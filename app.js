// app.js — PERQ Revenue Desk frontend (vanilla JS, no build step).

const MONEY = new Set([
  'mrr', 'rerate_old_mrr', 'one_time_fee', 'month1', 'month2', 'month3',
  'offset_amount', 'annual_value', 'company_total_booking', 'commissionable_bookings',
  'google_search_budget', 'ar_final_invoice_amount', 'prorated_churn_amount', 'final_churn_amount',
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
  token: localStorage.getItem('perqToken') || '',
  adminToken: localStorage.getItem('perqAdminToken') || '', // set while impersonating another user
  user: null, // { id, username, role }
  filtersHidden: localStorage.getItem('perqFiltersHidden') === '1',
  zoom: parseFloat(localStorage.getItem('perqZoom')) || 1,
  // Hidden columns per tab, e.g. { bookings: ['notes'], churn: [...] }.
  hiddenCols: (() => { try { return JSON.parse(localStorage.getItem('perqHiddenCols') || '{}'); } catch { return {}; } })(),
  // User-set column widths (px) per tab, e.g. { bookings: { mrr: 120 }, churn: {} }.
  colWidths: (() => { try { return JSON.parse(localStorage.getItem('perqColWidths') || '{}'); } catch { return {}; } })(),
  churnQuarter: 'All',   // dashboard churn-by-month quarter filter
  churnOwner: 'All',     // dashboard churn Account Owner filter (sales users default to their name)
  saasCategory: 'Multifamily', // SaaS Financials: Multifamily | Digital Advertising
  saasQuarter: '',       // SaaS Financials quarter label, e.g. 'Q1 2026' (defaults to current)
  saasSub: 'data',       // SaaS Financials sub-tab: 'data' (MRR table) | 'dashboard' (tiles)
  saasZoom: parseFloat(localStorage.getItem('perqSaasZoom')) || 1,
  churnDetailQuarter: null, // dashboard: quarter whose per-month Churn Details tables are open
  bookingQuarter: 'All', // dashboard booking-per-category quarter filter (separate from churn)
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
  ssBarCollapsed: localStorage.getItem('perqSsBarCollapsed') === '1', // Sales Support toolbar collapsed
  bdDetail: null,     // active Billing Dashboard drill-down key
  bdCollapsed: false, // collapse the Billing Dashboard tiles to focus the detail
  bdAction: null,     // active "For Immediate Action" drill-down: 'golive' | 'churn'
  bdMonth: 'All',     // Billing Dashboard Booking Month/Year filter
  bdFilters: {},      // Billing Dashboard drill-down column filters { colKey: value }
  aiHistory: [],      // "Ask Claude" conversation [{role, content}]
  aiBusy: false,      // a chat request is in flight
  pendingBookings: [], // new-booking payloads awaiting confirmation
  pendingOffsets: [],  // per-line License Transfer offset selections (null or {churnId, amount})
  notifications: [],   // billing notifications (e.g. GoLive changes)
};

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!res.ok && res.status !== 204) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
};

