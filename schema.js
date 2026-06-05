// schema.js — field definitions, dropdown options, and Excel column mapping.
// Shared by the importer, exporter, DB layer, and (served to) the frontend.

// Editable booking fields stored in DB. `excel` = 0-based column index in the
// original "May 2026" sheet (header row 7, data from row 8).
export const BOOKING_FIELDS = [
  { key: 'booking_month',                   label: 'Booking Month',          excel: 40, type: 'select', options: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] },
  { key: 'booking_year',                    label: 'Booking Year',           excel: 41, type: 'number' },
  { key: 'centralized',                     label: 'Centralized',            excel: 0,  type: 'select', options: ['Centralized', 'Decentralized'] },
  { key: 'sales_rep',                       label: 'Sales Rep',              excel: 1,  type: 'select', options: ['Kathryn', 'Doug', 'House/CSM', 'Caleb', 'Kirk', 'Scott', 'Cindy', 'Michelle'] },
  { key: 'property_id',                     label: 'Property ID',            excel: 2,  type: 'text' },
  { key: 'property_name',                   label: 'Property Name',          excel: 3,  type: 'text' },
  { key: 'pmc',                             label: 'PMC',                    excel: 4,  type: 'text' },
  { key: 'buying_center',                   label: 'Buying Center',          excel: 5,  type: 'text' },
  { key: 'pilot_or_ctam',                   label: 'Pilot or CTAM',          excel: 6,  type: 'select', options: ['', 'Pilot', 'CTAM'] },
  { key: 'pilot_type',                      label: 'Pilot Type',             excel: 7,  type: 'select', options: ['', 'New - Paid', 'New - Free', 'Conversion', 'Pilot Expansion', 'Second Signature'] },
  { key: 'ctam_type',                       label: 'CTAM Type',              excel: 8,  type: 'select', options: ['', 'Straight to Pay', 'Expansion', 'Upsell', 'License Transfer', 'Renewal Rate Increase', 'Downgrade', 'Re-rate'] },
  { key: 'product',                         label: 'Product',                excel: 10, type: 'select', options: ['AI Lead Capture Agent', 'Pulse Data Hub', 'AI Leasing Agent', 'Performance Reporting Agent', 'Property Website', 'Corporate Website', 'Google Search Management', 'AI Google Booking Agent', 'AI Google Posts and Products', 'SEO'] },
  { key: 'mql',                             label: 'MQL',                    excel: 12, type: 'select', options: ['', 'YES', 'NO'] },
  { key: 'rerate_paid_months',              label: 'Re-rate Paid Months',    excel: 13, type: 'number' },
  { key: 'rerate_old_mrr',                  label: 'Re-rate Old MRR',        excel: 14, type: 'number' },
  { key: 'contract_term',                   label: 'Contract Term',          excel: 15, type: 'number' },
  { key: 'booked_term',                     label: 'Booked Term',            excel: 16, type: 'number' },
  { key: 'date_signed',                     label: 'Date Signed',            excel: 17, type: 'date' },
  { key: 'mrr',                             label: 'MRR',                    excel: 18, type: 'number' },
  { key: 'offset_amount',                   label: 'Offset Amount',          excel: 19, type: 'number' },
  { key: 'one_time_fee',                    label: 'One-Time Fee',           excel: 21, type: 'number' },
  { key: 'notes',                           label: 'Notes',                  excel: 24, type: 'text' },
  { key: 'discuss_in_review',               label: 'To Discuss',             excel: 25, type: 'text' },
  { key: 'salesforce_oppty',                label: 'SF Oppty',               excel: 26, type: 'select', options: ['', 'YES', 'NO'] },
  { key: 'sales_support',                   label: 'Sales Support',          excel: 27, type: 'select', options: ['', 'YES', 'NO'] },
  { key: 'sf_reconciled',                   label: 'SF Reconciled',          excel: 28, type: 'select', options: ['', 'YES', 'NO'] },
  { key: 'month1',                          label: 'Month 1',                excel: 29, type: 'number' },
  { key: 'month2',                          label: 'Month 2',                excel: 30, type: 'number' },
  { key: 'month3',                          label: 'Month 3',                excel: 31, type: 'number' },
  { key: 'golive_date_added',               label: 'GoLive Added',           excel: 32, type: 'text' },
  { key: 'golive_date',                     label: 'GoLive Date',            excel: 33, type: 'date' },
  { key: 'billing_trigger',                 label: 'Billing Trigger',        excel: 34, type: 'select', options: ['', 'Go Live', 'Billing Schedule', 'DA Billing Sheet', 'No Action'] },
  { key: 'recurring_billing_status',        label: 'Recurring Billing',      excel: 35, type: 'select', options: ['', 'Completed', 'Pending'] },
  { key: 'implementation_billing_status',   label: 'Impl. Billing',          excel: 36, type: 'select', options: ['', 'Completed', 'Pending', 'Not Applicable'] },
  { key: 'completed_by',                    label: 'Completed By',           excel: 37, type: 'select', options: ['', 'Brittany', 'Rose', 'Germaine'] },
  { key: 'completed_date',                  label: 'Completed Date',         excel: 38, type: 'date' },
  { key: 'sage_id',                         label: 'Sage ID',                excel: 39, type: 'text' },
];

// Computed booking fields (read-only). `excel` = column index for export.
export const BOOKING_COMPUTED = [
  { key: 'formula_column',          label: 'Formula Column',        excel: 9,  type: 'text' },
  { key: 'bpr_prod_category',       label: 'BPR Prod Category',     excel: 11, type: 'text' },
  { key: 'annual_value',            label: 'Annual Value',          excel: 20, type: 'number' },
  { key: 'company_total_booking',   label: 'Company Total Booking', excel: 22, type: 'number' },
  { key: 'commissionable_bookings', label: 'Commissionable',        excel: 23, type: 'number' },
];

