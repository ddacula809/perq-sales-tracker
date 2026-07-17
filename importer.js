// importer.js — parse the original PERQ workbook's "May 2026" and "Churn Tracker"
// sheets into plain row objects, ready to insert into the DB.
import XLSX from 'xlsx';
import {
  BOOKING_FIELDS, CHURN_FIELDS, BOOKING_SHEET, CHURN_SHEET, SALESFORCE_RECON_FIELDS,
  LEGACY_GOLIVE_SHEET, LEGACY_CHURN_SOFTWARE_SHEET, LEGACY_CHURN_PPC_SHEET,
} from './schema.js';

// Convert an Excel cell into a value appropriate for the field type.
function coerce(value, type) {
  if (value === undefined || value === null || value === '') return null;
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const d = new Date(value);
    return isNaN(d) ? String(value) : d.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

function rowsFromSheet(ws, fields, headerRowIndex) {
  // header:1 -> array of arrays; defval keeps empty cells aligned.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const dataRows = aoa.slice(headerRowIndex + 1); // rows after the header
  const out = [];
  for (const arr of dataRows) {
    const obj = {};
    let hasContent = false;
    for (const f of fields) {
      const v = coerce(arr[f.excel], f.type);
      obj[f.key] = v;
      if (v !== null && v !== '') hasContent = true;
    }
    if (hasContent) out.push(obj);
  }
  return out;
}

// Columns pulled from a churn report upload, matched by header label (not position),
// since the report's sheet name and column order differ from the Churn Tracker sheet.
const CHURN_UPLOAD_COLS = [
  ['Old Value', 'old_value', 'text'],
  ['New Value', 'new_value', 'text'],
  ['Edit Date', 'edit_date', 'text'],
  ['Property ID', 'property_id', 'text'],
  ['Sage ID', 'sage_id', 'text'],
  ['PMC Buying Center', 'pmc_buying_center', 'text'],
  ['Property', 'property', 'text'],
  ['Product', 'product', 'text'],
  ['MRR', 'mrr', 'number'],
  ['Last Date Under Contract', 'last_date_under_contract', 'date'],
  ['Lost MRR Reason', 'lost_mrr_reason', 'text'],
  ['Client Success Manager', 'client_success_manager', 'text'],
];

const normHeader = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Derive the bare "Property Name" from a combined "PMC - Property Name" value: drop the PMC
// prefix if present, else everything before the first " - ". Returns '' when nothing's there.
export function propertyOnlyFrom(combined, pmc) {
  const c = String(combined == null ? '' : combined).trim();
  if (!c) return '';
  const p = String(pmc == null ? '' : pmc).trim();
  if (p && c.toLowerCase().startsWith(`${p.toLowerCase()} - `)) return c.slice(p.length + 3).trim();
  const i = c.indexOf(' - ');
  return i >= 0 ? c.slice(i + 3).trim() : c;
}

// Parse a churn report (.xlsx) into churn row objects. Reads the first sheet and locates
// the header row by matching the expected labels, so column position/sheet name don't matter.
export function parseChurnUpload(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The uploaded file has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });

  const wantNorm = CHURN_UPLOAD_COLS.map(([label]) => normHeader(label));
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(aoa.length, 25); i++) {
    const present = new Set((aoa[i] || []).map(normHeader));
    const matches = wantNorm.filter((l) => present.has(l)).length;
    if (matches > best) { best = matches; headerIdx = i; }
  }
  if (headerIdx < 0 || best < 6) {
    throw new Error('Could not find the expected churn columns (Old Value, New Value, Property ID, …) in the file.');
  }

  const header = (aoa[headerIdx] || []).map(normHeader);
  const colOf = {};
  for (const [label, key] of CHURN_UPLOAD_COLS) colOf[key] = header.indexOf(normHeader(label));

  const out = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const obj = {};
    let hasContent = false;
    for (const [, key, type] of CHURN_UPLOAD_COLS) {
      const ci = colOf[key];
      const v = ci >= 0 ? coerce(row[ci], type) : null;
      obj[key] = v;
      if (v !== null && v !== '') hasContent = true;
    }
    if (hasContent) out.push(obj);
  }
  return out;
}

