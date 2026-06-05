// server.js — Express API + static frontend host for the PERQ sales tracker.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDb, listRows, insertRow, updateRow, deleteRow, replaceAll, pool,
  getUserByUsername, listUsers, createUser, updateUser, deleteUser, getUserById, countAdmins,
  listPeriods, getOpenPeriod, closeAllOpenPeriods, latestPeriod, createPeriod, getRowPeriod,
  getPeriod, closePeriod,
  listNotifications, createNotification, dismissNotification,
} from './db.js';
import { computeBooking, computeChurn } from './compute.js';
import { parseWorkbook, parseChurnUpload, parseBookingReconcile, parseGolives, parseSalesforceRecon } from './importer.js';
import { buildWorkbook } from './exporter.js';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_BILLING_KEYS, CHURN_BILLING_KEYS, USER_ROLES, SALES_SUPPORT_FIELDS,
  SALESFORCE_RECON_FIELDS,
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

// Self-service password change for the logged-in user.
app.post('/api/change-password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    const user = await getUserByUsername(req.user.username);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    await updateUser(user.id, { password: newPassword });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

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
    sales_support: { editable: SALES_SUPPORT_FIELDS },
    salesforce_recon: { editable: SALESFORCE_RECON_FIELDS },
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
        const allowed = BILLING_KEYS[table] || [];
        const bad = Object.keys(req.body || {}).filter((k) => !allowed.includes(k));
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

// Preview booking rows (compute formula columns) without saving — for the confirm dialog.
app.post('/api/bookings/preview', requireRole('admin', 'standard'), (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  res.json({ rows: rows.map((r) => ({ ...r, ...computeBooking(r) })) });
});

// ---- Sales Support periods (quarters); close/open are admin-only ----
app.get('/api/sales_periods', async (_req, res, next) => {
  try { res.json(await listPeriods()); } catch (e) { next(e); }
});
// Close (archive + lock) one specific quarter. Only that quarter is affected.
app.post('/api/sales_periods/close', requireRole('admin'), async (req, res, next) => {
  try {
    const period = (req.body && req.body.period) ? String(req.body.period) : null;
    if (!period) return res.status(400).json({ error: 'No quarter specified.' });
    const p = await getPeriod(period);
    if (!p) return res.status(404).json({ error: 'Unknown quarter.' });
    if (p.status !== 'open') return res.status(400).json({ error: 'That quarter is already archived.' });
    await closePeriod(period);
    res.json(await listPeriods());
  } catch (e) { next(e); }
});
// Open a new quarter. Existing open quarters are left open (closing is now explicit).
app.post('/api/sales_periods/open', requireRole('admin'), async (_req, res, next) => {
  try {
    const last = await latestPeriod();
    let q = last ? last.quarter + 1 : 1;
    let y = last ? last.year : new Date().getFullYear();
    if (q > 4) { q = 1; y += 1; }
    const created = await createPeriod(q, y);
    res.json({ created, periods: await listPeriods() });
  } catch (e) { next(e); }
});

// ---- Salesforce Recon Data: admin-only master reference, replaced wholesale on import ----
app.get('/api/salesforce_recon', requireRole('admin'), async (_req, res, next) => {
  try { res.json(await listRows('salesforce_recon')); } catch (e) { next(e); }
});
// Distinct Account Names (PMCs) — used to populate the Sales Support PMC dropdown.
// Available to anyone who can edit Sales Support (admin + standard).
app.get('/api/salesforce_recon/pmcs', requireRole('admin', 'standard'), async (_req, res, next) => {
  try {
    const rows = await listRows('salesforce_recon');
    const set = new Set();
    for (const r of rows) { const v = String(r.account_name ?? '').trim(); if (v) set.add(v); }
    res.json([...set].sort((a, b) => a.localeCompare(b)));
  } catch (e) { next(e); }
});
app.post('/api/salesforce_recon/import', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = parseSalesforceRecon(req.file.buffer);
    await replaceAll('salesforce_recon', rows);
    res.json({ imported: rows.length });
  } catch (e) { next(e); }
});

// ---- Sales Support rows: edits allowed only within the open quarter ----
app.get('/api/sales_support', async (_req, res, next) => {
  try { res.json(await listRows('sales_support')); } catch (e) { next(e); }
});
app.post('/api/sales_support', requireRole('admin', 'standard'), async (req, res, next) => {
  try {
    const body = req.body || {};
    // Add to the quarter the client is viewing (must be open); fall back to the latest open.
    let period = body.period ? String(body.period) : null;
    if (period) {
      const p = await getPeriod(period);
      if (!p) return res.status(400).json({ error: 'Unknown quarter.' });
      if (p.status !== 'open') return res.status(403).json({ error: 'This quarter is archived (read-only).' });
    } else {
      const open = await getOpenPeriod();
      if (!open) return res.status(400).json({ error: 'No open quarter. Open a new quarter first.' });
      period = open.period;
    }
    res.status(201).json(await insertRow('sales_support', { ...body, period }));
  } catch (e) { next(e); }
});
// A sales_support row is editable while its own quarter is open (multiple quarters may be open).
async function ssRowEditable(id) {
  const rowPeriod = await getRowPeriod('sales_support', id);
  if (!rowPeriod) return { ok: false, code: 404, error: 'Not found' };
  const p = await getPeriod(rowPeriod);
  if (!p || p.status !== 'open') return { ok: false, code: 403, error: 'This quarter is archived (read-only).' };
  return { ok: true };
}
app.patch('/api/sales_support/:id', requireRole('admin', 'standard'), async (req, res, next) => {
  try {
    const chk = await ssRowEditable(Number(req.params.id));
    if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
    res.json(await updateRow('sales_support', Number(req.params.id), req.body || {}));
  } catch (e) { next(e); }
});
app.delete('/api/sales_support/:id', requireRole('admin', 'standard'), async (req, res, next) => {
  try {
    const chk = await ssRowEditable(Number(req.params.id));
    if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
    await deleteRow('sales_support', Number(req.params.id));
    res.status(204).end();
  } catch (e) { next(e); }
});

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

