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
  listProducts, loadCatalog,
  listClosedMonths, closeMonth, reopenMonth,
} from './db.js';
import { computeBooking, computeChurn, quarterFromMonthName, quarterFromMonthYear, monthYear } from './compute.js';
import { parseWorkbook, parseChurnUpload, parseBookingReconcile, parseGolives, parseSalesforceRecon, parseLegacyTracker, parsePriorBookings } from './importer.js';
import { buildWorkbook } from './exporter.js';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_BILLING_KEYS, CHURN_BILLING_KEYS, USER_ROLES, SALES_SUPPORT_FIELDS,
  SALESFORCE_RECON_FIELDS, LEGACY_GOLIVE_FIELDS, LEGACY_CHURN_FIELDS, BPR_CATEGORIES,
} from './schema.js';
import { verifyPassword, signToken, verifyToken } from './auth.js';
import { sendEmail, changeEmailHtml } from './mailer.js';
import { assistantEnabled, runAssistant } from './assistant.js';

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
    // Product dropdown options come from the admin-managed products table (source of truth).
    const products = await listProducts();
    const productNames = products.map((p) => String(p.name || '').trim()).filter(Boolean);
    const productCategories = Object.fromEntries(products.map((p) => [p.name, p.bpr_category]));
    const bookingFields = BOOKING_FIELDS.map((f) => {
      if (f.key === 'sales_rep') return { ...f, options: ownerOptions(f.options, owners) };
      if (f.key === 'product' && productNames.length) return { ...f, options: productNames };
      return f;
    });
    const ssFields = SALES_SUPPORT_FIELDS.map((f) =>
      f.key === 'account_owner' ? { ...f, options: ownerOptions(f.options, owners) } : f);
    res.json({
      bookings: { editable: bookingFields, computed: BOOKING_COMPUTED, billing: BOOKING_BILLING_KEYS },
      churn: { editable: CHURN_FIELDS, computed: CHURN_COMPUTED, billing: CHURN_BILLING_KEYS },
      sales_support: { editable: ssFields },
      salesforce_recon: { editable: SALESFORCE_RECON_FIELDS },
      legacy_golives: { editable: LEGACY_GOLIVE_FIELDS },
      legacy_churn: { editable: LEGACY_CHURN_FIELDS },
      productCategories,
      bprCategories: BPR_CATEGORIES,
      assistantEnabled: assistantEnabled(),
    });
  } catch (e) { next(e); }
});

// ---- Products (admin-managed list that drives the Product dropdowns) ----
// Read: any authenticated user (the dropdowns need it). Create/edit/delete: admin only.
app.get('/api/products', async (_req, res, next) => {
  try { res.json(await listProducts()); } catch (e) { next(e); }
});
app.post('/api/products', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Product name is required.' });
    let cat = String((req.body && req.body.bpr_category) || '').trim();
    if (!BPR_CATEGORIES.includes(cat)) cat = 'Software';
    const existing = await listProducts();
    if (existing.some((p) => String(p.name || '').trim().toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: 'A product with that name already exists.' });
    }
    const sort = (existing.reduce((m, p) => Math.max(m, Number(p.sort_order) || 0), 0)) + 10;
    const row = await insertRow('products', { name, bpr_category: cat, sort_order: sort });
    await loadCatalog();
    res.status(201).json(row);
  } catch (e) { next(e); }
});
app.patch('/api/products/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const patch = {};
    if (req.body && req.body.bpr_category !== undefined) {
      const cat = String(req.body.bpr_category || '').trim();
      patch.bpr_category = BPR_CATEGORIES.includes(cat) ? cat : 'Software';
    }
    if (req.body && req.body.sort_order !== undefined) patch.sort_order = req.body.sort_order;
    const row = await updateRow('products', Number(req.params.id), patch);
    await loadCatalog();
    res.json(row);
  } catch (e) { next(e); }
});
app.delete('/api/products/:id', requireRole('admin'), async (req, res, next) => {
  try { await deleteRow('products', Number(req.params.id)); await loadCatalog(); res.status(204).end(); }
  catch (e) { next(e); }
});

// ---- Closed months (month-end lock; drives churn carry-over). Close/reopen is admin-only. ----
app.get('/api/closed-months', async (_req, res, next) => {
  try { res.json(await listClosedMonths()); } catch (e) { next(e); }
});
app.post('/api/closed-months', requireRole('admin'), async (req, res, next) => {
  try {
    const month = String((req.body && req.body.month) || '').trim();
    const close_date = String((req.body && req.body.close_date) || '').slice(0, 10);
    if (!month) return res.status(400).json({ error: 'Month is required.' });
    if (!close_date || Number.isNaN(Date.parse(close_date))) return res.status(400).json({ error: 'A valid official close date is required.' });
    res.status(201).json(await closeMonth(month, close_date, req.user && req.user.username));
  } catch (e) { next(e); }
});
app.delete('/api/closed-months/:month', requireRole('admin'), async (req, res, next) => {
  try { await reopenMonth(req.params.month); res.status(204).end(); } catch (e) { next(e); }
});

