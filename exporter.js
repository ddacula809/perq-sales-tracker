// exporter.js — produce an .xlsx file that mirrors the original two tabs,
// with computed columns recalculated server-side (values, zero formula errors).
import XLSX from 'xlsx';
import {
  BOOKING_FIELDS, BOOKING_COMPUTED, CHURN_FIELDS, CHURN_COMPUTED,
  BOOKING_SHEET, CHURN_SHEET,
  CONVERT_BOOKING_FIELDS, CONVERT_BOOKING_COMPUTED, CONVERT_BOOKING_SHEET,
} from './schema.js';
import { computeBooking, computeChurn } from './compute.js';

// Build a sheet as an array-of-arrays. Columns keep their original Excel position; when
// some are excluded (`exclude` set of keys), the rest are re-packed to be contiguous
// (no blank gaps where the removed columns were).
function buildAoa(rows, editFields, computedFields, computeFn, exclude = new Set()) {
  const edit = editFields.filter((f) => !exclude.has(f.key));
  const comp = computedFields.filter((f) => !exclude.has(f.key));
  const allCols = [...edit, ...comp].sort((a, b) => a.excel - b.excel);
  const repack = exclude.size > 0;
  const colAt = new Map();
  allCols.forEach((c, i) => colAt.set(c.key, repack ? i : c.excel));
  const maxCol = repack ? Math.max(0, allCols.length - 1) : Math.max(...allCols.map((c) => c.excel));
  const aoa = [];

  // Header on the first row.
  const header = new Array(maxCol + 1).fill('');
  for (const c of allCols) header[colAt.get(c.key)] = c.label;
  aoa.push(header);

  for (const r of rows) {
    const computed = computeFn(r);
    const line = new Array(maxCol + 1).fill(null);
    for (const f of edit) line[colAt.get(f.key)] = r[f.key] ?? null;
    for (const f of comp) line[colAt.get(f.key)] = computed[f.key] ?? null;
    aoa.push(line);
  }
  return aoa;
}

// opts.excludeBookingKeys / opts.excludeChurnKeys: sets of field keys to omit (e.g. the
// billing columns for a "sales commission" export).
export function buildWorkbook(bookings, churn, opts = {}) {
  const wb = XLSX.utils.book_new();
  const bExclude = opts.excludeBookingKeys || new Set();
  const cExclude = opts.excludeChurnKeys || new Set();
  const sheets = opts.sheets || 'both'; // 'both' | 'bookings' | 'churn'

  // Convert instance: one Bookings sheet built from the Convert field set, no churn tab.
  if (opts.instance === 'convert') {
    const bAoa = buildAoa(bookings, CONVERT_BOOKING_FIELDS, CONVERT_BOOKING_COMPUTED, () => ({}), bExclude);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bAoa), CONVERT_BOOKING_SHEET);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  if (sheets !== 'churn') {
    const bAoa = buildAoa(bookings, BOOKING_FIELDS, BOOKING_COMPUTED, computeBooking, bExclude);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bAoa), BOOKING_SHEET);
  }
  if (sheets !== 'bookings') {
    const cAoa = buildAoa(churn, CHURN_FIELDS, CHURN_COMPUTED, computeChurn, cExclude);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cAoa), CHURN_SHEET);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