// Columns read from a bookings reconciliation upload (matched by header label).
const RECON_COLS = [
  ['Booking Month', 'booking_month', 'text'],
  ['Booking Year', 'booking_year', 'number'],
  ['Property ID', 'property_id', 'text'],
  ['PMC', 'pmc', 'text'],
  ['Product', 'product', 'text'],
  ['MRR', 'mrr', 'number'],
  ['Offset Amount', 'offset_amount', 'number'],
  ['One-Time Fee', 'one_time_fee', 'number'],
  ['Company Total Booking', 'company_total_booking', 'number'],
];

// Parse a reconciliation file into { booking_month, booking_year, property_id, product, mrr }
// row objects. Reads the first sheet and locates the header row by matching the labels.
export function parseBookingReconcile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The uploaded file has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });

  const wantNorm = RECON_COLS.map(([label]) => normHeader(label));
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(aoa.length, 25); i++) {
    const present = new Set((aoa[i] || []).map(normHeader));
    const matches = wantNorm.filter((l) => present.has(l)).length;
    if (matches > best) { best = matches; headerIdx = i; }
  }
  if (headerIdx < 0 || best < 3) {
    throw new Error('Could not find the expected columns (Booking Month, Booking Year, Property ID, Product, MRR) in the file.');
  }

  const header = (aoa[headerIdx] || []).map(normHeader);
  const colOf = {};
  for (const [label, key] of RECON_COLS) colOf[key] = header.indexOf(normHeader(label));

  const out = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const obj = {};
    let hasContent = false;
    for (const [, key, type] of RECON_COLS) {
      const ci = colOf[key];
      const v = ci >= 0 ? coerce(row[ci], type) : null;
      obj[key] = v;
      if (v !== null && v !== '') hasContent = true;
    }
    if (hasContent) out.push(obj);
  }
  return out;
}

// Coerce a Go Live Date cell to 'YYYY-MM-DD'. Handles Date objects, Excel date serials
// (e.g. 46156), and date strings.
function coerceExcelDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000)); // Excel serial -> epoch ms
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Parse a GoLives report into { property_id, product, mrr, golive_date } rows, matching
// the header labels (the report's GoLive column is "Go Live Date").
export function parseGolives(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The uploaded file has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const cols = [['Property ID', 'property_id'], ['Product', 'product'], ['MRR', 'mrr'], ['Go Live Date', 'golive_date']];
  const wantNorm = cols.map(([l]) => normHeader(l));
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(aoa.length, 25); i++) {
    const present = new Set((aoa[i] || []).map(normHeader));
    const matches = wantNorm.filter((l) => present.has(l)).length;
    if (matches > best) { best = matches; headerIdx = i; }
  }
  if (headerIdx < 0 || best < 3) {
    throw new Error('Could not find the expected columns (Property ID, Product, MRR, Go Live Date) in the file.');
  }
  const header = (aoa[headerIdx] || []).map(normHeader);
  const colOf = {};
  for (const [l, k] of cols) colOf[k] = header.indexOf(normHeader(l));
  // The GoLive date header varies between exports ("Go Live Date" vs "GoLive Date"); accept either.
  if (colOf.golive_date < 0) {
    for (const alt of ['GoLive Date', 'Golive Date', 'Go-Live Date', 'GoLive']) {
      const i = header.indexOf(normHeader(alt));
      if (i >= 0) { colOf.golive_date = i; break; }
    }
  }
  const out = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const obj = {
      property_id: colOf.property_id >= 0 ? coerce(row[colOf.property_id], 'text') : null,
      product: colOf.product >= 0 ? coerce(row[colOf.product], 'text') : null,
      mrr: colOf.mrr >= 0 ? coerce(row[colOf.mrr], 'number') : null,
      golive_date: colOf.golive_date >= 0 ? coerceExcelDate(row[colOf.golive_date]) : null,
    };
    if (obj.property_id || obj.product || obj.golive_date) out.push(obj);
  }
  return out;
}

// Parse a Salesforce Recon Data export into row objects, matching the SALESFORCE_RECON_FIELDS
// labels against the file's header row (column order / sheet name don't matter).
export function parseSalesforceRecon(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The uploaded file has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });

  const wantNorm = SALESFORCE_RECON_FIELDS.map((f) => normHeader(f.label));
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(aoa.length, 25); i++) {
    const present = new Set((aoa[i] || []).map(normHeader));
    const matches = wantNorm.filter((l) => present.has(l)).length;
    if (matches > best) { best = matches; headerIdx = i; }
  }
  if (headerIdx < 0 || best < 4) {
    throw new Error('Could not find the expected columns (Property ID 18 Digit, Account Name, MRR, Account Owner) in the file.');
  }

  const header = (aoa[headerIdx] || []).map(normHeader);
  const colOf = {};
  for (const f of SALESFORCE_RECON_FIELDS) colOf[f.key] = header.indexOf(normHeader(f.label));

  const out = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const obj = {};
    let hasContent = false;
    for (const f of SALESFORCE_RECON_FIELDS) {
      const ci = colOf[f.key];
      const v = ci >= 0 ? coerce(row[ci], f.type) : null;
      obj[f.key] = v;
      if (v !== null && v !== '') hasContent = true;
    }
    if (hasContent) out.push(obj);
  }
  return out;
}

