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
  createOffsetTxn, listOffsetTxns, getOffsetTxn, markOffsetTxnUndone,
  listProducts, loadCatalog,
  listClosedMonths, closeMonth, reopenMonth,
} from './db.js';
import { computeBooking, computeChurn, quarterFromMonthName, quarterFromMonthYear, monthYear, wholeMonthsBetween } from './compute.js';
import { parseWorkbook, parseChurnUpload, parseBookingReconcile, parseGolives, parseSalesforceRecon, parseLegacyTracker, parsePriorBookings, parseConvertEdit } from './importer.js';
import { buildWorkbook } from './exporter.js';
import { parseLegacyWorkbook } from './legacyImporter.js';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_BILLING_KEYS, CHURN_BILLING_KEYS, USER_ROLES, SALES_SUPPORT_FIELDS,
  SALESFORCE_RECON_FIELDS, LEGACY_GOLIVE_FIELDS, LEGACY_CHURN_FIELDS, BPR_CATEGORIES,
  CONVERT_BOOKING_FIELDS, CONVERT_BOOKING_COMPUTED,
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
// A version token that changes on every deploy (Railway restarts the process): the git commit
// SHA when available, else the boot timestamp. Clients poll it to detect a new deploy.
const APP_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_DEPLOYMENT_ID || String(Date.now());
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
    const safe = { id: user.id, username: user.username, role: user.role, account_owner: user.account_owner || null, convert_access: !!user.convert_access };
    // section_access rides on the /api/me response (read fresh), not the token, so grants apply live.
    res.json({ token: signToken(safe), user: { ...safe, section_access: user.section_access || null } });
  } catch (e) { next(e); }
});

// Every other /api route requires a valid token.
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/health' || req.path === '/version') return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.get('x-app-key') || '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: payload.id, username: payload.username, role: payload.role, account_owner: payload.account_owner || null, convert_access: !!payload.convert_access };
  next();
});
// The Revenue Desk instance a request targets (client sends x-instance). Access to 'convert' is
// admin-only unless the user has been granted convert_access (checked fresh from the DB so a
// newly granted user doesn't need to re-login).
function reqInstance(req) { return req.get('x-instance') === 'convert' ? 'convert' : 'multifamily'; }
async function canAccessInstance(req, instance) {
  if (instance !== 'convert') return true;
  if (req.user.role === 'admin') return true;
  try { const u = await getUserById(req.user.id); return !!(u && u.convert_access); } catch { return false; }
}