// ---- Churn upload: append rows from a churn report, skipping duplicates ----
// A row is a duplicate if New Value + Property ID + Property + MRR + Last Date Under
// Contract already exist (in the table or earlier in the same file).
app.post('/api/churn/upload', requireRole('admin', 'standard'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const incoming = parseChurnUpload(req.file.buffer);
    const existing = await listRows('churn');
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const numKey = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : ''; };
    // Match an uploaded row to an existing churn row by Property ID + Product + MRR.
    const key = (r) => `${norm(r.property_id)}|${norm(r.product)}|${numKey(r.mrr)}`;
    const byKey = new Map();
    for (const c of existing) { const k = key(c); if (!byKey.has(k)) byKey.set(k, c); }

    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let skippedBlank = 0;
    for (const row of incoming) {
      // Rows without a Last Date Under Contract are not real churn events -> skip them.
      const next = row.last_date_under_contract ? String(row.last_date_under_contract).slice(0, 10) : '';
      if (!next) { skippedBlank += 1; continue; }
      const k = key(row);
      const match = byKey.get(k);
      if (!match) {
        // No existing churn line for this property/product/MRR -> add it.
        const ins = await insertRow('churn', row);
        byKey.set(k, ins);
        added += 1;
        continue;
      }
      // Same property/product/MRR already exists: compare Last Date Under Contract.
      const cur = match.last_date_under_contract ? String(match.last_date_under_contract).slice(0, 10) : '';
      if (cur === next) { unchanged += 1; continue; }
      // Last Date Under Contract changed -> update the existing row and notify billing.
      await updateRow('churn', match.id, { last_date_under_contract: next });
      const who = match.property || match.property_id || 'a property';
      await createNotification('churn', match.id,
        `Last Date Under Contract changed for ${who} (${match.product || 'product'}) from ${cur || '(blank)'} to ${next || '(blank)'}`);
      match.last_date_under_contract = next;
      changed += 1;
    }
    res.json({ added, changed, unchanged, skippedBlank, total: incoming.length });
  } catch (e) { next(e); }
});

// ---- GoLives: update booking GoLive dates from a report; notify billing on changes ----
app.post('/api/bookings/golives', requireRole('admin', 'standard'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const incoming = parseGolives(req.file.buffer);
    const bookings = await listRows('bookings');
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const numKey = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : ''; };
    const key = (r) => `${norm(r.property_id)}|${norm(r.product)}|${numKey(r.mrr)}`;
    const byKey = new Map();
    for (const b of bookings) {
      const k = key(b);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(b);
    }
    let updated = 0;
    let changed = 0;
    let unchanged = 0;
    let notFound = 0;
    for (const row of incoming) {
      if (!row.golive_date) continue;
      const matches = byKey.get(key(row));
      if (!matches || !matches.length) { notFound += 1; continue; }
      const next = String(row.golive_date).slice(0, 10);
      for (const b of matches) {
        const cur = b.golive_date ? String(b.golive_date).slice(0, 10) : '';
        if (!cur) {
          await updateRow('bookings', b.id, { golive_date: next });
          updated += 1;
        } else if (cur === next) {
          unchanged += 1;
        } else {
          await updateRow('bookings', b.id, { golive_date: next });
          const who = b.property_name || b.property_id || 'a property';
          await createNotification('bookings', b.id, `GoLive date changed for ${who} (${b.product || 'product'}) from ${cur} to ${next}`);
          changed += 1;
        }
      }
    }
    res.json({ updated, changed, unchanged, notFound, total: incoming.length });
  } catch (e) { next(e); }
});

// ---- Notifications (admin + billing) ----
app.get('/api/notifications', requireRole('admin', 'billing'), async (_req, res, next) => {
  try { res.json(await listNotifications()); } catch (e) { next(e); }
});
app.post('/api/notifications/:id/dismiss', requireRole('admin', 'billing'), async (req, res, next) => {
  try { await dismissNotification(Number(req.params.id)); res.json(await listNotifications()); } catch (e) { next(e); }
});

// ---- Reconcile: parse an uploaded bookings file; the client diffs it against current data ----
app.post('/api/bookings/reconcile', requireRole('admin', 'standard'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ rows: parseBookingReconcile(req.file.buffer) });
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
app.get('/api/export', async (req, res, next) => {
  try {
    let bookings = await listRows('bookings');
    const { month, year } = req.query;
    if (month) bookings = bookings.filter((r) => r.booking_month === month);
    if (year) bookings = bookings.filter((r) => String(r.booking_year) === String(year));
    const churn = await listRows('churn');
    // "For Sales Commission" export drops the billing (blue) columns from both tabs.
    const opts = req.query.scope === 'commission'
      ? { excludeBookingKeys: new Set(BOOKING_BILLING_KEYS), excludeChurnKeys: new Set(CHURN_BILLING_KEYS) }
      : {};
    const buf = buildWorkbook(bookings, churn, opts);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PERQ_Revenue_Desk_Export_${stamp}.xlsx"`);
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
  .then(() => app.listen(PORT, () => console.log(`PERQ Revenue Desk listening on :${PORT}`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
