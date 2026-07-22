// legacyImporter.js — parse the historical "SaaS Financials" workbook (Edit / PS / TrialsPilots)
// into per-product, per-booking-month booking rows tagged as legacy.
//
// Columns are located BY HEADER LABEL (not fixed letters) because the three tabs don't share the
// same column positions. Two contiguous runs of date-serial headers are auto-detected: the first
// run = booking columns (value = the booked amount in that month), the second = MRR-timing columns
// (used only to find the GoLive/recognition-start month).
//
// Rules (agreed): split Product Type on + / <> / , into individual products (names kept as-is);
// the FIRST product carries the full MRR + booking amount, the rest come in at $0; each non-empty
// booking cell is its own row; MRR = "MRR"/"Monthly Fee" as-is; booking amount stored as-is;
// GoLive = first MRR-timing month; Sage = "Sage Customer ID"; TrialsPilots rows tagged Pilot.
import XLSX from 'xlsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const numOr = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// An Excel date serial or a Date -> { month, year, iso } for the 1st of that month.
function hdrMonth(v) {
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number' && v >= 20000 && v <= 90000) d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
  if (!d || isNaN(d)) return null;
  const m = d.getUTCMonth(); const y = d.getUTCFullYear();
  return { month: MONTHS[m], year: y, iso: `${y}-${String(m + 1).padStart(2, '0')}-01` };
}
const isDateHdr = (v) => hdrMonth(v) !== null;
// Runs of consecutive date-serial header columns. runs[0] = booking block, runs[1] = MRR timing.
function dateRuns(header) {
  const runs = []; let cur = null;
  for (let i = 0; i < header.length; i++) {
    if (isDateHdr(header[i])) { if (!cur) cur = [i, i]; else cur[1] = i; }
    else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs;
}
const findCol = (header, pred) => { for (let i = 0; i < header.length; i++) if (pred(norm(header[i]))) return i; return -1; };

export function parseLegacyWorkbook(buffer, existingBookings = []) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheets: ['Edit', 'PS', 'TrialsPilots'] });
  const existKey = new Set(existingBookings.map((b) => `${norm(b.property_id)}|${norm(b.product)}|${norm(b.booking_month)} ${String(b.booking_year ?? '').trim()}`));
  const seen = new Set(); // avoid duplicates within this file
  const rows = []; const errors = []; const perTab = {}; let skipped = 0;

  for (const [name, isPilot] of [['Edit', false], ['PS', false], ['TrialsPilots', true]]) {
    const ws = wb.Sheets[name];
    if (!ws) { perTab[name] = { note: 'sheet not found', added: 0, skipped: 0, errors: 0 }; continue; }
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (!aoa.length) { perTab[name] = { note: 'empty', added: 0, skipped: 0, errors: 0 }; continue; }
    const header = aoa[0];
    const runs = dateRuns(header);
    const bookRun = runs[0]; const timeRun = runs[1];
    const C = {
      pid: findCol(header, (l) => l === 'property id'),
      prod: findCol(header, (l) => l === 'product type'),
      mrr: findCol(header, (l) => l === 'mrr' || l === 'monthly fee'),
      impl: findCol(header, (l) => l === 'implementation fee'),
      signed: findCol(header, (l) => l === 'contract signed'),
      rep: findCol(header, (l) => l === 'sales rep'),
      freepaid: findCol(header, (l) => l === 'free or paid'),
      pmc: findCol(header, (l) => l === 'pmc'),
      propname: findCol(header, (l) => l === 'pmc - property'),
      sage: findCol(header, (l) => l === 'sage customer id'),
      owner: findCol(header, (l) => l === 'account owner'),
    };
    let added = 0; let tabSkip = 0; let tabErr = 0;
    if (C.pid < 0 || C.prod < 0 || !bookRun) {
      perTab[name] = { note: `missing key columns (Property ID/Product/booking block)`, added: 0, skipped: 0, errors: 0, cols: C };
      continue;
    }
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r];
      const pid = String(row[C.pid] ?? '').trim();
      if (!pid) continue; // formula/template/blank rows have no Property ID
      const prodStr = String(row[C.prod] ?? '').trim();
      if (!prodStr) { errors.push({ tab: name, property: pid, reason: 'no product' }); tabErr++; continue; }
      const products = prodStr.split(/\s*(?:\+|<>|,)\s*/).map((s) => s.trim()).filter(Boolean);
      if (!products.length) { errors.push({ tab: name, property: pid, reason: 'no product' }); tabErr++; continue; }
      const mrr = C.mrr >= 0 ? numOr(row[C.mrr]) : null;
      const impl = C.impl >= 0 ? numOr(row[C.impl]) : null;
      const signed = C.signed >= 0 ? row[C.signed] : null;
      const dateSigned = signed instanceof Date ? signed.toISOString().slice(0, 10) : null;
      const rep = C.rep >= 0 && row[C.rep] ? String(row[C.rep]).trim() : (C.owner >= 0 ? String(row[C.owner] ?? '').trim() : '');
      const pmc = C.pmc >= 0 ? String(row[C.pmc] ?? '').trim() : '';
      const propname = C.propname >= 0 ? String(row[C.propname] ?? '').trim() : '';
      const sage = C.sage >= 0 ? String(row[C.sage] ?? '').trim() : '';
      const pilotType = /paid/i.test(C.freepaid >= 0 ? String(row[C.freepaid] ?? '') : '') ? 'New - Paid' : 'New - Free';
      // GoLive = first non-empty MRR-timing month.
      let goLive = null;
      if (timeRun) for (let i = timeRun[0]; i <= timeRun[1]; i++) { if (numOr(row[i])) { const hm = hdrMonth(header[i]); if (hm) { goLive = hm.iso; break; } } }
      // One booking row per non-empty booking-month cell × product.
      for (let i = bookRun[0]; i <= bookRun[1]; i++) {
        const amt = numOr(row[i]); if (!amt) continue;
        const hm = hdrMonth(header[i]); if (!hm) continue;
        products.forEach((p, j) => {
          const key = `${norm(pid)}|${norm(p)}|${norm(hm.month)} ${hm.year}`;
          if (existKey.has(key) || seen.has(key)) { skipped++; tabSkip++; return; }
          seen.add(key);
          const rec = {
            property_id: pid, property_name: propname, pmc, sales_rep: rep, product: p,
            booking_month: hm.month, booking_year: hm.year,
            mrr: j === 0 ? mrr : 0,
            company_total_override: j === 0 ? amt : 0,
            annual_value_override: j === 0 ? amt : 0,
            commissionable_override: j === 0 ? amt : 0,
            one_time_fee: j === 0 ? impl : null,
            date_signed: dateSigned, golive_date: goLive, golive_set_date: goLive,
            sage_id: sage, legacy: true, instance: 'multifamily',
          };
          if (isPilot) { rec.pilot_or_ctam = 'Pilot'; rec.pilot_type = pilotType; }
          rows.push(rec); added++;
        });
      }
    }
    perTab[name] = { added, skipped: tabSkip, errors: tabErr, bookRun, timeRun };
  }
  return { rows, skipped, errors, perTab };
}