// Generic header-matched sheet parser: cols = [[label, key, type]]. Finds the header row
// by the best label match (handles a banner row above the header), maps and coerces values.
function parseSheetByCols(ws, cols) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const wantNorm = cols.map(([l]) => normHeader(l));
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(aoa.length, 30); i++) {
    const present = new Set((aoa[i] || []).map(normHeader));
    const matches = wantNorm.filter((l) => present.has(l)).length;
    if (matches > best) { best = matches; headerIdx = i; }
  }
  if (headerIdx < 0 || best < 3) return [];
  const header = (aoa[headerIdx] || []).map(normHeader);
  const colOf = {};
  for (const [label, key] of cols) colOf[key] = header.indexOf(normHeader(label));
  const out = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const obj = {};
    let has = false;
    for (const [, key, type] of cols) {
      const ci = colOf[key];
      let v = null;
      if (ci >= 0) v = type === 'date' ? coerceExcelDate(row[ci]) : coerce(row[ci], type);
      obj[key] = v;
      if (v !== null && v !== '') has = true;
    }
    if (has) out.push(obj);
  }
  return out;
}

const LEGACY_GOLIVE_COLS = [
  ['Division', 'division', 'text'], ['Date Added', 'date_added', 'text'], ['Sage ID', 'sage_id', 'text'],
  ['Property', 'property', 'text'], ['Parent PMC', 'parent_pmc', 'text'], ['PMC Buying Center', 'pmc_buying_center', 'text'],
  ['Product', 'product', 'text'], ['MRR', 'mrr', 'number'], ['Go Live Date', 'golive_date', 'date'],
  ['Salesforce Property ID', 'salesforce_property_id', 'text'], ['Note', 'note', 'text'],
  ['Billed in Sage', 'billed_in_sage', 'text'], ['Template Created', 'template_created', 'text'],
];
const LEGACY_CHURN_SOFTWARE_COLS = [
  ['Division', 'division', 'text'], ['Date Added', 'date_added', 'text'], ['Property ID', 'property_id', 'text'],
  ['Sage ID', 'sage_id', 'text'], ['PMC/Logo', 'pmc_logo', 'text'], ['Property: Name', 'property_name', 'text'],
  ['Product', 'product', 'text'], ['SF MRR', 'sf_mrr', 'number'], ['Last Date Under Contract', 'last_date_under_contract', 'date'],
  ['Reason Lost', 'reason_lost', 'text'], ['Client Success Manager', 'client_success_manager', 'text'],
  ['Software Revenue for Final Month', 'software_revenue_final_month', 'text'], ['Last Invoice Month', 'last_invoice_month', 'text'],
  ['Account Balance', 'account_balance', 'number'], ['Updated in Saas Financials', 'updated_saas_financials', 'text'],
  ['Brittany Review', 'brittany_review', 'text'], ['Cancellation date added', 'cancellation_date_added', 'text'],
  ['Prorated final invoice', 'prorated_final_invoice', 'text'], ['Note', 'note', 'text'],
];
const LEGACY_CHURN_PPC_COLS = [
  ['Date Added', 'date_added', 'text'], ['Property ID', 'property_id', 'text'], ['Sage ID', 'sage_id', 'text'],
  ['PMC/Logo', 'pmc_logo', 'text'], ['Property: Name', 'property_name', 'text'], ['Product', 'product', 'text'],
  ['SF MRR', 'sf_mrr', 'number'], ['Last Date Under Contract', 'last_date_under_contract', 'date'],
  ['Reason Lost', 'reason_lost', 'text'], ['Client Success Manager', 'client_success_manager', 'text'],
  ['PPC MGMT Fee Revenue for Final Month', 'ppc_mgmt_fee_final_month', 'text'],
  ['PPC Spend Revenue for Final Month', 'ppc_spend_final_month', 'text'], ['SEO', 'seo', 'text'],
  ['Last Invoice Month', 'last_invoice_month', 'text'], ['Account Balance', 'account_balance', 'number'],
  ['Updated in Saas Financials', 'updated_saas_financials', 'text'], ['Updated in Digital Ad Sheet', 'updated_da_sheet', 'text'],
  ['Brittany Review', 'brittany_review', 'text'], ['Prorated final invoice', 'prorated_final_invoice', 'text'],
  ['Note', 'note', 'text'],
];