// ---- "Ask Claude" assistant (read-only Q&A over the app data) ----
// Available to roles that already see all the data; gives Claude tools to query it.
function assistantSchemaText() {
  const cols = (fields) => fields.map((f) => `${f.key} (${f.label})`).join(', ');
  return [
    `- bookings: ${cols([...BOOKING_FIELDS, ...BOOKING_COMPUTED])}`,
    `- churn: ${cols([...CHURN_FIELDS, ...CHURN_COMPUTED])}, account_owner (Account Owner, from recon)`,
    `- sales_support: ${cols(SALES_SUPPORT_FIELDS)} — note: monthly "actual" figures are computed in the app from bookings, not stored here`,
    `- salesforce_recon: ${cols(SALESFORCE_RECON_FIELDS)}`,
  ].join('\n');
}
async function assistantLoad(dataset) {
  if (dataset === 'bookings') return (await listRows('bookings')).map((r) => withComputed(r, computeBooking));
  if (dataset === 'churn') return attachChurnOwners((await listRows('churn')).map((r) => withComputed(r, computeChurn)));
  if (dataset === 'sales_support') return listRows('sales_support');
  if (dataset === 'salesforce_recon') return listRows('salesforce_recon');
  throw new Error(`Unknown dataset: ${dataset}`);
}
const aNorm = (v) => String(v ?? '').trim().toLowerCase();
function assistantFilter(rows, filters) {
  if (!filters || typeof filters !== 'object') return rows;
  const entries = Object.entries(filters);
  return rows.filter((r) => entries.every(([k, v]) => aNorm(r[k]) === aNorm(v)));
}
async function assistantQuery({ dataset, filters, limit }) {
  const matched = assistantFilter(await assistantLoad(dataset), filters);
  const lim = Math.min(Math.max(1, Number(limit) || 100), 500);
  return { dataset, total_matched: matched.length, returned: Math.min(matched.length, lim), rows: matched.slice(0, lim) };
}
async function assistantSummarize({ dataset, filters, sum_fields, group_by }) {
  const matched = assistantFilter(await assistantLoad(dataset), filters);
  const sumFields = Array.isArray(sum_fields) ? sum_fields : [];
  const sumRow = (arr) => Object.fromEntries(sumFields.map((f) => [f, arr.reduce((a, r) => a + (Number(r[f]) || 0), 0)]));
  const result = { dataset, count: matched.length, sums: sumRow(matched) };
  if (group_by) {
    const groups = {};
    for (const r of matched) { const k = String(r[group_by] ?? '(blank)'); (groups[k] || (groups[k] = [])).push(r); }
    result.groups = Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, { count: rs.length, sums: sumRow(rs) }]));
  }
  return result;
}
app.post('/api/chat', requireRole('admin', 'standard', 'billing'), async (req, res, next) => {
  try {
    if (!assistantEnabled()) return res.status(503).json({ error: 'The AI assistant is not configured (set ANTHROPIC_API_KEY).' });
    const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'No message provided.' });
    const today = new Date().toISOString().slice(0, 10);
    const reply = await runAssistant({
      messages,
      user: req.user,
      today,
      schemaText: assistantSchemaText(),
      tools: { query_records: assistantQuery, summarize: assistantSummarize },
    });
    res.json({ reply });
  } catch (e) { next(e); }
});

// ---- Generic CRUD wired to both tables (with role-based authorization) ----
// Manual edits to these fields raise the same "For Immediate Action" notification as the
// GoLives / Churn uploads do, so Billing sees the change either way. MRR is watched too.
const WATCHED_NAME = {
  bookings: (r) => r.property_name || r.property_id || `Booking #${r.id}`,
  churn: (r) => r.property || r.property_id || `Churn #${r.id}`,
};
const WATCHED_FIELDS = {
  bookings: [{ key: 'golive_date', label: 'GoLive Date' }, { key: 'mrr', label: 'MRR', money: true }],
  churn: [{ key: 'last_date_under_contract', label: 'Last Date Under Contract' }, { key: 'mrr', label: 'MRR', money: true }],
};
const sameWatched = (a, b, money) => (money
  ? (Number(a) || 0) === (Number(b) || 0)
  : String(a ?? '').trim() === String(b ?? '').trim());
