// server.js — Express API + static frontend host for the PERQ sales tracker.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDb, listRows, insertRow, updateRow, deleteRow, replaceAll, pool,
  getUserByUsername, listUsers, createUser, updateUser, deleteUser, getUserById, countAdmins,
  listPeriods, getOpenPeriod, closeAllOpenPeriods, latestPeriod, createPeriod, getRowPeriod,
  getPeriod, closePeriod, reconcileOwnerNames,
  listNotifications, createNotification, dismissNotification, resolveNotification,
} from './db.js';
import { computeBooking, computeChurn, quarterFromMonthName, quarterFromMonthYear } from './compute.js';
import { parseWorkbook, parseChurnUpload, parseBookingReconcile, parseGolives, parseSalesforceRecon, parseLegacyTracker, parsePriorBookings } from './importer.js';
import { buildWorkbook } from './exporter.js';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_BILLING_KEYS, CHURN_BILLING_KEYS, USER_ROLES, SALES_SUPPORT_FIELDS,
  SALESFORCE_RECON_FIELDS, LEGACY_GOLIVE_FIELDS, LEGACY_CHURN_FIELDS,
} from './schema.js';
import { verifyPassword, signToken, verifyToken } from './auth.js';
import { sendEmail, changeEmailHtml } from './mailer.js';

// Notification email recipients: admin + billing users (their username is their email).
async function notifyEmails() {
  try {
    return (await listUsers())
      .filter((u) => u.role === 'admin' || u.role === 'billing')
      .map((u) => u.username);
  } catch { return []; }
}

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
    const safe = { id: user.id, username: user.username, role: user.role, account_owner: user.account_owner || null };
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
  req.user = { id: payload.id, username: payload.username, role: payload.role, account_owner: payload.account_owner || null };
  next();
});

// Read the user fresh from the DB so role/account_owner changes apply without re-login
// (and so older tokens that predate the account_owner field still resolve it).
app.get('/api/me', async (req, res, next) => {
  try {
    const u = await getUserById(req.user.id);
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user: { id: u.id, username: u.username, role: u.role, account_owner: u.account_owner || null } });
  } catch (e) { next(e); }
});

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

// Owner dropdown options = Salesforce Recon Account Owner full names + any original
// options that have no Recon match (e.g. "House/CSM", "Doug") + blank if originally allowed.
function ownerOptions(originalOptions, reconOwners) {
  const firsts = new Set(reconOwners.map((n) => n.split(/\s+/)[0].toLowerCase()));
  const keepLegacy = originalOptions.filter((o) => o && !firsts.has(o.split(/\s+/)[0].toLowerCase()));
  const sorted = [...reconOwners].sort((a, b) => a.localeCompare(b));
  return [...(originalOptions.includes('') ? [''] : []), ...sorted, ...keepLegacy];
}

// ---- Schema (drives the frontend forms) ----
app.get('/api/schema', async (_req, res, next) => {
  try {
    const recon = await listRows('salesforce_recon');
    const owners = [...new Set(recon.map((r) => String(r.account_owner ?? '').trim()).filter(Boolean))];
    const bookingFields = BOOKING_FIELDS.map((f) =>
      f.key === 'sales_rep' ? { ...f, options: ownerOptions(f.options, owners) } : f);
    const ssFields = SALES_SUPPORT_FIELDS.map((f) =>
      f.key === 'account_owner' ? { ...f, options: ownerOptions(f.options, owners) } : f);
    res.json({
      bookings: { editable: bookingFields, computed: BOOKING_COMPUTED, billing: BOOKING_BILLING_KEYS },
      churn: { editable: CHURN_FIELDS, computed: CHURN_COMPUTED, billing: CHURN_BILLING_KEYS },
      sales_support: { editable: ssFields },
      salesforce_recon: { editable: SALESFORCE_RECON_FIELDS },
      legacy_golives: { editable: LEGACY_GOLIVE_FIELDS },
      legacy_churn: { editable: LEGACY_CHURN_FIELDS },
    });
  } catch (e) { next(e); }
});

