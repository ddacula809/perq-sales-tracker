// app.js — PERQ Sales Tracker frontend (vanilla JS, no build step).

const MONEY = new Set([
  'mrr', 'rerate_old_mrr', 'one_time_fee', 'month1', 'month2', 'month3',
  'offset_amount', 'annual_value', 'company_total_booking', 'commissionable_bookings',
  'google_search_budget', 'ar_final_invoice_amount', 'prorated_churn_amount', 'final_churn_amount',
]);

const state = {
  tab: 'bookings',
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

function renderBody() {
  const { edit, computed } = fieldsForTab();
  const rows = state.rows[state.tab];
  const tbody = $('#tbody');
  tbody.innerHTML = '';
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    let html = `<td class="rownum">${i + 1}</td>`;
    for (const f of edit) html += editCell(f, row);
    for (const f of computed) html += computedCell(f, row);
    html += `<td class="del"><button title="Delete row" data-del="${row.id}">✕</button></td>`;
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}

function editCell(f, row) {
  const val = row[f.key] ?? '';
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

// ---------- Summary (bookings only) ----------
function renderSummary() {
  const el = $('#summary');
  if (state.tab !== 'bookings') { el.className = 'summary hidden'; el.innerHTML = ''; return; }
  el.className = 'summary';
  const rows = state.rows.bookings;
  const uniq = (k) => ['All', ...[...new Set(rows.map((r) => r[k]).filter(Boolean))].sort()];
  const f = state.filters;

  const sel = (id, label, key) =>
    `<div class="filter"><label>${label}</label><select id="${id}">` +
    uniq(key).map((o) => `<option${o === f[id === 'pmc' ? 'pmc' : id] ? ' selected' : ''}>${o}</option>`).join('') +
    `</select></div>`;

  const match = (r) =>
    (f.pmc === 'All' || r.pmc === f.pmc) &&
    (f.rep === 'All' || r.sales_rep === f.rep) &&
    (f.cat === 'All' || r.bpr_prod_category === f.cat);

  const filtered = rows.filter(match);
  const sum = (k) => filtered.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totalBooking = sum('company_total_booking');
  const totalOTF = sum('one_time_fee');
  const totalComm = sum('commissionable_bookings');

  el.innerHTML =
    `<div class="filter"><label>Filter by PMC</label><select id="pmc">${uniq('pmc').map((o) => `<option${o === f.pmc ? ' selected' : ''}>${o}</option>`).join('')}</select></div>` +
    `<div class="filter"><label>Filter by Sales Rep</label><select id="rep">${uniq('sales_rep').map((o) => `<option${o === f.rep ? ' selected' : ''}>${o}</option>`).join('')}</select></div>` +
    `<div class="filter"><label>Filter by BPR Category</label><select id="cat">${uniq('bpr_prod_category').map((o) => `<option${o === f.cat ? ' selected' : ''}>${o}</option>`).join('')}</select></div>` +
    metric('Total Company Booking', totalBooking, true) +
    metric('Total One-Time Fees', totalOTF) +
    metric('Total Commissionable', totalComm) +
    metric('Commissionable + OTF', totalComm + totalOTF);

  $('#pmc').onchange = (e) => { f.pmc = e.target.value; renderSummary(); };
  $('#rep').onchange = (e) => { f.rep = e.target.value; renderSummary(); };
  $('#cat').onchange = (e) => { f.cat = e.target.value; renderSummary(); };
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

function renderAll() { renderHead(); renderSummary(); renderBody(); }

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
      const updated = await api(`/api/${state.tab}/${id}`, {
        method: 'PATCH', body: JSON.stringify({ [key]: ctl.value }),
      });
      updateRowInState(state.tab, updated);
      refreshComputedCells(tr, updated);
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
  wireTabs(); wireActions(); wireGrid(); wireAuth();
  const { required } = await fetch('/api/auth-required').then((r) => r.json()).catch(() => ({ required: false }));
  try {
    await loadAll();
  } catch {
    if (required) showAuth();
  }
}
boot();
