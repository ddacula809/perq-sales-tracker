// importer.js — parse the original PERQ workbook's "May 2026" and "Churn Tracker"
// sheets into plain row objects, ready to insert into the DB.
import XLSX from 'xlsx';
import { BOOKING_FIELDS, CHURN_FIELDS, BOOKING_SHEET, CHURN_SHEET } from './schema.js';

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
    }
  }

  const cws = wb.Sheets[CHURN_SHEET];
  if (cws) result.churn = rowsFromSheet(cws, CHURN_FIELDS, 0); // header on row 1 (index 0)

  return result;
}