// Read the user fresh from the DB so role/account_owner changes apply without re-login
// (and so older tokens that predate the account_owner field still resolve it).
app.get('/api/me', async (req, res, next) => {
  try {
    const u = await getUserById(req.user.id);
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user: { id: u.id, username: u.username, role: u.role, account_owner: u.account_owner || null, convert_access: !!u.convert_access, section_access: u.section_access || null } });
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

// ---- Section access (sidebar visibility, per-user) ----
// Sections are the sidebar tabs. Access is an explicit per-user allow-list (section_access); when a
// user has none set we fall back to what their role has always shown. Admins always see everything.
// Kept in sync with the client's roleDefaultSections()/userSections() in app.js.
const ALL_SECTIONS = ['dashboard', 'newbooking', 'bookings', 'salessupport', 'churn', 'saas', 'billing', 'sfrecon', 'legacy'];
function roleDefaultSections(role) {
  const base = ['dashboard', 'bookings', 'churn', 'salessupport'];
  if (role === 'admin') return ALL_SECTIONS.slice();
  if (role === 'standard') return [...base, 'saas'];
  if (role === 'billing') return [...base, 'saas', 'billing', 'legacy'];
  return base; // sales_admin, sales, viewer
}
function effectiveSections(user) {
  if (!user) return [];
  if (user.role === 'admin') return ALL_SECTIONS.slice();
  const sa = user.section_access;
  return (Array.isArray(sa) && sa.length) ? sa : roleDefaultSections(user.role);
}
// Read the user fresh so a just-granted section works without re-login.
async function sectionAllowed(req, section) {
  if (req.user.role === 'admin') return true;
  try { const u = await getUserById(req.user.id); return effectiveSections(u).includes(section); } catch { return false; }
}
const requireSection = (section) => async (req, res, next) => {
  try { if (await sectionAllowed(req, section)) return next(); } catch { /* fall through */ }
  res.status(403).json({ error: 'You do not have permission to do that.' });
};

const BILLING_KEYS = { bookings: BOOKING_BILLING_KEYS, churn: CHURN_BILLING_KEYS };

const withComputed = (row, fn) => ({ ...row, ...fn(row) });

// ---- Downgrade paid-months: read-time lookup of the property's existing GoLive ----
// A Downgrade assumes the property already has a booking. "Months already paying the old MRR" =
// whole months from that existing booking's GoLive date to the Downgrade's Date Signed. Built from
// the FULL bookings list (the original may be a different month/year than the downgrade).
function goliveByProperty(allBookings) {
  const m = new Map();
  const put = (k, gl) => { if (!k || !gl) return; const cur = m.get(k); if (!cur || String(gl) < String(cur)) m.set(k, gl); };
  for (const b of allBookings) {
    if (!b.golive_date) continue;
    if (String(b.ctam_type || '').trim() === 'Downgrade') continue; // never reference a downgrade row itself
    const pid = String(b.property_id || '').trim().toLowerCase();
    const prod = String(b.product || '').trim().toLowerCase();
    put(`${pid}|${prod}`, b.golive_date); // same subscription line (property + product)
    put(`${pid}|`, b.golive_date);        // property-level fallback (earliest go-live)
  }
  return m;
}
// Paid months for a Downgrade booking (undefined for non-downgrades → computeBooking ignores it).
function downgradePaid(r, glMap) {
  if (String(r.ctam_type || '').trim() !== 'Downgrade') return undefined;
  const pid = String(r.property_id || '').trim().toLowerCase();
  const prod = String(r.product || '').trim().toLowerCase();
  const gl = glMap.get(`${pid}|${prod}`) || glMap.get(`${pid}|`);
  return gl ? wholeMonthsBetween(gl, r.date_signed) : 0;
}
// Merge computed booking fields, resolving Downgrade paid-months from a prebuilt GoLive map.
const withBooking = (row, glMap) => ({ ...row, ...computeBooking(row, downgradePaid(row, glMap)) });
// Compute a single booking row: fetch the list once to resolve any Downgrade paid-months.
async function computeBookingRow(row) {
  const all = await listRows('bookings');
  return withBooking(row, goliveByProperty(all));
}

// Owner dropdown options = Salesforce Recon Account Owner full names + any original
// options that have no Recon match (e.g. "House/CSM", "Doug") + blank if originally allowed.
function ownerOptions(originalOptions, reconOwners) {
  const firsts = new Set(reconOwners.map((n) => n.split(/\s+/)[0].toLowerCase()));
  const keepLegacy = originalOptions.filter((o) => o && !firsts.has(o.split(/\s+/)[0].toLowerCase()));
  const sorted = [...reconOwners].sort((a, b) => a.localeCompare(b));
  return [...(originalOptions.includes('') ? [''] : []), ...sorted, ...keepLegacy];
}

// ---- Schema (drives the frontend forms) ----
app.get('/api/schema', async (req, res, next) => {
  try {
    const recon = await listRows('salesforce_recon');
    const owners = [...new Set(recon.map((r) => String(r.account_owner ?? '').trim()).filter(Boolean))];
    // Product dropdown options come from the admin-managed products table (source of truth).
    const products = await listProducts();
    const productNames = products.map((p) => String(p.name || '').trim()).filter(Boolean);
    const productCategories = Object.fromEntries(products.map((p) => [p.name, p.bpr_category]));
    // Convert bookings use their own field set (category-tagged rows, different columns). The
    // other datasets are Multifamily-only, so we serve the Multifamily definitions regardless
    // (the Convert client ignores them).
    const bookingFields = reqInstance(req) === 'convert'
      ? CONVERT_BOOKING_FIELDS
      : BOOKING_FIELDS.map((f) => {
        if (f.key === 'sales_rep') return { ...f, options: ownerOptions(f.options, owners) };
        if (f.key === 'product' && productNames.length) return { ...f, options: productNames };
        return f;
      });
    const bookingsSchema = reqInstance(req) === 'convert'
      ? { editable: bookingFields, computed: CONVERT_BOOKING_COMPUTED, billing: [] }
      : { editable: bookingFields, computed: BOOKING_COMPUTED, billing: BOOKING_BILLING_KEYS };
    const ssFields = SALES_SUPPORT_FIELDS.map((f) =>
      f.key === 'account_owner' ? { ...f, options: ownerOptions(f.options, owners) } : f);
    res.json({
      bookings: bookingsSchema,
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

// Auto-derived "Downgrade" churn lines. A Re-rate / Downgrade booking whose Re-rate Old MRR is
// higher than its new MRR is a drop: we surface that drop as a read-only churn line recognized the
// month AFTER the booking's signing month, with Final Churn Amount = new MRR − old MRR (negative).
// These are NOT stored — they're recomputed from the bookings on every churn read, so they always
// track the booking (edit the booking to change the drop; delete it and the line disappears).
const DG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function deriveDowngradeChurn(bookings) {
  const num = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0; };
  const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString('en-US')}`;
  const out = [];
  for (const b of bookings) {
    if ((b.instance || 'multifamily') !== 'multifamily') continue;
    const adj = String(b.booking_adjustment || '').trim();
    if (adj === 'Booking Clawback' || adj === 'Booking Correction') continue; // accounting correction, not MRR movement
    const ctam = String(b.ctam_type || '').trim();
    if (ctam !== 'Re-rate' && ctam !== 'Downgrade') continue;
    const oldMrr = num(b.rerate_old_mrr);
    const newMrr = num(b.mrr);
    if (!(oldMrr > newMrr)) continue; // only an actual MRR drop
    const base = String(b.date_signed || b.golive_date || '').match(/^(\d{4})-(\d{2})/);
    if (!base) continue;
    const sY = Number(base[1]); const sM = Number(base[2]); // signing year + 1-based month
    let ny = sY; let nmi = sM; // month AFTER signing (sM is already the next month, 0-based -> DG_MONTHS[sM])
    if (nmi > 11) { nmi = 0; ny += 1; }
    const finalChurnMonth = `${DG_MONTHS[nmi]} ${ny}`;
    const lastDay = new Date(Date.UTC(sY, sM, 0)); // last day of the signing month (informational)
    const lduc = lastDay.toISOString().slice(0, 10);
    const drop = Math.round((newMrr - oldMrr) * 100) / 100; // negative
    out.push({
      id: `dg-${b.id}`, auto: 'downgrade',
      property_id: b.property_id || '', product: b.product || '',
      property: b.property_name || '', pmc_buying_center: b.pmc || '',
      client_success_manager: '', google_search_budget: null, lost_mrr_reason: '',
      mrr: Math.round((oldMrr - newMrr) * 100) / 100, // positive reduction magnitude
      last_date_under_contract: lduc, date_added: (b.date_signed || lduc),
      classification: 'Downgrade', completed: '', template_deleted: '',
      notes: `Downgrade — re-rate ${money(oldMrr)} → ${money(newMrr)} (auto from booking)`,
      // Computed churn fields set directly: a clean full drop the month after signing (no proration).
      final_invoice_month: '', ar_final_invoice_amount: null,
      prorated_churn_month: '', prorated_churn_amount: null,
      final_churn_month: finalChurnMonth, final_churn_amount: drop,
    });
  }
  return out;
}

function crud(table, computeFn, afterInsert, beforeInsert, instanceScoped) {
  // Read: any authenticated user. Churn rows are enriched with their Account Owner (from Recon).
  app.get(`/api/${table}`, async (req, res, next) => {
    try {
      const instance = instanceScoped ? reqInstance(req) : null;
      if (instance && !(await canAccessInstance(req, instance))) return res.status(403).json({ error: 'No access to that instance.' });
      const raw = await listRows(table);
      // Bookings carry Downgrade paid-months context (from the property's existing GoLive).
      let out = table === 'bookings'
        ? (() => { const glMap = goliveByProperty(raw); return raw.map((r) => withBooking(r, glMap)); })()
        : raw.map((r) => withComputed(r, computeFn));
      if (instanceScoped) out = out.filter((r) => (r.instance || 'multifamily') === instance);
      if (table === 'churn') {
        // Append read-only, auto-derived Downgrade churn lines (from Re-rate/Downgrade bookings).
        out = out.concat(deriveDowngradeChurn(await listRows('bookings')));
        out = await attachChurnOwners(out);
      }
      res.json(out);
    } catch (e) { next(e); }
  });
  // Create / delete rows: admin or standard only.
  app.post(`/api/${table}`, requireRole('admin', 'standard'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (instanceScoped) {
        const instance = reqInstance(req);
        if (!(await canAccessInstance(req, instance))) return res.status(403).json({ error: 'No access to that instance.' });
        body.instance = instance; // stamp the active instance on the new row
      }
      // beforeInsert may handle this as an update of an existing row (e.g. a Conversion that
      // overrides its pilot booking) and return that row — then no new row is inserted.
      if (beforeInsert) {
        const replaced = await beforeInsert(body);
        if (replaced) return res.json(table === 'bookings' ? await computeBookingRow(replaced) : withComputed(replaced, computeFn));
      }
      const row = await insertRow(table, body);
      // `instance` isn't a schema/grid field, so insertRow doesn't write it — stamp it explicitly
      // when creating in a non-default instance.
      if (instanceScoped && body.instance && body.instance !== (row.instance || 'multifamily')) {
        await pool.query('UPDATE bookings SET instance=$1 WHERE id=$2', [body.instance, row.id]);
        row.instance = body.instance;
      }
      const computed = table === 'bookings' ? await computeBookingRow(row) : withComputed(row, computeFn);
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
      // Bookings: if an offset is reverted (CTAM Type no longer License Transfer), drop the stale
      // churn link so the booking becomes available to offset again.
      if (table === 'bookings' && row.offset_churn_id != null
        && String(row.ctam_type || '').trim() !== 'License Transfer') {
        await pool.query('UPDATE bookings SET offset_churn_id = NULL WHERE id=$1', [id]);
        row.offset_churn_id = null;
      }
      // Sage ID is per-property: setting it on one order fills the property's other orders that
      // don't have one yet (never overwrites an existing Sage ID).
      if (table === 'bookings' && req.body && Object.prototype.hasOwnProperty.call(req.body, 'sage_id')) {
        const sid = String(row.sage_id || '').trim();
        const pid = String(row.property_id || '').trim();
        if (sid && pid) {
          await pool.query(
            `UPDATE bookings SET sage_id = $1
               WHERE lower(trim(property_id)) = lower(trim($2)) AND (sage_id IS NULL OR trim(sage_id) = '') AND id <> $3`,
            [sid, pid, id]);
        }
      }
      for (const f of watched) {
        if (old[f.key] === undefined || sameWatched(old[f.key], row[f.key], f.money)) continue;
        await createNotification(table, row.id,
          `${f.label} changed for ${WATCHED_NAME[table](row)}: ${fmtWatched(old[f.key], f.money)} → ${fmtWatched(row[f.key], f.money)}`,
          { fieldKey: f.key, oldValue: old[f.key], newValue: row[f.key] });
      }
      res.json(table === 'bookings' ? await computeBookingRow(row) : withComputed(row, computeFn));
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
  const already = existing.some((r) => (r.level || 'product') !== 'property' && r.period === period
    && norm(r.pmc) === norm(pmc) && norm(r.product_category) === norm(category) && norm(r.section) === norm(section));
  if (!already) {
    const total = Number(b.company_total_booking) || 0;
    await insertRow('sales_support', {
      period, level: 'product', product_category: category, section, pmc,
      booking_type: section === 'Pilot / New Logo' ? 'Pilot' : (b.ctam_type || ''),
      account_owner: b.sales_rep || '',
      q2_target: total, apr_target: 0, may_target: 0, jun_target: 0,
      worst: total, accurate: total, best: total, notes: '',
    });
  }
  // Also ensure a property-level row exists for this property (targets entered manually later).
  const propId = String(b.property_id || '').trim();
  if (propId) {
    const haveProp = existing.some((r) => (r.level || '') === 'property'
      && r.period === period && norm(r.property_id) === norm(propId));
    if (!haveProp) {
      await insertRow('sales_support', {
        period, level: 'property', property_id: propId,
        property: b.property_name || b.property_only || propId, pmc,
        account_owner: b.sales_rep || '',
        q2_target: 0, apr_target: 0, may_target: 0, jun_target: 0,
        worst: 0, accurate: 0, best: 0, notes: '',
      });
    }
  }
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
  // Sales Support / conversion-billing are Multifamily concepts — skip them for other instances.
  if ((b.instance || 'multifamily') !== 'multifamily') return;
  try { await autoTrackBookingInSalesSupport(b); } catch (e) { console.error('[autoTrack]', e.message); }
  try { await noteConversionBilling(b); } catch (e) { console.error('[conversionNote]', e.message); }
}
// The Sage ID already on file for a property (any of its bookings in the same instance), or ''.
async function sageIdForProperty(propertyId, excludeId, instance = 'multifamily') {
  const pid = String(propertyId || '').trim();
  if (!pid) return '';
  const params = [pid, instance];
  let sql = "SELECT sage_id FROM bookings WHERE lower(trim(property_id)) = lower(trim($1))"
    + " AND COALESCE(instance,'multifamily') = $2 AND sage_id IS NOT NULL AND trim(sage_id) <> ''";
  if (excludeId) { params.push(excludeId); sql += ` AND id <> $${params.length}`; }
  sql += ' ORDER BY id DESC LIMIT 1';
  const q = await pool.query(sql, params);
  return q.rows[0] ? q.rows[0].sage_id : '';
}
// A Conversion booking should OVERRIDE the property's existing pilot booking (same Property ID +
// Product) in place rather than create a duplicate. Recognition restarts at the conversion's
// GoLive (cleared here; set it when the property actually converts/goes live). Returns the
// updated row, or null if there's no matching pilot to convert (then it inserts normally).
async function maybeConvertExisting(body) {
  const instance = body.instance || 'multifamily';
  // Sage ID is per-property: a new order for a property that already has one inherits it.
  if (body && String(body.property_id || '').trim() && !String(body.sage_id || '').trim()) {
    const s = await sageIdForProperty(body.property_id, null, instance);
    if (s) body.sage_id = s;
  }
  if (String(body.pilot_type || '').trim() !== 'Conversion') return null;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const pid = norm(body.property_id);
  const prod = norm(body.product);
  if (!pid || !prod) return null;
  // Match purely on Property ID + Product within the same instance, so a conversion updates the
  // existing record instead of creating a duplicate (and never crosses instances).
  const matches = (await listRows('bookings')).filter((b) => (b.instance || 'multifamily') === instance
    && norm(b.property_id) === pid && norm(b.product) === prod);
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
// Convert bookings have no computed columns (all manual for now) and don't share the
// Multifamily booking-type math — return them unchanged so compute.js never runs on them.
const computeBookingScoped = (r) => ((r.instance || 'multifamily') === 'convert' ? {} : computeBooking(r));
crud('bookings', computeBookingScoped, onBookingCreated, maybeConvertExisting, true); // instance-scoped
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

    // The locked piece is the PRORATED churn (the partial-month remainder) when its month is
    // closed — the final/rooftop churn lands the next (open) month and is handled normally. A
    // locked prorated drop can't be reclassified (that would change a closed month), so we bring
    // it over to the open month as a Contraction and issue a positive Churn Credit to cancel it.
    const closed = Object.fromEntries((await listClosedMonths()).map((r) => [r.month, String(r.close_date).slice(0, 10)]));
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    // Last day of a "Month Year" label, e.g. "May 2026" -> "2026-05-31" (so a brought-over row
    // recognizes as a clean full amount in the FOLLOWING open month, not a re-prorated split).
    const lastDayOfMonthLabel = (label) => {
      const [mn, y] = String(label).split(' ');
      const mi = MONTH_NAMES.indexOf(mn);
      if (mi < 0 || !y) return null;
      const last = new Date(Number(y), mi + 1, 0).getDate();
      return `${y}-${String(mi + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    };
    // Last day of the month BEFORE the label (so a row's Final Churn lands IN the label's month).
    const lastDayBeforeMonth = (label) => {
      const [mn, y] = String(label).split(' ');
      const mi = MONTH_NAMES.indexOf(mn);
      if (mi < 0 || !y) return null;
      const d = new Date(Number(y), mi, 0); // day 0 of month mi = last day of the previous month
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const lockedProrated = (churn) => {
      const cc = computeChurn(churn);
      const pm = String(cc.prorated_churn_month || '').trim();      // "May 2026" or "-"
      const pa = Math.abs(Number(cc.prorated_churn_amount) || 0);   // the prorated drop magnitude
      if (!pm || pm === '-' || pa === 0) return null;
      const cd = closed[pm];
      if (!cd || String(churn.date_added || '').slice(0, 10) > cd) return null; // not closed / not locked
      return { month: pm, amount: pa };
    };

    // Undo snapshot: the booking's offset fields + the churns we're about to modify, and the set of
    // churn ids that already exist (so afterwards we can identify the split/credit rows we inserted).
    const bookingBefore = { pilot_or_ctam: booking.pilot_or_ctam, ctam_type: booking.ctam_type,
      offset_amount: booking.offset_amount, offset_churn_id: booking.offset_churn_id, notes: booking.notes };
    const churnSnapshots = work.map((w) => ({ id: w.churn.id, before: { ...w.churn } }));
    const beforeChurnIds = new Set((await pool.query('SELECT id FROM churn')).rows.map((r) => r.id));

    const labels = [];
    let total = 0;
    for (const { churn, amount } of work) {
      const sign = (Number(churn.mrr) || 0) < 0 ? -1 : 1;
      const drop = Math.abs(Number(churn.mrr) || 0);
      const used = Math.min(amount, drop);
      total += used;
      const churnProp = churn.property || churn.pmc_buying_center || 'churned property';
      labels.push(`${churnProp} (${usd(used)})`);
      const locked = lockedProrated(churn);
      if (locked) {
        // Closed-month churn. The prorated piece is locked in the closed month; the final/rooftop
        // piece is in the next (open) month. The offset consumes the prorated FIRST, then the
        // rooftop. We never change the closed month — instead we bring the prorated over to the
        // open month + issue a Churn Credit that cancels it; the leftover prorated stays as Churn
        // Net; the rooftop is contracted only to the extent the offset reaches it.
        const cc = computeChurn(churn);
        const Pa = locked.amount;                                       // prorated drop (closed)
        const Pm = locked.month;
        const Fa = Math.abs(Number(cc.final_churn_amount) || 0);        // rooftop drop (open)
        const Fm = String(cc.final_churn_month || '').trim();
        // The math above already used any manual AR override (via computeChurn). The derived rows
        // below set their own MRR/dates and must re-prorate normally, so drop the override on them.
        churn.ar_override = null;
        const proratedUsed = Math.min(used, Pa);
        const proratedNet = Pa - proratedUsed;
        const broughtLast = lastDayOfMonthLabel(Pm) || churn.last_date_under_contract; // -> recognizes the open month
        const openBase = { ...churn, last_date_under_contract: broughtLast, date_added: todayStr() };
        // Credit the full prorated brought over (cancels the locked closed-month drop).
        await insertRow('churn', { ...openBase, mrr: sign * Pa, classification: 'Churn Credit',
          notes: `Churn Credit for prorated churn brought over from ${Pm} (offset of ${bookingProp}, ${bookingPeriod})` });
        // Brought-over prorated: the used part Contracted; any remainder kept as Churn Net.
        if (proratedUsed > 0.005) await insertRow('churn', { ...openBase, mrr: sign * proratedUsed, classification: 'Contraction',
          notes: `Prorated churn brought over from ${Pm} (closed), used to offset ${bookingProp} (${bookingPeriod}) — License Transfer` });
        if (proratedNet > 0.005) await insertRow('churn', { ...openBase, mrr: sign * proratedNet, classification: String(churn.classification || '') || 'Churn',
          notes: `Churn Net — prorated churn brought over from ${Pm}; ${usd(proratedNet)} not offset` });
        // Rooftop (final churn, open month): only touched if the offset reaches past the prorated.
        if (used > Pa + 0.005 && Fa > 0) {
          const rooftopUsed = Math.min(used - Pa, Fa);
          const rooftopRemain = Fa - rooftopUsed;
          // Repurpose the ORIGINAL row into just the rooftop (open month) as a Contraction, so the
          // closed-month prorated is NOT shown as a contraction in the closed month. The prorated
          // is restored as a locked real churn so the closed month's total is unchanged.
          await updateRow('churn', churn.id, {
            mrr: sign * rooftopUsed, last_date_under_contract: lastDayOfMonthLabel(Pm),
            classification: 'Contraction', date_added: todayStr(), ar_override: null,
            notes: appendNote(churn.notes, `Rooftop contracted to offset ${bookingProp} (${bookingPeriod}); prorated carried over (License Transfer)`),
          });
          await insertRow('churn', {
            ...churn, mrr: sign * Pa, last_date_under_contract: lastDayBeforeMonth(Pm),
            classification: String(churn.classification || '') || 'Churn', date_added: churn.date_added,
            notes: `Prorated churn retained in ${Pm} (closed) after the original was carried over to offset ${bookingProp}`,
          });
          if (rooftopRemain > 0.005) await insertRow('churn', {
            ...churn, mrr: sign * rooftopRemain, last_date_under_contract: lastDayOfMonthLabel(Pm),
            classification: String(churn.classification || '') || 'Churn', date_added: todayStr(),
            notes: `Churn Rooftop remaining in ${Fm}; ${usd(rooftopRemain)} not offset`,
          });
        }
      } else if (used >= drop - 0.005) {
        // Fully used — the whole churn was a transfer, not a loss.
        const cNote = appendNote(churn.notes, `Used to offset ${bookingProp} (${bookingPeriod}) — License Transfer`);
        await updateRow('churn', churn.id, { classification: 'Contraction', notes: cNote });
      } else {
        // Partially used (open months) — consume the OLDEST month first: the prorated/final-invoice
        // month, then the rooftop (final churn) month. Decompose into per-month pieces so each
        // contracts independently and the leftover stays as Churn Net / Churn Rooftop in its month.
        const cls = String(churn.classification || '') || 'Churn';
        const cc = computeChurn(churn);
        const Pa = Math.abs(Number(cc.prorated_churn_amount) || 0);
        const Pm = String(cc.prorated_churn_month || '').trim();
        const Fa = Math.abs(Number(cc.final_churn_amount) || 0);
        const Fm = String(cc.final_churn_month || '').trim();
        // The math above already used any manual AR override (via computeChurn). The derived rows
        // below set their own MRR/dates and must re-prorate normally, so drop the override on them.
        churn.ar_override = null;
        const hasPro = Pm && Pm !== '-' && Pa > 0;
        const proratedUsed = hasPro ? Math.min(used, Pa) : 0;
        const proratedRemain = hasPro ? Pa - proratedUsed : 0;
        const rooftopUsed = Math.min(Math.max(0, used - proratedUsed), Fa);
        const rooftopRemain = Fa - rooftopUsed;
        const roofLast = lastDayBeforeMonth(Fm); // a row whose Final Churn lands in the rooftop month
        if (hasPro) {
          // Repurpose the original as the prorated-month Contraction (oldest month, used first).
          await updateRow('churn', churn.id, {
            mrr: sign * proratedUsed, last_date_under_contract: lastDayBeforeMonth(Pm), classification: 'Contraction', ar_override: null,
            notes: appendNote(churn.notes, `Contracted ${usd(proratedUsed)} of the ${Pm} drop to offset ${bookingProp} (${bookingPeriod}) — License Transfer`),
          });
          if (proratedRemain > 0.005) await insertRow('churn', {
            ...churn, mrr: sign * proratedRemain, last_date_under_contract: lastDayBeforeMonth(Pm), classification: cls,
            notes: `Churn Net — ${usd(proratedRemain)} of the ${Pm} drop not offset`,
          });
          if (rooftopUsed > 0.005) await insertRow('churn', {
            ...churn, mrr: sign * rooftopUsed, last_date_under_contract: roofLast, classification: 'Contraction',
            notes: `Contracted ${usd(rooftopUsed)} of the ${Fm} rooftop to offset ${bookingProp} (${bookingPeriod}) — License Transfer`,
          });
          if (rooftopRemain > 0.005) await insertRow('churn', {
            ...churn, mrr: sign * rooftopRemain, last_date_under_contract: roofLast, classification: cls,
            notes: `Churn Rooftop — ${usd(rooftopRemain)} of the ${Fm} drop not offset`,
          });
        } else {
          // No prorated piece (full-month churn) — only the rooftop month.
          await updateRow('churn', churn.id, {
            mrr: sign * rooftopUsed, last_date_under_contract: roofLast, classification: 'Contraction', ar_override: null,
            notes: appendNote(churn.notes, `Contracted ${usd(rooftopUsed)} of the ${Fm} drop to offset ${bookingProp} (${bookingPeriod}) — License Transfer`),
          });
          if (rooftopRemain > 0.005) await insertRow('churn', {
            ...churn, mrr: sign * rooftopRemain, last_date_under_contract: roofLast, classification: cls,
            notes: `Churn Net — ${usd(rooftopRemain)} of the ${Fm} drop not offset`,
          });
        }
      }
    }

    const bNote = appendNote(booking.notes, `Offset by ${labels.join(' + ')} (License Transfer)`);
    await pool.query(
      `UPDATE bookings SET pilot_or_ctam='CTAM', ctam_type='License Transfer',
         offset_amount=$1, offset_churn_id=$2, notes=$3, updated_at=now() WHERE id=$4`,
      [total, work[0].churn.id, bNote, booking.id]);

    // Record an undo snapshot (best-effort — never blocks the offset itself).
    try {
      const afterChurnIds = (await pool.query('SELECT id FROM churn')).rows.map((r) => r.id);
      const insertedChurnIds = afterChurnIds.filter((id) => !beforeChurnIds.has(id));
      await createOffsetTxn({
        bookingId: booking.id,
        label: `${bookingProp}${bookingPeriod ? ` · ${bookingPeriod}` : ''} — offset by ${labels.join(' + ')}`,
        data: { bookingId: booking.id, bookingBefore, updatedChurns: churnSnapshots, insertedChurnIds },
        createdBy: req.user && req.user.username,
      });
    } catch (e) { console.error('[offsetTxn]', e.message); }

    const b2 = (await pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id])).rows[0];
    res.json({ booking: withComputed(b2, computeBooking), offsetsApplied: work.length, totalOffset: total });
  } catch (e) { next(e); }
});

// Recent (not-yet-undone) offset transactions, newest first — for the Undo panel.
app.get('/api/offset-txns', requireRole('admin', 'standard'), async (_req, res, next) => {
  try { res.json(await listOffsetTxns()); } catch (e) { next(e); }
});
// Undo an applied offset: delete the split/credit rows it created, restore the churns it modified
// to their exact prior state, and restore the booking's offset fields — all from the snapshot.
app.post('/api/bookings/undo-offset', requireRole('admin', 'standard'), async (req, res, next) => {
  try {
    const txnId = Number(req.body && req.body.txnId);
    const txn = txnId ? await getOffsetTxn(txnId) : null;
    if (!txn || txn.undone) return res.status(404).json({ error: 'That offset was not found or was already undone.' });
    const data = typeof txn.data === 'string' ? JSON.parse(txn.data) : txn.data;
    // 1) Remove the split / Churn Credit / carried-over rows this offset created.
    if (Array.isArray(data.insertedChurnIds) && data.insertedChurnIds.length) {
      await pool.query('DELETE FROM churn WHERE id = ANY($1)', [data.insertedChurnIds]);
    }
    // 2) Restore each churn we modified to its snapshot values.
    const cols = CHURN_FIELDS.map((f) => f.key);
    for (const u of (data.updatedChurns || [])) {
      const b = u.before || {};
      const sets = cols.map((c, i) => `"${c}"=$${i + 1}`).join(', ');
      const vals = cols.map((c) => (b[c] === undefined ? null : b[c]));
      vals.push(u.id);
      await pool.query(`UPDATE churn SET ${sets} WHERE id=$${vals.length}`, vals);
    }
    // 3) Restore the booking's offset fields (CTAM/Pilot, offset amount/link, notes).
    const bb = data.bookingBefore || {};
    await pool.query(
      'UPDATE bookings SET pilot_or_ctam=$1, ctam_type=$2, offset_amount=$3, offset_churn_id=$4, notes=$5, updated_at=now() WHERE id=$6',
      [bb.pilot_or_ctam ?? null, bb.ctam_type ?? null, bb.offset_amount ?? null, bb.offset_churn_id ?? null, bb.notes ?? null, data.bookingId]);
    await markOffsetTxnUndone(txn.id);
    res.json({ ok: true });
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

// ---- Salesforce Recon Data: master reference, replaced wholesale on import ----
// Readable by admins, plus any user explicitly granted the "sfrecon" section. (Import stays admin.)
app.get('/api/salesforce_recon', requireSection('sfrecon'), async (_req, res, next) => {
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

// ---- Legacy trackers: read-only archive from the old AR Tracking workbook ----
// Readable by admins/billing (role default) and anyone granted the "legacy" section.
app.get('/api/legacy_golives', requireSection('legacy'), async (_req, res, next) => {
  try { res.json(await listRows('legacy_golives')); } catch (e) { next(e); }
});
app.get('/api/legacy_churn', requireSection('legacy'), async (_req, res, next) => {
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
    const existingRows = await listRows('sales_support');
    const have = new Set(existingRows.filter((r) => (r.level || 'product') !== 'property')
      .map((r) => keyOf(r.period, r.pmc, r.product_category, r.section)));
    // Property-level rows are keyed by period + Property ID (one row per property).
    const propKey = (period, pid) => `${period}||prop||${norm(pid)}`;
    const haveProp = new Set(existingRows.filter((r) => (r.level || '') === 'property')
      .map((r) => propKey(r.period, r.property_id)));
    let created = 0;
    for (const raw of await listRows('bookings')) {
      if ((raw.instance || 'multifamily') !== 'multifamily') continue; // Sales Support is Multifamily-only
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
      const section = String(b.pilot_or_ctam || '').trim() === 'Pilot' ? 'Pilot / New Logo' : 'CTAM';
      // Product-level row (per PMC + Product category + Section).
      if (pmc && category) {
        const k = keyOf(period, pmc, category, section);
        if (!have.has(k)) {
          have.add(k);
          const total = Number(b.company_total_booking) || 0;
          await insertRow('sales_support', {
            period, level: 'product', product_category: category, section, pmc,
            booking_type: section === 'Pilot / New Logo' ? 'Pilot' : (b.ctam_type || ''),
            account_owner: b.sales_rep || '',
            q2_target: total, apr_target: 0, may_target: 0, jun_target: 0,
            worst: total, accurate: total, best: total, notes: '',
          });
          created += 1;
        }
      }
      // Property-level row (one per property; targets start blank, entered manually).
      const propId = String(b.property_id || '').trim();
      if (propId) {
        const pk = propKey(period, propId);
        if (!haveProp.has(pk)) {
          haveProp.add(pk);
          await insertRow('sales_support', {
            period, level: 'property', property_id: propId,
            property: b.property_name || b.property_only || propId, pmc,
            account_owner: b.sales_rep || '',
            q2_target: 0, apr_target: 0, may_target: 0, jun_target: 0,
            worst: 0, accurate: 0, best: 0, notes: '',
          });
          created += 1;
        }
      }
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
    const { username, password, role, account_owner, convert_access } = req.body || {};
    const u = String(username || '').trim();
    if (!u || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    const owner = role === 'sales' ? String(account_owner || '').trim() : null;
    res.status(201).json(await createUser({ username: u, password, role, account_owner: owner, convert_access: !!convert_access }));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username already exists.' });
    next(e);
  }
});
app.patch('/api/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { role, password, account_owner, convert_access, section_access } = req.body || {};
    if (role && !USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    // section_access, when provided, must be an array of known section keys (empty = role defaults).
    let sections;
    if (section_access !== undefined) {
      if (!Array.isArray(section_access)) return res.status(400).json({ error: 'section_access must be an array.' });
      sections = [...new Set(section_access)].filter((s) => ALL_SECTIONS.includes(s));
    }
    // Never leave the system with zero admins.
    if (role && role !== 'admin') {
      const target = await getUserById(id);
      if (target && target.role === 'admin' && (await countAdmins()) <= 1) {
        return res.status(400).json({ error: 'Cannot change the role of the last admin.' });
      }
    }
    const updated = await updateUser(id, { role, password, account_owner, convert_access, section_access: sections });
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
    const safe = { id: target.id, username: target.username, role: target.role, account_owner: target.account_owner || null, convert_access: !!target.convert_access };
    res.json({ token: signToken({ ...safe, imp_by: req.user.username }), user: { ...safe, section_access: target.section_access || null } });
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
      await createNotification('churn', match.id, msg, { fieldKey: 'last_date_under_contract', oldValue: cur, newValue: next });
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
    // Detail rows returned to the client (mirrors the Churn upload result tables).
    const setRows = [];       // GoLive date set (was blank)
    const changedRows = [];   // GoLive date changed (old -> new)
    const mrrRows = [];        // MRR updated from the sheet (old -> new)
    const notFoundRows = [];   // in the file, no matching booking (Property ID + Product)
    for (const row of incoming) {
      if (!row.golive_date) continue;
      const next = String(row.golive_date).slice(0, 10);
      const sheetMrr = toNum(row.mrr);
      const matches = byKey.get(key(row));
      if (!matches || !matches.length) {
        notFound += 1;
        notFoundRows.push({ property: row.property_id || '—', product: row.product || '—', golive_date: next });
        continue;
      }
      for (const b of matches) {
        const who = b.property_name || b.property_id || 'a property';
        const dispMrr = sheetMrr !== null ? sheetMrr : b.mrr;
        const patch = {};
        // GoLive date.
        const cur = b.golive_date ? String(b.golive_date).slice(0, 10) : '';
        if (!cur) {
          patch.golive_date = next; updated += 1;
          setRows.push({ property: who, product: b.product || '—', mrr: dispMrr, golive_date: next });
        } else if (cur === next) { unchanged += 1; }
        else {
          patch.golive_date = next;
          const msg = `GoLive date changed for ${who} (${b.product || 'product'}) from ${cur} to ${next}`;
          await createNotification('bookings', b.id, msg, { fieldKey: 'golive_date', oldValue: cur, newValue: next });
          changeLines.push(msg);
          changedRows.push({ property: who, product: b.product || '—', mrr: dispMrr, from: cur, to: next });
          changed += 1;
        }
        // MRR — update to the sheet's value when provided and different; notify billing on change.
        if (sheetMrr !== null) {
          const curMrr = toNum(b.mrr);
          if (curMrr !== sheetMrr) {
            patch.mrr = sheetMrr;
            const money = (v) => (v === null || v === undefined ? '$0' : `$${Number(v).toLocaleString('en-US')}`);
            const msg = `MRR changed for ${who} (${b.product || 'product'}) from ${money(curMrr)} to ${money(sheetMrr)}`;
            await createNotification('bookings', b.id, msg, { fieldKey: 'mrr', oldValue: curMrr, newValue: sheetMrr });
            mrrLines.push(msg);
            mrrRows.push({ property: who, product: b.product || '—', from: curMrr, to: sheetMrr });
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
    res.json({ updated, changed, unchanged, notFound, mrrUpdated, total: incoming.length,
      setRows, changedRows, mrrRows, notFoundRows });
  } catch (e) { next(e); }
});

// ---- Notifications (admin + billing, plus anyone granted the Billing section) ----
app.get('/api/notifications', requireSection('billing'), async (_req, res, next) => {
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

// Convert instance: import the "Retail SaaS Financials" EDIT tab into Convert bookings.
// One booking per populated W..ES month cell (Booking Month/Year from the column header,
// MRR = the cell value). Replaces ALL Convert bookings (full reseed) — Multifamily is untouched.
app.post('/api/bookings/import-edit', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    const instance = reqInstance(req);
    if (instance !== 'convert') return res.status(400).json({ error: 'The EDIT import is only for the Convert instance.' });
    if (!(await canAccessInstance(req, instance))) return res.status(403).json({ error: 'No access to that instance.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { rows, customers } = parseConvertEdit(req.file.buffer);
    // Full reseed of Convert bookings only (never touch Multifamily rows).
    await pool.query("DELETE FROM bookings WHERE COALESCE(instance, 'multifamily') = 'convert'");
    let imported = 0;
    for (const r of rows) {
      const row = await insertRow('bookings', r);
      await pool.query('UPDATE bookings SET instance = $1 WHERE id = $2', ['convert', row.id]);
      imported += 1;
    }
    res.json({ imported, customers });
  } catch (e) { next(e); }
});

// ---- Export: download current data as .xlsx ----
app.get('/api/export', async (req, res, next) => {
  try {
    const instance = reqInstance(req);
    if (!(await canAccessInstance(req, instance))) return res.status(403).json({ error: 'No access to that instance.' });
    const allBookings = (await listRows('bookings')).filter((r) => (r.instance || 'multifamily') === instance);
    // GoLive map is built from ALL bookings (the property's original may be a different month/year
    // than the downgrade being exported) so Downgrade paid-months resolve correctly.
    const glMap = goliveByProperty(allBookings);
    let bookings = allBookings;
    const { month, year } = req.query;
    if (month) bookings = bookings.filter((r) => r.booking_month === month);
    if (year) bookings = bookings.filter((r) => String(r.booking_year) === String(year));
    // Churn is Multifamily-only for now; a Convert export carries no churn.
    const churn = instance === 'convert' ? [] : await listRows('churn');
    // "For Sales Commission" export drops the billing (blue) columns from both tabs.
    const opts = req.query.scope === 'commission'
      ? { excludeBookingKeys: new Set(BOOKING_BILLING_KEYS), excludeChurnKeys: new Set(CHURN_BILLING_KEYS) }
      : {};
    opts.bookingCompute = (r) => computeBooking(r, downgradePaid(r, glMap));
    // Which tabs to include: 'both' (default), 'bookings', or 'churn'.
    const sheets = ['bookings', 'churn'].includes(req.query.sheets) ? req.query.sheets : 'both';
    opts.sheets = sheets;
    opts.instance = instance; // Convert exports its own single Bookings sheet (no churn)
    const buf = buildWorkbook(bookings, churn, opts);
    const stamp = new Date().toISOString().slice(0, 10);
    const namePart = sheets === 'churn' ? 'Churn_Tracker' : (sheets === 'bookings' ? 'Bookings' : 'Export');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PERQ_Revenue_Desk_${namePart}_${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});
// Current deploy version — clients poll this and prompt a refresh when it changes.
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));

// ---- Legacy migration: parse the old SaaS Financials workbook into legacy bookings ----
// Preview is a dry run (no writes); commit inserts the new rows tagged legacy. Both dedupe against
// existing bookings (same Property ID + Product + Booking Month/Year) so nothing already there is
// touched or duplicated. Admin only, Multifamily instance.
app.post('/api/legacy/preview', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const existing = (await listRows('bookings')).filter((b) => (b.instance || 'multifamily') === 'multifamily');
    const existingChurn = await listRows('churn');
    const { rows, churnRows, skipped, skippedWon, errors, perTab } = parseLegacyWorkbook(req.file.buffer, existing, existingChurn);
    // Per-quarter Company Total: what's already in the Revenue Desk vs what this migration adds,
    // so it can be checked against the workbook before committing.
    const byQ = {};
    const bump = (label, k, amt) => { if (!byQ[label]) byQ[label] = { existing: 0, toAdd: 0 }; byQ[label][k] += amt; };
    for (const b of existing) {
      const info = quarterFromMonthName(b.booking_month, b.booking_year); if (!info) continue;
      bump(`Q${info.q} ${info.year}`, 'existing', Number(withComputed(b, computeBooking).company_total_booking) || 0);
    }
    for (const r of rows) {
      const info = quarterFromMonthName(r.booking_month, r.booking_year); if (!info) continue;
      bump(`Q${info.q} ${info.year}`, 'toAdd', Number(r.company_total_override) || 0);
    }
    const quarters = Object.entries(byQ)
      .map(([label, v]) => ({ label, existing: v.existing, toAdd: v.toAdd, combined: v.existing + v.toAdd }))
      .sort((a, b) => { const A = a.label.match(/Q(\d)\s+(\d+)/); const B = b.label.match(/Q(\d)\s+(\d+)/); return (Number(A[2]) - Number(B[2])) || (Number(A[1]) - Number(B[1])); });
    res.json({
      toAdd: rows.length, churnToAdd: churnRows.length, skipped, skippedWon, perTab, quarters,
      errorCount: errors.length, errors: errors.slice(0, 50),
      sample: rows.slice(0, 25).map((r) => ({
        property: r.property_name || r.property_id, product: r.product,
        month: `${r.booking_month} ${r.booking_year}`, mrr: r.mrr, amount: r.company_total_override,
        golive: r.golive_date, pilot: r.pilot_or_ctam === 'Pilot',
      })),
    });
  } catch (e) { next(e); }
});
app.post('/api/legacy/commit', requireRole('admin'), upload.single('file'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) { client.release(); return res.status(400).json({ error: 'No file uploaded' }); }
    const existing = (await listRows('bookings')).filter((b) => (b.instance || 'multifamily') === 'multifamily');
    const existingChurn = await listRows('churn');
    const { rows, churnRows } = parseLegacyWorkbook(req.file.buffer, existing, existingChurn);
    // Insert booking rows AND churned-property rows (into the Churn Tracker) in ONE transaction
    // (atomic — a failure rolls the whole batch back), chunked into multi-row INSERTs.
    const bulkInsert = async (table, records, fields) => {
      if (!records.length) return 0;
      const cols = [...fields.map((f) => f.key), 'legacy', 'instance'].filter((c, i, a) => a.indexOf(c) === i);
      const usable = cols.filter((c) => c !== 'instance' || table === 'bookings'); // instance is bookings-only
      const quoted = usable.map((c) => `"${c}"`).join(', ');
      const CHUNK = 300; let n = 0;
      for (let i = 0; i < records.length; i += CHUNK) {
        const batch = records.slice(i, i + CHUNK);
        const params = []; const tuples = [];
        for (const rec of batch) {
          const ph = usable.map((c) => {
            let v = c === 'legacy' ? true : (c === 'instance' ? 'multifamily' : rec[c]);
            if (v === undefined) v = null;
            params.push(v); return `$${params.length}`;
          });
          tuples.push(`(${ph.join(', ')})`);
        }
        await client.query(`INSERT INTO ${table} (${quoted}) VALUES ${tuples.join(', ')}`, params);
        n += batch.length;
      }
      return n;
    };
    await client.query('BEGIN');
    const added = await bulkInsert('bookings', rows, BOOKING_FIELDS);
    const churnAdded = await bulkInsert('churn', churnRows, CHURN_FIELDS);
    await client.query('COMMIT');
    res.json({ added, churnAdded });
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } next(e); }
  finally { client.release(); }
});
// Undo a migration: delete every legacy-tagged booking + churn row (never touches real data).
app.post('/api/legacy/clear', requireRole('admin'), async (_req, res, next) => {
  try {
    const b = await pool.query('DELETE FROM bookings WHERE legacy = true');
    const c = await pool.query('DELETE FROM churn WHERE legacy = true');
    res.json({ removedBookings: b.rowCount || 0, removedChurn: c.rowCount || 0 });
  } catch (e) { next(e); }
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