// Editable churn fields. `excel` = 0-based column in "Churn Tracker" (header row 1, data row 2).
export const CHURN_FIELDS = [
  { key: 'old_value',                label: 'Old Value',             excel: 0,  type: 'text' },
  { key: 'new_value',                label: 'New Value',             excel: 1,  type: 'text' },
  { key: 'edit_date',                label: 'Edit Date',             excel: 2,  type: 'text' },
  { key: 'property_id',              label: 'Property ID',           excel: 3,  type: 'text' },
  { key: 'sage_id',                  label: 'Sage ID',               excel: 4,  type: 'text' },
  { key: 'pmc_buying_center',        label: 'PMC Buying Center',     excel: 5,  type: 'text' },
  { key: 'property',                 label: 'Property',              excel: 6,  type: 'text' },
  { key: 'product',                  label: 'Product',               excel: 7,  type: 'text' },
  { key: 'mrr',                      label: 'MRR',                   excel: 8,  type: 'number' },
  { key: 'last_date_under_contract', label: 'Last Date Under Contract', excel: 9, type: 'date' },
  { key: 'lost_mrr_reason',          label: 'Lost MRR Reason',       excel: 10, type: 'select', options: ['', 'Property Sold/PMC Change', 'Product', 'Persona', 'Process', 'Price', 'Other'] },
  { key: 'client_success_manager',   label: 'Client Success Mgr',    excel: 11, type: 'text' },
  { key: 'google_search_budget',     label: 'Google Search Budget',  excel: 12, type: 'number' },
  { key: 'template_deleted',         label: 'Template Deleted',      excel: 19, type: 'text' },
  { key: 'completed',                label: 'Completed',             excel: 20, type: 'select', options: ['', 'CM', 'Invoice', 'No Action needed'] },
  { key: 'notes',                    label: 'Notes',                 excel: 21, type: 'text' },
];

export const CHURN_COMPUTED = [
  { key: 'final_invoice_month',      label: 'Final Invoice Month',   excel: 13, type: 'text' },
  { key: 'ar_final_invoice_amount',  label: 'AR Final Invoice Amt',  excel: 14, type: 'number' },
  { key: 'prorated_churn_month',     label: 'Prorated Churn Month',  excel: 15, type: 'text' },
  { key: 'prorated_churn_amount',    label: 'Prorated Churn Amt',    excel: 16, type: 'number' },
  { key: 'final_churn_month',        label: 'Final Churn Month',     excel: 17, type: 'text' },
  { key: 'final_churn_amount',       label: 'Final Churn Amt',       excel: 18, type: 'number' },
];

export const BOOKING_SHEET = 'May 2026';
export const CHURN_SHEET = 'Churn Tracker';

// Billing-section field keys per table (the blue columns). Used to tint/reorder them in
// the UI and to restrict what a "billing" role user is allowed to edit on the server.
export const BOOKING_BILLING_KEYS = [
  'billing_trigger', 'recurring_billing_status', 'implementation_billing_status',
  'completed_by', 'completed_date', 'sage_id',
];
export const CHURN_BILLING_KEYS = ['template_deleted', 'completed', 'notes'];

// User roles. admin: full access + user management. standard: edit all data.
// billing: edit only the billing columns. viewer: read-only.
export const USER_ROLES = ['admin', 'standard', 'billing', 'viewer'];

// BPR product categories (see compute.js bprCategory).
export const BPR_CATEGORIES = ['Software', 'Pulse', 'Website', 'Digital Advertising', 'Tools for Google'];

// Sales Support (Q2 2026 forecast). Editable fields stored in the sales_support table.
// The monthly "Actual" columns and "Q2 Actual" are computed on the client from Bookings.
export const SALES_SUPPORT_SECTIONS = ['Pilot / New Logo', 'CTAM'];
export const SALES_SUPPORT_FIELDS = [
  { key: 'product_category', label: 'Product',        type: 'select', options: BPR_CATEGORIES },
  { key: 'section',          label: 'Section',        type: 'select', options: SALES_SUPPORT_SECTIONS },
  { key: 'pmc',              label: 'PMC',            type: 'text' },
  { key: 'booking_type',     label: 'Booking Type',   type: 'select', options: ['', 'Pilot', 'Conversion', 'Straight to Pay', 'Expansion', 'Upsell', 'License Transfer', 'Renewal Rate Increase', 'Downgrade', 'Re-rate'] },
  { key: 'account_owner',    label: 'Account Owner',  type: 'select', options: ['', 'Kathryn', 'Doug', 'House/CSM', 'Caleb', 'Kirk', 'Scott', 'Cindy', 'Michelle'] },
  { key: 'q2_target',        label: 'Quarter Target', type: 'number' }, // quarter target (generic slot)
  { key: 'apr_target',       label: 'Month 1 Target', type: 'number' }, // 1st month of the quarter
  { key: 'may_target',       label: 'Month 2 Target', type: 'number' },
  { key: 'jun_target',       label: 'Month 3 Target', type: 'number' },
  { key: 'worst',            label: 'Worst',          type: 'number' },
  { key: 'accurate',         label: 'Accurate',       type: 'number' },
  { key: 'best',             label: 'Best',           type: 'number' },
  { key: 'notes',            label: 'Notes',          type: 'text' },
  { key: 'period',           label: 'Period',         type: 'text' },  // 'Q2 2026' (scoping; not shown)
];
