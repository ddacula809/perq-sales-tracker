// exporter.js — produce an .xlsx file that mirrors the original two tabs,
// with computed columns recalculated server-side (values, zero formula errors).
import XLSX from 'xlsx';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_SHEET, CHURN_SHEET,
} from './schema.js';
import { computeBooking, computeChurn } from './compute.js';

// Build a sheet as an array-of-arrays placing each value at its original Excel column.
function buildAoa(rows, editFields, computedFields, computeFn) {
  const allCols = [...editFields, ...computedFields].sort((a, b) => a.excel - b.excel);
  const maxCol = Math.max(...allCols.map((c) => c.excel));
  const aoa = [];

  // Header on the first row.
  const header = new Array(maxCol + 1).fill('');
  for (const c of allCols) header[c.excel] = c.label;
  aoa.push(header);

  for (const r of rows) {
    const computed = computeFn(r);
    const line = new Array(maxCol + 1).fill(null);
    for (const f of editFields) line[f.excel] = r[f.key] ?? null;
    for (const f of computedFields) line[f.excel] = computed[f.key] ?? null;
    aoa.push(line);
  }
  return aoa;
}

export function buildWorkbook(bookings, churn) {
  const wb = XLSX.utils.book_new();

  const bAoa = buildAoa(bookings, BOOKING_FIELDS, BOOKING_COMPUTED, computeBooking);
  const bWs = XLSX.utils.aoa_to_sheet(bAoa);
  XLSX.utils.book_append_sheet(wb, bWs, BOOKING_SHEET);

  const cAoa = buildAoa(churn, CHURN_FIELDS, CHURN_COMPUTED, computeChurn);
  const cWs = XLSX.utils.aoa_to_sheet(cAoa);
  XLSX.utils.book_append_sheet(wb, cWs, CHURN_SHEET);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