const fmtWatched = (v, money) => (money
  ? (v === null || v === undefined || v === '' ? '$0' : `$${Number(v).toLocaleString('en-US')}`)
  : (v ? v : '(blank)'));

// Attach an Account Owner to each churn row, looked up from the Salesforce Recon master
// (churn has no owner column). Match by Property ID -> Property ID 18 Digit, falling back to
// PMC Buying Center -> Account Name. Lets the dashboard filter Churn by Account Owner.
async function attachChurnOwners(rows) {
  const recon = await listRows('salesforce_recon');
  const byPid = new Map();
  const byPmc = new Map();
  for (const r of recon) {
    const owner = String(r.account_owner ?? '').trim();
    if (!owner) continue;
    const pid = String(r.property_id_18 ?? '').trim().toLowerCase();
    const pmc = String(r.account_name ?? '').trim().toLowerCase();
    if (pid && !byPid.has(pid)) byPid.set(pid, owner);
    if (pmc && !byPmc.has(pmc)) byPmc.set(pmc, owner);
  }
  return rows.map((r) => ({
    ...r,
    account_owner: byPid.get(String(r.property_id ?? '').trim().toLowerCase())
      || byPmc.get(String(r.pmc_buying_center ?? '').trim().toLowerCase()) || '',
  }));
}

