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