// Prior-period bookings (old single-sheet format, e.g. "April 2026 sales Results"). Maps to
// the Bookings inputs: MRR = Month 1, Contract Term = Booked Term = 12, tagged by the file's
// Booking Month/Year. Totals are then auto-computed by computeBooking like any other booking.
const APRIL_COLS = [
  ['booking month', 'booking_month', 'text', 'exact'],
  ['booking year', 'booking_year', 'number', 'exact'],
  ['centralized', 'centralized', 'text', 'starts'],
  ['sales rep', 'sales_rep', 'text', 'exact'],
  ['property id', 'property_id', 'text', 'exact'],
  ['property name', 'property_name', 'text', 'exact'],
  ['pmc', 'pmc', 'text', 'exact'],
  ['buying center', 'buying_center', 'text', 'exact'],
  ['pilot or ctam', 'pilot_or_ctam', 'text', 'exact'],
  ['pilot type', 'pilot_type', 'text', 'starts'],
  ['ctam type', 'ctam_type', 'text', 'starts'],
  ['product', 'product', 'text', 'exact'],
  ['mql', 'mql', 'text', 'exact'],
  ['date agreement signed', 'date_signed', 'date', 'exact'],
  ['month 1', 'month1', 'number', 'exact'],
  ['month 2', 'month2', 'number', 'exact'],
  ['month 3', 'month3', 'number', 'exact'],
  ['one time charges', 'one_time_fee', 'number', 'exact'],
  ['notes', 'notes', 'text', 'exact'],
  ['to discuss', 'discuss_in_review', 'text', 'starts'],
  ['salesforce oppty', 'salesforce_oppty', 'text', 'exact'],
  ['sales support', 'sales_support', 'text', 'exact'],
  ['sf reconciled', 'sf_reconciled', 'text', 'exact'],
];
const PRODUCT_FIX = { 'ai lead captur agent': 'AI Lead Capture Agent', 'ai google booking agent': 'AI Google Bookings Agent' };

export function parsePriorBookings(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The uploaded file has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const match = (h, label, mode) => (mode === 'starts' ? h.startsWith(label) : h === label);
  let headerIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const hs = (aoa[i] || []).map(normHeader);
    const m = APRIL_COLS.filter(([l, , , mode]) => hs.some((h) => match(h, l, mode))).length;
    if (m > best) { best = m; headerIdx = i; }
  }
  if (headerIdx < 0 || best < 8) {
    throw new Error('Could not find the expected booking columns (Booking Month, Property Name, Product, Month 1, …) in the file.');
  }
  const header = (aoa[headerIdx] || []).map(normHeader);
  const colOf = {};
  for (const [l, key, , mode] of APRIL_COLS) colOf[key] = header.findIndex((h) => match(h, l, mode));
  const out = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const get = (key) => { const ci = colOf[key]; return ci >= 0 ? row[ci] : null; };
    const property_name = coerce(get('property_name'), 'text');
    const pmc = coerce(get('pmc'), 'text');
    if (!property_name && !pmc) continue; // skip blank/footer rows
    let product = coerce(get('product'), 'text');
    if (product && PRODUCT_FIX[product.toLowerCase()]) product = PRODUCT_FIX[product.toLowerCase()];
    out.push({
      booking_month: coerce(get('booking_month'), 'text'),
      booking_year: coerce(get('booking_year'), 'number'),
      centralized: coerce(get('centralized'), 'text'),
      sales_rep: coerce(get('sales_rep'), 'text'),
      property_id: coerce(get('property_id'), 'text'),
      property_name,
      pmc,
      buying_center: coerce(get('buying_center'), 'text'),
      pilot_or_ctam: coerce(get('pilot_or_ctam'), 'text'),
      pilot_type: coerce(get('pilot_type'), 'text'),
      ctam_type: coerce(get('ctam_type'), 'text'),
      product,
      mql: coerce(get('mql'), 'text'),
      date_signed: coerceExcelDate(get('date_signed')),
      mrr: coerce(get('month1'), 'number'),   // MRR = Month 1
      contract_term: 12,
      booked_term: 12,
      month1: coerce(get('month1'), 'number'),
      month2: coerce(get('month2'), 'number'),
      month3: coerce(get('month3'), 'number'),
      one_time_fee: coerce(get('one_time_fee'), 'number'),
      notes: coerce(get('notes'), 'text'),
      discuss_in_review: coerce(get('discuss_in_review'), 'text'),
      salesforce_oppty: coerce(get('salesforce_oppty'), 'text'),
      sales_support: coerce(get('sales_support'), 'text'),
      sf_reconciled: coerce(get('sf_reconciled'), 'text'),
    });
  }
  return out;
}