function crud(table, computeFn, afterInsert, beforeInsert) {
  // Read: any authenticated user. Churn rows are enriched with their Account Owner (from Recon).
  app.get(`/api/${table}`, async (_req, res, next) => {
    try {
      let out = (await listRows(table)).map((r) => withComputed(r, computeFn));
      if (table === 'churn') out = await attachChurnOwners(out);
      res.json(out);
    } catch (e) { next(e); }
  });
  // Create / delete rows: admin or standard only.
  app.post(`/api/${table}`, requireRole('admin', 'standard'), async (req, res, next) => {
    try {
      const body = req.body || {};
      // beforeInsert may handle this as an update of an existing row (e.g. a Conversion that
      // overrides its pilot booking) and return that row — then no new row is inserted.
      if (beforeInsert) {
        const replaced = await beforeInsert(body);
        if (replaced) return res.json(withComputed(replaced, computeFn));
      }
      const row = await insertRow(table, body);
      const computed = withComputed(row, computeFn);
      // Optional side-effect after insert (e.g. auto-track a new booking in Sales Support).
      if (afterInsert) { try { await afterInsert(computed); } catch (e) { console.error('[afterInsert]', e.message); } }
      res.status(201).json(computed);
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
      // Only admins may set the system-generated date fields (Date Added / GoLive Set Date).
      if (role !== 'admin' && req.body) { delete req.body.date_added; delete req.body.golive_set_date; }
      const id = Number(req.params.id);
      // Capture old values of any watched fields touched by this edit, so we can tell whether
      // they actually changed and raise a Billing notification (GoLive/Last Date and MRR).
      const watched = (WATCHED_FIELDS[table] || []).filter((f) => Object.prototype.hasOwnProperty.call(req.body || {}, f.key));
      const old = {};
      for (const f of watched) {
        const prev = await pool.query(`SELECT ${f.key} AS v FROM ${table} WHERE id=$1`, [id]);
        old[f.key] = prev.rows[0] ? prev.rows[0].v : undefined;
      }
      // Churn: changing Last Date Under Contract re-stamps Date Added (the drop re-entered now).
      if (table === 'churn' && req.body && Object.prototype.hasOwnProperty.call(req.body, 'last_date_under_contract')) {
        const norm = (v) => (v ? String(v).slice(0, 10) : '');
        if (norm(old.last_date_under_contract) !== norm(req.body.last_date_under_contract)) req.body.date_added = todayStr();
      }
      // Bookings: changing GoLive Date stamps GoLive Set Date = today (unless explicitly provided).
      if (table === 'bookings' && req.body && Object.prototype.hasOwnProperty.call(req.body, 'golive_date')
        && !Object.prototype.hasOwnProperty.call(req.body, 'golive_set_date')) {
        const norm = (v) => (v ? String(v).slice(0, 10) : '');
        if (norm(old.golive_date) !== norm(req.body.golive_date)) req.body.golive_set_date = todayStr();
      }
      const row = await updateRow(table, id, req.body || {});
      if (!row) return res.status(404).json({ error: 'Not found' });
      for (const f of watched) {
        if (old[f.key] === undefined || sameWatched(old[f.key], row[f.key], f.money)) continue;
        await createNotification(table, row.id,
          `${f.label} changed for ${WATCHED_NAME[table](row)}: ${fmtWatched(old[f.key], f.money)} → ${fmtWatched(row[f.key], f.money)}`);
      }
      res.json(withComputed(row, computeFn));
    } catch (e) { next(e); }
  });
}
// Auto-track a newly created booking in Sales Support: if no row yet exists for its
// quarter + PMC + product category + section (Pilot vs CTAM, from Pilot or CTAM), create one
// seeded from the booking — Quarter Target / Worst / Accurate / Best = Company Total Booking,
// monthly targets = 0. Best-effort: a failure never blocks the booking from being created.
async function autoTrackBookingInSalesSupport(b) {
  const month = String(b.booking_month || '').trim();
  const year = b.booking_year;
  if (!month || year === null || year === undefined || year === '') return;
  const info = quarterFromMonthName(month, year);
  if (!info) return;
  const period = `Q${info.q} ${info.year}`;
  if (!(await getPeriod(period))) return; // no forecast quarter for this booking — skip
  const pmc = String(b.pmc || '').trim();
  // SEO is tracked as its own "Product" line (it still groups under Digital Advertising in the
  // sheet); every other product uses its BPR category.
  const category = String(b.product || '').trim() === 'SEO' ? 'SEO' : String(b.bpr_prod_category || '').trim();
  if (!pmc || !category) return;
  const section = String(b.pilot_or_ctam || '').trim() === 'Pilot' ? 'Pilot / New Logo' : 'CTAM';
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const existing = await listRows('sales_support');
  const already = existing.some((r) => r.period === period
    && norm(r.pmc) === norm(pmc) && norm(r.product_category) === norm(category) && norm(r.section) === norm(section));
  if (already) return;
  const total = Number(b.company_total_booking) || 0;
  await insertRow('sales_support', {
    period,
    product_category: category,
    section,
    pmc,
    booking_type: section === 'Pilot / New Logo' ? 'Pilot' : (b.ctam_type || ''),
    account_owner: b.sales_rep || '',
    q2_target: total, apr_target: 0, may_target: 0, jun_target: 0,
    worst: total, accurate: total, best: total, notes: '',
  });
}
// When a Conversion booking is created (a pilot converting to paid), stamp its Billing Notes
// so billing can see it's a converted property and when. The conversion is what's recognized
// in SaaS Financials (pure pilots are excluded until then).
async function noteConversionBilling(b) {
  if (String(b.pilot_type || '').trim() !== 'Conversion') return;
  const existing = String(b.billing_notes || '').trim();
  if (/converted property/i.test(existing)) return; // already noted
  const when = String(b.date_signed || b.golive_date || '').slice(0, 10);
  const note = `Converted property${when ? ` (converted ${when})` : ''}`;
  await updateRow('bookings', b.id, { billing_notes: existing ? `${existing} | ${note}` : note });
}
// After a booking is created: auto-track it in Sales Support and (if a conversion) note it.
// Each is best-effort so one failing never blocks the booking or the other.
async function onBookingCreated(b) {
  try { await autoTrackBookingInSalesSupport(b); } catch (e) { console.error('[autoTrack]', e.message); }
  try { await noteConversionBilling(b); } catch (e) { console.error('[conversionNote]', e.message); }
}
// A Conversion booking should OVERRIDE the property's existing pilot booking (same Property ID +
// Product) in place rather than create a duplicate. Recognition restarts at the conversion's
// GoLive (cleared here; set it when the property actually converts/goes live). Returns the
// updated row, or null if there's no matching pilot to convert (then it inserts normally).
async function maybeConvertExisting(body) {
  if (String(body.pilot_type || '').trim() !== 'Conversion') return null;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const pid = norm(body.property_id);
  const prod = norm(body.product);
  if (!pid || !prod) return null;
  // Match purely on Property ID + Product (any existing line item for it), so a conversion
  // always updates the existing record instead of creating a duplicate.
  const matches = (await listRows('bookings')).filter((b) => norm(b.property_id) === pid && norm(b.product) === prod);
  if (!matches.length) return null;
  const target = matches[matches.length - 1]; // the most recent line item for this property + product
  const merged = { ...body, golive_date: null }; // recognized only once the conversion goes live
  // Never overwrite the existing One-Time / implementation fee — it was billed during the pilot.
  delete merged.one_time_fee;
  const fee = Number(target.one_time_fee) || 0;
  const existingNote = String(target.billing_notes || '').trim();
  if (!/converted property/i.test(existingNote)) {
    const when = String(body.date_signed || '').slice(0, 10);
    let note = `Converted property${when ? ` (converted ${when})` : ''}`;
    if (fee > 0) note += ' — one-time/implementation fee already on the original booking; do NOT double-bill';
    merged.billing_notes = existingNote ? `${existingNote} | ${note}` : note;
  }
  return updateRow('bookings', target.id, merged);
}
crud('bookings', computeBooking, onBookingCreated, maybeConvertExisting);
// "Date Added" is system-generated: stamp it on creation (manual add / upload) when not provided.
const todayStr = () => new Date().toISOString().slice(0, 10);
function churnDefaults(body) {
  if (body && !body.date_added) body.date_added = todayStr();
  return null; // not handled as an update — proceed to a normal insert with the stamped body
}
crud('churn', computeChurn, undefined, churnDefaults);

