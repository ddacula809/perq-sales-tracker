// server.js — Express API + static frontend host for the PERQ sales tracker.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDb, listRows, insertRow, updateRow, deleteRow, replaceAll, pool,
} from './db.js';
import { computeBooking, computeChurn } from './compute.js';
import { parseWorkbook } from './importer.js';
import { buildWorkbook } from './exporter.js';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
} from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Optional shared-key auth (set APP_PASSWORD in Railway to enable) ----
const APP_PASSWORD = process.env.APP_PASSWORD || '';
app.get('/api/auth-required', (_req, res) => res.json({ required: !!APP_PASSWORD }));
app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (req.path === '/auth-required') return next();
  if (req.get('x-app-key') === APP_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

const withComputed = (row, fn) => ({ ...row, ...fn(row) });

// ---- Schema (drives the frontend forms) ----
app.get('/api/schema', (_req, res) => {
  res.json({
    bookings: { editable: BOOKING_FIELDS, computed: BOOKING_COMPUTED },
    churn: { editable: CHURN_FIELDS, computed: CHURN_COMPUTED },
  });
});

// ---- Generic CRUD wired to both tables ----
function crud(table, computeFn) {
  app.get(`/api/${table}`, async (_req, res, next) => {
    try {
      const rows = await listRows(table);
      res.json(rows.map((r) => withComputed(r, computeFn)));
    } catch (e) { next(e); }
  });
  app.post(`/api/${table}`, async (req, res, next) => {
    try {
      const row = await insertRow(table, req.body || {});
      res.status(201).json(withComputed(row, computeFn));
    } catch (e) { next(e); }
  });
  app.patch(`/api/${table}/:id`, async (req, res, next) => {
    try {
      const row = await updateRow(table, Number(req.params.id), req.body || {});
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(withComputed(row, computeFn));
    } catch (e) { next(e); }
  });
  app.delete(`/api/${table}/:id`, async (req, res, next) => {
    try { await deleteRow(table, Number(req.params.id)); res.status(204).end(); }
    catch (e) { next(e); }
  });
}
crud('bookings', computeBooking);
crud('churn', computeChurn);

// ---- Import: upload original workbook, replace both tables ----
app.post('/api/import', upload.single('file'), async (req, res, next) => {
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