// Parse the legacy "AR Tracking" workbook: Go Lives + the two Notices Churn tabs (combined).
export function parseLegacyTracker(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const golives = wb.Sheets[LEGACY_GOLIVE_SHEET] ? parseSheetByCols(wb.Sheets[LEGACY_GOLIVE_SHEET], LEGACY_GOLIVE_COLS) : [];
  const sw = wb.Sheets[LEGACY_CHURN_SOFTWARE_SHEET]
    ? parseSheetByCols(wb.Sheets[LEGACY_CHURN_SOFTWARE_SHEET], LEGACY_CHURN_SOFTWARE_COLS).map((r) => ({ ...r, section: 'Software' })) : [];
  const ppc = wb.Sheets[LEGACY_CHURN_PPC_SHEET]
    ? parseSheetByCols(wb.Sheets[LEGACY_CHURN_PPC_SHEET], LEGACY_CHURN_PPC_COLS).map((r) => ({ ...r, section: 'PPC' })) : [];
  if (!golives.length && !sw.length && !ppc.length) {
    throw new Error('Could not find the “Go Lives”, “Notices Churn - Software”, or “Notices Churn - PPC” tabs in the file.');
  }
  return { golives, churn: [...sw, ...ppc] };
}

// ---- Convert instance: the "Retail SaaS Financials" EDIT tab ----
// Each row is a customer. Columns W..ES form a sparse month matrix: a value under a month's
// header is a booking that "falls under" that Booking Month/Year, with MRR = the cell value.
// The identity columns (Division, Channel, Customer Name, Sales Rep, Product Type, dates, opt-out,
// Implementation Fee, Sage Customer ID) are shared across that customer's bookings. Column A holds
// the status flag (a=Active, n=Never went live, c=Churned). One booking is produced per populated
// month cell (so a customer with an upsell in a later month yields multiple bookings).
const CONVERT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CONVERT_STATUS = { a: 'Active', n: 'Never went live', c: 'Churned' };

// Read a header cell as a month {serial, month name, year}, or null if it isn't a date. Cells may
// arrive as JS Dates (cellDates) or Excel date serials.
function monthFromHeader(cell) {
  let serial = null;
  let dt = null;
  if (cell instanceof Date) { dt = cell; serial = Math.round(cell.getTime() / 86400000) + 25569; }
  else if (typeof cell === 'number' && cell >= 40000 && cell <= 60000) { serial = cell; dt = new Date(Math.round((cell - 25569) * 86400000)); }
  else return null;
  if (!dt || isNaN(dt)) return null;
  return { serial, month: CONVERT_MONTHS[dt.getUTCMonth()], year: dt.getUTCFullYear() };
}

// Opt-out expiration is free text ("never", "n/a") but sometimes a real date serial — render
// serials as YYYY-MM-DD, keep everything else as text.
function optOutText(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return coerceExcelDate(v);
  if (typeof v === 'number' && v >= 40000 && v <= 60000) return coerceExcelDate(v);
  return String(v).trim();
}

