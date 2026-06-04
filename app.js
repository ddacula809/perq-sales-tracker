// app.js — PERQ Sales Tracker frontend (vanilla JS, no build step).

const MONEY = new Set([
  'mrr', 'rerate_old_mrr', 'one_time_fee', 'month1', 'month2', 'month3',
  'offset_amount', 'annual_value', 'company_total_booking', 'commissionable_bookings',
  'google_search_budget', 'ar_final_invoice_amount', 'prorated_churn_amount', 'final_churn_amount',
]);

const state = {
  tab: 'dashboard',
  schema: null,
  rows: { bookings: [], churn: [] },
  // Dashboard and Bookings filter independently: filtering the grid must not move the
  // dashboard totals, and vice versa.
  filters: {
    dashboard: { month: 'All', year: 'All', pmc: 'All', prop: 'All', rep: 'All', cat: 'All' },
    bookings:  { month: 'All', year: 'All', pmc: 'All', prop: 'All', rep: 'All', cat: 'All' },
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
  if (state.tab === 'dashboard') { $('#thead').innerHTML = ''; return; }
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

function renderBody() {
  const tbody = $('#tbody');
  if (state.tab === 'dashboard') { tbody.innerHTML = ''; return; }
  let rows = state.rows[state.tab] || [];
  if (state.tab === 'bookings') rows = rows.filter((r) => bookingMatch(r, state.filters.bookings));
  else if (state.tab === 'churn') rows = rows.filter((r) => churnMatch(r, state.filters.churn));
  tbody.innerHTML = '';
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    tr.innerHTML = rowInnerHtml(row, i);
    tbody.appendChild(tr);
  });
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
    && (f.cat === 'All' || r.bpr_prod_category === f.cat);
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

// Re-render whatever the active tab shows that depends on the filters.
function onFilterChange() { renderSummary(); renderBody(); }

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
}
function metric(k, v, accent = false) {
  return `<div class="metric${accent ? ' accent' : ''}"><span class="k">${k}</span><span class="v">${fmtMoney(v)}</span></div>`;
}

