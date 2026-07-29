// app.js — PERQ Revenue Desk frontend (vanilla JS, no build step).

const MONEY = new Set([
  'mrr', 'rerate_old_mrr', 'one_time_fee', 'month1', 'month2', 'month3',
  'offset_amount', 'annual_value', 'company_total_booking', 'commissionable_bookings',
  'google_search_budget', 'ar_final_invoice_amount', 'prorated_churn_amount', 'final_churn_amount',
  'implementation_fee', // Convert bookings
]);

const state = {
  tab: 'dashboard',
  schema: null,
  rows: { bookings: [], churn: [], sales_support: [], salesforce_recon: [], legacy_golives: [], legacy_churn: [] },
  sfPmcs: [], // Account Names from Salesforce Recon Data, for the Sales Support PMC dropdown
  legacySub: 'golives', // active Legacy sub-tab: 'golives' | 'churn'
  legacyPage: 1,
  legacyPageSize: localStorage.getItem('perqLegacyPageSize') || '100',
  legacyZoom: parseFloat(localStorage.getItem('perqLegacyZoom')) || 1,
  // Dashboard and Bookings filter independently: filtering the grid must not move the
  // dashboard totals, and vice versa.
  // Generic per-tab filters keyed by column key: { <columnKey>: <selectedValue> }. Empty = none.
  filters: { dashboard: {}, bookings: {}, churn: {} },
  // Click-to-sort per grid tab. dir: 1 = ascending (low→high), -1 = descending, 0 = unsorted.
  sort: { bookings: { key: null, dir: 0 }, churn: { key: null, dir: 0 } },
  closedMonths: {}, // { "May 2026": "2026-06-25" } — closed accounting months + official close date
  closedMonthsList: [], // raw rows for the admin Close Month panel
  offsetPmc: 'All', // License Transfer offsets review: filter by PMC
  offsetProp: 'All', // License Transfer offsets review: filter by Property (cascades within PMC)
  offsetSel: {}, // License Transfer offsets review: pending selections { bookingId: [{propKey, amount}, …] } (a booking can offset with several churning properties)
  offsetTxns: [], // recent applied offsets (undo log) shown in the Offset Review
  offsetDiag: false, // Offset Review: churn-eligibility diagnostic open
  offsetDiagQ: '',   // diagnostic search term (property / PMC)
  offsetOnly: null,  // when set to a booking id, the Offset Review is scoped to that one booking
                     // (opened from the ⚠ hint in the Bookings grid's Offset Amount column)
  token: localStorage.getItem('perqToken') || '',
  adminToken: localStorage.getItem('perqAdminToken') || '', // set while impersonating another user
  user: null, // { id, username, role }
  filtersHidden: localStorage.getItem('perqFiltersHidden') === '1',
  zoom: parseFloat(localStorage.getItem('perqZoom')) || 1,
  // Hidden columns per tab, e.g. { bookings: ['notes'], churn: [...] }.
  hiddenCols: (() => { try { return JSON.parse(localStorage.getItem('perqHiddenCols') || '{}'); } catch { return {}; } })(),
  // Pinned (frozen-left) columns per tab. Absent tab = use the default freeze (GRID_FREEZE).
  pinnedCols: (() => { try { return JSON.parse(localStorage.getItem('perqPinnedCols') || '{}'); } catch { return {}; } })(),
  // User-set column widths (px) per tab, e.g. { bookings: { mrr: 120 }, churn: {} }.
  colWidths: (() => { try { return JSON.parse(localStorage.getItem('perqColWidths') || '{}'); } catch { return {}; } })(),
  churnQuarter: 'All',   // dashboard churn-by-month quarter filter
  churnOwner: 'All',     // dashboard churn Account Owner filter (sales users default to their name)
  churnPmc: 'All',       // dashboard churn PMC filter
  saasCategory: 'Multifamily', // SaaS Financials: Multifamily | Digital Advertising
  saasQuarter: '',       // SaaS Financials quarter label, e.g. 'Q1 2026' (defaults to current)
  saasTypeMonth: '',     // SaaS Dashboard "Bookings per Type" Month/Year filter (defaults to current)
  saasSub: 'data',       // SaaS Financials sub-tab: 'data' (MRR table) | 'dashboard' (tiles)
  saasZoom: parseFloat(localStorage.getItem('perqSaasZoom')) || 1,
  // SaaS MRR Data multi-filter (same UX as the Bookings "Add Filter" bar). Values chosen per column
  // (checkbox multi-select); saasActiveFilters is which filter tiles are shown.
  saasFilters: {},
  saasActiveFilters: (() => { try { return JSON.parse(localStorage.getItem('perqSaasActiveFilters') || '[]'); } catch { return []; } })(),
  // Same multi-filter, but for the Unit Economics Report (its rows are type-bucketed events).
  saasUnitFilters: {},
  saasUnitActiveFilters: (() => { try { return JSON.parse(localStorage.getItem('perqSaasUnitActiveFilters') || '[]'); } catch { return []; } })(),
  churnDetailQuarter: null, // dashboard: quarter whose per-month Churn Details tables are open
  churnComOpen: false,      // dashboard: whether the COM (Property Sold/PMC Change) detail is open
  churnDetailExpanded: new Set(), // dashboard Churn Details: property rows expanded to per-product detail
  bookingQuarter: 'All', // dashboard booking-per-category quarter filter (separate from churn)
  convertYear: null,     // Convert dashboard: selected year (defaults to current/most-recent with data)
  convertQuarter: '',    // Convert dashboard: selected quarter tile (defaults to current/most-recent)
  convertDetailMonth: null, // Convert dashboard: month whose booking-detail table is open
  convertDivision: 'All', // Convert dashboard: Division filter
  convertChannel: 'All', // Convert dashboard: Channel filter
  reconcile: { uploaded: [], result: null }, // bookings reconciliation upload + diff
  pageSize: localStorage.getItem('perqPageSize') || '100', // rows per page ('all' = no paging)
  page: { bookings: 1, churn: 1 },
  quickFilter: { bookings: { col: '', text: '' }, churn: { col: '', text: '' } },
  // Which detailed filters are currently shown per tab (added via "Add Filter"); default none.
  activeFilters: (() => { try { return JSON.parse(localStorage.getItem('perqActiveFilters') || '{}'); } catch { return {}; } })(),
  totalsZoom: parseFloat(localStorage.getItem('perqTotalsZoom')) || 1, // Bookings totals-bar zoom
  filterZoom: parseFloat(localStorage.getItem('perqFilterZoom')) || 1, // filter-tile size (drag to resize)
  salesPeriods: [],   // [{ period, quarter, year, status }]
  salesPeriod: '',    // the quarter currently being viewed in Sales Support
  ssFilters: { owner: 'All', product: 'All', section: 'All' }, // Sales Support filters
  ssView: (localStorage.getItem('perqSsView') === 'property' ? 'pmc' : localStorage.getItem('perqSsView')) || 'product', // 'product' | 'pmc'
  ssExpanded: new Set(),    // property rows whose per-order detail is expanded (by row id)
  ssExpandedPmc: new Set(), // PMCs whose property rows are expanded (by PMC name)
  saasUnitExpanded: new Set(), // Unit Economics property rows expanded to their products (month|bucket|prop)
  ssBarCollapsed: localStorage.getItem('perqSsBarCollapsed') === '1', // Sales Support toolbar collapsed
  bdDetail: null,     // active Billing Dashboard drill-down key
  bdCollapsed: false, // collapse the Billing Dashboard tiles to focus the detail
  bdAction: null,     // active "For Immediate Action" drill-down: 'golive' | 'churn'
  bdMonth: 'All',     // Billing Dashboard Booking Month/Year filter
  bdArMonth: 'All',   // Billing Dashboard AR Final Invoice Month filter (churn tiles)
  bdFilters: {},      // Billing Dashboard drill-down column filters { colKey: value }
  bdActionFilters: {}, // "For Immediate Action" (GoLive/Churn change) drill-down filters { colKey: value }
  aiHistory: [],      // "Ask Claude" conversation [{role, content}]
  aiBusy: false,      // a chat request is in flight
  pendingBookings: [], // new-booking payloads awaiting confirmation
  pendingOffsets: [],  // per-line License Transfer offsets: array of {propKey, amount} (churning property) per line
  notifications: [],   // billing notifications (e.g. GoLive changes)
  instance: localStorage.getItem('perqInstance') || 'multifamily', // active Revenue Desk instance
  appVersion: null,       // deploy version this tab loaded with (set on first version check)
  pendingVersion: null,   // a newer deploy version detected while open
  updateDismissed: null,  // a newer version the user chose "Later" on (don't nag again)
};

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', 'x-instance': state.instance || 'multifamily', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!res.ok && res.status !== 204) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
};

function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- New-version detection: prompt a refresh after a deploy ----------
// The server's version token changes on every deploy; when the token we loaded with no longer
// matches, a new build is live and this tab is running stale code.
async function fetchVersion() {
  try { const r = await fetch('/api/version', { cache: 'no-store' }); return r.ok ? ((await r.json()).version || null) : null; }
  catch { return null; }
}
async function checkAppVersion() {
  const v = await fetchVersion();
  if (!v) return;
  if (!state.appVersion) { state.appVersion = v; return; } // first check — establish the baseline
  if (v !== state.appVersion && v !== state.updateDismissed) { state.pendingVersion = v; $('#updateModal').hidden = false; }
}
function wireUpdateCheck() {
  $('#updateRefresh').onclick = () => { window.location.reload(); }; // reload revalidates index.html + app.js
  $('#updateLater').onclick = () => { $('#updateModal').hidden = true; state.updateDismissed = state.pendingVersion; };
  checkAppVersion(); // baseline
  setInterval(checkAppVersion, 90000); // poll every 90s
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppVersion(); });
  window.addEventListener('focus', checkAppVersion);
}

// ---------- Roles / permissions (UX mirror of server enforcement) ----------
function role() { return state.user ? state.user.role : null; }
function isAdmin() { return role() === 'admin'; }
function isSales() { return role() === 'sales'; }                 // salesperson tagged to one owner
function salesOwner() { return state.user ? (state.user.account_owner || '') : ''; }
// Access to the Convert instance: admins always; others only when granted (users.convert_access).
function canConvert() { return isAdmin() || !!(state.user && state.user.convert_access); }

// ---- Section access (which sidebar sections a user may see) ----
// Every grantable sidebar section, in sidebar order. Mirrors server ALL_SECTIONS.
const ALL_SECTION_KEYS = ['dashboard', 'newbooking', 'bookings', 'salessupport', 'churn', 'saas', 'billing', 'sfrecon', 'legacy'];
// What each role has always shown, used when a user has no explicit allow-list. Mirrors the server.
function roleDefaultSections(r) {
  const base = ['dashboard', 'bookings', 'churn', 'salessupport'];
  if (r === 'admin') return ALL_SECTION_KEYS.slice();
  if (r === 'standard') return [...base, 'saas'];
  if (r === 'billing') return [...base, 'saas', 'billing', 'legacy'];
  return base; // sales_admin, sales, viewer
}
// The sections THIS user can see: admins all; explicit allow-list if set; else role defaults.
function userSections() {
  if (isAdmin()) return ALL_SECTION_KEYS.slice();
  const sa = state.user && state.user.section_access;
  return (Array.isArray(sa) && sa.length) ? sa : roleDefaultSections(role());
}
function canSection(key) { return userSections().includes(key); }
// Are we currently viewing the Convert instance? Convert's Bookings diverge from Multifamily
// (category-tagged rows, different columns, none of the churn/booking-type enhancements).
function isConvert() { return state.instance === 'convert'; }
// In the Convert instance, the Dashboard + Bookings sections exist. (The Multifamily New Booking
// entry form is property/pilot-specific; Convert rows are added inline via "+ Add row".)
const CONVERT_TABS = new Set(['dashboard', 'bookings']);
function tabAvailable(tab) { return state.instance === 'convert' ? CONVERT_TABS.has(tab) : true; }
function isSalesRole() { return role() === 'sales_admin' || role() === 'sales'; }
function canAddDelete() { return role() === 'admin' || role() === 'standard'; } // bookings/churn + imports
function canImport() { return role() === 'admin'; }
function canEditSalesSupport() { return ['admin', 'standard', 'sales_admin', 'sales'].includes(role()); }
function canManageQuarters() { return ['admin', 'sales_admin'].includes(role()); } // open/close quarter
// System-generated fields: read-only for everyone EXCEPT admins, who may correct them
// (e.g. Date Added / GoLive Set Date, which drive the closed-month carry-over recognition).
const ADMIN_EDIT_FIELDS = new Set(['date_added', 'golive_set_date', 'booking_adjustment']);
// Booking Clawback / Correction: computed field -> the stored manual-override field it maps to.
// When a booking is tagged (booking_adjustment), admins enter these three values by hand.
const BOOKING_OVERRIDE = { annual_value: 'annual_value_override', company_total_booking: 'company_total_override', commissionable_bookings: 'commissionable_override' };
const BOOKING_OVERRIDE_KEYS = new Set(Object.values(BOOKING_OVERRIDE));
const isBookingAdjusted = (row) => { const a = String(row.booking_adjustment || '').trim(); return a === 'Booking Clawback' || a === 'Booking Correction'; };
function canEditField(f) {
  if (ADMIN_EDIT_FIELDS.has(f.key)) return isAdmin();
  const r = role();
  if (r === 'admin' || r === 'standard') return true;
  if (r === 'billing') return isBilling(f.key);
  return false; // sales_admin, sales, viewer -> read-only on Bookings/Churn
}

// A centered result dialog that stays open until dismissed.
function showResult(title, bodyHtml) {
  $('#resultTitle').textContent = title;
  $('#resultBody').innerHTML = bodyHtml;
  $('#resultModal').hidden = false;
}
// Build the Churn upload result: the count summary, plus detail tables of exactly what was
// added (property / MRR / last date) and what changed (property / MRR / old -> new date).
function churnResultHtml(data) {
  const addedRows = data.addedRows || [];
  const changedRows = data.changedRows || [];
  let html = '<ul class="result-list">'
    + `<li><strong>${data.added}</strong> new churn row(s) added</li>`
    + `<li><strong>${data.changed}</strong> Last Date Under Contract changed (billing notified)</li>`
    + `<li><strong>${data.unchanged}</strong> unchanged (already present)</li>`
    + `<li><strong>${data.skippedBlank || 0}</strong> skipped (blank Last Date Under Contract)</li>`
    + `<li class="muted">${data.total} row(s) in the file</li>`
    + '</ul>';
  if (addedRows.length) {
    html += `<div class="result-detail-title">Added (${addedRows.length})</div>`
      + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>MRR</th><th>Last Date Under Contract</th></tr></thead><tbody>'
      + addedRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
        + `<td class="num">${fmtMoney(r.mrr)}</td><td>${escapeHtml(r.last_date_under_contract || '—')}</td></tr>`).join('')
      + '</tbody></table></div>';
  }
  if (changedRows.length) {
    html += `<div class="result-detail-title">Last Date Under Contract updated (${changedRows.length})</div>`
      + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>MRR</th><th>Old date</th><th>New date</th></tr></thead><tbody>'
      + changedRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
        + `<td class="num">${fmtMoney(r.mrr)}</td><td>${escapeHtml(r.from || '(blank)')}</td><td><strong>${escapeHtml(r.to || '(blank)')}</strong></td></tr>`).join('')
      + '</tbody></table></div>';
  }
  return html;
}

// Build the GoLives upload result: the count summary, plus detail tables of exactly what was
// set / changed / MRR-updated / not found — mirroring the Churn upload result.
function golivesResultHtml(data) {
  const setRows = data.setRows || [];
  const changedRows = data.changedRows || [];
  const mrrRows = data.mrrRows || [];
  const notFoundRows = data.notFoundRows || [];
  let html = '<ul class="result-list">'
    + `<li><strong>${data.updated}</strong> GoLive date(s) set (were blank)</li>`
    + `<li><strong>${data.changed}</strong> GoLive date(s) changed (billing notified)</li>`
    + `<li><strong>${data.unchanged}</strong> unchanged (same date)</li>`
    + `<li><strong>${data.mrrUpdated || 0}</strong> MRR value(s) updated from the sheet (billing notified)</li>`
    + `<li><strong>${data.notFound}</strong> not found in Bookings (matched by Property ID + Product)</li>`
    + `<li class="muted">${data.total} row(s) in the file</li>`
    + '</ul>';
  if (setRows.length) {
    html += `<div class="result-detail-title">GoLive date set (${setRows.length})</div>`
      + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>MRR</th><th>GoLive Date</th></tr></thead><tbody>'
      + setRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
        + `<td class="num">${fmtMoney(r.mrr)}</td><td>${escapeHtml(r.golive_date || '—')}</td></tr>`).join('')
      + '</tbody></table></div>';
  }
  if (changedRows.length) {
    html += `<div class="result-detail-title">GoLive date changed (${changedRows.length})</div>`
      + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>MRR</th><th>Old date</th><th>New date</th></tr></thead><tbody>'
      + changedRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
        + `<td class="num">${fmtMoney(r.mrr)}</td><td>${escapeHtml(r.from || '(blank)')}</td><td><strong>${escapeHtml(r.to || '(blank)')}</strong></td></tr>`).join('')
      + '</tbody></table></div>';
  }
  if (mrrRows.length) {
    html += `<div class="result-detail-title">MRR updated from the sheet (${mrrRows.length})</div>`
      + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>Old MRR</th><th>New MRR</th></tr></thead><tbody>'
      + mrrRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
        + `<td class="num">${fmtMoney(r.from)}</td><td class="num"><strong>${fmtMoney(r.to)}</strong></td></tr>`).join('')
      + '</tbody></table></div>';
  }
  if (notFoundRows.length) {
    html += `<div class="result-detail-title">Not found in Bookings (${notFoundRows.length})</div>`
      + '<div class="result-detail"><table><thead><tr><th>Property ID</th><th>Product</th><th>GoLive Date</th></tr></thead><tbody>'
      + notFoundRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
        + `<td>${escapeHtml(r.golive_date || '—')}</td></tr>`).join('')
      + '</tbody></table>'
      + '<p class="muted" style="margin-top:6px">These file rows had no matching booking (by Property ID + Product). Check the Property ID / Product, or add the booking first.</p></div>';
  }
  return html;
}

function wireResult() {
  const close = () => { $('#resultModal').hidden = true; };
  $('#resultClose').onclick = close;
  $('#resultOk').onclick = close;
  $('#resultModal').addEventListener('click', (e) => { if (e.target.id === 'resultModal') close(); });
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2200);
}

function fmtMoney(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return n < 0 ? `($${s})` : `$${s}`;
}
function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v;
}
// Parse a typed money string ("$19,200", "(1,234)") back to a number.
function parseMoney(v) {
  if (v == null || String(v).trim() === '') return '';
  const s = String(v).trim();
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[(),$\s]/g, ''));
  if (!Number.isFinite(n)) return s; // leave as-is; server will coerce/reject
  return neg ? -n : n;
}

// ---------- Rendering ----------
// Billing sections (per tab) — shown at the very end, after the computed columns, and
// tinted blue. Keys are in the order they should appear.
const BILLING_KEYS = {
  bookings: new Set(['billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'sage_id', 'billing_notes']),
  churn: new Set(['template_deleted', 'completed', 'billing_notes']),
};
function isBilling(key) { return !!(BILLING_KEYS[state.tab] && BILLING_KEYS[state.tab].has(key)); }

// Ordered display columns for the active tab, plus a lookup of which keys are computed.
function fieldsForTab() {
  const s = state.schema[state.tab];
  const computedKeys = new Set(s.computed.map((f) => f.key));
  // Some stored fields have no column of their own — they're edited inline through a computed
  // cell: ar_override (AR Final Invoice Amt) and the Booking Clawback/Correction overrides.
  // Hidden from the grid: inline-only overrides + the system recognition_date (churn month lever).
  const inlineOnly = new Set(['ar_override', 'recognition_date', ...BOOKING_OVERRIDE_KEYS]);
  let cols = [...s.editable, ...s.computed].filter((c) => !inlineOnly.has(c.key));
  // Move this tab's billing fields to the very end, after the computed columns.
  const billing = BILLING_KEYS[state.tab];
  if (billing) {
    cols = [...cols.filter((c) => !billing.has(c.key)), ...cols.filter((c) => billing.has(c.key))];
  }
  // Bookings: a synthetic, read-only "Status" column (Active / Churned / Never went live),
  // derived by cross-referencing the Churn Tracker. Sits right after the property name.
  // Convert has no Churn Tracker, so this column doesn't apply there.
  if (state.tab === 'bookings' && !isConvert()) {
    const idx = cols.findIndex((c) => c.key === 'property_name');
    const statusCol = { key: 'churn_status', label: 'Status', type: 'text', synthetic: true };
    if (idx >= 0) cols.splice(idx + 1, 0, statusCol); else cols.push(statusCol);
  }
  return { cols, computedKeys, computed: s.computed };
}

function renderHead() {
  if (state.tab !== 'bookings' && state.tab !== 'churn') { $('#thead').innerHTML = ''; return; }
  const { cols, computedKeys } = fieldsForTab();
  const s = state.sort[state.tab] || {};
  $('#thead').innerHTML =
    `<tr><th class="rownum">#</th>` +
    cols.map((f) => {
      const cls = computedKeys.has(f.key) ? 'computed' : (isBilling(f.key) ? 'billing' : '');
      const active = s.key === f.key && s.dir;
      const arrow = active ? (s.dir === 1 ? '▲' : '▼') : '↕';
      const sort = `<span class="col-sort${active ? ' sorted' : ''}" data-sort="${f.key}" title="Sort ${escapeHtml(f.label)}">${arrow}</span>`;
      return `<th class="${cls}" data-col="${f.key}" title="${f.label}">${f.label}${sort}<span class="col-resize"></span></th>`;
    }).join('') +
    `<th class="del"></th></tr>`;
}

// A booking's status vs the Churn Tracker: 'churned' (a matching churn exists), 'never-live'
// (matches a churn but the booking never got a GoLive date), or 'active' (no matching churn).
// Match = same Property ID + Product + MRR (excluding Contraction/offset churns). The churn-key
// set is cached by the churn array reference so it's built once per data load, not per row.
let _churnKeySrc = null;
let _churnKeySet = new Set();
function churnKeySet() {
  if (_churnKeySrc === state.rows.churn) return _churnKeySet;
  const set = new Set();
  for (const c of state.rows.churn || []) {
    if (String(c.classification || '') === 'Contraction') continue; // offsets aren't churn
    const pid = String(c.property_id || '').trim().toLowerCase();
    const prod = String(c.product || '').trim().toLowerCase();
    if (!pid || !prod) continue;
    set.add(`${pid}|${prod}|${Math.round((Number(c.mrr) || 0) * 100)}`);
  }
  _churnKeySrc = state.rows.churn;
  _churnKeySet = set;
  return set;
}
function bookingChurnStatus(b) {
  const pid = String(b.property_id || '').trim().toLowerCase();
  const prod = String(b.product || '').trim().toLowerCase();
  if (!pid || !prod) return 'active';
  const key = `${pid}|${prod}|${Math.round((Number(b.mrr) || 0) * 100)}`;
  if (!churnKeySet().has(key)) return 'active';
  return b.golive_date ? 'churned' : 'never-live';
}
const CHURN_STATUS_LABEL = { churned: 'Churned', 'never-live': 'Never went live', active: 'Active' };
function churnStatusCell(row) {
  const s = bookingChurnStatus(row);
  return `<td class="ro booking-status status-${s}" data-col="churn_status">${CHURN_STATUS_LABEL[s]}</td>`;
}
// The <tr> class that tints legacy (grey), churned (red) / never-live (blue) rows in Bookings.
function rowStatusClass(row) {
  const cls = [];
  if (row.auto || row.legacy) cls.push('row-legacy'); // auto-derived / migrated rows: muted + locked
  if (state.tab === 'bookings') {
    if (isBookingAdjusted(row)) cls.push('row-adjust'); // Booking Clawback / Correction: highlighted
    const s = bookingChurnStatus(row);
    if (s === 'churned' || s === 'never-live') cls.push(`row-${s}`);
  }
  return cls.length ? ` class="${cls.join(' ')}"` : '';
}
// Legacy (migrated) bookings are locked for everyone except admins. Auto-derived rows (e.g. the
// Downgrade churn lines computed from bookings) are locked for everyone — edit the source booking.
function rowLocked(row) { return !!row.auto || (!!row.legacy && !isAdmin()); }

function rowInnerHtml(row, i, fields) {
  const { cols, computedKeys } = fields || fieldsForTab();
  const locked = rowLocked(row);
  let html = `<td class="rownum">${i + 1}</td>`;
  for (const f of cols) {
    if (f.key === 'churn_status') html += churnStatusCell(row);
    else if (f.key === 'ar_final_invoice_amount' && state.tab === 'churn' && isAdmin() && !locked) html += arOverrideCell(row);
    else if (state.tab === 'bookings' && BOOKING_OVERRIDE[f.key] && isAdmin() && (isBookingAdjusted(row) || row.legacy)) html += bookingOverrideCell(f.key, row);
    else if (computedKeys.has(f.key)) html += computedCell(f, row);
    else if (canEditField(f) && !locked) html += editCell(f, row);
    else html += readonlyCell(f, row);
  }
  let actions = (canAddDelete() && !locked) ? `<button class="row-del" title="Delete row" data-del="${row.id}">✕</button>` : '';
  // Admin only, on the Bookings & Churn grids: a ▾ reveals Add-below / Duplicate.
  if ((state.tab === 'bookings' || state.tab === 'churn') && isAdmin() && !locked) {
    actions += '<div class="row-more">'
      + '<button type="button" class="row-more-btn" title="More row actions">▾</button>'
      + '<div class="row-more-menu" hidden>'
      + `<button type="button" class="row-add" data-add-below="${row.id}">＋ Add row below</button>`
      + `<button type="button" class="row-dup" data-dup="${row.id}">⧉ Duplicate row</button>`
      + '</div></div>';
  }
  html += `<td class="del">${actions}</td>`;
  return html;
}

// The rows for the active grid tab, after applying that tab's filters.
// Quick filter: a single column + free text (contains, case-insensitive), applied on top
// of the detailed ("Multiple Filters") filters.
function quickFilterPass(r, tab) {
  const qf = state.quickFilter[tab];
  if (!qf || !qf.col || !qf.text) return true;
  return String(r[qf.col] ?? '').toLowerCase().includes(String(qf.text).toLowerCase());
}
// Month-Year computed columns ("June 2026") sort chronologically, not alphabetically.
const MONTH_YEAR_SORT_COLS = new Set(['final_churn_month', 'prorated_churn_month', 'final_invoice_month']);
const monthYearSortKey = (v) => {
  const [m, y] = String(v).split(' ');
  const mi = MONTHS.indexOf(m);
  return (mi < 0 || !y) ? null : Number(y) * 12 + mi;
};
// Sort the filtered rows by the active click-to-sort column. Blanks always sort last (both
// directions). Numbers compare numerically, dates/month-year chronologically, text naturally.
function sortRows(rows, tab) {
  const s = state.sort && state.sort[tab];
  if (!s || !s.key || !s.dir) return rows;
  const sch = state.schema && state.schema[tab];
  if (!sch) return rows;
  const def = [...sch.editable, ...sch.computed].find((f) => f.key === s.key);
  const type = def ? def.type : 'text';
  const key = s.key;
  // The synthetic "Status" column isn't a stored field — derive its value for sorting.
  if (key === 'churn_status') {
    return rows.slice().sort((a, b) => s.dir * bookingChurnStatus(a).localeCompare(bookingChurnStatus(b)));
  }
  const isBlank = (r) => { const v = r[key]; return v === null || v === undefined || String(v).trim() === ''; };
  const base = (a, b) => {
    const av = a[key], bv = b[key];
    if (type === 'number') return (Number(String(av).replace(/[$,]/g, '')) || 0) - (Number(String(bv).replace(/[$,]/g, '')) || 0);
    if (MONTH_YEAR_SORT_COLS.has(key)) return (monthYearSortKey(av) ?? 0) - (monthYearSortKey(bv) ?? 0);
    if (type === 'date') return String(av).localeCompare(String(bv)); // YYYY-MM-DD is chronological as text
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  };
  return rows.slice().sort((a, b) => {
    const aB = isBlank(a); const bB = isBlank(b);
    if (aB && bB) return 0;
    if (aB) return 1; // blanks last
    if (bB) return -1;
    return s.dir * base(a, b);
  });
}
function currentRows(tab) {
  const rows = state.rows[tab] || [];
  let out = rows;
  if (tab === 'bookings') out = rows.filter((r) => bookingMatch(r, state.filters.bookings));
  else if (tab === 'churn') out = rows.filter((r) => churnMatch(r, state.filters.churn));
  if (tab === 'bookings' || tab === 'churn') out = sortRows(out.filter((r) => quickFilterPass(r, tab)), tab);
  return out;
}

// Render only the current page of rows (default 100) — keeps tab-switch/filtering fast
// on large tables. Row numbers reflect the global position within the filtered set.
function applyTotalsZoom() {
  const c = $('#bookingTotals .gt-content');
  if (c) c.style.zoom = state.totalsZoom;
  const lvl = $('#gtZoomLevel');
  if (lvl) lvl.textContent = Math.round(state.totalsZoom * 100) + '%';
}
// Which money columns the bottom totals row sums, per grid. Totals reflect the filtered set.
// The One-Time Fee that counts toward "Commissionable + OTF": excluded (0) for Conversions
// (Pilot Type = Conversion), since the implementation fee was already billed during the pilot.
const otfForCommissionable = (r) => (String(r.pilot_type || '').trim() === 'Conversion' ? 0 : (Number(r.one_time_fee) || 0));
const commissionablePlusOtf = (r) => (Number(r.commissionable_bookings) || 0) + otfForCommissionable(r);
// A key can be a single field, an array of fields summed together, or a per-row function.
const TOTALS_FIELDS = {
  bookings: [['MRR', 'mrr'], ['One-Time Fee', 'one_time_fee'], ['Offset Amount', 'offset_amount'], ['Annual Value', 'annual_value'], ['Company Total Booking', 'company_total_booking'], ['Commissionable', 'commissionable_bookings'], ['Commissionable + OTF', commissionablePlusOtf]],
  churn: [['AR Final Invoice Amt', 'ar_final_invoice_amount'], ['Prorated Churn Amt', 'prorated_churn_amount'], ['Final Churn Amt', 'final_churn_amount']],
};
// Convert bookings have no booking-type math — total the plain money columns instead.
const CONVERT_TOTALS_FIELDS = [['MRR', 'mrr'], ['Company Total Booking', 'company_total_booking'], ['Implementation Fee', 'implementation_fee']];
function renderBookingTotals(allRows) {
  const el = $('#bookingTotals');
  const fields = (isConvert() && state.tab === 'bookings') ? CONVERT_TOTALS_FIELDS : TOTALS_FIELDS[state.tab];
  if (!fields) { el.hidden = true; return; }
  // Churn Credits are a positive accounting adjustment recognized in the dashboard, not a raw
  // churn drop — exclude them from the raw Churn grid totals (their computed amounts are negative).
  const rows = state.tab === 'churn' ? allRows.filter((r) => String(r.classification || '') !== 'Churn Credit') : allRows;
  const sum = (k) => {
    if (typeof k === 'function') return rows.reduce((a, r) => a + (Number(k(r)) || 0), 0);
    const keys = Array.isArray(k) ? k : [k];
    return rows.reduce((a, r) => a + keys.reduce((s, kk) => s + (Number(r[kk]) || 0), 0), 0);
  };
  const cell = (label, k) => `<span class="gt-cell"><span class="gt-k">${label}</span><span class="gt-v">${fmtMoney(sum(k))}</span></span>`;
  el.innerHTML = `<div class="gt-content">`
    + `<span class="gt-count">${fmtNum(rows.length)} row${rows.length === 1 ? '' : 's'}</span>`
    + fields.map(([label, k]) => cell(label, k)).join('')
    + '</div>'
    + '<div class="gt-zoom" title="Totals size">'
    + '<button type="button" class="view-btn" data-gt-zoom="out" aria-label="Smaller">&minus;</button>'
    + '<span id="gtZoomLevel"></span>'
    + '<button type="button" class="view-btn" data-gt-zoom="in" aria-label="Larger">&plus;</button>'
    + '</div>';
  el.hidden = false;
  applyTotalsZoom();
}
function wireTotalsZoom() {
  $('#bookingTotals').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-gt-zoom]');
    if (!btn) return;
    const step = btn.dataset.gtZoom === 'in' ? 0.1 : -0.1;
    state.totalsZoom = Math.min(2, Math.max(0.5, Math.round((state.totalsZoom + step) * 10) / 10));
    localStorage.setItem('perqTotalsZoom', String(state.totalsZoom));
    applyTotalsZoom();
  });
}
function renderBody() {
  const tbody = $('#tbody');
  if (state.tab !== 'bookings' && state.tab !== 'churn') { tbody.innerHTML = ''; renderPager(0, 1, 1, 0, 0); $('#bookingTotals').hidden = true; return; }
  const rows = currentRows(state.tab);
  renderBookingTotals(rows);
  const size = state.pageSize === 'all' ? (rows.length || 1) : Number(state.pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  let page = Math.min(Math.max(1, state.page[state.tab] || 1), totalPages);
  state.page[state.tab] = page;
  const start = (page - 1) * size;
  const slice = state.pageSize === 'all' ? rows : rows.slice(start, start + size);
  // Build the whole page as one HTML string (one parse + one layout) — far faster than
  // creating/appending each row, which forced a reflow per row on the wide grid.
  const fields = fieldsForTab();
  tbody.innerHTML = slice.map((row, i) => `<tr data-id="${row.id}"${rowStatusClass(row)}>${rowInnerHtml(row, start + i, fields)}</tr>`).join('');
  renderPager(rows.length, page, totalPages, start, slice.length);
}

function renderPager(total, page, totalPages, start, count) {
  const pager = $('#pager');
  if (state.tab !== 'bookings' && state.tab !== 'churn') { pager.style.display = 'none'; return; }
  pager.style.display = '';
  $('#pageInfo').textContent = `${total === 0 ? 0 : start + 1}–${start + count} of ${total}`;
  $('#pagePrev').disabled = page <= 1;
  $('#pageNext').disabled = page >= totalPages;
}

function editCell(f, row) {
  const val = row[f.key] ?? '';
  // Offset Amount only applies to License Transfers; otherwise show a non-editable dash — unless the
  // system found a churn this booking could offset, in which case show a ⚠ hint that opens the same
  // Offset Review (scoped to this booking) so it can be turned into a License Transfer offset.
  if (f.key === 'offset_amount' && (row.ctam_type || '').trim() !== 'License Transfer') {
    if (bookingHasOffsetHint(row)) {
      return `<td class="num offset-na" data-col="${f.key}"><button type="button" class="offset-hint" data-offset-hint="${row.id}" title="Available churn to offset this booking — click to review">⚠</button></td>`;
    }
    return `<td class="num offset-na" data-col="${f.key}"><span class="na">—</span></td>`;
  }
  const billing = isBilling(f.key) ? ' billing' : '';
  const numClass = f.type === 'number' ? ' num' : '';
  if (f.type === 'select') {
    const opts = f.options.map((o) =>
      `<option value="${escapeAttr(o)}"${o === val ? ' selected' : ''}>${o || '—'}</option>`).join('');
    return `<td class="${billing.trim()}" data-col="${f.key}"><select data-key="${f.key}">${opts}</select></td>`;
  }
  const inputType = f.type === 'date' ? 'date' : (f.type === 'number' ? 'number' : 'text');
  const step = f.type === 'number' ? ' step="any"' : '';
  return `<td class="${(numClass + billing).trim()}" data-col="${f.key}"><input type="${inputType}"${step} data-key="${f.key}" value="${escapeAttr(val)}" /></td>`;
}

function computedCell(f, row) {
  const raw = row[f.key];
  const isNeg = typeof raw === 'number' && raw < 0;
  const text = MONEY.has(f.key) ? fmtMoney(raw) : (f.type === 'number' ? fmtNum(raw) : (raw ?? ''));
  return `<td class="computed${isNeg ? ' neg' : ''}" data-comp="${f.key}" data-col="${f.key}">${text}</td>`;
}

// Admin-only editable "AR Final Invoice Amt" cell. Blank = use the auto proration (placeholder
// shows it); a typed value overrides it (stored as ar_override) and the prorated/final churn
// amounts recompute from it. Clearing the box reverts to auto.
function arOverrideCell(row) {
  const ov = row.ar_override;
  const hasOv = ov !== null && ov !== undefined && ov !== '';
  const auto = fmtMoney(row.ar_final_invoice_amount); // effective value (= auto when no override)
  const title = hasOv
    ? 'Manual override — clear the box to use the auto-calculated AR.'
    : 'Auto-calculated. Type a value to override the AR Final Invoice Amount.';
  return `<td class="num computed ar-override${hasOv ? ' ar-overridden' : ''}" data-col="ar_final_invoice_amount" title="${escapeAttr(title)}">`
    + `<input type="text" inputmode="decimal" data-key="ar_override" value="${escapeAttr(hasOv ? fmtMoney(ov) : '')}" placeholder="${escapeAttr(auto)}" /></td>`;
}

// Manual-entry cell for a Booking Clawback / Correction line: the computed column (Annual Value /
// Company Total Booking / Commissionable) becomes an editable input bound to its *_override field.
function bookingOverrideCell(computedKey, row) {
  const overrideKey = BOOKING_OVERRIDE[computedKey];
  const ov = row[overrideKey];
  const hasOv = ov !== null && ov !== undefined && ov !== '';
  const tag = String(row.booking_adjustment || '').trim() || (row.legacy ? 'Legacy' : 'Manual');
  return `<td class="num computed ar-override ar-overridden" data-col="${computedKey}" title="${escapeAttr(tag + ' — enter the value manually')}">`
    + `<input type="text" inputmode="decimal" data-key="${overrideKey}" value="${escapeAttr(hasOv ? fmtMoney(ov) : '')}" placeholder="$0" /></td>`;
}

// A field the current user can see but not edit: render the value as static text.
function readonlyCell(f, row) {
  const raw = row[f.key];
  const billing = isBilling(f.key) ? ' billing' : '';
  const numClass = f.type === 'number' ? ' num' : '';
  const text = MONEY.has(f.key) ? fmtMoney(raw) : (f.type === 'number' ? fmtNum(raw) : (raw ?? ''));
  return `<td class="ro${numClass}${billing}" data-col="${f.key}">${escapeHtml(text)}</td>`;
}

function escapeAttr(v) { return String(v).replace(/"/g, '&quot;'); }

// ---------- Filters + summary metrics ----------
// "Recently added" windows (days) for the synthetic added_recent filter, by option label.
const ADDED_WINDOWS = { 'Today': 1, 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 };
// A filter value can be a single value (string) or, for multi-select filters, an array of
// values. Normalize to the list of *active* selections ([] means "no filter" / All).
function selectedValues(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== 'All' && x !== '');
  return (v == null || v === 'All' || v === '') ? [] : [v];
}
// Macro product grouping used on the Dashboard and as the "Main Category" filter:
// Professional Services = the Digital Advertising products (SEO / Google Search Management /
// Google Performance Max); Software = everything else. Works for bookings (which carry a computed
// bpr_prod_category) and churn (which carries only a product -> mapped via the Products catalog).
const PRO_SVC_PRODUCTS = new Set(['Google Search Management', 'SEO', 'Google Performance Max']);
function mainCategoryOf(row) {
  const prod = String(row.product || '').trim();
  let cat = String(row.bpr_prod_category || '').trim(); // present on bookings
  if (!cat) { const map = (state.schema && state.schema.productCategories) || {}; cat = map[prod] || ''; }
  return (cat === 'Digital Advertising' || PRO_SVC_PRODUCTS.has(prod)) ? 'Professional Services' : 'Software';
}

// The value a row presents to a given filter (handles synthetic columns). For value-list
// filters, an empty value is represented as the "(blank)" option.
function rowFilterValue(r, key) {
  if (key === 'booking_my') {
    return (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '';
  }
  if (key === 'main_category') return mainCategoryOf(r);
  if (key === 'churn_quarter') { const i = monthYearQuarter(r.final_churn_month || ''); return i ? i.label : '(blank)'; }
  if (key === 'booking_quarter') {
    const my = (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '';
    const i = monthYearQuarter(my); return i ? i.label : '(blank)';
  }
  if (key === 'golive_date') return String(r.golive_date ?? '').trim() !== '' ? 'Go Live' : 'Not Live';
  const raw = r[key];
  return (raw === null || raw === undefined || String(raw).trim() === '') ? '(blank)' : String(raw);
}
// A row passes if, for every active filter, the row matches AT LEAST ONE selected value
// (multi-select = OR within a column, AND across columns).
function rowMatchesFilters(r, f) {
  for (const key in f) {
    const sel = selectedValues(f[key]);
    if (!sel.length) continue;
    if (key === 'added_recent' || key === 'golive_added_recent') { // "recently added" — widest selected window
      const days = Math.max(...sel.map((v) => ADDED_WINDOWS[v] || 0));
      if (!days) continue;
      // Churn "Added" = the row's creation time; Bookings "GoLive Added" = when the GoLive Date
      // was set in the system (golive_set_date). A blank stamp never matches a recency window.
      const stamp = key === 'golive_added_recent' ? r.golive_set_date : r.created_at;
      const t = Date.parse(stamp || '');
      if (!Number.isFinite(t) || t < Date.now() - days * 86400000) return false;
      continue;
    }
    if (!sel.includes(rowFilterValue(r, key))) return false;
  }
  return true;
}
const bookingMatch = rowMatchesFilters;
const churnMatch = rowMatchesFilters;

// ---------- Multi-select filter dropdowns (checkbox lists) ----------
// Build one filter tile as a checkbox dropdown. `options` are the (cascaded) values to choose
// from; `selected` is the currently-chosen list. Selecting nothing = "All" (no filter).
function filterTileHtml(key, lbl, options, selected, removable) {
  const opts = options.slice();
  for (const s of selected) if (!opts.includes(s)) opts.unshift(s); // keep chosen values selectable
  const summary = selected.length === 0 ? 'All' : (selected.length === 1 ? selected[0] : `${selected.length} selected`);
  const search = opts.length > 8 ? '<input type="text" class="ms-search" placeholder="Search…" />' : '';
  const list = opts.map((o) =>
    `<label class="ms-opt"><input type="checkbox" value="${escapeAttr(o)}"${selected.includes(o) ? ' checked' : ''}/><span>${escapeHtml(o)}</span></label>`).join('')
    || '<div class="ms-empty">No values</div>';
  const x = removable ? `<button type="button" class="filter-x" data-remove-filter="${key}" title="Remove filter">✕</button>` : '';
  return `<div class="filter" data-filter="${key}">${x}<label>${lbl}</label>`
    + `<div class="ms" data-ms="${key}">`
    + `<button type="button" class="ms-btn" data-ms-btn="${key}"><span class="ms-label">${escapeHtml(summary)}</span><span class="ms-caret">▾</span></button>`
    + `<div class="ms-menu" hidden><div class="ms-tools">${search}<button type="button" class="ms-clear" data-ms-clear="${key}">Clear</button></div>`
    + `<div class="ms-list">${list}</div></div></div></div>`;
}
function setFilterValues(key, arr) {
  const f = state.filters[state.tab] || (state.filters[state.tab] = {});
  f[key] = (arr && arr.length) ? arr.slice() : 'All';
}
function closeAllMsMenus() {
  let closed = false;
  document.querySelectorAll('#summary .ms-menu:not([hidden])').forEach((m) => { m.hidden = true; closed = true; });
  return closed;
}
function updateMsSummary(key) {
  const ms = document.querySelector(`#summary [data-ms="${key}"]`);
  if (!ms) return;
  const sel = selectedValues((state.filters[state.tab] || {})[key]);
  const label = ms.querySelector('.ms-label');
  if (label) label.textContent = sel.length === 0 ? 'All' : (sel.length === 1 ? sel[0] : `${sel.length} selected`);
}
// Delegated handlers for all filter checkbox dropdowns (attached once; #summary persists).
function wireFilterMenus() {
  const summary = $('#summary');
  if (!summary) return;
  summary.addEventListener('click', (e) => {
    // Churn Details: expand / collapse a property row to its per-product detail.
    const chExp = e.target.closest('[data-churn-expand]');
    if (chExp) {
      const k = chExp.dataset.churnExpand;
      if (state.churnDetailExpanded.has(k)) state.churnDetailExpanded.delete(k); else state.churnDetailExpanded.add(k);
      renderSummary();
      e.stopPropagation();
      return;
    }
    const btn = e.target.closest('[data-ms-btn]');
    if (btn && !btn.disabled) {
      const menu = btn.parentElement.querySelector('.ms-menu');
      const willOpen = menu.hidden;
      closeAllMsMenus();
      if (willOpen) { menu.hidden = false; const s = menu.querySelector('.ms-search'); if (s) setTimeout(() => s.focus(), 0); }
      e.stopPropagation();
      return;
    }
    const clear = e.target.closest('[data-ms-clear]');
    if (clear) {
      const key = clear.dataset.msClear;
      clear.closest('.ms-menu').querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
      setFilterValues(key, []);
      updateMsSummary(key);
      if (state.tab !== 'dashboard') renderBody();
      e.stopPropagation();
    }
  });
  summary.addEventListener('change', (e) => {
    const cb = e.target.closest('.ms-opt input[type=checkbox]');
    if (!cb) return;
    const ms = cb.closest('[data-ms]');
    const key = ms.dataset.ms;
    setFilterValues(key, [...ms.querySelectorAll('.ms-opt input[type=checkbox]:checked')].map((c) => c.value));
    updateMsSummary(key);
    if (state.tab !== 'dashboard') renderBody();
  });
  summary.addEventListener('input', (e) => {
    const s = e.target.closest('.ms-search');
    if (!s) return;
    const q = s.value.trim().toLowerCase();
    s.closest('.ms-menu').querySelectorAll('.ms-opt').forEach((opt) => {
      opt.style.display = opt.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  // Clicking outside an open menu closes it and refreshes the cascading options / metrics.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ms')) return;
    if (closeAllMsMenus()) renderSummary();
  });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// Sort "Month Year" strings chronologically (by year, then calendar month).
function sortMonthYear(arr) {
  return arr.slice().sort((a, b) => {
    const [ma, ya] = String(a).split(' ');
    const [mb, yb] = String(b).split(' ');
    return (Number(ya) - Number(yb)) || (MONTHS.indexOf(ma) - MONTHS.indexOf(mb));
  });
}
// "May 2026" -> "June 2026" (rolls the year over December).
function nextMonthLabel(label) {
  const [m, y] = String(label || '').split(' ');
  const i = MONTHS.indexOf(m);
  if (i < 0 || !y) return label;
  return i === 11 ? `${MONTHS[0]} ${Number(y) + 1}` : `${MONTHS[i + 1]} ${y}`;
}
// ---- Closed months (month-end lock + churn carry-over) ----
async function loadClosedMonths() {
  try {
    const rows = await api('/api/closed-months');
    state.closedMonthsList = rows;
    state.closedMonths = Object.fromEntries(rows.map((r) => [r.month, String(r.close_date).slice(0, 10)]));
  } catch { state.closedMonthsList = []; state.closedMonths = {}; }
}
// The month a churn amount is actually recognized in: if its natural month is closed and the
// churn was ADDED after that month's official close date, it carries to the next open month
// (repeating through consecutive closed months). Returns the effective month + the month it was
// carried from (null if not carried).
function effectiveChurnMonth(monthLabel, dateAdded) {
  let m = String(monthLabel || '').trim();
  const added = dateAdded ? String(dateAdded).slice(0, 10) : '';
  let carriedFrom = null;
  let guard = 0;
  while (m && added) {
    const closeDate = state.closedMonths[m];
    if (!closeDate || added <= closeDate) break; // open, or added on/before the close -> belongs here
    if (!carriedFrom) carriedFrom = m;
    m = nextMonthLabel(m);
    if (++guard > 48) break;
  }
  return { month: m, carriedFrom };
}
// Today's calendar quarter as a label, e.g. "Q2 2026".
function currentQuarterLabel() {
  const d = new Date();
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
}
// "May 2026" -> { q: 2, year: 2026, label: 'Q2 2026' } (null if unparseable).
function monthYearQuarter(my) {
  const [m, y] = String(my).split(' ');
  const idx = MONTHS.indexOf(m);
  if (idx < 0 || !y) return null;
  const q = Math.floor(idx / 3) + 1;
  return { q, year: Number(y), label: `Q${q} ${y}` };
}

// React to a filter change. Bookings/Churn re-render page 1 of the filtered set; the
// Dashboard recomputes its metric cards.
function onFilterChange() {
  if (state.tab === 'dashboard') { renderSummary(); return; }
  state.page[state.tab] = 1;
  renderSummary(); // rebuild the filter tiles so the connected (cascading) dropdowns update
  // Defer so the filter dropdowns repaint immediately, then the grid rebuilds.
  requestAnimationFrame(renderBody);
}

function renderSummary() {
  const el = $('#summary');
  const tab = state.tab;
  // Convert has its own Bookings dashboard (quarterly Total Bookings, clickable month tiles).
  if (isConvert() && tab === 'dashboard') { renderConvertDashboard(el); return; }
  const rows = tab === 'churn' ? state.rows.churn : state.rows.bookings;
  const f = state.filters[tab];
  if (!f) { el.className = 'summary hidden'; el.innerHTML = ''; return; }

  // Connected (cascading) filters: a filter's options reflect the rows that match all the OTHER
  // active filters, so picking Sales Rep narrows the PMC / Property / Month options to matching
  // rows. A filter never constrains its own options (so you can always change your own selection).
  const rowsExcept = (exceptKey) => {
    const sub = {};
    for (const k in f) if (k !== exceptKey) sub[k] = f[k];
    return rows.filter((r) => rowMatchesFilters(r, sub));
  };
  const distinctIn = (src, k) => [...new Set(src.map((r) => r[k]).filter((v) => v !== null && v !== '' && v !== undefined))];
  const sel = (id, label, vals, cur, disabled) =>
    `<div class="filter"><label>${label}</label><select id="${id}"${disabled ? ' disabled' : ''}>` +
    vals.map((o) => `<option${String(o) === String(cur) ? ' selected' : ''}>${o}</option>`).join('') +
    `</select></div>`;

  // Every column of the active tab is filterable (Dashboard filters use the booking columns).
  let cols = tab === 'churn'
    ? [...state.schema.churn.editable, ...state.schema.churn.computed]
    : [...state.schema.bookings.editable, ...state.schema.bookings.computed];
  // The synthetic filters below are all Multifamily concepts (Booking Month/Year, GoLive, the
  // Professional-Services grouping). Convert bookings don't have those fields — skip them so the
  // Convert filter list is just its own columns (Category, Customer Name, Sales Rep, …).
  const mfSynthetic = !isConvert();
  // Bookings + Dashboard: offer a single combined "Booking Month/Year" filter instead of separate ones.
  if (tab !== 'churn' && mfSynthetic) {
    cols = cols.filter((c) => c.key !== 'booking_month' && c.key !== 'booking_year');
    cols.unshift({ key: 'booking_my', label: 'Booking Month/Year', type: 'text' });
  }
  // Churn: synthetic "Quarter" (from Final Churn Month) + "Added" (recently-added window).
  if (tab === 'churn') {
    cols.unshift({ key: 'churn_quarter', label: 'Quarter', type: 'text' });
    cols.unshift({ key: 'added_recent', label: 'Added', type: 'text' });
  }
  // Bookings + Dashboard: a synthetic "Quarter" filter (Q1 2026, Q2 2026, …) derived from
  // Booking Month/Year. Convert Bookings also carry Booking Month/Year, so offer it there too.
  if (((tab === 'bookings' || tab === 'dashboard') && mfSynthetic) || (tab === 'bookings' && isConvert())) {
    cols.unshift({ key: 'booking_quarter', label: 'Quarter', type: 'text' });
  }
  // Bookings + Churn: a synthetic "Main Category" filter — Professional Services (Digital
  // Advertising products) vs Software (everything else). Matches the Dashboard's macro grouping.
  if ((tab === 'bookings' || tab === 'churn') && mfSynthetic) {
    cols.unshift({ key: 'main_category', label: 'Main Category', type: 'text' });
  }
  // Bookings only: a "GoLive Added" recency filter by when the GoLive Date was set in the system
  // (golive_set_date — stamped on GoLives upload and manual edits). Mirrors churn's "Added".
  if (tab === 'bookings' && mfSynthetic) {
    cols.unshift({ key: 'golive_added_recent', label: 'GoLive Added (recent)', type: 'text' });
  }
  const monthOrder = (state.schema.bookings.editable.find((x) => x.key === 'booking_month') || {}).options || [];
  const MONTH_YEAR_COLS = new Set(['final_churn_month', 'prorated_churn_month', 'final_invoice_month']);
  const valuesFor = (col) => {
    if (col.key === 'added_recent' || col.key === 'golive_added_recent') return ['All', ...Object.keys(ADDED_WINDOWS)];
    if (col.key === 'main_category') {
      const present = new Set(rowsExcept(col.key).map((r) => mainCategoryOf(r)));
      return ['All', ...['Professional Services', 'Software'].filter((v) => present.has(v))];
    }
    // GoLive filter is a has-date / no-date toggle, not a list of dates.
    if (col.key === 'golive_date') return ['All', 'Go Live', 'Not Live'];
    // Options reflect rows matching every OTHER active filter (cascading).
    const src = rowsExcept(col.key);
    if (col.key === 'booking_my') {
      const combos = [...new Set(src
        .map((r) => (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '')
        .filter(Boolean))];
      // Bookings section lists the periods most-recent → oldest; elsewhere keep oldest → newest.
      const ordered = sortMonthYear(combos);
      return ['All', ...(tab === 'bookings' ? ordered.reverse() : ordered)];
    }
    if (col.key === 'churn_quarter' || col.key === 'booking_quarter') {
      const set = new Set();
      let hasBlank = false;
      for (const r of src) {
        const my = col.key === 'churn_quarter'
          ? (r.final_churn_month || '')
          : ((r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '');
        const info = monthYearQuarter(my);
        if (info) set.add(info.label); else hasBlank = true;
      }
      const sorted = [...set].sort((a, b) => {
        const qa = a.match(/Q(\d)\s+(\d+)/); const qb = b.match(/Q(\d)\s+(\d+)/);
        return (Number(qa[2]) - Number(qb[2])) || (Number(qa[1]) - Number(qb[1]));
      });
      return ['All', ...(hasBlank ? ['(blank)'] : []), ...sorted];
    }
    // If the column has any empty values, offer "(blank)" as the first selectable option.
    const hasBlank = src.some((r) => { const v = r[col.key]; return v === null || v === undefined || String(v).trim() === ''; });
    const blank = hasBlank ? ['(blank)'] : [];
    const d = distinctIn(src, col.key);
    if (col.key === 'booking_month') { const present = new Set(d); return ['All', ...blank, ...monthOrder.filter((m) => present.has(m))]; }
    if (MONTH_YEAR_COLS.has(col.key)) return ['All', ...blank, ...sortMonthYear(d)];
    // Keep the raw values (so they still match r[key]); just order numerically for number cols.
    if (col.type === 'number') return ['All', ...blank, ...d.slice().sort((a, b) => Number(a) - Number(b))];
    return ['All', ...blank, ...d.map(String).sort((a, b) => a.localeCompare(b))];
  };
  const colByKey = new Map(cols.map((c) => [c.key, c]));

  // Bookings + Churn use the adjustable "Add Filter" system (removable tiles). The Dashboard
  // keeps its fixed filter set. Churn defaults to the synthetic Quarter filter on first use.
  const FIXED = {
    dashboard: ['booking_quarter', 'booking_my', 'pmc', 'sales_rep', 'bpr_prod_category'],
  };
  if (tab === 'churn' && !state.activeFilters.churn) state.activeFilters.churn = ['churn_quarter'];
  if (tab === 'bookings' && !state.activeFilters.bookings) {
    state.activeFilters.bookings = isConvert() ? ['booking_quarter', 'category'] : ['booking_quarter'];
  }
  const adjustable = tab === 'bookings' || tab === 'churn';
  const lockRep = isSales() && salesOwner();
  let active = adjustable
    ? (state.activeFilters[tab] || []).filter((k) => colByKey.has(k))
    : (FIXED[tab] || []).filter((k) => colByKey.has(k));
  if (lockRep && tab !== 'churn' && colByKey.has('sales_rep') && !active.includes('sales_rep')) {
    active = adjustable ? ['sales_rep', ...active] : active; // dashboard already includes sales_rep
  }
  // Dashboard's first-section "Filter by Quarter" defaults to the current calendar quarter on first
  // load (only if that quarter has data). `undefined` = never touched; once the user picks anything
  // — including "All" — the value is set and this no longer overrides it.
  if (tab === 'dashboard' && colByKey.has('booking_quarter') && state.filters.dashboard.booking_quarter === undefined) {
    const cur = currentQuarterLabel();
    if (valuesFor(colByKey.get('booking_quarter')).includes(cur)) state.filters.dashboard.booking_quarter = [cur];
  }
  const activeSet = new Set(active);
  let filtersHtml = '';
  if (!state.filtersHidden) {
    const tiles = active.map((key) => {
      const col = colByKey.get(key);
      const lbl = escapeHtml(adjustable ? col.label : `Filter by ${col.label}`);
      if (key === 'sales_rep' && lockRep) { // a tagged Sales user is locked to their own name
        const me = salesOwner();
        return `<div class="filter" data-filter="${key}"><label>${lbl}</label>`
          + `<div class="ms"><button type="button" class="ms-btn" disabled><span class="ms-label">${escapeHtml(me)}</span></button></div></div>`;
      }
      const options = valuesFor(col).filter((v) => v !== 'All');
      return filterTileHtml(key, lbl, options, selectedValues(f[key]), adjustable);
    }).join('');
    let addTile = '';
    if (adjustable) {
      const addOpts = ['<option value="">+ Add a filter…</option>']
        .concat(cols.filter((c) => !activeSet.has(c.key)).map((c) => `<option value="${c.key}">${escapeHtml(c.label)}</option>`)).join('');
      addTile = `<div class="filter add-filter"><label>Add Filter</label><select id="addFilterSelect">${addOpts}</select></div>`;
    }
    // Churn tab: a fixed "Enter Churn" button sits before the filter tiles (lives in the filters
    // row, so it hides with "Hide Multiple Filters"). Opens the single-entry churn form.
    let enterChurn = '';
    if (tab === 'churn' && canAddDelete()) {
      enterChurn = `<div class="filter enter-churn-tile"><button type="button" class="btn solid" id="enterChurnBtn">+ Enter Churn</button></div>`;
    }
    filtersHtml = `<div class="filters-row" style="zoom:${state.filterZoom}">${enterChurn}${tiles}${addTile}</div>`;
  }

  // Metric cards live on the Dashboard tab only, on their own row below the filters.
  let metricsHtml = '';
  if (state.tab === 'dashboard') {
    const filtered = rows.filter((r) => bookingMatch(r, f));
    const sum = (k) => filtered.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const totalBooking = sum('company_total_booking');
    const totalOTF = sum('one_time_fee');
    const totalComm = sum('commissionable_bookings');
    // Commissionable + OTF excludes the One-Time Fee on Conversions (already billed in pilot).
    const commPlusOtf = filtered.reduce((a, r) => a + commissionablePlusOtf(r), 0);
    metricsHtml = '<div class="metrics-row">' +
      metric('Total Company Booking', totalBooking, true) +
      metric('Total One-Time Fees', totalOTF) +
      metric('Total Commissionable', totalComm) +
      metric('Commissionable + OTF', commPlusOtf) +
      '</div>';

    // Company Total Booking per BPR product category, with its own (separate) quarter filter.
    const bookingMY = (r) => ((r.booking_month && r.booking_year != null && r.booking_year !== '')
      ? monthYearQuarter(`${r.booking_month} ${r.booking_year}`) : null);
    const bQuarterMap = new Map();
    for (const r of rows) { const info = bookingMY(r); if (info) bQuarterMap.set(info.label, info); }
    const bQuarterVals = ['All', ...[...bQuarterMap.values()]
      .sort((a, b) => (a.year - b.year) || (a.q - b.q)).map((x) => x.label)];
    if (!bQuarterVals.includes(state.bookingQuarter)) state.bookingQuarter = 'All';
    let catRows = filtered;
    if (state.bookingQuarter !== 'All') {
      catRows = catRows.filter((r) => { const i = bookingMY(r); return i && i.label === state.bookingQuarter; });
    }
    const byCat = {};
    // Two macro buckets (see mainCategoryOf): "Professional Services" = the Digital Advertising
    // products (SEO, Google Search Management, Google Performance Max); "Software" = everything else
    // (Software, Pulse, Website, Tools for Google). Same grouping as the "Main Category" filter.
    let profSvc = 0, software = 0;
    for (const r of catRows) {
      const c = (r.bpr_prod_category || '').trim() || 'Uncategorized';
      const amt = Number(r.company_total_booking) || 0;
      byCat[c] = (byCat[c] || 0) + amt;
      if (mainCategoryOf(r) === 'Professional Services') profSvc += amt; else software += amt;
    }
    const catCards = Object.keys(byCat).sort().map((c) => metric(c, byCat[c])).join('');
    const bQuarterSel = '<select id="bookingQuarter" class="churn-quarter">' +
      bQuarterVals.map((q) => `<option${q === state.bookingQuarter ? ' selected' : ''}>${q}</option>`).join('') + '</select>';
    metricsHtml += `<div class="metrics-title metrics-title-row"><span>Booking Per Product Category</span>${bQuarterSel}</div>`
      + '<div class="metrics-subtitle">Main category</div>'
      + `<div class="metrics-row">${metric('Professional Services', profSvc, true) + metric('Software', software, true)}</div>`
      + '<div class="metrics-subtitle">By product category</div>'
      + `<div class="metrics-row">${catCards || '<span class="muted">No data.</span>'}</div>`;

    // Account Owner filter for the whole Churn section (tiles + details). Sales users default
    // to their own name on login; the value is validated against the owners actually present.
    const churnOwners = [...new Set(state.rows.churn.map((r) => String(r.account_owner || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (state.churnOwner !== 'All' && !churnOwners.includes(state.churnOwner)) state.churnOwner = 'All';
    const churnOwnerMatch = (r) => state.churnOwner === 'All' || String(r.account_owner || '').trim() === state.churnOwner;
    // PMC filter for the whole Churn section (tiles + details).
    const churnPmcs = [...new Set(state.rows.churn.map((r) => String(r.pmc_buying_center || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (state.churnPmc !== 'All' && !churnPmcs.includes(state.churnPmc)) state.churnPmc = 'All';
    const churnPmcMatch = (r) => state.churnPmc === 'All' || String(r.pmc_buying_center || '').trim() === state.churnPmc;

    // Churn by month: prorated churn + final churn amounts landing in each month. A late-added
    // churn whose month is closed carries over to the next open month (effectiveChurnMonth).
    const churnByMonth = {};
    const comByMonth = {}; // "COM" = Change of Management (Lost MRR Reason = Property Sold/PMC Change)
    const addTo = (bucket, month, amt, dateAdded) => {
      const m0 = String(month || '').trim();
      const a = Number(amt);
      if (!m0 || m0 === '-' || !Number.isFinite(a) || a === 0) return; // ignore $0 churn (e.g. a $0-MRR product)
      const m = effectiveChurnMonth(m0, dateAdded).month;
      bucket[m] = (bucket[m] || 0) + a;
    };
    for (const r of state.rows.churn) {
      if (String(r.classification || '') === 'Contraction') continue; // contractions aren't churn
      if (!churnOwnerMatch(r)) continue;
      if (!churnPmcMatch(r)) continue;
      const isCom = String(r.lost_mrr_reason || '').trim() === 'Property Sold/PMC Change';
      const add = (month, amt, dateAdded) => {
        addTo(churnByMonth, month, amt, dateAdded);
        if (isCom) addTo(comByMonth, month, amt, dateAdded);
      };
      if (String(r.classification || '') === 'Churn Credit') {
        // A positive credit (cancels a locked closed-month drop), recognized in its open month.
        add(r.final_churn_month, Math.abs(Number(r.mrr) || 0), r.date_added);
        continue;
      }
      add(r.prorated_churn_month, r.prorated_churn_amount, r.date_added);
      add(r.final_churn_month, r.final_churn_amount, r.date_added);
    }
    // Quarter options derived from the months present; reset selection if it no longer exists.
    const quarterMap = new Map();
    for (const m of Object.keys(churnByMonth)) {
      const info = monthYearQuarter(m);
      if (info) quarterMap.set(info.label, info);
    }
    const quarterVals = ['All', ...[...quarterMap.values()]
      .sort((a, b) => (a.year - b.year) || (a.q - b.q)).map((x) => x.label)];
    if (!quarterVals.includes(state.churnQuarter)) state.churnQuarter = 'All';
    let churnMonths = Object.keys(churnByMonth);
    if (state.churnQuarter !== 'All') {
      churnMonths = churnMonths.filter((m) => {
        const i = monthYearQuarter(m);
        return i && i.label === state.churnQuarter;
      });
    }
    const churnCards = sortMonthYear(churnMonths).map((m) => metric(m, churnByMonth[m])).join('');
    // Quarter totals (sum of the shown months, grouped by quarter).
    const qTotals = new Map();
    for (const m of churnMonths) {
      const info = monthYearQuarter(m);
      if (info) qTotals.set(info.label, (qTotals.get(info.label) || 0) + churnByMonth[m]);
    }
    // Quarter-total tiles are clickable: selecting one opens its per-month Churn Details below.
    if (state.churnDetailQuarter && !qTotals.has(state.churnDetailQuarter)) state.churnDetailQuarter = null;
    const qTotalCards = [...qTotals.keys()]
      .sort((a, b) => { const ia = quarterMap.get(a); const ib = quarterMap.get(b); return (ia.year - ib.year) || (ia.q - ib.q); })
      .map((label) => `<div class="metric accent clickable${state.churnDetailQuarter === label ? ' active' : ''}" data-churn-quarter="${escapeAttr(label)}">`
        + `<span class="k">${label} total</span><span class="v">${fmtMoney(qTotals.get(label))}</span></div>`)
      .join('');
    // COM Total = churn tagged "Property Sold/PMC Change" (Lost MRR Reason), over the shown months.
    const comTotal = churnMonths.reduce((a, m) => a + (comByMonth[m] || 0), 0);
    const comCard = `<div class="metric accent clickable${state.churnComOpen ? ' active' : ''}" data-churn-com="1" title="Churn with Lost MRR Reason = Property Sold/PMC Change">`
      + `<span class="k">COM Total</span><span class="v">${fmtMoney(comTotal)}</span></div>`;
    const quarterSel = '<select id="churnQuarter" class="churn-quarter">' +
      quarterVals.map((q) => `<option${q === state.churnQuarter ? ' selected' : ''}>${q}</option>`).join('') + '</select>';
    // Account Owner filter (locked to their own name for sales users).
    const ownerVals = ['All', ...churnOwners];
    const churnOwnerSel = `<select id="churnOwner" class="churn-quarter"${isSales() ? ' disabled' : ''}>` +
      ownerVals.map((o) => `<option${o === state.churnOwner ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') + '</select>';
    // PMC filter.
    const churnPmcSel = '<select id="churnPmc" class="churn-quarter">' +
      ['All', ...churnPmcs].map((p) => `<option${p === state.churnPmc ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('') + '</select>';
    metricsHtml += `<div class="metrics-title metrics-title-row"><span>Churn</span>`
      + `<label class="churn-filter-lbl">PMC ${churnPmcSel}</label>`
      + `<label class="churn-filter-lbl">Owner ${churnOwnerSel}</label>${quarterSel}</div>`;
    if (qTotalCards) metricsHtml += `<div class="metrics-row">${qTotalCards}${comCard}</div>`;
    metricsHtml += `<div class="metrics-row">${churnCards || '<span class="muted">No churn data.</span>'}</div>`;
    // Churn Details: one table per month of the selected quarter (property / MRR dropped / last date).
    if (state.churnDetailQuarter) metricsHtml += renderChurnDetail(state.churnDetailQuarter);
    // COM detail: the churn rows tagged Property Sold/PMC Change (same Owner + Quarter scope).
    if (state.churnComOpen) metricsHtml += renderComDetail();
  }

  // Nothing to show (filters hidden and not the dashboard) — collapse the whole bar.
  if (!filtersHtml && !metricsHtml) { el.className = 'summary hidden'; el.innerHTML = ''; return; }
  el.className = 'summary';
  el.innerHTML = filtersHtml + metricsHtml;

  if (!state.filtersHidden) {
    const ecBtn = $('#enterChurnBtn');
    if (ecBtn) ecBtn.onclick = openChurnForm;
    // Filter value dropdowns are checkbox multi-selects, wired once via wireFilterMenus().
    const addSel = $('#addFilterSelect');
    if (addSel) addSel.onchange = (e) => {
      const id = e.target.value;
      if (!id) return;
      if (!state.activeFilters[tab]) state.activeFilters[tab] = [];
      if (!state.activeFilters[tab].includes(id)) state.activeFilters[tab].push(id);
      saveActiveFilters();
      renderSummary();
    };
    el.querySelectorAll('[data-remove-filter]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.removeFilter;
        state.activeFilters[tab] = (state.activeFilters[tab] || []).filter((x) => x !== id);
        f[id] = 'All';
        saveActiveFilters();
        renderSummary();
        if (tab !== 'dashboard') renderBody();
      };
    });
  }
  // Quarter filters live in the metrics area (always present on the dashboard).
  const qSel = $('#churnQuarter');
  if (qSel) qSel.onchange = (e) => { state.churnQuarter = e.target.value; renderSummary(); };
  const bqSel = $('#bookingQuarter');
  if (bqSel) bqSel.onchange = (e) => { state.bookingQuarter = e.target.value; renderSummary(); };
  const coSel = $('#churnOwner');
  if (coSel) coSel.onchange = (e) => { state.churnOwner = e.target.value; renderSummary(); };
  const cpSel = $('#churnPmc');
  if (cpSel) cpSel.onchange = (e) => { state.churnPmc = e.target.value; renderSummary(); };
  // Click a quarter-total tile -> toggle its per-month Churn Details breakdown.
  el.querySelectorAll('[data-churn-quarter]').forEach((tile) => {
    tile.onclick = () => {
      const label = tile.dataset.churnQuarter;
      state.churnDetailQuarter = state.churnDetailQuarter === label ? null : label;
      renderSummary();
    };
  });
  // Click the COM Total tile -> toggle the COM (Property Sold/PMC Change) detail table.
  const comTile = el.querySelector('[data-churn-com]');
  if (comTile) comTile.onclick = () => { state.churnComOpen = !state.churnComOpen; renderSummary(); };
  applyChurnDetailWidths(); // re-apply any saved Churn Details column widths to the new tables
}

// ---- Convert instance: Bookings Dashboard ----
// Total Bookings (sum of Company Total Booking), viewed by quarter. A year's quarters show as
// clickable tiles; clicking one reveals that quarter's three month tiles. Defaults to the current
// year + current quarter (else the most recent quarter with data). Clicking a month tile opens a
// detail table of that month's bookings.
const CONVERT_QUARTER_MONTHS = { 1: [0, 1, 2], 2: [3, 4, 5], 3: [6, 7, 8], 4: [9, 10, 11] };
function renderConvertDashboard(el) {
  const allRows = state.rows.bookings || [];
  const bookingMY = (r) => ((r.booking_month && r.booking_year != null && r.booking_year !== '')
    ? monthYearQuarter(`${r.booking_month} ${r.booking_year}`) : null);
  // Division + Channel filters — options come from ALL bookings (so each list stays complete when
  // a value is selected); the tiles/detail below use the filtered set.
  const distinctOf = (key) => [...new Set(allRows.map((r) => String(r[key] ?? '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const divisions = distinctOf('division');
  const channels = distinctOf('channel');
  if (state.convertDivision !== 'All' && !divisions.includes(state.convertDivision)) state.convertDivision = 'All';
  if (state.convertChannel !== 'All' && !channels.includes(state.convertChannel)) state.convertChannel = 'All';
  const rows = allRows.filter((r) =>
    (state.convertDivision === 'All' || String(r.division ?? '').trim() === state.convertDivision)
    && (state.convertChannel === 'All' || String(r.channel ?? '').trim() === state.convertChannel));
  const selectHtml = (id, cur, opts) => `<select id="${id}" class="churn-quarter">`
    + ['All', ...opts].map((o) => `<option${o === cur ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') + '</select>';
  const filterBar = `<label class="churn-filter-lbl">Division ${selectHtml('convertDivision', state.convertDivision, divisions)}</label>`
    + `<label class="churn-filter-lbl">Channel ${selectHtml('convertChannel', state.convertChannel, channels)}</label>`;
  // Quarters + years present in the filtered data.
  const qMap = new Map(); // label -> {q, year, label}
  const yearsSet = new Set();
  for (const r of rows) { const info = bookingMY(r); if (info) { qMap.set(info.label, info); yearsSet.add(info.year); } }
  el.className = 'summary';
  if (!qMap.size) {
    const filtered = state.convertDivision !== 'All' || state.convertChannel !== 'All';
    const msg = filtered ? 'No bookings for the selected filters.' : 'No bookings yet. Import the EDIT tab to get started.';
    el.innerHTML = `<div class="metrics-title metrics-title-row"><span>Total Bookings</span>${filterBar}</div>`
      + `<div class="metrics-row"><span class="muted">${msg}</span></div>`;
    wireConvertFilters(el);
    return;
  }
  const years = [...yearsSet].sort((a, b) => a - b);
  // Default year: the current year if it has data, else the most recent year with data.
  if (!years.includes(state.convertYear)) {
    const curYear = new Date().getFullYear();
    state.convertYear = years.includes(curYear) ? curYear : years[years.length - 1];
  }
  // The selected year's quarters that have data, ascending (Q1 → Q4).
  const yearQuarters = [...qMap.values()].filter((x) => x.year === state.convertYear).sort((a, b) => a.q - b.q);
  const availLabels = yearQuarters.map((x) => x.label);
  // Default quarter: the current quarter if it's in this year's data, else the most recent one.
  if (!availLabels.includes(state.convertQuarter)) {
    const cur = currentQuarterLabel();
    state.convertQuarter = availLabels.includes(cur) ? cur : availLabels[availLabels.length - 1];
  }
  const sel = qMap.get(state.convertQuarter);

  const totalForMonth = (mName, yr) => rows.reduce((a, r) =>
    (r.booking_month === mName && Number(r.booking_year) === yr ? a + (Number(r.company_total_booking) || 0) : a), 0);
  const totalForQuarter = (qi) => CONVERT_QUARTER_MONTHS[qi.q].reduce((a, i) => a + totalForMonth(MONTHS[i], qi.year), 0);

  // Year selector (only when more than one year has data), next to the title.
  const yearSel = years.length > 1
    ? '<select id="convertYear" class="churn-quarter">'
      + years.slice().reverse().map((y) => `<option${y === state.convertYear ? ' selected' : ''}>${y}</option>`).join('') + '</select>'
    : '';

  let html = `<div class="metrics-title metrics-title-row"><span>Total Bookings</span>${filterBar}${yearSel}</div>`;
  // Quarter tiles (clickable) for the selected year — the selected one is highlighted.
  const qTiles = yearQuarters.map((x) => {
    const active = x.label === state.convertQuarter ? ' active' : '';
    return `<div class="metric accent clickable${active}" data-convert-quarter="${escapeAttr(x.label)}">`
      + `<span class="k">${x.label}</span><span class="v">${fmtMoney(totalForQuarter(x))}</span></div>`;
  }).join('');
  html += `<div class="metrics-row">${qTiles}</div>`;

  // Month tiles for the selected quarter (always shown).
  const monthIdxs = CONVERT_QUARTER_MONTHS[sel.q];
  const monthLabels = monthIdxs.map((i) => `${MONTHS[i]} ${sel.year}`);
  if (state.convertDetailMonth && !monthLabels.includes(state.convertDetailMonth)) state.convertDetailMonth = null;
  const mTiles = monthIdxs.map((i) => {
    const label = `${MONTHS[i]} ${sel.year}`;
    const active = state.convertDetailMonth === label ? ' active' : '';
    return `<div class="metric clickable${active}" data-convert-month="${escapeAttr(label)}">`
      + `<span class="k">${MONTHS[i]}</span><span class="v">${fmtMoney(totalForMonth(MONTHS[i], sel.year))}</span></div>`;
  }).join('');
  html += `<div class="metrics-subtitle">${escapeHtml(state.convertQuarter)} — by month</div>`;
  html += `<div class="metrics-row">${mTiles}</div>`;
  if (state.convertDetailMonth) html += renderConvertMonthDetail(state.convertDetailMonth, sel.year);

  el.innerHTML = html;

  wireConvertFilters(el);
  const ys = $('#convertYear');
  if (ys) ys.onchange = (e) => { state.convertYear = Number(e.target.value); state.convertQuarter = ''; state.convertDetailMonth = null; renderSummary(); };
  el.querySelectorAll('[data-convert-quarter]').forEach((tile) => {
    tile.onclick = () => { state.convertQuarter = tile.dataset.convertQuarter; state.convertDetailMonth = null; renderSummary(); };
  });
  el.querySelectorAll('[data-convert-month]').forEach((tile) => {
    tile.onclick = () => {
      const label = tile.dataset.convertMonth;
      state.convertDetailMonth = state.convertDetailMonth === label ? null : label;
      renderSummary();
    };
  });
}

// Wire the Convert dashboard Division/Channel dropdowns (shared by the normal + empty renders).
function wireConvertFilters(el) {
  const ds = el.querySelector('#convertDivision');
  if (ds) ds.onchange = (e) => { state.convertDivision = e.target.value; state.convertDetailMonth = null; renderSummary(); };
  const cs = el.querySelector('#convertChannel');
  if (cs) cs.onchange = (e) => { state.convertChannel = e.target.value; state.convertDetailMonth = null; renderSummary(); };
}

// Detail table of the bookings that fall under a given month (Convert dashboard drill-down).
function renderConvertMonthDetail(monthLabel, year) {
  const mName = String(monthLabel).split(' ')[0];
  const div = state.convertDivision;
  const ch = state.convertChannel;
  const list = (state.rows.bookings || [])
    .filter((r) => r.booking_month === mName && Number(r.booking_year) === year && (Number(r.company_total_booking) || 0) !== 0
      && (div === 'All' || String(r.division ?? '').trim() === div)
      && (ch === 'All' || String(r.channel ?? '').trim() === ch))
    .sort((a, b) => (Number(b.company_total_booking) || 0) - (Number(a.company_total_booking) || 0));
  const th = '<tr><th>Customer</th><th>Division</th><th>Channel</th><th>Product Type</th><th>Status</th>'
    + '<th class="num">Company Total Booking</th><th class="num">MRR</th><th>Sage Customer ID</th></tr>';
  const body = list.map((r) => '<tr>'
    + `<td>${escapeHtml(r.customer_name ?? '')}</td>`
    + `<td>${escapeHtml(r.division ?? '')}</td>`
    + `<td>${escapeHtml(r.channel ?? '')}</td>`
    + `<td>${escapeHtml(r.product_type ?? '')}</td>`
    + `<td>${escapeHtml(r.status ?? '')}</td>`
    + `<td class="num">${fmtMoney(r.company_total_booking)}</td>`
    + `<td class="num">${fmtMoney(r.mrr)}</td>`
    + `<td>${escapeHtml(r.sage_customer_id ?? '')}</td>`
    + '</tr>').join('');
  return `<div class="metrics-title">${escapeHtml(monthLabel)} — Bookings (${list.length})</div>`
    + '<div class="churn-detail"><table><thead>' + th + '</thead><tbody>'
    + (body || `<tr><td class="muted" colspan="8" style="padding:12px">No bookings for ${escapeHtml(monthLabel)}.</td></tr>`)
    + '</tbody></table></div>';
}

function saveActiveFilters() { localStorage.setItem('perqActiveFilters', JSON.stringify(state.activeFilters)); }
function metric(k, v, accent = false) {
  return `<div class="metric${accent ? ' accent' : ''}"><span class="k">${k}</span><span class="v">${fmtMoney(v)}</span></div>`;
}

// Per-month Churn Details for a quarter. Two sets of 3 tables (one per month):
//   1. Real churn (classification != Contraction): Property / MRR dropped / Last Date Under Contract.
//   2. Contracted churn — churn used to offset a License Transfer booking: Property / MRR dropped /
//      Notes (truncated, full text on hover). Sums reconcile with the quarter's month tiles above.
// Detail table for the COM Total tile: churn rows tagged "Property Sold/PMC Change", scoped by the
// Churn section's Owner + Quarter filters (carry-over aware, matching the tile's number).
function renderComDetail() {
  const inScope = (monthLabel) => {
    if (state.churnQuarter === 'All') return true;
    const i = monthYearQuarter(monthLabel);
    return !!(i && i.label === state.churnQuarter);
  };
  const rows = [];
  for (const r of state.rows.churn) {
    if (String(r.classification || '') === 'Contraction') continue;
    if (String(r.lost_mrr_reason || '').trim() !== 'Property Sold/PMC Change') continue;
    if (state.churnOwner !== 'All' && String(r.account_owner || '').trim() !== state.churnOwner) continue;
    if (state.churnPmc !== 'All' && String(r.pmc_buying_center || '').trim() !== state.churnPmc) continue;
    let amt = 0; let month = '';
    const consider = (m0, a0, credit) => {
      const a = credit ? Math.abs(Number(a0) || 0) : Number(a0);
      const mm = effectiveChurnMonth(String(m0 || '').trim(), r.date_added).month;
      if (!mm || mm === '-' || !Number.isFinite(a) || a === 0 || !inScope(mm)) return;
      amt += a; if (!month) month = mm;
    };
    if (String(r.classification || '') === 'Churn Credit') consider(r.final_churn_month, r.mrr, true);
    else { consider(r.prorated_churn_month, r.prorated_churn_amount); consider(r.final_churn_month, r.final_churn_amount); }
    if (amt === 0) continue;
    rows.push({ pmc: r.pmc_buying_center || '', prop: r.property || r.property_id || '—', product: r.product || '—', mrr: Number(r.mrr) || 0, month, amt, last: r.last_date_under_contract || '' });
  }
  rows.sort((a, b) => (a.pmc || '').localeCompare(b.pmc || '') || (a.prop || '').localeCompare(b.prop || ''));
  const total = rows.reduce((a, r) => a + r.amt, 0);
  const scope = state.churnQuarter === 'All' ? 'all quarters' : state.churnQuarter;
  const body = rows.map((x) => `<tr>
      <td>${escapeHtml(x.pmc || '—')}</td>
      <td>${escapeHtml(x.prop)}</td>
      <td>${escapeHtml(x.product)}</td>
      <td class="num">${fmtMoney(x.mrr)}</td>
      <td>${escapeHtml(x.month)}</td>
      <td class="num">${fmtMoney(x.amt)}</td>
      <td>${escapeHtml(x.last || '—')}</td>
    </tr>`).join('');
  return `<div class="metrics-title">COM — Property Sold/PMC Change · ${escapeHtml(scope)} · ${rows.length} · ${fmtMoney(total)}</div>`
    + '<div class="result-detail"><table class="recon-table"><thead><tr>'
    + '<th>PMC</th><th>Property</th><th>Product</th><th class="num">MRR</th><th>Month</th><th class="num">Churn</th><th>Last Date</th>'
    + '</tr></thead><tbody>'
    + (body || '<tr><td class="muted" colspan="7" style="padding:12px">No COM churn for this scope.</td></tr>')
    + '</tbody></table></div>';
}

function renderChurnDetail(quarterLabel) {
  const m = String(quarterLabel).match(/Q(\d)\s+(\d{4})/);
  if (!m) return '';
  const q = Number(m[1]);
  const year = m[2];
  const months = (QUARTER_MONTHS[q] || []).map((mo) => `${mo} ${year}`);
  // Entries for a month, split by whether the row is a Contraction (offset) or real churn.
  const rowsFor = (monthLabel, wantContraction) => {
    const out = [];
    for (const r of state.rows.churn) {
      const cls = String(r.classification || '');
      // Honor the Churn section's Account Owner + PMC filters.
      if (state.churnOwner !== 'All' && String(r.account_owner || '').trim() !== state.churnOwner) continue;
      if (state.churnPmc !== 'All' && String(r.pmc_buying_center || '').trim() !== state.churnPmc) continue;
      const e = { prop: r.property || r.property_id || '—', pmc: r.pmc_buying_center || '', product: r.product || '', last: r.last_date_under_contract || '', note: r.notes || '' };
      // Churn Credit: a positive line in the real-churn table (cancels a locked closed-month drop).
      if (cls === 'Churn Credit') {
        if (wantContraction) continue;
        const cm = effectiveChurnMonth(r.final_churn_month, r.date_added);
        if (cm.month === monthLabel) out.push({ ...e, amt: Math.abs(Number(r.mrr) || 0), carriedFrom: cm.carriedFrom, credit: true });
        continue;
      }
      const isContraction = cls === 'Contraction';
      if (isContraction !== wantContraction) continue;
      // A churn event can land a prorated remainder one month and the full amount the next.
      // Each is shifted to the next open month if its natural month is closed (carry-over).
      const pm = effectiveChurnMonth(r.prorated_churn_month, r.date_added);
      if (pm.month === monthLabel) {
        const a = Number(r.prorated_churn_amount);
        if (Number.isFinite(a) && a !== 0) out.push({ ...e, amt: a, carriedFrom: pm.carriedFrom });
      }
      const fm = effectiveChurnMonth(r.final_churn_month, r.date_added);
      if (fm.month === monthLabel) {
        const a = Number(r.final_churn_amount);
        if (Number.isFinite(a) && a !== 0) out.push({ ...e, amt: a, carriedFrom: fm.carriedFrom }); // skip $0 churn
      }
    }
    // Sort by PMC A–Z (then Property) for a predictable, easy-to-scan order.
    out.sort((a, b) => (a.pmc || '').localeCompare(b.pmc || '') || (a.prop || '').localeCompare(b.prop || ''));
    return out;
  };
  const lastCell = (x) => `<td class="churn-date" data-col="last" title="${escapeAttr(x.last || '')}">${escapeHtml(x.last || '—')}</td>`;
  const noteCell = (x) => `<td class="churn-note" data-col="note" title="${escapeAttr(x.note || '')}"><span>${escapeHtml(x.note || '—')}</span></td>`;
  // Column headers carry a resize handle (data-col matches the body cells); widths are shared
  // across all month tables so they stay aligned. thirdKey is 'last' or 'note'.
  const th = (label, key, cls) => `<th${cls ? ` class="${cls}"` : ''} data-col="${key}">${label}<span class="col-resize"></span></th>`;
  // Build one month's table for the given set.
  const table = (monthLabel, wantContraction, thirdLabel, thirdKey, thirdCell, emptyLabel) => {
    const list = rowsFor(monthLabel, wantContraction);
    const total = list.reduce((s, x) => s + x.amt, 0);
    const section = wantContraction ? 'c' : 'n';
    const badge = (x) => x.credit ? ' <span class="carry-badge credit-badge">Churn Credit</span>'
      : (x.carriedFrom ? ` <span class="carry-badge" title="Carried over because ${escapeAttr(x.carriedFrom)} was closed before this churn was added">carried from ${escapeHtml(x.carriedFrom)}</span>` : '');
    // Group the month's churn by property; each property rolls up to a total with a ▸ arrow that
    // expands to its per-product detail (single-product properties show inline, no arrow).
    const groups = new Map();
    for (const x of list) {
      const gk = `${x.pmc}||${x.prop}`;
      if (!groups.has(gk)) groups.set(gk, { pmc: x.pmc, prop: x.prop, entries: [] });
      groups.get(gk).entries.push(x);
    }
    const propGroups = [...groups.values()].sort((a, b) => (a.pmc || '').localeCompare(b.pmc || '') || (a.prop || '').localeCompare(b.prop || ''));
    const body = list.length
      ? propGroups.map((g) => {
        const pmcProp = [g.pmc, g.prop].filter(Boolean).join(' - ') || '—';
        const gTotal = g.entries.reduce((s, x) => s + x.amt, 0);
        if (g.entries.length === 1) {
          const x = g.entries[0];
          return `<tr><td data-col="pmcprop" title="${escapeAttr(pmcProp)}"><span class="churn-nocaret"></span>${escapeHtml(pmcProp)}${badge(x)}</td>`
            + `<td data-col="product" title="${escapeAttr(x.product || '')}">${escapeHtml(x.product || '—')}</td>`
            + `<td class="num" data-col="mrr">${fmtMoney(gTotal)}</td>${thirdCell(x)}</tr>`;
        }
        const key = `${monthLabel}|${section}|${pmcProp}`;
        const open = state.churnDetailExpanded.has(key);
        const caret = `<button type="button" class="ss-expand${open ? ' open' : ''}" data-churn-expand="${escapeAttr(key)}" title="Show / hide products">▸</button>`;
        const propRow = `<tr class="churn-prop-row"><td data-col="pmcprop" title="${escapeAttr(pmcProp)}">${caret}${escapeHtml(pmcProp)} <span class="ss-count">${g.entries.length}</span></td>`
          + `<td data-col="product"></td><td class="num" data-col="mrr">${fmtMoney(gTotal)}</td><td data-col="${thirdKey}"></td></tr>`;
        const detail = open ? g.entries.slice().sort((a, b) => String(a.product).localeCompare(b.product)).map((x) =>
          `<tr class="churn-detail-sub"><td data-col="pmcprop"><span class="ss-detail-indent">↳</span></td>`
          + `<td data-col="product" title="${escapeAttr(x.product || '')}">${escapeHtml(x.product || '—')}${badge(x)}</td>`
          + `<td class="num" data-col="mrr">${fmtMoney(x.amt)}</td>${thirdCell(x)}</tr>`).join('') : '';
        return propRow + detail;
      }).join('')
      : `<tr><td class="muted" colspan="4" style="padding:10px">${emptyLabel}</td></tr>`;
    return '<div class="churn-detail-card">'
      + `<div class="churn-detail-month">${escapeHtml(monthLabel)}</div>`
      + '<div class="churn-detail-scroll">'
      + `<table><thead><tr>${th('PMC - Property', 'pmcprop')}${th('Product', 'product')}${th('MRR Dropped', 'mrr', 'num')}${th(thirdLabel, thirdKey)}</tr></thead>`
      + `<tbody>${body}</tbody>`
      + (list.length ? `<tfoot><tr><td>Total</td><td></td><td class="num">${fmtMoney(total)}</td><td></td></tr></tfoot>` : '')
      + '</table></div></div>';
  };
  let html = `<div class="metrics-title">Churn Details — ${escapeHtml(quarterLabel)}</div>`
    + `<div class="churn-detail-grid">${months.map((mo) => table(mo, false, 'Last Date Under Contract', 'last', lastCell, 'No churn this month.')).join('')}</div>`;
  html += `<div class="metrics-title">Contracted Churn (offsets) — ${escapeHtml(quarterLabel)}</div>`
    + `<div class="churn-detail-grid">${months.map((mo) => table(mo, true, 'Notes', 'note', noteCell, 'No contracted churn this month.')).join('')}</div>`;
  return html;
}

// ---------- Billing Dashboard (admin + billing) ----------
const BD_BILLING = new Set(['billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'sage_id', 'billing_notes']);
// Who can edit a field in the drill-down: admin/standard all; billing = billing columns.
function bdCanEdit(key) {
  const r = role();
  if (r === 'admin' || r === 'standard') return true;
  if (r === 'billing') return BD_BILLING.has(key);
  return false;
}
const BD_DETAIL_KEYS = ['property_id', 'property_name', 'pmc', 'product', 'mrr', 'one_time_fee',
  'billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'golive_date', 'sage_id', 'billing_notes'];
// Per-card column overrides for the drill-down (defaults to BD_DETAIL_KEYS). The "without Sage ID"
// list is focused on the columns needed to fill the Sage ID in: identity + Sage ID + Billing Notes.
const BD_DETAIL_KEYS_BY = {
  noSage: ['property_id', 'property_name', 'mrr', 'golive_date', 'sage_id', 'billing_notes'],
};
// Columns shown in the Churn "For Immediate Action" drill-down (editable so billing can act).
// Uses the billing-editable Billing Notes (not the system-generated License Transfer "notes").
const CHURN_DETAIL_KEYS = ['property_id', 'property', 'product', 'mrr', 'last_date_under_contract',
  'template_deleted', 'completed', 'billing_notes'];
// Who can edit a churn cell in the drill-down: admin/standard all; billing = churn billing columns.
function churnCanEdit(key) {
  const r = role();
  if (r === 'admin' || r === 'standard') return true;
  if (r === 'billing') return BILLING_KEYS.churn.has(key);
  return false;
}

function renderBillingDashboard() {
  // Booking Month/Year filter: scopes the metric tiles and their drill-downs.
  const bookingMY = (r) => (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '';
  const myOptions = ['All', ...sortMonthYear([...new Set(state.rows.bookings.map(bookingMY).filter(Boolean))])];
  if (!myOptions.includes(state.bdMonth)) state.bdMonth = 'All';
  const rows = state.bdMonth === 'All' ? state.rows.bookings : state.rows.bookings.filter((r) => bookingMY(r) === state.bdMonth);
  const num = (v) => Number(v) || 0;
  const distinctProps = (pred) => {
    const set = new Set();
    for (const r of rows) if (pred(r)) set.add(String(r.property_id || r.property_name || `#${r.id}`));
    return set.size;
  };
  const sumWhere = (pred, key) => rows.reduce((a, r) => a + (pred(r) ? num(r[key]) : 0), 0);

  const hasImplFee = (r) => num(r.one_time_fee) > 0;
  const implCompleted = (r) => r.implementation_billing_status === 'Completed';
  // Legacy SaaS rows were already billed in the old workbook — they must never surface as an
  // outstanding billing action, so they're excluded from the "pending / not-completed" tiles.
  const implPending = (r) => hasImplFee(r) && r.implementation_billing_status !== 'Completed' && !r.legacy;
  const recCompleted = (r) => r.recurring_billing_status === 'Completed';
  const recPending = (r) => r.recurring_billing_status === 'Pending' && !r.legacy;
  const notLive = (r) => !r.golive_date;
  const live = (r) => !!r.golive_date;
  const noSage = (r) => !String(r.sage_id || '').trim();

  // AR Final Invoice (from the Churn Tracker): churn rows that have an AR final invoice, split by
  // whether the billing "Completed" column is filled. Has its own Final Invoice Month filter.
  const arHas = (c) => String(c.final_invoice_month || '').trim() !== '' && c.ar_final_invoice_amount != null;
  const arMonthOptions = ['All', ...sortMonthYear([...new Set((state.rows.churn || []).filter(arHas).map((c) => String(c.final_invoice_month).trim()))])];
  if (!arMonthOptions.includes(state.bdArMonth)) state.bdArMonth = 'All';
  const arRows = (state.rows.churn || []).filter(arHas)
    .filter((c) => state.bdArMonth === 'All' || String(c.final_invoice_month).trim() === state.bdArMonth);
  const arDone = (c) => String(c.completed || '').trim() !== '';
  // Legacy churn was already invoiced in the old workbook — keep it out of "Not Completed".
  const arNotList = arRows.filter((c) => !arDone(c) && !c.legacy);
  const arDoneList = arRows.filter(arDone);
  const arSum = (list) => list.reduce((a, c) => a + (Number(c.ar_final_invoice_amount) || 0), 0);

  const BD_PREDS = {
    implFee: { label: 'Properties with Implementation Fees', pred: hasImplFee },
    implBilled: { label: 'Implementation Fees — Billed (Completed)', pred: (r) => hasImplFee(r) && implCompleted(r) },
    implPending: { label: 'Implementation Fees — Pending / Not Billed', pred: implPending },
    recCompleted: { label: 'Recurring Billing — Completed', pred: recCompleted },
    recPending: { label: 'Recurring Billing — Pending', pred: recPending },
    notLive: { label: 'Not Live (no GoLive date)', pred: notLive },
    live: { label: 'Live Properties', pred: live },
    noSage: { label: 'Properties without Sage ID', pred: noSage },
  };

  // Tiles are clickable; data-bd ties each to a drill-down predicate.
  const card = (label, value, bd, accent) =>
    `<div class="metric clickable${accent ? ' accent' : ''}${state.bdDetail === bd ? ' active' : ''}" data-bd="${bd}"><span class="k">${label}</span><span class="v">${value}</span></div>`;

  // "For Immediate Action": GoLive / Churn-date changes from uploads (the notifications).
  let html = renderActionSection();

  const monthSel = '<select id="bdMonth" class="churn-quarter">'
    + myOptions.map((o) => `<option${o === state.bdMonth ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') + '</select>';
  html += '<div class="bd-bar">'
    + `<label class="churn-filter-lbl">Month/Year ${monthSel}</label>`
    + `<button type="button" class="view-btn" data-bd-toggle>${state.bdCollapsed ? 'Show metrics ▾' : 'Hide metrics ▴'}</button></div>`;
  if (!state.bdCollapsed) html +=
    '<div class="metrics-title">Implementation Fees</div><div class="metrics-row">'
    + card('Properties w/ Impl. Fee', String(distinctProps(hasImplFee)), 'implFee', true)
    + card('Total Implementation Fees', fmtMoney(sumWhere(hasImplFee, 'one_time_fee')), 'implFee')
    + card('Billed (Completed)', fmtMoney(sumWhere((r) => hasImplFee(r) && implCompleted(r), 'one_time_fee')), 'implBilled')
    + card('Pending / Not Billed', fmtMoney(sumWhere(implPending, 'one_time_fee')), 'implPending')
    + '</div>'
    + '<div class="metrics-title">Recurring Billing</div><div class="metrics-row">'
    + card('Completed Properties', String(distinctProps(recCompleted)), 'recCompleted', true)
    + card('Completed MRR', fmtMoney(sumWhere(recCompleted, 'mrr')), 'recCompleted')
    + card('Pending Properties', String(distinctProps(recPending)), 'recPending')
    + card('Pending MRR', fmtMoney(sumWhere(recPending, 'mrr')), 'recPending')
    + '</div>'
    + '<div class="metrics-title">Go-Live</div><div class="metrics-row">'
    + card('Not Live (no GoLive date)', String(distinctProps(notLive)), 'notLive', true)
    + card('Not Live MRR', fmtMoney(sumWhere(notLive, 'mrr')), 'notLive')
    + card('Live Properties', String(distinctProps(live)), 'live')
    + card('Live MRR', fmtMoney(sumWhere(live, 'mrr')), 'live')
    + '</div>'
    + '<div class="metrics-title">Data Quality</div><div class="metrics-row">'
    + card('Properties without Sage ID', String(distinctProps(noSage)), 'noSage', true)
    + '</div>'
    + `<div class="metrics-title metrics-title-row"><span>AR Final Invoice (Churn)</span>`
    + '<select id="bdArMonth" class="churn-quarter">'
    + arMonthOptions.map((o) => `<option${o === state.bdArMonth ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')
    + '</select></div><div class="metrics-row">'
    + card('Not Completed', String(arNotList.length), 'arNotCompleted', true)
    + card('Not Completed AR', fmtMoney(arSum(arNotList)), 'arNotCompleted')
    + card('Completed', String(arDoneList.length), 'arCompleted')
    + card('Completed AR', fmtMoney(arSum(arDoneList)), 'arCompleted')
    + '</div>';

  // Drill-down: editable detail table for the selected tile (edits write back to bookings).
  // Columns are resizable, and a multi-filter (on any shown column) narrows the rows.
  if (state.bdDetail && BD_PREDS[state.bdDetail]) {
    const { pred, label } = BD_PREDS[state.bdDetail];
    const keys = BD_DETAIL_KEYS_BY[state.bdDetail] || BD_DETAIL_KEYS;
    const defs = keys.map((k) => state.schema.bookings.editable.find((f) => f.key === k)).filter(Boolean);
    const matching = rows.filter(pred);
    const shown = matching.filter(bdRowMatches);
    const headRow = defs.map((f) => `<th data-col="${f.key}">${escapeHtml(f.label)}<span class="col-resize"></span></th>`).join('');
    const bodyRows = shown.map((row) =>
      `<tr data-id="${row.id}">${defs.map((f) => (bdCanEdit(f.key) ? editCell(f, row) : readonlyCell(f, row))).join('')}</tr>`).join('');
    const count = shown.length === matching.length ? `${matching.length}` : `${shown.length} of ${matching.length}`;
    html += `<div class="metrics-title">${escapeHtml(label)} (${count})</div>`
      + bdFilterBarHtml(defs, matching)
      + '<div class="bd-detail"><table><thead><tr>' + headRow + '</tr></thead><tbody>'
      + (bodyRows || `<tr><td class="muted" colspan="${defs.length || 1}" style="padding:12px">No matching properties.</td></tr>`)
      + '</tbody></table></div>';
  } else if (state.bdDetail === 'arNotCompleted' || state.bdDetail === 'arCompleted') {
    html += renderArDrillDown(state.bdDetail === 'arCompleted' ? arDoneList : arNotList, state.bdDetail);
  }
  $('#billingInner').classList.toggle('bd-collapsed', state.bdCollapsed);
  $('#billingInner').innerHTML = html;
  applyBillingDetailWidths(); // re-apply any saved drill-down column widths
}

// Drill-down for the AR Final Invoice tiles: churn rows with Property / Product / MRR / AR month
// + amount (read-only) and an editable Completed column (saves to churn via the billing handler).
function renderArDrillDown(list, key) {
  const label = key === 'arCompleted' ? 'AR Final Invoice — Completed' : 'AR Final Invoice — Not Completed';
  // The three editable billing columns on a churn row: Completed, Template Deleted, Billing Notes.
  const editDefs = ['completed', 'template_deleted', 'billing_notes']
    .map((k) => state.schema.churn.editable.find((f) => f.key === k)).filter(Boolean);
  const head = ['Property', 'Product', 'MRR', 'AR Final Invoice Month', 'AR Final Invoice Amt', ...editDefs.map((f) => f.label)]
    .map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const colCount = 5 + editDefs.length;
  const body = list.slice()
    .sort((a, b) => String(a.property || a.pmc_buying_center || '').localeCompare(String(b.property || b.pmc_buying_center || '')))
    .map((c) => {
      const editCells = editDefs.map((f) => (churnCanEdit(f.key) ? editCell(f, c) : readonlyCell(f, c))).join('');
      return `<tr data-id="${c.id}">`
        + `<td class="ro">${escapeHtml(c.property || c.pmc_buying_center || '—')}</td>`
        + `<td class="ro">${escapeHtml(c.product || '—')}</td>`
        + `<td class="ro num">${fmtMoney(c.mrr)}</td>`
        + `<td class="ro">${escapeHtml(c.final_invoice_month || '—')}</td>`
        + `<td class="ro num">${fmtMoney(c.ar_final_invoice_amount)}</td>`
        + editCells
        + '</tr>';
    }).join('');
  const total = list.reduce((a, c) => a + (Number(c.ar_final_invoice_amount) || 0), 0);
  return `<div class="metrics-title">${escapeHtml(label)} (${list.length}) — ${fmtMoney(total)}</div>`
    + '<div class="bd-detail" data-action-tab="churn"><table><thead><tr>' + head + '</tr></thead><tbody>'
    + (body || `<tr><td class="muted" colspan="${colCount}" style="padding:12px">No matching churn rows.</td></tr>`)
    + '</tbody></table></div>';
}

// Does a row pass the Billing Dashboard drill-down filters?
function bdRowMatches(r) {
  return Object.entries(state.bdFilters).every(([k, v]) => {
    if (v == null || v === 'All' || v === '') return true;
    if (v === '(blank)') return String(r[k] ?? '').trim() === '';
    return String(r[k] ?? '') === String(v);
  });
}
// Distinct values for a drill-down column (within the tile's matched rows).
function bdValuesFor(matching, key) {
  const hasBlank = matching.some((r) => { const v = r[key]; return v === null || v === undefined || String(v).trim() === ''; });
  const d = [...new Set(matching.map((r) => r[key]).filter((v) => v !== null && v !== undefined && String(v).trim() !== ''))]
    .map(String).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return ['All', ...(hasBlank ? ['(blank)'] : []), ...d];
}
// Adjustable filter bar (removable tiles + "Add Filter") over the shown drill-down columns.
function bdFilterBarHtml(defs, matching) {
  const labelOf = (k) => (defs.find((f) => f.key === k) || {}).label || k;
  const active = Object.keys(state.bdFilters).filter((k) => defs.some((f) => f.key === k));
  const tiles = active.map((k) => {
    const cur = state.bdFilters[k] || 'All';
    const opts = bdValuesFor(matching, k).map((o) => `<option${String(o) === String(cur) ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="filter" data-filter="${k}"><button type="button" class="filter-x" data-bd-remove-filter="${k}" title="Remove filter">✕</button>`
      + `<label>${escapeHtml(labelOf(k))}</label><select data-bd-filter="${k}">${opts}</select></div>`;
  }).join('');
  const addOpts = ['<option value="">+ Add a filter…</option>']
    .concat(defs.filter((f) => !active.includes(f.key)).map((f) => `<option value="${f.key}">${escapeHtml(f.label)}</option>`)).join('');
  const addTile = `<div class="filter add-filter"><label>Add Filter</label><select id="bdAddFilter">${addOpts}</select></div>`;
  return `<div class="filters-row bd-filters">${tiles}${addTile}</div>`;
}
// Saved drill-down column widths (own scope, applied to .bd-detail cells by data-col).
function applyBillingDetailWidths() {
  const widths = state.colWidths.billing_detail || {};
  let css = '';
  for (const [key, px] of Object.entries(widths)) {
    css += `.bd-detail [data-col="${key}"]{width:${px}px;min-width:${px}px;max-width:${px}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`;
    css += `.bd-detail [data-col="${key}"] input,.bd-detail [data-col="${key}"] select{min-width:0;}`;
  }
  $('#billingDetailWidthStyle').textContent = css;
}
function setBillingDetailWidth(key, px) {
  (state.colWidths.billing_detail || (state.colWidths.billing_detail = {}))[key] = px;
  applyBillingDetailWidths();
}

// "For Immediate Action" alert tiles built from the change notifications.
function renderActionSection() {
  const golive = state.notifications.filter((n) => n.target_tab === 'bookings');
  const churn = state.notifications.filter((n) => n.target_tab === 'churn');
  if (!golive.length && !churn.length) return '';
  const actionCard = (label, count, action) =>
    `<div class="metric clickable bd-action${state.bdAction === action ? ' active' : ''}" data-bd-action="${action}">`
    + `<span class="k">${label}</span><span class="v">${count}</span></div>`;
  let html = '<div class="metrics-title bd-action-title">⚠ For Immediate Action</div><div class="metrics-row">';
  if (golive.length) html += actionCard('GoLive Changes', golive.length, 'golive');
  if (churn.length) html += actionCard('Churn Date Changes', churn.length, 'churn');
  html += '</div>';
  if (state.bdAction === 'golive' && golive.length) html += renderActionDetail('golive', golive);
  else if (state.bdAction === 'churn' && churn.length) html += renderActionDetail('churn', churn);
  return html;
}
// Drill-down for the changed rows. Same editable detail as the metric tiles, so billing can
// take action inline; a Resolve button sits at the START of each row to clear the warning.
function renderActionDetail(action, notifs) {
  const isGolive = action === 'golive';
  const tab = isGolive ? 'bookings' : 'churn';
  const title = isGolive ? 'GoLive Changes' : 'Churn Date Changes';
  const keys = isGolive ? BD_DETAIL_KEYS : CHURN_DETAIL_KEYS;
  const canEdit = isGolive ? bdCanEdit : churnCanEdit;
  const byId = new Map(state.rows[tab].map((r) => [String(r.id), r]));
  const defs = keys.map((k) => state.schema[tab].editable.find((f) => f.key === k)).filter(Boolean);
  // Original → Updated of whatever field changed (from the notification), plus the editable row.
  // Columns are resizable (data-col + .col-resize, applied via applyBillingDetailWidths).
  const th = (col, label) => `<th data-col="${col}">${escapeHtml(label)}<span class="col-resize"></span></th>`;
  const origLabel = isGolive ? 'Original GoLive' : 'Original Last Date';
  const updLabel = isGolive ? 'Updated GoLive' : 'Updated Last Date';
  const headRow = '<th class="bd-act-col">Action</th>' + th('_edit_date', 'Edit Date')
    + th('_change_orig', origLabel) + th('_change_upd', updLabel)
    + defs.map((f) => th(f.key, f.label)).join('');
  const fmtChange = (n, v) => {
    if (v === null || v === undefined || v === '') return '<span class="muted">(blank)</span>';
    return String(n.field_key) === 'mrr' ? escapeHtml(fmtMoney(v)) : escapeHtml(String(v));
  };
  const fmtEdit = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d) ? escapeHtml(String(v))
      : escapeHtml(d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  };
  // Plain (unformatted-for-HTML) values used for the dynamic filter — one flat row per notification
  // covering every column shown: the change columns, edit day, and each detail field.
  const editDay = (v) => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); };
  const changeVal = (n, v) => (v === null || v === undefined || v === '') ? '(blank)' : (String(n.field_key) === 'mrr' ? fmtMoney(v) : String(v));
  const items = notifs.map((n) => {
    const row = byId.get(String(n.booking_id));
    if (!row) return null; // the underlying row no longer exists
    const flat = { _edit_date: editDay(n.created_at), _change_orig: changeVal(n, n.old_value), _change_upd: changeVal(n, n.new_value) };
    defs.forEach((f) => { flat[f.key] = row[f.key]; });
    return { n, row, flat };
  }).filter(Boolean);
  // The dynamic "Add Filter" columns = every column in the detail table.
  const filterDefs = [{ key: '_edit_date', label: 'Edit Date' }, { key: '_change_orig', label: origLabel },
    { key: '_change_upd', label: updLabel }, ...defs.map((f) => ({ key: f.key, label: f.label }))];
  const shown = items.filter((it) => bdActionRowMatches(it.flat));
  const body = shown.map(({ n, row }) => {
    const act = `<td class="bd-act-col"><button type="button" class="bd-resolve" data-resolve="${n.id}" title="${escapeAttr(n.message || 'Mark resolved')}">⚠ Resolve</button></td>`;
    const edited = `<td data-col="_edit_date" class="bd-edit-date">${fmtEdit(n.created_at)}</td>`;
    const orig = `<td data-col="_change_orig" class="bd-change-orig">${fmtChange(n, n.old_value)}</td>`;
    const upd = `<td data-col="_change_upd" class="bd-change-upd">${fmtChange(n, n.new_value)}</td>`;
    const cells = defs.map((f) => (canEdit(f.key) ? editCell(f, row) : readonlyCell(f, row))).join('');
    return `<tr data-id="${row.id}">${act}${edited}${orig}${upd}${cells}</tr>`;
  }).join('');
  return `<div class="metrics-title">${title} (${notifs.length})</div>`
    + bdActionFilterBarHtml(filterDefs, items.map((it) => it.flat))
    + `<div class="bd-detail" data-action-tab="${tab}"><table><thead><tr>${headRow}</tr></thead>`
    + `<tbody>${body || `<tr><td class="muted" colspan="${defs.length + 4}" style="padding:12px">No rows match the current filters.</td></tr>`}</tbody></table></div>`;
}
// Does a flat action-detail row pass the "For Immediate Action" drill-down filters?
function bdActionRowMatches(flat) {
  return Object.entries(state.bdActionFilters).every(([k, v]) => {
    if (v == null || v === 'All' || v === '') return true;
    if (v === '(blank)') { const s = String(flat[k] ?? '').trim(); return s === '' || s === '(blank)'; }
    return String(flat[k] ?? '') === String(v);
  });
}
// Distinct values for an action-detail column (within the current change rows).
function bdActionValuesFor(flats, key) {
  const isBlank = (v) => v === null || v === undefined || String(v).trim() === '' || String(v) === '(blank)';
  const hasBlank = flats.some((r) => isBlank(r[key]));
  const d = [...new Set(flats.filter((r) => !isBlank(r[key])).map((r) => String(r[key])))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return ['All', ...(hasBlank ? ['(blank)'] : []), ...d];
}
// Adjustable "Add Filter" bar over the action-detail columns (own state so it never clashes with
// the metric-tile drill-down filters).
function bdActionFilterBarHtml(defs, flats) {
  const labelOf = (k) => (defs.find((f) => f.key === k) || {}).label || k;
  const active = Object.keys(state.bdActionFilters).filter((k) => defs.some((f) => f.key === k));
  const tiles = active.map((k) => {
    const cur = state.bdActionFilters[k] || 'All';
    const opts = bdActionValuesFor(flats, k).map((o) => `<option${String(o) === String(cur) ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="filter" data-filter="${escapeAttr(k)}"><button type="button" class="filter-x" data-bda-remove-filter="${escapeAttr(k)}" title="Remove filter">✕</button>`
      + `<label>${escapeHtml(labelOf(k))}</label><select data-bda-filter="${escapeAttr(k)}">${opts}</select></div>`;
  }).join('');
  const addOpts = ['<option value="">+ Add a filter…</option>']
    .concat(defs.filter((f) => !active.includes(f.key)).map((f) => `<option value="${escapeAttr(f.key)}">${escapeHtml(f.label)}</option>`)).join('');
  const addTile = `<div class="filter add-filter"><label>Add Filter</label><select id="bdActionAddFilter">${addOpts}</select></div>`;
  return `<div class="filters-row bd-filters">${tiles}${addTile}</div>`;
}

function wireBilling() {
  // Click a tile -> toggle its drill-down.
  $('#billingInner').addEventListener('click', async (e) => {
    if (e.target.closest('[data-bd-toggle]')) { state.bdCollapsed = !state.bdCollapsed; renderBillingDashboard(); return; }
    // "For Immediate Action" tile -> toggle its drill-down.
    const actionTile = e.target.closest('[data-bd-action]');
    if (actionTile) {
      const a = actionTile.dataset.bdAction;
      if (state.bdAction !== a) state.bdActionFilters = {}; // switching drill-downs clears its filters
      state.bdAction = state.bdAction === a ? null : a;
      renderBillingDashboard();
      return;
    }
    // Remove an action drill-down filter tile.
    const rmActionFilter = e.target.closest('[data-bda-remove-filter]');
    if (rmActionFilter) { delete state.bdActionFilters[rmActionFilter.dataset.bdaRemoveFilter]; renderBillingDashboard(); return; }
    // Resolve a change -> clears the warning entirely (and removes it from the bell).
    const resolveBtn = e.target.closest('[data-resolve]');
    if (resolveBtn) {
      resolveBtn.disabled = true;
      try {
        state.notifications = await api(`/api/notifications/${resolveBtn.dataset.resolve}/resolve`, { method: 'POST' });
        const tab = state.bdAction === 'golive' ? 'bookings' : 'churn';
        if (!state.notifications.some((n) => n.target_tab === tab)) state.bdAction = null;
        renderAll(); // refreshes the dashboard tiles and the header bell count
      } catch (err) { resolveBtn.disabled = false; toast(err.message, true); }
      return;
    }
    // Remove a drill-down filter tile.
    const rmFilter = e.target.closest('[data-bd-remove-filter]');
    if (rmFilter) { delete state.bdFilters[rmFilter.dataset.bdRemoveFilter]; renderBillingDashboard(); return; }
    const tile = e.target.closest('[data-bd]');
    if (!tile) return;
    // Switching tiles clears the drill-down filters (values differ per tile).
    if (state.bdDetail !== tile.dataset.bd) state.bdFilters = {};
    state.bdDetail = state.bdDetail === tile.dataset.bd ? null : tile.dataset.bd;
    renderBillingDashboard();
  });
  // Edit a cell in the drill-down -> save to bookings and refresh.
  $('#billingInner').addEventListener('change', async (e) => {
    if (e.target.id === 'bdMonth') { state.bdMonth = e.target.value; renderBillingDashboard(); return; }
    if (e.target.id === 'bdArMonth') { state.bdArMonth = e.target.value; renderBillingDashboard(); return; }
    // Drill-down multi-filter controls.
    if (e.target.id === 'bdAddFilter') { const k = e.target.value; if (k) state.bdFilters[k] = 'All'; renderBillingDashboard(); return; }
    const bf = e.target.closest('[data-bd-filter]');
    if (bf) { state.bdFilters[bf.dataset.bdFilter] = e.target.value; renderBillingDashboard(); return; }
    // Action ("For Immediate Action") drill-down filters.
    if (e.target.id === 'bdActionAddFilter') { const k = e.target.value; if (k) state.bdActionFilters[k] = 'All'; renderBillingDashboard(); return; }
    const bfa = e.target.closest('[data-bda-filter]');
    if (bfa) { state.bdActionFilters[bfa.dataset.bdaFilter] = e.target.value; renderBillingDashboard(); return; }
    const ctl = e.target.closest('[data-key]');
    if (!ctl) return;
    const tr = ctl.closest('tr');
    if (!tr || !tr.dataset.id) return;
    // Remember where we were so the re-render doesn't jump back to the top.
    const view = $('#billingView');
    const detail = $('#billingInner .bd-detail');
    const outerTop = view ? view.scrollTop : 0;
    const innerTop = detail ? detail.scrollTop : 0;
    // The Churn action drill-down marks its table; everything else edits bookings.
    const detailWrap = ctl.closest('.bd-detail');
    const tab = (detailWrap && detailWrap.dataset.actionTab) || 'bookings';
    const key = ctl.dataset.key;
    try {
      const updated = await api(`/api/${tab}/${tr.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ [key]: ctl.value }) });
      updateRowInState(tab, updated);
      // Sage ID is per-property: the server fills the property's other blank orders — reload so
      // they (and the "without Sage ID" count) reflect it.
      if (tab === 'bookings' && key === 'sage_id') state.rows.bookings = await api('/api/bookings');
      // Editing a watched date here raises a Billing alert -> reload so the tile/bell reflect it.
      if ((key === 'golive_date' || key === 'last_date_under_contract' || key === 'mrr') && (isAdmin() || role() === 'billing')) {
        state.notifications = await api('/api/notifications');
        updateBell();
      }
      renderBillingDashboard();
      // Restore scroll positions after the DOM is rebuilt.
      if (view) view.scrollTop = outerTop;
      const newDetail = $('#billingInner .bd-detail');
      if (newDetail) newDetail.scrollTop = innerTop;
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- Salesforce Recon Data (admin-only master reference) ----------
function renderSfRecon() {
  const fields = (state.schema.salesforce_recon && state.schema.salesforce_recon.editable) || [];
  const rows = state.rows.salesforce_recon || [];
  $('#sfreconCount').textContent = rows.length ? `${fmtNum(rows.length)} records` : 'No data yet';
  $('#sfreconImport').style.display = isAdmin() ? '' : 'none';
  $('#sfreconHead').innerHTML = '<tr><th class="rownum">#</th>'
    + fields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('') + '</tr>';
  const money = new Set(['mrr']);
  $('#sfreconBody').innerHTML = rows.length
    ? rows.map((r, i) => `<tr><td class="rownum">${i + 1}</td>`
        + fields.map((f) => {
          const v = r[f.key];
          const disp = money.has(f.key) ? fmtMoney(v) : (f.type === 'number' ? fmtNum(v) : (v ?? ''));
          return `<td class="${f.type === 'number' ? 'num' : ''}">${escapeHtml(String(disp))}</td>`;
        }).join('') + '</tr>').join('')
    : `<tr><td class="muted" colspan="${fields.length + 1}" style="padding:14px">No data yet. Use “Import Salesforce .xlsx”.</td></tr>`;
}

function wireSfRecon() {
  $('#sfreconReconcile').onclick = async () => {
    if (!confirm('Update Sales Rep (Bookings) and Account Owner (Sales Support) names to match the Salesforce Recon data?')) return;
    try {
      toast('Reconciling names…');
      await api('/api/salesforce_recon/reconcile-owners', { method: 'POST' });
      state.rows.bookings = await api('/api/bookings');
      state.rows.sales_support = await api('/api/sales_support');
      renderAll();
      showResult('Names reconciled',
        '<ul class="result-list"><li>Sales Rep and Account Owner names now match the Salesforce Recon data.</li></ul>');
    } catch (err) { toast(err.message, true); }
  };
  $('#sfreconFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Importing Salesforce data…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/salesforce_recon/import', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed');
      const data = await res.json();
      state.rows.salesforce_recon = await api('/api/salesforce_recon');
      state.sfPmcs = await api('/api/salesforce_recon/pmcs');
      state.schema = await api('/api/schema'); // refresh owner dropdown options
      renderAll();
      showResult('Salesforce Recon import complete',
        '<ul class="result-list">'
        + `<li><strong>${fmtNum(data.imported)}</strong> record(s) imported (replaced all existing)</li>`
        + '<li>Use <strong>Reconcile Sales Rep names</strong> to update existing Bookings &amp; Sales Support to the new names.</li>'
        + '</ul>');
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };
}

// ---------- Legacy trackers (admin + billing read-only archive) ----------
function applyLegacyZoom() {
  $('#legacyTable').style.zoom = state.legacyZoom;
  $('#legacyZoomLevel').textContent = Math.round(state.legacyZoom * 100) + '%';
}
function renderLegacy() {
  const sub = state.legacySub === 'churn' ? 'legacy_churn' : 'legacy_golives';
  const fields = (state.schema[sub] && state.schema[sub].editable) || [];
  const rows = state.rows[sub] || [];
  document.querySelectorAll('.legacy-subtab').forEach((b) => b.classList.toggle('active', b.dataset.legacy === state.legacySub));
  $('#legacyImport').hidden = !isAdmin();
  // Migrate-to-tracker only makes sense on the Churn sub-tab, for admins.
  $('#legacyMigrateChurn').hidden = !(isAdmin() && state.legacySub === 'churn');
  $('#legacyPageSize').value = state.legacyPageSize;
  applyLegacyZoom();

  // Pagination — render only the current page so resizing a (large) table stays snappy.
  const size = state.legacyPageSize === 'all' ? (rows.length || 1) : Number(state.legacyPageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, state.legacyPage), totalPages);
  state.legacyPage = page;
  const start = (page - 1) * size;
  const slice = state.legacyPageSize === 'all' ? rows : rows.slice(start, start + size);

  $('#legacyCount').textContent = rows.length ? `${fmtNum(rows.length)} records` : 'No data yet';
  $('#legacyPageInfo').textContent = `${rows.length === 0 ? 0 : start + 1}–${start + slice.length} of ${fmtNum(rows.length)}`;
  $('#legacyPagePrev').disabled = page <= 1;
  $('#legacyPageNext').disabled = page >= totalPages;

  const money = new Set(['mrr', 'sf_mrr', 'account_balance']);
  $('#legacyHead').innerHTML = '<tr><th class="rownum">#</th>'
    + fields.map((f) => `<th data-col="${f.key}">${escapeHtml(f.label)}<span class="col-resize"></span></th>`).join('') + '</tr>';
  $('#legacyBody').innerHTML = slice.length
    ? slice.map((r, i) => `<tr><td class="rownum">${start + i + 1}</td>`
        + fields.map((f) => {
          const v = r[f.key];
          const isNum = f.type === 'number' || money.has(f.key);
          const disp = money.has(f.key) ? fmtMoney(v) : (f.type === 'number' ? fmtNum(v) : (v ?? ''));
          return `<td class="${isNum ? 'num' : ''}" data-col="${f.key}">${escapeHtml(String(disp))}</td>`;
        }).join('') + '</tr>').join('')
    : `<tr><td class="muted" colspan="${fields.length + 1}" style="padding:14px">No data yet. ${isAdmin() ? 'Use “Import AR Tracking .xlsx”.' : 'Ask an admin to import the legacy tracker.'}</td></tr>`;
}

function wireLegacy() {
  document.querySelectorAll('.legacy-subtab').forEach((b) => {
    b.onclick = () => { state.legacySub = b.dataset.legacy; state.legacyPage = 1; renderLegacy(); applyColWidths(); };
  });
  $('#legacyPageSize').onchange = (e) => {
    state.legacyPageSize = e.target.value;
    localStorage.setItem('perqLegacyPageSize', state.legacyPageSize);
    state.legacyPage = 1;
    renderLegacy();
  };
  $('#legacyPagePrev').onclick = () => { state.legacyPage -= 1; renderLegacy(); };
  $('#legacyPageNext').onclick = () => { state.legacyPage += 1; renderLegacy(); };
  const setLegacyZoom = (z) => {
    state.legacyZoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10));
    localStorage.setItem('perqLegacyZoom', String(state.legacyZoom));
    applyLegacyZoom();
  };
  $('#legacyZoomOut').onclick = () => setLegacyZoom(state.legacyZoom - 0.1);
  $('#legacyZoomIn').onclick = () => setLegacyZoom(state.legacyZoom + 0.1);
  $('#legacyFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Importing legacy tracker…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/legacy/import', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed');
      const data = await res.json();
      state.rows.legacy_golives = await api('/api/legacy_golives');
      state.rows.legacy_churn = await api('/api/legacy_churn');
      renderLegacy();
      showResult('Legacy import complete',
        '<ul class="result-list">'
        + `<li><strong>${fmtNum(data.golives)}</strong> GoLive record(s)</li>`
        + `<li><strong>${fmtNum(data.churn)}</strong> Churn record(s) — Software + PPC combined</li>`
        + '</ul>');
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Migrate Legacy Churn -> the active Churn Tracker (dedup-aware, tags billing "From Legacy").
  $('#legacyMigrateChurn').onclick = async () => {
    if (!confirm('Pull Legacy Churn into the Churn Tracker?\n\nDuplicates collapse to the most-recent entry, properties already in the tracker are skipped, and billing is tagged "From Legacy". You can re-run this safely.')) return;
    try {
      toast('Migrating legacy churn…');
      const data = await api('/api/churn/migrate-legacy', { method: 'POST' });
      state.rows.churn = await api('/api/churn');
      $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
      let html = '<ul class="result-list">'
        + `<li><strong>${fmtNum(data.added)}</strong> churn row(s) added to the tracker</li>`
        + `<li><strong>${fmtNum(data.skippedExisting)}</strong> skipped (already in the tracker)</li>`
        + `<li><strong>${fmtNum(data.dupCollapsed)}</strong> legacy duplicate(s) collapsed to the latest entry</li>`
        + `<li><strong>${fmtNum(data.skippedBlank)}</strong> skipped (no Last Date Under Contract)</li>`
        + `<li class="muted">${fmtNum(data.legacyTotal)} legacy churn record(s) scanned</li>`
        + '</ul>';
      const addedRows = data.addedRows || [];
      if (addedRows.length) {
        html += `<div class="result-detail-title">Added (${addedRows.length})</div>`
          + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>MRR</th><th>Last Date Under Contract</th></tr></thead><tbody>'
          + addedRows.map((r) => `<tr><td>${escapeHtml(r.property || '—')}</td><td>${escapeHtml(r.product || '—')}</td>`
            + `<td class="num">${fmtMoney(r.mrr)}</td><td>${escapeHtml(r.last_date_under_contract || '—')}</td></tr>`).join('')
          + '</tbody></table></div>';
      }
      showResult('Legacy churn migrated', html);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- Data ops ----------
// Reflect the active instance on the root element so the theme (accent color) can switch via CSS.
function applyInstanceTheme() { document.documentElement.dataset.instance = state.instance || 'multifamily'; }

// ---- Instance-switch loading overlay (progress %) ----
// Shown while switching instances so users see the data reload is in progress. The bar eases
// toward 90% on a timer and jumps to 100% when loadAll finishes; a failsafe hides it if a load
// stalls so the overlay can never get stuck.
let _ilTimer = null;
let _ilActive = false;
function setInstanceLoaderProgress(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = $('#ilFill'); if (fill) fill.style.width = `${p}%`;
  const t = $('#ilPct'); if (t) t.textContent = `${p}%`;
}
function showInstanceLoader(instance) {
  const el = $('#instanceLoader'); if (!el) return;
  _ilActive = true;
  const lbl = $('#ilInstance'); if (lbl) lbl.textContent = instance === 'convert' ? 'Convert' : 'Multifamily';
  let pct = 0;
  setInstanceLoaderProgress(0);
  el.hidden = false; el.setAttribute('aria-hidden', 'false');
  clearInterval(_ilTimer);
  _ilTimer = setInterval(() => { pct += Math.max(0.6, (90 - pct) * 0.12); if (pct > 90) pct = 90; setInstanceLoaderProgress(pct); }, 100);
  clearTimeout(el._failsafe);
  el._failsafe = setTimeout(hideInstanceLoader, 20000); // never let it get stuck
}
function hideInstanceLoader() {
  if (!_ilActive) return;
  _ilActive = false;
  clearInterval(_ilTimer);
  const el = $('#instanceLoader'); if (!el) return;
  clearTimeout(el._failsafe);
  setInstanceLoaderProgress(100);
  setTimeout(() => { el.hidden = true; el.setAttribute('aria-hidden', 'true'); }, 300); // let 100% flash
}

// Switch instances: persist, re-theme, and reload the (instance-scoped) data.
function setInstance(instance, opts = {}) {
  const prev = state.instance;
  state.instance = (instance === 'convert' && canConvert()) ? 'convert' : 'multifamily';
  localStorage.setItem('perqInstance', state.instance);
  // Convert and Multifamily bookings have different columns, so any active bookings filter/sort/
  // quick-search from the other instance would reference columns that don't exist here (and could
  // hide every row). Reset the bookings view-state on a real switch so each instance starts clean.
  if (prev !== state.instance) {
    state.filters.bookings = {};
    state.quickFilter.bookings = { col: '', text: '' };
    state.sort.bookings = { key: null, dir: 0 };
    delete state.activeFilters.bookings; // let the instance-appropriate default filter re-apply
    saveActiveFilters();
  }
  applyInstanceTheme();
  if (opts.reload === false) return;
  if (!tabAvailable(state.tab)) state.tab = 'bookings';
  if (prev !== state.instance) showInstanceLoader(state.instance); // only on a real switch
  loadAll();
}

async function loadAll() {
  // A user without Convert access can't be in the Convert instance.
  if (state.instance === 'convert' && !canConvert()) setInstance('multifamily', { reload: false });
  applyInstanceTheme();
  state.schema = await api('/api/schema');
  state.rows.bookings = await api('/api/bookings'); // server scopes to state.instance
  // Convert has only a Bookings section for now — the other datasets are Multifamily-only.
  if (state.instance === 'convert') {
    state.rows.churn = []; state.rows.sales_support = []; state.salesPeriods = [];
    state.rows.salesforce_recon = []; state.sfPmcs = [];
    state.rows.legacy_golives = []; state.rows.legacy_churn = [];
    state.notifications = [];
    state.closedMonths = state.closedMonths || [];
    if (!tabAvailable(state.tab)) state.tab = 'bookings';
    renderAll();
    $('#status').textContent = `${state.rows.bookings.length} bookings`;
    hideInstanceLoader();
    return;
  }
  state.rows.churn = await api('/api/churn');
  state.rows.sales_support = await api('/api/sales_support');
  state.salesPeriods = await api('/api/sales_periods');
  await loadClosedMonths();
  // Default to the latest open quarter (periods are listed oldest→newest); else the latest period.
  const openPeriods = state.salesPeriods.filter((p) => p.status === 'open');
  state.salesPeriod = openPeriods.length ? openPeriods[openPeriods.length - 1].period
    : (state.salesPeriods.length ? state.salesPeriods[state.salesPeriods.length - 1].period : '');
  // Data fetches follow section access (admins + role defaults + any explicit grant).
  state.notifications = canSection('billing') ? await api('/api/notifications') : [];
  // Salesforce Recon Data (its own section) + Account Name list for the Sales Support PMC dropdown.
  state.rows.salesforce_recon = canSection('sfrecon') ? await api('/api/salesforce_recon') : [];
  state.sfPmcs = ['admin', 'standard', 'sales_admin', 'sales'].includes(role())
    ? await api('/api/salesforce_recon/pmcs') : [];
  // Legacy trackers.
  if (canSection('legacy')) {
    state.rows.legacy_golives = await api('/api/legacy_golives');
    state.rows.legacy_churn = await api('/api/legacy_churn');
  } else { state.rows.legacy_golives = []; state.rows.legacy_churn = []; }
  // Dashboard Churn section defaults to the current calendar quarter (falls back to "All"
  // in renderSummary if there's no churn data for it yet).
  state.churnQuarter = currentQuarterLabel();
  // A tagged salesperson is scoped to their own name: Sales Support owner filter + the
  // Sales Rep filter on both the Dashboard and Bookings all lock to their Account Owner.
  if (isSales() && salesOwner()) {
    state.ssFilters.owner = salesOwner();
    state.filters.dashboard.sales_rep = salesOwner();
    state.filters.bookings.sales_rep = salesOwner();
    state.churnOwner = salesOwner(); // default the dashboard Churn Account Owner filter to them
  }
  renderAll();
  $('#status').textContent =
    `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
  hideInstanceLoader();
}

function renderAll() {
  // Instance switcher + theme (the switcher shows only for users who can access Convert).
  applyInstanceTheme();
  const sw = $('#instanceSwitcher');
  if (sw) { sw.hidden = !canConvert(); sw.value = state.instance; }
  // Sidebar section visibility is per-user: admins see all; a user with an explicit allow-list sees
  // exactly those; everyone else sees their role defaults. (Sales roles still see Churn read-only —
  // canEditField gates editing separately.) Reset each render so returning from Convert restores them.
  const allowed = userSections();
  ALL_SECTION_KEYS.forEach((t) => {
    const el = document.querySelector(`[data-tab="${t}"]`); if (el) el.hidden = !allowed.includes(t);
  });
  // If the current tab isn't allowed, fall back to the first section the user can see.
  if (!allowed.includes(state.tab)) state.tab = allowed.includes('dashboard') ? 'dashboard' : (allowed[0] || 'dashboard');
  // Convert instance: only Bookings (+ Dashboard) exist for now — hide every other tab and the
  // Multifamily-only data operations (import/upload/reconcile/offsets act on Multifamily datasets).
  const inConvert = state.instance === 'convert';
  if (inConvert) {
    document.querySelectorAll('[data-tab]').forEach((el) => { if (!CONVERT_TABS.has(el.dataset.tab)) el.hidden = true; });
    if (!tabAvailable(state.tab)) state.tab = 'bookings';
  }

  const isEntry = state.tab === 'newbooking';
  const isSales = state.tab === 'salessupport';
  const isBillingTab = state.tab === 'billing';
  const isSfrecon = state.tab === 'sfrecon';
  const isLegacy = state.tab === 'legacy';
  const isSaas = state.tab === 'saas';
  const isGrid = state.tab === 'bookings' || state.tab === 'churn';
  // SaaS Financials shows its own title in its header row, so don't duplicate it up here.
  $('#currentTab').textContent = isSaas ? '' : (TAB_LABELS[state.tab] || '');
  // Account / role-based controls. The Multifamily-only data operations are hidden in Convert
  // (they import/upload/reconcile against the Multifamily datasets).
  const mfOps = !inConvert; // available only in the Multifamily instance
  $('#importBtn').style.display = (canImport() && mfOps) ? '' : 'none';
  $('#priorBookingsBtn').hidden = !(canImport() && mfOps);
  // Convert-only: import the "Retail SaaS Financials" EDIT tab into Convert bookings (admin).
  $('#convertImportBtn').hidden = !(isAdmin() && inConvert);
  // In the More PERQs menu these are role-gated only (work from any tab).
  $('#churnUploadBtn').hidden = !(canAddDelete() && mfOps);
  $('#reconcileBtn').hidden = !(canAddDelete() && mfOps);
  $('#golivesBtn').hidden = !(canAddDelete() && mfOps);
  $('#offsetReviewBtn').hidden = !(canAddDelete() && mfOps);
  $('#usersBtn').hidden = !isAdmin();
  $('#productsBtn').hidden = !(isAdmin() && mfOps);
  $('#bundlesBtn').hidden = !(isAdmin() && mfOps);
  $('#closeMonthBtn').hidden = !(isAdmin() && mfOps);
  $('#legacyImportBtn').hidden = !(isAdmin() && mfOps);
  $('#legacyClearBtn').hidden = !(isAdmin() && mfOps);
  $('#notifWrap').hidden = !canSection('billing');
  updateBell();
  // "Ask Claude" assistant: shown only when configured (API key set) and for full-data roles.
  const canAssistant = !!(state.schema && state.schema.assistantEnabled) && ['admin', 'standard', 'billing'].includes(role());
  $('#aiWidget').hidden = !canAssistant;
  $('#userWrap').hidden = !state.user;
  $('#userChip').innerHTML = state.user
    ? `${escapeHtml(state.user.username)} · <span class="role">${escapeHtml(state.user.role)}</span>` : '';
  // Quick "+ Add row": the Churn grid, and the Convert Bookings grid (Convert has no New Booking
  // entry form — rows are added inline and filled in the grid). Multifamily Bookings uses the form.
  const canQuickAdd = canAddDelete() && (state.tab === 'churn' || (state.tab === 'bookings' && isConvert()));
  $('#addRowBtn').style.display = canQuickAdd ? '' : 'none';
  $('#addRowBtn').textContent = '+ Add row';
  // Sections: grid for Bookings/Churn, the entry form for New Booking, neither on Dashboard.
  $('#gridwrap').style.display = isGrid ? '' : 'none';
  $('#entryView').hidden = !isEntry;
  $('#salesView').hidden = !isSales;
  $('#billingView').hidden = !isBillingTab;
  $('#sfreconView').hidden = !isSfrecon;
  $('#legacyView').hidden = !isLegacy;
  $('#saasView').hidden = !isSaas;
  // View tools: filters where there's a summary; columns/zoom only where a grid shows.
  const isConvertDash = isConvert() && state.tab === 'dashboard'; // Convert dashboard has no Multiple-Filters system
  $('#toggleFilters').style.display = (isEntry || isSales || isBillingTab || isSfrecon || isLegacy || isSaas || isConvertDash) ? 'none' : '';
  $('#toggleFilters').textContent = state.filtersHidden ? 'Multiple Filters' : 'Hide Multiple Filters';
  $('#quickFilter').style.display = isGrid ? '' : 'none'; // quick search on Bookings/Churn only
  $('#zoomGroup').style.display = (isGrid || isSales) ? '' : 'none';
  $('#colBtn').style.display = isGrid ? '' : 'none';
  $('#colMenu').hidden = true;
  if (isEntry && !$('#propertyBlocks').children.length) resetEntryView();
  if (isSales) renderSalesSupport();
  if (isBillingTab) renderBillingDashboard();
  if (isSfrecon) renderSfRecon();
  if (isLegacy) renderLegacy();
  if (isSaas) renderSaas();
  if (isGrid) renderQuickFilter();
  renderHead(); renderSummary(); renderBody();
  applyColHide();
  applyColWidths();
  if (isSales) ssApplyFreeze();
  applyGridFreeze();
}

function updateRowInState(table, updated) {
  const arr = state.rows[table];
  const idx = arr.findIndex((r) => r.id === updated.id);
  if (idx >= 0) arr[idx] = updated; else arr.push(updated);
}

// Refresh just the computed cells of one <tr> from a server row.
function refreshComputedCells(tr, row) {
  const { computed } = fieldsForTab();
  for (const f of computed) {
    const td = tr.querySelector(`[data-comp="${f.key}"]`);
    if (!td) continue;
    const raw = row[f.key];
    const isNeg = typeof raw === 'number' && raw < 0;
    td.className = 'computed' + (isNeg ? ' neg' : '');
    td.textContent = MONEY.has(f.key) ? fmtMoney(raw) : (f.type === 'number' ? fmtNum(raw) : (raw ?? ''));
  }
}

// "Add row below" carries the source row's identifying context (so the new blank row stays
// visible under the current filter). Transaction fields (MRR / dates / product) are left blank.
const ADD_BELOW_CTX = {
  bookings: ['booking_month', 'booking_year', 'centralized', 'sales_rep', 'property_id', 'property_name', 'pmc', 'buying_center'],
  churn: ['property_id', 'sage_id', 'pmc_buying_center', 'property'],
};

// ---------- Events ----------
function wireGrid() {
  const tbody = $('#tbody');
  tbody.addEventListener('change', async (e) => {
    const ctl = e.target.closest('[data-key]');
    if (!ctl) return;
    const tr = ctl.closest('tr');
    const id = Number(tr.dataset.id);
    const key = ctl.dataset.key;
    // The manual-override cells (AR / Booking Clawback-Correction) show a formatted $ value; parse
    // it back (handles $, commas, and (parentheses) as negative) so negatives round-trip cleanly.
    const rawVal = (key === 'ar_override' || BOOKING_OVERRIDE_KEYS.has(key)) ? parseMoney(ctl.value) : ctl.value;
    try {
      let updated = await api(`/api/${state.tab}/${id}`, {
        method: 'PATCH', body: JSON.stringify({ [key]: rawVal }),
      });
      // Leaving License Transfer? Clear any stale Offset Amount so it can't linger unused.
      if (key === 'ctam_type' && ctl.value.trim() !== 'License Transfer' && updated.offset_amount != null) {
        updated = await api(`/api/${state.tab}/${id}`, {
          method: 'PATCH', body: JSON.stringify({ offset_amount: '' }),
        });
      }
      updateRowInState(state.tab, updated);
      // Sage ID is per-property: the server fills the property's other blank orders — reload the
      // bookings so the grid reflects it everywhere.
      if (state.tab === 'bookings' && key === 'sage_id') state.rows.bookings = await api('/api/bookings');
      // Changing CTAM Type flips whether the Offset cell is editable; changing a churn's Last
      // Date Under Contract re-stamps the read-only Date Added. On churn, MRR / Last Date also
      // drive the admin-editable AR Final Invoice Amt cell (an input, not a data-comp cell, so
      // refreshComputedCells can't update it) — rebuild the row so its placeholder recomputes.
      // Tagging a booking Clawback/Correction flips its three computed cells to manual inputs (and
      // back); editing an override changes the stored value the computed cell now reflects.
      const bookingAdjChange = state.tab === 'bookings' && (key === 'booking_adjustment' || BOOKING_OVERRIDE_KEYS.has(key));
      if (key === 'ctam_type' || (state.tab === 'churn' && (key === 'last_date_under_contract' || key === 'ar_override' || key === 'mrr'))
        || (state.tab === 'bookings' && key === 'sage_id') || bookingAdjChange) {
        renderBody(); // Sage ID may have propagated to the property's other orders
      } else {
        refreshComputedCells(tr, updated);
      }
      if (state.tab === 'bookings' || state.tab === 'churn') { renderSummary(); renderBookingTotals(currentRows(state.tab)); }
      // Editing a watched date (GoLive / Last Date Under Contract) raises a Billing alert.
      if ((key === 'golive_date' || key === 'last_date_under_contract' || key === 'mrr') && (isAdmin() || role() === 'billing')) {
        state.notifications = await api('/api/notifications');
        updateBell();
      }
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });

  // Insert a freshly created row right after the source row so it appears "below" it.
  const insertRowAfter = (afterId, row, table) => {
    const arr = state.rows[table];
    const idx = arr.findIndex((r) => r.id === afterId);
    if (idx >= 0) arr.splice(idx + 1, 0, row); else arr.push(row);
  };
  const afterCreate = (id, row, table) => {
    insertRowAfter(id, row, table);
    renderBody(); renderSummary(); renderBookingTotals(currentRows(table));
    $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
  };

  // Close any open row-action menu when clicking elsewhere.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-more')) tbody.querySelectorAll('.row-more-menu').forEach((m) => { m.hidden = true; });
  });

  tbody.addEventListener('click', async (e) => {
    // ⚠ Offset Amount hint — open the Offset Review scoped to this booking.
    const offHint = e.target.closest('[data-offset-hint]');
    if (offHint) { openOffsetReview(offHint.dataset.offsetHint); return; }
    // Toggle the ▾ "more actions" menu.
    const moreBtn = e.target.closest('.row-more-btn');
    if (moreBtn) {
      const menu = moreBtn.nextElementSibling;
      const open = menu && menu.hidden;
      tbody.querySelectorAll('.row-more-menu').forEach((m) => { m.hidden = true; });
      if (menu) menu.hidden = !open;
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const id = Number(del.dataset.del);
      const r = state.rows[state.tab].find((x) => x.id === id);
      const name = state.tab === 'bookings'
        ? (r && (r.property_name || r.property_id) || 'this booking')
        : (r && r.property || 'this row');
      if (!confirm(`⚠  Delete ${name}?\n\nThis permanently removes the row and cannot be undone.`)) return;
      try {
        await api(`/api/${state.tab}/${id}`, { method: 'DELETE' });
        state.rows[state.tab] = state.rows[state.tab].filter((r) => r.id !== id);
        renderBody(); renderSummary();
        renderBookingTotals(currentRows(state.tab));
        $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
        toast('Row deleted');
      } catch (err) { toast(err.message, true); }
      return;
    }
    // Add a blank line below, carrying the row's identifying context (so it stays visible
    // under the current filter); Bookings & Churn, admin only.
    const add = e.target.closest('[data-add-below]');
    if (add) {
      const table = state.tab;
      const cur = state.rows[table].find((r) => r.id === Number(add.dataset.addBelow));
      const ctx = {};
      (ADD_BELOW_CTX[table] || []).forEach((k) => { if (cur && cur[k] != null && cur[k] !== '') ctx[k] = cur[k]; });
      try {
        const row = await api(`/api/${table}`, { method: 'POST', body: JSON.stringify(ctx) });
        afterCreate(cur.id, row, table);
        toast('Row added');
      } catch (err) { toast(err.message, true); }
      return;
    }
    // Duplicate this row (copy all editable fields); Bookings & Churn, admin only.
    const dup = e.target.closest('[data-dup]');
    if (dup) {
      const table = state.tab;
      const cur = state.rows[table].find((r) => r.id === Number(dup.dataset.dup));
      if (!cur) return;
      const payload = {};
      // Don't carry a manual AR override to the copy — it should recompute from its own MRR /
      // Last Date (otherwise a changed MRR wouldn't update the AR Final Invoice Amt).
      state.schema[table].editable.forEach((fld) => {
        if (fld.key !== 'ar_override' && cur[fld.key] != null) payload[fld.key] = cur[fld.key];
      });
      try {
        const row = await api(`/api/${table}`, { method: 'POST', body: JSON.stringify(payload) });
        afterCreate(cur.id, row, table);
        toast('Row duplicated');
      } catch (err) { toast(err.message, true); }
    }
  });
}

const TAB_LABELS = {
  dashboard: 'Dashboard', billing: 'Billing Dashboard', salessupport: 'Sales Support',
  newbooking: 'New Booking', bookings: 'Bookings', churn: 'Churn Tracker',
  sfrecon: 'Salesforce Recon Data', legacy: 'Legacy', saas: 'SaaS Financials',
};

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarBackdrop').hidden = true;
}

function wireSidebar() {
  $('#menuBtn').onclick = () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#sidebarBackdrop').hidden = !open;
  };
  $('#sidebarBackdrop').onclick = closeSidebar;
}

function wireTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      state.tab = t.dataset.tab;
      closeSidebar();
      renderAll();
    };
  });
}

function wireActions() {
  // Revenue Desk instance switcher (Multifamily / Convert).
  $('#instanceSwitcher').onchange = (e) => { setInstance(e.target.value); };
  // "More PERQs" dropdown holding the file actions.
  $('#moreBtn').onclick = () => { $('#moreMenu').hidden = !$('#moreMenu').hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) $('#moreMenu').hidden = true; });

  // Quick blank-row add — only used on the Churn grid (Bookings uses the New Booking tab).
  $('#addRowBtn').onclick = async () => {
    if (!canAddDelete()) return;
    // Convert Bookings: add a blank booking (defaulting Category to MRR) to fill in inline.
    if (state.tab === 'bookings' && isConvert()) {
      try {
        const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify({ category: 'MRR' }) });
        state.rows.bookings.push(row);
        renderBody(); renderSummary();
        $('#scroller').scrollTop = $('#scroller').scrollHeight;
        toast('Row added');
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (state.tab !== 'churn') return;
    try {
      const row = await api('/api/churn', { method: 'POST', body: JSON.stringify({}) });
      state.rows.churn.push(row);
      renderBody(); renderSummary();
      $('#scroller').scrollTop = $('#scroller').scrollHeight;
      toast('Row added');
    } catch (err) { toast(err.message, true); }
  };

  $('#importFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Importing replaces ALL current data in both tabs. Continue?')) { e.target.value = ''; return; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Importing…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/import', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed');
      const data = await res.json();
      await loadAll();
      toast(`Imported ${data.imported.bookings} bookings, ${data.imported.churn} churn rows`);
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Convert instance: import the EDIT tab into Convert bookings (replaces all Convert bookings).
  $('#convertImportFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Import the EDIT tab? This REPLACES all current Convert bookings.')) { e.target.value = ''; return; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Importing EDIT tab…');
      const headers = { 'x-instance': state.instance || 'multifamily', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) };
      const res = await fetch('/api/bookings/import-edit', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed');
      const data = await res.json();
      state.rows.bookings = await api('/api/bookings');
      renderAll();
      toast(`Imported ${data.imported} bookings from ${data.customers} customers`);
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Import prior-period bookings (old single-sheet format, e.g. April 2026) — appends.
  $('#priorBookingsFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Importing prior bookings…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/bookings/import-prior', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed');
      const data = await res.json();
      state.rows.bookings = await api('/api/bookings');
      renderAll();
      showResult('Prior bookings imported',
        '<ul class="result-list">'
        + `<li><strong>${data.added}</strong> booking(s) added (MRR = Month 1; Contract &amp; Booked Term = 12)</li>`
        + `<li><strong>${data.skipped}</strong> skipped (already in Bookings)</li>`
        + `<li><strong>${data.filledIds}</strong> Property ID(s) filled from Salesforce Recon</li>`
        + `<li class="muted">${data.total} row(s) in the file</li>`
        + '</ul>');
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Append churn rows from an uploaded report (duplicates skipped server-side).
  $('#churnUploadFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Uploading…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/churn/upload', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      const data = await res.json();
      state.rows.churn = await api('/api/churn');
      if (isAdmin() || role() === 'billing') state.notifications = await api('/api/notifications');
      renderAll();
      $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
      showResult('Churn upload complete', churnResultHtml(data));
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Upload GoLives report -> set/update booking GoLive dates; notify billing on changes.
  $('#golivesFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Uploading GoLives…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/bookings/golives', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      const data = await res.json();
      state.rows.bookings = await api('/api/bookings');
      if (isAdmin() || role() === 'billing') state.notifications = await api('/api/notifications');
      renderAll();
      showResult('GoLives upload complete', golivesResultHtml(data));
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Export opens a dialog to pick the booking period first.
  $('#exportBtn').onclick = (e) => { e.preventDefault(); $('#moreMenu').hidden = true; openExport(); };
  $('#exportClose').onclick = () => { $('#exportModal').hidden = true; };
  $('#exportModal').addEventListener('click', (e) => { if (e.target.id === 'exportModal') $('#exportModal').hidden = true; });
  $('#exportSheets').onchange = () => { syncExportSheetControls(); updateExportHint(); };
  $('#exportMonth').onchange = updateExportHint;
  $('#exportYear').onchange = updateExportHint;
  $('#exportConfirm').onclick = doExport;

  // Legacy SaaS Financials migration: upload -> dry-run preview -> (admin clicks) commit.
  $('#legacyImportFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0]; if (!file) return;
    state.legacyFile = file;
    const fd = new FormData(); fd.append('file', file);
    try {
      toast('Analyzing workbook…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/legacy/preview', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Preview failed');
      showResult('Legacy migration — preview (nothing saved yet)', legacyPreviewHtml(await res.json()));
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };
  // Remove all migrated legacy rows (undo a migration). Never touches real data.
  $('#legacyClearBtn').onclick = async () => {
    $('#moreMenu').hidden = true;
    if (!confirm('Remove ALL migrated Legacy Data (bookings + churn)?\n\nThis deletes only rows tagged Legacy; your real data is untouched.')) return;
    try {
      const d = await api('/api/legacy/clear', { method: 'POST' });
      state.rows.bookings = await api('/api/bookings');
      state.rows.churn = await api('/api/churn');
      renderAll();
      toast(`Removed ${d.removedBookings} legacy booking(s) + ${d.removedChurn} churn`);
    } catch (err) { toast(err.message, true); }
  };
  // Commit button lives inside the preview result modal.
  $('#resultBody').addEventListener('click', async (e) => {
    if (e.target.id !== 'legacyCommitBtn' || !state.legacyFile) return;
    if (!confirm('Migrate the previewed rows into the Revenue Desk as Legacy Data?\n\nExisting rows are untouched; only new rows are added.')) return;
    e.target.disabled = true; e.target.textContent = 'Migrating…';
    const fd = new FormData(); fd.append('file', state.legacyFile);
    try {
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/legacy/commit', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Commit failed');
      const d = await res.json();
      state.rows.bookings = await api('/api/bookings');
      state.rows.churn = await api('/api/churn');
      renderAll();
      $('#resultModal').hidden = true;
      toast(`Migrated ${d.added} booking(s) + ${d.churnAdded || 0} churn record(s)`);
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Commit migration'; }
  });
}

// Build the legacy-migration preview report shown in the result modal.
function legacyPreviewHtml(d) {
  const tabRows = Object.entries(d.perTab || {}).map(([name, t]) =>
    `<tr><td>${escapeHtml(name)}</td><td class="num">${t.added ?? 0}</td><td class="num">${t.skipped ?? 0}</td>`
    + `<td class="num">${t.errors ?? 0}</td><td class="muted">${escapeHtml(t.note || '')}</td></tr>`).join('');
  const sample = (d.sample || []).map((s) =>
    `<tr><td>${escapeHtml(s.property || '—')}</td><td>${escapeHtml(s.product || '—')}</td><td>${escapeHtml(s.month)}</td>`
    + `<td class="num">${fmtMoney(s.mrr)}</td><td class="num">${fmtMoney(s.amount)}</td><td>${escapeHtml(s.golive || '—')}</td>`
    + `<td>${s.pilot ? 'Pilot' : ''}</td></tr>`).join('');
  const errs = (d.errors || []).map((er) =>
    `<tr><td>${escapeHtml(er.tab)}</td><td>${escapeHtml(er.property || '—')}</td><td>${escapeHtml(er.reason)}</td></tr>`).join('');
  let html = `<p><strong>${fmtNum(d.toAdd)}</strong> booking(s) to add · <strong>${fmtNum(d.churnToAdd || 0)}</strong> churn record(s) to add (churned properties) · `
    + `<strong>${fmtNum(d.skipped)}</strong> skipped (already in the Desk) · <strong>${fmtNum(d.errorCount)}</strong> couldn't map.</p>`
    + '<p style="color:var(--ink-soft);font-size:12px">Edit + PS tabs only. Pilots (Trials tab) are not migrated — that tab has no bookings, only MRR movement.</p>';
  // Per-quarter Company Total: already in the Revenue Desk vs. what this adds vs. combined — check
  // "Combined" against the workbook's quarter total before committing.
  if (d.quarters && d.quarters.length) {
    const qrows = d.quarters.map((q) => `<tr><td>${escapeHtml(q.label)}</td><td class="num">${fmtMoney(q.existing)}</td>`
      + `<td class="num">${fmtMoney(q.toAdd)}</td><td class="num"><strong>${fmtMoney(q.combined)}</strong></td></tr>`).join('');
    html += '<h3 class="recon-h">Company Total by quarter (check "Combined" vs the workbook)</h3>'
      + '<div class="result-detail"><table class="recon-table"><thead><tr><th>Quarter</th><th class="num">Already in RD</th><th class="num">This migration adds</th><th class="num">Combined</th></tr></thead>'
      + `<tbody>${qrows}</tbody></table></div>`;
  }
  html += ''
    + '<table class="recon-table"><thead><tr><th>Tab</th><th class="num">To add</th><th class="num">Skipped</th><th class="num">Errors</th><th>Note</th></tr></thead>'
    + `<tbody>${tabRows}</tbody></table>`;
  if (sample) {
    html += '<h3 class="recon-h">Sample (first 25 rows to add)</h3>'
      + '<div class="result-detail"><table><thead><tr><th>Property</th><th>Product</th><th>Month</th><th class="num">MRR</th><th class="num">Booking $</th><th>GoLive</th><th></th></tr></thead>'
      + `<tbody>${sample}</tbody></table></div>`;
  }
  if (errs) {
    html += `<h3 class="recon-h">Couldn't map (${d.errorCount})</h3>`
      + '<div class="result-detail"><table><thead><tr><th>Tab</th><th>Property</th><th>Reason</th></tr></thead>'
      + `<tbody>${errs}</tbody></table></div>`;
  }
  if (d.toAdd > 0) {
    html += `<div style="margin-top:14px;text-align:right"><button type="button" class="btn solid" id="legacyCommitBtn">Commit migration (${fmtNum(d.toAdd)} rows)</button></div>`;
  }
  return html;
}

// Populate the export dialog's Month/Year options from the bookings and show it.
function openExport() {
  const rows = state.rows.bookings;
  const monthVals = ['All', ...MONTHS.filter((m) => rows.some((r) => r.booking_month === m))];
  const yearVals = ['All', ...[...new Set(rows.map((r) => r.booking_year).filter((v) => v != null && v !== ''))].sort((a, b) => a - b)];
  $('#exportMonth').innerHTML = monthVals.map((m) => `<option>${m}</option>`).join('');
  $('#exportYear').innerHTML = yearVals.map((y) => `<option>${y}</option>`).join('');
  // Default Year to the CURRENT year (not "All") so picking a month exports that month of this year
  // — not every year's copy of that month (which would sweep in legacy/historical bookings).
  const curYear = String(new Date().getFullYear());
  $('#exportYear').value = yearVals.map(String).includes(curYear) ? curYear : 'All';
  // Default the Sheets choice to the tab you're on (Churn Tracker only when on the Churn tab).
  $('#exportSheets').value = state.tab === 'churn' ? 'churn' : 'both';
  syncExportSheetControls();
  updateExportHint();
  $('#exportModal').hidden = false;
}
// Describe the period being exported, and warn on the foot-gun combo Month=specific + Year=All
// (which sweeps in every year's copy of that month, including historical / legacy bookings).
function updateExportHint() {
  const el = $('#exportPeriodHint'); if (!el) return;
  if ($('#exportSheets').value === 'churn') { el.textContent = ''; el.className = 'export-hint'; return; }
  const m = $('#exportMonth').value; const y = $('#exportYear').value;
  if (m !== 'All' && y === 'All') {
    el.className = 'export-hint warn';
    el.textContent = `⚠ Year is “All”, so this exports ${m} of EVERY year (including historical/legacy bookings). Pick a Year to limit it.`;
  } else {
    el.className = 'export-hint';
    const scope = (m === 'All' && y === 'All') ? 'all bookings, all periods'
      : `${m === 'All' ? 'all months' : m}${y === 'All' ? ', all years' : ` ${y}`}`;
    el.textContent = `Exporting: ${scope}.`;
  }
}
// The Booking period filters only apply when Bookings are being exported — disable them for
// a Churn-only export.
function syncExportSheetControls() {
  const churnOnly = $('#exportSheets').value === 'churn';
  $('#exportMonth').disabled = churnOnly;
  $('#exportYear').disabled = churnOnly;
}

async function doExport() {
  const sheets = $('#exportSheets').value;
  const month = $('#exportMonth').value;
  const year = $('#exportYear').value;
  const scope = $('#exportScope').value;
  const params = new URLSearchParams();
  if (sheets && sheets !== 'both') params.set('sheets', sheets);
  if (sheets !== 'churn' && month && month !== 'All') params.set('month', month);
  if (sheets !== 'churn' && year && year !== 'All') params.set('year', year);
  if (scope === 'commission') params.set('scope', 'commission');
  try {
    const headers = { 'x-instance': state.instance || 'multifamily', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) };
    const res = await fetch(`/api/export?${params.toString()}`, { headers });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const prefix = sheets === 'churn' ? 'Churn_Tracker' : (sheets === 'bookings' ? 'Bookings' : 'Export');
    const label = ([sheets !== 'churn' && month !== 'All' ? month : '', sheets !== 'churn' && year !== 'All' ? year : ''].filter(Boolean).join('_')
      || new Date().toISOString().slice(0, 10)) + (scope === 'commission' ? '_Commission' : '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `PERQ_Revenue_Desk_${prefix}_${label}.xlsx`.replace(/\s+/g, '_');
    a.click();
    URL.revokeObjectURL(a.href);
    $('#exportModal').hidden = true;
  } catch (err) { toast(err.message, true); }
}

// ---------- New Booking section (shared details + one row per product) ----------
// Common booking details, entered once. Each product line below becomes its own booking.
const SHARED_KEYS = [
  'booking_month', 'booking_year',
  'centralized', 'sales_rep', 'property_id', 'pmc', 'property_only', 'property_name', 'buying_center',
  'pilot_or_ctam', 'pilot_type', 'ctam_type', 'rerate_paid_months', 'rerate_old_mrr', 'mql',
  'contract_term', 'booked_term', 'free_months', 'date_signed',
];
// Per-product fields. Offset Amount only applies (and only shows) on License Transfers.
const PRODUCT_KEYS = ['product', 'mrr', 'one_time_fee', 'offset_amount'];

// Booking Month/Year default to the current month, then "stick" to the last value used.
let entryDefaults = { booking_month: MONTHS[new Date().getMonth()], booking_year: String(new Date().getFullYear()) };

// Fields a booking can't be submitted without (marked with * and enforced on submit).
const REQUIRED_ENTRY_KEYS = new Set(['sales_rep', 'contract_term', 'booked_term', 'date_signed']);
// Re-rate-only fields: shown in the New Booking form only when CTAM Type = Re-rate (hidden and
// blanked otherwise), and required when shown. They feed the Re-rate math in compute.js.
const RERATE_KEYS = ['rerate_paid_months', 'rerate_old_mrr'];

function entryFieldHtml(f) {
  let control;
  if (f.type === 'select') {
    let opts = f.options.map((o) => `<option value="${escapeAttr(o)}">${o || '—'}</option>`).join('');
    // Sales Rep starts blank (and is required) — prepend a blank, selected option.
    if (f.key === 'sales_rep' && !f.options.includes('')) opts = '<option value="" selected>—</option>' + opts;
    control = `<select data-key="${f.key}">${opts}</select>`;
  } else {
    const inputType = f.type === 'date' ? 'date' : (f.type === 'number' ? 'number' : 'text');
    const step = f.type === 'number' ? ' step="any"' : '';
    // PMC - Property is auto-combined from PMC + Property Name, so it's read-only.
    const ro = f.key === 'property_name' ? ' readonly title="Auto-combined from PMC + Property Name"' : '';
    control = `<input type="${inputType}"${step}${ro} data-key="${f.key}" />`;
  }
  // Offset (License Transfer) and the Re-rate fields start hidden — shown by CTAM Type.
  const hidden = (f.key === 'offset_amount' || RERATE_KEYS.includes(f.key)) ? ' hidden' : '';
  const req = (REQUIRED_ENTRY_KEYS.has(f.key) || RERATE_KEYS.includes(f.key)) ? ' <span class="req">*</span>' : '';
  return `<div class="entry-field" data-field="${f.key}"${hidden}><label>${f.label}${req}</label>${control}</div>`;
}

function fieldDef(key) { return state.schema.bookings.editable.find((f) => f.key === key); }

// A property block = its own Booking details + Products. Multiple can be entered at once.
function propertyBlockHtml() {
  const shared = SHARED_KEYS.map(fieldDef).filter(Boolean).map(entryFieldHtml).join('');
  return '<div class="property-block" data-block>'
    + '<div class="entry-card-form"><div class="entry-card-head"><span class="entry-card-title">Booking details</span>'
    + '<button type="button" class="entry-remove property-remove" title="Remove this property">✕</button></div>'
    + `<div class="entry-form shared-fields" data-shared>${shared}</div></div>`
    + '<div class="entry-card-form"><div class="entry-card-head"><span class="entry-card-title">Products</span>'
    + '<label class="dup-from-label">Duplicate from <select class="dup-from" data-dupfrom>'
    + '<option value="">— another property —</option></select></label></div>'
    + `<div class="product-lines" data-products>${productLineHtml()}</div>`
    + '<button type="button" class="btn ghost entry-add add-product">+ Add another product</button></div>'
    + '</div>';
}

// Read / write the Booking-details (shared) fields of one block.
function readShared(block) {
  const out = {};
  block.querySelectorAll('[data-shared] [data-key]').forEach((ctl) => { out[ctl.dataset.key] = ctl.value; });
  return out;
}
function fillShared(block, values) {
  for (const [k, v] of Object.entries(values || {})) {
    const ctl = block.querySelector(`[data-shared] [data-key="${k}"]`);
    if (ctl && v != null && v !== '') ctl.value = v;
  }
}

// Pilot Type applies only to Pilots and CTAM Type only to CTAMs — grey out and blank the
// field that doesn't apply, based on the Pilot or CTAM choice.
function setSharedSelect(sel, enabled) {
  if (!sel) return;
  if (enabled) { sel.disabled = false; if (sel.selectedIndex < 0) sel.selectedIndex = 0; }
  else { sel.selectedIndex = -1; sel.disabled = true; } // blank (value '') + greyed
}
function updatePilotCtam(block) {
  const poc = block.querySelector('[data-shared] [data-key="pilot_or_ctam"]');
  if (!poc) return;
  const v = poc.value.trim();
  setSharedSelect(block.querySelector('[data-shared] [data-key="pilot_type"]'), v === 'Pilot');
  setSharedSelect(block.querySelector('[data-shared] [data-key="ctam_type"]'), v === 'CTAM');
  setProductOffsets(block); // CTAM Type may have changed → refresh product Offset visibility
  setRerateFields(block);   // …and the Re-rate-only fields
}

// Combine PMC + Property Name into "PMC - Property Name" (either alone if the other is blank).
function combinePmcProperty(pmc, prop) {
  const a = String(pmc || '').trim();
  const b = String(prop || '').trim();
  return (a && b) ? `${a} - ${b}` : (b || a || '');
}
// Recompute a block's read-only "PMC - Property" field from its PMC + Property Name.
function recomputeCombinedName(block) {
  const pmc = block.querySelector('[data-shared] [data-key="pmc"]');
  const prop = block.querySelector('[data-shared] [data-key="property_only"]');
  const combined = block.querySelector('[data-shared] [data-key="property_name"]');
  if (combined) combined.value = combinePmcProperty(pmc && pmc.value, prop && prop.value);
}

// Auto-fill Property Name + PMC (+ Sales Rep) for THIS block from the Salesforce Recon master
// when the entered Property ID matches a Property ID 18 Digit there. Returns true if applied.
function autofillFromSfRecon(block) {
  const pidCtl = block.querySelector('[data-shared] [data-key="property_id"]');
  if (!pidCtl) return false;
  const pid = String(pidCtl.value || '').trim().toLowerCase();
  if (!pid) return false;
  const match = (state.rows.salesforce_recon || []).find(
    (r) => String(r.property_id_18 || '').trim().toLowerCase() === pid);
  if (!match) return false;
  const onlyCtl = block.querySelector('[data-shared] [data-key="property_only"]');
  const pmcCtl = block.querySelector('[data-shared] [data-key="pmc"]');
  const repCtl = block.querySelector('[data-shared] [data-key="sales_rep"]');
  if (onlyCtl) onlyCtl.value = match.property_name || ''; // recon Property: Name = just the name
  if (pmcCtl) pmcCtl.value = match.account_name || '';
  recomputeCombinedName(block); // build the combined "PMC - Property"
  if (repCtl && match.account_owner) {
    if (![...repCtl.options].some((o) => o.value === match.account_owner)) {
      repCtl.add(new Option(match.account_owner, match.account_owner)); // ensure it's selectable
    }
    repCtl.value = match.account_owner;
  }
  return true;
}

function productLineHtml() {
  const fields = PRODUCT_KEYS.map(fieldDef).filter(Boolean).map(entryFieldHtml).join('');
  return `<div class="product-line" data-product>${fields}` +
    `<button type="button" class="entry-remove" title="Remove this product">✕</button></div>`;
}

// Offset Amount shows on a block's product lines only when that block's CTAM Type is License Transfer.
// Old MRR / Paid Months fields, shown by CTAM Type:
//  • Re-rate   → Paid Months + Old MRR (both drive the Re-rate math).
//  • Downgrade → Old MRR only (Paid Months is auto-computed from the property's existing GoLive).
//  • anything else → hidden + blanked.
function setRerateFields(block) {
  const ctam = block.querySelector('[data-shared] [data-key="ctam_type"]');
  const v = ctam ? ctam.value.trim() : '';
  const showByKey = {
    rerate_paid_months: v === 'Re-rate',
    rerate_old_mrr: v === 'Re-rate' || v === 'Downgrade',
  };
  for (const key of RERATE_KEYS) {
    const field = block.querySelector(`[data-shared] [data-field="${key}"]`);
    if (!field) continue;
    const show = !!showByKey[key];
    field.hidden = !show;
    if (!show) { const inp = field.querySelector('[data-key]'); if (inp) inp.value = ''; }
  }
}

function setProductOffsets(block) {
  const ctam = block.querySelector('[data-shared] [data-key="ctam_type"]');
  const isLT = !!ctam && ctam.value.trim() === 'License Transfer';
  block.querySelectorAll('[data-products] [data-product]').forEach((line) => {
    const field = line.querySelector('[data-field="offset_amount"]');
    if (!field) return;
    field.hidden = !isLT;
    if (!isLT) { const inp = field.querySelector('[data-key]'); if (inp) inp.value = ''; }
  });
}

function renumberProducts(block) {
  const lines = [...block.querySelectorAll('[data-products] [data-product]')];
  const showRemove = lines.length > 1;
  lines.forEach((l) => { l.querySelector('.entry-remove').style.visibility = showRemove ? '' : 'hidden'; });
}
function addProductLine(block) {
  const tmp = document.createElement('div');
  tmp.innerHTML = productLineHtml();
  block.querySelector('[data-products]').appendChild(tmp.firstElementChild);
  setProductOffsets(block);
  renumberProducts(block);
}
// Copy the product lines (Product / MRR / One-Time Fee / Offset) from one block into another.
function mirrorProducts(src, dest) {
  const destProducts = dest.querySelector('[data-products]');
  destProducts.innerHTML = '';
  for (const line of src.querySelectorAll('[data-products] [data-product]')) {
    const tmp = document.createElement('div');
    tmp.innerHTML = productLineHtml();
    const newLine = tmp.firstElementChild;
    line.querySelectorAll('[data-key]').forEach((ctl) => {
      const target = newLine.querySelector(`[data-key="${ctl.dataset.key}"]`);
      if (target) target.value = ctl.value;
    });
    destProducts.appendChild(newLine);
  }
  setProductOffsets(dest);
  renumberProducts(dest);
}

// Show the "remove property" ✕ only when there's more than one property block.
function renumberProperties() {
  const blocks = [...$('#propertyBlocks').querySelectorAll('[data-block]')];
  const show = blocks.length > 1;
  blocks.forEach((b) => { const x = b.querySelector('.property-remove'); if (x) x.style.visibility = show ? '' : 'hidden'; });
  refreshDupFroms();
}

// A readable label for a property block in the "Duplicate from" dropdown.
function blockLabel(block, idx) {
  const name = String(block.querySelector('[data-shared] [data-key="property_only"]')?.value || '').trim()
    || String(block.querySelector('[data-shared] [data-key="property_id"]')?.value || '').trim();
  return name ? `Property ${idx + 1} — ${name}` : `Property ${idx + 1}`;
}
// Rebuild every block's "Duplicate from" dropdown to list the OTHER property blocks (by stable
// id), preserving any current selection. Called whenever blocks or property names change.
function refreshDupFroms() {
  const blocks = [...$('#propertyBlocks').querySelectorAll('[data-block]')];
  blocks.forEach((block) => {
    const sel = block.querySelector('[data-dupfrom]');
    if (!sel) return;
    const label = sel.closest('.dup-from-label');
    if (label) label.hidden = blocks.length <= 1; // nothing to copy from when alone
    const cur = sel.value;
    let opts = '<option value="">— another property —</option>';
    blocks.forEach((other, j) => {
      if (other !== block) opts += `<option value="${other.dataset.blockId}">${escapeHtml(blockLabel(other, j))}</option>`;
    });
    sel.innerHTML = opts;
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  });
}

// Add a property block. With `copyFrom`, carry over its Booking details EXCEPT the property
// identity (Property ID + Name), which the user fills in fresh; otherwise seed from defaults.
let blockSeq = 0;
function addPropertyBlock(copyFrom) {
  const tmp = document.createElement('div');
  tmp.innerHTML = propertyBlockHtml();
  const block = tmp.firstElementChild;
  block.dataset.blockId = String(++blockSeq); // stable id for "Duplicate from" references
  $('#propertyBlocks').appendChild(block);
  if (copyFrom) {
    const vals = readShared(copyFrom);
    delete vals.property_id; delete vals.property_name; delete vals.property_only; // new property's own identity
    fillShared(block, vals);
    recomputeCombinedName(block); // reflect the (kept) PMC with the now-blank property name
  } else {
    fillShared(block, entryDefaults);
  }
  updatePilotCtam(block);
  setProductOffsets(block);
  renumberProducts(block);
  renumberProperties();
  return block;
}

// Reset to a single empty property block (on open and after submit).
function resetEntryView() {
  $('#propertyBlocks').innerHTML = '';
  addPropertyBlock(null);
}

async function submitEntries() {
  const blocks = [...$('#propertyBlocks').querySelectorAll('[data-block]')];
  const payloads = [];
  // One booking per product line, each carrying its property block's Booking details.
  for (const block of blocks) {
    const shared = readShared(block);
    if (!String(shared.property_name || '').trim() && !String(shared.property_id || '').trim()) {
      toast('Enter the property details for every property.', true);
      return;
    }
    // Required fields: Contract Term, Booked Term, Date Signed.
    for (const key of REQUIRED_ENTRY_KEYS) {
      if (!String(shared[key] ?? '').trim()) {
        const f = fieldDef(key);
        toast(`${f ? f.label : key} is required.`, true);
        const ctl = block.querySelector(`[data-shared] [data-key="${key}"]`);
        if (ctl) ctl.focus();
        return;
      }
    }
    // Required extra fields by CTAM Type: Re-rate needs Paid Months + Old MRR; Downgrade needs
    // Old MRR (its paid months come from the property's existing GoLive automatically).
    const ctamSel = String(shared.ctam_type || '').trim();
    const requiredExtra = ctamSel === 'Re-rate' ? RERATE_KEYS : (ctamSel === 'Downgrade' ? ['rerate_old_mrr'] : []);
    for (const key of requiredExtra) {
      if (!String(shared[key] ?? '').trim()) {
        const f = fieldDef(key);
        toast(`${f ? f.label : key} is required for a ${ctamSel}.`, true);
        const ctl = block.querySelector(`[data-shared] [data-key="${key}"]`);
        if (ctl) ctl.focus();
        return;
      }
    }
    block.querySelectorAll('[data-products] [data-product]').forEach((line) => {
      const p = { ...shared };
      line.querySelectorAll('[data-key]').forEach((ctl) => {
        const field = ctl.closest('.entry-field');
        if (field && field.hidden) return; // skip hidden Offset on non-License-Transfers
        p[ctl.dataset.key] = ctl.value;
      });
      payloads.push(p);
    });
  }
  if (!payloads.length) { toast('Add at least one product.', true); return; }
  // Preview the computed values, then ask for confirmation before creating anything.
  try {
    await api('/api/bookings/preview', { method: 'POST', body: JSON.stringify({ rows: payloads }) });
    state.pendingBookings = payloads;
    state.pendingOffsets = payloads.map(() => []); // each line: array of {churnId, amount}
    $('#confirmModal').hidden = false;
    await renderConfirm();
  } catch (err) { toast(err.message, true); }
}

// A churn's offset quarter = the quarter its full revenue drop is recognized (Final Churn
// Month, i.e. the month AFTER Last Date Under Contract). E.g. last date 06/30 -> drops in
// July -> Q3, not Q2.
function churnQuarterInfo(c) {
  const m = String(c.final_churn_month || '').trim();
  if (!m || m === '-') return null;
  return monthYearQuarter(m); // { q, year, label }
}
const qCmp = (a, b) => (a.year - b.year) * 4 + (a.q - b.q); // >0 a is later, 0 same, <0 earlier
// Offsettable churns grouped by PMC (lowercased), built ONCE per churn dataset and cached.
// Without this, offsetEligibleChurns rescanned every churn row per booking — O(bookings × churn),
// which lagged badly on selection/filtering after the migration bulked up the tables.
let _churnByPmc = null;
let _churnByPmcSrc = null;
function churnByPmcIndex() {
  if (_churnByPmcSrc === state.rows.churn && _churnByPmc) return _churnByPmc;
  const idx = new Map();
  for (const c of (state.rows.churn || [])) {
    // Auto-derived Downgrade lines (id "dg-…") ARE offsettable — the server materializes them into a
    // real churn row on apply. Their id is preserved through expandOffsetPieces for that.
    if (String(c.classification || '') === 'Contraction') continue;
    const q = churnQuarterInfo(c);
    if (!q) continue;
    const p = String(c.pmc_buying_center || '').trim().toLowerCase();
    if (!p) continue;
    if (!idx.has(p)) idx.set(p, []);
    idx.get(p).push({ churn: c, quarter: q });
  }
  _churnByPmc = idx; _churnByPmcSrc = state.rows.churn;
  return idx;
}
// Churns that can offset a booking in quarter bq: same OR future quarter (never past),
// each annotated with its quarter and whether it's a future-quarter churn.
function offsetEligibleChurns(pmc, bq) {
  if (!pmc || !bq) return [];
  const list = churnByPmcIndex().get(String(pmc).trim().toLowerCase());
  if (!list) return [];
  return list
    .filter((e) => qCmp(e.quarter, bq) >= 0)
    .map((e) => ({ churn: e.churn, quarter: e.quarter, isFuture: qCmp(e.quarter, bq) > 0 }))
    .sort((a, b) => (a.isFuture - b.isFuture) || qCmp(a.quarter, b.quarter));
}
const churnDropAmt = (c) => Math.abs(Number(c && c.mrr) || 0); // monthly MRR that dropped
// A churn record's recognized drop split by month: the prorated remainder (final-invoice month)
// and the full drop (the month after). Used to show a churning property's per-month breakdown.
function churnMonthlyPieces(c) {
  const out = [];
  const pm = String(c.prorated_churn_month || '').trim();
  const pa = Math.abs(Number(c.prorated_churn_amount) || 0);
  if (pm && pm !== '-' && pa > 0.005) out.push({ month: pm, amt: pa });
  const fm = String(c.final_churn_month || '').trim();
  const fa = Math.abs(Number(c.final_churn_amount) || 0);
  if (fm && fm !== '-' && fa > 0.005) out.push({ month: fm, amt: fa });
  return out;
}
// Group a booking's eligible churns by the CHURNING property (entries stay current-quarter-first,
// as offsetEligibleChurns already sorts them). One offset option per churning property.
function groupEligibleByProperty(eligible) {
  const g = new Map();
  for (const e of eligible) {
    const key = String(e.churn.property || e.churn.pmc_buying_center || `#${e.churn.id}`).trim().toLowerCase();
    if (!g.has(key)) g.set(key, { key, name: e.churn.property || e.churn.pmc_buying_center || 'churn', entries: [] });
    g.get(key).entries.push(e);
  }
  return [...g.values()];
}
// Total offsettable drop for a churning-property group.
function groupDropTotal(entries) { return entries.reduce((s, e) => s + churnDropAmt(e.churn), 0); }
// A per-month breakdown label for a property group, e.g. "July 2026 $921.29, August 2026 $30.71".
function groupBreakdown(entries) {
  const monthMap = new Map();
  for (const e of entries) for (const pc of churnMonthlyPieces(e.churn)) monthMap.set(pc.month, (monthMap.get(pc.month) || 0) + pc.amt);
  return [...monthMap.entries()]
    .sort((a, b) => (monthIdxFromMonthYear(a[0]) || 0) - (monthIdxFromMonthYear(b[0]) || 0))
    .map(([mo, amt]) => `${mo} ${fmtMoney(amt)}`).join(', ');
}
// Expand an offset amount over a property group's churns, consuming EARLIEST MONTH FIRST across all
// records -> [{churnId, amount}] for the apply endpoint (so the current month is exhausted first).
function expandOffsetPieces(entries, amount) {
  const pieces = [];
  // churnId kept raw: a real numeric id, or a "dg-<bookingId>" placeholder the server materializes.
  for (const e of entries) for (const pc of churnMonthlyPieces(e.churn)) pieces.push({ churnId: e.churn.id, monthIdx: monthIdxFromMonthYear(pc.month) || 0, amt: pc.amt });
  pieces.sort((a, b) => a.monthIdx - b.monthIdx);
  let left = Number(amount) || 0;
  const per = new Map();
  for (const p of pieces) { if (left <= 0.005) break; const use = Math.min(left, p.amt); if (use > 0.005) { per.set(p.churnId, (per.get(p.churnId) || 0) + use); left -= use; } }
  return [...per.entries()].map(([churnId, amt]) => ({ churnId, amount: Math.round(amt * 100) / 100 }));
}

// ---- Confirm-dialog offset helpers (a line can use several churning properties to cover its MRR) ----
function pendingLineEligible(i) {
  const p = state.pendingBookings[i];
  const q = monthYearQuarter(`${p.booking_month || ''} ${p.booking_year || ''}`);
  return offsetEligibleChurns(p.pmc, q);
}
// Churning properties already chosen on OTHER lines (a property offsets only one booking line).
function pendingUsedElsewhere(i) {
  const set = new Set();
  (state.pendingOffsets || []).forEach((arr, j) => {
    if (j !== i && Array.isArray(arr)) arr.forEach((o) => set.add(String(o.propKey)));
  });
  return set;
}
// Total available drop for a churning-property option on line i.
function propDropForLine(i, propKey) {
  const g = groupEligibleByProperty(pendingLineEligible(i)).find((x) => x.key === String(propKey));
  return g ? groupDropTotal(g.entries) : 0;
}
// Suggested amount for a churning property on line i, row r = min(MRR still uncovered, its drop).
function defaultOffsetAmount(i, r, propKey) {
  const mrr = parseMoney(state.pendingBookings[i].mrr) || 0;
  const sels = state.pendingOffsets[i] || [];
  const otherTotal = sels.reduce((a, o, rr) => a + (rr === r ? 0 : (Number(o.amount) || 0)), 0);
  const remaining = Math.max(0, mrr - otherTotal);
  const drop = propDropForLine(i, propKey);
  return Math.min(remaining || drop, drop);
}

// Renders the confirm dialog. Re-runs whenever an offset selection changes so the
// computed Company Total / Commissionable reflect the License Transfer offset.
async function renderConfirm() {
  const base = state.pendingBookings || [];
  const offsets = state.pendingOffsets || [];
  const lineOffs = (i) => (Array.isArray(offsets[i]) ? offsets[i] : []);
  const lineOffTotal = (i) => lineOffs(i).reduce((a, o) => a + (Number(o.amount) || 0), 0);
  // Effective payloads: a line with any offsets becomes a License Transfer whose offset = the
  // sum of the amounts used across all its churns.
  const eff = base.map((p, i) => (lineOffs(i).length
    ? { ...p, pilot_or_ctam: 'CTAM', ctam_type: 'License Transfer', offset_amount: lineOffTotal(i) }
    : p));
  let computed;
  try { ({ rows: computed } = await api('/api/bookings/preview', { method: 'POST', body: JSON.stringify({ rows: eff }) })); }
  catch (err) { toast(err.message, true); return; }

  const m = fmtMoney;
  const sum = (k) => computed.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const propName = (p) => p.property_name || p.property_id || '—';
  const propCount = new Set(base.map(propName)).size;
  const meta = `<strong>${propCount} propert${propCount === 1 ? 'y' : 'ies'}</strong> · ${computed.length} line item${computed.length === 1 ? '' : 's'}`;

  // Summary grouped by property (a subheader row per property, then its product lines).
  let rowsHtml = '';
  let lastProp = null;
  computed.forEach((r, i) => {
    const p = base[i];
    const name = propName(p);
    if (name !== lastProp) {
      const period = `${p.booking_month || ''} ${p.booking_year || ''}`.trim();
      const bits = [escapeHtml(name)];
      if (p.pmc) bits.push(escapeHtml(p.pmc));
      if (period) bits.push(escapeHtml(period));
      rowsHtml += `<tr class="confirm-prop"><td colspan="5">${bits.join(' · ')}</td></tr>`;
      lastProp = name;
    }
    rowsHtml += `<tr><td>${escapeHtml(r.product || '—')}${lineOffs(i).length ? ' <span class="lt-badge">License Transfer</span>' : ''}</td>`
      + `<td class="num">${m(r.mrr)}</td><td class="num">${m(r.company_total_booking)}</td>`
      + `<td class="num">${m(r.commissionable_bookings)}</td><td class="num">${m(r.one_time_fee)}</td></tr>`;
  });
  let html = `<p class="confirm-meta">${meta}</p>`
    + '<table class="confirm-table"><thead><tr><th>Product</th><th class="num">MRR</th>'
    + '<th class="num">Company Total Booking</th><th class="num">Commissionable</th><th class="num">One-Time Fee</th></tr></thead>'
    + `<tbody>${rowsHtml}</tbody>`
    + `<tfoot><tr><th>Total (${computed.length})</th><th class="num">${m(sum('mrr'))}</th>`
    + `<th class="num">${m(sum('company_total_booking'))}</th><th class="num">${m(sum('commissionable_bookings'))}</th>`
    + `<th class="num">${m(sum('one_time_fee'))}</th></tr></tfoot></table>`;

  // Offsets: per line, eligible churns by that line's own PMC + quarter (same or future).
  // A line may use MANY churns to cover its MRR; a churn can only offset one line, so options
  // exclude churns already chosen on this or another line.
  const offLines = base.map((p, i) => {
    const mrr = parseMoney(p.mrr) || 0;
    if (mrr <= 0.005) return ''; // $0 lines have nothing to offset — hide them
    const q = monthYearQuarter(`${p.booking_month || ''} ${p.booking_year || ''}`);
    const groups = groupEligibleByProperty(offsetEligibleChurns(p.pmc, q)); // one option per churning property
    if (!groups.length) return '';
    const sels = lineOffs(i);
    // Churning properties used on OTHER lines (a property offsets only one line).
    const usedByOthers = new Set();
    offsets.forEach((arr, j) => { if (j !== i && Array.isArray(arr)) arr.forEach((o) => usedByOthers.add(String(o.propKey))); });
    const optionFor = (g, selected) => {
      const bd = groupBreakdown(g.entries);
      const allFuture = g.entries.every((e) => e.isFuture);
      return `<option value="${escapeAttr(g.key)}"${selected ? ' selected' : ''}>`
        + `${escapeHtml(g.name)} — ${escapeHtml(m(groupDropTotal(g.entries)))} total${bd ? ` (${escapeHtml(bd)})` : ''}${allFuture ? ' · future' : ''}</option>`;
    };
    const rowsH = sels.map((o, r) => {
      const usedThisLine = new Set(sels.filter((_, rr) => rr !== r).map((x) => String(x.propKey)));
      // Available properties + the one this row already has selected.
      const opts = groups.filter((g) => String(o.propKey) === String(g.key) || (!usedByOthers.has(g.key) && !usedThisLine.has(g.key)));
      const optionHtml = ['<option value="">— choose a churn —</option>',
        ...opts.map((g) => optionFor(g, String(o.propKey) === String(g.key)))].join('');
      return `<div class="offset-row">`
        + `<select class="offset-sel" data-off-sel="${i}:${r}">${optionHtml}</select>`
        + `<label class="offset-amt-l">Offset <input type="text" class="offset-amt" data-off-amt="${i}:${r}" value="${escapeAttr(m(o.amount))}" /></label>`
        + `<button type="button" class="offset-del" data-off-del="${i}:${r}" title="Remove this churn">✕</button></div>`;
    }).join('');

    const total = lineOffTotal(i);
    const remaining = mrr - total;
    const usedAll = new Set([...usedByOthers, ...sels.map((o) => String(o.propKey))]);
    const canAdd = groups.some((g) => !usedAll.has(g.key));
    const addH = canAdd
      ? `<button type="button" class="btn ghost offset-add" data-off-add="${i}">+ ${sels.length ? 'Add another churn' : 'Add churn'} to offset</button>` : '';
    const statusH = sels.length
      ? `<div class="offset-status">Offsetting <strong>${m(total)}</strong> of ${m(mrr)} MRR · ${remaining > 0.005 ? `${m(remaining)} not yet covered` : (remaining < -0.005 ? `<span class="offset-over">over by ${m(-remaining)}</span>` : 'fully covered')}</div>`
      : '';
    const label = `${escapeHtml(propName(p))} · ${escapeHtml(p.product || `Line ${i + 1}`)}`;
    return `<div class="offset-line"><div class="offset-prod">${label}</div>${rowsH}${statusH}${addH}</div>`;
  }).filter(Boolean).join('');
  if (offLines) {
    html += '<div class="offset-box"><div class="offset-title">License Transfer offsets available</div>'
      + offLines
      + '<p class="offset-note">Add one or more churns to cover this line’s MRR. A fully-used churn becomes a Contraction; a partly-used churn is split, with the remainder kept as a separate churn line. Future-quarter churns are flagged.</p></div>';
  }
  $('#confirmSummary').innerHTML = html;
}

// Submit progress bar (the confirm dialog can take a while for many line items).
function setSubmitProgress(done, total, finishing) {
  const pct = total ? Math.round((done / total) * 100) : 100;
  $('#submitProgressBar').style.width = `${pct}%`;
  $('#submitProgressLabel').textContent = finishing ? 'Finishing…' : `Submitting ${done} of ${total} (${pct}%)`;
}
function startSubmitProgress(total) {
  $('#submitProgress').hidden = false;
  setSubmitProgress(0, total);
  $('#confirmSubmit').disabled = true; $('#confirmSubmit').textContent = 'Submitting…';
  $('#confirmCancel').disabled = true;
}
function endSubmitProgress() {
  $('#submitProgress').hidden = true;
  $('#submitProgressBar').style.width = '0%';
  $('#confirmSubmit').disabled = false; $('#confirmSubmit').textContent = 'Confirm & submit';
  $('#confirmCancel').disabled = false;
}

async function confirmBookings() {
  const base = state.pendingBookings || [];
  const offsets = state.pendingOffsets || [];
  if (!base.length) { $('#confirmModal').hidden = true; return; }
  startSubmitProgress(base.length);
  try {
    let added = 0;
    let offsetCount = 0;
    for (let i = 0; i < base.length; i++) {
      // Expand each chosen churning-property row into per-churn offsets, earliest month first.
      const rows = (Array.isArray(offsets[i]) ? offsets[i] : []).filter((o) => o.propKey && (Number(o.amount) || 0) > 0);
      const groups = groupEligibleByProperty(pendingLineEligible(i));
      const merged = new Map();
      for (const row of rows) {
        const g = groups.find((x) => x.key === String(row.propKey));
        if (!g) continue;
        for (const o of expandOffsetPieces(g.entries, row.amount)) merged.set(o.churnId, (merged.get(o.churnId) || 0) + o.amount);
      }
      const offs = [...merged.entries()].map(([churnId, amount]) => ({ churnId, amount: Math.round(amount * 100) / 100 }));
      const total = offs.reduce((a, o) => a + (Number(o.amount) || 0), 0);
      const payload = offs.length
        ? { ...base[i], pilot_or_ctam: 'CTAM', ctam_type: 'License Transfer', offset_amount: total }
        : base[i];
      const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
      if (offs.length) {
        await api('/api/bookings/apply-offset', { method: 'POST', body: JSON.stringify({ bookingId: row.id, offsets: offs }) });
        offsetCount += 1;
      }
      added += 1;
      setSubmitProgress(added, base.length);
    }
    setSubmitProgress(base.length, base.length, true); // reloading the data
    // Reload so the offset bookings, contracted churns, and any auto-created Sales Support
    // rows are reflected everywhere.
    state.rows.bookings = await api('/api/bookings');
    state.rows.churn = await api('/api/churn');
    state.rows.sales_support = await api('/api/sales_support');
    const last = base[base.length - 1];
    if (last.booking_month) entryDefaults.booking_month = last.booking_month;
    if (last.booking_year) entryDefaults.booking_year = last.booking_year;
    state.pendingBookings = []; state.pendingOffsets = [];
    $('#confirmModal').hidden = true;
    $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
    toast(`Added ${added} line item${added === 1 ? '' : 's'}${offsetCount ? `, ${offsetCount} offset` : ''}`);
    resetEntryView();
  } catch (err) { toast(err.message, true); }
  finally { endSubmitProgress(); }
}

// ---------- License Transfer offset review (existing bookings) ----------
// Bookings (not yet offset) that have an eligible churn in the same quarter + PMC.
// Memoized on the bookings + churn dataset refs so repeated renders (every filter/select change
// in the review) don't recompute the whole booking scan.
let _offsetCands = null;
let _offsetCandsSrc = null;
let _offBk = null;
let _offBkSrc = null;
// Force a rebuild of the offset caches (call when opening the review, in case grid edits mutated
// the churn/booking rows in place without swapping the array reference).
function invalidateOffsetCaches() { _offsetCands = null; _offsetCandsSrc = null; _churnByPmc = null; _churnByPmcSrc = null; _offBk = null; _offBkSrc = null; }
// Offsettable bookings (not yet offset, with a valid quarter) grouped by PMC — for the diagnostic.
function offsettableBookingsByPmc() {
  if (_offBkSrc === state.rows.bookings && _offBk) return _offBk;
  const m = new Map();
  for (const b of state.rows.bookings) {
    if (b.offset_churn_id && String(b.ctam_type || '').trim() === 'License Transfer') continue;
    const bq = monthYearQuarter(`${b.booking_month || ''} ${b.booking_year || ''}`);
    if (!bq) continue;
    const p = String(b.pmc || '').trim().toLowerCase();
    if (!p) continue;
    if (!m.has(p)) m.set(p, []);
    m.get(p).push({ booking: b, q: bq });
  }
  _offBk = m; _offBkSrc = state.rows.bookings;
  return m;
}
// Why a churn is / isn't offerable — the exact rule that decides whether it shows in the dropdown.
function churnOfferability(c) {
  const cls = String(c.classification || '');
  if (cls === 'Contraction') return { ok: false, reason: 'Already used to offset (Contraction)' };
  if (cls === 'Churn Credit') return { ok: false, reason: 'Churn Credit line — not offsettable' };
  const q = churnQuarterInfo(c);
  if (!q) return { ok: false, reason: 'No Final Churn Month — needs a Last Date Under Contract + MRR' };
  const p = String(c.pmc_buying_center || '').trim().toLowerCase();
  if (!p) return { ok: false, reason: 'Churn has no PMC' };
  const bs = offsettableBookingsByPmc().get(p);
  if (!bs || !bs.length) return { ok: false, reason: `No open booking under PMC “${c.pmc_buying_center || ''}” to offset` };
  const match = bs.filter((x) => qCmp(q, x.q) >= 0); // churn same/future vs booking
  if (!match.length) return { ok: false, reason: `This PMC’s open bookings are all in a LATER quarter than this churn (${q.label})` };
  return { ok: true, reason: `Offerable — ${match.length} booking${match.length === 1 ? '' : 's'} in ${q.label} or earlier` };
}
// Toggle + (when open) the search bar and results container for the eligibility diagnostic.
function offsetDiagHtml() {
  const btn = `<button type="button" class="view-btn" id="offsetDiagToggle">${state.offsetDiag ? 'Hide' : 'Show'} churn eligibility diagnostic</button>`;
  if (!state.offsetDiag) return `<div class="offset-diag-toggle">${btn}</div>`;
  return `<div class="offset-diag-toggle">${btn}</div>`
    + '<div class="offset-diag"><div class="offset-diag-bar">'
    + `<label>Search churn <input type="text" id="offsetDiagSearch" placeholder="property or PMC…" value="${escapeAttr(state.offsetDiagQ || '')}" autocomplete="off" /></label></div>`
    + '<div id="offsetDiagResults"></div></div>';
}
// Fill the diagnostic results (updated on its own so the search box keeps focus).
function renderOffsetDiagResults() {
  const el = document.getElementById('offsetDiagResults');
  if (!el) return;
  const qstr = String(state.offsetDiagQ || '').trim().toLowerCase();
  if (!qstr) { el.innerHTML = '<p class="muted" style="padding:8px">Type a property or PMC above to see why its churn is or isn’t offerable.</p>'; return; }
  const matches = (state.rows.churn || []).filter((c) => `${c.property || ''} ${c.pmc_buying_center || ''} ${c.product || ''} ${c.property_id || ''}`.toLowerCase().includes(qstr));
  if (!matches.length) { el.innerHTML = `<p class="muted" style="padding:8px">No churn matches “${escapeHtml(state.offsetDiagQ)}”.</p>`; return; }
  const body = matches.slice(0, 200).map((c) => {
    const o = churnOfferability(c);
    return `<tr class="${o.ok ? 'diag-ok' : 'diag-no'}">`
      + `<td>${escapeHtml(c.property || c.property_id || '—')}</td>`
      + `<td>${escapeHtml(c.pmc_buying_center || '—')}</td>`
      + `<td>${escapeHtml(c.product || '—')}</td>`
      + `<td class="num">${fmtMoney(churnDropAmt(c))}</td>`
      + `<td>${escapeHtml(String(c.final_churn_month || '').trim() || '—')}</td>`
      + `<td>${o.ok ? '✓ ' : '⚠ '}${escapeHtml(o.reason)}</td></tr>`;
  }).join('');
  el.innerHTML = '<table class="recon-table"><thead><tr><th>Property</th><th>PMC</th><th>Product</th><th class="num">Drop</th><th>Final Churn Month</th><th>Status</th></tr></thead>'
    + `<tbody>${body}</tbody></table>${matches.length > 200 ? `<p class="muted" style="padding:6px">Showing first 200 of ${matches.length}.</p>` : ''}`;
}
function offsetCandidates() {
  if (_offsetCandsSrc && _offsetCandsSrc.b === state.rows.bookings && _offsetCandsSrc.c === state.rows.churn) return _offsetCands;
  const out = [];
  for (const b of state.rows.bookings) {
    // Already offset = still linked to a churn AND still a License Transfer. If the offset was
    // reverted (CTAM Type changed back), a stale link no longer counts — the booking is available.
    if (b.offset_churn_id && String(b.ctam_type || '').trim() === 'License Transfer') continue;
    const bq = monthYearQuarter(`${b.booking_month || ''} ${b.booking_year || ''}`);
    if (!bq) continue;
    const eligible = offsetEligibleChurns(b.pmc, bq);
    if (eligible.length) out.push({ booking: b, eligible });
  }
  _offsetCands = out; _offsetCandsSrc = { b: state.rows.bookings, c: state.rows.churn };
  return out;
}
// Candidate lookup by booking id (for the grid's Offset Amount ⚠ hint). Rebuilt whenever the
// candidate list is (it returns a fresh array each time its data refs change).
let _offsetCandMap = null;
let _offsetCandMapSrc = null;
function offsetCandForBooking(bookingId) {
  const list = offsetCandidates();
  if (_offsetCandMapSrc !== list) { _offsetCandMap = new Map(list.map((c) => [String(c.booking.id), c])); _offsetCandMapSrc = list; }
  return _offsetCandMap.get(String(bookingId)) || null;
}
// A booking shows the ⚠ hint when it has an eligible churn to offset AND real MRR (matches exactly
// the set the Offset Review lists — see renderOffsetReview's MRR > 0 filter).
function bookingHasOffsetHint(row) {
  return (parseMoney(row && row.mrr) || 0) > 0.005 && !!offsetCandForBooking(row.id);
}
function renderOffsetReview() {
  const m = fmtMoney;
  // Only bookings with real MRR need offsetting — hide $0 lines (e.g. $0 secondary products).
  let all = offsetCandidates().filter((c) => (parseMoney(c.booking.mrr) || 0) > 0.005);
  // Scoped to a single booking (opened from the grid's Offset Amount ⚠ hint).
  const only = state.offsetOnly;
  if (only != null) all = all.filter((c) => String(c.booking.id) === String(only));
  if (!all.length) {
    $('#offsetBody').innerHTML = `<p class="muted" style="padding:10px">${only != null
      ? 'This booking no longer has a matching churn (same PMC, this or a future quarter) available to offset.'
      : 'No bookings currently have a matching churn (same PMC, this or a future quarter) available to offset.'}</p>`
      + offsetUndoHtml() + offsetDiagHtml();
    if (state.offsetDiag) renderOffsetDiagResults();
    return;
  }
  // Filter by PMC (options = PMCs that actually have offsettable bookings).
  const pmcs = [...new Set(all.map((c) => String(c.booking.pmc || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.offsetPmc !== 'All' && !pmcs.includes(state.offsetPmc)) state.offsetPmc = 'All';
  let cands = state.offsetPmc === 'All' ? all : all.filter((c) => String(c.booking.pmc || '').trim() === state.offsetPmc);
  // Filter by Property — cascades within the selected PMC (options reflect the PMC-filtered set).
  const propOf = (c) => String(c.booking.property_name || c.booking.property_id || '').trim();
  const props = [...new Set(cands.map(propOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.offsetProp !== 'All' && !props.includes(state.offsetProp)) state.offsetProp = 'All';
  if (state.offsetProp !== 'All') cands = cands.filter((c) => propOf(c) === state.offsetProp);
  // When scoped to one booking, skip the PMC/Property filters (there's only one row) and show a
  // "back to the full review" link instead.
  const filterHtml = only != null
    ? '<div class="offset-filter offset-filter-only"><button type="button" class="view-btn" id="offsetShowAll">← Show all offsettable bookings</button></div>'
    : '<div class="offset-filter">'
      + `<label>Filter by PMC <select data-offset-pmc>${['All', ...pmcs].map((p) => `<option${p === state.offsetPmc ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select></label>`
      + `<label>Filter by Property <select data-offset-prop>${['All', ...props].map((p) => `<option${p === state.offsetProp ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select></label>`
      + '</div>';
  // Pending (un-applied) selections. A booking can offset with SEVERAL churning properties, so
  // sel[bookingId] is an ARRAY of { propKey, amount }. A churning property's drop is shared by
  // amount across bookings; within one booking a property is chosen at most once.
  const sel = state.offsetSel || (state.offsetSel = {});
  const selArr = (bid) => (Array.isArray(sel[bid]) ? sel[bid] : []);
  // Drop of a churning property already consumed by OTHER bookings' selections (by amount).
  const consumedByOtherBookings = (propKey, exceptBid) => {
    let s = 0;
    for (const bid of Object.keys(sel)) {
      if (bid === String(exceptBid)) continue;
      for (const o of selArr(bid)) if (String(o.propKey) === String(propKey)) s += Number(o.amount) || 0;
    }
    return s;
  };
  const rows = cands.map(({ booking: b, eligible }) => {
    const hasSame = eligible.some((e) => !e.isFuture);
    const lineMrr = parseMoney(b.mrr) || 0;
    const groups = groupEligibleByProperty(eligible);
    const sels = selArr(b.id);
    // Drop of a group still available to THIS booking = gross − other bookings' amounts.
    const availFor = (g) => groupDropTotal(g.entries) - consumedByOtherBookings(g.key, b.id);
    const optionFor = (g, selected) => {
      const avail = availFor(g);
      const bd = groupBreakdown(g.entries);
      const allFuture = g.entries.every((e) => e.isFuture);
      return `<option value="${escapeAttr(g.key)}" data-remaining="${avail}"${selected ? ' selected' : ''}>`
        + `${escapeHtml(g.name)} — ${escapeHtml(m(avail))} available${bd ? ` (${escapeHtml(bd)})` : ''}${allFuture ? ' · future' : ''}</option>`;
    };
    // Always show at least one selection row (a placeholder dropdown when nothing chosen yet).
    const displayRows = sels.length ? sels : [{ propKey: '', amount: 0 }];
    const rowsH = displayRows.map((o, r) => {
      const picked = !!o.propKey;
      const usedOtherRows = new Set(sels.filter((_, rr) => rr !== r).map((x) => String(x.propKey)));
      const opts = groups.filter((g) => String(o.propKey) === String(g.key) || (!usedOtherRows.has(g.key) && availFor(g) > 0.005));
      const optionHtml = ['<option value="">— choose a churn —</option>', ...opts.map((g) => optionFor(g, String(o.propKey) === String(g.key)))].join('');
      const delH = sels.length ? `<button type="button" class="offset-del" data-or-del="${b.id}:${r}" title="Remove this churn">✕</button>` : '';
      return '<div class="offset-row">'
        + `<select class="offset-sel" data-or-sel="${b.id}:${r}">${optionHtml}</select>`
        + `<label class="offset-amt-l">Offset <input type="text" class="offset-amt" data-or-amt="${b.id}:${r}" value="${picked ? escapeAttr(m(Number(o.amount) || 0)) : ''}"${picked ? '' : ' disabled'} /></label>`
        + delH + '</div>';
    }).join('');
    const total = sels.reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const remainingMrr = lineMrr - total;
    const usedThis = new Set(sels.map((o) => String(o.propKey)));
    const canAdd = sels.length && groups.some((g) => !usedThis.has(g.key) && availFor(g) > 0.005);
    const addH = canAdd ? `<button type="button" class="btn ghost offset-add" data-or-add="${b.id}">+ Add another churn</button>` : '';
    const statusH = sels.length
      ? `<div class="offset-status">Offsetting <strong>${m(total)}</strong> of ${m(lineMrr)} MRR · ${remainingMrr > 0.005 ? `${m(remainingMrr)} not yet covered` : (remainingMrr < -0.005 ? `<span class="offset-over">over by ${m(-remainingMrr)}</span>` : 'fully covered')}</div>`
      : '';
    const period = `${b.booking_month || ''} ${b.booking_year || ''}`.trim();
    const futureNote = hasSame ? ''
      : '<div class="offset-future-note">⚠ No churn this quarter for this PMC — the option(s) are future-quarter churns.</div>';
    const propFull = b.property_name || b.property_id || '—';
    return `<tr data-booking="${b.id}">
      <td class="offset-prop" title="${escapeAttr(propFull)}"><div class="offset-prop-name">${escapeHtml(propFull)}</div><div class="muted-sm">${escapeHtml(b.pmc || '')} · ${escapeHtml(period)}</div>${futureNote}</td>
      <td class="offset-prod" title="${escapeAttr(b.product || '')}">${escapeHtml(b.product || '—')}</td>
      <td class="num">${m(b.mrr)}</td>
      <td class="offset-churn-cell">${rowsH}${addH}${statusH}</td>
      <td><button type="button" class="btn solid offset-apply" data-apply-offset${total > 0.005 ? '' : ' disabled'}>Apply</button></td>
    </tr>`;
  }).join('');
  $('#offsetBody').innerHTML = filterHtml + '<table class="recon-table offset-table offset-table-multi">'
    + '<colgroup><col class="c-prop"><col class="c-prod"><col class="c-mrr"><col class="c-churn"><col class="c-apply"></colgroup>'
    + '<thead><tr>'
    + '<th>Booking property</th><th>Product</th><th class="num">MRR</th><th>Offset with churn</th><th></th>'
    + `</tr></thead><tbody>${rows}</tbody></table>`
    + offsetUndoHtml() + offsetDiagHtml();
  if (state.offsetDiag) renderOffsetDiagResults();
}
// Drop of a churning property consumed by OTHER bookings' pending selections (by amount).
function orConsumedByOtherBookings(propKey, exceptBid) {
  const sel = state.offsetSel || {};
  let s = 0;
  for (const bid of Object.keys(sel)) {
    if (bid === String(exceptBid)) continue;
    for (const o of (Array.isArray(sel[bid]) ? sel[bid] : [])) if (String(o.propKey) === String(propKey)) s += Number(o.amount) || 0;
  }
  return s;
}
// Suggested amount for a churn newly chosen on a booking's row: min(the booking's MRR not yet
// covered by its other rows, the property's drop still available after other bookings).
function orDefaultAmount(bid, rowIndex, propKey) {
  const b = state.rows.bookings.find((x) => String(x.id) === String(bid));
  const mrr = parseMoney(b && b.mrr) || 0;
  const sels = Array.isArray(state.offsetSel[bid]) ? state.offsetSel[bid] : [];
  const otherTotal = sels.reduce((a, o, rr) => a + (rr === rowIndex ? 0 : (Number(o.amount) || 0)), 0);
  const remainingMrr = Math.max(0, mrr - otherTotal);
  const cand = offsetCandidates().find((c) => String(c.booking.id) === String(bid));
  const g = cand && groupEligibleByProperty(cand.eligible).find((x) => x.key === String(propKey));
  const avail = g ? Math.max(0, groupDropTotal(g.entries) - orConsumedByOtherBookings(g.key, bid)) : 0;
  return Math.round(Math.min(remainingMrr || avail, avail) * 100) / 100;
}
// The Undo panel: recent applied offsets, newest first, each with an Undo button.
function offsetUndoHtml() {
  const txns = state.offsetTxns || [];
  if (!txns.length) return '';
  const rowsH = txns.map((t) => {
    const when = t.created_at ? new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    return `<div class="offset-undo-row"><span class="offset-undo-label" title="${escapeAttr(t.label || '')}">${escapeHtml(t.label || `Offset #${t.id}`)}</span>`
      + `<span class="offset-undo-when">${escapeHtml(when)}${t.created_by ? ` · ${escapeHtml(t.created_by)}` : ''}</span>`
      + `<button type="button" class="btn ghost offset-undo-btn" data-undo-offset="${t.id}">Undo</button></div>`;
  }).join('');
  return `<div class="offset-undo"><div class="offset-undo-title">Recent offsets — Undo</div>${rowsH}`
    + '<p class="offset-note">Undo removes the split / Churn Credit rows the offset created and restores the churn(s) and booking to their state before it was applied. If you applied several, undo the most recent first.</p></div>';
}
// Drop pending offset selections that are no longer valid (booking already offset, or the chosen
// churn is no longer eligible — e.g. it became a Contraction or was split after an Apply).
function pruneOffsetSel() {
  const sel = state.offsetSel || {};
  const byBooking = new Map(offsetCandidates().map((c) => [String(c.booking.id), c]));
  for (const bid of Object.keys(sel)) {
    const cand = byBooking.get(bid);
    if (!cand) { delete sel[bid]; continue; }
    const keys = new Set(groupEligibleByProperty(cand.eligible).map((g) => g.key));
    const arr = (Array.isArray(sel[bid]) ? sel[bid] : []).filter((o) => keys.has(String(o.propKey)));
    if (arr.length) sel[bid] = arr; else delete sel[bid];
  }
}
// Open the Offset Review modal. Pass a bookingId to scope it to a single booking (from the grid's
// Offset Amount ⚠ hint); omit it for the full review. Same list, same logic either way.
async function openOffsetReview(bookingId) {
  $('#moreMenu').hidden = true;
  state.offsetSel = {}; state.offsetPmc = 'All'; state.offsetProp = 'All';
  state.offsetOnly = bookingId != null ? String(bookingId) : null;
  invalidateOffsetCaches();
  $('#offsetModal').hidden = false;
  renderOffsetReview();
  try { state.offsetTxns = await api('/api/offset-txns'); renderOffsetReview(); } catch { /* undo panel is best-effort */ }
}
function wireOffsetReview() {
  $('#offsetReviewBtn').onclick = () => openOffsetReview();
  $('#offsetClose').onclick = () => { $('#offsetModal').hidden = true; };
  $('#offsetModal').addEventListener('click', (e) => { if (e.target.id === 'offsetModal') $('#offsetModal').hidden = true; });
  // Diagnostic search — updates just the results (keeps the input focused as you type).
  $('#offsetBody').addEventListener('input', (e) => {
    if (e.target.id === 'offsetDiagSearch') { state.offsetDiagQ = e.target.value; renderOffsetDiagResults(); }
  });
  // "bid:r" -> [bookingId (string), rowIndex (number)]
  const orKey = (s) => { const [b, r] = String(s || '').split(':'); return [b, Number(r)]; };
  $('#offsetBody').addEventListener('change', (e) => {
    const pmcSel = e.target.closest('[data-offset-pmc]');
    if (pmcSel) { state.offsetPmc = pmcSel.value; state.offsetProp = 'All'; renderOffsetReview(); return; }
    const propSel = e.target.closest('[data-offset-prop]');
    if (propSel) { state.offsetProp = propSel.value; renderOffsetReview(); return; }
    const sel = state.offsetSel || (state.offsetSel = {});
    const orSel = e.target.closest('[data-or-sel]');
    if (orSel) {
      const [bid, r] = orKey(orSel.dataset.orSel);
      const arr = sel[bid] || (sel[bid] = []);
      const propKey = orSel.value;
      if (!propKey) { arr.splice(r, 1); if (!arr.length) delete sel[bid]; renderOffsetReview(); return; }
      arr[r] = { propKey, amount: orDefaultAmount(bid, r, propKey) };
      renderOffsetReview();
      return;
    }
    const orAmt = e.target.closest('[data-or-amt]');
    if (orAmt) {
      const [bid, r] = orKey(orAmt.dataset.orAmt);
      const arr = sel[bid];
      if (arr && arr[r]) { arr[r].amount = parseMoney(orAmt.value); renderOffsetReview(); }
    }
  });
  $('#offsetBody').addEventListener('click', async (e) => {
    // Toggle the churn-eligibility diagnostic.
    if (e.target.closest('#offsetDiagToggle')) { state.offsetDiag = !state.offsetDiag; renderOffsetReview(); return; }
    // Leave single-booking scope and show the full review.
    if (e.target.closest('#offsetShowAll')) { openOffsetReview(); return; }
    // Undo a previously applied offset.
    const undoBtn = e.target.closest('[data-undo-offset]');
    if (undoBtn) {
      if (undoBtn.disabled) return;
      if (!confirm('Undo this offset? It restores the churn(s) and booking to before the offset and removes the rows it created.')) return;
      undoBtn.disabled = true;
      undoBtn.innerHTML = '<span class="btn-spinner"></span>Undoing…';
      try {
        await api('/api/bookings/undo-offset', { method: 'POST', body: JSON.stringify({ txnId: Number(undoBtn.dataset.undoOffset) }) });
        state.rows.bookings = await api('/api/bookings');
        state.rows.churn = await api('/api/churn');
        state.offsetTxns = await api('/api/offset-txns');
        pruneOffsetSel();
        renderOffsetReview();
        renderAll();
        toast('Offset undone');
      } catch (err) { undoBtn.disabled = false; undoBtn.textContent = 'Undo'; toast(err.message, true); }
      return;
    }
    // Add another churn to a booking's offset (first still-available churning property).
    const orAdd = e.target.closest('[data-or-add]');
    if (orAdd) {
      const bid = orAdd.dataset.orAdd;
      const arr = state.offsetSel[bid] || (state.offsetSel[bid] = []);
      const cand = offsetCandidates().find((c) => String(c.booking.id) === String(bid));
      if (cand) {
        const usedThis = new Set(arr.map((o) => String(o.propKey)));
        const next = groupEligibleByProperty(cand.eligible).find((g) => !usedThis.has(g.key)
          && (groupDropTotal(g.entries) - orConsumedByOtherBookings(g.key, bid)) > 0.005);
        if (next) { const r = arr.length; arr.push({ propKey: next.key, amount: orDefaultAmount(bid, r, next.key) }); renderOffsetReview(); }
      }
      return;
    }
    // Remove one churn from a booking's offset.
    const orDel = e.target.closest('[data-or-del]');
    if (orDel) {
      const [bid, r] = orKey(orDel.dataset.orDel);
      if (Array.isArray(state.offsetSel[bid])) { state.offsetSel[bid].splice(r, 1); if (!state.offsetSel[bid].length) delete state.offsetSel[bid]; renderOffsetReview(); }
      return;
    }
    const btn = e.target.closest('[data-apply-offset]');
    if (!btn || btn.disabled) return;
    const bid = btn.closest('[data-booking]').dataset.booking;
    const sel = state.offsetSel || {};
    const arr = (Array.isArray(sel[bid]) ? sel[bid] : []).filter((o) => o.propKey && (Number(o.amount) || 0) > 0);
    if (!arr.length) { toast('Choose a churn to offset with.', true); return; }
    // Merge EVERY selected churning property into per-churn offsets. Each property expands EARLIEST
    // MONTH FIRST across its own churns; a churn shared across selections accumulates its amount.
    const cand = offsetCandidates().find((c) => String(c.booking.id) === String(bid));
    const groups = cand ? groupEligibleByProperty(cand.eligible) : [];
    const merged = new Map();
    for (const row of arr) {
      const group = groups.find((g) => g.key === String(row.propKey));
      if (!group) continue;
      for (const o of expandOffsetPieces(group.entries, row.amount)) merged.set(o.churnId, (merged.get(o.churnId) || 0) + o.amount);
    }
    const offsets = [...merged.entries()].map(([churnId, amount]) => ({ churnId, amount: Math.round(amount * 100) / 100 }));
    if (!offsets.length) { toast('That churn is no longer available — reselect.', true); return; }
    // Show a spinner on the button while the offset applies + data reloads.
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span>Applying…';
    try {
      await api('/api/bookings/apply-offset', { method: 'POST', body: JSON.stringify({ bookingId: Number(bid), offsets }) });
      delete sel[bid];
      state.rows.bookings = await api('/api/bookings');
      state.rows.churn = await api('/api/churn');
      try { state.offsetTxns = await api('/api/offset-txns'); } catch { /* undo panel best-effort */ }
      pruneOffsetSel(); // clear selections invalidated by the split/contraction
      renderOffsetReview(); // rebuilds the table (and the button) from fresh data
      renderAll();
      toast('Offset applied');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Apply';
      toast(err.message, true);
    }
  });
}

function wireEntry() {
  $('#addPropertyBtn').onclick = () => {
    const blocks = [...$('#propertyBlocks').querySelectorAll('[data-block]')];
    const last = blocks[blocks.length - 1] || null;
    addPropertyBlock(last); // carries the Booking details; products are copied via "Duplicate from"
  };
  $('#submitEntriesBtn').onclick = submitEntries;
  // Confirm dialog: Confirm creates the rows; Cancel returns to the entry form unchanged.
  $('#confirmSubmit').onclick = confirmBookings;
  $('#confirmCancel').onclick = () => { $('#confirmModal').hidden = true; };
  $('#confirmClose').onclick = () => { $('#confirmModal').hidden = true; };
  $('#confirmModal').addEventListener('click', (e) => { if (e.target.id === 'confirmModal') $('#confirmModal').hidden = true; });
  // Offset controls inside the confirm dialog (re-renders to show updated computed values).
  const parseIR = (s) => String(s || '').split(':').map(Number); // "i:r" -> [i, r]
  $('#confirmSummary').addEventListener('change', (e) => {
    const selEl = e.target.closest('[data-off-sel]');
    if (selEl) {
      const [i, r] = parseIR(selEl.dataset.offSel);
      const sels = state.pendingOffsets[i];
      if (sels && sels[r]) {
        sels[r].propKey = selEl.value;
        sels[r].amount = selEl.value ? defaultOffsetAmount(i, r, selEl.value) : 0;
        renderConfirm();
      }
      return;
    }
    const amtEl = e.target.closest('[data-off-amt]');
    if (amtEl) {
      const [i, r] = parseIR(amtEl.dataset.offAmt);
      const sels = state.pendingOffsets[i];
      if (sels && sels[r]) { sels[r].amount = parseMoney(amtEl.value); renderConfirm(); }
    }
  });
  // Add / remove churns on an offset line.
  $('#confirmSummary').addEventListener('click', (e) => {
    const addEl = e.target.closest('[data-off-add]');
    if (addEl) {
      const i = Number(addEl.dataset.offAdd);
      const sels = state.pendingOffsets[i] || (state.pendingOffsets[i] = []);
      const usedElse = pendingUsedElsewhere(i);
      const usedThis = new Set(sels.map((o) => String(o.propKey)));
      const next = groupEligibleByProperty(pendingLineEligible(i)).find((g) =>
        !usedElse.has(g.key) && !usedThis.has(g.key));
      if (next) {
        const r = sels.length;
        sels.push({ propKey: next.key, amount: defaultOffsetAmount(i, r, next.key) });
        renderConfirm();
      }
      return;
    }
    const delEl = e.target.closest('[data-off-del]');
    if (delEl) {
      const [i, r] = parseIR(delEl.dataset.offDel);
      if (Array.isArray(state.pendingOffsets[i])) { state.pendingOffsets[i].splice(r, 1); renderConfirm(); }
    }
  });
  // All property blocks share one delegated set of handlers (blocks are added/removed dynamically).
  const blocks = $('#propertyBlocks');
  // Booking-details changes (scoped to the block they happened in).
  blocks.addEventListener('change', (e) => {
    const block = e.target.closest('[data-block]');
    if (!block) return;
    // "Duplicate from": copy the chosen property's products + MRR into this block.
    if (e.target.matches('[data-dupfrom]')) {
      const src = e.target.value
        && $('#propertyBlocks').querySelector(`[data-block][data-block-id="${e.target.value}"]`);
      if (src) { mirrorProducts(src, block); toast('Products copied'); }
      e.target.value = ''; // reset to placeholder so it can be used again
      return;
    }
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    if (key === 'ctam_type') { setProductOffsets(block); setRerateFields(block); }
    if (key === 'pilot_or_ctam') updatePilotCtam(block);
    if (key === 'pmc' || key === 'property_only') recomputeCombinedName(block); // rebuild "PMC - Property"
    if (key === 'property_only' || key === 'property_id') refreshDupFroms(); // keep dropdown labels fresh
    if (key === 'property_id' && autofillFromSfRecon(block)) toast('Property Name & PMC filled from Salesforce Recon');
  });
  // Live-update the combined name (and recon autofill) as PMC / Property Name / Property ID are typed.
  blocks.addEventListener('input', (e) => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const block = e.target.closest('[data-block]');
    if (!block) return;
    if (key === 'pmc' || key === 'property_only') recomputeCombinedName(block);
    if (key === 'property_only' || key === 'property_id') refreshDupFroms(); // keep dropdown labels fresh
    if (key === 'property_id') autofillFromSfRecon(block);
  });
  blocks.addEventListener('click', (e) => {
    const block = e.target.closest('[data-block]');
    if (!block) return;
    if (e.target.closest('.add-product')) { addProductLine(block); return; }
    // Remove this property (keep at least one).
    if (e.target.closest('.property-remove')) {
      if ($('#propertyBlocks').querySelectorAll('[data-block]').length <= 1) return;
      block.remove();
      renumberProperties();
      return;
    }
    // Remove a product line within the block (keep at least one).
    if (e.target.closest('.entry-remove')) {
      if (block.querySelectorAll('[data-products] [data-product]').length <= 1) return;
      const line = e.target.closest('[data-product]');
      if (line) { line.remove(); renumberProducts(block); }
    }
  });
}

// ---------- Sales Support (quarterly forecast vs actuals) ----------
const QUARTER_MONTHS = {
  1: ['January', 'February', 'March'], 2: ['April', 'May', 'June'],
  3: ['July', 'August', 'September'], 4: ['October', 'November', 'December'],
};
// Stored slots: q2_target = quarter target; apr/may/jun_target = month 1/2/3 targets.
// Computed (frontend-only): m1/m2/m3_actual + q_actual.
const SS_COMPUTED = new Set(['m1_actual', 'm2_actual', 'm3_actual', 'q_actual']);
const SS_MONEY = new Set(['q2_target', 'apr_target', 'may_target', 'jun_target',
  'm1_actual', 'm2_actual', 'm3_actual', 'q_actual', 'worst', 'accurate', 'best']);

function viewedPeriodObj() { return state.salesPeriods.find((p) => p.period === state.salesPeriod) || null; }
function ssEditable() { const p = viewedPeriodObj(); return !!p && p.status === 'open' && canEditSalesSupport(); }

// Columns for the viewed quarter: [key, label]. Labels reflect the quarter's months/year.
function ssColumns() {
  const p = viewedPeriodObj();
  const q = p ? `Q${p.quarter}` : 'Q';
  const y = p ? p.year : '';
  const m = p ? QUARTER_MONTHS[p.quarter] : ['Month 1', 'Month 2', 'Month 3'];
  const cols = [
    ['product_category', 'Product'], ['section', 'Section'], ['pmc', 'PMC'],
    ['booking_type', 'Booking Type'], ['account_owner', 'Account Owner'],
    ['q2_target', `${q} Target`],
    ['apr_target', `${m[0]} ${y} Target`], ['m1_actual', `${m[0]} ${y} Actual`],
    ['may_target', `${m[1]} ${y} Target`], ['m2_actual', `${m[1]} ${y} Actual`],
    ['jun_target', `${m[2]} ${y} Target`], ['m3_actual', `${m[2]} ${y} Actual`],
    ['q_actual', `${q} Actual`],
    ['worst', 'Worst'], ['accurate', 'Accurate'], ['best', 'Best'], ['notes', 'Notes'],
  ];
  // A tagged salesperson's rows are all their own — the Account Owner column is redundant.
  return isSales() ? cols.filter(([k]) => k !== 'account_owner') : cols;
}
const ssLabels = () => Object.fromEntries(ssColumns());

// Sum of Company Total Booking for matching PMC + product category + month + year.
// The two sections are mutually exclusive so a booking is counted once: a "Pilot / New Logo" row
// counts only Pilot bookings, and a "CTAM" row counts only non-Pilot (CTAM) bookings.
// SEO is selectable as its own "Product" in Sales Support, but its rows still GROUP under
// Digital Advertising (ssMainCategory). For matching actuals, a booking's Sales Support product
// is 'SEO' when the product is SEO, else its BPR category — so an SEO row pulls only SEO bookings
// and the Digital Advertising row pulls the rest.
function ssCategoryOf(b) {
  return String(b.product || '').trim() === 'SEO' ? 'SEO' : String(b.bpr_prod_category || '').trim();
}
const ssMainCategory = (cat) => (String(cat || '').trim() === 'SEO' ? 'Digital Advertising' : String(cat || '').trim());
const ssIsPilot = (b) => String(b.pilot_or_ctam || '').trim() === 'Pilot';
const ssSectionMatch = (row, b) => (String(row.section || '').trim() === 'Pilot / New Logo' ? ssIsPilot(b) : !ssIsPilot(b));
// Reconcile the viewed quarter: bookings whose Company Total isn't captured by any Sales Support
// row (e.g. the booking is missing a PMC or Product, so no row can represent it). Returns the
// quarter's total bookings, the un-tracked total, and the list of those bookings.
function ssReconcileViewed() {
  const p = viewedPeriodObj();
  if (!p) return { bookingsTotal: 0, ssTotal: 0, gap: 0, dupeExtra: 0, list: [], dupes: [] };
  const months = new Set(QUARTER_MONTHS[p.quarter]);
  const rows = state.rows.sales_support.filter((r) => r.period === p.period);
  // The Sales Support rows that PULL a given booking (same PMC + SS category + section). Zero rows
  // = the booking isn't tracked; more than one = it's double-counted in the SS grand total.
  const matchRows = (b) => {
    const bpmc = String(b.pmc || '').trim().toLowerCase();
    const bcat = ssCategoryOf(b);
    if (!bpmc || !bcat) return []; // ssActual can't pull a booking with no PMC/category
    return rows.filter((r) =>
      String(r.pmc || '').trim().toLowerCase() === bpmc
      && String(r.product_category || '').trim() === bcat
      && ssSectionMatch(r, b));
  };
  const booked = state.rows.bookings.filter((b) => months.has(b.booking_month) && reconNum(b.booking_year) === p.year);
  const list = [];   // untracked: no matching SS row (drags the SS total BELOW Bookings)
  const dupes = [];  // matched by >1 SS row (inflates the SS total ABOVE Bookings)
  let bookingsTotal = 0, gap = 0, dupeExtra = 0;
  for (const b of booked) {
    const amt = Number(b.company_total_booking) || 0;
    bookingsTotal += amt;
    const n = matchRows(b).length;
    if (n === 0) { if (amt !== 0) { list.push(b); gap += amt; } }
    else if (n > 1) { dupes.push({ b, count: n }); dupeExtra += amt * (n - 1); }
  }
  // The SS grand total (q_actual across ALL period rows) counts each booking once per matching row:
  // = (bookingsTotal − untracked) + double-counted extra. Matches the SS footer when no SS filter.
  const ssTotal = bookingsTotal - gap + dupeExtra;
  return { bookingsTotal, ssTotal, gap, dupeExtra, list, dupes };
}
// Why a booking isn't represented by any Sales Support row.
function ssUntrackedReason(b) {
  if (!String(b.pmc || '').trim()) return 'Missing PMC';
  if (!ssCategoryOf(b)) return 'Missing Product';
  return 'No matching row yet — click Sync from Bookings';
}
function ssReconcileReportHtml(rec) {
  const p = viewedPeriodObj();
  const diff = rec.ssTotal - rec.bookingsTotal; // SS − Bookings
  // Top summary: the two totals and how the difference decomposes.
  let html = `<p><strong>${p ? escapeHtml(p.period) : ''}</strong> reconciliation:</p>`
    + '<table class="recon-table"><tbody>'
    + `<tr><td>Bookings (Company Total, this quarter)</td><td class="num">${fmtMoney(rec.bookingsTotal)}</td></tr>`
    + `<tr><td>Sales Support grand total (all rows)</td><td class="num">${fmtMoney(rec.ssTotal)}</td></tr>`
    + `<tr class="ss-subtotal-row"><td>Difference (Sales Support − Bookings)</td><td class="num">${fmtMoney(diff)}</td></tr>`
    + `<tr><td>· Not pulled into Sales Support (lowers SS)</td><td class="num">${fmtMoney(-rec.gap)}</td></tr>`
    + `<tr><td>· Double-counted by multiple rows (raises SS)</td><td class="num">${fmtMoney(rec.dupeExtra)}</td></tr>`
    + '</tbody></table>';
  const ff = state.ssFilters || {};
  if (ff.owner !== 'All' || ff.product !== 'All' || ff.section !== 'All') {
    html += '<p class="muted" style="margin-top:6px">Note: the on-screen Grand Total reflects your active Account Owner / Product / Section filters, but this reconciliation uses <strong>all rows</strong> for the quarter.</p>';
  }
  if (Math.abs(diff) < 0.005 && !rec.list.length && !rec.dupes.length) {
    return html + '<p class="muted" style="margin-top:8px">Sales Support matches Bookings exactly for this quarter. 🎉</p>';
  }
  // Untracked bookings (in Bookings, no Sales Support row).
  if (rec.list.length) {
    const body = rec.list.slice()
      .sort((a, b) => (Number(b.company_total_booking) || 0) - (Number(a.company_total_booking) || 0))
      .map((b) => `<tr>
        <td title="${escapeAttr(b.property_id || '')}">${escapeHtml(b.pmc || '—')}</td>
        <td>${escapeHtml(b.property_only || b.property_name || b.property_id || '—')}</td>
        <td>${escapeHtml(b.product || '—')}</td>
        <td>${escapeHtml(b.booking_month || '—')}</td>
        <td class="num">${fmtMoney(b.company_total_booking)}</td>
        <td>${escapeHtml(ssUntrackedReason(b))}</td>
      </tr>`).join('');
    html += `<h3 class="recon-h">Not pulled into Sales Support (${rec.list.length}) — ${fmtMoney(rec.gap)}</h3>`
      + '<table class="recon-table"><thead><tr><th>PMC</th><th>Property</th><th>Product</th><th>Month</th><th class="num">Company Total</th><th>Reason</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
      + '<p class="muted" style="margin-top:6px">Fix the flagged field (PMC / Product) on each booking, then run Sync from Bookings. $0-Company-Total pilots are already tracked (they add $0), so they don’t appear here.</p>';
  }
  // Double-counted bookings (matched by more than one Sales Support row).
  if (rec.dupes.length) {
    const body = rec.dupes.slice()
      .sort((a, b) => (Number(b.b.company_total_booking) || 0) - (Number(a.b.company_total_booking) || 0))
      .map(({ b, count }) => `<tr>
        <td title="${escapeAttr(b.property_id || '')}">${escapeHtml(b.pmc || '—')}</td>
        <td>${escapeHtml(b.property_only || b.property_name || b.property_id || '—')}</td>
        <td>${escapeHtml(b.product || '—')}</td>
        <td>${escapeHtml(b.booking_month || '—')}</td>
        <td class="num">${fmtMoney(b.company_total_booking)}</td>
        <td class="num">${count} rows</td>
      </tr>`).join('');
    html += `<h3 class="recon-h">Double-counted by multiple Sales Support rows (${rec.dupes.length}) — +${fmtMoney(rec.dupeExtra)}</h3>`
      + '<table class="recon-table"><thead><tr><th>PMC</th><th>Property</th><th>Product</th><th>Month</th><th class="num">Company Total</th><th class="num">Matches</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
      + '<p class="muted" style="margin-top:6px">These bookings match more than one Sales Support row (same PMC + Product + Section), so their Company Total is counted once per row. Remove the duplicate Sales Support row(s) so each PMC + Product + Section appears once.</p>';
  }
  return html;
}
function ssActual(row, monthName, year) {
  const pmc = String(row.pmc || '').trim().toLowerCase();
  const cat = String(row.product_category || '').trim();
  if (!pmc || !cat || !monthName) return 0;
  let sum = 0;
  for (const b of state.rows.bookings) {
    if (String(b.pmc || '').trim().toLowerCase() === pmc
      && ssCategoryOf(b) === cat
      && b.booking_month === monthName
      && reconNum(b.booking_year) === year
      && ssSectionMatch(row, b)) {
      sum += Number(b.company_total_booking) || 0;
    }
  }
  return sum;
}
// The individual bookings that make up a Sales Support "Actual" cell (same match as ssActual).
function ssActualBreakdown(row, key) {
  const p = viewedPeriodObj();
  const year = p ? p.year : null;
  const qm = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const monthsForKey = { m1_actual: [qm[0]], m2_actual: [qm[1]], m3_actual: [qm[2]], q_actual: qm };
  const months = new Set((monthsForKey[key] || []).filter(Boolean));
  const pmc = String(row.pmc || '').trim().toLowerCase();
  const cat = String(row.product_category || '').trim();
  if (!pmc || !cat || !months.size) return [];
  return state.rows.bookings.filter((b) =>
    String(b.pmc || '').trim().toLowerCase() === pmc
    && ssCategoryOf(b) === cat
    && months.has(b.booking_month)
    && reconNum(b.booking_year) === year
    && ssSectionMatch(row, b));
}

// Hover-tooltip HTML for an Actual cell: the properties booked + their amounts + the total.
function ssActualTipHtml(row, key) {
  const list = ssActualBreakdown(row, key);
  if (!list.length) return '';
  const total = list.reduce((a, b) => a + (Number(b.company_total_booking) || 0), 0);
  const items = list.map((b) => {
    const isLT = String(b.ctam_type || '').trim() === 'License Transfer' || b.offset_churn_id;
    const adj = isBookingAdjusted(b) ? String(b.booking_adjustment || '').trim() : '';
    const note = String(b.notes || '').trim();
    return `<div class="tip-row"><span class="tip-prop">${escapeHtml(b.property_name || b.property_id || '—')}`
      + `${b.product ? ` <em>${escapeHtml(b.product)}</em>` : ''}`
      + `${isLT ? ' <span class="tip-lt">License Transfer</span>' : ''}`
      + `${adj ? ` <span class="tip-adj">${escapeHtml(adj)}</span>` : ''}</span>`
      + `<span class="tip-amt">${escapeHtml(fmtMoney(b.company_total_booking))}</span></div>`
      + ((isLT || adj) && note ? `<div class="tip-note">${escapeHtml(note)}</div>` : '');
  }).join('');
  const head = `${escapeHtml(row.pmc || '—')} · ${escapeHtml(row.product_category || '')} · ${list.length} booking${list.length === 1 ? '' : 's'}`;
  return `<div class="tip-head">${head}</div>${items}`
    + `<div class="tip-row tip-total"><span>Actual</span><span class="tip-amt">${escapeHtml(fmtMoney(total))}</span></div>`;
}

const ssFieldDef = (key) => state.schema.sales_support.editable.find((f) => f.key === key);

// Freeze the leading columns (through PMC) so they stay visible when scrolling right.
// Offsets are computed from the actual header widths (recomputed on resize).
const SS_FREEZE = ['product_category', 'section', 'pmc'];
const SS_FREEZE_PMC = ['name'];
function ssApplyFreeze() {
  // Start past the sticky row-number column so the frozen columns don't overlap it.
  const rownumTh = $('#ssHead th.rownum');
  let left = rownumTh ? rownumTh.getBoundingClientRect().width / (state.zoom || 1) : 0;
  let css = '';
  for (const key of (state.ssView === 'pmc' ? SS_FREEZE_PMC : SS_FREEZE)) {
    css += `#ssTable td[data-col="${key}"]{position:sticky;left:${left}px;z-index:1;}`;
    css += `#ssTable th[data-col="${key}"]{position:sticky;left:${left}px;top:0;z-index:4;}`;
    const th = $(`#ssHead th[data-col="${key}"]`);
    left += th ? th.getBoundingClientRect().width / (state.zoom || 1) : 0;
  }
  $('#ssFreezeStyle').textContent = css;
}

// PMC options: Salesforce Recon Account Names + existing PMCs (bookings + sales support),
// plus an "add new" choice.
function ssPmcList() {
  // A tagged salesperson only sees PMCs under their Account Owner (server-scoped sfPmcs).
  if (isSales()) {
    return [...new Set(state.sfPmcs.map((n) => String(n).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  const set = new Set();
  // Salesforce Recon Account Names: from the dedicated PMC endpoint (standard users)
  // and directly from the loaded recon rows (admins always have these in memory).
  for (const name of state.sfPmcs) if (name) set.add(String(name).trim());
  for (const r of state.rows.salesforce_recon) if (r.account_name) set.add(String(r.account_name).trim());
  for (const b of state.rows.bookings) if (b.pmc) set.add(String(b.pmc).trim());
  for (const r of state.rows.sales_support) if (r.pmc) set.add(String(r.pmc).trim());
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}
function ssPmcOptions(current) {
  const cur = current == null ? '' : String(current);
  const list = ssPmcList();
  if (cur && !list.includes(cur)) list.unshift(cur); // keep an unknown current value visible
  return ['<option value="">—</option>']
    .concat(list.map((p) => `<option value="${escapeAttr(p)}"${p === cur ? ' selected' : ''}>${escapeHtml(p)}</option>`))
    .concat('<option value="__add_pmc__">+ Add new PMC…</option>')
    .join('');
}

function ssCell(row, key) {
  if (SS_COMPUTED.has(key)) {
    const bd = ssActualBreakdown(row, key);
    const value = bd.reduce((a, b) => a + (Number(b.company_total_booking) || 0), 0);
    // $0 actual but real bookings came in that were offset to $0 by a License Transfer:
    // flag it so it's not mistaken for "no activity" (details + notes show on hover).
    const ltZero = value === 0 && bd.some((b) => String(b.ctam_type || '').trim() === 'License Transfer' || b.offset_churn_id);
    const adjusted = bd.some(isBookingAdjusted); // includes a Booking Clawback / Correction
    return `<td class="ss-actual${ltZero ? ' ss-lt-zero' : ''}${adjusted ? ' ss-adj' : ''}" data-col="${key}">${fmtMoney(value)}</td>`;
  }
  const f = ssFieldDef(key);
  const val = row[key] ?? '';
  const numCls = f.type === 'number' ? ' num' : '';
  if (!ssEditable()) { // read-only (archived quarter or no edit permission)
    const text = SS_MONEY.has(key) ? fmtMoney(row[key]) : (f.type === 'number' ? fmtNum(row[key]) : (row[key] ?? ''));
    return `<td class="${numCls.trim()}" data-col="${key}">${escapeHtml(text)}</td>`;
  }
  if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${escapeAttr(o)}"${o === val ? ' selected' : ''}>${o || '—'}</option>`).join('');
    return `<td data-col="${key}"><select data-ss-key="${key}">${opts}</select></td>`;
  }
  if (key === 'pmc') {
    return `<td data-col="pmc"><select data-ss-key="pmc">${ssPmcOptions(val)}</select></td>`;
  }
  if (SS_MONEY.has(key)) { // editable money fields: show a formatted $ value
    return `<td class="num" data-col="${key}"><input type="text" inputmode="decimal" data-ss-key="${key}" value="${escapeAttr(fmtMoney(row[key]))}" /></td>`;
  }
  const step = f.type === 'number' ? ' step="any"' : '';
  return `<td class="${numCls.trim()}" data-col="${key}"><input type="${f.type === 'number' ? 'number' : 'text'}"${step} data-ss-key="${key}" value="${escapeAttr(val)}" /></td>`;
}

// Sum one numeric column across a section's rows. Computed actuals are derived from
// Bookings (same as the cells); stored money/number columns sum row values.
function ssGroupSubtotal(groupRows, key) {
  const p = viewedPeriodObj();
  const months = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const year = p ? p.year : null;
  if (key === 'm1_actual' || key === 'm2_actual' || key === 'm3_actual') {
    const idx = { m1_actual: 0, m2_actual: 1, m3_actual: 2 }[key];
    return groupRows.reduce((a, r) => a + ssActual(r, months[idx], year), 0);
  }
  if (key === 'q_actual') {
    return groupRows.reduce((a, r) => a + months.reduce((s, mn) => s + ssActual(r, mn, year), 0), 0);
  }
  return groupRows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

// A bold subtotal row for a section: sums every numeric column (targets, actuals,
// Worst/Accurate/Best); non-numeric columns are blank except a "Subtotal" label.
function ssSubtotalRowHtml(cols, groupRows, editCol) {
  const cells = cols.map(([k], i) => {
    if (SS_MONEY.has(k)) {
      const cls = SS_COMPUTED.has(k) ? 'ss-actual' : 'num';
      return `<td class="${cls}" data-col="${k}">${fmtMoney(ssGroupSubtotal(groupRows, k))}</td>`;
    }
    if (i === 0) return `<td class="ss-subtotal-label" data-col="${k}">Subtotal</td>`;
    return `<td data-col="${k}"></td>`;
  }).join('');
  return `<tr class="ss-subtotal-row"><td class="rownum"></td>${cells}${editCol ? '<td></td>' : ''}</tr>`;
}

// Show/hide the Sales Support toolbar (quarter, filters, close/open) via the toggle.
function applySsBar() {
  const collapsed = state.ssBarCollapsed;
  const bar = $('#salesBar');
  if (bar) bar.hidden = collapsed;
  const btn = $('#ssBarToggle');
  if (btn) btn.textContent = collapsed ? '▾ Show controls' : '▴ Hide controls';
}

// Build the Sales Support filter dropdowns (Account Owner / Product / Section)
// from the schema field options, preserving the current selection.
function ssFilterOptionsHtml(values, current) {
  return [`<option value="All"${current === 'All' ? ' selected' : ''}>All</option>`]
    .concat(values.map((v) => `<option value="${escapeAttr(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`))
    .join('');
}
function populateSsFilters() {
  // Account Owner options = only the owners actually present in the currently-viewed quarter's
  // rows (not the full static list), so the dropdown reflects who's active in this sheet.
  const owners = [...new Set(state.rows.sales_support
    .filter((r) => r.period === state.salesPeriod)
    .map((r) => String(r.account_owner || '').trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // The Product filter groups SEO under Digital Advertising, so it's not its own filter option.
  const products = (ssFieldDef('product_category')?.options || []).filter((c) => c && c !== 'SEO');
  const sections = (ssFieldDef('section')?.options || []).filter(Boolean);
  // If a now-removed option (e.g. SEO) was selected, fall back to All.
  if (state.ssFilters.product !== 'All' && !products.includes(state.ssFilters.product)) state.ssFilters.product = 'All';
  // If the selected owner isn't in this quarter (e.g. after switching quarters), reset to All.
  if (state.ssFilters.owner !== 'All' && !owners.includes(state.ssFilters.owner) && !isSales()) state.ssFilters.owner = 'All';
  // A tagged salesperson is locked to their own name — keep it selectable even with no rows yet.
  if (isSales() && salesOwner() && !owners.includes(salesOwner())) owners.unshift(salesOwner());
  $('#ssFilterOwner').innerHTML = ssFilterOptionsHtml(owners, state.ssFilters.owner);
  $('#ssFilterProduct').innerHTML = ssFilterOptionsHtml(products, state.ssFilters.product);
  $('#ssFilterSection').innerHTML = ssFilterOptionsHtml(sections, state.ssFilters.section);
  // A tagged salesperson is locked to their own Account Owner.
  $('#ssFilterOwner').disabled = isSales();
}

function renderSalesSupport() {
  const periods = state.salesPeriods;
  $('#ssPeriod').innerHTML = periods.slice().reverse().map((p) =>
    `<option value="${escapeAttr(p.period)}"${p.period === state.salesPeriod ? ' selected' : ''}>${escapeHtml(p.period)}${p.status === 'open' ? ' (open)' : ' (archived)'}</option>`).join('')
    || '<option value="">No quarters</option>';
  const viewed = viewedPeriodObj();
  const pill = $('#ssPeriodStatus');
  pill.textContent = viewed ? (viewed.status === 'open' ? 'Open' : 'Archived') : '';
  pill.style.display = viewed ? '' : 'none';
  $('#ssAddRow').style.display = ssEditable() ? '' : 'none';
  $('#ssSyncBookings').hidden = !canManageQuarters();
  $('#ssReconcile').hidden = !viewed; // read-only diagnostic — available to anyone viewing SS
  $('#ssCloseQuarter').hidden = !(canManageQuarters() && viewed && viewed.status === 'open');
  // Open New Quarter only applies on the most recent quarter (it creates the next one).
  // If a later quarter already exists, disable it so you can't open ahead from an older quarter.
  $('#ssOpenQuarter').hidden = !canManageQuarters();
  const latest = periods.length ? periods[periods.length - 1] : null; // periods are oldest→newest
  const onLatest = !!(viewed && latest && viewed.period === latest.period);
  $('#ssOpenQuarter').disabled = !onLatest;
  $('#ssOpenQuarter').title = onLatest ? '' : 'Switch to the most recent quarter to open a new one.';

  applySsBar();
  const cols = ssColumns();
  const editCol = ssEditable();
  $('#ssHead').innerHTML = '<tr><th class="rownum">#</th>' +
    cols.map(([k, label]) => `<th class="${SS_COMPUTED.has(k) ? 'ss-actual' : ''}" data-col="${k}">${escapeHtml(label)}<span class="col-resize"></span></th>`).join('') +
    (editCol ? '<th></th>' : '') + '</tr>';

  const catList = ssFieldDef('product_category').options;
  const secList = ssFieldDef('section').options;
  const catIdx = (c) => { const i = catList.indexOf(c); return i < 0 ? 99 : i; };
  const secIdx = (s) => { const i = secList.indexOf(s); return i < 0 ? 99 : i; };

  // Filter controls (Account Owner / Product / Section).
  populateSsFilters();
  // View toggle (Product Level / Property Level) — reflect the active mode and hide the
  // product-only filters (Product / Section) when viewing per-property.
  document.querySelectorAll('.ss-view-btn').forEach((b) => b.classList.toggle('active', b.dataset.ssView === state.ssView));
  const prodFilterLbl = $('#ssFilterProduct') && $('#ssFilterProduct').closest('label');
  const secFilterLbl = $('#ssFilterSection') && $('#ssFilterSection').closest('label');
  if (prodFilterLbl) prodFilterLbl.style.display = state.ssView === 'pmc' ? 'none' : '';
  if (secFilterLbl) secFilterLbl.style.display = state.ssView === 'pmc' ? 'none' : '';
  if (state.ssView === 'pmc') { renderSsPmcTable(viewed, editCol); return; }
  const ff = state.ssFilters;
  const rows = state.rows.sales_support
    .filter((r) => (r.level || 'product') === 'product') // exclude property & pmc rows
    .filter((r) => r.period === state.salesPeriod)
    .filter((r) => ff.owner === 'All' || (r.account_owner || '') === ff.owner)
    .filter((r) => ff.product === 'All' || ssMainCategory(r.product_category) === ff.product)
    .filter((r) => ff.section === 'All' || (r.section || '') === ff.section)
    .sort((a, b) =>
      catIdx(ssMainCategory(a.product_category)) - catIdx(ssMainCategory(b.product_category))
      || secIdx(a.section) - secIdx(b.section)
      || String(a.product_category || '').localeCompare(String(b.product_category || ''))
      || String(a.pmc || '').localeCompare(String(b.pmc || '')));

  const colCount = cols.length + (editCol ? 1 : 0);
  let html = '';
  let group = null;
  let groupRows = []; // rows of the current section, for the subtotal
  let alt = 0; // alternating-row counter, reset at each section for clean striping
  let n = 0;   // running row number across the whole filtered set
  const flushSubtotal = () => { if (group !== null && groupRows.length) html += ssSubtotalRowHtml(cols, groupRows, editCol); };
  for (const row of rows) {
    const g = `${ssMainCategory(row.product_category) || '—'}  ·  ${row.section || '—'}`;
    if (g !== group) {
      flushSubtotal();        // close out the previous section with its subtotal
      group = g; alt = 0; groupRows = [];
      html += `<tr class="ss-group"><td class="rownum"></td><td colspan="${colCount}"><span class="ss-group-label">${escapeHtml(g)}</span></td></tr>`;
    }
    groupRows.push(row);
    n += 1;
    const del = editCol ? `<td><button type="button" class="view-btn danger" data-ss-del="${row.id}" title="Delete row">✕</button></td>` : '';
    const cls = (alt % 2) ? 'ss-alt' : '';
    alt += 1;
    html += `<tr data-ss-id="${row.id}" class="${cls}"><td class="rownum">${n}</td>${cols.map(([k]) => ssCell(row, k)).join('')}${del}</tr>`;
  }
  flushSubtotal(); // subtotal for the final section
  if (!rows.length) {
    const msg = !viewed ? `No quarters yet.${isAdmin() ? ' Use “Open New Quarter”.' : ''}`
      : editCol ? 'No rows yet. Use “+ Add row”.'
        : (viewed.status === 'open' ? 'No rows yet.' : 'Archived quarter (read-only).');
    html = `<tr><td class="muted" colspan="${colCount + 1}" style="padding:14px">${msg}</td></tr>`;
  }
  $('#ssBody').innerHTML = html;
  // Fixed grand-total row across every (filtered) row, pinned to the bottom of the table.
  $('#ssFoot').innerHTML = rows.length ? ssGrandTotalRowHtml(cols, rows, editCol) : '';
}

// ----- PMC Level view: PMC rows (aggregated) → expand to Property rows (manual targets) →
// expand to per-order detail. Stored rows stay at property level; PMC rows are computed sums. -----
function ssColumnsPmc() {
  const p = viewedPeriodObj();
  const q = p ? `Q${p.quarter}` : 'Q';
  const y = p ? p.year : '';
  const m = p ? QUARTER_MONTHS[p.quarter] : ['Month 1', 'Month 2', 'Month 3'];
  const cols = [
    ['name', 'PMC / Property'], ['total_props_count', 'Total Props'], ['active_props', 'Active Props'],
    ['account_owner', 'Account Owner'],
    ['q2_target', `${q} Target`],
    ['apr_target', `${m[0]} ${y} Target`], ['m1_actual', `${m[0]} ${y} Actual`],
    ['may_target', `${m[1]} ${y} Target`], ['m2_actual', `${m[1]} ${y} Actual`],
    ['jun_target', `${m[2]} ${y} Target`], ['m3_actual', `${m[2]} ${y} Actual`],
    ['q_actual', `${q} Actual`],
    ['worst', 'Worst'], ['accurate', 'Accurate'], ['best', 'Best'], ['notes', 'Notes'],
  ];
  return isSales() ? cols.filter(([k]) => k !== 'account_owner') : cols;
}
// PMC-only manual columns (shown on the PMC aggregate row, stored on a level='pmc' record).
const SS_PMC_MANUAL = new Set(['total_props_count', 'active_props']);
// The stored level='pmc' record for a PMC in the viewed quarter, if one exists yet.
function ssPmcRowFor(pmc) {
  const key = String(pmc || '').trim().toLowerCase();
  return state.rows.sales_support.find((r) => (r.level || '') === 'pmc'
    && r.period === state.salesPeriod && String(r.pmc || '').trim().toLowerCase() === key) || null;
}
const SS_PROP_MONTHS = { m1_actual: 0, m2_actual: 1, m3_actual: 2 };
// A booking that "went live" via a License Transfer (its Company Total is offset toward $0).
const isBookingLT = (b) => String(b.ctam_type || '').trim() === 'License Transfer' || !!b.offset_churn_id;
// The bookings for a property across a set of months (a quarter, or a single month).
function ssPropertyBookingsIn(propId, months, year) {
  const pid = String(propId || '').trim().toLowerCase();
  const mset = new Set(months);
  return state.rows.bookings.filter((b) => String(b.property_id || '').trim().toLowerCase() === pid
    && mset.has(b.booking_month) && reconNum(b.booking_year) === year);
}
// Sum a set of bookings' Company Total + the License Transfer bookings among them (for the $0
// flag and the hover note).
function ssSumLT(bookings) {
  let value = 0; const lt = []; const adj = [];
  for (const b of bookings) {
    value += Number(b.company_total_booking) || 0;
    if (isBookingLT(b)) lt.push(b);
    if (isBookingAdjusted(b)) adj.push(b);
  }
  return { value, ltBookings: lt, adjBookings: adj };
}
// A hover title summarizing the License Transfer(s) behind a cell (property · product · note).
function ssLtTitle(ltBookings) {
  return (ltBookings || []).map((b) => {
    const who = b.property_name || b.property_id || 'property';
    const note = String(b.notes || '').trim() || String(b.billing_notes || '').trim();
    return `License Transfer — ${who}${b.product ? ` (${b.product})` : ''}${note ? `: ${note}` : ''}`;
  }).join('\n');
}
// A hover title summarizing the Booking Clawback / Correction line(s) behind a cell.
function ssAdjTitle(adjBookings) {
  return (adjBookings || []).map((b) => {
    const who = b.property_name || b.property_id || 'property';
    const note = String(b.notes || '').trim();
    return `${b.booking_adjustment} — ${who}${b.product ? ` (${b.product})` : ''}${note ? `: ${note}` : ''}`;
  }).join('\n');
}
// Render an Actual cell. Flags: a $0 that's really a License Transfer (coral), and any Booking
// Clawback/Correction included (grey). Notes for both show on hover.
function ssActualCellHtml(key, value, ltBookings, adjBookings) {
  const lt = ltBookings || []; const adj = adjBookings || [];
  const ltZero = value === 0 && lt.length > 0;
  const title = [lt.length ? ssLtTitle(lt) : '', adj.length ? ssAdjTitle(adj) : ''].filter(Boolean).join('\n');
  const cls = `ss-actual${ltZero ? ' ss-lt-zero' : ''}${adj.length ? ' ss-adj' : ''}`;
  return `<td class="${cls}"${title ? ` title="${escapeAttr(title)}"` : ''} data-col="${key}">${fmtMoney(value)}</td>`;
}
const ssMonthsForKey = (key, qm) => (key === 'q_actual' ? qm : [qm[SS_PROP_MONTHS[key]]]);
// A non-name, non-actual cell on a property row: editable target / owner / notes (or read-only).
function ssPropEditCell(row, key) {
  const f = ssFieldDef(key);
  if (!ssEditable()) {
    const text = SS_MONEY.has(key) ? fmtMoney(row[key]) : (row[key] ?? '');
    return `<td class="${f && f.type === 'number' ? 'num' : ''}" data-col="${key}">${escapeHtml(text)}</td>`;
  }
  if (f && f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${escapeAttr(o)}"${o === (row[key] ?? '') ? ' selected' : ''}>${o || '—'}</option>`).join('');
    return `<td data-col="${key}"><select data-ss-key="${key}">${opts}</select></td>`;
  }
  if (SS_MONEY.has(key)) {
    return `<td class="num" data-col="${key}"><input type="text" inputmode="decimal" data-ss-key="${key}" value="${escapeAttr(fmtMoney(row[key]))}" /></td>`;
  }
  return `<td data-col="${key}"><input type="text" data-ss-key="${key}" value="${escapeAttr(row[key] ?? '')}" /></td>`;
}
// A PMC aggregate row (level 1): sums of its property rows' targets + actuals; expands to properties.
function ssPmcMainRow(pmc, props, cols, editCol) {
  const p = viewedPeriodObj();
  const year = p ? p.year : null;
  const qm = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const cells = cols.map(([k]) => {
    if (k === 'name') {
      const caret = `<button type="button" class="ss-expand${state.ssExpandedPmc.has(pmc) ? ' open' : ''}" data-ss-expand-pmc="${escapeAttr(pmc)}" title="Show / hide properties">▸</button>`;
      return `<td data-col="name" class="ss-prop-name">${caret}<span>${escapeHtml(pmc)}</span> <span class="ss-count">${props.length}</span></td>`;
    }
    if (SS_PMC_MANUAL.has(k)) { // manual PMC-level count (stored on the level='pmc' record)
      const pr = ssPmcRowFor(pmc);
      const val = pr && pr[k] != null && pr[k] !== '' ? pr[k] : '';
      if (!ssEditable()) return `<td class="num" data-col="${k}">${val === '' ? '' : fmtNum(val)}</td>`;
      return `<td class="num" data-col="${k}"><input type="number" step="any" data-pmc-key="${k}" data-pmc="${escapeAttr(pmc)}" value="${escapeAttr(val)}" /></td>`;
    }
    if (k === 'account_owner') { // rolls up from the properties (a PMC's owner = its properties' owner)
      const owners = [...new Set(props.map((r) => String(r.account_owner || '').trim()).filter(Boolean))];
      return `<td data-col="account_owner">${escapeHtml(owners.join(', '))}</td>`;
    }
    if (SS_COMPUTED.has(k)) {
      const months = ssMonthsForKey(k, qm);
      const { value, ltBookings, adjBookings } = ssSumLT(props.flatMap((r) => ssPropertyBookingsIn(r.property_id, months, year)));
      return ssActualCellHtml(k, value, ltBookings, adjBookings);
    }
    if (SS_MONEY.has(k)) return `<td class="num" data-col="${k}">${fmtMoney(props.reduce((a, r) => a + (Number(r[k]) || 0), 0))}</td>`;
    return `<td data-col="${k}"></td>`;
  }).join('');
  return `<tr class="ss-pmc-row"><td class="rownum"></td>${cells}${editCol ? '<td></td>' : ''}</tr>`;
}
// A property row (level 2): editable targets, computed actuals; expands to per-order detail.
function ssPropertyRow(row, cols, editCol) {
  const p = viewedPeriodObj();
  const year = p ? p.year : null;
  const qm = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const cells = cols.map(([k]) => {
    if (k === 'name') {
      const caret = `<button type="button" class="ss-expand${state.ssExpanded.has(row.id) ? ' open' : ''}" data-ss-expand="${row.id}" title="Show / hide order detail">▸</button>`;
      return `<td data-col="name" class="ss-prop-name ss-lvl2"><span class="ss-detail-indent">↳</span>${caret}<span>${escapeHtml(row.property || row.property_id || '—')}</span></td>`;
    }
    if (SS_PMC_MANUAL.has(k)) return `<td data-col="${k}"></td>`; // PMC-only columns are blank here
    if (SS_COMPUTED.has(k)) {
      const { value, ltBookings, adjBookings } = ssSumLT(ssPropertyBookingsIn(row.property_id, ssMonthsForKey(k, qm), year));
      return ssActualCellHtml(k, value, ltBookings, adjBookings);
    }
    return ssPropEditCell(row, k);
  }).join('');
  const del = editCol ? `<td><button type="button" class="view-btn danger" data-ss-del="${row.id}" title="Delete row">✕</button></td>` : '';
  return `<tr data-ss-id="${row.id}" class="ss-lvl2-row"><td class="rownum"></td>${cells}${del}</tr>`;
}
// Expanded per-property order detail: one row per Product × (Pilot/CTAM), actuals per month.
function ssOrderDetailRows(row, cols, editCol) {
  const p = viewedPeriodObj();
  const year = p ? p.year : null;
  const qm = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const pid = String(row.property_id || '').trim().toLowerCase();
  const groups = new Map();
  for (const b of state.rows.bookings) {
    if (String(b.property_id || '').trim().toLowerCase() !== pid) continue;
    if (reconNum(b.booking_year) !== year) continue;
    const mi = qm.indexOf(b.booking_month);
    if (mi < 0) continue;
    const product = String(b.product || '').trim() || '—';
    const section = ssIsPilot(b) ? 'Pilot' : 'CTAM';
    const k = `${product}||${section}`;
    if (!groups.has(k)) groups.set(k, { product, section, m: [0, 0, 0], ltb: [[], [], []], adjb: [[], [], []] });
    const g = groups.get(k);
    g.m[mi] += Number(b.company_total_booking) || 0;
    if (isBookingLT(b)) g.ltb[mi].push(b);
    if (isBookingAdjusted(b)) g.adjb[mi].push(b);
  }
  const list = [...groups.values()].sort((a, b) =>
    a.product.localeCompare(b.product) || a.section.localeCompare(b.section));
  const colCount = cols.length + (editCol ? 1 : 0);
  if (!list.length) {
    return `<tr class="ss-detail-row"><td class="rownum"></td><td class="ss-detail-empty" colspan="${colCount}">No bookings for this property this quarter.</td></tr>`;
  }
  return list.map((g) => {
    const vals = { m1_actual: g.m[0], m2_actual: g.m[1], m3_actual: g.m[2], q_actual: g.m[0] + g.m[1] + g.m[2] };
    const listFor = (arr, k) => (k === 'q_actual' ? [...arr[0], ...arr[1], ...arr[2]] : arr[SS_PROP_MONTHS[k]]);
    const cells = cols.map(([k]) => {
      if (k === 'name') return `<td class="ss-detail-name ss-lvl3" data-col="name"><span class="ss-detail-indent">↳↳</span> ${escapeHtml(g.product)} <span class="ss-tag ss-tag-${g.section.toLowerCase()}">${g.section}</span></td>`;
      if (Object.prototype.hasOwnProperty.call(vals, k)) return ssActualCellHtml(k, vals[k], listFor(g.ltb, k), listFor(g.adjb, k));
      return `<td data-col="${k}"></td>`;
    }).join('');
    return `<tr class="ss-detail-row"><td class="rownum"></td>${cells}${editCol ? '<td></td>' : ''}</tr>`;
  }).join('');
}
// Grand total (PMC view): stored targets summed across all property rows; actuals from Bookings.
function ssPmcGrandTotal(cols, rows, editCol) {
  const p = viewedPeriodObj();
  const year = p ? p.year : null;
  const qm = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const pmcRows = state.rows.sales_support.filter((r) => (r.level || '') === 'pmc' && r.period === state.salesPeriod);
  const cells = cols.map(([k], i) => {
    if (SS_PMC_MANUAL.has(k)) { const s = pmcRows.reduce((a, r) => a + (Number(r[k]) || 0), 0); return `<td class="num" data-col="${k}">${s ? fmtNum(s) : ''}</td>`; }
    if (SS_COMPUTED.has(k)) {
      const months = ssMonthsForKey(k, qm);
      const { value, ltBookings, adjBookings } = ssSumLT(rows.flatMap((r) => ssPropertyBookingsIn(r.property_id, months, year)));
      return ssActualCellHtml(k, value, ltBookings, adjBookings);
    }
    if (SS_MONEY.has(k)) return `<td class="num" data-col="${k}">${fmtMoney(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0))}</td>`;
    if (i === 0) return `<td data-col="${k}">Grand Total</td>`;
    return `<td data-col="${k}"></td>`;
  }).join('');
  return `<tr class="ss-grand-total"><td class="rownum"></td>${cells}${editCol ? '<td></td>' : ''}</tr>`;
}
function renderSsPmcTable(viewed, editCol) {
  const cols = ssColumnsPmc();
  $('#ssHead').innerHTML = '<tr><th class="rownum">#</th>'
    + cols.map(([k, label]) => `<th class="${SS_COMPUTED.has(k) ? 'ss-actual' : ''}" data-col="${k}">${escapeHtml(label)}<span class="col-resize"></span></th>`).join('')
    + (editCol ? '<th></th>' : '') + '</tr>';
  const ff = state.ssFilters;
  const propRows = state.rows.sales_support
    .filter((r) => (r.level || '') === 'property')
    .filter((r) => r.period === state.salesPeriod)
    .filter((r) => ff.owner === 'All' || (r.account_owner || '') === ff.owner);
  // Group property rows by PMC (the top hierarchy level).
  const byPmc = new Map();
  for (const r of propRows) { const key = String(r.pmc || '').trim() || '—'; if (!byPmc.has(key)) byPmc.set(key, []); byPmc.get(key).push(r); }
  const pmcs = [...byPmc.keys()].sort((a, b) => a.localeCompare(b));
  const colCount = cols.length + (editCol ? 1 : 0);
  let html = '';
  for (const pmc of pmcs) {
    const list = byPmc.get(pmc).sort((a, b) => String(a.property || '').localeCompare(String(b.property || '')));
    html += ssPmcMainRow(pmc, list, cols, editCol);
    if (state.ssExpandedPmc.has(pmc)) {
      for (const row of list) {
        html += ssPropertyRow(row, cols, editCol);
        if (state.ssExpanded.has(row.id)) html += ssOrderDetailRows(row, cols, editCol);
      }
    }
  }
  if (!propRows.length) {
    const msg = !viewed ? 'No quarters yet.'
      : (editCol ? 'No properties yet. Use “Sync from Bookings” to pull them in, or “+ Add row”.'
        : (viewed.status === 'open' ? 'No properties yet.' : 'Archived quarter (read-only).'));
    html = `<tr><td class="muted" colspan="${colCount + 1}" style="padding:14px">${escapeHtml(msg)}</td></tr>`;
  }
  $('#ssBody').innerHTML = html;
  $('#ssFoot').innerHTML = propRows.length ? ssPmcGrandTotal(cols, propRows, editCol) : '';
}

// Bold "Grand Total" row summing every numeric column across all shown rows (pinned at bottom).
function ssGrandTotalRowHtml(cols, allRows, editCol) {
  const cells = cols.map(([k], i) => {
    if (SS_MONEY.has(k)) {
      const cls = SS_COMPUTED.has(k) ? 'ss-actual' : 'num';
      return `<td class="${cls}" data-col="${k}">${fmtMoney(ssGroupSubtotal(allRows, k))}</td>`;
    }
    if (i === 0) return `<td data-col="${k}">Grand Total</td>`;
    return `<td data-col="${k}"></td>`;
  }).join('');
  return `<tr class="ss-grand-total"><td class="rownum"></td>${cells}${editCol ? '<td></td>' : ''}</tr>`;
}

// Build one field for the "Add row" form (labels reflect the open quarter).
function ssFormFieldHtml(f) {
  const label = ssLabels()[f.key] || f.label;
  let control;
  if (f.key === 'account_owner' && isSales()) {
    // A tagged salesperson can only file rows under their own name (locked).
    control = `<input type="text" data-ss-key="account_owner" value="${escapeAttr(salesOwner())}" disabled />`;
  } else if (f.key === 'pmc') {
    // Type-to-search PMC / Account Name (suggestions from Salesforce Recon + existing PMCs).
    // Free text is allowed, so a brand-new PMC can simply be typed in.
    const opts = ssPmcList().map((p) => `<option value="${escapeAttr(p)}"></option>`).join('');
    control = `<input type="text" list="ssPmcDatalist" data-ss-key="pmc" placeholder="Type to search PMCs…" autocomplete="off" />`
      + `<datalist id="ssPmcDatalist">${opts}</datalist>`;
  } else if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${escapeAttr(o)}">${o || '—'}</option>`).join('');
    control = `<select data-ss-key="${f.key}">${opts}</select>`;
  } else {
    control = `<input type="text" data-ss-key="${f.key}" />`; // money/text typed in
  }
  return `<div class="entry-field" data-field="${f.key}"><label>${escapeHtml(label)}</label>${control}</div>`;
}

function openSsForm() {
  const defs = state.schema.sales_support.editable;
  let fields;
  if (state.ssView === 'pmc') {
    // PMC view adds a Property row: identity + manual targets (no product/section).
    const keys = ['property', 'property_id', 'pmc', 'account_owner',
      'q2_target', 'apr_target', 'may_target', 'jun_target', 'worst', 'accurate', 'best', 'notes'];
    fields = keys.map((k) => defs.find((f) => f.key === k)).filter(Boolean);
  } else {
    const skip = new Set(['period', 'level', 'property_id', 'property', 'total_props_count', 'active_props']); // internal / other-level
    fields = defs.filter((f) => !skip.has(f.key));
  }
  $('#ssModalTitle').textContent = state.ssView === 'pmc' ? 'Add Property row' : 'Add Sales Support row';
  $('#ssForm').innerHTML = fields.map(ssFormFieldHtml).join('');
  $('#ssModal').hidden = false;
  const first = $('#ssForm [data-ss-key]');
  if (first) first.focus();
}

async function submitSsForm(e) {
  e.preventDefault();
  const payload = {};
  $('#ssForm').querySelectorAll('[data-ss-key]').forEach((ctl) => {
    let v = ctl.value;
    if (v === '__add_pmc__') v = ''; // unfinished add-new
    if (SS_MONEY.has(ctl.dataset.ssKey)) v = parseMoney(v);
    payload[ctl.dataset.ssKey] = v;
  });
  payload.period = state.salesPeriod; // add to the quarter currently being viewed
  payload.level = state.ssView === 'product' ? 'product' : 'property';
  try {
    const row = await api('/api/sales_support', { method: 'POST', body: JSON.stringify(payload) });
    state.rows.sales_support.push(row);
    $('#ssModal').hidden = true;
    renderSalesSupport();
    ssApplyFreeze();
    toast('Row added');
  } catch (err) { toast(err.message, true); }
}

// ---------- Single-entry Churn form (the "+ Enter Churn" button on the Churn tab) ----------
function churnFormFieldHtml(f) {
  let control;
  if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${escapeAttr(o)}">${o || '—'}</option>`).join('');
    control = `<select data-churn-key="${f.key}">${opts}</select>`;
  } else if (f.type === 'date') {
    control = `<input type="date" data-churn-key="${f.key}" />`;
  } else {
    control = `<input type="text" data-churn-key="${f.key}" />`; // money/text/number typed in
  }
  return `<div class="entry-field" data-field="${f.key}"><label>${escapeHtml(f.label)}</label>${control}</div>`;
}

function openChurnForm() {
  if (state.tab !== 'churn' || !canAddDelete()) return;
  // System-generated (date_added is stamped server-side) and inline-only (ar_override is edited
  // in the grid cell) fields are not part of the manual entry form.
  const skip = new Set(['date_added', 'ar_override']);
  $('#churnForm').innerHTML = state.schema.churn.editable
    .filter((f) => !skip.has(f.key))
    .map(churnFormFieldHtml).join('');
  $('#churnEntryModal').hidden = false;
  const first = $('#churnForm [data-churn-key]');
  if (first) first.focus();
}

async function submitChurnForm(e) {
  e.preventDefault();
  const payload = {};
  $('#churnForm').querySelectorAll('[data-churn-key]').forEach((ctl) => {
    let v = ctl.value;
    if (MONEY.has(ctl.dataset.churnKey)) v = parseMoney(v);
    payload[ctl.dataset.churnKey] = v;
  });
  try {
    const row = await api('/api/churn', { method: 'POST', body: JSON.stringify(payload) });
    state.rows.churn.push(row);
    $('#churnEntryModal').hidden = true;
    renderBody(); renderSummary(); renderBookingTotals(currentRows('churn'));
    $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
    $('#scroller').scrollTop = $('#scroller').scrollHeight;
    toast('Churn added');
  } catch (err) { toast(err.message, true); }
}

function wireChurnEntry() {
  $('#churnEntryClose').onclick = () => { $('#churnEntryModal').hidden = true; };
  $('#churnEntryCancel').onclick = () => { $('#churnEntryModal').hidden = true; };
  $('#churnEntryModal').addEventListener('click', (e) => { if (e.target.id === 'churnEntryModal') $('#churnEntryModal').hidden = true; });
  $('#churnForm').addEventListener('submit', submitChurnForm);
}

function wireSalesSupport() {
  $('#ssAddRow').onclick = () => { if (ssEditable()) openSsForm(); };
  // Product Level / Property Level toggle.
  document.querySelectorAll('.ss-view-btn').forEach((btn) => {
    btn.onclick = () => {
      if (state.ssView === btn.dataset.ssView) return;
      state.ssView = btn.dataset.ssView;
      localStorage.setItem('perqSsView', state.ssView);
      renderSalesSupport(); ssApplyFreeze();
    };
  });
  $('#ssBarToggle').onclick = () => {
    state.ssBarCollapsed = !state.ssBarCollapsed;
    localStorage.setItem('perqSsBarCollapsed', state.ssBarCollapsed ? '1' : '0');
    applySsBar();
  };
  $('#ssPeriod').onchange = (e) => { state.salesPeriod = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssFilterOwner').onchange = (e) => { state.ssFilters.owner = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssFilterProduct').onchange = (e) => { state.ssFilters.product = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssFilterSection').onchange = (e) => { state.ssFilters.section = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssSyncBookings').onclick = async () => {
    if (!confirm('Create any missing Sales Support rows from Bookings in the open quarter(s) — both Product-level (PMC + Product + Section) and Property-level (one per property)?\n\nThis never removes or duplicates rows.')) return;
    try {
      const { created } = await api('/api/sales_support/sync', { method: 'POST' });
      state.rows.sales_support = await api('/api/sales_support');
      renderSalesSupport(); ssApplyFreeze();
      const rec = ssReconcileViewed();
      toast(created ? `Added ${created} row${created === 1 ? '' : 's'} from Bookings` : 'No new rows needed');
      // If the SS total still doesn't match Bookings (untracked OR double-counted), show why.
      if (rec.gap || rec.dupeExtra) showResult('Sales Support vs Bookings', ssReconcileReportHtml(rec));
    } catch (err) { toast(err.message, true); }
  };
  $('#ssReconcile').onclick = () => showResult('Sales Support vs Bookings', ssReconcileReportHtml(ssReconcileViewed()));
  $('#ssCloseQuarter').onclick = async () => {
    const period = state.salesPeriod;
    if (!period) return;
    if (!confirm(`Are you sure you want to close ${period}?\n\nAfter you confirm, this quarter will be locked and archived.`)) return;
    try {
      state.salesPeriods = await api('/api/sales_periods/close', { method: 'POST', body: JSON.stringify({ period }) });
      renderSalesSupport(); ssApplyFreeze();
      toast(`${period} closed and archived`);
    } catch (err) { toast(err.message, true); }
  };
  $('#ssOpenQuarter').onclick = async () => {
    if (!confirm('Open a new quarter? The current quarter stays open until you close it.')) return;
    try {
      const data = await api('/api/sales_periods/open', { method: 'POST' });
      state.salesPeriods = data.periods;
      state.salesPeriod = data.created.period;
      renderSalesSupport(); ssApplyFreeze();
      toast(`Opened ${data.created.period}`);
    } catch (err) { toast(err.message, true); }
  };
  $('#ssModalClose').onclick = () => { $('#ssModal').hidden = true; };
  $('#ssCancel').onclick = () => { $('#ssModal').hidden = true; };
  $('#ssModal').addEventListener('click', (e) => { if (e.target.id === 'ssModal') $('#ssModal').hidden = true; });
  $('#ssForm').addEventListener('submit', submitSsForm);
  // (PMC in the Add-row form is a type-to-search input with a datalist — free text allowed.)
  $('#ssBody').addEventListener('change', async (e) => {
    // PMC-level manual counts (Total Props / Active Props) live on a level='pmc' record —
    // create it on first edit, otherwise patch it.
    const pmcCtl = e.target.closest('[data-pmc-key]');
    if (pmcCtl) {
      const key = pmcCtl.dataset.pmcKey;
      const pmc = pmcCtl.dataset.pmc;
      const value = pmcCtl.value === '' ? null : parseMoney(pmcCtl.value);
      try {
        const existing = ssPmcRowFor(pmc);
        if (existing) {
          updateRowInState('sales_support', await api(`/api/sales_support/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ [key]: value }) }));
        } else {
          state.rows.sales_support.push(await api('/api/sales_support', { method: 'POST', body: JSON.stringify({ period: state.salesPeriod, level: 'pmc', pmc, [key]: value }) }));
        }
        renderSalesSupport(); ssApplyFreeze();
        toast('Saved');
      } catch (err) { toast(err.message, true); }
      return;
    }
    const ctl = e.target.closest('[data-ss-key]');
    if (!ctl) return;
    const id = Number(ctl.closest('[data-ss-id]').dataset.ssId);
    const key = ctl.dataset.ssKey;
    let value = ctl.value;
    if (key === 'pmc' && value === '__add_pmc__') {
      const name = (prompt('New PMC name:') || '').trim();
      if (!name) { renderSalesSupport(); return; } // cancelled — restore the select
      value = name;
    } else if (SS_MONEY.has(key)) {
      value = parseMoney(value);
    }
    try {
      const updated = await api(`/api/sales_support/${id}`, { method: 'PATCH', body: JSON.stringify({ [key]: value }) });
      updateRowInState('sales_support', updated);
      renderSalesSupport(); // grouping/actuals may change
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });
  $('#ssBody').addEventListener('click', async (e) => {
    // Expand / collapse a PMC's property rows.
    const expPmc = e.target.closest('[data-ss-expand-pmc]');
    if (expPmc) {
      const pmc = expPmc.dataset.ssExpandPmc;
      if (state.ssExpandedPmc.has(pmc)) state.ssExpandedPmc.delete(pmc); else state.ssExpandedPmc.add(pmc);
      renderSalesSupport(); ssApplyFreeze();
      return;
    }
    // Expand / collapse a property's per-order detail.
    const exp = e.target.closest('[data-ss-expand]');
    if (exp) {
      const id = Number(exp.dataset.ssExpand);
      if (state.ssExpanded.has(id)) state.ssExpanded.delete(id); else state.ssExpanded.add(id);
      renderSalesSupport(); ssApplyFreeze();
      return;
    }
    const del = e.target.closest('[data-ss-del]');
    if (!del) return;
    if (!confirm('Delete this row?')) return;
    try {
      await api(`/api/sales_support/${del.dataset.ssDel}`, { method: 'DELETE' });
      state.rows.sales_support = state.rows.sales_support.filter((r) => String(r.id) !== String(del.dataset.ssDel));
      renderSalesSupport();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- Pagination ----------
function wirePager() {
  $('#pageSize').value = state.pageSize;
  $('#pageSize').onchange = (e) => {
    state.pageSize = e.target.value;
    localStorage.setItem('perqPageSize', state.pageSize);
    state.page[state.tab] = 1;
    renderBody();
  };
  $('#pagePrev').onclick = () => {
    if ((state.page[state.tab] || 1) > 1) { state.page[state.tab] -= 1; renderBody(); $('#scroller').scrollTop = 0; }
  };
  $('#pageNext').onclick = () => {
    state.page[state.tab] = (state.page[state.tab] || 1) + 1; renderBody(); $('#scroller').scrollTop = 0;
  };
}

// ---------- Bookings reconciliation ----------
const reconText = (v) => String(v == null ? '' : v).trim().toLowerCase();
const reconNum = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
const reconPair = (r) => `${reconText(r.booking_month)}|${reconNum(r.booking_year)}`;
const reconKey = (r) => `${reconPair(r)}|${reconText(r.property_id)}|${reconText(r.pmc)}|${reconText(r.product)}`;
// Value columns compared during reconciliation. Company Total is computed (not editable).
const RECON_METRICS = [
  { key: 'mrr', label: 'MRR', editable: true },
  { key: 'offset_amount', label: 'Offset Amount', editable: true },
  { key: 'one_time_fee', label: 'One-Time Fee', editable: true },
  { key: 'company_total_booking', label: 'Company Total', editable: false },
];

// Metric keys where the uploaded value (when present) differs from the booking's value.
function metricsDiff(b, u) {
  const diffs = [];
  for (const m of RECON_METRICS) {
    const uv = u[m.key];
    if (uv === null || uv === undefined || uv === '') continue; // upload didn't provide it
    if (reconNum(uv) !== reconNum(b[m.key])) diffs.push(m.key);
  }
  return diffs;
}

// Diff the uploaded rows against current bookings, scoped to the uploaded Month/Year pairs.
function reconcile() {
  const uploaded = state.reconcile.uploaded || [];
  const scope = new Set(uploaded.map(reconPair));
  const upByKey = new Map();
  uploaded.forEach((r) => upByKey.set(reconKey(r), r));
  const curByKey = new Map();
  for (const b of state.rows.bookings) {
    if (scope.has(reconPair(b))) curByKey.set(reconKey(b), b);
  }
  const mismatches = [];
  const missingInApp = [];
  for (const r of uploaded) {
    const b = curByKey.get(reconKey(r));
    if (!b) { missingInApp.push(r); continue; }
    const diffs = metricsDiff(b, r);
    if (diffs.length) mismatches.push({ booking: b, uploaded: r, diffs });
  }
  const extraInApp = [];
  for (const [key, b] of curByKey) if (!upByKey.has(key)) extraInApp.push(b);
  state.reconcile.result = { mismatches, missingInApp, extraInApp };
}

// One metric cell: the booking's value (editable input or text) + a small "file: $X" hint.
function reconMetricCell(b, u, m, diffs) {
  const differs = diffs.includes(m.key);
  const upRaw = u ? u[m.key] : null;
  const hasUp = upRaw !== null && upRaw !== undefined && upRaw !== '';
  const cur = m.editable
    ? `<input type="number" step="any" data-recon-field="${m.key}" value="${escapeAttr(b[m.key] ?? '')}" />`
    : `<span>${fmtMoney(b[m.key])}</span>`;
  const hint = hasUp ? `<div class="recon-up">file: ${fmtMoney(upRaw)}</div>` : '';
  return `<td class="num${differs ? ' diff' : ''}">${cur}${hint}</td>`;
}

function renderReconcile() {
  const res = state.reconcile.result || { mismatches: [], missingInApp: [], extraInApp: [] };
  const my = (r) => `${r.booking_month || ''} ${r.booking_year || ''}`.trim();
  if (!res.mismatches.length && !res.missingInApp.length && !res.extraInApp.length) {
    $('#reconcileBody').innerHTML = '<p class="recon-ok">Everything reconciles for the uploaded period(s). 🎉</p>';
    return;
  }
  const metricHead = RECON_METRICS.map((m) => `<th class="num">${m.label}</th>`).join('');
  const idCells = (r, prop = true) =>
    `<td>${escapeHtml(my(r))}</td><td>${escapeHtml(r.property_id ?? '')}</td><td>${escapeHtml(r.pmc ?? '')}</td>` +
    (prop ? `<td>${escapeHtml(r.property_name ?? '')}</td>` : '') +
    `<td>${escapeHtml(r.product ?? '')}</td>`;

  let html = `<h3 class="recon-h">Values differ (${res.mismatches.length})</h3>`;
  html += res.mismatches.length
    ? `<table class="recon-table"><thead><tr><th>Month/Year</th><th>Property ID</th><th>PMC</th><th>Property</th><th>Product</th>${metricHead}</tr></thead><tbody>` +
      res.mismatches.map(({ booking: b, uploaded: u, diffs }) =>
        `<tr data-id="${b.id}">${idCells(b)}${RECON_METRICS.map((m) => reconMetricCell(b, u, m, diffs)).join('')}</tr>`).join('') +
      '</tbody></table>'
    : '<p class="muted">None.</p>';

  html += `<h3 class="recon-h">In upload, missing from Bookings (${res.missingInApp.length})</h3>`;
  html += res.missingInApp.length
    ? `<table class="recon-table"><thead><tr><th>Month/Year</th><th>Property ID</th><th>PMC</th><th>Product</th>${metricHead}</tr></thead><tbody>` +
      res.missingInApp.map((r) =>
        `<tr>${idCells(r, false)}${RECON_METRICS.map((m) => `<td class="num">${(r[m.key] != null && r[m.key] !== '') ? fmtMoney(r[m.key]) : ''}</td>`).join('')}</tr>`).join('') +
      '</tbody></table>'
    : '<p class="muted">None.</p>';

  html += `<h3 class="recon-h">In Bookings, not in upload (${res.extraInApp.length})</h3>`;
  html += res.extraInApp.length
    ? `<table class="recon-table"><thead><tr><th>Month/Year</th><th>Property ID</th><th>PMC</th><th>Property</th><th>Product</th>${metricHead}<th></th></tr></thead><tbody>` +
      res.extraInApp.map((b) =>
        `<tr data-id="${b.id}">${idCells(b)}${RECON_METRICS.map((m) => reconMetricCell(b, null, m, [])).join('')}<td><button type="button" class="view-btn danger" data-recon-del>Delete</button></td></tr>`).join('') +
      '</tbody></table>'
    : '<p class="muted">None.</p>';
  $('#reconcileBody').innerHTML = html;
}

function closeReconcile() {
  $('#reconcileModal').hidden = true;
  renderBody(); renderSummary(); // reflect any edits made during reconciliation
  $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
}

function wireReconcile() {
  $('#reconcileFile').onchange = async (e) => {
    $('#moreMenu').hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Reconciling…');
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/bookings/reconcile', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Reconcile failed');
      const data = await res.json();
      state.reconcile.uploaded = data.rows || [];
      reconcile();
      renderReconcile();
      $('#reconcileModal').hidden = false;
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };
  $('#reconcileClose').onclick = closeReconcile;
  $('#reconcileModal').addEventListener('click', (e) => { if (e.target.id === 'reconcileModal') closeReconcile(); });

  // Inline-edit a value (MRR / Offset / One-Time Fee) -> save and re-diff.
  $('#reconcileBody').addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-recon-field]');
    if (!inp) return;
    const id = Number(inp.closest('tr').dataset.id);
    const key = inp.dataset.reconField;
    try {
      const updated = await api(`/api/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ [key]: inp.value }) });
      updateRowInState('bookings', updated);
      reconcile(); renderReconcile();
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });
  // Delete an extra booking -> remove and re-diff.
  $('#reconcileBody').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-recon-del]');
    if (!del) return;
    const id = Number(del.closest('tr').dataset.id);
    if (!confirm('Delete this booking?')) return;
    try {
      await api(`/api/bookings/${id}`, { method: 'DELETE' });
      state.rows.bookings = state.rows.bookings.filter((r) => r.id !== id);
      reconcile(); renderReconcile();
      toast('Deleted');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- View tools: filter toggle + table zoom ----------
function applyZoom() {
  $('#grid').style.zoom = state.zoom;
  $('#ssTable').style.zoom = state.zoom;
  $('#zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
}

// Quick-filter: column dropdown + autocomplete text for the active grid tab.
function renderQuickFilter() {
  const tab = state.tab;
  if (tab !== 'bookings' && tab !== 'churn') return;
  const { cols } = fieldsForTab();
  const qf = state.quickFilter[tab];
  if (qf.col && !cols.some((f) => f.key === qf.col)) { qf.col = ''; qf.text = ''; } // col not in this tab
  $('#qfColumn').innerHTML = ['<option value="">Quick filter column…</option>']
    .concat(cols.map((f) => `<option value="${f.key}"${f.key === qf.col ? ' selected' : ''}>${escapeHtml(f.label)}</option>`)).join('');
  $('#qfText').value = qf.text || '';
  $('#qfText').disabled = !qf.col;
  updateQfDatalist();
}
function updateQfDatalist() {
  const qf = state.quickFilter[state.tab];
  if (!qf || !qf.col) { $('#qfList').innerHTML = ''; return; }
  const vals = [...new Set((state.rows[state.tab] || [])
    .map((r) => r[qf.col]).filter((v) => v !== null && v !== undefined && v !== ''))]
    .map((v) => String(v)).sort((a, b) => a.localeCompare(b)).slice(0, 400);
  $('#qfList').innerHTML = vals.map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
}
let qfTimer = null;
function wireQuickFilter() {
  $('#qfColumn').onchange = (e) => {
    const qf = state.quickFilter[state.tab];
    const hadText = !!qf.text;
    qf.col = e.target.value;
    qf.text = '';
    $('#qfText').value = '';
    $('#qfText').disabled = !qf.col;
    if (qf.col) $('#qfText').focus();
    // Build the autocomplete list off the critical path so the field is instantly usable.
    setTimeout(updateQfDatalist, 0);
    // Only rebuild the grid if a filter was actually active (i.e. we're clearing one).
    if (hadText) { state.page[state.tab] = 1; renderBody(); }
  };
  // Debounce so the grid rebuilds once after typing stops, not on every keystroke.
  $('#qfText').oninput = (e) => {
    state.quickFilter[state.tab].text = e.target.value;
    clearTimeout(qfTimer);
    qfTimer = setTimeout(() => { state.page[state.tab] = 1; renderBody(); }, 180);
  };
}

// Drag the grip at the bottom of the filter bar to scale the filter tiles up/down.
function wireFiltersResize() {
  let active = null;
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.filters-resize')) return;
    e.preventDefault();
    active = { startY: e.clientY, startZoom: state.filterZoom };
    document.body.style.cursor = 'ns-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!active) return;
    const z = Math.min(2, Math.max(0.6, Math.round((active.startZoom + (e.clientY - active.startY) / 200) * 100) / 100));
    state.filterZoom = z;
    // Shared filter-tile size — apply to whichever filter row is on screen (Bookings/Churn or SaaS).
    const row = $('#summary .filters-row');
    if (row) row.style.zoom = z;
    const saasRow = $('#saasFilters');
    if (saasRow && !saasRow.hidden) saasRow.style.zoom = z;
  });
  document.addEventListener('mouseup', () => {
    if (!active) return;
    localStorage.setItem('perqFilterZoom', String(state.filterZoom));
    active = null;
    document.body.style.cursor = '';
  });
}

function wireView() {
  $('#toggleFilters').onclick = () => {
    state.filtersHidden = !state.filtersHidden;
    localStorage.setItem('perqFiltersHidden', state.filtersHidden ? '1' : '0');
    $('#toggleFilters').textContent = state.filtersHidden ? 'Multiple Filters' : 'Hide Multiple Filters';
    renderSummary();
  };
  const setZoom = (z) => {
    state.zoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10)); // clamp 50%–200%, 10% steps
    localStorage.setItem('perqZoom', String(state.zoom));
    applyZoom();
    applyGridFreeze();
  };
  $('#zoomOut').onclick = () => setZoom(state.zoom - 0.1);
  $('#zoomIn').onclick = () => setZoom(state.zoom + 0.1);
}

// Freeze key column(s) per grid: on Bookings it's Property Name; on Churn it's PMC Buying
// Center + Property (a contiguous pinned block). The columns before them scroll away normally,
// and once pinned they stick to the left (after the sticky row-number) while the rest scrolls.
// Default pinned (frozen-left) columns per tab. Users can change these via the Columns menu;
// their choice is stored in state.pinnedCols and overrides these defaults.
const BOOKING_FREEZE = ['property_name', 'product', 'mrr'];
const CONVERT_BOOKING_FREEZE = ['category', 'customer_name'];
const CHURN_FREEZE = ['property_id', 'pmc_buying_center', 'property', 'product', 'mrr', 'last_date_under_contract'];
const GRID_FREEZE = { bookings: BOOKING_FREEZE, churn: CHURN_FREEZE };
// The default frozen columns for the active tab (instance-aware for Convert bookings).
function defaultFreeze(tab) {
  if (tab === 'bookings' && isConvert()) return CONVERT_BOOKING_FREEZE;
  return GRID_FREEZE[tab] || [];
}
// The pinned columns for a tab: the user's saved set if any, else the default freeze.
function pinnedFor(tab) {
  const saved = state.pinnedCols[tab];
  return Array.isArray(saved) ? saved : defaultFreeze(tab);
}
function savePinnedCols() { localStorage.setItem('perqPinnedCols', JSON.stringify(state.pinnedCols)); }
function applyGridFreeze() {
  if (!GRID_FREEZE[state.tab]) { $('#gridFreezeStyle').textContent = ''; return; }
  const hidden = new Set(state.hiddenCols[state.tab] || []);
  // Pin in DISPLAY order so the sticky left-offsets accumulate left-to-right, whatever order the
  // user toggled them in.
  const order = fieldsForTab().cols.map((c) => c.key);
  const freezeKeys = pinnedFor(state.tab).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const zoom = state.zoom || 1;
  const rownumTh = $('#thead th.rownum');
  let left = rownumTh ? rownumTh.getBoundingClientRect().width / zoom : 46;
  let css = '';
  for (const key of freezeKeys) {
    if (hidden.has(key)) continue;
    css += `#grid td[data-col="${key}"]{position:sticky;left:${left}px;z-index:2;}`;
    css += `#grid th[data-col="${key}"]{position:sticky;left:${left}px;top:0;z-index:5;}`;
    const th = $(`#thead th[data-col="${key}"]`);
    left += th ? th.getBoundingClientRect().width / zoom : 0;
  }
  $('#gridFreezeStyle').textContent = css;
}

// ---------- Columns show/hide ----------
function saveHiddenCols() { localStorage.setItem('perqHiddenCols', JSON.stringify(state.hiddenCols)); }

// Hide columns via a single CSS rule (no grid rebuild) — instant regardless of row count.
function applyColHide() {
  const hidden = state.hiddenCols[state.tab] || [];
  const selector = hidden.map((k) => `#grid [data-col="${k}"]`).join(',');
  $('#colHideStyle').textContent = selector ? `${selector}{display:none!important;}` : '';
}

// ---------- Adjustable column widths (any user) ----------
// Widths are applied via one generated CSS rule per resized column, keyed off data-col.
// Column-width scope/table. Legacy keeps GoLives and Churn widths separate.
function colWidthScope() { return state.tab === 'legacy' ? `legacy_${state.legacySub}` : state.tab; }
function colWidthTableSel() {
  if (state.tab === 'salessupport') return '#ssTable';
  if (state.tab === 'legacy') return '#legacyTable';
  if (state.tab === 'saas') return '#saasTable';
  return '#grid';
}
function applyColWidths() {
  const widths = state.colWidths[colWidthScope()] || {};
  const t = colWidthTableSel();
  let css = '';
  for (const [key, px] of Object.entries(widths)) {
    css += `${t} [data-col="${key}"]{width:${px}px;min-width:${px}px;max-width:${px}px;overflow:hidden;text-overflow:ellipsis;}`;
    css += `${t} [data-col="${key}"] input,${t} [data-col="${key}"] select{min-width:0;}`;
  }
  $('#colWidthStyle').textContent = css;
}
function setColWidth(key, px) {
  const scope = colWidthScope();
  (state.colWidths[scope] || (state.colWidths[scope] = {}))[key] = px;
  applyColWidths();
}
function saveColWidths() { localStorage.setItem('perqColWidths', JSON.stringify(state.colWidths)); }

// Shared column widths for the dashboard Churn Details tables (applied to every month table so
// they stay aligned). Stored under the 'churn_detail' scope of state.colWidths.
function applyChurnDetailWidths() {
  const widths = state.colWidths.churn_detail || {};
  let css = '';
  for (const [key, px] of Object.entries(widths)) {
    css += `.churn-detail-card [data-col="${key}"]{width:${px}px;min-width:${px}px;max-width:${px}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`;
  }
  $('#churnDetailWidthStyle').textContent = css;
}
function setChurnDetailWidth(key, px) {
  (state.colWidths.churn_detail || (state.colWidths.churn_detail = {}))[key] = px;
  applyChurnDetailWidths();
}

// ---------- Hover popup for long Notes cells ----------
function wireCellTip() {
  const tip = $('#cellTip');
  const tbody = $('#tbody');
  const position = (e) => {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };
  const noteText = (cell) => {
    const ctl = cell.querySelector('input, textarea, select');
    return ((ctl ? ctl.value : cell.textContent) || '').trim();
  };
  tbody.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('[data-col="notes"]');
    const text = cell ? noteText(cell) : '';
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    position(e);
  });
  tbody.addEventListener('mousemove', (e) => {
    if (tip.hidden) return;
    if (e.target.closest('[data-col="notes"]')) position(e);
    else tip.hidden = true;
  });
  tbody.addEventListener('mouseleave', () => { tip.hidden = true; });

  // Sales Support: hovering an "Actual" cell shows the properties booked + amounts behind it.
  const ssBody = $('#ssBody');
  const ACTUAL_COLS = new Set(['m1_actual', 'm2_actual', 'm3_actual', 'q_actual']);
  const ssActualHit = (e) => {
    const cell = e.target.closest('[data-col]');
    if (!cell || !ACTUAL_COLS.has(cell.dataset.col)) return null;
    const tr = cell.closest('[data-ss-id]'); // skip the subtotal row (no id)
    if (!tr) return null;
    const row = state.rows.sales_support.find((r) => String(r.id) === tr.dataset.ssId);
    return row ? { col: cell.dataset.col, row } : null;
  };
  ssBody.addEventListener('mouseover', (e) => {
    const hit = ssActualHit(e);
    const html = hit ? ssActualTipHtml(hit.row, hit.col) : '';
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html;
    tip.hidden = false;
    position(e);
  });
  ssBody.addEventListener('mousemove', (e) => {
    if (tip.hidden) return;
    if (ssActualHit(e)) position(e); else tip.hidden = true;
  });
  ssBody.addEventListener('mouseleave', () => { tip.hidden = true; });
}

function wireResize() {
  let active = null; // { key, startX, startW }
  let pendingPx = null;
  let rafId = 0;
  // Apply at most once per animation frame so dragging never stacks up reflows (the big
  // Legacy / no-pagination tables would otherwise freeze on every mousemove).
  const flush = () => {
    rafId = 0;
    if (!active || pendingPx === null) return;
    if (active.churnDetail) { setChurnDetailWidth(active.key, pendingPx); return; }
    if (active.billingDetail) { setBillingDetailWidth(active.key, pendingPx); return; }
    setColWidth(active.key, pendingPx);
    if (state.tab === 'salessupport') ssApplyFreeze();
    if (state.tab === 'bookings' || state.tab === 'churn') applyGridFreeze();
  };
  // Listen on document so the grid (#grid), Sales Support (#ssTable), Legacy, the dashboard
  // Churn Details, and the Billing Dashboard drill-down tables all work.
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.col-resize');
    if (!handle) return;
    const th = handle.closest('th');
    if (!th || !th.dataset.col) return;
    e.preventDefault();
    const churnDetail = !!th.closest('.churn-detail-card');
    const billingDetail = !churnDetail && !!th.closest('.bd-detail');
    const zoom = (churnDetail || billingDetail) ? 1
      : state.tab === 'legacy' ? (state.legacyZoom || 1)
        : state.tab === 'saas' ? (state.saasZoom || 1)
          : (state.zoom || 1);
    active = { key: th.dataset.col, startX: e.clientX, startW: th.getBoundingClientRect().width / zoom, zoom, churnDetail, billingDetail };
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!active) return;
    const delta = (e.clientX - active.startX) / (active.zoom || 1);
    pendingPx = Math.max(48, Math.min(900, Math.round(active.startW + delta)));
    if (!rafId) rafId = requestAnimationFrame(flush);
  });
  document.addEventListener('mouseup', () => {
    if (!active) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (pendingPx !== null) {
      if (active.churnDetail) { setChurnDetailWidth(active.key, pendingPx); }
      else if (active.billingDetail) { setBillingDetailWidth(active.key, pendingPx); }
      else { setColWidth(active.key, pendingPx); if (state.tab === 'salessupport') ssApplyFreeze(); applyGridFreeze(); }
    }
    saveColWidths();
    active = null;
    pendingPx = null;
    document.body.style.cursor = '';
  });
}

function renderColMenu() {
  const { cols } = fieldsForTab();
  const hidden = state.hiddenCols[state.tab] || [];
  const canPin = !!GRID_FREEZE[state.tab]; // pinning applies to the Bookings & Churn grids
  const pinned = new Set(pinnedFor(state.tab));
  const items = cols.map((f) => {
    const vis = `<label class="col-vis"><input type="checkbox" data-col="${f.key}"${hidden.includes(f.key) ? '' : ' checked'} /> ${escapeHtml(f.label)}</label>`;
    const pin = canPin
      ? `<button type="button" class="col-pin${pinned.has(f.key) ? ' pinned' : ''}" data-pin="${f.key}" title="${pinned.has(f.key) ? 'Unpin' : 'Pin'} column">📌</button>`
      : '';
    return `<div class="col-item">${vis}${pin}</div>`;
  }).join('');
  const resetPins = canPin ? '<button type="button" class="view-btn" id="colResetPins">Reset pins</button>' : '';
  $('#colMenu').innerHTML =
    `<div class="col-menu-head"><span>${canPin ? 'Show / pin columns' : 'Show columns'}</span>`
    + `<span class="col-menu-actions"><button type="button" class="view-btn" id="colShowAll">Show all</button>${resetPins}</span></div>`
    + items;
}

function wireColumns() {
  $('#colBtn').onclick = () => {
    const menu = $('#colMenu');
    if (menu.hidden) { renderColMenu(); menu.hidden = false; } else { menu.hidden = true; }
  };
  // Toggle a single column.
  $('#colMenu').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-col]');
    if (!cb) return;
    const hidden = state.hiddenCols[state.tab] || (state.hiddenCols[state.tab] = []);
    const i = hidden.indexOf(cb.dataset.col);
    if (cb.checked && i >= 0) hidden.splice(i, 1);
    else if (!cb.checked && i < 0) hidden.push(cb.dataset.col);
    saveHiddenCols();
    applyColHide();
    applyGridFreeze();
  });
  $('#colMenu').addEventListener('click', (e) => {
    // Pin / unpin a column (frozen-left).
    const pinBtn = e.target.closest('[data-pin]');
    if (pinBtn) {
      const key = pinBtn.dataset.pin;
      const cur = pinnedFor(state.tab).slice();
      const i = cur.indexOf(key);
      if (i >= 0) cur.splice(i, 1); else cur.push(key);
      state.pinnedCols[state.tab] = cur;
      savePinnedCols();
      renderColMenu(); applyGridFreeze();
      return;
    }
    // "Reset pins" restores this tab's default pinned columns.
    if (e.target.id === 'colResetPins') {
      delete state.pinnedCols[state.tab];
      savePinnedCols();
      renderColMenu(); applyGridFreeze();
      return;
    }
    // "Show all" resets visibility for the current tab.
    if (e.target.id !== 'colShowAll') return;
    state.hiddenCols[state.tab] = [];
    saveHiddenCols();
    renderColMenu(); applyColHide(); applyGridFreeze();
  });
  // Click outside closes the menu.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.col-menu-wrap')) $('#colMenu').hidden = true;
  });
  // Click a header's sort arrow to sort the grid: unsorted -> ascending -> descending -> unsorted.
  $('#thead').addEventListener('click', (e) => {
    const btn = e.target.closest('.col-sort');
    if (!btn) return;
    const tab = state.tab;
    if (tab !== 'bookings' && tab !== 'churn') return;
    const key = btn.dataset.sort;
    const cur = state.sort[tab] || { key: null, dir: 0 };
    let dir;
    if (cur.key !== key) dir = 1;          // new column -> ascending (lowest to greatest)
    else if (cur.dir === 1) dir = -1;      // ascending -> descending (greatest to lowest)
    else if (cur.dir === -1) dir = 0;      // descending -> back to original order
    else dir = 1;
    state.sort[tab] = { key: dir === 0 ? null : key, dir };
    state.page[tab] = 1; // jump back to the first page of the newly sorted set
    renderHead();
    renderBody();
  });
}

// ---------- Login / logout ----------
function showLogin() { $('#loginModal').hidden = false; $('#loginUser').focus(); }
function hideLogin() { $('#loginModal').hidden = true; }

function logout() {
  state.token = '';
  state.user = null;
  state.adminToken = '';
  localStorage.removeItem('perqToken');
  localStorage.removeItem('perqAdminToken'); // also drop any impersonation
  // Reload to a clean login screen (clears all logged-in UI/state reliably).
  location.reload();
}

// ---------- Impersonation ("log in as") ----------
// Admin only: swap the session to another user's token, keeping the admin token so we can
// switch back. No page reload — we just reload the data as the target user.
async function impersonate(id) {
  const { token, user } = await api(`/api/impersonate/${id}`, { method: 'POST' });
  if (!state.adminToken) { // remember the real admin token the first time
    state.adminToken = state.token;
    localStorage.setItem('perqAdminToken', state.adminToken);
  }
  state.token = token;
  state.user = user;
  localStorage.setItem('perqToken', token);
  $('#usersModal').hidden = true;
  state.tab = 'dashboard';
  await loadAll();
  renderImpersonationBanner();
  toast(`Now viewing as ${user.username}`);
}
async function returnToAdmin() {
  if (!state.adminToken) return;
  state.token = state.adminToken;
  localStorage.setItem('perqToken', state.adminToken);
  state.adminToken = '';
  localStorage.removeItem('perqAdminToken');
  state.tab = 'dashboard';
  await loadAll();
  renderImpersonationBanner();
  toast('Back to your admin account');
}
function renderImpersonationBanner() {
  const bar = $('#impersonationBar');
  if (!bar) return;
  const on = !!(state.adminToken && state.user);
  if (on) $('#impUser').textContent = `${state.user.username} (${ROLE_LABELS[state.user.role] || state.user.role})`;
  bar.hidden = !on;
}

async function doLogin() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  // Login intentionally bypasses api() so a 401 shows an error instead of triggering logout.
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('bad');
    const { token, user } = await res.json();
    state.token = token; state.user = user;
    localStorage.setItem('perqToken', token);
    $('#loginErr').textContent = '';
    $('#loginPass').value = '';
    hideLogin();
    await loadAll();
  } catch {
    $('#loginErr').textContent = 'Invalid username or password.';
  }
}

function wireAuth() {
  $('#loginBtn').onclick = doLogin;
  $('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass').focus(); });
  $('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#logoutBtn').onclick = logout;

  // Forgot password -> reveal the "ask an admin" note (admin resets via Users panel).
  $('#forgotLink').onclick = (e) => { e.preventDefault(); $('#forgotHelp').hidden = !$('#forgotHelp').hidden; };

  // User dropdown (username/role -> Change password / Log out).
  $('#userBtn').onclick = () => { const m = $('#userMenu'); m.hidden = !m.hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.user-wrap')) $('#userMenu').hidden = true; });

  // Self-service change password.
  $('#changePwBtn').onclick = () => {
    $('#userMenu').hidden = true;
    ['pwCurrent', 'pwNew', 'pwConfirm'].forEach((id) => { $('#' + id).value = ''; });
    $('#pwErr').textContent = '';
    $('#passwordModal').hidden = false;
    $('#pwCurrent').focus();
  };
  $('#pwClose').onclick = () => { $('#passwordModal').hidden = true; };
  $('#passwordModal').addEventListener('click', (e) => { if (e.target.id === 'passwordModal') $('#passwordModal').hidden = true; });
  $('#pwSubmit').onclick = changePassword;
  $('#pwConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') changePassword(); });
}

async function changePassword() {
  const currentPassword = $('#pwCurrent').value;
  const newPassword = $('#pwNew').value;
  if (newPassword !== $('#pwConfirm').value) { $('#pwErr').textContent = 'New passwords do not match.'; return; }
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    $('#passwordModal').hidden = true;
    toast('Password updated');
  } catch (err) { $('#pwErr').textContent = err.message; }
}

// ---------- Users admin panel ----------
const ROLE_LABELS = { admin: 'Admin', standard: 'Standard', sales_admin: 'Sales Admin', sales: 'Sales', billing: 'Billing', viewer: 'Viewer' };

// Distinct Account Owner full names from the loaded Salesforce Recon data (admin has it).
function reconOwnerList() {
  return [...new Set((state.rows.salesforce_recon || [])
    .map((r) => String(r.account_owner ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function ownerOptionsHtml(current) {
  const cur = current || '';
  return ['<option value="">— pick Account Owner —</option>']
    .concat(reconOwnerList().map((o) => `<option value="${escapeAttr(o)}"${o === cur ? ' selected' : ''}>${escapeHtml(o)}</option>`))
    .join('');
}

async function openUsers() { $('#usersModal').hidden = false; renderConnectorStatus(); await renderUsersList(); }

// Claude connector (remote MCP) on/off status — so an admin can confirm it's live without reading
// Railway logs. Enabled when the server has MCP_ENABLE=true + APP_BASE_URL (see /api/schema).
function renderConnectorStatus() {
  const el = document.getElementById('connectorStatus');
  if (!el) return;
  const c = (state.schema && state.schema.connector) || { enabled: false, mcpUrl: null };
  if (c.enabled && c.mcpUrl) {
    el.className = 'connector-status on';
    el.innerHTML = '<span class="connector-dot"></span>'
      + '<div class="connector-body"><strong>Claude connector: On</strong>'
      + '<div class="connector-sub">Add it in claude.ai → Settings → Connectors → Add custom → Web, using this URL:</div>'
      + `<div class="connector-url"><code id="connectorUrl">${escapeHtml(c.mcpUrl)}</code>`
      + '<button type="button" class="view-btn" id="connectorCopy">Copy</button></div>'
      + '<div class="connector-sub">Each teammate connects and signs in with their Revenue Desk login. Read-only.</div></div>';
  } else {
    el.className = 'connector-status off';
    el.innerHTML = '<span class="connector-dot"></span>'
      + '<div class="connector-body"><strong>Claude connector: Off</strong>'
      + '<div class="connector-sub">To turn it on, set <code>MCP_ENABLE=true</code> and <code>APP_BASE_URL</code> '
      + '(the app’s public https URL) on the Railway app service, then redeploy.</div></div>';
  }
}

// The sections a given user currently sees (admins all; explicit allow-list if set; else defaults).
function effectiveSectionsFor(u) {
  if (u.role === 'admin') return ALL_SECTION_KEYS.slice();
  return (Array.isArray(u.section_access) && u.section_access.length) ? u.section_access : roleDefaultSections(u.role);
}
// Summary label for a user's section-access dropdown.
function sectionSummary(count, explicit) {
  if (!explicit) return `Role default · ${count}`;
  if (count === 0) return 'Role default';
  if (count === ALL_SECTION_KEYS.length) return 'All sections';
  return `${count} section${count === 1 ? '' : 's'}`;
}
// Per-user section access as a multiselect dropdown (checkbox list). Admins get a static "all" note;
// everyone else gets a compact dropdown pre-checked to what they see today. Toggling switches them
// to an explicit allow-list; "Reset to role default" clears it back to the role's defaults.
function sectionAccessHtml(u) {
  if (u.role === 'admin') return '<div class="user-sections muted">Section access: <em>all sections (admin)</em></div>';
  const eff = new Set(effectiveSectionsFor(u));
  const explicit = !!(Array.isArray(u.section_access) && u.section_access.length);
  const list = ALL_SECTION_KEYS.map((k) =>
    `<label class="ms-opt"><input type="checkbox" data-sec-box="${u.id}" value="${escapeAttr(k)}"${eff.has(k) ? ' checked' : ''}/><span>${escapeHtml(TAB_LABELS[k] || k)}</span></label>`).join('');
  return '<div class="user-sections"><span class="sec-lbl">Sections</span>'
    + `<div class="ms sec-ms" data-sec-ms="${u.id}">`
    + `<button type="button" class="ms-btn" data-sec-btn="${u.id}"><span class="ms-label">${escapeHtml(sectionSummary(eff.size, explicit))}</span><span class="ms-caret">▾</span></button>`
    + `<div class="ms-menu" hidden><div class="ms-tools"><button type="button" class="ms-clear" data-sec-clear="${u.id}">Reset to role default</button></div>`
    + `<div class="ms-list">${list}</div></div></div></div>`;
}

async function renderUsersList() {
  try {
    const users = await api('/api/users');
    $('#usersList').innerHTML = users.map((u) => {
      const opts = Object.keys(ROLE_LABELS).map((r) =>
        `<option value="${r}"${r === u.role ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
      const ownerSel = u.role === 'sales'
        ? `<select data-owner-for="${u.id}" title="Tagged Account Owner">${ownerOptionsHtml(u.account_owner)}</select>` : '';
      // "Log in as" for everyone except yourself.
      const impBtn = (state.user && u.id === state.user.id) ? ''
        : `<button type="button" class="view-btn" data-imp-user="${u.id}" data-imp-name="${escapeAttr(u.username)}">Log in as</button>`;
      // Convert-instance access (admins always have it, so the toggle is only meaningful for others).
      const convChk = u.role === 'admin'
        ? '<label class="user-convert muted" title="Admins always have Convert access"><input type="checkbox" checked disabled /> Convert</label>'
        : `<label class="user-convert" title="Grant access to the Convert instance"><input type="checkbox" data-convert-for="${u.id}"${u.convert_access ? ' checked' : ''} /> Convert</label>`;
      return `<div class="user-row">
        <span class="user-name">${escapeHtml(u.username)}</span>
        <button type="button" class="view-btn" data-rename-user="${u.id}" data-rename-name="${escapeAttr(u.username)}" title="Change this user's login username">Rename</button>
        <select data-role-for="${u.id}">${opts}</select>
        ${ownerSel}
        ${convChk}
        ${impBtn}
        <button type="button" class="view-btn" data-pw-user="${u.id}">Reset password</button>
        <button type="button" class="view-btn danger" data-del-user="${u.id}">Delete</button>
        ${sectionAccessHtml(u)}
      </div>`;
    }).join('');
  } catch (e) { $('#usersList').innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}

// ---------- Products (admin-managed product list) ----------
function bprCategoryOptions() {
  return (state.schema && state.schema.bprCategories)
    || ['Software', 'Pulse', 'Website', 'Digital Advertising', 'Tools for Google'];
}
function catOptionsHtml(selected) {
  return bprCategoryOptions().map((c) =>
    `<option value="${escapeAttr(c)}"${c === selected ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
}
async function openProducts() {
  $('#productsModal').hidden = false;
  $('#newProductCat').innerHTML = catOptionsHtml('Software');
  await renderProductsList();
}
async function renderProductsList() {
  try {
    const products = await api('/api/products');
    if (!products.length) { $('#productsList').innerHTML = '<p class="muted" style="padding:10px">No products yet — add one below.</p>'; return; }
    $('#productsList').innerHTML = products.map((p) => `<div class="user-row">
        <span class="user-name">${escapeHtml(p.name)}</span>
        <select data-prodcat-for="${p.id}">${catOptionsHtml(p.bpr_category)}</select>
        <button type="button" class="view-btn danger" data-del-product="${p.id}">Remove</button>
      </div>`).join('');
  } catch (e) { $('#productsList').innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}
// After any product change, refresh the schema so Product dropdowns everywhere pick up the change.
async function refreshAfterProductChange() {
  state.schema = await api('/api/schema');
  renderAll();
}
function wireProducts() {
  $('#productsBtn').onclick = () => { $('#userMenu').hidden = true; openProducts(); };
  $('#productsClose').onclick = () => { $('#productsModal').hidden = true; };

  $('#addProductForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#newProductName').value.trim();
    const bpr_category = $('#newProductCat').value;
    if (!name) { $('#addProductErr').textContent = 'Enter a product name.'; return; }
    try {
      await api('/api/products', { method: 'POST', body: JSON.stringify({ name, bpr_category }) });
      $('#newProductName').value = ''; $('#addProductErr').textContent = '';
      toast('Product added');
      await renderProductsList();
      await refreshAfterProductChange();
    } catch (err) { $('#addProductErr').textContent = err.message; }
  });

  // Change a product's BPR Category.
  $('#productsList').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-prodcat-for]');
    if (!sel) return;
    try {
      await api(`/api/products/${sel.dataset.prodcatFor}`, { method: 'PATCH', body: JSON.stringify({ bpr_category: sel.value }) });
      toast('Category updated');
      await refreshAfterProductChange();
    } catch (err) { toast(err.message, true); }
  });

  // Remove a product (only hides it from the dropdown; existing bookings keep their product).
  $('#productsList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-product]');
    if (!del) return;
    if (!confirm('Remove this product from the list? Existing bookings keep their product; it just won’t appear in the dropdown.')) return;
    try {
      await api(`/api/products/${del.dataset.delProduct}`, { method: 'DELETE' });
      toast('Product removed');
      await renderProductsList();
      await refreshAfterProductChange();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- Product Bundles (admin-managed named packages of products) ----------
async function openBundles() { $('#bundlesModal').hidden = false; await renderBundlesList(); }
function bundleSummary(count) { return count ? `${count} product${count === 1 ? '' : 's'}` : 'No products'; }
async function renderBundlesList() {
  try {
    const [bundles, products] = await Promise.all([api('/api/product-bundles'), api('/api/products')]);
    if (!bundles.length) { $('#bundlesList').innerHTML = '<p class="muted" style="padding:10px">No bundles yet — add one below.</p>'; return; }
    $('#bundlesList').innerHTML = bundles.map((b) => {
      const sel = new Set((b.product_ids || []).map(Number));
      const list = products.length
        ? products.map((p) => `<label class="ms-opt"><input type="checkbox" data-bundle-box="${b.id}" value="${p.id}"${sel.has(Number(p.id)) ? ' checked' : ''}/><span>${escapeHtml(p.name)}</span></label>`).join('')
        : '<div class="ms-empty">No products yet</div>';
      const count = products.filter((p) => sel.has(Number(p.id))).length;
      return `<div class="user-row" data-bundle="${b.id}">
        <input type="text" class="bundle-name" data-bundle-name="${b.id}" value="${escapeAttr(b.name)}" title="Bundle name" />
        <div class="ms bundle-ms" data-bundle-ms="${b.id}">
          <button type="button" class="ms-btn" data-bundle-btn="${b.id}"><span class="ms-label">${escapeHtml(bundleSummary(count))}</span><span class="ms-caret">▾</span></button>
          <div class="ms-menu" hidden><div class="ms-list">${list}</div></div>
        </div>
        <button type="button" class="view-btn danger" data-del-bundle="${b.id}">Remove</button>
      </div>`;
    }).join('');
  } catch (e) { $('#bundlesList').innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}
function wireBundles() {
  $('#bundlesBtn').onclick = () => { $('#userMenu').hidden = true; openBundles(); };
  $('#bundlesClose').onclick = () => { $('#bundlesModal').hidden = true; };

  $('#addBundleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#newBundleName').value.trim();
    if (!name) { $('#addBundleErr').textContent = 'Enter a bundle name.'; return; }
    try {
      await api('/api/product-bundles', { method: 'POST', body: JSON.stringify({ name }) });
      $('#newBundleName').value = ''; $('#addBundleErr').textContent = '';
      toast('Bundle added');
      await renderBundlesList();
    } catch (err) { $('#addBundleErr').textContent = err.message; }
  });

  const list = $('#bundlesList');
  list.addEventListener('change', async (e) => {
    // Rename a bundle.
    const nm = e.target.closest('[data-bundle-name]');
    if (nm) {
      const v = nm.value.trim();
      if (!v) { toast('Bundle name cannot be blank.', true); renderBundlesList(); return; }
      try { await api(`/api/product-bundles/${nm.dataset.bundleName}`, { method: 'PATCH', body: JSON.stringify({ name: v }) }); toast('Bundle renamed'); }
      catch (err) { toast(err.message, true); renderBundlesList(); }
      return;
    }
    // Toggle a product in/out of the bundle (keeps the open dropdown; updates the label in place).
    const box = e.target.closest('[data-bundle-box]');
    if (box) {
      const id = box.dataset.bundleBox;
      const ids = [...list.querySelectorAll(`[data-bundle-box="${id}"]`)].filter((c) => c.checked).map((c) => Number(c.value));
      try {
        await api(`/api/product-bundles/${id}`, { method: 'PATCH', body: JSON.stringify({ product_ids: ids }) });
        const label = document.querySelector(`[data-bundle-ms="${id}"] .ms-label`);
        if (label) label.textContent = bundleSummary(ids.length);
        toast('Bundle updated');
      } catch (err) { toast(err.message, true); box.checked = !box.checked; }
    }
  });
  const closeBundleMenus = () => list.querySelectorAll('.bundle-ms .ms-menu:not([hidden])').forEach((m) => { m.hidden = true; });
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bundle-btn]');
    if (btn) {
      const menu = btn.parentElement.querySelector('.ms-menu');
      const willOpen = menu.hidden;
      closeBundleMenus();
      if (willOpen) menu.hidden = false;
      e.stopPropagation();
      return;
    }
    const del = e.target.closest('[data-del-bundle]');
    if (del) {
      if (!confirm('Remove this bundle? (Products themselves are not affected.)')) return;
      try { await api(`/api/product-bundles/${del.dataset.delBundle}`, { method: 'DELETE' }); toast('Bundle removed'); renderBundlesList(); }
      catch (err) { toast(err.message, true); }
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.bundle-ms')) closeBundleMenus(); });
}

// ---------- Close Month (admin month-end lock) ----------
async function openCloseMonth() {
  $('#closeMonthModal').hidden = false;
  $('#closeMonthMonth').innerHTML = MONTHS.map((m) => `<option value="${m}">${m}</option>`).join('');
  const now = new Date();
  $('#closeMonthMonth').value = MONTHS[now.getMonth()];
  if (!$('#closeMonthYear').value) $('#closeMonthYear').value = String(now.getFullYear());
  if (!$('#closeMonthDate').value) $('#closeMonthDate').value = now.toISOString().slice(0, 10);
  renderCloseMonthList();
}
function renderCloseMonthList() {
  const rows = state.closedMonthsList || [];
  if (!rows.length) { $('#closeMonthList').innerHTML = '<p class="muted" style="padding:10px">No months are closed yet.</p>'; return; }
  $('#closeMonthList').innerHTML = sortMonthYear(rows.map((r) => r.month)).reverse().map((month) => {
    const r = rows.find((x) => x.month === month);
    const cd = r ? String(r.close_date).slice(0, 10) : '';
    return `<div class="user-row">
        <span class="user-name">${escapeHtml(month)}</span>
        <span class="muted">closed ${escapeHtml(cd)}${r && r.closed_by ? ` · by ${escapeHtml(r.closed_by)}` : ''}</span>
        <button type="button" class="view-btn danger" data-reopen-month="${escapeAttr(month)}">Reopen</button>
      </div>`;
  }).join('');
}
async function refreshAfterClosedMonthChange() {
  await loadClosedMonths();
  renderCloseMonthList();
  renderSummary(); // churn carry-over depends on closed months
}
function wireCloseMonth() {
  $('#closeMonthBtn').onclick = () => { $('#userMenu').hidden = true; openCloseMonth(); };
  $('#closeMonthClose').onclick = () => { $('#closeMonthModal').hidden = true; };
  $('#closeMonthModal').addEventListener('click', (e) => { if (e.target.id === 'closeMonthModal') $('#closeMonthModal').hidden = true; });
  $('#closeMonthForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const month = `${$('#closeMonthMonth').value} ${String($('#closeMonthYear').value).trim()}`.trim();
    const close_date = $('#closeMonthDate').value;
    if (!$('#closeMonthYear').value || !close_date) { $('#closeMonthErr').textContent = 'Pick a month, year, and official close date.'; return; }
    try {
      await api('/api/closed-months', { method: 'POST', body: JSON.stringify({ month, close_date }) });
      $('#closeMonthErr').textContent = '';
      toast(`Closed ${month}`);
      await refreshAfterClosedMonthChange();
    } catch (err) { $('#closeMonthErr').textContent = err.message; }
  });
  $('#closeMonthList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-reopen-month]');
    if (!btn) return;
    const month = btn.dataset.reopenMonth;
    if (!confirm(`Reopen ${month}? Carried-over churn will return to ${month}.`)) return;
    try {
      await api(`/api/closed-months/${encodeURIComponent(month)}`, { method: 'DELETE' });
      toast(`Reopened ${month}`);
      await refreshAfterClosedMonthChange();
    } catch (err) { toast(err.message, true); }
  });
}

function wireUsers() {
  $('#usersBtn').onclick = () => { $('#userMenu').hidden = true; openUsers(); };
  $('#usersClose').onclick = () => { $('#usersModal').hidden = true; };

  // Copy the connector's MCP URL to the clipboard.
  $('#connectorStatus').addEventListener('click', async (e) => {
    if (!e.target.closest('#connectorCopy')) return;
    const url = (document.getElementById('connectorUrl') || {}).textContent || '';
    try { await navigator.clipboard.writeText(url); toast('Connector URL copied'); }
    catch { toast(url, false); }
  });

  // Show/populate the Account Owner picker only for the Sales role.
  $('#newUserRole').addEventListener('change', () => {
    const sales = $('#newUserRole').value === 'sales';
    const sel = $('#newUserOwner');
    sel.hidden = !sales;
    if (sales) sel.innerHTML = ownerOptionsHtml('');
  });

  $('#addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#newUserName').value.trim();
    const password = $('#newUserPass').value;
    const role = $('#newUserRole').value;
    const account_owner = role === 'sales' ? $('#newUserOwner').value : undefined;
    if (role === 'sales' && !account_owner) { $('#addUserErr').textContent = 'Pick the Account Owner this Sales user is tied to.'; return; }
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role, account_owner }) });
      $('#newUserName').value = ''; $('#newUserPass').value = ''; $('#addUserErr').textContent = '';
      $('#newUserRole').value = 'standard'; $('#newUserOwner').hidden = true;
      toast('User added');
      renderUsersList();
    } catch (err) { $('#addUserErr').textContent = err.message; }
  });

  // Change a user's role or (for Sales) their tagged Account Owner.
  $('#usersList').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role-for]');
    if (sel) {
      try {
        await api(`/api/users/${sel.dataset.roleFor}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) });
        toast('Role updated');
      } catch (err) { toast(err.message, true); }
      renderUsersList();
      return;
    }
    const own = e.target.closest('[data-owner-for]');
    if (own) {
      try {
        await api(`/api/users/${own.dataset.ownerFor}`, { method: 'PATCH', body: JSON.stringify({ account_owner: own.value }) });
        toast('Account Owner updated');
      } catch (err) { toast(err.message, true); }
      return;
    }
    const conv = e.target.closest('[data-convert-for]');
    if (conv) {
      try {
        await api(`/api/users/${conv.dataset.convertFor}`, { method: 'PATCH', body: JSON.stringify({ convert_access: conv.checked }) });
        toast(conv.checked ? 'Convert access granted' : 'Convert access removed');
      } catch (err) { toast(err.message, true); conv.checked = !conv.checked; }
      return;
    }
    // Section access: gather every ticked section for this user and save it as the explicit
    // allow-list. Unticking everything sends [] -> the user falls back to their role defaults.
    // Update the dropdown's summary label in place so the open menu stays open while ticking.
    const sec = e.target.closest('[data-sec-box]');
    if (sec) {
      const uid = sec.dataset.secBox;
      const boxes = [...$('#usersList').querySelectorAll(`[data-sec-box="${uid}"]`)];
      const checked = boxes.filter((b) => b.checked).map((b) => b.value);
      try {
        await api(`/api/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ section_access: checked }) });
        toast('Section access updated');
        if (!checked.length) {
          renderUsersList(); // emptied -> falls back to role default; re-render to show that state
        } else {
          const label = document.querySelector(`[data-sec-ms="${uid}"] .ms-label`);
          if (label) label.textContent = sectionSummary(checked.length, true);
        }
      } catch (err) { toast(err.message, true); sec.checked = !sec.checked; }
    }
  });

  // Open/close a section-access dropdown (only one open at a time).
  const closeSecMenus = () => $('#usersList').querySelectorAll('.sec-ms .ms-menu:not([hidden])').forEach((m) => { m.hidden = true; });
  $('#usersList').addEventListener('click', async (e) => {
    const secBtn = e.target.closest('[data-sec-btn]');
    if (secBtn) {
      const menu = secBtn.parentElement.querySelector('.ms-menu');
      const willOpen = menu.hidden;
      closeSecMenus();
      if (willOpen) menu.hidden = false;
      e.stopPropagation();
      return;
    }
    // Reset a user's section access to their role default (clears the explicit allow-list).
    const secClear = e.target.closest('[data-sec-clear]');
    if (secClear) {
      const uid = secClear.dataset.secClear;
      try {
        await api(`/api/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ section_access: [] }) });
        toast('Reset to role default');
        renderUsersList();
      } catch (err) { toast(err.message, true); }
      e.stopPropagation();
      return;
    }
  });
  // Clicking outside an open section dropdown closes it.
  document.addEventListener('click', (e) => { if (!e.target.closest('.sec-ms')) closeSecMenus(); });

  // Reset password / delete / log in as.
  $('#usersList').addEventListener('click', async (e) => {
    const imp = e.target.closest('[data-imp-user]');
    if (imp) {
      if (!confirm(`Log in as ${imp.dataset.impName}?\n\nYou'll see the app exactly as they do. Use “Return to admin” at the top to switch back.`)) return;
      try { await impersonate(imp.dataset.impUser); } catch (err) { toast(err.message, true); }
      return;
    }
    const del = e.target.closest('[data-del-user]');
    if (del) {
      if (!confirm('Delete this user?')) return;
      try { await api(`/api/users/${del.dataset.delUser}`, { method: 'DELETE' }); toast('User deleted'); renderUsersList(); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const pw = e.target.closest('[data-pw-user]');
    if (pw) {
      const np = prompt('New password for this user:');
      if (!np) return;
      try { await api(`/api/users/${pw.dataset.pwUser}`, { method: 'PATCH', body: JSON.stringify({ password: np }) }); toast('Password reset'); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const rn = e.target.closest('[data-rename-user]');
    if (rn) {
      const cur = rn.dataset.renameName || '';
      const nu = prompt('New username (for billing/admin accounts this is also the notification email):', cur);
      if (nu === null) return; // cancelled
      const trimmed = nu.trim();
      if (!trimmed || trimmed === cur) return;
      try {
        await api(`/api/users/${rn.dataset.renameUser}`, { method: 'PATCH', body: JSON.stringify({ username: trimmed }) });
        // If you renamed your OWN account, refresh the session view so it reflects the new name.
        if (state.user && String(state.user.id) === String(rn.dataset.renameUser)) {
          try { const { user } = await api('/api/me'); state.user = user; } catch { /* non-fatal */ }
        }
        toast('Username updated');
        renderUsersList();
      } catch (err) { toast(err.message, true); }
    }
  });
}

// ---------- Notifications ----------
// The bell shows only notifications not yet acknowledged (✕). Resolving on the dashboard
// removes them entirely; bell ✕ just hides them here without resolving the warning.
function bellNotifs() { return (state.notifications || []).filter((n) => !n.dismissed); }
function updateBell() { const c = bellNotifs().length; $('#notifCount').textContent = c ? String(c) : ''; }
function renderNotifMenu() {
  const list = bellNotifs();
  $('#notifMenu').innerHTML = list.length
    ? list.map((n) => `<div class="notif-item" data-go="${n.booking_id}" data-tab="${n.target_tab || 'bookings'}"><span class="notif-msg">${escapeHtml(n.message)}</span><button type="button" class="notif-x" data-dismiss="${n.id}" title="Dismiss">✕</button></div>`).join('')
    : '<div class="notif-empty">No notifications</div>';
}

function wireNotifications() {
  $('#notifBtn').onclick = () => { renderNotifMenu(); const m = $('#notifMenu'); m.hidden = !m.hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.notif-wrap')) $('#notifMenu').hidden = true; });
  $('#notifMenu').addEventListener('click', async (e) => {
    const dis = e.target.closest('[data-dismiss]');
    if (dis) {
      e.stopPropagation();
      try {
        state.notifications = await api(`/api/notifications/${dis.dataset.dismiss}/dismiss`, { method: 'POST' });
        renderNotifMenu();
        updateBell();
      } catch (err) { toast(err.message, true); }
      return;
    }
    const item = e.target.closest('[data-go]');
    if (item) { $('#notifMenu').hidden = true; gotoRow(item.dataset.tab || 'bookings', item.dataset.go); }
  });
}

// Navigate to a specific line item: open its tab (Bookings or Churn), clear filters,
// page to it, and flash the row.
function gotoRow(tab, id) {
  if (tab !== 'bookings' && tab !== 'churn') tab = 'bookings';
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  state.filters[tab] = {}; // clear all filters so the target row is visible
  state.quickFilter[tab] = { col: '', text: '' };
  const rows = currentRows(tab);
  const idx = rows.findIndex((r) => String(r.id) === String(id));
  if (idx >= 0) {
    const size = state.pageSize === 'all' ? (rows.length || 1) : Number(state.pageSize);
    state.page[tab] = Math.floor(idx / size) + 1;
  }
  closeSidebar();
  renderAll();
  const tr = $(`#tbody tr[data-id="${id}"]`);
  if (tr) {
    tr.scrollIntoView({ block: 'center' });
    tr.classList.add('row-flash');
    setTimeout(() => tr.classList.remove('row-flash'), 2500);
  }
}

// ---------- "Ask Claude" assistant ----------
function renderAiMessages() {
  const box = $('#aiMessages');
  if (!state.aiHistory.length && !state.aiBusy) {
    box.innerHTML = '<div class="ai-empty">Ask me anything about the Revenue Desk —<br>bookings, churn, billing status, or your sales numbers.</div>';
    return;
  }
  const bubbles = state.aiHistory.map((m) =>
    `<div class="ai-msg ${m.role === 'user' ? 'user' : (m.error ? 'err' : 'bot')}">${escapeHtml(m.content)}</div>`).join('');
  box.innerHTML = bubbles + (state.aiBusy ? '<div class="ai-typing">Claude is thinking…</div>' : '');
  box.scrollTop = box.scrollHeight;
}
function setAiOpen(open) {
  $('#aiPanel').hidden = !open;
  $('#aiBubble').textContent = open ? '▾' : '✦';
  if (open) { renderAiMessages(); setTimeout(() => $('#aiInput').focus(), 50); }
}
async function sendAiMessage(text) {
  if (state.aiBusy || !text.trim()) return;
  state.aiHistory.push({ role: 'user', content: text.trim() });
  state.aiBusy = true;
  renderAiMessages();
  $('#aiSend').disabled = true;
  try {
    // Send only the role/content turns (drop our local error flags) as the conversation.
    const messages = state.aiHistory.map((m) => ({ role: m.role, content: m.content }));
    const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages }) });
    state.aiHistory.push({ role: 'assistant', content: data.reply || '(no response)' });
  } catch (err) {
    state.aiHistory.push({ role: 'assistant', content: err.message || 'Something went wrong.', error: true });
  } finally {
    state.aiBusy = false;
    $('#aiSend').disabled = false;
    renderAiMessages();
  }
}
function wireAssistant() {
  $('#aiBubble').onclick = () => setAiOpen($('#aiPanel').hidden);
  $('#aiClose').onclick = () => setAiOpen(false);
  $('#aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#aiInput');
    const text = inp.value;
    inp.value = '';
    sendAiMessage(text);
  });
}

// ---------- SaaS Financials (computed MRR-movement view, per property + category) ----------
// Digital Advertising = the existing "Digital Advertising" bpr category; everything else = Multifamily.
function saasCategoryOf(b) {
  return String(b.bpr_prod_category || '').trim() === 'Digital Advertising' ? 'Digital Advertising' : 'Multifamily';
}
// The Category dropdown keeps its internal keys ('Multifamily' = non-DA products, 'Digital
// Advertising' = DA products) but is shown to users as Software / Professional Services, plus All.
const SAAS_CAT_LABELS = { All: 'All', Multifamily: 'Software', 'Digital Advertising': 'Professional Services' };
const catLabel = (c) => SAAS_CAT_LABELS[c] || c;
const saasCatMatch = (cat, itemCat) => cat === 'All' || itemCat === cat;
// A Re-rate/Downgrade booking whose Re-rate Old MRR exceeds its new MRR is a downgrade drop; its
// MRR movement is represented as a "Churn Downgrade" churn line, so it's excluded from add events.
function isDowngradeBooking(b) {
  const ctam = String(b.ctam_type || '').trim();
  if (ctam !== 'Re-rate' && ctam !== 'Downgrade') return false;
  const num = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0; };
  return num(b.rerate_old_mrr) > num(b.mrr);
}
// Pure pilots (Pilot in "Pilot or CTAM" with any pilot type except Conversion) are NOT
// recognized in SaaS Financials — even once live — until a Conversion booking comes in for
// the same property/product. MRR is recognized only from that conversion.
function saasRecognized(b) {
  // Booking Clawback / Correction lines only adjust Revenue-Desk $ to match the source sheet —
  // they aren't real MRR movement, so they never count toward SaaS Financials.
  if (isBookingAdjusted(b)) return false;
  const poc = String(b.pilot_or_ctam || '').trim();
  const pt = String(b.pilot_type || '').trim();
  return !(poc === 'Pilot' && pt !== 'Conversion');
}
// Churn rows carry a product (not a computed category), so map the product to a category the
// same way bprCategory does. The admin Products list (state.schema.productCategories) is the
// source; fall back to the built-in Digital Advertising set for anything not listed.
const SAAS_DA_PRODUCTS = new Set(['Google Search Management', 'SEO', 'Google Performance Max']);
function saasProductCategory(product) {
  const p = String(product || '').trim();
  const map = (state.schema && state.schema.productCategories) || {};
  const cat = map[p];
  if (cat) return cat === 'Digital Advertising' ? 'Digital Advertising' : 'Multifamily';
  return SAAS_DA_PRODUCTS.has(p) ? 'Digital Advertising' : 'Multifamily';
}
// Absolute month index = year*12 + (month-1). From a 'YYYY-MM-DD' date or a 'Month Year' string.
function monthIdxFromDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})/);
  return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : null;
}
function monthIdxFromMonthYear(my) {
  const [mn, y] = String(my || '').trim().split(' ');
  const mi = MONTHS.indexOf(mn);
  return (mi >= 0 && y) ? Number(y) * 12 + mi : null;
}
function monthLabelFromIdx(idx) { return idx == null ? '' : `${MONTHS[((idx % 12) + 12) % 12]} ${Math.floor(idx / 12)}`; }
// A booking's EFFECTIVE go-live month: if its go-live month is closed and the go-live was SET
// (golive_set_date) after that month's official close date, MRR recognition carries to the next
// open month. Returns the effective absolute month index + the month it was carried from.
function effectiveGoLive(b) {
  const gi = monthIdxFromDate(b.golive_date);
  if (gi == null) return { idx: null, carriedFrom: null };
  // Free (promotional) months delay recognition: 3 free months → MRR starts the 4th month.
  const free = Math.max(0, Math.floor(Number(b.free_months) || 0));
  const eff = effectiveChurnMonth(monthLabelFromIdx(gi + free), b.golive_set_date);
  return { idx: monthIdxFromMonthYear(eff.month), carriedFrom: eff.carriedFrom };
}
function effectiveGoLiveIdx(b) { return effectiveGoLive(b).idx; }
function parseQuarterLabel(label) {
  const m = String(label || '').match(/Q(\d)\s+(\d{4})/);
  return m ? { q: Number(m[1]), year: Number(m[2]) } : { q: 1, year: 2000 };
}
// The most recent real (non-Contraction) churn for a booking's property + product.
// Most recent churn for a booking's property + product. Contractions ARE included here: a
// contracted property's MRR still ends (it was offset by a license-transfer booking) — it's
// just typed as "Contraction" rather than churn, and the offset booking reactivates the MRR.
function saasChurnFor(b) {
  const pid = String(b.property_id || '').trim().toLowerCase();
  const prod = String(b.product || '').trim().toLowerCase();
  let best = null;
  for (const c of state.rows.churn) {
    // Downgrade lines — on-the-fly (auto) or materialized (downgrade_booking_id set) — are
    // booking-driven; the re-rate booking's reduced MRR already reflects the drop. Skip to avoid double-count.
    if (c.auto || c.downgrade_booking_id != null) continue;
    if (String(c.classification || '') === 'Churn Credit') continue; // accounting credit, not a real churn
    if (!c.last_date_under_contract) continue;
    if (String(c.property_id || '').trim().toLowerCase() !== pid) continue;
    if (String(c.product || '').trim().toLowerCase() !== prod) continue;
    if (!best || String(c.last_date_under_contract) > String(best.last_date_under_contract)) best = c;
  }
  return best;
}
// MRR a single booking recognizes in absolute month `idx`, with churn proration:
//  before GoLive -> 0; GoLive..(churn month-1) -> full MRR; churn month -> prorated Final AR; after -> 0.
function saasBookingMonthMRR(b, churn, idx) {
  const goLive = effectiveGoLiveIdx(b); // shifts forward if the go-live month is closed (carry-over)
  if (goLive == null || idx < goLive) return 0;
  const mrr = Number(b.mrr) || 0;
  if (!churn) return mrr;
  const finalInv = monthIdxFromMonthYear(churn.final_invoice_month);
  if (finalInv == null) return mrr;
  if (idx < finalInv) return mrr;
  if (idx === finalInv) return Number(churn.ar_final_invoice_amount) || 0;
  return 0;
}
// Quarters present in the data (by go-live / churn months) + the current quarter.
function saasQuarterOptions() {
  const set = new Set();
  const addIdx = (idx) => { if (idx != null) { const y = Math.floor(idx / 12); const q = Math.floor((idx % 12) / 3) + 1; set.add(`Q${q} ${y}`); } };
  for (const b of state.rows.bookings) addIdx(effectiveGoLiveIdx(b));
  for (const c of state.rows.churn) { addIdx(monthIdxFromMonthYear(c.final_invoice_month)); addIdx(monthIdxFromMonthYear(c.final_churn_month)); }
  set.add(currentQuarterLabel());
  return [...set].sort((a, b) => { const A = parseQuarterLabel(a); const B = parseQuarterLabel(b); return (A.year - B.year) || (A.q - B.q); });
}
const SAAS_TYPE_CLASS = {
  'New Logo': 'saas-newlogo', Expansion: 'saas-expansion', Upsell: 'saas-upsell',
  Reactivation: 'saas-reactivation', Contraction: 'saas-contraction', Downgrade: 'saas-downgrade',
  'Churn prorated product': 'saas-churn-pro', 'Churn Product': 'saas-churn',
  'Churn Prorated Rooftop': 'saas-churn-pro', 'Churn Rooftop': 'saas-churn',
  'Churn Logo': 'saas-churn', 'Churn Downgrade': 'saas-downgrade',
  Churn: 'saas-churn',
};
// Granular churn-family types that roll up into the single "Churn" bucket (Unit Economics).
const SAAS_CHURN_TYPES = new Set(['Churn prorated product', 'Churn Product',
  'Churn Prorated Rooftop', 'Churn Rooftop', 'Downgrade']);
function saasBucketOf(type) { return SAAS_CHURN_TYPES.has(type) ? 'Churn' : type; }
function applySaasZoom() {
  $('#saasTable').style.zoom = state.saasZoom;
  $('#saasZoomLevel').textContent = Math.round(state.saasZoom * 100) + '%';
}
// ---- SaaS MRR Data multi-filter (mirrors the Bookings "Add Filter" bar) ----
// Filterable columns of a built MRR-Data row (see rows.push in renderSaas).
const SAAS_FILTER_DEFS = [
  { key: 'pmc', label: 'PMC' },
  { key: 'property', label: 'Property' },
  { key: 'propertyId', label: 'Property ID' },
  { key: 'sageId', label: 'Sage ID' },
  { key: 'status', label: 'Status' },
  { key: 'products', label: 'Products' }, // row.products is an array
  { key: 'type', label: 'MRR Type' },     // any month's type pill
  { key: 'goLive', label: 'GoLive Date' },
];
// The value(s) a row exposes for a given filter column (always an array; [] means blank).
function saasRowValues(r, key) {
  if (key === 'products') return (r.products || []).map((p) => String(p).trim()).filter(Boolean);
  if (key === 'type') return [...new Set((r.types || []).map((t) => t && t.type).filter(Boolean))];
  const v = r[key];
  return (v === null || v === undefined || String(v).trim() === '') ? [] : [String(v)];
}
// Does a row pass every active SaaS filter? A filter passes if the row shares ≥1 selected value.
function saasRowMatches(r) {
  return SAAS_FILTER_DEFS.every((def) => {
    const sel = selectedValues(state.saasFilters[def.key]);
    if (!sel.length) return true;
    return saasRowValues(r, def.key).some((v) => sel.includes(v));
  });
}
// Distinct values for a column across the given rows (for the checkbox dropdown).
function saasFilterValues(rows, key) {
  const set = new Set();
  for (const r of rows) for (const v of saasRowValues(r, key)) set.add(v);
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function saveSaasActiveFilters() { localStorage.setItem('perqSaasActiveFilters', JSON.stringify(state.saasActiveFilters)); }
function saveSaasUnitActiveFilters() { localStorage.setItem('perqSaasUnitActiveFilters', JSON.stringify(state.saasUnitActiveFilters)); }

// ---- Unit Economics Report multi-filter (its rows are type-bucketed events {type, pmcProperty, product}) ----
const SAAS_UNIT_FILTER_DEFS = [
  { key: 'type', label: 'Type' },              // New Logo / Expansion / Upsell / Contraction / Churn …
  { key: 'pmcProperty', label: 'PMC - Property' },
  { key: 'product', label: 'Product' },
];
function saasUnitEventValues(e, key) {
  const v = e[key];
  return (v === null || v === undefined || String(v).trim() === '' || v === '—') ? [] : [String(v)];
}
function saasUnitEventMatches(e) {
  return SAAS_UNIT_FILTER_DEFS.every((def) => {
    const sel = selectedValues(state.saasUnitFilters[def.key]);
    if (!sel.length) return true;
    return saasUnitEventValues(e, def.key).some((v) => sel.includes(v));
  });
}
function saasUnitFilterValues(events, key) {
  const set = new Set();
  for (const e of events) for (const v of saasUnitEventValues(e, key)) set.add(v);
  const arr = [...set];
  if (key === 'type') return arr.sort((a, b) => ((SAAS_BUCKET_ORDER.indexOf(a) + 1) || 99) - ((SAAS_BUCKET_ORDER.indexOf(b) + 1) || 99));
  return arr.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// The always-present Quarter + Category tiles (single-select), shown on every SaaS sub-tab. Folding
// these into the filter bar replaces the old standalone dropdowns.
function saasPinnedTilesHtml() {
  const qOpts = saasQuarterOptions();
  const qsel = (qOpts.length ? qOpts : ['—']).map((q) => `<option${q === state.saasQuarter ? ' selected' : ''}>${escapeHtml(q)}</option>`).join('');
  const cats = [['All', 'All'], ['Multifamily', 'Software'], ['Digital Advertising', 'Professional Services']];
  const csel = cats.map(([v, l]) => `<option value="${escapeAttr(v)}"${v === state.saasCategory ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('');
  return '<div class="filter saas-pin"><label>Quarter</label>'
    + `<select id="saasQuarterSel" class="saas-pin-sel">${qsel}</select></div>`
    + '<div class="filter saas-pin"><label>Category</label>'
    + `<select id="saasCategorySel" class="saas-pin-sel">${csel}</select></div>`;
}
// Build the SaaS filter bar for a sub-tab: Quarter + Category (all tabs), plus the value-filter tiles
// + "Add Filter" for the data / unit tabs. `items` are the (unfiltered) rows (data) or events (unit).
function renderSaasFilterBar(sub, items) {
  const el = $('#saasFilters');
  if (!el) return;
  const grip = $('#saasFiltersResize');
  el.hidden = false;
  if (grip) grip.hidden = false;
  el.style.zoom = state.filterZoom; // shared filter-tile size (drag the grip below to resize)
  let html = saasPinnedTilesHtml();
  if (sub === 'data' || sub === 'unit') {
    const defs = sub === 'unit' ? SAAS_UNIT_FILTER_DEFS : SAAS_FILTER_DEFS;
    const filters = sub === 'unit' ? state.saasUnitFilters : state.saasFilters;
    const valuesOf = sub === 'unit' ? saasUnitFilterValues : saasFilterValues;
    const active = (sub === 'unit' ? state.saasUnitActiveFilters : state.saasActiveFilters).filter((k) => defs.some((d) => d.key === k));
    html += active.map((k) => {
      const def = defs.find((d) => d.key === k);
      return filterTileHtml(k, escapeHtml(def.label), valuesOf(items || [], k), selectedValues(filters[k]), true);
    }).join('');
    const addOpts = ['<option value="">+ Add a filter…</option>']
      .concat(defs.filter((d) => !active.includes(d.key)).map((d) => `<option value="${d.key}">${escapeHtml(d.label)}</option>`)).join('');
    html += `<div class="filter add-filter"><label>Add Filter</label><select id="saasAddFilter">${addOpts}</select></div>`;
  }
  el.innerHTML = html;
}

function renderSaas(opts = {}) {
  const qOpts = saasQuarterOptions();
  if (!qOpts.includes(state.saasQuarter)) {
    state.saasQuarter = qOpts.includes(currentQuarterLabel()) ? currentQuarterLabel() : (qOpts[qOpts.length - 1] || currentQuarterLabel());
  }
  applySaasZoom();
  // Sub-tabs: MRR Data (table) | Dashboard (tiles) | Unit Economics (type buckets).
  const sub = state.saasSub;
  document.querySelectorAll('[data-saas-sub]').forEach((b) => b.classList.toggle('active', b.dataset.saasSub === sub));
  $('#saasTableWrap').hidden = sub !== 'data';
  $('#saasDashboard').hidden = sub !== 'dashboard';
  $('#saasUnit').hidden = sub !== 'unit';
  $('#saasZoomGroup').style.display = sub === 'data' ? '' : 'none';

  const { q, year } = parseQuarterLabel(state.saasQuarter);
  const idxs = [0, 1, 2].map((i) => year * 12 + (q - 1) * 3 + i);
  const category = state.saasCategory;

  // Shared churn cache (used by all three sub-tabs).
  const churnCache = new Map();
  const churnOf = (b) => { if (!churnCache.has(b.id)) churnCache.set(b.id, saasChurnFor(b)); return churnCache.get(b.id); };

  if (sub === 'dashboard') { renderSaasFilterBar('dashboard', null); renderSaasDashboard(idxs, category, churnOf); return; }

  // Precompute, across ALL active bookings: each property's bookings + first go-live month,
  // each PMC's first go-live month (for New Logo). Needed by the table and the Unit report.
  const allByProp = new Map();
  const allByPmc = new Map();      // pmc -> its bookings (for PMC-level "logo churn" checks)
  const firstGoLive = new Map();   // property -> earliest go-live idx (any category)
  const pmcFirstGoLive = new Map(); // pmc -> earliest go-live idx (drives New Logo)
  for (const b of state.rows.bookings) {
    if (!saasRecognized(b)) continue; // pure pilots aren't recognized until converted
    const gi = effectiveGoLiveIdx(b); // carry-over: closed go-live months shift forward
    if (gi == null) continue;
    const pid = String(b.property_id || b.property_name || `#${b.id}`);
    if (!allByProp.has(pid)) allByProp.set(pid, []);
    allByProp.get(pid).push(b);
    if (!firstGoLive.has(pid) || gi < firstGoLive.get(pid)) firstGoLive.set(pid, gi);
    const pmc = String(b.pmc || '').trim().toLowerCase();
    if (pmc) {
      if (!allByPmc.has(pmc)) allByPmc.set(pmc, []);
      allByPmc.get(pmc).push(b);
      if (!pmcFirstGoLive.has(pmc) || gi < pmcFirstGoLive.get(pmc)) pmcFirstGoLive.set(pmc, gi);
    }
  }
  // The property's total recognized MRR across ALL categories in a month — for Rooftop checks.
  const propTotalAt = (pid, idx) => (allByProp.get(pid) || []).reduce((a, b) => a + saasBookingMonthMRR(b, churnOf(b), idx), 0);
  // The PMC's total recognized MRR in a month (NaN if the PMC has no bookings we know of, so we
  // never mislabel an unknown PMC as a "logo churn"). Used to tell Churn Logo from Churn Rooftop.
  const pmcTotalAt = (pmc, idx) => {
    const list = allByPmc.get(pmc);
    return list ? list.reduce((a, b) => a + saasBookingMonthMRR(b, churnOf(b), idx), 0) : NaN;
  };

  if (sub === 'unit') { renderSaasUnit(idxs, category, { churnOf, firstGoLive, pmcFirstGoLive, propTotalAt, pmcTotalAt }, opts); return; }

  // MRR Type for a property+category row in absolute month `idx`. Returns { type, note }.
  function saasTypeFor(pid, pmc, catBookings, idx) {
    // Adds first: a product whose (effective) go-live lands this month.
    const goLives = catBookings.filter((b) => effectiveGoLiveIdx(b) === idx);
    if (goLives.length) {
      // If recognition was carried over from a closed month, note it.
      const carriedFrom = goLives.map((b) => effectiveGoLive(b).carriedFrom).find(Boolean);
      const carryNote = carriedFrom ? `MRR carried over from ${carriedFrom} (closed month)` : '';
      const off = goLives.find((b) => b.offset_churn_id);
      if (off) return { type: 'Reactivation', note: [String(off.notes || ''), carryNote].filter(Boolean).join(' — ') };
      if (idx === firstGoLive.get(pid)) {
        return { type: pmcFirstGoLive.get(pmc) === idx ? 'New Logo' : 'Expansion', note: carryNote };
      }
      if (goLives.some((b) => String(b.ctam_type || '').trim() === 'Downgrade')) return { type: 'Downgrade', note: carryNote };
      return { type: 'Upsell', note: carryNote };
    }
    // Churn drops: prorated (final invoice month) then full ($0) the next month.
    const proBk = catBookings.find((b) => { const c = churnOf(b); return c && monthIdxFromMonthYear(c.final_invoice_month) === idx; });
    if (proBk) {
      const c = churnOf(proBk);
      if (String(c.classification || '') === 'Contraction') return { type: 'Contraction', note: String(c.notes || '') };
      return { type: propTotalAt(pid, idx + 1) === 0 ? 'Churn Prorated Rooftop' : 'Churn prorated product', note: '' };
    }
    const fullBk = catBookings.find((b) => { const c = churnOf(b); return c && monthIdxFromMonthYear(c.final_churn_month) === idx; });
    if (fullBk) {
      const c = churnOf(fullBk);
      if (String(c.classification || '') === 'Contraction') return { type: 'Contraction', note: String(c.notes || '') };
      return { type: propTotalAt(pid, idx) === 0 ? 'Churn Rooftop' : 'Churn Product', note: '' };
    }
    return { type: '', note: '' };
  }

  // Group ALL bookings of the selected category by property (live AND not-yet-live).
  const byProp = new Map();
  for (const b of state.rows.bookings) {
    if (!saasCatMatch(category, saasCategoryOf(b)) || !saasRecognized(b)) continue; // skip pure pilots
    const pid = String(b.property_id || b.property_name || `#${b.id}`);
    if (!byProp.has(pid)) {
      byProp.set(pid, {
        property: b.property_only || b.property_name || b.property_id || '—',
        pmc: String(b.pmc || '').trim().toLowerCase(),
        pmcDisplay: String(b.pmc || '').trim(),
        property_id: String(b.property_id || '').trim(),
        bookings: [],
      });
    }
    byProp.get(pid).bookings.push(b);
  }

  // Current calendar month — for the "current MRR" snapshot (excludes products churned by now).
  const nowD = new Date();
  const nowIdx = nowD.getFullYear() * 12 + nowD.getMonth();

  let rows = [];
  for (const [pid, info] of byProp) {
    const isLive = info.bookings.some((b) => b.golive_date);
    const monthVals = idxs.map((idx) => info.bookings.reduce((a, b) => a + saasBookingMonthMRR(b, churnOf(b), idx), 0));
    const typeObjs = idxs.map((idx) => saasTypeFor(pid, info.pmc, info.bookings, idx));
    // Live rows only show when they have activity/events in the viewed quarter; not-live rows
    // (pipeline) always show, with their MRR sitting in the MRR column.
    if (isLive && monthVals.every((v) => !v) && typeObjs.every((t) => !t.type)) continue;
    const products = [...new Set(info.bookings.map((b) => String(b.product || '').trim()).filter(Boolean))];
    const sageId = info.bookings.map((b) => String(b.sage_id || '').trim()).find(Boolean) || '';
    const goLive = info.bookings.map((b) => b.golive_date).filter(Boolean).sort()[0] || ''; // earliest go-live
    // Current MRR = sum of products' MRR, excluding any fully churned as of this month.
    const currentMrr = info.bookings.reduce((a, b) => {
      const c = churnOf(b);
      const fc = c ? monthIdxFromMonthYear(c.final_churn_month) : null;
      return a + ((fc != null && nowIdx >= fc) ? 0 : (Number(b.mrr) || 0));
    }, 0);
    // Churned = it went live, at least one product's churn month has been reached, and no current
    // MRR remains (all products have ended as of now). Reflects the property's status TODAY, like
    // the current-MRR snapshot — the month columns still show the quarter's recognition.
    const anyEnded = info.bookings.some((b) => {
      const c = churnOf(b);
      const fc = c ? monthIdxFromMonthYear(c.final_churn_month) : null;
      return fc != null && nowIdx >= fc;
    });
    const churned = isLive && anyEnded && currentMrr <= 0.005;
    const status = !isLive ? 'Not Live' : (churned ? 'Churned' : 'Active & Live');
    rows.push({
      pmc: info.pmcDisplay, propertyId: info.property_id, property: info.property,
      sageId, goLive, isLive, churned, status, currentMrr,
      products, monthVals, types: typeObjs, total: monthVals.reduce((a, v) => a + v, 0),
    });
  }
  rows.sort((a, b) => String(a.property).localeCompare(String(b.property)));
  // Build the multi-filter bar from the full set, then show only rows that pass the active filters.
  // keepFilterBar leaves the existing tiles/open dropdown untouched (a value was just toggled), so
  // multi-select stays smooth — only the table below re-filters.
  if (!opts.keepFilterBar) renderSaasFilterBar('data', rows);
  rows = rows.filter(saasRowMatches);

  // Columns carry data-col (position-based so widths persist across quarters) + resize handles.
  const RES = '<span class="col-resize"></span>';
  const monthHead = idxs.map((idx, j) => {
    const mi = idx % 12; const y = Math.floor(idx / 12);
    return `<th class="num" data-col="m${j}">${MONTHS[mi]} ${y}${RES}</th><th class="saas-type-col" data-col="t${j}">${MONTHS[mi].slice(0, 3)}${String(y).slice(2)} Type${RES}</th>`;
  }).join('');
  const idHead = `<th data-col="pmc">PMC${RES}</th><th data-col="property_id">Property ID${RES}</th>`
    + `<th data-col="property">Property${RES}</th><th data-col="sage_id">Sage ID${RES}</th><th data-col="golive">GoLive Date${RES}</th>`
    + `<th data-col="status">Status${RES}</th><th data-col="products">Products${RES}</th><th class="num" data-col="mrr">MRR${RES}</th>`;
  $('#saasHead').innerHTML = `<tr><th class="rownum">#</th>${idHead}${monthHead}<th class="num" data-col="qtotal">${escapeHtml(state.saasQuarter)} Total${RES}</th></tr>`;

  $('#saasBody').innerHTML = rows.length ? rows.map((r, i) => {
    const cells = r.monthVals.map((v, j) => {
      const t = r.types[j];
      const pill = t.type
        ? `<span class="saas-pill ${SAAS_TYPE_CLASS[t.type] || ''}"${t.note ? ` title="${escapeAttr(t.note)}"` : ''}>${escapeHtml(t.type)}</span>`
        : '';
      return `<td class="num" data-col="m${j}">${fmtMoney(v)}</td><td class="saas-type-col" data-col="t${j}">${pill}</td>`;
    }).join('');
    return `<tr class="${r.isLive ? '' : 'saas-notlive'}"><td class="rownum">${i + 1}</td>`
      + `<td data-col="pmc">${escapeHtml(r.pmc || '—')}</td>`
      + `<td data-col="property_id">${escapeHtml(r.propertyId || '—')}</td>`
      + `<td data-col="property">${escapeHtml(r.property)}</td>`
      + `<td data-col="sage_id">${escapeHtml(r.sageId || '—')}</td>`
      + `<td data-col="golive">${escapeHtml(r.goLive || '—')}</td>`
      + `<td data-col="status"><span class="saas-status ${r.churned ? 'saas-status-churned' : (r.isLive ? 'saas-status-live' : 'saas-status-notlive')}">${escapeHtml(r.status)}</span></td>`
      + `<td class="saas-products" data-col="products" title="${escapeAttr(r.products.join(', '))}">${escapeHtml(r.products.join(', ') || '—')}</td>`
      + `<td class="num" data-col="mrr">${fmtMoney(r.currentMrr)}</td>`
      + `${cells}<td class="num" data-col="qtotal">${fmtMoney(r.total)}</td></tr>`;
  }).join('') : `<tr><td class="muted" colspan="${10 + idxs.length * 2}" style="padding:14px">${
    SAAS_FILTER_DEFS.some((d) => selectedValues(state.saasFilters[d.key]).length)
      ? 'No properties match the current filters.'
      : `No ${escapeHtml(category)} properties in ${escapeHtml(state.saasQuarter)}.`}</td></tr>`;

  if (rows.length) {
    const monthTotals = idxs.map((_, j) => rows.reduce((a, r) => a + r.monthVals[j], 0));
    const grand = rows.reduce((a, r) => a + r.total, 0);
    const mrrTotal = rows.reduce((a, r) => a + r.currentMrr, 0);
    const tcells = monthTotals.map((v, j) => `<td class="num" data-col="m${j}">${fmtMoney(v)}</td><td class="saas-type-col" data-col="t${j}"></td>`).join('');
    $('#saasFoot').innerHTML = `<tr class="saas-total"><td class="rownum"></td>`
      + '<td data-col="pmc"></td><td data-col="property_id"></td><td data-col="property">Total</td>'
      + '<td data-col="sage_id"></td><td data-col="golive"></td><td data-col="status"></td>'
      + `<td data-col="products">${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}</td>`
      + `<td class="num" data-col="mrr">${fmtMoney(mrrTotal)}</td>${tcells}<td class="num" data-col="qtotal">${fmtMoney(grand)}</td></tr>`;
  } else {
    $('#saasFoot').innerHTML = '';
  }
  $('#saasCount').textContent = `${rows.length} ${catLabel(category)} propert${rows.length === 1 ? 'y' : 'ies'} · ${state.saasQuarter}`;
  applyColWidths(); // re-apply any saved SaaS column widths to the freshly built table
}
// SaaS Dashboard sub-tab: monthly Recognized-MRR tiles + monthly Churn tiles for the quarter,
// scoped to the selected category. Auto-filters to the current quarter via state.saasQuarter.
function renderSaasDashboard(idxs, category, churnOf) {
  // Recognized MRR per month: all category bookings except pure pilots (not-live contribute 0).
  const mrrByMonth = idxs.map((idx) => state.rows.bookings.reduce(
    (a, b) => ((saasCatMatch(category, saasCategoryOf(b)) && saasRecognized(b)) ? a + saasBookingMonthMRR(b, churnOf(b), idx) : a), 0));
  // Churn per month (Churn Tracker amounts; category by product; excludes Contraction).
  const churnByMonth = idxs.map(() => 0);
  for (const c of state.rows.churn) {
    if (String(c.classification || '') === 'Contraction') continue;
    if (!saasCatMatch(category, saasProductCategory(c.product))) continue;
    const pIdx = monthIdxFromMonthYear(c.prorated_churn_month);
    const fIdx = monthIdxFromMonthYear(c.final_churn_month);
    idxs.forEach((idx, j) => {
      if (pIdx === idx) churnByMonth[j] += Number(c.prorated_churn_amount) || 0;
      if (fIdx === idx) churnByMonth[j] += Number(c.final_churn_amount) || 0;
    });
  }
  const monthLabel = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
  const tile = (label, val, accent) => `<div class="metric${accent ? ' accent' : ''}"><span class="k">${escapeHtml(label)}</span><span class="v">${fmtMoney(val)}</span></div>`;
  const sum = (arr) => arr.reduce((a, v) => a + v, 0);
  const mrrTiles = idxs.map((idx, j) => tile(monthLabel(idx), mrrByMonth[j])).join('') + tile(`${state.saasQuarter} Total`, sum(mrrByMonth), true);
  const churnTiles = idxs.map((idx, j) => tile(monthLabel(idx), churnByMonth[j])).join('') + tile(`${state.saasQuarter} Total`, sum(churnByMonth), true);

  // Multifamily Bookings per Type — Company Total Booking summed per type (New Logo + each CTAM
  // Type), with the distinct PMC count under each. Has its OWN Month/Year filter (booking_month +
  // booking_year), defaulting to the current month/year.
  const bookingMY = (b) => (b.booking_month && b.booking_year != null && b.booking_year !== '') ? `${b.booking_month} ${b.booking_year}` : '';
  const now = new Date();
  const curMY = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  if (!state.saasTypeMonth) state.saasTypeMonth = curMY;
  const monthsPresent = [...new Set(state.rows.bookings.map(bookingMY).filter(Boolean))];
  if (!monthsPresent.includes(curMY)) monthsPresent.push(curMY); // keep the current month selectable
  const typeMonthOpts = ['All', ...sortMonthYear(monthsPresent)];
  if (!typeMonthOpts.includes(state.saasTypeMonth)) state.saasTypeMonth = curMY;
  const typeBookings = state.saasTypeMonth === 'All'
    ? state.rows.bookings
    : state.rows.bookings.filter((b) => bookingMY(b) === state.saasTypeMonth);
  const byType = new Map();
  const addTo = (t, b) => {
    if (!byType.has(t)) byType.set(t, { total: 0, pmcs: new Set() });
    const g = byType.get(t);
    g.total += Number(b.company_total_booking) || 0;
    const pmc = String(b.pmc || '').trim().toLowerCase();
    if (pmc) g.pmcs.add(pmc);
  };
  // Bucket EVERY booking so the per-type tiles reconcile with the total (and with the Main
  // Dashboard's Total Company Booking for the same month): CTAM types (Renewal Rate Increase +
  // Re-rate combined), New Logo (New-Paid/Free pilots), the other pilot types by name, else Other.
  const RATE_BUCKET = 'Renewal Rate Increase / Re-rate';
  const typeLabel = (t) => (t === 'Renewal Rate Increase' || t === 'Re-rate') ? RATE_BUCKET : t;
  const typeBucketOf = (b) => {
    const ctam = String(b.ctam_type || '').trim();
    if (ctam) return typeLabel(ctam);
    const pt = String(b.pilot_type || '').trim();
    if (pt === 'New - Paid' || pt === 'New - Free') return 'New Logo';
    return pt || 'Other'; // Conversion / Pilot Expansion / Second Signature, or untyped
  };
  let totalBookings = 0;
  for (const b of typeBookings) { totalBookings += Number(b.company_total_booking) || 0; addTo(typeBucketOf(b), b); }
  const ctamOpts = (state.schema.bookings.editable.find((f) => f.key === 'ctam_type')?.options || []).filter(Boolean);
  const pilotOpts = (state.schema.bookings.editable.find((f) => f.key === 'pilot_type')?.options || []).filter(Boolean);
  const pilotExtra = pilotOpts.filter((p) => p !== 'New - Paid' && p !== 'New - Free');
  const typeOrder = ['New Logo', ...new Set(ctamOpts.map(typeLabel)), ...pilotExtra, 'Other'];
  const types = [...byType.keys()].sort((a, b) => {
    const ia = typeOrder.indexOf(a); const ib = typeOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const typeTiles = types.map((t) => {
    const g = byType.get(t);
    return `<div class="metric"><span class="k">${escapeHtml(t)}</span><span class="v">${fmtMoney(g.total)}</span>`
      + `<span class="saas-type-count">${g.pmcs.size} PMC${g.pmcs.size === 1 ? '' : 's'}</span></div>`;
  }).join('');
  const totalPmcs = new Set(typeBookings.map((b) => String(b.pmc || '').trim().toLowerCase()).filter(Boolean)).size;
  const totalTile = `<div class="metric accent"><span class="k">Total Bookings</span><span class="v">${fmtMoney(totalBookings)}</span>`
    + `<span class="saas-type-count">${totalPmcs} PMC${totalPmcs === 1 ? '' : 's'}</span></div>`;
  const typeMonthSel = '<select id="saasTypeMonth" class="churn-quarter">'
    + typeMonthOpts.map((o) => `<option${o === state.saasTypeMonth ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') + '</select>';

  $('#saasDashboard').innerHTML =
    `<div class="metrics-title">${escapeHtml(catLabel(category))} — Recognized MRR by Month</div><div class="metrics-row">${mrrTiles}</div>`
    + `<div class="metrics-title">${escapeHtml(catLabel(category))} — Churn by Month</div><div class="metrics-row">${churnTiles}</div>`
    + `<div class="metrics-title metrics-title-row"><span>Multifamily Bookings</span>${typeMonthSel}</div>`
    + `<div class="metrics-row">${totalTile}</div>`
    + '<div class="metrics-title">Bookings per Type</div>'
    + `<div class="metrics-row">${typeTiles || '<span class="muted">No bookings for this month.</span>'}</div>`;
  $('#saasCount').textContent = `${catLabel(category)} · ${state.saasQuarter}`;
}

// Order the buckets appear in the Unit Economics Report. "Churn" rolls up the churn-family
// types (prorated/full, product/rooftop) plus Downgrade.
const SAAS_BUCKET_ORDER = ['New Logo', 'Expansion', 'Upsell', 'Reactivation', 'Contraction',
  'Churn Logo', 'Churn Rooftop', 'Churn Prorated Rooftop', 'Churn Downgrade'];

// Unit Economics Report sub-tab: one card per month of the quarter (like Churn Details).
// Each month's table lists the type buckets (New Logo, Expansion, …) as groups, with
// PMC - Property / Product / MRR rows. Long PMC - Property values truncate; scroll horizontally.
function renderSaasUnit(idxs, category, h, opts = {}) {
  const { firstGoLive, pmcFirstGoLive, pmcTotalAt } = h;
  const idxSet = new Set(idxs);
  const events = [];
  const push = (type, pmcProperty, product, monthIdx, amt) => {
    if (!amt) return; // hide $0 rows
    events.push({ type, pmcProperty, product: product || '—', monthIdx, mrr: amt });
  };
  // ADD events come from bookings (go-live). Downgrade/re-rate drops are represented as churn
  // (below), so exclude them here to avoid showing them as a positive add.
  for (const b of state.rows.bookings) {
    if (!saasCatMatch(category, saasCategoryOf(b)) || !saasRecognized(b)) continue; // skip pure pilots
    if (isDowngradeBooking(b)) continue;
    const pid = String(b.property_id || b.property_name || `#${b.id}`);
    const pmcProperty = b.property_name || b.property_id || '—';
    const mrr = Number(b.mrr) || 0;
    const gi = effectiveGoLiveIdx(b);
    if (gi == null || !idxSet.has(gi)) continue;
    let type;
    if (b.offset_churn_id) type = 'Reactivation';
    else if (gi === firstGoLive.get(pid)) type = pmcFirstGoLive.get(String(b.pmc || '').trim().toLowerCase()) === gi ? 'New Logo' : 'Expansion';
    else type = 'Upsell';
    push(type, pmcProperty, b.product, gi, mrr);
  }
  // CHURN events come straight from the Churn Tracker (so EVERY drop shows, even with no matching
  // booking). Each churn recognizes a prorated remainder one month and its full drop the next:
  //   • prorated portion            → Churn Prorated Rooftop
  //   • final portion               → Churn Logo (this churn empties the whole PMC) else Churn Rooftop
  //   • auto downgrade churn line    → Churn Downgrade
  //   • Contraction                 → Contraction (its own bucket, unchanged)
  for (const c of state.rows.churn) {
    if (String(c.classification || '') === 'Churn Credit') continue; // accounting credit, not a drop
    if (!saasCatMatch(category, saasProductCategory(c.product))) continue;
    const isContraction = String(c.classification || '') === 'Contraction';
    const pmc = String(c.pmc_buying_center || '').trim().toLowerCase();
    const pmcProperty = c.property || c.property_id || '—';
    const pIdx = monthIdxFromMonthYear(c.prorated_churn_month);
    if (pIdx != null && idxSet.has(pIdx)) {
      push(isContraction ? 'Contraction' : 'Churn Prorated Rooftop', pmcProperty, c.product, pIdx, Number(c.prorated_churn_amount) || 0);
    }
    const fIdx = monthIdxFromMonthYear(c.final_churn_month);
    if (fIdx != null && idxSet.has(fIdx)) {
      let type;
      if (isContraction) type = 'Contraction';
      else if (c.auto || String(c.classification || '') === 'Downgrade') type = 'Churn Downgrade';
      else type = pmcTotalAt(pmc, fIdx) === 0 ? 'Churn Logo' : 'Churn Rooftop';
      push(type, pmcProperty, c.product, fIdx, Number(c.final_churn_amount) || 0);
    }
  }
  // Build the multi-filter bar from the full event set, then show only events that pass the filters.
  if (!opts.keepFilterBar) renderSaasFilterBar('unit', events);
  const shownEvents = events.filter(saasUnitEventMatches);
  const filtered = SAAS_UNIT_FILTER_DEFS.some((d) => selectedValues(state.saasUnitFilters[d.key]).length);
  const monthLabel = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
  // One card per month; inside, group rows by type bucket (in order).
  const cards = idxs.map((mIdx) => {
    const monthEvents = shownEvents.filter((e) => e.monthIdx === mIdx);
    let body;
    if (!monthEvents.length) {
      body = `<tr><td class="muted" colspan="3" style="padding:10px">${filtered ? 'No activity matches the current filters.' : 'No activity this month.'}</td></tr>`;
    } else {
      // Group by bucket — each event's type IS its bucket (Churn Logo/Rooftop/Prorated/Downgrade).
      const byBucket = new Map();
      for (const e of monthEvents) { const bk = e.type; if (!byBucket.has(bk)) byBucket.set(bk, []); byBucket.get(bk).push(e); }
      body = SAAS_BUCKET_ORDER.filter((bk) => byBucket.has(bk)).map((bk) => {
        const list = byBucket.get(bk);
        const total = list.reduce((a, e) => a + e.mrr, 0);
        // Roll the product-level events up to one row per property (PMC - Property).
        const byProp = new Map();
        for (const e of list) { if (!byProp.has(e.pmcProperty)) byProp.set(e.pmcProperty, []); byProp.get(e.pmcProperty).push(e); }
        const props = [...byProp.entries()].sort((a, b) => String(a[0]).localeCompare(b[0]));
        const head = `<tr class="saas-unit-group"><td colspan="3"><span class="saas-pill ${SAAS_TYPE_CLASS[bk] || ''}">${escapeHtml(bk)}</span>`
          + `<span class="saas-unit-gcount">${props.length}</span><span class="saas-unit-gtotal">${fmtMoney(total)}</span></td></tr>`;
        // Each property row shows its rolled-up total; a ▸ arrow expands to the products behind it
        // (only when there's more than one product to reveal).
        const rows = props.map(([prop, evs]) => {
          const pTotal = evs.reduce((a, e) => a + e.mrr, 0);
          const multi = evs.length > 1;
          const key = `${mIdx}|${bk}|${prop}`;
          const open = state.saasUnitExpanded.has(key);
          const caret = multi
            ? `<button type="button" class="ss-expand${open ? ' open' : ''}" data-saas-unit-expand="${escapeAttr(key)}" title="Show / hide products">▸</button>`
            : '<span class="saas-unit-nocaret"></span>';
          const propRow = `<tr class="saas-unit-prop-row"><td class="saas-unit-prop" title="${escapeAttr(prop)}">${caret}<span>${escapeHtml(prop)}</span>`
            + `${multi ? ` <span class="ss-count">${evs.length}</span>` : ''}</td>`
            + `<td>${multi ? '' : escapeHtml(evs[0].product)}</td><td class="num">${fmtMoney(pTotal)}</td></tr>`;
          const detail = (multi && open)
            ? evs.slice().sort((a, b) => String(a.product).localeCompare(b.product)).map((e) =>
              `<tr class="saas-unit-detail"><td class="saas-unit-prop"><span class="ss-detail-indent">↳</span></td>`
              + `<td>${escapeHtml(e.product)}</td><td class="num">${fmtMoney(e.mrr)}</td></tr>`).join('')
            : '';
          return propRow + detail;
        }).join('');
        return head + rows;
      }).join('');
    }
    return '<div class="churn-detail-card"><div class="churn-detail-month">'
      + `${escapeHtml(monthLabel(mIdx))} <span class="saas-unit-mcount">(${monthEvents.length})</span></div>`
      + '<div class="churn-detail-scroll"><table><thead><tr><th>PMC - Property</th><th>Product</th><th class="num">MRR</th></tr></thead>'
      + `<tbody>${body}</tbody></table></div></div>`;
  }).join('');
  $('#saasUnit').innerHTML = `<div class="churn-detail-grid">${cards}</div>`;
  $('#saasCount').textContent = `${catLabel(category)} · ${state.saasQuarter} · ${shownEvents.length} event${shownEvents.length === 1 ? '' : 's'}`;
}

function wireSaas() {
  // Quarter + Category now live as tiles inside the filter bar (#saasFilters) — handled by wireSaasFilters.
  // The "Bookings per Type" Month/Year filter lives inside the (re-rendered) dashboard, so bind
  // it with a delegated listener on the container.
  $('#saasDashboard').addEventListener('change', (e) => {
    if (e.target.id === 'saasTypeMonth') { state.saasTypeMonth = e.target.value; renderSaas(); }
  });
  // Unit Economics: expand / collapse a property row to the products behind its total.
  $('#saasUnit').addEventListener('click', (e) => {
    const exp = e.target.closest('[data-saas-unit-expand]');
    if (!exp) return;
    const key = exp.dataset.saasUnitExpand;
    if (state.saasUnitExpanded.has(key)) state.saasUnitExpanded.delete(key); else state.saasUnitExpanded.add(key);
    renderSaas();
  });
  document.querySelectorAll('[data-saas-sub]').forEach((b) => {
    b.onclick = () => { state.saasSub = b.dataset.saasSub; renderSaas(); };
  });
  const setZoom = (z) => { state.saasZoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10)); localStorage.setItem('perqSaasZoom', String(state.saasZoom)); applySaasZoom(); };
  $('#saasZoomOut').onclick = () => setZoom(state.saasZoom - 0.1);
  $('#saasZoomIn').onclick = () => setZoom(state.saasZoom + 0.1);
  wireSaasFilters();
}

// Delegated handlers for the SaaS MRR Data multi-filter (own state, scoped to #saasFilters so it
// never clashes with the Bookings/Churn filter bar). Mirrors wireFilterMenus.
function wireSaasFilters() {
  const bar = $('#saasFilters');
  if (!bar) return;
  const closeMenus = () => {
    let closed = false;
    bar.querySelectorAll('.ms-menu:not([hidden])').forEach((m) => { m.hidden = true; closed = true; });
    return closed;
  };
  // The value-filter state depends on which sub-tab is active (data vs unit).
  const filtersFor = () => (state.saasSub === 'unit' ? state.saasUnitFilters : state.saasFilters);
  const activeFor = () => (state.saasSub === 'unit' ? state.saasUnitActiveFilters : state.saasActiveFilters);
  const saveActive = () => (state.saasSub === 'unit' ? saveSaasUnitActiveFilters() : saveSaasActiveFilters());
  const setVals = (key, arr) => { filtersFor()[key] = (arr && arr.length) ? arr.slice() : 'All'; };
  const updateSummary = (key) => {
    const ms = bar.querySelector(`[data-ms="${key}"]`);
    if (!ms) return;
    const sel = selectedValues(filtersFor()[key]);
    const label = ms.querySelector('.ms-label');
    if (label) label.textContent = sel.length === 0 ? 'All' : (sel.length === 1 ? sel[0] : `${sel.length} selected`);
  };
  bar.addEventListener('change', (e) => {
    // Quarter / Category single-select tiles (drive the whole computation → full re-render).
    if (e.target.id === 'saasQuarterSel') { state.saasQuarter = e.target.value; renderSaas(); return; }
    if (e.target.id === 'saasCategorySel') { state.saasCategory = e.target.value; renderSaas(); return; }
    // Add Filter dropdown (scoped to the active sub-tab's filter set).
    if (e.target.id === 'saasAddFilter') {
      const id = e.target.value;
      const active = activeFor();
      if (id && !active.includes(id)) { active.push(id); saveActive(); renderSaas(); }
      return;
    }
    // A value checkbox toggled.
    const cb = e.target.closest('.ms-opt input[type=checkbox]');
    if (cb) {
      const ms = cb.closest('[data-ms]');
      const key = ms.dataset.ms;
      setVals(key, [...ms.querySelectorAll('.ms-opt input[type=checkbox]:checked')].map((c) => c.value));
      updateSummary(key);
      renderSaas({ keepFilterBar: true }); // keep the open dropdown; only re-filter the table/cards
    }
  });
  bar.addEventListener('click', (e) => {
    // Remove a filter tile.
    const rm = e.target.closest('[data-remove-filter]');
    if (rm) {
      const key = rm.dataset.removeFilter;
      if (state.saasSub === 'unit') state.saasUnitActiveFilters = state.saasUnitActiveFilters.filter((k) => k !== key);
      else state.saasActiveFilters = state.saasActiveFilters.filter((k) => k !== key);
      delete filtersFor()[key];
      saveActive();
      renderSaas();
      return;
    }
    // Open/close a checkbox dropdown.
    const btn = e.target.closest('[data-ms-btn]');
    if (btn) {
      const menu = btn.parentElement.querySelector('.ms-menu');
      const willOpen = menu.hidden;
      closeMenus();
      if (willOpen) { menu.hidden = false; const s = menu.querySelector('.ms-search'); if (s) setTimeout(() => s.focus(), 0); }
      e.stopPropagation();
      return;
    }
    // Clear a dropdown's selections.
    const clear = e.target.closest('[data-ms-clear]');
    if (clear) {
      const key = clear.dataset.msClear;
      clear.closest('.ms-menu').querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
      setVals(key, []);
      updateSummary(key);
      renderSaas({ keepFilterBar: true });
      e.stopPropagation();
    }
  });
  bar.addEventListener('input', (e) => {
    const s = e.target.closest('.ms-search');
    if (!s) return;
    const q = s.value.trim().toLowerCase();
    s.closest('.ms-menu').querySelectorAll('.ms-opt').forEach((opt) => { opt.style.display = opt.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  // Click outside an open SaaS menu closes it.
  document.addEventListener('click', (e) => {
    if (e.target.closest('#saasFilters .ms')) return;
    closeMenus();
  });
}

// ---------- Boot ----------
async function boot() {
  wireTabs(); wireSidebar(); wireActions(); wireGrid(); wireAuth(); wireUsers(); wireProducts(); wireBundles(); wireCloseMonth(); wireEntry(); wireView(); wireColumns(); wireResize(); wireCellTip(); wireReconcile(); wirePager(); wireSalesSupport(); wireChurnEntry(); wireBilling(); wireNotifications(); wireResult(); wireSfRecon(); wireOffsetReview(); wireLegacy(); wireQuickFilter(); wireTotalsZoom(); wireFiltersResize(); wireFilterMenus(); wireAssistant(); wireSaas();
  applyZoom();
  wireUpdateCheck();
  $('#returnAdminBtn').onclick = returnToAdmin;
  if (state.token) {
    try {
      const { user } = await api('/api/me');
      state.user = user;
      await loadAll();
      renderImpersonationBanner(); // restore the banner if a page reload happened mid-impersonation
      return;
    } catch { /* token missing/expired — fall through to login */ }
  }
  showLogin();
}
boot();