export function parseConvertEdit(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['EDIT'];
  if (!ws) throw new Error('The uploaded file has no "EDIT" sheet.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  if (aoa.length < 2) throw new Error('The EDIT sheet has no data rows.');
  const header = aoa[0] || [];

  // Identity columns: locate by header label, falling back to the known EDIT position (0-based).
  const find = (label, fallback) => {
    const i = header.findIndex((h) => normHeader(h) === normHeader(label));
    return i >= 0 ? i : fallback;
  };
  const col = {
    status: 0, // column A (header "F"): a / n / c
    division: find('Division', 1),
    channel: find('Channel', 2),
    customer_name: find('Customer Name', 4),
    contract_signed: find('Contract Signed', 6),
    term_length: find('Term Length', 7),
    sales_rep: find('Sales Rep', 8),
    product_type: find('Product Type', 12),
    opt_out_period: find('Opt Out Period', 16),
    opt_out_expiration: find('Opt Out Expiration', 17),
    term_end_date: find('Term End Date', 18),
    implementation_fee: find('Implementation Fee', 19),
    monthly_fee: find('Monthly Fee', 20), // column U -> MRR
    sage_customer_id: find('Sage Customer ID', 316),
  };

  // The month block (W..ES) is the ascending run of date-headed columns. The sheet has a SECOND
  // month block after ES that restarts at an earlier month — stop as soon as the month goes down.
  const monthCols = [];
  let lastSerial = 0;
  for (let i = 0; i < header.length; i++) {
    const m = monthFromHeader(header[i]);
    if (!m) continue;
    if (monthCols.length && m.serial <= lastSerial) break; // second block started
    monthCols.push({ index: i, month: m.month, year: m.year });
    lastSerial = m.serial;
  }
  if (!monthCols.length) throw new Error('Could not find the monthly booking columns (W..ES) in the EDIT sheet.');

  const out = [];
  let customers = 0;
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const name = coerce(row[col.customer_name], 'text');
    if (!name) continue; // skip spacer / footer rows
    const statusRaw = String(row[col.status] == null ? '' : row[col.status]).trim().toLowerCase();
    const base = {
      category: 'MRR',
      status: CONVERT_STATUS[statusRaw] || null,
      division: coerce(row[col.division], 'text'),
      channel: coerce(row[col.channel], 'text'),
      customer_name: name,
      location: null, // not present in the EDIT tab
      sage_customer_id: coerce(row[col.sage_customer_id], 'text'),
      contract_signed_date: coerceExcelDate(row[col.contract_signed]),
      term_length: coerce(row[col.term_length], 'text'),
      sales_rep: coerce(row[col.sales_rep], 'text'),
      product_type: coerce(row[col.product_type], 'text'),
      term_start_date: null, // no clean source column in the EDIT tab
      opt_out_period: coerce(row[col.opt_out_period], 'text'),
      opt_out_expiration: optOutText(row[col.opt_out_expiration]),
      term_end_date: coerceExcelDate(row[col.term_end_date]),
      implementation_fee: coerce(row[col.implementation_fee], 'number'),
      mrr: coerce(row[col.monthly_fee], 'number'), // MRR = Monthly Fee (col U), shared across the customer's bookings
    };
    let produced = 0;
    for (const mc of monthCols) {
      const total = coerce(row[mc.index], 'number');
      if (total === null || total === 0) continue; // only populated month cells are bookings
      // The month-cell amount is the Company Total Booking for the month it falls under.
      out.push({ ...base, booking_month: mc.month, booking_year: mc.year, company_total_booking: total });
      produced += 1;
    }
    if (produced) customers += 1;
  }
  if (!out.length) throw new Error('No bookings found — the W..ES month columns had no values.');
  return { rows: out, customers };
}

export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const result = { bookings: [], churn: [] };

  const bws = wb.Sheets[BOOKING_SHEET];
  if (bws) {
    result.bookings = rowsFromSheet(bws, BOOKING_FIELDS, 6); // header on row 7 (index 6)
    // The original workbook has no Booking Month/Year columns; the sheet itself names the
    // period ("May 2026"). Tag imported rows from the sheet name so they stay distinguishable
    // once all bookings share one tab. (An exported file already carries these columns, so
    // a re-import of our own export keeps its real values and skips this default.)
    const [sheetMonth, sheetYearStr] = BOOKING_SHEET.split(' ');
    const sheetYear = Number(sheetYearStr);
    for (const r of result.bookings) {
      if (r.booking_month === null || r.booking_month === '') r.booking_month = sheetMonth || null;
      if (r.booking_year === null || r.booking_year === '') r.booking_year = Number.isFinite(sheetYear) ? sheetYear : null;
      // "Property Name" (property_only) = the combined "PMC - Property" minus the PMC prefix.
      if (!r.property_only) r.property_only = propertyOnlyFrom(r.property_name, r.pmc);
    }
  }

  const cws = wb.Sheets[CHURN_SHEET];
  if (cws) result.churn = rowsFromSheet(cws, CHURN_FIELDS, 0); // header on row 1 (index 0)

  return result;
}