// ---- Generic CRUD wired to both tables (with role-based authorization) ----
// Manual edits to these date fields raise the same "For Immediate Action" notification
// as the GoLives / Churn uploads do, so Billing sees the change either way.
const WATCHED_EDIT = {
  bookings: { key: 'golive_date', label: 'GoLive Date', name: (r) => r.property_name || r.property_id || `Booking #${r.id}` },
  churn: { key: 'last_date_under_contract', label: 'Last Date Under Contract', name: (r) => r.property || r.property_id || `Churn #${r.id}` },
};
const sameDate = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

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
      // Bookings/Churn are edited only by admin, standard, and (billing columns) billing.
      // Viewers and the sales roles have read-only access here.
      if (role === 'viewer' || role === 'sales_admin' || role === 'sales') {
        return res.status(403).json({ error: 'Your account has view-only access to this data.' });
      }
      if (role === 'billing') {
        const allowed = BILLING_KEYS[table] || [];
        const bad = Object.keys(req.body || {}).filter((k) => !allowed.includes(k));
        if (bad.length) return res.status(403).json({ error: 'Billing users can only edit the billing columns.' });
      }
      const id = Number(req.params.id);
      // If this edit touches a watched date field, capture the old value first so we can
      // tell whether it actually changed (and raise a notification for Billing if so).
      const watch = WATCHED_EDIT[table];
      let oldVal;
      if (watch && Object.prototype.hasOwnProperty.call(req.body || {}, watch.key)) {
        const prev = await pool.query(`SELECT ${watch.key} AS v FROM ${table} WHERE id=$1`, [id]);
        oldVal = prev.rows[0] ? prev.rows[0].v : undefined;
      }
      const row = await updateRow(table, id, req.body || {});
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (watch && oldVal !== undefined && !sameDate(oldVal, row[watch.key])) {
        const from = oldVal ? oldVal : '(blank)';
        const to = row[watch.key] ? row[watch.key] : '(blank)';
        await createNotification(table, row.id, `${watch.label} changed for ${watch.name(row)}: ${from} → ${to}`);
      }
      res.json(withComputed(row, computeFn));
    } catch (e) { next(e); }
  });
}
crud('bookings', computeBooking);
crud('churn', computeChurn);

