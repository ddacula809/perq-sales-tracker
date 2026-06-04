// server.js — Express API + static frontend host for the PERQ sales tracker.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDb, listRows, insertRow, updateRow, deleteRow, replaceAll, pool,
  getUserByUsername, listUsers, createUser, updateUser, deleteUser, getUserById, countAdmins,
} from './db.js';
import { computeBooking, computeChurn } from './compute.js';
import { parseWorkbook } from './importer.js';
import { buildWorkbook } from './exporter.js';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_BILLING_KEYS, CHURN_BILLING_KEYS, USER_ROLES,
} from './schema.js';
import { verifyPassword, signToken, verifyToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Authentication (per-user accounts with roles) ----
app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await getUserByUsername(String(username || '').trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const safe = { id: user.id, username: user.username, role: user.role };
    res.json({ token: signToken(safe), user: safe });
  } catch (e) { next(e); }
});

// Every other /api route requires a valid token.
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/health') return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.get('x-app-key') || '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: payload.id, username: payload.username, role: payload.role };
  next();
});

app.get('/api/me', (req, res) => res.json({ user: req.user }));

// 403 unless the current user holds one of the listed roles.
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' });

const BILLING_KEYS = { bookings: BOOKING_BILLING_KEYS, churn: CHURN_BILLING_KEYS };

const withComputed = (row, fn) => ({ ...row, ...fn(row) });

// ---- Schema (drives the frontend forms) ----
app.get('/api/schema', (_req, res) => {
  res.json({
    bookings: { editable: BOOKING_FIELDS, computed: BOOKING_COMPUTED, billing: BOOKING_BILLING_KEYS },
    churn: { editable: CHURN_FIELDS, computed: CHURN_COMPUTED, billing: CHURN_BILLING_KEYS },
  });
});

// ---- Generic CRUD wired to both tables (with role-based authorization) ----
function crud(table, computeFn) {
  // Read: any authenticated user.
  app.get(`/api/${table}`, async (_req, res, next) => {
    try {
      const rows = await listRows(table);
      res.json(rows.map((r) => withComputed(r, computeFn)));
    } catch (e) { next(e); }
  });
  // Create / delete rows: admin or standard only.
  app.post(`/api/${table}`, requireRole('admin', 'standard'), async (req, res, next) => {
    try {
      const row = await insertRow(table, req.body || {});
      res.status(201).json(withComputed(row, computeFn));
    } catch (e) { next(e); }
  });
  app.delete(`/api/${table}/:id`, requireRole('admin', 'standard'), async (req, res, next) => {
    try { await deleteRow(table, Number(req.params.id)); res.status(204).end(); }
    catch (e) { next(e); }
  });
  // Edit a cell: viewers can't; billing users may only touch the billing columns.
  app.patch(`/api/${table}/:id`, async (req, res, next) => {
    try {
      const role = req.user.role;
      if (role === 'viewer') return res.status(403).json({ error: 'Your account is read-only.' });
      if (role === 'billing') {
        const bad = Object.keys(req.body || {}).filter((k) => !BILLING_KEYS[table].includes(k));
        if (bad.length) return res.status(403).json({ error: 'Billing users can only edit the billing columns.' });
      }
      const row = await updateRow(table, Number(req.params.id), req.body || {});
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(withComputed(row, computeFn));
    } catch (e) { next(e); }
  });
}
crud('bookings', computeBooking);
crud('churn', computeChurn);

// ---- User management (admin only) ----
app.get('/api/users', requireRole('admin'), async (_req, res, next) => {
  try { res.json(await listUsers()); } catch (e) { next(e); }
});
app.post('/api/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    const u = String(username || '').trim();
    if (!u || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    res.status(201).json(await createUser({ username: u, password, role }));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username already exists.' });
    next(e);
  }
});
app.patch('/api/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { role, password } = req.body || {};
    if (role && !USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    // Never leave the system with zero admins.
    if (role && role !== 'admin') {
      const target = await getUserById(id);
      if (target && target.role === 'admin' && (await countAdmins()) <= 1) {
        return res.status(400).json({ error: 'Cannot change the role of the last admin.' });
      }
    }
    const updated = await updateUser(id, { role, password });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (e) { next(e); }
});
app.delete('/api/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    const target = await getUserById(id);
    if (target && target.role === 'admin' && (await countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin.' });
    }
    await deleteUser(id);
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---- Import: upload original workbook, replace both tables (admin only) ----
app.post('/api/import', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { bookings, churn } = parseWorkbook(req.file.buffer);
    await replaceAll('bookings', bookings);
    await replaceAll('churn', churn);
    res.json({ imported: { bookings: bookings.length, churn: churn.length } });
  } catch (e) { next(e); }
});

// ---- Export: download current data as .xlsx ----
app.get('/api/export', async (_req, res, next) => {
  try {
    const bookings = await listRows('bookings');
    const churn = await listRows('churn');
    const buf = buildWorkbook(bookings, churn);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PERQ_Sales_Export_${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

// ---- Static frontend (served explicitly so backend source files aren't exposed) ----
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));

// ---- Error handler ----
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`PERQ Sales Tracker listening on :${PORT}`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
