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
  filters: { pmc: 'All', rep: 'All', cat: 'All' },
  authKey: localStorage.getItem('perqKey') || '',
};

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.authKey) headers['x-app-key'] = state.authKey;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { showAuth(); throw new Error('Unauthorized'); }
  if (!res.ok && res.status !== 204) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
};

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
function fieldsForTab() {
  const s = state.schema[state.tab];
  return { edit: s.editable, computed: s.computed, all: [...s.editable, ...s.computed] };
}

function renderHead() {
  if (state.tab === 'dashboard') { $('#thead').innerHTML = ''; return; }
  const { edit, computed } = fieldsForTab();
  const cols = [...edit, ...computed];
  $('#thead').innerHTML =
    `<tr><th class="rownum">#</th>` +
    cols.map((f) => {
      const isComp = computed.includes(f);
      return `<th class="${isComp ? 'computed' : ''}" title="${f.label}">${f.label}</th>`;
    }).join('') +
    `<th class="del"></th></tr>`;
}

function rowInnerHtml(row, i) {
  const { edit, computed } = fieldsForTab();
  let html = `<td class="rownum">${i + 1}</td>`;
  for (const f of edit) html += editCell(f, row);
  for (const f of computed) html += computedCell(f, row);
  html += `<td class="del"><button title="Delete row" data-del="${row.id}">✕</button></td>`;
  return html;
}

function renderBody() {
  const tbody = $('#tbody');
  if (state.tab === 'dashboard') { tbody.innerHTML = ''; return; }
  let rows = state.rows[state.tab] || [];
  if (state.tab === 'bookings') rows = rows.filter(bookingMatch);
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
    return `<td class="num offset-na"><span class="na">—</span></td>`;
  }
  const numClass = f.type === 'number' ? ' num' : '';
  if (f.type === 'select') {
    const opts = f.options.map((o) =>
      `<option value="${escapeAttr(o)}"${o === val ? ' selected' : ''}>${o || '—'}</option>`).join('');
    return `<td><select data-key="${f.key}">${opts}</select></td>`;
  }
  const inputType = f.type === 'date' ? 'date' : (f.type === 'number' ? 'number' : 'text');
  const step = f.type === 'number' ? ' step="any"' : '';
  return `<td class="${numClass.trim()}"><input type="${inputType}"${step} data-key="${f.key}" value="${escapeAttr(val)}" /></td>`;
}

function computedCell(f, row) {
  const raw = row[f.key];
  const isNeg = typeof raw === 'number' && raw < 0;
  const text = MONEY.has(f.key) ? fmtMoney(raw) : (f.type === 'number' ? fmtNum(raw) : (raw ?? ''));
  return `<td class="computed${isNeg ? ' neg' : ''}" data-comp="${f.key}">${text}</td>`;
}

function escapeAttr(v) { return String(v).replace(/"/g, '&quot;'); }

// ---------- Filters + summary metrics ----------
// PMC / Sales Rep / BPR Category filter, shared by the Dashboard metrics and the
// bookings grid. True when a booking row passes the current filter selection.
function bookingMatch(r) {
  const f = state.filters;
  return (f.pmc === 'All' || r.pmc === f.pmc)
    && (f.rep === 'All' || r.sales_rep === f.rep)
    && (f.cat === 'All' || r.bpr_prod_category === f.cat);
}

// Re-render whatever the active tab shows that depends on the filters.
function onFilterChange() { renderSummary(); renderBody(); }

function renderSummary() {
  const el = $('#summary');
  // Filters drive the Dashboard metrics and the bookings table; churn has neither.
  if (state.tab === 'churn') { el.className = 'summary hidden'; el.innerHTML = ''; return; }
  el.className = 'summary';
  const rows = state.rows.bookings;
  const uniq = (k) => ['All', ...[...new Set(rows.map((r) => r[k]).filter(Boolean))].sort()];
  const f = state.filters;
  const opts = (k, cur) => uniq(k).map((o) => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join('');

  let html =
    `<div class="filter"><label>Filter by PMC</label><select id="pmc">${opts('pmc', f.pmc)}</select></div>` +
    `<div class="filter"><label>Filter by Sales Rep</label><select id="rep">${opts('sales_rep', f.rep)}</select></div>` +
    `<div class="filter"><label>Filter by BPR Category</label><select id="cat">${opts('bpr_prod_category', f.cat)}</select></div>`;

  // Metric cards live on the Dashboard tab only.
  if (state.tab === 'dashboard') {
    const filtered = rows.filter(bookingMatch);
    const sum = (k) => filtered.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const totalBooking = sum('company_total_booking');
    const totalOTF = sum('one_time_fee');
    const totalComm = sum('commissionable_bookings');
    html +=
      metric('Total Company Booking', totalBooking, true) +
      metric('Total One-Time Fees', totalOTF) +
      metric('Total Commissionable', totalComm) +
      metric('Commissionable + OTF', totalComm + totalOTF);
  }

  el.innerHTML = html;
  $('#pmc').onchange = (e) => { f.pmc = e.target.value; onFilterChange(); };
  $('#rep').onchange = (e) => { f.rep = e.target.value; onFilterChange(); };
  $('#cat').onchange = (e) => { f.cat = e.target.value; onFilterChange(); };
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
  const addBtn = $('#addRowBtn');
  addBtn.style.display = isDash ? 'none' : '';        // no grid to add rows to on the dashboard
  addBtn.textContent = state.tab === 'bookings' ? '+ New booking' : '+ Add row';
  $('#gridwrap').style.display = isDash ? 'none' : '';
  renderHead(); renderSummary(); renderBody();
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
    if (state.tab === 'dashboard') return; // dashboard has no grid
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
      const headers = state.authKey ? { 'x-app-key': state.authKey } : {};
      const res = await fetch('/api/import', { method: 'POST', body: fd, headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed');
      const data = await res.json();
      await loadAll();
      toast(`Imported ${data.imported.bookings} bookings, ${data.imported.churn} churn rows`);
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };

  // Export respects the auth key via a fetch->blob download.
  $('#exportBtn').onclick = async (e) => {
    e.preventDefault();
    try {
      const headers = state.authKey ? { 'x-app-key': state.authKey } : {};
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

// ---------- Auth ----------
function showAuth() { $('#authModal').hidden = false; }
function wireAuth() {
  $('#authSubmit').onclick = async () => {
    state.authKey = $('#authInput').value.trim();
    localStorage.setItem('perqKey', state.authKey);
    try { await loadAll(); $('#authModal').hidden = true; }
    catch { $('#authErr').textContent = 'Invalid key.'; }
  };
  $('#authInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#authSubmit').click(); });
}

// ---------- Boot ----------
async function boot() {
  wireTabs(); wireActions(); wireGrid(); wireAuth(); wireEntry();
  const { required } = await fetch('/api/auth-required').then((r) => r.json()).catch(() => ({ required: false }));
  try {
    await loadAll();
  } catch {
    if (required) showAuth();
  }
}
boot();
