// compute.js
// Pure functions that reproduce the Excel formula columns from the original workbook.
// Verified against cached Excel values for both the "May 2026" and "Churn Tracker" tabs.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function monthYear(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

// ---------- May 2026 bookings ----------

// Column L: BPR Prod Category (derived from Product)
export function bprCategory(product) {
  const p = (product || '').trim();
  if (!p) return '';
  if (['AI Lead Capture Agent', 'AI Leasing Agent', 'Performance Reporting Agent'].includes(p)) return 'Software';
  if (p === 'Pulse Data Hub') return 'Pulse';
  if (['Property Website', 'Corporate Website'].includes(p)) return 'Website';
  if (['Google Search Management', 'SEO'].includes(p)) return 'Digital Advertising';
  if (['AI Google Bookings Agent', 'AI Google Posts and Products'].includes(p)) return 'Tools for Google';
  return 'Unknown';
}

// Column J: "Formula Column" — booking-type bucket (from Pilot Type H + CTAM Type I)
export function formulaColumn(pilotType, ctamType) {
  const H = (pilotType || '').trim();
  const I = (ctamType || '').trim();
  if (H === '' && I === '') return '';
  if (H === 'New - Paid' || H === 'New - Free') return 'New PMC Pilot ($0)';
  if (H === 'Conversion') return 'New PMC (Straight to Pay or Pilot Converted)';
  if (H === 'Pilot Expansion' || H === 'Second Signature') return 'Expansion(Pilot Expansion)';
  if (I === 'License Transfer') return 'License Transfer';
  if (I === 'Straight to Pay') return 'New PMC (Straight to Pay or Pilot Converted)';
  if (I === 'Expansion') return 'Expansion(Pilot Expansion)';
  if (I === 'Upsell') return 'Upsell';
  if (I === 'Renewal Rate Increase') return 'Renewal Rate Increase';
  if (I === 'Downgrade') return 'Downgrade';
  if (I === 'Re-rate') return 'Re-rate';
  return '';
}

// Computes all derived booking fields. `r` is a booking row (plain object).
export function computeBooking(r) {
  const H = (r.pilot_type || '').trim();
  const I = (r.ctam_type || '').trim();
  const G = (r.pilot_or_ctam || '').trim();
  const P = num(r.contract_term);
  const Q = num(r.booked_term);
  const S = num(r.mrr);
  const N = num(r.rerate_paid_months);
  const O = num(r.rerate_old_mrr);
  const T = num(r.offset_amount);   // Column T: Offset Amount — now an editable field (License Transfer only)
  const V = num(r.one_time_fee);

  const formula = formulaColumn(H, I);
  const category = bprCategory(r.product);

  // Column U: Annual Value of Agreement
  let annual = null;
  if (!(P === null && S === null)) {
    annual = H === 'New - Paid' ? (S ?? 0) * 12 : (P ?? 0) * (S ?? 0);
  }

  // Column W: Company Total Booking
  let companyTotal = null;
  if (!(Q === null && S === null)) {
    if (H === 'New - Free' || (H === 'New - Paid' && I === 'Straight to Pay')) {
      companyTotal = 0;
    } else if (I === 'Re-rate') {
      const v = ((S ?? 0) - (O ?? 0)) * (P ?? 0);
      companyTotal = v < 0 ? 0 : v;
    } else if (formula === 'License Transfer') {
      companyTotal = ((S ?? 0) - (T ?? 0)) * (Q ?? 0);
    } else {
      companyTotal = (Q ?? 0) * (S ?? 0);
    }
  }

  // Column X: Commissionable Bookings
  let commissionable = null;
  if (!(Q === null && S === null)) {
    if (H === 'New - Free') {
      commissionable = 0;
    } else if (I === 'Re-rate') {
      commissionable = ((S ?? 0) - (O ?? 0)) * ((P ?? 0) - (N ?? 0));
    } else if (G === 'Pilot' && H === 'Conversion') {
      commissionable = ((P ?? 0) - 3) * (S ?? 0);
    } else if (H === 'New - Paid') {
      commissionable = (S ?? 0) * (P ?? 0);
    } else if (I === 'License Transfer') {
      commissionable = (S ?? 0) * (P ?? 0);
    } else {
      commissionable = companyTotal;
    }
  }

  // Implementation billing default (only when not explicitly set):
  //   no one-time fee (blank or 0) -> Not Applicable;  has a one-time fee -> Pending.
  let implStatus = r.implementation_billing_status;
  if (implStatus === null || implStatus === undefined || implStatus === '') {
    implStatus = (V === null || V === 0) ? 'Not Applicable' : 'Pending';
  }

  return {
    formula_column: formula,
    bpr_prod_category: category,
    annual_value: annual,
    company_total_booking: companyTotal,
    commissionable_bookings: commissionable,
    implementation_billing_status: implStatus,
  };
}

// ---------- Churn Tracker ----------

// Computes derived churn fields (columns N, O, P, Q, R, S).
export function computeChurn(r) {
  const S = num(r.mrr);
  const j = r.last_date_under_contract ? new Date(r.last_date_under_contract) : null;
  const blank = { final_invoice_month: '', ar_final_invoice_amount: null,
                  prorated_churn_month: '', prorated_churn_amount: null,
                  final_churn_month: '', final_churn_amount: null };
  if (!j || isNaN(j) || S === null) return blank;

  const daysInMonth = new Date(j.getFullYear(), j.getMonth() + 1, 0).getDate();
  const ar = (S / daysInMonth) * j.getDate();        // O: prorated final-month AR
  const proratedAmt = ar - S;                         // Q: prorated remainder (negative)
  const finalInvoiceMonth = monthYear(j);             // N
  const nextMonth = new Date(j.getFullYear(), j.getMonth() + 1, 1);
  const finalChurnMonth = monthYear(nextMonth);       // R: month after last-under-contract
  const proratedMonth = proratedAmt === 0 ? '-' : monthYear(j); // P
  const finalChurnAmt = -ar;                          // S: full negative churn next month

  return {
    final_invoice_month: finalInvoiceMonth,
    ar_final_invoice_amount: ar,
    prorated_churn_month: proratedMonth,
    prorated_churn_amount: proratedAmt,
    final_churn_month: finalChurnMonth,
    final_churn_amount: finalChurnAmt,
  };
}

// Quarter helpers for the License Transfer offset rule (same-quarter matching).
export function quarterFromMonthName(monthName, year) {
  const i = MONTHS.indexOf(String(monthName || '').trim());
  if (i < 0 || year === null || year === undefined || year === '') return null;
  return { q: Math.floor(i / 3) + 1, year: Number(year) };
}
export function quarterFromMonthYear(my) {
  const [m, y] = String(my || '').trim().split(' ');
  return quarterFromMonthName(m, y);
}

export { monthYear, num };