// ---- License Transfer offset: a booking offsets a same-PMC, same-quarter churn ----
// Tags the booking as a License Transfer with the offset, reclassifies the churn as a
// Contraction (excluded from churn totals), and stamps cross-reference notes on both.
const norm = (v) => String(v ?? '').trim().toLowerCase();
const appendNote = (existing, addition) => {
  const cur = String(existing || '').trim();
  if (!addition || cur.includes(addition)) return cur;
  return cur ? `${cur} | ${addition}` : addition;
};
app.post('/api/bookings/apply-offset', requireRole('admin', 'standard'), async (req, res, next) => {
  try {
    const { bookingId, churnId, offsetAmount } = req.body || {};
    const booking = (await pool.query('SELECT * FROM bookings WHERE id=$1', [Number(bookingId)])).rows[0];
    const churn = (await pool.query('SELECT * FROM churn WHERE id=$1', [Number(churnId)])).rows[0];
    if (!booking || !churn) return res.status(404).json({ error: 'Booking or churn not found.' });
    if (norm(booking.pmc) !== norm(churn.pmc_buying_center)) {
      return res.status(400).json({ error: 'The booking and churn are under different PMCs.' });
    }
    if (String(churn.classification || '') === 'Contraction') {
      return res.status(400).json({ error: 'That churn has already been used to offset a booking.' });
    }
    // A churn's quarter is when its full drop is recognized (Final Churn Month). Allow the
    // booking to be offset by a churn in the same quarter or a future one (never a past one).
    const cQ = quarterFromMonthYear(computeChurn(churn).final_churn_month);
    const bQ = quarterFromMonthName(booking.booking_month, booking.booking_year);
    if (!cQ || !bQ) return res.status(400).json({ error: 'Could not determine the quarter of the booking or churn.' });
    if (((cQ.year - bQ.year) * 4 + (cQ.q - bQ.q)) < 0) {
      return res.status(400).json({ error: 'That churn is in a quarter before the booking.' });
    }
    const amt = Number(String(offsetAmount ?? '').replace(/[$,]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Enter a valid offset amount.' });

    const churnProp = churn.property || churn.pmc_buying_center || 'churned property';
    const bookingProp = booking.property_name || booking.property_id || 'booking';
    const bNote = appendNote(booking.notes, `Offset by ${churnProp} (License Transfer)`);
    await pool.query(
      `UPDATE bookings SET pilot_or_ctam='CTAM', ctam_type='License Transfer',
         offset_amount=$1, offset_churn_id=$2, notes=$3, updated_at=now() WHERE id=$4`,
      [amt, churn.id, bNote, booking.id]);
    const cNote = appendNote(churn.notes,
      `Used to offset ${bookingProp} (${`${booking.booking_month || ''} ${booking.booking_year || ''}`.trim()})`);
    await updateRow('churn', churn.id, { classification: 'Contraction', notes: cNote });

    const b2 = (await pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id])).rows[0];
    const c2 = (await pool.query('SELECT * FROM churn WHERE id=$1', [churn.id])).rows[0];
    res.json({ booking: withComputed(b2, computeBooking), churn: withComputed(c2, computeChurn) });
  } catch (e) { next(e); }
});

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
app.post('/api/sales_periods/close', requireRole('admin', 'sales_admin'), async (req, res, next) => {
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
app.post('/api/sales_periods/open', requireRole('admin', 'sales_admin'), async (_req, res, next) => {
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
// Distinct Account Names (PMCs) for the Sales Support PMC dropdown. Anyone who can edit
// Sales Support may fetch it; a tagged 'sales' user only sees PMCs under their Account Owner.
app.get('/api/salesforce_recon/pmcs', requireRole('admin', 'standard', 'sales_admin', 'sales'), async (req, res, next) => {
  try {
    const rows = await listRows('salesforce_recon');
    const scopeOwner = (req.user.role === 'sales' && req.user.account_owner)
      ? String(req.user.account_owner).trim().toLowerCase() : null;
    const set = new Set();
    for (const r of rows) {
      if (scopeOwner && String(r.account_owner ?? '').trim().toLowerCase() !== scopeOwner) continue;
      const v = String(r.account_name ?? '').trim();
      if (v) set.add(v);
    }
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
// Re-clean Sales Rep / Account Owner names against the current Recon master (admin).
app.post('/api/salesforce_recon/reconcile-owners', requireRole('admin'), async (_req, res, next) => {
  try { await reconcileOwnerNames(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Legacy trackers (admin + billing): read-only archive from the old AR Tracking workbook ----
app.get('/api/legacy_golives', requireRole('admin', 'billing'), async (_req, res, next) => {
  try { res.json(await listRows('legacy_golives')); } catch (e) { next(e); }
});
app.get('/api/legacy_churn', requireRole('admin', 'billing'), async (_req, res, next) => {
  try { res.json(await listRows('legacy_churn')); } catch (e) { next(e); }
});
app.post('/api/legacy/import', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { golives, churn } = parseLegacyTracker(req.file.buffer);
    await replaceAll('legacy_golives', golives);
    await replaceAll('legacy_churn', churn);
    res.json({ golives: golives.length, churn: churn.length });
  } catch (e) { next(e); }
});

// ---- Sales Support rows: edits allowed only within the open quarter ----
app.get('/api/sales_support', async (_req, res, next) => {
  try { res.json(await listRows('sales_support')); } catch (e) { next(e); }
});
app.post('/api/sales_support', requireRole('admin', 'standard', 'sales_admin', 'sales'), async (req, res, next) => {
  try {
    const body = req.body || {};
    // A tagged 'sales' user can only file rows under their own Account Owner.
    if (req.user.role === 'sales' && req.user.account_owner) body.account_owner = req.user.account_owner;
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
app.patch('/api/sales_support/:id', requireRole('admin', 'standard', 'sales_admin', 'sales'), async (req, res, next) => {
  try {
    const chk = await ssRowEditable(Number(req.params.id));
    if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
    res.json(await updateRow('sales_support', Number(req.params.id), req.body || {}));
  } catch (e) { next(e); }
});
app.delete('/api/sales_support/:id', requireRole('admin', 'standard', 'sales_admin', 'sales'), async (req, res, next) => {
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
    const { username, password, role, account_owner } = req.body || {};
    const u = String(username || '').trim();
    if (!u || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    const owner = role === 'sales' ? String(account_owner || '').trim() : null;
    res.status(201).json(await createUser({ username: u, password, role, account_owner: owner }));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username already exists.' });
    next(e);
  }
});
app.patch('/api/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { role, password, account_owner } = req.body || {};
    if (role && !USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    // Never leave the system with zero admins.
    if (role && role !== 'admin') {
      const target = await getUserById(id);
      if (target && target.role === 'admin' && (await countAdmins()) <= 1) {
        return res.status(400).json({ error: 'Cannot change the role of the last admin.' });
      }
    }
    const updated = await updateUser(id, { role, password, account_owner });
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
    const changeLines = [];
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
      const msg = `Last Date Under Contract changed for ${who} (${match.product || 'product'}) from ${cur || '(blank)'} to ${next || '(blank)'}`;
      await createNotification('churn', match.id, msg);
      changeLines.push(msg);
      match.last_date_under_contract = next;
      changed += 1;
    }
    if (changeLines.length) {
      sendEmail({
        to: await notifyEmails(),
        subject: `PERQ: ${changeLines.length} Last Date Under Contract change${changeLines.length === 1 ? '' : 's'}`,
        html: changeEmailHtml('Churn date changes', 'The following Last Date Under Contract values were updated from a churn upload:', changeLines),
      });
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
    const changeLines = [];
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
          const msg = `GoLive date changed for ${who} (${b.product || 'product'}) from ${cur} to ${next}`;
          await createNotification('bookings', b.id, msg);
          changeLines.push(msg);
          changed += 1;
        }
      }
    }
    if (changeLines.length) {
      sendEmail({
        to: await notifyEmails(),
        subject: `PERQ: ${changeLines.length} GoLive date change${changeLines.length === 1 ? '' : 's'}`,
        html: changeEmailHtml('GoLive date changes', 'The following GoLive dates were updated from a GoLives upload:', changeLines),
      });
    }
    res.json({ updated, changed, unchanged, notFound, total: incoming.length });
  } catch (e) { next(e); }
});

// ---- Notifications (admin + billing) ----
app.get('/api/notifications', requireRole('admin', 'billing'), async (_req, res, next) => {
  try { res.json(await listNotifications()); } catch (e) { next(e); }
});
// Bell "✕" — acknowledge only (keeps the dashboard warning).
app.post('/api/notifications/:id/dismiss', requireRole('admin', 'billing'), async (req, res, next) => {
  try { await dismissNotification(Number(req.params.id)); res.json(await listNotifications()); } catch (e) { next(e); }
});
// Dashboard "Resolve" — clears the warning (and the bell entry).
app.post('/api/notifications/:id/resolve', requireRole('admin', 'billing'), async (req, res, next) => {
  try { await resolveNotification(Number(req.params.id)); res.json(await listNotifications()); } catch (e) { next(e); }
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

// ---- Import prior-period bookings (old single-sheet format, e.g. April 2026) — appends ----
app.post('/api/bookings/import-prior', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = parsePriorBookings(req.file.buffer);
    // Fill blank Property IDs from Salesforce Recon by property name (best effort).
    const recon = await listRows('salesforce_recon');
    const reconByName = new Map();
    for (const r of recon) {
      const nm = String(r.property_name ?? '').trim().toLowerCase();
      if (nm && r.property_id_18 && !reconByName.has(nm)) reconByName.set(nm, r.property_id_18);
    }
    const propTail = (full) => { const p = String(full || '').split(' - '); return p[p.length - 1].trim().toLowerCase(); };
    const existing = await listRows('bookings');
    const dkey = (r) => `${norm(r.property_id) || norm(r.property_name)}|${norm(r.product)}|${norm(r.booking_month)}|${norm(r.booking_year)}`;
    const seen = new Set(existing.map(dkey));
    let added = 0;
    let skipped = 0;
    let filledIds = 0;
    for (const r of rows) {
      if (!r.property_id) {
        const id = reconByName.get(propTail(r.property_name));
        if (id) { r.property_id = id; filledIds += 1; }
      }
      const k = dkey(r);
      if (seen.has(k)) { skipped += 1; continue; }
      seen.add(k);
      await insertRow('bookings', r);
      added += 1;
    }
    if (added) await reconcileOwnerNames(); // bring Sales Rep names in line with Salesforce Recon
    res.json({ added, skipped, filledIds, total: rows.length });
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
