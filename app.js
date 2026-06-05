// app.js — PERQ Revenue Desk frontend (vanilla JS, no build step).

const MONEY = new Set([
  'mrr', 'rerate_old_mrr', 'one_time_fee', 'month1', 'month2', 'month3',
  'offset_amount', 'annual_value', 'company_total_booking', 'commissionable_bookings',
  'google_search_budget', 'ar_final_invoice_amount', 'prorated_churn_amount', 'final_churn_amount',
]);

const state = {
  tab: 'dashboard',
  schema: null,
  rows: { bookings: [], churn: [], sales_support: [] },
  // Dashboard and Bookings filter independently: filtering the grid must not move the
  // dashboard totals, and vice versa.
  filters: {
    dashboard: { month: 'All', year: 'All', pmc: 'All', prop: 'All', rep: 'All', cat: 'All', recbill: 'All', impbill: 'All' },
    bookings:  { month: 'All', year: 'All', pmc: 'All', prop: 'All', rep: 'All', cat: 'All', recbill: 'All', impbill: 'All' },
    churn:     { pmcbc: 'All', property: 'All', product: 'All', fcm: 'All' },
  },
  token: localStorage.getItem('perqToken') || '',
  user: null, // { id, username, role }
  filtersHidden: localStorage.getItem('perqFiltersHidden') === '1',
  zoom: parseFloat(localStorage.getItem('perqZoom')) || 1,
  // Hidden columns per tab, e.g. { bookings: ['notes'], churn: [...] }.
  hiddenCols: (() => { try { return JSON.parse(localStorage.getItem('perqHiddenCols') || '{}'); } catch { return {}; } })(),
  // User-set column widths (px) per tab, e.g. { bookings: { mrr: 120 }, churn: {} }.
  colWidths: (() => { try { return JSON.parse(localStorage.getItem('perqColWidths') || '{}'); } catch { return {}; } })(),
  churnQuarter: 'All',   // dashboard churn-by-month quarter filter
  bookingQuarter: 'All', // dashboard booking-per-category quarter filter (separate from churn)
  reconcile: { uploaded: [], result: null }, // bookings reconciliation upload + diff
  pageSize: localStorage.getItem('perqPageSize') || '100', // rows per page ('all' = no paging)
  page: { bookings: 1, churn: 1 },
  salesPeriods: [],   // [{ period, quarter, year, status }]
  salesPeriod: '',    // the quarter currently being viewed in Sales Support
  bdDetail: null,     // active Billing Dashboard drill-down key
  bdCollapsed: false, // collapse the Billing Dashboard tiles to focus the detail
  pendingBookings: [], // new-booking payloads awaiting confirmation
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
function canAddDelete() { return role() === 'admin' || role() === 'standard'; }
function canImport() { return role() === 'admin'; }
function canEditField(f) {
  const r = role();
  if (r === 'admin' || r === 'standard') return true;
  if (r === 'billing') return isBilling(f.key);
  return false; // viewer (or not logged in)
}

// A centered result dialog that stays open until dismissed.
function showResult(title, bodyHtml) {
  $('#resultTitle').textContent = title;
  $('#resultBody').innerHTML = bodyHtml;
  $('#resultModal').hidden = false;
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

function rowInnerHtml(row, i) {
  const { cols, computedKeys } = fieldsForTab();
  let html = `<td class="rownum">${i + 1}</td>`;
  for (const f of cols) {
    if (computedKeys.has(f.key)) html += computedCell(f, row);
    else if (canEditField(f)) html += editCell(f, row);
    else html += readonlyCell(f, row);
  }
  const del = canAddDelete() ? `<button title="Delete row" data-del="${row.id}">✕</button>` : '';
  html += `<td class="del">${del}</td>`;
  return html;
}

// The rows for the active grid tab, after applying that tab's filters.
function currentRows(tab) {
  const rows = state.rows[tab] || [];
  if (tab === 'bookings') return rows.filter((r) => bookingMatch(r, state.filters.bookings));
  if (tab === 'churn') return rows.filter((r) => churnMatch(r, state.filters.churn));
  return rows;
}

// Render only the current page of rows (default 100) — keeps tab-switch/filtering fast
// on large tables. Row numbers reflect the global position within the filtered set.
function renderBody() {
  const tbody = $('#tbody');
  if (state.tab !== 'bookings' && state.tab !== 'churn') { tbody.innerHTML = ''; renderPager(0, 1, 1, 0, 0); return; }
  const rows = currentRows(state.tab);
  const size = state.pageSize === 'all' ? (rows.length || 1) : Number(state.pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  let page = Math.min(Math.max(1, state.page[state.tab] || 1), totalPages);
  state.page[state.tab] = page;
  const start = (page - 1) * size;
  const slice = state.pageSize === 'all' ? rows : rows.slice(start, start + size);
  tbody.innerHTML = '';
  slice.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    tr.innerHTML = rowInnerHtml(row, start + i);
    tbody.appendChild(tr);
  });
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
// True when a booking row passes the given filter selection (f = one filter set,
// e.g. state.filters.dashboard or state.filters.bookings).
function bookingMatch(r, f) {
  return (f.month === 'All' || r.booking_month === f.month)
    && (f.year === 'All' || String(r.booking_year) === String(f.year))
    && (f.pmc === 'All' || r.pmc === f.pmc)
    && (f.prop === 'All' || r.property_name === f.prop)
    && (f.rep === 'All' || r.sales_rep === f.rep)
    && (f.cat === 'All' || r.bpr_prod_category === f.cat)
    && (!f.recbill || f.recbill === 'All' || r.recurring_billing_status === f.recbill)
    && (!f.impbill || f.impbill === 'All' || r.implementation_billing_status === f.impbill);
}

// True when a churn row passes the churn filter selection.
function churnMatch(r, f) {
  return (f.pmcbc === 'All' || r.pmc_buying_center === f.pmcbc)
    && (f.property === 'All' || r.property === f.property)
    && (f.product === 'All' || r.product === f.product)
    && (f.fcm === 'All' || r.final_churn_month === f.fcm);
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
  renderBody();
}

function renderSummary() {
  const el = $('#summary');
  const tab = state.tab;
  const rows = tab === 'churn' ? state.rows.churn : state.rows.bookings;
  const f = state.filters[tab];
  if (!f) { el.className = 'summary hidden'; el.innerHTML = ''; return; }

  const distinct = (k) => [...new Set(rows.map((r) => r[k]).filter((v) => v !== null && v !== '' && v !== undefined))];
  const sel = (id, label, vals, cur) =>
    `<div class="filter"><label>${label}</label><select id="${id}">` +
    vals.map((o) => `<option${String(o) === String(cur) ? ' selected' : ''}>${o}</option>`).join('') +
    `</select></div>`;

  let filterDefs;
  if (tab === 'churn') {
    filterDefs = [
      ['pmcbc', 'Filter by PMC Buying Center', ['All', ...distinct('pmc_buying_center').sort()], f.pmcbc],
      ['property', 'Filter by Property', ['All', ...distinct('property').sort()], f.property],
      ['product', 'Filter by Product', ['All', ...distinct('product').sort()], f.product],
      ['fcm', 'Filter by Final Churn Month', ['All', ...sortMonthYear(distinct('final_churn_month'))], f.fcm],
    ];
  } else {
    // Months in calendar order (from the schema), restricted to those present in the data.
    const monthOrder = (state.schema.bookings.editable.find((x) => x.key === 'booking_month') || {}).options || [];
    const presentMonths = new Set(distinct('booking_month'));
    filterDefs = [
      ['month', 'Filter by Booking Month', ['All', ...monthOrder.filter((m) => presentMonths.has(m))], f.month],
      ['year', 'Filter by Booking Year', ['All', ...distinct('booking_year').sort((a, b) => a - b)], f.year],
      ['pmc', 'Filter by PMC', ['All', ...distinct('pmc').sort()], f.pmc],
    ];
    // Property Name is only offered on the Bookings tab (too granular for dashboard totals).
    if (tab === 'bookings') filterDefs.push(['prop', 'Filter by Property Name', ['All', ...distinct('property_name').sort()], f.prop]);
    filterDefs.push(['rep', 'Filter by Sales Rep', ['All', ...distinct('sales_rep').sort()], f.rep]);
    filterDefs.push(['cat', 'Filter by BPR Category', ['All', ...distinct('bpr_prod_category').sort()], f.cat]);
    // Billing-status filters: Bookings tab, admin/billing roles only.
    if (tab === 'bookings' && (isAdmin() || role() === 'billing')) {
      filterDefs.push(['recbill', 'Filter by Recurring Billing', ['All', ...distinct('recurring_billing_status').sort()], f.recbill]);
      filterDefs.push(['impbill', 'Filter by Impl. Billing', ['All', ...distinct('implementation_billing_status').sort()], f.impbill]);
    }
  }

  let filtersHtml = '';
  if (!state.filtersHidden) {
    filtersHtml = '<div class="filters-row">' +
      filterDefs.map(([id, label, vals, cur]) => sel(id, label, vals, cur)).join('') +
      '</div>';
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

    // Churn by month: prorated churn + final churn amounts landing in each month.
    const churnByMonth = {};
    const addChurn = (month, amt) => {
      const m = String(month || '').trim();
      const a = Number(amt);
      if (!m || m === '-' || !Number.isFinite(a)) return;
      churnByMonth[m] = (churnByMonth[m] || 0) + a;
    };
    for (const r of state.rows.churn) {
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
    const qTotalCards = [...qTotals.keys()]
      .sort((a, b) => { const ia = quarterMap.get(a); const ib = quarterMap.get(b); return (ia.year - ib.year) || (ia.q - ib.q); })
      .map((label) => metric(`${label} total`, qTotals.get(label), true))
      .join('');
    const quarterSel = '<select id="churnQuarter" class="churn-quarter">' +
      quarterVals.map((q) => `<option${q === state.churnQuarter ? ' selected' : ''}>${q}</option>`).join('') + '</select>';
    metricsHtml += `<div class="metrics-title metrics-title-row"><span>Churn</span>${quarterSel}</div>`;
    if (qTotalCards) metricsHtml += `<div class="metrics-row">${qTotalCards}</div>`;
    metricsHtml += `<div class="metrics-row">${churnCards || '<span class="muted">No churn data.</span>'}</div>`;
  }

  // Nothing to show (filters hidden and not the dashboard) — collapse the whole bar.
  if (!filtersHtml && !metricsHtml) { el.className = 'summary hidden'; el.innerHTML = ''; return; }
  el.className = 'summary';
  el.innerHTML = filtersHtml + metricsHtml;

  if (!state.filtersHidden) {
    filterDefs.forEach(([id]) => {
      const ctl = $('#' + id);
      if (ctl) ctl.onchange = (e) => { f[id] = e.target.value; onFilterChange(); };
    });
  }
  // Quarter filters live in the metrics area (always present on the dashboard).
  const qSel = $('#churnQuarter');
  if (qSel) qSel.onchange = (e) => { state.churnQuarter = e.target.value; renderSummary(); };
  const bqSel = $('#bookingQuarter');
  if (bqSel) bqSel.onchange = (e) => { state.bookingQuarter = e.target.value; renderSummary(); };
}
function metric(k, v, accent = false) {
  return `<div class="metric${accent ? ' accent' : ''}"><span class="k">${k}</span><span class="v">${fmtMoney(v)}</span></div>`;
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
  'billing_trigger', 'recurring_billing_status', 'implementation_billing_status', 'completed_by', 'completed_date', 'golive_date'];

function renderBillingDashboard() {
  const rows = state.rows.bookings;
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

  const BD_PREDS = {
    implFee: { label: 'Properties with Implementation Fees', pred: hasImplFee },
    implBilled: { label: 'Implementation Fees — Billed (Completed)', pred: (r) => hasImplFee(r) && implCompleted(r) },
    implPending: { label: 'Implementation Fees — Pending / Not Billed', pred: implPending },
    recCompleted: { label: 'Recurring Billing — Completed', pred: recCompleted },
    recPending: { label: 'Recurring Billing — Pending', pred: recPending },
    notLive: { label: 'Not Live (no GoLive date)', pred: notLive },
    live: { label: 'Live Properties', pred: live },
  };

  // Tiles are clickable; data-bd ties each to a drill-down predicate.
  const card = (label, value, bd, accent) =>
    `<div class="metric clickable${accent ? ' accent' : ''}${state.bdDetail === bd ? ' active' : ''}" data-bd="${bd}"><span class="k">${label}</span><span class="v">${value}</span></div>`;

  let html = `<div class="bd-bar"><button type="button" class="view-btn" data-bd-toggle>${state.bdCollapsed ? 'Show metrics ▾' : 'Hide metrics ▴'}</button></div>`;
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
    + '</div>';

  // Drill-down: editable detail table for the selected tile (edits write back to bookings).
  if (state.bdDetail && BD_PREDS[state.bdDetail]) {
    const { pred, label } = BD_PREDS[state.bdDetail];
    const defs = BD_DETAIL_KEYS.map((k) => state.schema.bookings.editable.find((f) => f.key === k)).filter(Boolean);
    const matching = rows.filter(pred);
    const headRow = defs.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('');
    const bodyRows = matching.map((row) =>
      `<tr data-id="${row.id}">${defs.map((f) => (bdCanEdit(f.key) ? editCell(f, row) : readonlyCell(f, row))).join('')}</tr>`).join('');
    html += `<div class="metrics-title">${escapeHtml(label)} (${matching.length})</div>`
      + '<div class="bd-detail"><table><thead><tr>' + headRow + '</tr></thead><tbody>'
      + (bodyRows || `<tr><td class="muted" colspan="${defs.length || 1}" style="padding:12px">No matching properties.</td></tr>`)
      + '</tbody></table></div>';
  }
  $('#billingInner').classList.toggle('bd-collapsed', state.bdCollapsed);
  $('#billingInner').innerHTML = html;
}

function wireBilling() {
  // Click a tile -> toggle its drill-down.
  $('#billingInner').addEventListener('click', (e) => {
    if (e.target.closest('[data-bd-toggle]')) { state.bdCollapsed = !state.bdCollapsed; renderBillingDashboard(); return; }
    const tile = e.target.closest('[data-bd]');
    if (!tile) return;
    state.bdDetail = state.bdDetail === tile.dataset.bd ? null : tile.dataset.bd;
    renderBillingDashboard();
  });
  // Edit a cell in the drill-down -> save to bookings and refresh.
  $('#billingInner').addEventListener('change', async (e) => {
    const ctl = e.target.closest('[data-key]');
    if (!ctl) return;
    const tr = ctl.closest('tr');
    if (!tr || !tr.dataset.id) return;
    try {
      const updated = await api(`/api/bookings/${tr.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ [ctl.dataset.key]: ctl.value }) });
      updateRowInState('bookings', updated);
      renderBillingDashboard();
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- Data ops ----------
async function loadAll() {
  state.schema = await api('/api/schema');
  state.rows.bookings = await api('/api/bookings');
  state.rows.churn = await api('/api/churn');
  state.rows.sales_support = await api('/api/sales_support');
  state.salesPeriods = await api('/api/sales_periods');
  const openP = state.salesPeriods.find((p) => p.status === 'open');
  state.salesPeriod = openP ? openP.period
    : (state.salesPeriods.length ? state.salesPeriods[state.salesPeriods.length - 1].period : '');
  state.notifications = (isAdmin() || role() === 'billing') ? await api('/api/notifications') : [];
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

  const isEntry = state.tab === 'newbooking';
  const isSales = state.tab === 'salessupport';
  const isBillingTab = state.tab === 'billing';
  const isGrid = state.tab === 'bookings' || state.tab === 'churn';
  $('#currentTab').textContent = TAB_LABELS[state.tab] || '';
  // Account / role-based controls.
  $('#importBtn').style.display = canImport() ? '' : 'none';
  // In the More PERQs menu these are role-gated only (work from any tab).
  $('#churnUploadBtn').hidden = !canAddDelete();
  $('#reconcileBtn').hidden = !canAddDelete();
  $('#golivesBtn').hidden = !canAddDelete();
  $('#usersBtn').hidden = !isAdmin();
  $('#notifWrap').hidden = !canBilling;
  $('#notifCount').textContent = state.notifications.length ? String(state.notifications.length) : '';
  $('#changePwBtn').hidden = !state.user;
  $('#logoutBtn').hidden = !state.user;
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
  // View tools: filters where there's a summary; columns/zoom only where a grid shows.
  $('#toggleFilters').style.display = (isEntry || isSales || isBillingTab) ? 'none' : '';
  $('#toggleFilters').textContent = state.filtersHidden ? 'Show filters' : 'Hide filters';
  $('#zoomGroup').style.display = (isGrid || isSales) ? '' : 'none';
  $('#colBtn').style.display = isGrid ? '' : 'none';
  $('#colMenu').hidden = true;
  if (isEntry && !$('#productLines').children.length) resetEntryView();
  if (isSales) renderSalesSupport();
  if (isBillingTab) renderBillingDashboard();
  renderHead(); renderSummary(); renderBody();
  applyColHide();
  applyColWidths();
  if (isSales) ssApplyFreeze();
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
      if (state.tab === 'bookings') renderSummary();
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const id = Number(btn.dataset.del);
    if (!confirm('Delete this row?')) return;
    try {
      await api(`/api/${state.tab}/${id}`, { method: 'DELETE' });
      state.rows[state.tab] = state.rows[state.tab].filter((r) => r.id !== id);
      renderBody(); renderSummary();
      $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
      toast('Row deleted');
    } catch (err) { toast(err.message, true); }
  });
}

const TAB_LABELS = {
  dashboard: 'Dashboard', billing: 'Billing Dashboard', salessupport: 'Sales Support',
  newbooking: 'New Booking', bookings: 'Bookings', churn: 'Churn Tracker',
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
      renderAll();
      $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
      toast(`Added ${data.added}, skipped ${data.skipped} duplicate${data.skipped === 1 ? '' : 's'}`);
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
  'centralized', 'sales_rep', 'property_id', 'property_name', 'pmc', 'buying_center',
  'pilot_or_ctam', 'pilot_type', 'ctam_type', 'mql',
  'contract_term', 'booked_term', 'date_signed',
];
// Per-product fields. Offset Amount only applies (and only shows) on License Transfers.
const PRODUCT_KEYS = ['product', 'mrr', 'one_time_fee', 'offset_amount'];

// Booking Month/Year default to the dataset's period and "stick" to the last value used.
let entryDefaults = { booking_month: 'May', booking_year: '2026' };

function entryFieldHtml(f) {
  let control;
  if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${escapeAttr(o)}">${o || '—'}</option>`).join('');
    control = `<select data-key="${f.key}">${opts}</select>`;
  } else {
    const inputType = f.type === 'date' ? 'date' : (f.type === 'number' ? 'number' : 'text');
    const step = f.type === 'number' ? ' step="any"' : '';
    control = `<input type="${inputType}"${step} data-key="${f.key}" />`;
  }
  const hidden = f.key === 'offset_amount' ? ' hidden' : '';
  return `<div class="entry-field" data-field="${f.key}"${hidden}><label>${f.label}</label>${control}</div>`;
}

function fieldDef(key) { return state.schema.bookings.editable.find((f) => f.key === key); }

function renderSharedFields() {
  $('#sharedFields').innerHTML = SHARED_KEYS.map(fieldDef).filter(Boolean).map(entryFieldHtml).join('');
  for (const [k, v] of Object.entries(entryDefaults)) {
    const ctl = $(`#sharedFields [data-key="${k}"]`);
    if (ctl && v != null && v !== '') ctl.value = v;
  }
  updatePilotCtam();
}

// Pilot Type applies only to Pilots and CTAM Type only to CTAMs — grey out and blank the
// field that doesn't apply, based on the Pilot or CTAM choice.
function setSharedSelect(sel, enabled) {
  if (!sel) return;
  if (enabled) { sel.disabled = false; if (sel.selectedIndex < 0) sel.selectedIndex = 0; }
  else { sel.selectedIndex = -1; sel.disabled = true; } // blank (value '') + greyed
}
function updatePilotCtam() {
  const poc = $('#sharedFields [data-key="pilot_or_ctam"]');
  if (!poc) return;
  const v = poc.value.trim();
  setSharedSelect($('#sharedFields [data-key="pilot_type"]'), v === 'Pilot');
  setSharedSelect($('#sharedFields [data-key="ctam_type"]'), v === 'CTAM');
  setProductOffsets(); // CTAM Type may have changed → refresh product Offset visibility
}

function productLineHtml() {
  const fields = PRODUCT_KEYS.map(fieldDef).filter(Boolean).map(entryFieldHtml).join('');
  return `<div class="product-line" data-product>${fields}` +
    `<button type="button" class="entry-remove" title="Remove this product">✕</button></div>`;
}

// Offset Amount shows on every product line only when the shared CTAM Type is License Transfer.
function setProductOffsets() {
  const ctam = $('#sharedFields [data-key="ctam_type"]');
  const isLT = !!ctam && ctam.value.trim() === 'License Transfer';
  $('#productLines').querySelectorAll('[data-product]').forEach((line) => {
    const field = line.querySelector('[data-field="offset_amount"]');
    if (!field) return;
    field.hidden = !isLT;
    if (!isLT) { const inp = field.querySelector('[data-key]'); if (inp) inp.value = ''; }
  });
}

function renumberProducts() {
  const lines = [...$('#productLines').querySelectorAll('[data-product]')];
  const showRemove = lines.length > 1;
  lines.forEach((l) => { l.querySelector('.entry-remove').style.visibility = showRemove ? '' : 'hidden'; });
}

function addProductLine() {
  const tmp = document.createElement('div');
  tmp.innerHTML = productLineHtml();
  $('#productLines').appendChild(tmp.firstElementChild);
  setProductOffsets();
  renumberProducts();
}

// Reset to the empty shared form with a single product line (on open and after submit).
function resetEntryView() {
  renderSharedFields();
  $('#productLines').innerHTML = '';
  addProductLine();
}

async function submitEntries() {
  const shared = {};
  $('#sharedFields').querySelectorAll('[data-key]').forEach((ctl) => { shared[ctl.dataset.key] = ctl.value; });
  if (!String(shared.property_name || '').trim() && !String(shared.property_id || '').trim()) {
    toast('Enter the property details first.', true);
    return;
  }
  // One booking per product line, each carrying the shared details.
  const payloads = [...$('#productLines').querySelectorAll('[data-product]')].map((line) => {
    const p = { ...shared };
    line.querySelectorAll('[data-key]').forEach((ctl) => {
      const field = ctl.closest('.entry-field');
      if (field && field.hidden) return; // skip hidden Offset on non-License-Transfers
      p[ctl.dataset.key] = ctl.value;
    });
    return p;
  });
  if (!payloads.length) { toast('Add at least one product.', true); return; }
  // Preview the computed values, then ask for confirmation before creating anything.
  try {
    const { rows } = await api('/api/bookings/preview', { method: 'POST', body: JSON.stringify({ rows: payloads }) });
    state.pendingBookings = payloads;
    openBookingConfirm(rows, shared);
  } catch (err) { toast(err.message, true); }
}

function openBookingConfirm(computed, shared) {
  const m = fmtMoney;
  const sum = (k) => computed.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const period = `${shared.booking_month || ''} ${shared.booking_year || ''}`.trim();
  const prop = shared.property_name || shared.property_id || '—';
  const meta = `<strong>${escapeHtml(prop)}</strong>`
    + (period ? ` · ${escapeHtml(period)}` : '')
    + (shared.sales_rep ? ` · ${escapeHtml(shared.sales_rep)}` : '')
    + (shared.ctam_type ? ` · ${escapeHtml(shared.ctam_type)}` : '')
    + (shared.pilot_type ? ` · ${escapeHtml(shared.pilot_type)}` : '');
  const body = computed.map((r) =>
    `<tr><td>${escapeHtml(r.product || '—')}</td><td class="num">${m(r.mrr)}</td>`
    + `<td class="num">${m(r.company_total_booking)}</td><td class="num">${m(r.commissionable_bookings)}</td>`
    + `<td class="num">${m(r.one_time_fee)}</td></tr>`).join('');
  $('#confirmSummary').innerHTML =
    `<p class="confirm-meta">${meta}</p>`
    + '<table class="confirm-table"><thead><tr><th>Product</th><th class="num">MRR</th>'
    + '<th class="num">Company Total Booking</th><th class="num">Commissionable</th><th class="num">One-Time Fee</th></tr></thead>'
    + `<tbody>${body}</tbody>`
    + `<tfoot><tr><th>Total (${computed.length})</th><th class="num">${m(sum('mrr'))}</th>`
    + `<th class="num">${m(sum('company_total_booking'))}</th><th class="num">${m(sum('commissionable_bookings'))}</th>`
    + `<th class="num">${m(sum('one_time_fee'))}</th></tr></tfoot></table>`;
  $('#confirmModal').hidden = false;
}

async function confirmBookings() {
  const payloads = state.pendingBookings || [];
  if (!payloads.length) { $('#confirmModal').hidden = true; return; }
  try {
    let added = 0;
    for (const payload of payloads) {
      const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
      state.rows.bookings.push(row);
      added += 1;
    }
    const last = payloads[payloads.length - 1];
    if (last.booking_month) entryDefaults.booking_month = last.booking_month;
    if (last.booking_year) entryDefaults.booking_year = last.booking_year;
    state.pendingBookings = [];
    $('#confirmModal').hidden = true;
    $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
    toast(`Added ${added} line item${added === 1 ? '' : 's'}`);
    resetEntryView();
  } catch (err) { toast(err.message, true); }
}

function wireEntry() {
  $('#addEntryFormBtn').onclick = () => addProductLine();
  $('#submitEntriesBtn').onclick = submitEntries;
  // Confirm dialog: Confirm creates the rows; Cancel returns to the entry form unchanged.
  $('#confirmSubmit').onclick = confirmBookings;
  $('#confirmCancel').onclick = () => { $('#confirmModal').hidden = true; };
  $('#confirmClose').onclick = () => { $('#confirmModal').hidden = true; };
  $('#confirmModal').addEventListener('click', (e) => { if (e.target.id === 'confirmModal') $('#confirmModal').hidden = true; });
  // Shared-field changes: CTAM Type toggles product Offset; Pilot/CTAM gates Pilot Type.
  $('#sharedFields').addEventListener('change', (e) => {
    const key = e.target.dataset && e.target.dataset.key;
    if (key === 'ctam_type') setProductOffsets();
    if (key === 'pilot_or_ctam') updatePilotCtam();
  });
  // Remove a product line (keep at least one).
  $('#productLines').addEventListener('click', (e) => {
    if (!e.target.closest('.entry-remove')) return;
    if ($('#productLines').querySelectorAll('[data-product]').length <= 1) return;
    e.target.closest('[data-product]').remove();
    renumberProducts();
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
function ssEditable() { const p = viewedPeriodObj(); return !!p && p.status === 'open' && canAddDelete(); }

// Columns for the viewed quarter: [key, label]. Labels reflect the quarter's months/year.
function ssColumns() {
  const p = viewedPeriodObj();
  const q = p ? `Q${p.quarter}` : 'Q';
  const y = p ? p.year : '';
  const m = p ? QUARTER_MONTHS[p.quarter] : ['Month 1', 'Month 2', 'Month 3'];
  return [
    ['product_category', 'Product'], ['section', 'Section'], ['pmc', 'PMC'],
    ['booking_type', 'Booking Type'], ['account_owner', 'Account Owner'],
    ['q2_target', `${q} Target`],
    ['apr_target', `${m[0]} ${y} Target`], ['m1_actual', `${m[0]} ${y} Actual`],
    ['may_target', `${m[1]} ${y} Target`], ['m2_actual', `${m[1]} ${y} Actual`],
    ['jun_target', `${m[2]} ${y} Target`], ['m3_actual', `${m[2]} ${y} Actual`],
    ['q_actual', `${q} Actual`],
    ['worst', 'Worst'], ['accurate', 'Accurate'], ['best', 'Best'], ['notes', 'Notes'],
  ];
}
const ssLabels = () => Object.fromEntries(ssColumns());

// Sum of Company Total Booking for matching PMC + product category + month + year.
function ssActual(row, monthName, year) {
  const pmc = String(row.pmc || '').trim().toLowerCase();
  const cat = String(row.product_category || '').trim();
  if (!pmc || !cat || !monthName) return 0;
  let sum = 0;
  for (const b of state.rows.bookings) {
    if (String(b.pmc || '').trim().toLowerCase() === pmc
      && (b.bpr_prod_category || '') === cat
      && b.booking_month === monthName
      && reconNum(b.booking_year) === year) {
      sum += Number(b.company_total_booking) || 0;
    }
  }
  return sum;
}
const ssFieldDef = (key) => state.schema.sales_support.editable.find((f) => f.key === key);

// Freeze the leading columns (through PMC) so they stay visible when scrolling right.
// Offsets are computed from the actual header widths (recomputed on resize).
const SS_FREEZE = ['product_category', 'section', 'pmc'];
function ssApplyFreeze() {
  let left = 0;
  let css = '';
  for (const key of SS_FREEZE) {
    css += `#ssTable td[data-col="${key}"]{position:sticky;left:${left}px;z-index:1;}`;
    css += `#ssTable th[data-col="${key}"]{position:sticky;left:${left}px;top:0;z-index:4;}`;
    const th = $(`#ssHead th[data-col="${key}"]`);
    left += th ? th.getBoundingClientRect().width / (state.zoom || 1) : 0;
  }
  $('#ssFreezeStyle').textContent = css;
}

// PMC options: existing PMCs (from bookings + sales support) plus an "add new" choice.
function ssPmcList() {
  const set = new Set();
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
  const p = viewedPeriodObj();
  const months = p ? QUARTER_MONTHS[p.quarter] : ['', '', ''];
  const year = p ? p.year : null;
  if (key === 'm1_actual' || key === 'm2_actual' || key === 'm3_actual') {
    const idx = { m1_actual: 0, m2_actual: 1, m3_actual: 2 }[key];
    return `<td class="ss-actual" data-col="${key}">${fmtMoney(ssActual(row, months[idx], year))}</td>`;
  }
  if (key === 'q_actual') {
    return `<td class="ss-actual" data-col="${key}">${fmtMoney(months.reduce((a, mn) => a + ssActual(row, mn, year), 0))}</td>`;
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
  $('#ssCloseQuarter').hidden = !(isAdmin() && viewed && viewed.status === 'open');
  $('#ssOpenQuarter').hidden = !isAdmin();

  const cols = ssColumns();
  const editCol = ssEditable();
  $('#ssHead').innerHTML = '<tr>' +
    cols.map(([k, label]) => `<th class="${SS_COMPUTED.has(k) ? 'ss-actual' : ''}" data-col="${k}">${escapeHtml(label)}<span class="col-resize"></span></th>`).join('') +
    (editCol ? '<th></th>' : '') + '</tr>';

  const catList = ssFieldDef('product_category').options;
  const secList = ssFieldDef('section').options;
  const catIdx = (c) => { const i = catList.indexOf(c); return i < 0 ? 99 : i; };
  const secIdx = (s) => { const i = secList.indexOf(s); return i < 0 ? 99 : i; };
  const rows = state.rows.sales_support
    .filter((r) => r.period === state.salesPeriod)
    .sort((a, b) =>
      catIdx(a.product_category) - catIdx(b.product_category)
      || secIdx(a.section) - secIdx(b.section)
      || String(a.pmc || '').localeCompare(String(b.pmc || '')));

  const colCount = cols.length + (editCol ? 1 : 0);
  let html = '';
  let group = null;
  for (const row of rows) {
    const g = `${row.product_category || '—'}  ·  ${row.section || '—'}`;
    if (g !== group) { group = g; html += `<tr class="ss-group"><td colspan="${colCount}"><span class="ss-group-label">${escapeHtml(g)}</span></td></tr>`; }
    const del = editCol ? `<td><button type="button" class="view-btn danger" data-ss-del="${row.id}" title="Delete row">✕</button></td>` : '';
    html += `<tr data-ss-id="${row.id}">${cols.map(([k]) => ssCell(row, k)).join('')}${del}</tr>`;
  }
  if (!rows.length) {
    const msg = !viewed ? `No quarters yet.${isAdmin() ? ' Use “Open New Quarter”.' : ''}`
      : editCol ? 'No rows yet. Use “+ Add row”.'
        : (viewed.status === 'open' ? 'No rows yet.' : 'Archived quarter (read-only).');
    html = `<tr><td class="muted" colspan="${colCount || 1}" style="padding:14px">${msg}</td></tr>`;
  }
  $('#ssBody').innerHTML = html;
}

// Build one field for the "Add row" form (labels reflect the open quarter).
function ssFormFieldHtml(f) {
  const label = ssLabels()[f.key] || f.label;
  let control;
  if (f.key === 'pmc') {
    control = `<select data-ss-key="pmc">${ssPmcOptions('')}</select>`;
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
  $('#ssPeriod').onchange = (e) => { state.salesPeriod = e.target.value; renderSalesSupport(); ssApplyFreeze(); };
  $('#ssCloseQuarter').onclick = async () => {
    if (!confirm('Close (archive) the current open quarter? It becomes read-only.')) return;
    try {
      state.salesPeriods = await api('/api/sales_periods/close', { method: 'POST' });
      renderSalesSupport(); ssApplyFreeze();
      toast('Quarter closed');
    } catch (err) { toast(err.message, true); }
  };
  $('#ssOpenQuarter').onclick = async () => {
    if (!confirm('Open a new quarter? Any open quarter will be archived first.')) return;
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
  // "+ Add new PMC" inside the form.
  $('#ssForm').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-ss-key="pmc"]');
    if (!sel || sel.value !== '__add_pmc__') return;
    const name = (prompt('New PMC name:') || '').trim();
    sel.innerHTML = ssPmcOptions(name); // includes + selects the new name, or resets if blank
  });
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

function wireView() {
  $('#toggleFilters').onclick = () => {
    state.filtersHidden = !state.filtersHidden;
    localStorage.setItem('perqFiltersHidden', state.filtersHidden ? '1' : '0');
    $('#toggleFilters').textContent = state.filtersHidden ? 'Show filters' : 'Hide filters';
    renderSummary();
  };
  const setZoom = (z) => {
    state.zoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10)); // clamp 50%–200%, 10% steps
    localStorage.setItem('perqZoom', String(state.zoom));
    applyZoom();
  };
  $('#zoomOut').onclick = () => setZoom(state.zoom - 0.1);
  $('#zoomIn').onclick = () => setZoom(state.zoom + 0.1);
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
function applyColWidths() {
  const widths = state.colWidths[state.tab] || {};
  const t = state.tab === 'salessupport' ? '#ssTable' : '#grid';
  let css = '';
  for (const [key, px] of Object.entries(widths)) {
    css += `${t} [data-col="${key}"]{width:${px}px;min-width:${px}px;max-width:${px}px;overflow:hidden;text-overflow:ellipsis;}`;
    css += `${t} [data-col="${key}"] input,${t} [data-col="${key}"] select{min-width:0;}`;
  }
  $('#colWidthStyle').textContent = css;
}
function setColWidth(key, px) {
  (state.colWidths[state.tab] || (state.colWidths[state.tab] = {}))[key] = px;
  applyColWidths();
}
function saveColWidths() { localStorage.setItem('perqColWidths', JSON.stringify(state.colWidths)); }

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
}

function wireResize() {
  let active = null; // { key, startX, startW }
  // Listen on document so both the main grid (#grid) and Sales Support (#ssTable) work.
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.col-resize');
    if (!handle) return;
    const th = handle.closest('th');
    if (!th || !th.dataset.col) return;
    e.preventDefault();
    const zoom = state.zoom || 1;
    active = { key: th.dataset.col, startX: e.clientX, startW: th.getBoundingClientRect().width / zoom };
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!active) return;
    const delta = (e.clientX - active.startX) / (state.zoom || 1);
    setColWidth(active.key, Math.max(48, Math.min(900, Math.round(active.startW + delta))));
    if (state.tab === 'salessupport') ssApplyFreeze();
  });
  document.addEventListener('mouseup', () => {
    if (!active) return;
    saveColWidths();
    active = null;
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
  });
  // "Show all" resets visibility for the current tab.
  $('#colMenu').addEventListener('click', (e) => {
    if (e.target.id !== 'colShowAll') return;
    state.hiddenCols[state.tab] = [];
    saveHiddenCols();
    renderColMenu(); applyColHide();
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
  localStorage.removeItem('perqToken');
  $('#usersModal').hidden = true;
  showLogin();
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

  // Self-service change password.
  $('#changePwBtn').onclick = () => {
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
const ROLE_LABELS = { admin: 'Admin', standard: 'Standard', billing: 'Billing', viewer: 'Viewer' };

async function openUsers() { $('#usersModal').hidden = false; await renderUsersList(); }

async function renderUsersList() {
  try {
    const users = await api('/api/users');
    $('#usersList').innerHTML = users.map((u) => {
      const opts = Object.keys(ROLE_LABELS).map((r) =>
        `<option value="${r}"${r === u.role ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
      return `<div class="user-row">
        <span class="user-name">${escapeHtml(u.username)}</span>
        <select data-role-for="${u.id}">${opts}</select>
        <button type="button" class="view-btn" data-pw-user="${u.id}">Reset password</button>
        <button type="button" class="view-btn danger" data-del-user="${u.id}">Delete</button>
      </div>`;
    }).join('');
  } catch (e) { $('#usersList').innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}

function wireUsers() {
  $('#usersBtn').onclick = openUsers;
  $('#usersClose').onclick = () => { $('#usersModal').hidden = true; };
  $('#usersModal').addEventListener('click', (e) => { if (e.target.id === 'usersModal') $('#usersModal').hidden = true; });

  $('#addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#newUserName').value.trim();
    const password = $('#newUserPass').value;
    const role = $('#newUserRole').value;
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) });
      $('#newUserName').value = ''; $('#newUserPass').value = ''; $('#addUserErr').textContent = '';
      toast('User added');
      renderUsersList();
    } catch (err) { $('#addUserErr').textContent = err.message; }
  });

  // Change a user's role.
  $('#usersList').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role-for]');
    if (!sel) return;
    try {
      await api(`/api/users/${sel.dataset.roleFor}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) });
      toast('Role updated');
    } catch (err) { toast(err.message, true); }
    renderUsersList();
  });

  // Reset password / delete.
  $('#usersList').addEventListener('click', async (e) => {
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
function renderNotifMenu() {
  const list = state.notifications || [];
  $('#notifMenu').innerHTML = list.length
    ? list.map((n) => `<div class="notif-item" data-go="${n.booking_id}"><span class="notif-msg">${escapeHtml(n.message)}</span><button type="button" class="notif-x" data-dismiss="${n.id}" title="Dismiss">✕</button></div>`).join('')
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
        $('#notifCount').textContent = state.notifications.length ? String(state.notifications.length) : '';
      } catch (err) { toast(err.message, true); }
      return;
    }
    const item = e.target.closest('[data-go]');
    if (item) { $('#notifMenu').hidden = true; gotoBooking(item.dataset.go); }
  });
}

// Navigate to a specific booking line item: open Bookings, clear filters, page to it, flash it.
function gotoBooking(id) {
  state.tab = 'bookings';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'bookings'));
  Object.keys(state.filters.bookings).forEach((k) => { state.filters.bookings[k] = 'All'; });
  const rows = currentRows('bookings');
  const idx = rows.findIndex((r) => String(r.id) === String(id));
  if (idx >= 0) {
    const size = state.pageSize === 'all' ? (rows.length || 1) : Number(state.pageSize);
    state.page.bookings = Math.floor(idx / size) + 1;
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

// ---------- Boot ----------
async function boot() {
  wireTabs(); wireSidebar(); wireActions(); wireGrid(); wireAuth(); wireUsers(); wireEntry(); wireView(); wireColumns(); wireResize(); wireCellTip(); wireReconcile(); wirePager(); wireSalesSupport(); wireBilling(); wireNotifications(); wireResult();
  applyZoom();
  if (state.token) {
    try {
      const { user } = await api('/api/me');
      state.user = user;
      await loadAll();
      return;
    } catch { /* token missing/expired — fall through to login */ }
  }
  showLogin();
}
boot();