function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Roles / permissions (UX mirror of server enforcement) ----------
function role() { return state.user ? state.user.role : null; }
function isAdmin() { return role() === 'admin'; }
function isSales() { return role() === 'sales'; }                 // salesperson tagged to one owner
function salesOwner() { return state.user ? (state.user.account_owner || '') : ''; }
function isSalesRole() { return role() === 'sales_admin' || role() === 'sales'; }
function canAddDelete() { return role() === 'admin' || role() === 'standard'; } // bookings/churn + imports
function canImport() { return role() === 'admin'; }
function canEditSalesSupport() { return ['admin', 'standard', 'sales_admin', 'sales'].includes(role()); }
function canManageQuarters() { return ['admin', 'sales_admin'].includes(role()); } // open/close quarter
function canEditField(f) {
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
  bookings: new Set(['billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'sage_id']),
  churn: new Set(['template_deleted', 'completed', 'notes']),
};
function isBilling(key) { return !!(BILLING_KEYS[state.tab] && BILLING_KEYS[state.tab].has(key)); }

// Ordered display columns for the active tab, plus a lookup of which keys are computed.
function fieldsForTab() {
  const s = state.schema[state.tab];
  const computedKeys = new Set(s.computed.map((f) => f.key));
  let cols = [...s.editable, ...s.computed];
  // Move this tab's billing fields to the very end, after the computed columns.
  const billing = BILLING_KEYS[state.tab];
  if (billing) {
    cols = [...cols.filter((c) => !billing.has(c.key)), ...cols.filter((c) => billing.has(c.key))];
  }
  return { cols, computedKeys, computed: s.computed };
}

function renderHead() {
  if (state.tab !== 'bookings' && state.tab !== 'churn') { $('#thead').innerHTML = ''; return; }
  const { cols, computedKeys } = fieldsForTab();
  $('#thead').innerHTML =
    `<tr><th class="rownum">#</th>` +
    cols.map((f) => {
      const cls = computedKeys.has(f.key) ? 'computed' : (isBilling(f.key) ? 'billing' : '');
      return `<th class="${cls}" data-col="${f.key}" title="${f.label}">${f.label}<span class="col-resize"></span></th>`;
    }).join('') +
    `<th class="del"></th></tr>`;
}

function rowInnerHtml(row, i, fields) {
  const { cols, computedKeys } = fields || fieldsForTab();
  let html = `<td class="rownum">${i + 1}</td>`;
  for (const f of cols) {
    if (computedKeys.has(f.key)) html += computedCell(f, row);
    else if (canEditField(f)) html += editCell(f, row);
    else html += readonlyCell(f, row);
  }
  let actions = canAddDelete() ? `<button class="row-del" title="Delete row" data-del="${row.id}">✕</button>` : '';
  // Super-admin only, Bookings only: a ▾ reveals Add-below / Duplicate.
  if (state.tab === 'bookings' && isAdmin()) {
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
function currentRows(tab) {
  const rows = state.rows[tab] || [];
  let out = rows;
  if (tab === 'bookings') out = rows.filter((r) => bookingMatch(r, state.filters.bookings));
  else if (tab === 'churn') out = rows.filter((r) => churnMatch(r, state.filters.churn));
  if (tab === 'bookings' || tab === 'churn') out = out.filter((r) => quickFilterPass(r, tab));
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
const TOTALS_FIELDS = {
  bookings: [['MRR', 'mrr'], ['Annual Value', 'annual_value'], ['Company Total Booking', 'company_total_booking'], ['Commissionable', 'commissionable_bookings']],
  churn: [['AR Final Invoice Amt', 'ar_final_invoice_amount'], ['Prorated Churn Amt', 'prorated_churn_amount'], ['Final Churn Amt', 'final_churn_amount']],
};
function renderBookingTotals(rows) {
  const el = $('#bookingTotals');
  const fields = TOTALS_FIELDS[state.tab];
  if (!fields) { el.hidden = true; return; }
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
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
  tbody.innerHTML = slice.map((row, i) => `<tr data-id="${row.id}">${rowInnerHtml(row, start + i, fields)}</tr>`).join('');
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
  // Offset Amount only applies to License Transfers; otherwise show a non-editable dash.
  if (f.key === 'offset_amount' && (row.ctam_type || '').trim() !== 'License Transfer') {
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
// Generic: a row passes if, for every active column filter, its value matches. f is keyed
// by column key, e.g. { sales_rep: 'Kirk Flatter', booking_month: 'April' }.
function rowMatchesFilters(r, f) {
  for (const key in f) {
    const v = f[key];
    if (v == null || v === 'All' || v === '') continue;
    if (key === 'booking_my') { // synthetic combined "Booking Month Year"
      const my = (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '';
      if (my !== String(v)) return false;
      continue;
    }
    if (key === 'churn_quarter') { // synthetic quarter from Final Churn Month
      const info = monthYearQuarter(r.final_churn_month || '');
      const q = info ? info.label : '';
      if (v === '(blank)') { if (q !== '') return false; continue; }
      if (q !== String(v)) return false;
      continue;
    }
    if (key === 'booking_quarter') { // synthetic quarter from Booking Month + Year
      const my = (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '';
      const info = monthYearQuarter(my);
      const q = info ? info.label : '';
      if (v === '(blank)') { if (q !== '') return false; continue; }
      if (q !== String(v)) return false;
      continue;
    }
    if (key === 'added_recent') { // synthetic "recently added" window on created_at
      const days = ADDED_WINDOWS[v];
      if (!days) continue;
      const t = Date.parse(r.created_at || '');
      if (!Number.isFinite(t) || t < Date.now() - days * 86400000) return false;
      continue;
    }
    if (v === '(blank)') { if (String(r[key] ?? '').trim() !== '') return false; continue; }
    if (String(r[key] ?? '') !== String(v)) return false;
  }
  return true;
}
const bookingMatch = rowMatchesFilters;
const churnMatch = rowMatchesFilters;

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
  // Defer so the filter dropdown repaints its new value immediately, then the grid rebuilds.
  requestAnimationFrame(renderBody);
}

function renderSummary() {
  const el = $('#summary');
  const tab = state.tab;
  const rows = tab === 'churn' ? state.rows.churn : state.rows.bookings;
  const f = state.filters[tab];
  if (!f) { el.className = 'summary hidden'; el.innerHTML = ''; return; }

  const distinct = (k) => [...new Set(rows.map((r) => r[k]).filter((v) => v !== null && v !== '' && v !== undefined))];
  const sel = (id, label, vals, cur, disabled) =>
    `<div class="filter"><label>${label}</label><select id="${id}"${disabled ? ' disabled' : ''}>` +
    vals.map((o) => `<option${String(o) === String(cur) ? ' selected' : ''}>${o}</option>`).join('') +
    `</select></div>`;

  // Every column of the active tab is filterable (Dashboard filters use the booking columns).
  let cols = tab === 'churn'
    ? [...state.schema.churn.editable, ...state.schema.churn.computed]
    : [...state.schema.bookings.editable, ...state.schema.bookings.computed];
  // Bookings + Dashboard: offer a single combined "Booking Month/Year" filter instead of separate ones.
  if (tab !== 'churn') {
    cols = cols.filter((c) => c.key !== 'booking_month' && c.key !== 'booking_year');
    cols.unshift({ key: 'booking_my', label: 'Booking Month/Year', type: 'text' });
  }
  // Churn: synthetic "Quarter" (from Final Churn Month) + "Added" (recently-added window).
  if (tab === 'churn') {
    cols.unshift({ key: 'churn_quarter', label: 'Quarter', type: 'text' });
    cols.unshift({ key: 'added_recent', label: 'Added', type: 'text' });
  }
  // Bookings: a synthetic "Quarter" filter (Q1 2026, Q2 2026, …) derived from Booking Month/Year.
  if (tab === 'bookings') {
    cols.unshift({ key: 'booking_quarter', label: 'Quarter', type: 'text' });
  }
  const monthOrder = (state.schema.bookings.editable.find((x) => x.key === 'booking_month') || {}).options || [];
  const MONTH_YEAR_COLS = new Set(['final_churn_month', 'prorated_churn_month', 'final_invoice_month']);
  const valuesFor = (col) => {
    if (col.key === 'added_recent') return ['All', ...Object.keys(ADDED_WINDOWS)];
    if (col.key === 'booking_my') {
      const combos = [...new Set(rows
        .map((r) => (r.booking_month && r.booking_year != null && r.booking_year !== '') ? `${r.booking_month} ${r.booking_year}` : '')
        .filter(Boolean))];
      return ['All', ...sortMonthYear(combos)];
    }
    if (col.key === 'churn_quarter' || col.key === 'booking_quarter') {
      const set = new Set();
      let hasBlank = false;
      for (const r of rows) {
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
    const hasBlank = rows.some((r) => { const v = r[col.key]; return v === null || v === undefined || String(v).trim() === ''; });
    const blank = hasBlank ? ['(blank)'] : [];
    const d = distinct(col.key);
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
    dashboard: ['booking_my', 'pmc', 'sales_rep', 'bpr_prod_category'],
  };
  if (tab === 'churn' && !state.activeFilters.churn) state.activeFilters.churn = ['churn_quarter'];
  if (tab === 'bookings' && !state.activeFilters.bookings) state.activeFilters.bookings = ['booking_quarter'];
  const adjustable = tab === 'bookings' || tab === 'churn';
  const lockRep = isSales() && salesOwner();
  let active = adjustable
    ? (state.activeFilters[tab] || []).filter((k) => colByKey.has(k))
    : (FIXED[tab] || []).filter((k) => colByKey.has(k));
  if (lockRep && tab !== 'churn' && colByKey.has('sales_rep') && !active.includes('sales_rep')) {
    active = adjustable ? ['sales_rep', ...active] : active; // dashboard already includes sales_rep
  }
  const activeSet = new Set(active);
  let filtersHtml = '';
  if (!state.filtersHidden) {
    const tiles = active.map((key) => {
      const col = colByKey.get(key);
      const lbl = escapeHtml(adjustable ? col.label : `Filter by ${col.label}`);
      const vals = valuesFor(col);
      if (key === 'sales_rep' && lockRep) {
        const me = salesOwner();
        const v = vals.includes(me) ? vals : ['All', me, ...vals.filter((x) => x !== 'All')];
        return `<div class="filter" data-filter="${key}"><label>${lbl}</label>`
          + `<select id="${key}" disabled>${v.map((o) => `<option${String(o) === String(me) ? ' selected' : ''}>${o}</option>`).join('')}</select></div>`;
      }
      const cur = f[key] || 'All';
      const opts = vals.map((o) => `<option${String(o) === String(cur) ? ' selected' : ''}>${o}</option>`).join('');
      const x = adjustable ? `<button type="button" class="filter-x" data-remove-filter="${key}" title="Remove filter">✕</button>` : '';
      return `<div class="filter" data-filter="${key}">${x}<label>${lbl}</label><select id="${key}">${opts}</select></div>`;
    }).join('');
    let addTile = '';
    if (adjustable) {
      const addOpts = ['<option value="">+ Add a filter…</option>']
        .concat(cols.filter((c) => !activeSet.has(c.key)).map((c) => `<option value="${c.key}">${escapeHtml(c.label)}</option>`)).join('');
      addTile = `<div class="filter add-filter"><label>Add Filter</label><select id="addFilterSelect">${addOpts}</select></div>`;
    }
    filtersHtml = `<div class="filters-row" style="zoom:${state.filterZoom}">${tiles}${addTile}</div>`;
  }

  // Metric cards live on the Dashboard tab only, on their own row below the filters.
  let metricsHtml = '';
  if (state.tab === 'dashboard') {
    const filtered = rows.filter((r) => bookingMatch(r, f));
    const sum = (k) => filtered.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const totalBooking = sum('company_total_booking');
    const totalOTF = sum('one_time_fee');
    const totalComm = sum('commissionable_bookings');
    metricsHtml = '<div class="metrics-row">' +
      metric('Total Company Booking', totalBooking, true) +
      metric('Total One-Time Fees', totalOTF) +
      metric('Total Commissionable', totalComm) +
      metric('Commissionable + OTF', totalComm + totalOTF) +
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
    for (const r of catRows) {
      const c = (r.bpr_prod_category || '').trim() || 'Uncategorized';
      byCat[c] = (byCat[c] || 0) + (Number(r.company_total_booking) || 0);
    }
    const catCards = Object.keys(byCat).sort().map((c) => metric(c, byCat[c])).join('');
    const bQuarterSel = '<select id="bookingQuarter" class="churn-quarter">' +
      bQuarterVals.map((q) => `<option${q === state.bookingQuarter ? ' selected' : ''}>${q}</option>`).join('') + '</select>';
    metricsHtml += `<div class="metrics-title metrics-title-row"><span>Booking Per Product Category</span>${bQuarterSel}</div>` +
      `<div class="metrics-row">${catCards || '<span class="muted">No data.</span>'}</div>`;

    // Account Owner filter for the whole Churn section (tiles + details). Sales users default
    // to their own name on login; the value is validated against the owners actually present.
    const churnOwners = [...new Set(state.rows.churn.map((r) => String(r.account_owner || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (state.churnOwner !== 'All' && !churnOwners.includes(state.churnOwner)) state.churnOwner = 'All';
    const churnOwnerMatch = (r) => state.churnOwner === 'All' || String(r.account_owner || '').trim() === state.churnOwner;

    // Churn by month: prorated churn + final churn amounts landing in each month.
    const churnByMonth = {};
    const addChurn = (month, amt) => {
      const m = String(month || '').trim();
      const a = Number(amt);
      if (!m || m === '-' || !Number.isFinite(a)) return;
      churnByMonth[m] = (churnByMonth[m] || 0) + a;
    };
    for (const r of state.rows.churn) {
      if (String(r.classification || '') === 'Contraction') continue; // contractions aren't churn
      if (!churnOwnerMatch(r)) continue;
      addChurn(r.prorated_churn_month, r.prorated_churn_amount);
      addChurn(r.final_churn_month, r.final_churn_amount);
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
    const quarterSel = '<select id="churnQuarter" class="churn-quarter">' +
      quarterVals.map((q) => `<option${q === state.churnQuarter ? ' selected' : ''}>${q}</option>`).join('') + '</select>';
    // Account Owner filter (locked to their own name for sales users).
    const ownerVals = ['All', ...churnOwners];
    const churnOwnerSel = `<select id="churnOwner" class="churn-quarter"${isSales() ? ' disabled' : ''}>` +
      ownerVals.map((o) => `<option${o === state.churnOwner ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') + '</select>';
    metricsHtml += `<div class="metrics-title metrics-title-row"><span>Churn</span>`
      + `<label class="churn-filter-lbl">Owner ${churnOwnerSel}</label>${quarterSel}</div>`;
    if (qTotalCards) metricsHtml += `<div class="metrics-row">${qTotalCards}</div>`;
    metricsHtml += `<div class="metrics-row">${churnCards || '<span class="muted">No churn data.</span>'}</div>`;
    // Churn Details: one table per month of the selected quarter (property / MRR dropped / last date).
    if (state.churnDetailQuarter) metricsHtml += renderChurnDetail(state.churnDetailQuarter);
  }

  // Nothing to show (filters hidden and not the dashboard) — collapse the whole bar.
  if (!filtersHtml && !metricsHtml) { el.className = 'summary hidden'; el.innerHTML = ''; return; }
  el.className = 'summary';
  el.innerHTML = filtersHtml + metricsHtml;

  if (!state.filtersHidden) {
    active.forEach((id) => {
      const ctl = $('#' + id);
      if (ctl && !ctl.disabled) ctl.onchange = (e) => { f[id] = e.target.value; onFilterChange(); };
    });
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
  // Click a quarter-total tile -> toggle its per-month Churn Details breakdown.
  el.querySelectorAll('[data-churn-quarter]').forEach((tile) => {
    tile.onclick = () => {
      const label = tile.dataset.churnQuarter;
      state.churnDetailQuarter = state.churnDetailQuarter === label ? null : label;
      renderSummary();
    };
  });
  applyChurnDetailWidths(); // re-apply any saved Churn Details column widths to the new tables
}
function saveActiveFilters() { localStorage.setItem('perqActiveFilters', JSON.stringify(state.activeFilters)); }
function metric(k, v, accent = false) {
  return `<div class="metric${accent ? ' accent' : ''}"><span class="k">${k}</span><span class="v">${fmtMoney(v)}</span></div>`;
}

// Per-month Churn Details for a quarter. Two sets of 3 tables (one per month):
//   1. Real churn (classification != Contraction): Property / MRR dropped / Last Date Under Contract.
//   2. Contracted churn — churn used to offset a License Transfer booking: Property / MRR dropped /
//      Notes (truncated, full text on hover). Sums reconcile with the quarter's month tiles above.
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
      const isContraction = String(r.classification || '') === 'Contraction';
      if (isContraction !== wantContraction) continue;
      // Honor the Churn section's Account Owner filter.
      if (state.churnOwner !== 'All' && String(r.account_owner || '').trim() !== state.churnOwner) continue;
      const e = { prop: r.property || r.property_id || '—', pmc: r.pmc_buying_center || '', last: r.last_date_under_contract || '', note: r.notes || '' };
      // A churn event can land a prorated remainder one month and the full amount the next.
      if (String(r.prorated_churn_month || '').trim() === monthLabel) {
        const a = Number(r.prorated_churn_amount);
        if (Number.isFinite(a) && a !== 0) out.push({ ...e, amt: a });
      }
      if (String(r.final_churn_month || '').trim() === monthLabel) {
        const a = Number(r.final_churn_amount);
        if (Number.isFinite(a)) out.push({ ...e, amt: a });
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
    const body = list.length
      ? list.map((x) => `<tr><td data-col="pmc" title="${escapeAttr(x.pmc || '')}">${escapeHtml(x.pmc || '—')}</td><td data-col="prop" title="${escapeAttr(x.prop || '')}">${escapeHtml(x.prop)}</td><td class="num" data-col="mrr">${fmtMoney(x.amt)}</td>${thirdCell(x)}</tr>`).join('')
      : `<tr><td class="muted" colspan="4" style="padding:10px">${emptyLabel}</td></tr>`;
    return '<div class="churn-detail-card">'
      + `<div class="churn-detail-month">${escapeHtml(monthLabel)}</div>`
      + '<div class="churn-detail-scroll">'
      + `<table><thead><tr>${th('PMC', 'pmc')}${th('Property', 'prop')}${th('MRR Dropped', 'mrr', 'num')}${th(thirdLabel, thirdKey)}</tr></thead>`
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
const BD_BILLING = new Set(['billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'sage_id']);
// Who can edit a field in the drill-down: admin/standard all; billing = billing columns.
function bdCanEdit(key) {
  const r = role();
  if (r === 'admin' || r === 'standard') return true;
  if (r === 'billing') return BD_BILLING.has(key);
  return false;
}
const BD_DETAIL_KEYS = ['property_id', 'property_name', 'pmc', 'product', 'mrr', 'one_time_fee',
  'billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'golive_date', 'sage_id'];
// Columns shown in the Churn "For Immediate Action" drill-down (editable so billing can act).
const CHURN_DETAIL_KEYS = ['property_id', 'property', 'product', 'mrr', 'last_date_under_contract',
  'template_deleted', 'completed', 'notes'];
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
  const implPending = (r) => hasImplFee(r) && r.implementation_billing_status !== 'Completed';
  const recCompleted = (r) => r.recurring_billing_status === 'Completed';
  const recPending = (r) => r.recurring_billing_status === 'Pending';
  const notLive = (r) => !r.golive_date;
  const live = (r) => !!r.golive_date;
  const noSage = (r) => !String(r.sage_id || '').trim();

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
    + '</div>';

  // Drill-down: editable detail table for the selected tile (edits write back to bookings).
  // Columns are resizable, and a multi-filter (on any shown column) narrows the rows.
  if (state.bdDetail && BD_PREDS[state.bdDetail]) {
    const { pred, label } = BD_PREDS[state.bdDetail];
    const defs = BD_DETAIL_KEYS.map((k) => state.schema.bookings.editable.find((f) => f.key === k)).filter(Boolean);
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
  }
  $('#billingInner').classList.toggle('bd-collapsed', state.bdCollapsed);
  $('#billingInner').innerHTML = html;
  applyBillingDetailWidths(); // re-apply any saved drill-down column widths
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
  const headRow = '<th class="bd-act-col">Action</th>' + defs.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('');
  const body = notifs.map((n) => {
    const row = byId.get(String(n.booking_id));
    if (!row) return ''; // the underlying row no longer exists
    const act = `<td class="bd-act-col"><button type="button" class="bd-resolve" data-resolve="${n.id}" title="${escapeAttr(n.message || 'Mark resolved')}">⚠ Resolve</button></td>`;
    const cells = defs.map((f) => (canEdit(f.key) ? editCell(f, row) : readonlyCell(f, row))).join('');
    return `<tr data-id="${row.id}">${act}${cells}</tr>`;
  }).join('');
  return `<div class="metrics-title">${title} (${notifs.length})</div>`
    + `<div class="bd-detail" data-action-tab="${tab}"><table><thead><tr>${headRow}</tr></thead>`
    + `<tbody>${body || `<tr><td class="muted" colspan="${defs.length + 1}" style="padding:12px">No matching rows.</td></tr>`}</tbody></table></div>`;
}

function wireBilling() {
  // Click a tile -> toggle its drill-down.
  $('#billingInner').addEventListener('click', async (e) => {
    if (e.target.closest('[data-bd-toggle]')) { state.bdCollapsed = !state.bdCollapsed; renderBillingDashboard(); return; }
    // "For Immediate Action" tile -> toggle its drill-down.
    const actionTile = e.target.closest('[data-bd-action]');
    if (actionTile) {
      state.bdAction = state.bdAction === actionTile.dataset.bdAction ? null : actionTile.dataset.bdAction;
      renderBillingDashboard();
      return;
    }
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
    // Drill-down multi-filter controls.
    if (e.target.id === 'bdAddFilter') { const k = e.target.value; if (k) state.bdFilters[k] = 'All'; renderBillingDashboard(); return; }
    const bf = e.target.closest('[data-bd-filter]');
    if (bf) { state.bdFilters[bf.dataset.bdFilter] = e.target.value; renderBillingDashboard(); return; }
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
      // Editing a watched date here raises a Billing alert -> reload so the tile/bell reflect it.
      if ((key === 'golive_date' || key === 'last_date_under_contract') && (isAdmin() || role() === 'billing')) {
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
async function loadAll() {
  state.schema = await api('/api/schema');
  state.rows.bookings = await api('/api/bookings');
  state.rows.churn = await api('/api/churn');
  state.rows.sales_support = await api('/api/sales_support');
  state.salesPeriods = await api('/api/sales_periods');
  // Default to the latest open quarter (periods are listed oldest→newest); else the latest period.
  const openPeriods = state.salesPeriods.filter((p) => p.status === 'open');
  state.salesPeriod = openPeriods.length ? openPeriods[openPeriods.length - 1].period
    : (state.salesPeriods.length ? state.salesPeriods[state.salesPeriods.length - 1].period : '');
  state.notifications = (isAdmin() || role() === 'billing') ? await api('/api/notifications') : [];
  // Salesforce Recon Data (admin-only tab) + its Account Name list for the Sales Support PMC dropdown.
  state.rows.salesforce_recon = isAdmin() ? await api('/api/salesforce_recon') : [];
  state.sfPmcs = ['admin', 'standard', 'sales_admin', 'sales'].includes(role())
    ? await api('/api/salesforce_recon/pmcs') : [];
  // Legacy trackers (admin + billing only).
  if (isAdmin() || role() === 'billing') {
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
}

function renderAll() {
  // The New Booking tab is admin-only.
  document.querySelector('[data-tab="newbooking"]').hidden = !isAdmin();
  if (state.tab === 'newbooking' && !isAdmin()) state.tab = 'dashboard';
  // The Billing Dashboard is for admins and billing users.
  const canBilling = isAdmin() || role() === 'billing';
  document.querySelector('[data-tab="billing"]').hidden = !canBilling;
  if (state.tab === 'billing' && !canBilling) state.tab = 'dashboard';
  // Salesforce Recon Data is admin-only.
  document.querySelector('[data-tab="sfrecon"]').hidden = !isAdmin();
  if (state.tab === 'sfrecon' && !isAdmin()) state.tab = 'dashboard';
  // Legacy trackers are for admins and billing users.
  document.querySelector('[data-tab="legacy"]').hidden = !canBilling;
  if (state.tab === 'legacy' && !canBilling) state.tab = 'dashboard';
  // SaaS Financials (MRR movement view) — admins, standard, and billing.
  const canSaas = isAdmin() || role() === 'standard' || role() === 'billing';
  document.querySelector('[data-tab="saas"]').hidden = !canSaas;
  if (state.tab === 'saas' && !canSaas) state.tab = 'dashboard';
  // (Sales roles see Churn read-only — canEditField returns false for them.)

  const isEntry = state.tab === 'newbooking';
  const isSales = state.tab === 'salessupport';
  const isBillingTab = state.tab === 'billing';
  const isSfrecon = state.tab === 'sfrecon';
  const isLegacy = state.tab === 'legacy';
  const isSaas = state.tab === 'saas';
  const isGrid = state.tab === 'bookings' || state.tab === 'churn';
  // SaaS Financials shows its own title in its header row, so don't duplicate it up here.
  $('#currentTab').textContent = isSaas ? '' : (TAB_LABELS[state.tab] || '');
  // Account / role-based controls.
  $('#importBtn').style.display = canImport() ? '' : 'none';
  $('#priorBookingsBtn').hidden = !canImport();
  // In the More PERQs menu these are role-gated only (work from any tab).
  $('#churnUploadBtn').hidden = !canAddDelete();
  $('#reconcileBtn').hidden = !canAddDelete();
  $('#golivesBtn').hidden = !canAddDelete();
  $('#offsetReviewBtn').hidden = !canAddDelete();
  $('#usersBtn').hidden = !isAdmin();
  $('#notifWrap').hidden = !canBilling;
  updateBell();
  // "Ask Claude" assistant: shown only when configured (API key set) and for full-data roles.
  const canAssistant = !!(state.schema && state.schema.assistantEnabled) && ['admin', 'standard', 'billing'].includes(role());
  $('#aiWidget').hidden = !canAssistant;
  $('#userWrap').hidden = !state.user;
  $('#userChip').innerHTML = state.user
    ? `${escapeHtml(state.user.username)} · <span class="role">${escapeHtml(state.user.role)}</span>` : '';
  // Quick "+ Add row" is only used on the Churn grid now (Bookings uses the New Booking tab).
  $('#addRowBtn').style.display = (state.tab === 'churn' && canAddDelete()) ? '' : 'none';
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
  $('#toggleFilters').style.display = (isEntry || isSales || isBillingTab || isSfrecon || isLegacy || isSaas) ? 'none' : '';
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

// ---------- Events ----------
function wireGrid() {
  const tbody = $('#tbody');
  tbody.addEventListener('change', async (e) => {
    const ctl = e.target.closest('[data-key]');
    if (!ctl) return;
    const tr = ctl.closest('tr');
    const id = Number(tr.dataset.id);
    const key = ctl.dataset.key;
    try {
      let updated = await api(`/api/${state.tab}/${id}`, {
        method: 'PATCH', body: JSON.stringify({ [key]: ctl.value }),
      });
      // Leaving License Transfer? Clear any stale Offset Amount so it can't linger unused.
      if (key === 'ctam_type' && ctl.value.trim() !== 'License Transfer' && updated.offset_amount != null) {
        updated = await api(`/api/${state.tab}/${id}`, {
          method: 'PATCH', body: JSON.stringify({ offset_amount: '' }),
        });
      }
      updateRowInState(state.tab, updated);
      // Changing CTAM Type flips whether the Offset cell is editable — re-render the page.
      if (key === 'ctam_type') {
        renderBody();
      } else {
        refreshComputedCells(tr, updated);
      }
      if (state.tab === 'bookings' || state.tab === 'churn') { renderSummary(); renderBookingTotals(currentRows(state.tab)); }
      // Editing a watched date (GoLive / Last Date Under Contract) raises a Billing alert.
      if ((key === 'golive_date' || key === 'last_date_under_contract') && (isAdmin() || role() === 'billing')) {
        state.notifications = await api('/api/notifications');
        updateBell();
      }
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });

  // Insert a freshly created row right after the source row so it appears "below" it.
  const insertRowAfter = (afterId, row) => {
    const arr = state.rows.bookings;
    const idx = arr.findIndex((r) => r.id === afterId);
    if (idx >= 0) arr.splice(idx + 1, 0, row); else arr.push(row);
  };
  const afterCreate = (id, row) => {
    insertRowAfter(id, row);
    renderBody(); renderSummary(); renderBookingTotals(currentRows('bookings'));
    $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
  };

  // Close any open row-action menu when clicking elsewhere.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-more')) tbody.querySelectorAll('.row-more-menu').forEach((m) => { m.hidden = true; });
  });

  tbody.addEventListener('click', async (e) => {
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
    // under the current filter); Bookings + admin only.
    const add = e.target.closest('[data-add-below]');
    if (add) {
      const cur = state.rows.bookings.find((r) => r.id === Number(add.dataset.addBelow));
      const ctx = {};
      ['booking_month', 'booking_year', 'centralized', 'sales_rep', 'property_id', 'property_name', 'pmc', 'buying_center']
        .forEach((k) => { if (cur && cur[k] != null && cur[k] !== '') ctx[k] = cur[k]; });
      try {
        const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify(ctx) });
        afterCreate(cur.id, row);
        toast('Row added');
      } catch (err) { toast(err.message, true); }
      return;
    }
    // Duplicate this row (copy all editable fields); Bookings + admin only.
    const dup = e.target.closest('[data-dup]');
    if (dup) {
      const cur = state.rows.bookings.find((r) => r.id === Number(dup.dataset.dup));
      if (!cur) return;
      const payload = {};
      state.schema.bookings.editable.forEach((fld) => { if (cur[fld.key] != null) payload[fld.key] = cur[fld.key]; });
      try {
        const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
        afterCreate(cur.id, row);
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
  // "More PERQs" dropdown holding the file actions.
  $('#moreBtn').onclick = () => { $('#moreMenu').hidden = !$('#moreMenu').hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) $('#moreMenu').hidden = true; });

  // Quick blank-row add — only used on the Churn grid (Bookings uses the New Booking tab).
  $('#addRowBtn').onclick = async () => {
    if (state.tab !== 'churn' || !canAddDelete()) return;
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
      showResult('GoLives upload complete',
        '<ul class="result-list">'
        + `<li><strong>${data.updated}</strong> GoLive date(s) set (were blank)</li>`
        + `<li><strong>${data.changed}</strong> changed (billing notified)</li>`
        + `<li><strong>${data.unchanged}</strong> unchanged (same date)</li>`
        + `<li><strong>${data.notFound}</strong> not found in Bookings (Property ID + Product + MRR)</li>`
        + `<li class="muted">${data.total} row(s) in the file</li>`
        + '</ul>');
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Export opens a dialog to pick the booking period first.
  $('#exportBtn').onclick = (e) => { e.preventDefault(); $('#moreMenu').hidden = true; openExport(); };
  $('#exportClose').onclick = () => { $('#exportModal').hidden = true; };
  $('#exportModal').addEventListener('click', (e) => { if (e.target.id === 'exportModal') $('#exportModal').hidden = true; });
  $('#exportConfirm').onclick = doExport;
}

// Populate the export dialog's Month/Year options from the bookings and show it.
function openExport() {
  const rows = state.rows.bookings;
  const monthVals = ['All', ...MONTHS.filter((m) => rows.some((r) => r.booking_month === m))];
  const yearVals = ['All', ...[...new Set(rows.map((r) => r.booking_year).filter((v) => v != null && v !== ''))].sort((a, b) => a - b)];
  $('#exportMonth').innerHTML = monthVals.map((m) => `<option>${m}</option>`).join('');
  $('#exportYear').innerHTML = yearVals.map((y) => `<option>${y}</option>`).join('');
  $('#exportModal').hidden = false;
}

async function doExport() {
  const month = $('#exportMonth').value;
  const year = $('#exportYear').value;
  const scope = $('#exportScope').value;
  const params = new URLSearchParams();
  if (month && month !== 'All') params.set('month', month);
  if (year && year !== 'All') params.set('year', year);
  if (scope === 'commission') params.set('scope', 'commission');
  try {
    const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
    const res = await fetch(`/api/export?${params.toString()}`, { headers });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const label = ([month !== 'All' ? month : '', year !== 'All' ? year : ''].filter(Boolean).join('_')
      || new Date().toISOString().slice(0, 10)) + (scope === 'commission' ? '_Commission' : '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `PERQ_Revenue_Desk_Export_${label}.xlsx`.replace(/\s+/g, '_');
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
  'pilot_or_ctam', 'pilot_type', 'ctam_type', 'mql',
  'contract_term', 'booked_term', 'date_signed',
];
// Per-product fields. Offset Amount only applies (and only shows) on License Transfers.
const PRODUCT_KEYS = ['product', 'mrr', 'one_time_fee', 'offset_amount'];

// Booking Month/Year default to the dataset's period and "stick" to the last value used.
let entryDefaults = { booking_month: 'May', booking_year: '2026' };

// Fields a booking can't be submitted without (marked with * and enforced on submit).
const REQUIRED_ENTRY_KEYS = new Set(['contract_term', 'booked_term', 'date_signed']);

function entryFieldHtml(f) {
  let control;
  if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${escapeAttr(o)}">${o || '—'}</option>`).join('');
    control = `<select data-key="${f.key}">${opts}</select>`;
  } else {
    const inputType = f.type === 'date' ? 'date' : (f.type === 'number' ? 'number' : 'text');
    const step = f.type === 'number' ? ' step="any"' : '';
    // PMC - Property is auto-combined from PMC + Property Name, so it's read-only.
    const ro = f.key === 'property_name' ? ' readonly title="Auto-combined from PMC + Property Name"' : '';
    control = `<input type="${inputType}"${step}${ro} data-key="${f.key}" />`;
  }
  const hidden = f.key === 'offset_amount' ? ' hidden' : '';
  const req = REQUIRED_ENTRY_KEYS.has(f.key) ? ' <span class="req">*</span>' : '';
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
    + '<div class="entry-card-form"><div class="entry-card-head"><span class="entry-card-title">Products</span></div>'
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

// Show the "remove property" ✕ only when there's more than one property block.
function renumberProperties() {
  const blocks = [...$('#propertyBlocks').querySelectorAll('[data-block]')];
  const show = blocks.length > 1;
  blocks.forEach((b) => { const x = b.querySelector('.property-remove'); if (x) x.style.visibility = show ? '' : 'hidden'; });
}

// Add a property block. With `copyFrom`, carry over its Booking details EXCEPT the property
// identity (Property ID + Name), which the user fills in fresh; otherwise seed from defaults.
function addPropertyBlock(copyFrom) {
  const tmp = document.createElement('div');
  tmp.innerHTML = propertyBlockHtml();
  const block = tmp.firstElementChild;
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
    state.pendingOffsets = payloads.map(() => null);
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
// Churns that can offset a booking in quarter bq: same OR future quarter (never past),
// each annotated with its quarter and whether it's a future-quarter churn.
function offsetEligibleChurns(pmc, bq) {
  if (!pmc || !bq) return [];
  const p = String(pmc).trim().toLowerCase();
  return state.rows.churn
    .filter((c) => String(c.pmc_buying_center || '').trim().toLowerCase() === p
      && String(c.classification || '') !== 'Contraction')
    .map((c) => ({ churn: c, quarter: churnQuarterInfo(c) }))
    .filter((e) => e.quarter && qCmp(e.quarter, bq) >= 0)
    .map((e) => ({ ...e, isFuture: qCmp(e.quarter, bq) > 0 }))
    .sort((a, b) => (a.isFuture - b.isFuture) || qCmp(a.quarter, b.quarter));
}
const churnDropAmt = (c) => Math.abs(Number(c && c.mrr) || 0); // monthly MRR that dropped

// Renders the confirm dialog. Re-runs whenever an offset selection changes so the
// computed Company Total / Commissionable reflect the License Transfer offset.
async function renderConfirm() {
  const base = state.pendingBookings || [];
  const offsets = state.pendingOffsets || [];
  // Effective payloads: apply each chosen offset as a License Transfer.
  const eff = base.map((p, i) => offsets[i]
    ? { ...p, pilot_or_ctam: 'CTAM', ctam_type: 'License Transfer', offset_amount: offsets[i].amount }
    : p);
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
    rowsHtml += `<tr><td>${escapeHtml(r.product || '—')}${offsets[i] ? ' <span class="lt-badge">License Transfer</span>' : ''}</td>`
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
  // A churn can only offset one line, so options exclude churns chosen on other lines.
  const offLines = base.map((p, i) => {
    const q = monthYearQuarter(`${p.booking_month || ''} ${p.booking_year || ''}`);
    const list = offsetEligibleChurns(p.pmc, q);
    if (!list.length) return '';
    const usedByOthers = new Set(offsets.map((o, j) => (o && j !== i) ? String(o.churnId) : null).filter(Boolean));
    const opts = list.filter((e) => !usedByOthers.has(String(e.churn.id)));
    const sel = offsets[i] ? String(offsets[i].churnId) : '';
    const optionHtml = ['<option value="">No offset</option>'].concat(opts.map((e) => {
      const c = e.churn;
      return `<option value="${c.id}"${sel === String(c.id) ? ' selected' : ''}>${escapeHtml(c.property || c.pmc_buying_center || 'churn')} — dropped ${escapeHtml(m(churnDropAmt(c)))}/mo · ${escapeHtml(e.quarter.label)}${e.isFuture ? ' (future)' : ''}</option>`;
    })).join('');
    const amtHtml = offsets[i]
      ? `<label class="offset-amt-l">Offset <input type="text" class="offset-amt" data-offset-amt="${i}" value="${escapeAttr(m(offsets[i].amount))}" /></label>` : '';
    const label = `${escapeHtml(propName(p))} · ${escapeHtml(p.product || `Line ${i + 1}`)}`;
    return `<div class="offset-line"><span class="offset-prod">${label}</span>`
      + `<select class="offset-sel" data-offset-line="${i}">${optionHtml}</select>${amtHtml}</div>`;
  }).filter(Boolean).join('');
  if (offLines) {
    html += '<div class="offset-box"><div class="offset-title">License Transfer offsets available</div>'
      + offLines
      + '<p class="offset-note">Selecting a churn tags that line as a License Transfer (offset applied) and reclassifies the churn as a Contraction. Future-quarter churns are flagged.</p></div>';
  }
  $('#confirmSummary').innerHTML = html;
}

async function confirmBookings() {
  const base = state.pendingBookings || [];
  const offsets = state.pendingOffsets || [];
  if (!base.length) { $('#confirmModal').hidden = true; return; }
  try {
    let added = 0;
    let offsetCount = 0;
    for (let i = 0; i < base.length; i++) {
      const off = offsets[i];
      const payload = off
        ? { ...base[i], pilot_or_ctam: 'CTAM', ctam_type: 'License Transfer', offset_amount: off.amount }
        : base[i];
      const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
      if (off) {
        await api('/api/bookings/apply-offset', { method: 'POST', body: JSON.stringify({ bookingId: row.id, churnId: off.churnId, offsetAmount: off.amount }) });
        offsetCount += 1;
      }
      added += 1;
    }
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
}

// ---------- License Transfer offset review (existing bookings) ----------
// Bookings (not yet offset) that have an eligible churn in the same quarter + PMC.
function offsetCandidates() {
  const out = [];
  for (const b of state.rows.bookings) {
    if (b.offset_churn_id) continue; // already offset
    const bq = monthYearQuarter(`${b.booking_month || ''} ${b.booking_year || ''}`);
    if (!bq) continue;
    const eligible = offsetEligibleChurns(b.pmc, bq);
    if (eligible.length) out.push({ booking: b, eligible });
  }
  return out;
}
function renderOffsetReview() {
  const m = fmtMoney;
  const cands = offsetCandidates();
  if (!cands.length) {
    $('#offsetBody').innerHTML = '<p class="muted" style="padding:10px">No bookings currently have a matching churn (same PMC, this or a future quarter) available to offset.</p>';
    return;
  }
  const rows = cands.map(({ booking: b, eligible }) => {
    const hasSame = eligible.some((e) => !e.isFuture);
    const opts = eligible.map((e) => {
      const c = e.churn;
      return `<option value="${c.id}" data-mrr="${Number(c.mrr) || 0}">${escapeHtml(c.property || c.pmc_buying_center || 'churn')} — dropped ${escapeHtml(m(churnDropAmt(c)))}/mo · ${escapeHtml(e.quarter.label)}${e.isFuture ? ' (future)' : ''}</option>`;
    }).join('');
    const period = `${b.booking_month || ''} ${b.booking_year || ''}`.trim();
    const lineMrr = parseMoney(b.mrr) || 0;
    const firstMrr = Number(eligible[0].churn.mrr) || 0;
    const def = Math.min(lineMrr || firstMrr, firstMrr || lineMrr);
    const futureNote = hasSame ? ''
      : '<div class="offset-future-note">⚠ No churn this quarter for this PMC — the option(s) are future-quarter churns.</div>';
    const propFull = b.property_name || b.property_id || '—';
    return `<tr data-booking="${b.id}">
      <td class="offset-prop" title="${escapeAttr(propFull)}"><div class="offset-prop-name">${escapeHtml(propFull)}</div><div class="muted-sm">${escapeHtml(b.pmc || '')} · ${escapeHtml(period)}</div>${futureNote}</td>
      <td class="offset-prod" title="${escapeAttr(b.product || '')}">${escapeHtml(b.product || '—')}</td>
      <td class="num">${m(b.mrr)}</td>
      <td><select class="offset-sel" data-churn-sel>${opts}</select></td>
      <td class="num"><input type="text" class="offset-amt" data-amt value="${escapeAttr(m(def))}" /></td>
      <td><button type="button" class="btn solid offset-apply" data-apply-offset>Apply</button></td>
    </tr>`;
  }).join('');
  $('#offsetBody').innerHTML = '<table class="recon-table offset-table">'
    + '<colgroup><col class="c-prop"><col class="c-prod"><col class="c-mrr"><col class="c-churn"><col class="c-offset"><col class="c-apply"></colgroup>'
    + '<thead><tr>'
    + '<th>Booking property</th><th>Product</th><th class="num">MRR</th><th>Offset with churn</th><th class="num">Offset</th><th></th>'
    + `</tr></thead><tbody>${rows}</tbody></table>`;
}
function wireOffsetReview() {
  $('#offsetReviewBtn').onclick = () => { $('#moreMenu').hidden = true; $('#offsetModal').hidden = false; renderOffsetReview(); };
  $('#offsetClose').onclick = () => { $('#offsetModal').hidden = true; };
  $('#offsetModal').addEventListener('click', (e) => { if (e.target.id === 'offsetModal') $('#offsetModal').hidden = true; });
  // Changing the churn re-suggests the offset = min(booking MRR, churned MRR).
  $('#offsetBody').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-churn-sel]');
    if (!sel) return;
    const tr = sel.closest('[data-booking]');
    const b = state.rows.bookings.find((x) => String(x.id) === tr.dataset.booking);
    const churnMrr = Number(sel.selectedOptions[0] && sel.selectedOptions[0].dataset.mrr) || 0;
    const lineMrr = parseMoney(b && b.mrr) || 0;
    const amtInput = tr.querySelector('[data-amt]');
    if (amtInput) amtInput.value = fmtMoney(Math.min(lineMrr || churnMrr, churnMrr || lineMrr));
  });
  $('#offsetBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-apply-offset]');
    if (!btn) return;
    const tr = btn.closest('[data-booking]');
    const bookingId = Number(tr.dataset.booking);
    const churnId = Number(tr.querySelector('[data-churn-sel]').value);
    const offsetAmount = parseMoney(tr.querySelector('[data-amt]').value);
    try {
      await api('/api/bookings/apply-offset', { method: 'POST', body: JSON.stringify({ bookingId, churnId, offsetAmount }) });
      state.rows.bookings = await api('/api/bookings');
      state.rows.churn = await api('/api/churn');
      renderOffsetReview();
      renderAll();
      toast('Offset applied');
    } catch (err) { toast(err.message, true); }
  });
}

function wireEntry() {
  $('#addPropertyBtn').onclick = () => {
    const blocks = [...$('#propertyBlocks').querySelectorAll('[data-block]')];
    addPropertyBlock(blocks[blocks.length - 1] || null);
  };
  $('#submitEntriesBtn').onclick = submitEntries;
  // Confirm dialog: Confirm creates the rows; Cancel returns to the entry form unchanged.
  $('#confirmSubmit').onclick = confirmBookings;
  $('#confirmCancel').onclick = () => { $('#confirmModal').hidden = true; };
  $('#confirmClose').onclick = () => { $('#confirmModal').hidden = true; };
  $('#confirmModal').addEventListener('click', (e) => { if (e.target.id === 'confirmModal') $('#confirmModal').hidden = true; });
  // Offset controls inside the confirm dialog (re-renders to show updated computed values).
  $('#confirmSummary').addEventListener('change', (e) => {
    const selEl = e.target.closest('[data-offset-line]');
    if (selEl) {
      const i = Number(selEl.dataset.offsetLine);
      const churnId = selEl.value;
      if (!churnId) { state.pendingOffsets[i] = null; }
      else {
        const c = state.rows.churn.find((x) => String(x.id) === String(churnId));
        const lineMrr = parseMoney(state.pendingBookings[i].mrr) || 0;
        const churnMrr = Number(c && c.mrr) || 0;
        state.pendingOffsets[i] = { churnId: Number(churnId), amount: Math.min(lineMrr || churnMrr, churnMrr || lineMrr) };
      }
      renderConfirm();
      return;
    }
    const amtEl = e.target.closest('[data-offset-amt]');
    if (amtEl) {
      const i = Number(amtEl.dataset.offsetAmt);
      if (state.pendingOffsets[i]) { state.pendingOffsets[i].amount = parseMoney(amtEl.value); renderConfirm(); }
    }
  });
  // All property blocks share one delegated set of handlers (blocks are added/removed dynamically).
  const blocks = $('#propertyBlocks');
  // Booking-details changes (scoped to the block they happened in).
  blocks.addEventListener('change', (e) => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const block = e.target.closest('[data-block]');
    if (!block) return;
    if (key === 'ctam_type') setProductOffsets(block);
    if (key === 'pilot_or_ctam') updatePilotCtam(block);
    if (key === 'pmc' || key === 'property_only') recomputeCombinedName(block); // rebuild "PMC - Property"
    if (key === 'property_id' && autofillFromSfRecon(block)) toast('Property Name & PMC filled from Salesforce Recon');
  });
  // Live-update the combined name (and recon autofill) as PMC / Property Name / Property ID are typed.
  blocks.addEventListener('input', (e) => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const block = e.target.closest('[data-block]');
    if (!block) return;
    if (key === 'pmc' || key === 'property_only') recomputeCombinedName(block);
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
// For the "Pilot / New Logo" section, only count bookings tagged Pilot in "Pilot or CTAM".
function ssActual(row, monthName, year) {
  const pmc = String(row.pmc || '').trim().toLowerCase();
  const cat = String(row.product_category || '').trim();
  if (!pmc || !cat || !monthName) return 0;
  const pilotOnly = String(row.section || '').trim() === 'Pilot / New Logo';
  let sum = 0;
  for (const b of state.rows.bookings) {
    if (String(b.pmc || '').trim().toLowerCase() === pmc
      && (b.bpr_prod_category || '') === cat
      && b.booking_month === monthName
      && reconNum(b.booking_year) === year
      && (!pilotOnly || String(b.pilot_or_ctam || '').trim() === 'Pilot')) {
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
  const pilotOnly = String(row.section || '').trim() === 'Pilot / New Logo';
  return state.rows.bookings.filter((b) =>
    String(b.pmc || '').trim().toLowerCase() === pmc
    && (b.bpr_prod_category || '') === cat
    && months.has(b.booking_month)
    && reconNum(b.booking_year) === year
    && (!pilotOnly || String(b.pilot_or_ctam || '').trim() === 'Pilot'));
}

// Hover-tooltip HTML for an Actual cell: the properties booked + their amounts + the total.
function ssActualTipHtml(row, key) {
  const list = ssActualBreakdown(row, key);
  if (!list.length) return '';
  const total = list.reduce((a, b) => a + (Number(b.company_total_booking) || 0), 0);
  const items = list.map((b) => {
    const isLT = String(b.ctam_type || '').trim() === 'License Transfer' || b.offset_churn_id;
    const note = String(b.notes || '').trim();
    return `<div class="tip-row"><span class="tip-prop">${escapeHtml(b.property_name || b.property_id || '—')}`
      + `${b.product ? ` <em>${escapeHtml(b.product)}</em>` : ''}`
      + `${isLT ? ' <span class="tip-lt">License Transfer</span>' : ''}</span>`
      + `<span class="tip-amt">${escapeHtml(fmtMoney(b.company_total_booking))}</span></div>`
      + (isLT && note ? `<div class="tip-note">${escapeHtml(note)}</div>` : '');
  }).join('');
  const head = `${escapeHtml(row.pmc || '—')} · ${escapeHtml(row.product_category || '')} · ${list.length} booking${list.length === 1 ? '' : 's'}`;
  return `<div class="tip-head">${head}</div>${items}`
    + `<div class="tip-row tip-total"><span>Actual</span><span class="tip-amt">${escapeHtml(fmtMoney(total))}</span></div>`;
}

const ssFieldDef = (key) => state.schema.sales_support.editable.find((f) => f.key === key);

// Freeze the leading columns (through PMC) so they stay visible when scrolling right.
// Offsets are computed from the actual header widths (recomputed on resize).
const SS_FREEZE = ['product_category', 'section', 'pmc'];
function ssApplyFreeze() {
  // Start past the sticky row-number column so the frozen columns don't overlap it.
  const rownumTh = $('#ssHead th.rownum');
  let left = rownumTh ? rownumTh.getBoundingClientRect().width / (state.zoom || 1) : 0;
  let css = '';
  for (const key of SS_FREEZE) {
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
    return `<td class="ss-actual${ltZero ? ' ss-lt-zero' : ''}" data-col="${key}">${fmtMoney(value)}</td>`;
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
  const owners = (ssFieldDef('account_owner')?.options || []).filter(Boolean);
  const products = (ssFieldDef('product_category')?.options || []).filter(Boolean);
  const sections = (ssFieldDef('section')?.options || []).filter(Boolean);
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
  const ff = state.ssFilters;
  const rows = state.rows.sales_support
    .filter((r) => r.period === state.salesPeriod)
    .filter((r) => ff.owner === 'All' || (r.account_owner || '') === ff.owner)
    .filter((r) => ff.product === 'All' || (r.product_category || '') === ff.product)
    .filter((r) => ff.section === 'All' || (r.section || '') === ff.section)
    .sort((a, b) =>
      catIdx(a.product_category) - catIdx(b.product_category)
      || secIdx(a.section) - secIdx(b.section)
      || String(a.pmc || '').localeCompare(String(b.pmc || '')));

  const colCount = cols.length + (editCol ? 1 : 0);
  let html = '';
  let group = null;
  let groupRows = []; // rows of the current section, for the subtotal
  let alt = 0; // alternating-row counter, reset at each section for clean striping
  let n = 0;   // running row number across the whole filtered set
  const flushSubtotal = () => { if (group !== null && groupRows.length) html += ssSubtotalRowHtml(cols, groupRows, editCol); };
  for (const row of rows) {
    const g = `${row.product_category || '—'}  ·  ${row.section || '—'}`;
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
  $('#ssForm').innerHTML = state.schema.sales_support.editable
    .filter((f) => f.key !== 'period') // period is set server-side to the open quarter
    .map(ssFormFieldHtml).join('');
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
  try {
    const row = await api('/api/sales_support', { method: 'POST', body: JSON.stringify(payload) });
    state.rows.sales_support.push(row);
    $('#ssModal').hidden = true;
    renderSalesSupport();
    ssApplyFreeze();
    toast('Row added');
  } catch (err) { toast(err.message, true); }
}

function wireSalesSupport() {
  $('#ssAddRow').onclick = () => { if (ssEditable()) openSsForm(); };
  $('#ssBarToggle').onclick = () => {
    state.ssBarCollapsed = !state.ssBarCollapsed;
    localStorage.setItem('perqSsBarCollapsed', state.ssBarCollapsed ? '1' : '0');
    applySsBar();
  };
  $('#ssPeriod').onchange = (e) => { state.salesPeriod = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssFilterOwner').onchange = (e) => { state.ssFilters.owner = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssFilterProduct').onchange = (e) => { state.ssFilters.product = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssFilterSection').onchange = (e) => { state.ssFilters.section = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
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
    const row = $('#summary .filters-row');
    if (row) row.style.zoom = z;
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
const BOOKING_FREEZE = ['property_name'];
const CHURN_FREEZE = ['pmc_buying_center', 'property'];
const GRID_FREEZE = { bookings: BOOKING_FREEZE, churn: CHURN_FREEZE };
function applyGridFreeze() {
  const freezeKeys = GRID_FREEZE[state.tab];
  if (!freezeKeys) { $('#gridFreezeStyle').textContent = ''; return; }
  const hidden = new Set(state.hiddenCols[state.tab] || []);
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
  const items = cols.map((f) =>
    `<label class="col-item"><input type="checkbox" data-col="${f.key}"${hidden.includes(f.key) ? '' : ' checked'} /> ${f.label}</label>`
  ).join('');
  $('#colMenu').innerHTML =
    '<div class="col-menu-head"><span>Show columns</span><button type="button" class="view-btn" id="colShowAll">Show all</button></div>' + items;
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
  // "Show all" resets visibility for the current tab.
  $('#colMenu').addEventListener('click', (e) => {
    if (e.target.id !== 'colShowAll') return;
    state.hiddenCols[state.tab] = [];
    saveHiddenCols();
    renderColMenu(); applyColHide(); applyGridFreeze();
  });
  // Click outside closes the menu.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.col-menu-wrap')) $('#colMenu').hidden = true;
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

async function openUsers() { $('#usersModal').hidden = false; await renderUsersList(); }

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
      return `<div class="user-row">
        <span class="user-name">${escapeHtml(u.username)}</span>
        <select data-role-for="${u.id}">${opts}</select>
        ${ownerSel}
        ${impBtn}
        <button type="button" class="view-btn" data-pw-user="${u.id}">Reset password</button>
        <button type="button" class="view-btn danger" data-del-user="${u.id}">Delete</button>
      </div>`;
    }).join('');
  } catch (e) { $('#usersList').innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}

function wireUsers() {
  $('#usersBtn').onclick = () => { $('#userMenu').hidden = true; openUsers(); };
  $('#usersClose').onclick = () => { $('#usersModal').hidden = true; };
  $('#usersModal').addEventListener('click', (e) => { if (e.target.id === 'usersModal') $('#usersModal').hidden = true; });

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
    }
  });

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
// Churn rows carry a product (not a computed category), so map the product to a category the
// same way bprCategory does (Digital Advertising bucket = Google Search Management + SEO).
const SAAS_DA_PRODUCTS = new Set(['Google Search Management', 'SEO']);
function saasProductCategory(product) {
  return SAAS_DA_PRODUCTS.has(String(product || '').trim()) ? 'Digital Advertising' : 'Multifamily';
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
  const goLive = monthIdxFromDate(b.golive_date);
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
  for (const b of state.rows.bookings) addIdx(monthIdxFromDate(b.golive_date));
  for (const c of state.rows.churn) { addIdx(monthIdxFromMonthYear(c.final_invoice_month)); addIdx(monthIdxFromMonthYear(c.final_churn_month)); }
  set.add(currentQuarterLabel());
  return [...set].sort((a, b) => { const A = parseQuarterLabel(a); const B = parseQuarterLabel(b); return (A.year - B.year) || (A.q - B.q); });
}
const SAAS_TYPE_CLASS = {
  'New Logo': 'saas-newlogo', Expansion: 'saas-expansion', Upsell: 'saas-upsell',
  Reactivation: 'saas-reactivation', Contraction: 'saas-contraction', Downgrade: 'saas-downgrade',
  'Churn prorated product': 'saas-churn-pro', 'Churn Product': 'saas-churn',
  'Churn Prorated Rooftop': 'saas-churn-pro', 'Churn Rooftop': 'saas-churn',
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
function renderSaas() {
  const qOpts = saasQuarterOptions();
  if (!qOpts.includes(state.saasQuarter)) {
    state.saasQuarter = qOpts.includes(currentQuarterLabel()) ? currentQuarterLabel() : (qOpts[qOpts.length - 1] || currentQuarterLabel());
  }
  $('#saasQuarter').innerHTML = qOpts.map((q) => `<option${q === state.saasQuarter ? ' selected' : ''}>${q}</option>`).join('') || '<option>—</option>';
  $('#saasCategory').value = state.saasCategory;
  applySaasZoom();
  // Sub-tabs: MRR Data (table) | Dashboard (tiles) | Unit Economics (type buckets).
  const sub = state.saasSub;
  document.querySelectorAll('[data-saas-sub]').forEach((b) => b.classList.toggle('active', b.dataset.saasSub === sub));
  $('#saasTableWrap').hidden = sub !== 'data';
  $('#saasDashboard').hidden = sub !== 'dashboard';
  $('#saasUnit').hidden = sub !== 'unit';
  $('#saasZoomGroup').style.display = sub === 'data' ? '' : 'none';
  $('#saasNote').style.display = sub === 'data' ? '' : 'none';

  const { q, year } = parseQuarterLabel(state.saasQuarter);
  const idxs = [0, 1, 2].map((i) => year * 12 + (q - 1) * 3 + i);
  const category = state.saasCategory;

  // Shared churn cache (used by all three sub-tabs).
  const churnCache = new Map();
  const churnOf = (b) => { if (!churnCache.has(b.id)) churnCache.set(b.id, saasChurnFor(b)); return churnCache.get(b.id); };

  if (sub === 'dashboard') { renderSaasDashboard(idxs, category, churnOf); return; }

  // Precompute, across ALL active bookings: each property's bookings + first go-live month,
  // each PMC's first go-live month (for New Logo). Needed by the table and the Unit report.
  const allByProp = new Map();
  const firstGoLive = new Map();   // property -> earliest go-live idx (any category)
  const pmcFirstGoLive = new Map(); // pmc -> earliest go-live idx (drives New Logo)
  for (const b of state.rows.bookings) {
    const gi = monthIdxFromDate(b.golive_date);
    if (gi == null) continue;
    const pid = String(b.property_id || b.property_name || `#${b.id}`);
    if (!allByProp.has(pid)) allByProp.set(pid, []);
    allByProp.get(pid).push(b);
    if (!firstGoLive.has(pid) || gi < firstGoLive.get(pid)) firstGoLive.set(pid, gi);
    const pmc = String(b.pmc || '').trim().toLowerCase();
    if (pmc && (!pmcFirstGoLive.has(pmc) || gi < pmcFirstGoLive.get(pmc))) pmcFirstGoLive.set(pmc, gi);
  }
  // The property's total recognized MRR across ALL categories in a month — for Rooftop checks.
  const propTotalAt = (pid, idx) => (allByProp.get(pid) || []).reduce((a, b) => a + saasBookingMonthMRR(b, churnOf(b), idx), 0);

  if (sub === 'unit') { renderSaasUnit(idxs, category, { churnOf, firstGoLive, pmcFirstGoLive, propTotalAt }); return; }

  // MRR Type for a property+category row in absolute month `idx`. Returns { type, note }.
  function saasTypeFor(pid, pmc, catBookings, idx) {
    // Adds first: a product going live this month.
    const goLives = catBookings.filter((b) => monthIdxFromDate(b.golive_date) === idx);
    if (goLives.length) {
      const off = goLives.find((b) => b.offset_churn_id);
      if (off) return { type: 'Reactivation', note: String(off.notes || '') }; // offset/license-transfer booking
      if (idx === firstGoLive.get(pid)) {
        return { type: pmcFirstGoLive.get(pmc) === idx ? 'New Logo' : 'Expansion', note: '' };
      }
      if (goLives.some((b) => String(b.ctam_type || '').trim() === 'Downgrade')) return { type: 'Downgrade', note: '' };
      return { type: 'Upsell', note: '' };
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
    if (saasCategoryOf(b) !== category) continue;
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

  const rows = [];
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
    rows.push({
      pmc: info.pmcDisplay, propertyId: info.property_id, property: info.property,
      sageId, goLive, isLive, status: isLive ? 'Active & Live' : 'Not Live', currentMrr,
      products, monthVals, types: typeObjs, total: monthVals.reduce((a, v) => a + v, 0),
    });
  }
  rows.sort((a, b) => String(a.property).localeCompare(String(b.property)));

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
      + `<td data-col="status"><span class="saas-status ${r.isLive ? 'saas-status-live' : 'saas-status-notlive'}">${escapeHtml(r.status)}</span></td>`
      + `<td class="saas-products" data-col="products" title="${escapeAttr(r.products.join(', '))}">${escapeHtml(r.products.join(', ') || '—')}</td>`
      + `<td class="num" data-col="mrr">${fmtMoney(r.currentMrr)}</td>`
      + `${cells}<td class="num" data-col="qtotal">${fmtMoney(r.total)}</td></tr>`;
  }).join('') : `<tr><td class="muted" colspan="${10 + idxs.length * 2}" style="padding:14px">No ${escapeHtml(category)} properties in ${escapeHtml(state.saasQuarter)}.</td></tr>`;

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
  $('#saasCount').textContent = `${rows.length} ${category} propert${rows.length === 1 ? 'y' : 'ies'} · ${state.saasQuarter}`;
  applyColWidths(); // re-apply any saved SaaS column widths to the freshly built table
}
// SaaS Dashboard sub-tab: monthly Recognized-MRR tiles + monthly Churn tiles for the quarter,
// scoped to the selected category. Auto-filters to the current quarter via state.saasQuarter.
function renderSaasDashboard(idxs, category, churnOf) {
  // Recognized MRR per month: all category bookings (not-live contribute 0).
  const mrrByMonth = idxs.map((idx) => state.rows.bookings.reduce(
    (a, b) => (saasCategoryOf(b) === category ? a + saasBookingMonthMRR(b, churnOf(b), idx) : a), 0));
  // Churn per month (Churn Tracker amounts; category by product; excludes Contraction).
  const churnByMonth = idxs.map(() => 0);
  for (const c of state.rows.churn) {
    if (String(c.classification || '') === 'Contraction') continue;
    if (saasProductCategory(c.product) !== category) continue;
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
  $('#saasDashboard').innerHTML =
    `<div class="metrics-title">${escapeHtml(category)} — Recognized MRR by Month</div><div class="metrics-row">${mrrTiles}</div>`
    + `<div class="metrics-title">${escapeHtml(category)} — Churn by Month</div><div class="metrics-row">${churnTiles}</div>`;
  $('#saasCount').textContent = `${category} · ${state.saasQuarter}`;
}

// Order the buckets appear in the Unit Economics Report. "Churn" rolls up the churn-family
// types (prorated/full, product/rooftop) plus Downgrade.
const SAAS_BUCKET_ORDER = ['New Logo', 'Expansion', 'Upsell', 'Reactivation', 'Contraction', 'Churn'];

// Unit Economics Report sub-tab: one card per month of the quarter (like Churn Details).
// Each month's table lists the type buckets (New Logo, Expansion, …) as groups, with
// PMC - Property / Product / MRR rows. Long PMC - Property values truncate; scroll horizontally.
function renderSaasUnit(idxs, category, h) {
  const { churnOf, firstGoLive, pmcFirstGoLive, propTotalAt } = h;
  const idxSet = new Set(idxs);
  const events = [];
  for (const b of state.rows.bookings) {
    if (saasCategoryOf(b) !== category) continue;
    const pid = String(b.property_id || b.property_name || `#${b.id}`);
    const pmcProperty = b.property_name || b.property_id || '—'; // combined "PMC - Property"
    const mrr = Number(b.mrr) || 0;
    const push = (type, monthIdx) => events.push({ type, pmcProperty, product: b.product || '—', monthIdx, mrr });
    // Go-live (add) event.
    const gi = monthIdxFromDate(b.golive_date);
    if (gi != null && idxSet.has(gi)) {
      if (b.offset_churn_id) push('Reactivation', gi);
      else if (gi === firstGoLive.get(pid)) push(pmcFirstGoLive.get(String(b.pmc || '').trim().toLowerCase()) === gi ? 'New Logo' : 'Expansion', gi);
      else if (String(b.ctam_type || '').trim() === 'Downgrade') push('Downgrade', gi); // goes in the Churn bucket
      else push('Upsell', gi);
    }
    // Churn (drop) events.
    const c = churnOf(b);
    if (c) {
      const isContraction = String(c.classification || '') === 'Contraction';
      const pIdx = monthIdxFromMonthYear(c.final_invoice_month);
      if (pIdx != null && idxSet.has(pIdx)) push(isContraction ? 'Contraction' : (propTotalAt(pid, pIdx + 1) === 0 ? 'Churn Prorated Rooftop' : 'Churn prorated product'), pIdx);
      const fIdx = monthIdxFromMonthYear(c.final_churn_month);
      if (fIdx != null && idxSet.has(fIdx)) push(isContraction ? 'Contraction' : (propTotalAt(pid, fIdx) === 0 ? 'Churn Rooftop' : 'Churn Product'), fIdx);
    }
  }
  const monthLabel = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
  // One card per month; inside, group rows by type bucket (in order).
  const cards = idxs.map((mIdx) => {
    const monthEvents = events.filter((e) => e.monthIdx === mIdx);
    let body;
    if (!monthEvents.length) {
      body = '<tr><td class="muted" colspan="3" style="padding:10px">No activity this month.</td></tr>';
    } else {
      // Group by bucket (Churn family rolls up into one "Churn" group).
      const byBucket = new Map();
      for (const e of monthEvents) { const bk = saasBucketOf(e.type); if (!byBucket.has(bk)) byBucket.set(bk, []); byBucket.get(bk).push(e); }
      body = SAAS_BUCKET_ORDER.filter((bk) => byBucket.has(bk)).map((bk) => {
        const list = byBucket.get(bk).sort((a, b) => String(a.pmcProperty).localeCompare(b.pmcProperty));
        const total = list.reduce((a, e) => a + e.mrr, 0);
        const head = `<tr class="saas-unit-group"><td colspan="3"><span class="saas-pill ${SAAS_TYPE_CLASS[bk] || ''}">${escapeHtml(bk)}</span>`
          + `<span class="saas-unit-gcount">${list.length}</span><span class="saas-unit-gtotal">${fmtMoney(total)}</span></td></tr>`;
        const rows = list.map((e) =>
          `<tr><td class="saas-unit-prop" title="${escapeAttr(e.pmcProperty)}">${escapeHtml(e.pmcProperty)}</td>`
          + `<td>${escapeHtml(e.product)}</td><td class="num">${fmtMoney(e.mrr)}</td></tr>`).join('');
        return head + rows;
      }).join('');
    }
    return '<div class="churn-detail-card"><div class="churn-detail-month">'
      + `${escapeHtml(monthLabel(mIdx))} <span class="saas-unit-mcount">(${monthEvents.length})</span></div>`
      + '<div class="churn-detail-scroll"><table><thead><tr><th>PMC - Property</th><th>Product</th><th class="num">MRR</th></tr></thead>'
      + `<tbody>${body}</tbody></table></div></div>`;
  }).join('');
  $('#saasUnit').innerHTML = `<div class="churn-detail-grid">${cards}</div>`;
  $('#saasCount').textContent = `${category} · ${state.saasQuarter} · ${events.length} event${events.length === 1 ? '' : 's'}`;
}

function wireSaas() {
  $('#saasCategory').onchange = (e) => { state.saasCategory = e.target.value; renderSaas(); };
  $('#saasQuarter').onchange = (e) => { state.saasQuarter = e.target.value; renderSaas(); };
  document.querySelectorAll('[data-saas-sub]').forEach((b) => {
    b.onclick = () => { state.saasSub = b.dataset.saasSub; renderSaas(); };
  });
  const setZoom = (z) => { state.saasZoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10)); localStorage.setItem('perqSaasZoom', String(state.saasZoom)); applySaasZoom(); };
  $('#saasZoomOut').onclick = () => setZoom(state.saasZoom - 0.1);
  $('#saasZoomIn').onclick = () => setZoom(state.saasZoom + 0.1);
}

// ---------- Boot ----------
async function boot() {
  wireTabs(); wireSidebar(); wireActions(); wireGrid(); wireAuth(); wireUsers(); wireEntry(); wireView(); wireColumns(); wireResize(); wireCellTip(); wireReconcile(); wirePager(); wireSalesSupport(); wireBilling(); wireNotifications(); wireResult(); wireSfRecon(); wireOffsetReview(); wireLegacy(); wireQuickFilter(); wireTotalsZoom(); wireFiltersResize(); wireAssistant(); wireSaas();
  applyZoom();
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