// ---------- Data ops ----------
async function loadAll() {
  state.schema = await api('/api/schema');
  state.rows.bookings = await api('/api/bookings');
  state.rows.churn = await api('/api/churn');
  renderAll();
  $('#status').textContent =
    `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
}

function renderAll() {
  const isDash = state.tab === 'dashboard';
  // Account / role-based controls.
  $('#importBtn').style.display = canImport() ? '' : 'none';
  $('#usersBtn').hidden = !isAdmin();
  $('#changePwBtn').hidden = !state.user;
  $('#logoutBtn').hidden = !state.user;
  $('#userChip').innerHTML = state.user
    ? `${escapeHtml(state.user.username)} · <span class="role">${escapeHtml(state.user.role)}</span>` : '';
  const addBtn = $('#addRowBtn');
  // Add row only where there's a grid and the user may create rows.
  addBtn.style.display = (isDash || !canAddDelete()) ? 'none' : '';
  addBtn.textContent = state.tab === 'bookings' ? '+ New booking' : '+ Add row';
  $('#gridwrap').style.display = isDash ? 'none' : '';
  // View tools: filter toggle only where filters exist; zoom only where a table shows.
  $('#toggleFilters').style.display = ''; // all three tabs now have filters
  $('#toggleFilters').textContent = state.filtersHidden ? 'Show filters' : 'Hide filters';
  $('#zoomGroup').style.display = isDash ? 'none' : '';
  $('#colBtn').style.display = isDash ? 'none' : '';  // column hiding only where a grid shows
  $('#colMenu').hidden = true;
  renderHead(); renderSummary(); renderBody();
  applyColHide();
  applyColWidths();
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
      // Changing CTAM Type flips whether the Offset cell is editable — re-render the whole row.
      if (key === 'ctam_type') {
        const idx = [...tr.parentNode.children].indexOf(tr); // visible position (grid may be filtered)
        tr.innerHTML = rowInnerHtml(updated, idx);
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

function wireTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      state.tab = t.dataset.tab;
      renderAll();
    };
  });
}

function wireActions() {
  $('#addRowBtn').onclick = async () => {
    if (state.tab === 'dashboard' || !canAddDelete()) return; // no grid / no permission
    // Bookings use the dedicated entry form; churn keeps the quick blank-row add.
    if (state.tab === 'bookings') { openEntry(); return; }
    try {
      const row = await api(`/api/${state.tab}`, { method: 'POST', body: JSON.stringify({}) });
      state.rows[state.tab].push(row);
      renderBody(); renderSummary();
      $('#scroller').scrollTop = $('#scroller').scrollHeight;
      toast('Row added');
    } catch (err) { toast(err.message, true); }
  };

  $('#importFile').onchange = async (e) => {
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

  // Export sends the auth token via a fetch->blob download.
  $('#exportBtn').onclick = async (e) => {
    e.preventDefault();
    try {
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch('/api/export', { headers });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `PERQ_Sales_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- New booking entry form ----------
// Fields shown in the entry form, in order. Offset Amount only appears for License Transfers.
const ENTRY_KEYS = [
  'booking_month', 'booking_year',
  'centralized', 'sales_rep', 'property_id', 'property_name', 'pmc', 'buying_center',
  'pilot_or_ctam', 'pilot_type', 'ctam_type', 'product', 'mql',
  'contract_term', 'booked_term', 'date_signed', 'mrr', 'offset_amount',
];

// Booking Month/Year default to the dataset's period and "stick" to whatever you last
// entered, so adding many bookings for the same period doesn't mean re-picking each time.
let entryDefaults = { booking_month: 'May', booking_year: '2026' };
function applyEntryDefaults() {
  for (const [k, v] of Object.entries(entryDefaults)) {
    const ctl = $(`#entryForm [data-key="${k}"]`);
    if (ctl && v != null && v !== '') ctl.value = v;
  }
}

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

function renderEntryForm() {
  const defs = state.schema.bookings.editable;
  $('#entryForm').innerHTML = ENTRY_KEYS
    .map((k) => defs.find((f) => f.key === k))
    .filter(Boolean)
    .map(entryFieldHtml)
    .join('');
  applyEntryDefaults();
  toggleEntryOffset();
}

// Show the Offset Amount field only when CTAM Type is License Transfer; clear it otherwise.
function toggleEntryOffset() {
  const ctam = $('#entryForm [data-key="ctam_type"]');
  const field = $('#entryForm [data-field="offset_amount"]');
  if (!ctam || !field) return;
  const isLT = ctam.value.trim() === 'License Transfer';
  field.hidden = !isLT;
  if (!isLT) { const inp = field.querySelector('[data-key]'); if (inp) inp.value = ''; }
}

function openEntry() {
  renderEntryForm();
  $('#entryModal').hidden = false;
  const first = $('#entryForm [data-key]');
  if (first) first.focus();
}
function closeEntry() { $('#entryModal').hidden = true; }

async function submitEntry(e) {
  e.preventDefault();
  const payload = {};
  $('#entryForm').querySelectorAll('[data-key]').forEach((ctl) => {
    const field = ctl.closest('.entry-field');
    if (field && field.hidden) return; // skip the hidden Offset field on non-License-Transfers
    payload[ctl.dataset.key] = ctl.value;
  });
  try {
    const row = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
    state.rows.bookings.push(row);
    if (state.tab === 'bookings') {
      renderBody(); renderSummary();
      $('#scroller').scrollTop = $('#scroller').scrollHeight;
    }
    $('#status').textContent = `${state.rows.bookings.length} bookings · ${state.rows.churn.length} churn rows`;
    toast('Booking added');
    // Carry the booking period forward to the next entry.
    if (payload.booking_month) entryDefaults.booking_month = payload.booking_month;
    if (payload.booking_year) entryDefaults.booking_year = payload.booking_year;
    renderEntryForm(); // reset for the next entry
    const first = $('#entryForm [data-key]');
    if (first) first.focus();
  } catch (err) { toast(err.message, true); }
}

function wireEntry() {
  $('#entryForm').addEventListener('submit', submitEntry);
  $('#entryForm').addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.key === 'ctam_type') toggleEntryOffset();
  });
  $('#entryClose').onclick = closeEntry;
  $('#entryCancel').onclick = closeEntry;
  $('#entryModal').addEventListener('click', (e) => { if (e.target.id === 'entryModal') closeEntry(); });
}

// ---------- View tools: filter toggle + table zoom ----------
function applyZoom() {
  $('#grid').style.zoom = state.zoom;
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
  let css = '';
  for (const [key, px] of Object.entries(widths)) {
    css += `#grid [data-col="${key}"]{width:${px}px;min-width:${px}px;max-width:${px}px;overflow:hidden;text-overflow:ellipsis;}`;
    css += `#grid [data-col="${key}"] input,#grid [data-col="${key}"] select{min-width:0;}`;
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
  $('#thead').addEventListener('mousedown', (e) => {
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

// ---------- Boot ----------
async function boot() {
  wireTabs(); wireActions(); wireGrid(); wireAuth(); wireUsers(); wireEntry(); wireView(); wireColumns(); wireResize(); wireCellTip();
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