// ---- License Transfer offset: a booking offsets a same-PMC, same-quarter churn ----
// Tags the booking as a License Transfer with the offset, reclassifies the churn as a
// Contraction (excluded from churn totals), and stamps cross-reference notes on both.
const norm = (v) => String(v ?? '').trim().toLowerCase();
const appendNote = (existing, addition) => {
  const cur = String(existing || '').trim();
  if (!addition || cur.includes(addition)) return cur;
  return cur ? `${cur} | ${addition}` : addition;
};
const usd = (v) => (v === null || v === undefined ? '$0' : `$${Number(v).toLocaleString('en-US')}`);
// Apply one OR MANY churns to a single License Transfer booking. The booking's total offset is
// the sum of the amounts used. Each churn that is fully used is reclassified as a Contraction
// (and so excluded from churn totals). A churn only partially used is SPLIT: the original line
// becomes the used (Contraction) portion and a NEW churn line carries the remaining real churn,
// each annotated so billing won't double-count.
app.post('/api/bookings/apply-offset', requireRole('admin', 'standard'), async (req, res, next) => {
  try {
    const body = req.body || {};
    // Accept the new list shape, or the legacy single-churn shape.
    let offsets = Array.isArray(body.offsets) ? body.offsets
      : (body.churnId ? [{ churnId: body.churnId, amount: body.offsetAmount }] : []);
    offsets = offsets
      .map((o) => ({ churnId: Number(o.churnId), amount: Number(String(o.amount ?? '').replace(/[$,]/g, '')) }))
      .filter((o) => o.churnId && Number.isFinite(o.amount) && o.amount > 0);
    if (!offsets.length) return res.status(400).json({ error: 'Select at least one churn to offset, with a valid amount.' });

    const booking = (await pool.query('SELECT * FROM bookings WHERE id=$1', [Number(body.bookingId)])).rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    const bQ = quarterFromMonthName(booking.booking_month, booking.booking_year);
    if (!bQ) return res.status(400).json({ error: 'Could not determine the quarter of the booking.' });
    const bookingProp = booking.property_name || booking.property_id || 'booking';
    const bookingPeriod = `${booking.booking_month || ''} ${booking.booking_year || ''}`.trim();

    // Validate EVERY churn before mutating anything (PMC, quarter, not already used).
    const work = [];
    for (const o of offsets) {
      const churn = (await pool.query('SELECT * FROM churn WHERE id=$1', [o.churnId])).rows[0];
      if (!churn) return res.status(404).json({ error: 'A selected churn was not found.' });
      if (norm(booking.pmc) !== norm(churn.pmc_buying_center)) {
        return res.status(400).json({ error: 'A selected churn is under a different PMC than the booking.' });
      }
      if (String(churn.classification || '') === 'Contraction') {
        return res.status(400).json({ error: 'A selected churn has already been used to offset a booking.' });
      }
      const cQ = quarterFromMonthYear(computeChurn(churn).final_churn_month);
      if (!cQ) return res.status(400).json({ error: 'Could not determine the quarter of a selected churn.' });
      if (((cQ.year - bQ.year) * 4 + (cQ.q - bQ.q)) < 0) {
        return res.status(400).json({ error: 'A selected churn is in a quarter before the booking.' });
      }
      work.push({ churn, amount: o.amount });
    }

    // A churn "locked" in a closed month can't be reclassified (that would change a closed
    // month's totals). Instead we bring the offset over to the open month + issue a Churn Credit.
    const closed = Object.fromEntries((await listClosedMonths()).map((r) => [r.month, String(r.close_date).slice(0, 10)]));
    const lockedInClosedMonth = (churn) => {
      const ld = monthYear(churn.last_date_under_contract); // "May 2026"
      const cd = closed[ld];
      return cd ? { month: ld, locked: String(churn.date_added || '').slice(0, 10) <= cd } : { month: ld, locked: false };
    };

    const labels = [];
    let total = 0;
    for (const { churn, amount } of work) {
      const sign = (Number(churn.mrr) || 0) < 0 ? -1 : 1;
      const drop = Math.abs(Number(churn.mrr) || 0);
      const used = Math.min(amount, drop);
      total += used;
      const churnProp = churn.property || churn.pmc_buying_center || 'churned property';
      labels.push(`${churnProp} (${usd(used)})`);
      const cm = lockedInClosedMonth(churn);
      if (cm.locked) {
        // Closed-month churn: leave the original untouched (the closed month stays frozen). Bring
        // the offset over to the open month as a Contraction (display only), and issue a positive
        // Churn Credit that cancels the locked drop so net churn nets to zero.
        await insertRow('churn', {
          ...churn, mrr: sign * used, classification: 'Contraction', date_added: todayStr(),
          notes: `Brought over from ${cm.month} (closed) to offset ${bookingProp} (${bookingPeriod}) — License Transfer`,
        });
        await insertRow('churn', {
          ...churn, mrr: sign * used, classification: 'Churn Credit', date_added: todayStr(),
          notes: `Churn Credit from ${cm.month} (offset of ${bookingProp}, ${bookingPeriod})`,
        });
      } else if (used >= drop - 0.005) {
        // Fully used — the whole churn was a transfer, not a loss.
        const cNote = appendNote(churn.notes, `Used to offset ${bookingProp} (${bookingPeriod}) — License Transfer`);
        await updateRow('churn', churn.id, { classification: 'Contraction', notes: cNote });
      } else {
        // Partially used — split into the Contraction (used) portion + remaining real churn.
        const remaining = drop - used;
        const cNote = appendNote(churn.notes,
          `${usd(used)} used to offset ${bookingProp} (${bookingPeriod}); ${usd(remaining)} net remaining churn (split out to a new line) — License Transfer`);
        await updateRow('churn', churn.id, { mrr: sign * used, classification: 'Contraction', notes: cNote });
        const rNote = `Net remaining churn after License Transfer offset — ${usd(used)} used to offset ${bookingProp} (${bookingPeriod}), ${usd(remaining)} remaining`;
        await insertRow('churn', { ...churn, mrr: sign * remaining, classification: String(churn.classification || '') || 'Churn', notes: rNote });
      }
    }

    const bNote = appendNote(booking.notes, `Offset by ${labels.join(' + ')} (License Transfer)`);
    await pool.query(
      `UPDATE bookings SET pilot_or_ctam='CTAM', ctam_type='License Transfer',
         offset_amount=$1, offset_churn_id=$2, notes=$3, updated_at=now() WHERE id=$4`,
      [total, work[0].churn.id, bNote, booking.id]);

    const b2 = (await pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id])).rows[0];
    res.json({ booking: withComputed(b2, computeBooking), offsetsApplied: work.length, totalOffset: total });
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

// ---- Migrate Legacy Churn -> the active Churn Tracker ----
// Pulls every legacy churn line (with a Last Date Under Contract) into the live churn table,
// mapping as many columns as we can and tagging the billing notes "From Legacy" so billing
// knows it was already handled. Duplicates in the legacy file (same property+product, usually
// re-listed because the Last Date Under Contract was updated) collapse to the most-recent one
// (latest Cancellation/Date Added; ties break to the later sheet row). Properties already in
// the Churn Tracker (same property+product) are skipped so re-running never double-counts.
app.post('/api/churn/migrate-legacy', requireRole('admin'), async (_req, res, next) => {
  try {
    const legacy = await listRows('legacy_churn'); // ascending id == original sheet row order
    const existing = await listRows('churn');
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const key = (r) => `${norm(r.property_id) || norm(r.property_name || r.property)}|${norm(r.product)}`;
    const parseD = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : -Infinity; };
    // "Most recent" legacy row for a duplicate: latest Cancellation/Date Added, then later row.
    const recency = (r) => Math.max(parseD(r.cancellation_date_added), parseD(r.date_added));

    let skippedBlank = 0;
    let dupCollapsed = 0;
    // 1) Collapse legacy duplicates, keeping the most-recently-updated row per property+product.
    const best = new Map();
    for (const r of legacy) {
      if (!r.last_date_under_contract) { skippedBlank += 1; continue; }
      const k = key(r);
      if (!k.replace('|', '')) { skippedBlank += 1; continue; }
      const prev = best.get(k);
      if (!prev) { best.set(k, r); continue; }
      dupCollapsed += 1;
      if (recency(r) >= recency(prev)) best.set(k, r); // later row wins on a tie (>=)
    }

    // 2) Skip anything already in the live Churn Tracker (same property+product).
    const existingKeys = new Set(existing.map(key));
    let added = 0;
    let skippedExisting = 0;
    const addedRows = [];
    for (const [k, r] of best) {
      if (existingKeys.has(k)) { skippedExisting += 1; continue; }
      const last = String(r.last_date_under_contract).slice(0, 10);
      const notes = ['[From Legacy AR Tracker — billing already processed]',
        r.reason_lost ? `Reason: ${r.reason_lost}` : '', r.note || ''].filter(Boolean).join(' — ');
      const legacyAdded = Date.parse(String(r.date_added || r.cancellation_date_added || ''));
      const ins = await insertRow('churn', {
        property_id: r.property_id || '',
        sage_id: r.sage_id || '',
        pmc_buying_center: r.pmc_logo || '',
        property: r.property_name || '',
        product: r.product || '',
        mrr: r.sf_mrr,
        last_date_under_contract: last,
        client_success_manager: r.client_success_manager || '',
        completed: 'No Action needed', // billing: already handled in the legacy workbook
        notes,
        classification: 'Churn',
        // Preserve the legacy "Date Added" when present, else stamp the migration date.
        date_added: Number.isFinite(legacyAdded) ? new Date(legacyAdded).toISOString().slice(0, 10) : todayStr(),
      });
      existingKeys.add(k);
      added += 1;
      addedRows.push({ property: ins.property || ins.property_id || '', product: ins.product || '', mrr: ins.mrr, last_date_under_contract: last });
    }
    res.json({ added, skippedExisting, skippedBlank, dupCollapsed, legacyTotal: legacy.length, addedRows });
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

// Backfill Sales Support rows from existing bookings: for every booking in an OPEN quarter,
// ensure a row exists for its PMC + Product (SEO split out) + Section. Mirrors auto-track but
// runs across all bookings (e.g. after a bulk import, which doesn't auto-track). Never creates
// duplicates and never touches archived quarters. Returns how many rows were created.
app.post('/api/sales_support/sync', requireRole('admin', 'sales_admin'), async (_req, res, next) => {
  try {
    const periods = await listPeriods();
    const openPeriods = new Set(periods.filter((p) => p.status === 'open').map((p) => p.period));
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const keyOf = (period, pmc, cat, section) => `${period}||${norm(pmc)}||${norm(cat)}||${norm(section)}`;
    const have = new Set((await listRows('sales_support'))
      .map((r) => keyOf(r.period, r.pmc, r.product_category, r.section)));
    let created = 0;
    for (const raw of await listRows('bookings')) {
      const b = withComputed(raw, computeBooking);
      const month = String(b.booking_month || '').trim();
      const year = b.booking_year;
      if (!month || year === null || year === undefined || year === '') continue;
      const info = quarterFromMonthName(month, year);
      if (!info) continue;
      const period = `Q${info.q} ${info.year}`;
      if (!openPeriods.has(period)) continue; // only open quarters are editable
      const pmc = String(b.pmc || '').trim();
      const category = String(b.product || '').trim() === 'SEO' ? 'SEO' : String(b.bpr_prod_category || '').trim();
      if (!pmc || !category) continue;
      const section = String(b.pilot_or_ctam || '').trim() === 'Pilot' ? 'Pilot / New Logo' : 'CTAM';
      const k = keyOf(period, pmc, category, section);
      if (have.has(k)) continue;
      have.add(k); // avoid creating duplicates within this run
      const total = Number(b.company_total_booking) || 0;
      await insertRow('sales_support', {
        period, product_category: category, section, pmc,
        booking_type: section === 'Pilot / New Logo' ? 'Pilot' : (b.ctam_type || ''),
        account_owner: b.sales_rep || '',
        q2_target: total, apr_target: 0, may_target: 0, jun_target: 0,
        worst: total, accurate: total, best: total, notes: '',
      });
      created += 1;
    }
    res.json({ created });
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
// Admin "log in as": mint a session token for another user (impersonation). The token records
// who initiated it (imp_by) for traceability.
app.post('/api/impersonate/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const target = await getUserById(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const safe = { id: target.id, username: target.username, role: target.role, account_owner: target.account_owner || null };
    res.json({ token: signToken({ ...safe, imp_by: req.user.username }), user: safe });
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
    const addedRows = [];   // detail: new churn rows
    const changedRows = []; // detail: Last Date Under Contract updates
    for (const row of incoming) {
      // Rows without a Last Date Under Contract are not real churn events -> skip them.
      const next = row.last_date_under_contract ? String(row.last_date_under_contract).slice(0, 10) : '';
      if (!next) { skippedBlank += 1; continue; }
      const k = key(row);
      const match = byKey.get(k);
      if (!match) {
        // No existing churn line for this property/product/MRR -> add it (stamp Date Added = today).
        const ins = await insertRow('churn', { ...row, date_added: todayStr() });
        byKey.set(k, ins);
        added += 1;
        addedRows.push({ property: ins.property || ins.property_id || '', product: ins.product || '', mrr: ins.mrr, last_date_under_contract: next });
        continue;
      }
      // Same property/product/MRR already exists: compare Last Date Under Contract.
      const cur = match.last_date_under_contract ? String(match.last_date_under_contract).slice(0, 10) : '';
      if (cur === next) { unchanged += 1; continue; }
      // Last Date Under Contract changed -> update the existing row (re-stamp Date Added) + notify.
      await updateRow('churn', match.id, { last_date_under_contract: next, date_added: todayStr() });
      const who = match.property || match.property_id || 'a property';
      const msg = `Last Date Under Contract changed for ${who} (${match.product || 'product'}) from ${cur || '(blank)'} to ${next || '(blank)'}`;
      await createNotification('churn', match.id, msg);
      changeLines.push(msg);
      changedRows.push({ property: who, product: match.product || '', mrr: match.mrr, from: cur, to: next });
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
    res.json({ added, changed, unchanged, skippedBlank, total: incoming.length, addedRows, changedRows });
  } catch (e) { next(e); }
});

// ---- GoLives: update booking GoLive dates from a report; notify billing on changes ----
app.post('/api/bookings/golives', requireRole('admin', 'standard'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const incoming = parseGolives(req.file.buffer);
    const bookings = await listRows('bookings');
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const toNum = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
    // Match on Property ID + Product (not MRR) — the GoLives sheet is the source of truth for MRR.
    const key = (r) => `${norm(r.property_id)}|${norm(r.product)}`;
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
    let mrrUpdated = 0;
    const changeLines = [];
    const mrrLines = [];
    for (const row of incoming) {
      if (!row.golive_date) continue;
      const matches = byKey.get(key(row));
      if (!matches || !matches.length) { notFound += 1; continue; }
      const next = String(row.golive_date).slice(0, 10);
      const sheetMrr = toNum(row.mrr);
      for (const b of matches) {
        const who = b.property_name || b.property_id || 'a property';
        const patch = {};
        // GoLive date.
        const cur = b.golive_date ? String(b.golive_date).slice(0, 10) : '';
        if (!cur) { patch.golive_date = next; updated += 1; }
        else if (cur === next) { unchanged += 1; }
        else {
          patch.golive_date = next;
          const msg = `GoLive date changed for ${who} (${b.product || 'product'}) from ${cur} to ${next}`;
          await createNotification('bookings', b.id, msg);
          changeLines.push(msg);
          changed += 1;
        }
        // MRR — update to the sheet's value when provided and different; notify billing on change.
        if (sheetMrr !== null) {
          const curMrr = toNum(b.mrr);
          if (curMrr !== sheetMrr) {
            patch.mrr = sheetMrr;
            const money = (v) => (v === null || v === undefined ? '$0' : `$${Number(v).toLocaleString('en-US')}`);
            const msg = `MRR changed for ${who} (${b.product || 'product'}) from ${money(curMrr)} to ${money(sheetMrr)}`;
            await createNotification('bookings', b.id, msg);
            mrrLines.push(msg);
            mrrUpdated += 1;
          }
        }
        // Whenever the GoLive date is set/changed here, stamp when it was set (drives MRR carry-over).
        if (patch.golive_date) patch.golive_set_date = todayStr();
        if (Object.keys(patch).length) await updateRow('bookings', b.id, patch);
      }
    }
    const allLines = [...changeLines, ...mrrLines];
    if (allLines.length) {
      sendEmail({
        to: await notifyEmails(),
        subject: `PERQ: ${allLines.length} booking change${allLines.length === 1 ? '' : 's'} from a GoLives upload`,
        html: changeEmailHtml('Booking changes', 'The following GoLive dates / MRR values were updated from a GoLives upload:', allLines),
      });
    }
    res.json({ updated, changed, unchanged, notFound, mrrUpdated, total: incoming.length });
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
    // Date Added isn't in the workbook — stamp today for any churn row that lacks it.
    const stamped = churn.map((r) => (r.date_added ? r : { ...r, date_added: todayStr() }));
    await replaceAll('bookings', bookings);
    await replaceAll('churn', stamped);
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
