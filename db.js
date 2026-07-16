// db.js — PostgreSQL access layer. Tables are created from the schema definitions
// on boot, so a fresh Railway Postgres is ready with no manual migration.
import pg from 'pg';
import {
  BOOKING_FIELDS, CHURN_FIELDS, SALES_SUPPORT_FIELDS, SALESFORCE_RECON_FIELDS,
  LEGACY_GOLIVE_FIELDS, LEGACY_CHURN_FIELDS, PRODUCT_FIELDS,
} from './schema.js';
import { hashPassword } from './auth.js';
import { bprCategory } from './compute.js';
import { setCatalog } from './catalog.js';

const { Pool, types } = pg;

// DATE columns (OID 1082): return the raw 'YYYY-MM-DD' string instead of a JS Date.
// Without this, pg hands back a Date object that JSON-serializes to a full ISO
// timestamp, which <input type="date"> can't render (shows blank) and which can
// timezone-shift. Keep this parser. (See CLAUDE.md "Gotchas".)
types.setTypeParser(1082, (val) => val);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set. Add a PostgreSQL service in Railway (it injects DATABASE_URL).');
  process.exit(1);
}

// Railway internal connections do not need SSL; external ones do. Toggle with DATABASE_SSL=true.
const ssl = String(process.env.DATABASE_SSL).toLowerCase() === 'true'
  ? { rejectUnauthorized: false }
  : false;

export const pool = new Pool({ connectionString, ssl });

function sqlType(type) {
  if (type === 'number') return 'numeric';
  if (type === 'date') return 'date';
  return 'text';
}

function columnsDef(fields) {
  return fields.map((f) => `"${f.key}" ${sqlType(f.type)}`).join(',\n  ');
}

// Add any schema fields that aren't yet columns on an existing table. CREATE TABLE
// IF NOT EXISTS only helps a fresh DB; for an already-deployed table (e.g. on Railway)
// this is how a newly added field actually gets its column. Safe to run every boot.
async function ensureColumns(table, fields) {
  for (const f of fields) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${f.key}" ${sqlType(f.type)}`);
  }
}

// Run a one-time data repair, tracked so it executes exactly once across reboots.
async function runOnce(name, fn) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
  if (rowCount) return;
  await fn();
  await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
}

// When offset_amount became an editable field, the new column was added as NULL on
// existing rows — dropping the original computed offset (= MRR for License Transfers)
// and changing company_total_booking. Restore that original value once, only for rows
// the original formula treated as License Transfers (matches formulaColumn): CTAM Type
// = License Transfer and Pilot Type not one of the pilot/conversion buckets. Rows where
// an offset has since been entered are skipped (offset_amount IS NULL guard).
async function backfillOffsetAmount() {
  await pool.query(`
    UPDATE bookings
       SET offset_amount = mrr
     WHERE offset_amount IS NULL
       AND mrr IS NOT NULL
       AND ctam_type = 'License Transfer'
       AND COALESCE(pilot_type, '') NOT IN
           ('New - Paid', 'New - Free', 'Conversion', 'Pilot Expansion', 'Second Signature');
  `);
}

// The Booking Month/Year columns were added after the existing rows were imported, so they
// start out NULL. The current data is the May 2026 workbook — tag it once so it stays
// distinguishable now that all bookings share one tab. New/imported rows set their own values.
async function backfillBookingPeriod() {
  await pool.query(`UPDATE bookings SET booking_month = 'May' WHERE booking_month IS NULL`);
  await pool.query(`UPDATE bookings SET booking_year = 2026  WHERE booking_year IS NULL`);
}

// Fix the product-name typo "AI Lead Captur Agent" -> "AI Lead Capture Agent" in existing data.
async function fixLeadCaptureTypo() {
  await pool.query(`UPDATE bookings SET product = 'AI Lead Capture Agent' WHERE product = 'AI Lead Captur Agent'`);
  await pool.query(`UPDATE churn    SET product = 'AI Lead Capture Agent' WHERE product = 'AI Lead Captur Agent'`);
}

// Fix the product-name typo "AI Google Booking Agent" -> "AI Google Bookings Agent" in existing data.
async function fixGoogleBookingsTypo() {
  await pool.query(`UPDATE bookings SET product = 'AI Google Bookings Agent' WHERE product = 'AI Google Booking Agent'`);
  await pool.query(`UPDATE churn    SET product = 'AI Google Bookings Agent' WHERE product = 'AI Google Booking Agent'`);
}

// One-time: reopen Q2 2026, which was auto-archived when a new quarter was opened
// (before closing became an explicit, confirmed action).
async function reopenQ2_2026() {
  await pool.query(`UPDATE sales_periods SET status='open', closed_at=NULL WHERE period='Q2 2026'`);
}

// Reconcile Sales Rep / Account Owner names against the Salesforce Recon master so they
// read exactly as written there (e.g. "Kirk" -> "Kirk Flatter"). Idempotent.
//   A) Bookings: set sales_rep from the property's Account Owner (match Property ID).
//   B) First-name -> full-name map (built from Recon) for anything else, in both tables.
export async function reconcileOwnerNames() {
  await pool.query(`
    UPDATE bookings b
    SET sales_rep = sub.account_owner
    FROM (
      SELECT DISTINCT ON (TRIM(property_id_18)) TRIM(property_id_18) AS pid, account_owner
      FROM salesforce_recon
      WHERE account_owner IS NOT NULL AND TRIM(account_owner) <> '' AND property_id_18 IS NOT NULL
      ORDER BY TRIM(property_id_18)
    ) sub
    WHERE TRIM(b.property_id) = sub.pid
      AND COALESCE(TRIM(b.sales_rep), '') <> sub.account_owner
  `);
  const { rows } = await pool.query(
    `SELECT DISTINCT TRIM(account_owner) AS owner FROM salesforce_recon
     WHERE account_owner IS NOT NULL AND TRIM(account_owner) <> ''`);
  const map = new Map();
  const ambiguous = new Set();
  for (const r of rows) {
    const full = r.owner;
    const first = full.split(/\s+/)[0].toLowerCase();
    if (map.has(first) && map.get(first) !== full) ambiguous.add(first);
    else map.set(first, full);
  }
  for (const a of ambiguous) map.delete(a); // skip first names that map to more than one person
  for (const [first, full] of map) {
    await pool.query(`UPDATE bookings      SET sales_rep     = $1 WHERE lower(trim(sales_rep))     = $2`, [full, first]);
    await pool.query(`UPDATE sales_support SET account_owner = $1 WHERE lower(trim(account_owner)) = $2`, [full, first]);
  }
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      ${columnsDef(BOOKING_FIELDS)},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS churn (
      id SERIAL PRIMARY KEY,
      ${columnsDef(CHURN_FIELDS)},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_support (
      id SERIAL PRIMARY KEY,
      ${columnsDef(SALES_SUPPORT_FIELDS)},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salesforce_recon (
      id SERIAL PRIMARY KEY,
      ${columnsDef(SALESFORCE_RECON_FIELDS)},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legacy_golives (
      id SERIAL PRIMARY KEY,
      ${columnsDef(LEGACY_GOLIVE_FIELDS)},
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legacy_churn (
      id SERIAL PRIMARY KEY,
      ${columnsDef(LEGACY_CHURN_FIELDS)},
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'standard',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username))');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS account_owner TEXT'); // tag for 'sales' role
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      target_tab TEXT NOT NULL DEFAULT 'bookings',
      booking_id INTEGER,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed BOOLEAN NOT NULL DEFAULT false
    );
  `);
  await pool.query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_tab TEXT NOT NULL DEFAULT 'bookings'");
  // 'dismissed' clears a notification from the header bell; 'resolved' clears the warning
  // from the Billing Dashboard "For Immediate Action" tile. They are independent: dismissing
  // in the bell does NOT resolve the warning — only the Resolve button does.
  await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT false');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_periods (
      period TEXT PRIMARY KEY,
      quarter INTEGER NOT NULL,
      year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Closed accounting months. A month (e.g. "May 2026") is locked with an official close date;
  // late-added churn that would land in a closed month carries over to the next open month.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS closed_months (
      month TEXT PRIMARY KEY,
      close_date DATE NOT NULL,
      closed_by TEXT,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Admin-managed product list (drives the Product dropdowns). Name is unique (case-insensitive).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      ${columnsDef(PRODUCT_FIELDS)},
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS products_name_lower_idx ON products (lower(name))');
  await ensureColumns('products', PRODUCT_FIELDS);
  await ensureColumns('bookings', BOOKING_FIELDS);
  await ensureColumns('churn', CHURN_FIELDS);
  await ensureColumns('sales_support', SALES_SUPPORT_FIELDS);
  await ensureColumns('salesforce_recon', SALESFORCE_RECON_FIELDS);
  await ensureColumns('legacy_golives', LEGACY_GOLIVE_FIELDS);
  await ensureColumns('legacy_churn', LEGACY_CHURN_FIELDS);
  // Link from a License Transfer booking to the churn it offset (kept out of the schema/grid).
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS offset_churn_id integer');
  // Revenue Desk instance a booking belongs to ('multifamily' = the original app; 'convert' = the
  // second instance). Kept out of the schema/grid; existing rows default to multifamily.
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT 'multifamily'");
  // Per-user access to the Convert instance (admins always have access).
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS convert_access BOOLEAN NOT NULL DEFAULT false');
  await runOnce('offset_amount_backfill_v1', backfillOffsetAmount);
  await runOnce('booking_period_backfill_v1', backfillBookingPeriod);
  await runOnce('fix_lead_capture_typo_v1', fixLeadCaptureTypo);
  await runOnce('fix_google_bookings_typo_v1', fixGoogleBookingsTypo);
  await runOnce('sales_periods_init_v1', initSalesPeriods);
  await runOnce('reopen_q2_2026_v1', reopenQ2_2026);
  await runOnce('reconcile_owner_names_v1', reconcileOwnerNames);
  await runOnce('churn_classification_default_v1', async () => {
    await pool.query(`UPDATE churn SET classification='Churn' WHERE classification IS NULL OR classification=''`);
  });
  // Before this release, "dismiss" cleared the warning entirely. Treat anything already
  // dismissed as resolved so old, handled warnings don't resurface in the new action tile.
  await runOnce('notif_dismissed_to_resolved_v1', async () => {
    await pool.query('UPDATE notifications SET resolved = true WHERE dismissed = true');
  });
  // Backfill the new bare "Property Name" (property_only) from the combined "PMC - Property"
  // value (property_name) by dropping the PMC prefix.
  await runOnce('booking_property_only_v1', async () => {
    const { rows } = await pool.query('SELECT id, property_name, pmc FROM bookings');
    for (const b of rows) {
      const c = String(b.property_name || '').trim();
      if (!c) continue;
      const p = String(b.pmc || '').trim();
      let only = c;
      if (p && c.toLowerCase().startsWith(`${p.toLowerCase()} - `)) only = c.slice(p.length + 3).trim();
      else { const i = c.indexOf(' - '); if (i >= 0) only = c.slice(i + 3).trim(); }
      await pool.query("UPDATE bookings SET property_only=$1 WHERE id=$2 AND (property_only IS NULL OR property_only='')", [only, b.id]);
    }
  });
  // Backfill the new churn "Date Added" from each row's created_at (the date it was first added).
  await runOnce('churn_date_added_backfill_v1', async () => {
    await pool.query("UPDATE churn SET date_added = created_at::date WHERE date_added IS NULL");
  });
  // Backfill "GoLive Set Date" for already-live bookings from created_at, so closing a month
  // never retroactively carries over MRR that was already live before the close.
  await runOnce('booking_golive_set_date_backfill_v1', async () => {
    await pool.query("UPDATE bookings SET golive_set_date = created_at::date WHERE golive_date IS NOT NULL AND golive_set_date IS NULL");
  });
  // Seed the products table once from the Booking "product" options (category from bprCategory).
  await runOnce('seed_products_v1', seedProducts);
  await ensureAdmin();
  await loadCatalog(); // populate the in-memory Product -> BPR Category map for compute.js
}

// Seed `products` from the schema's Booking product options, deriving each BPR Category from the
// built-in bprCategory mapping. Only runs when the table is empty (a one-time bootstrap).
async function seedProducts() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (rows[0].n > 0) return;
  const opts = (BOOKING_FIELDS.find((f) => f.key === 'product') || {}).options || [];
  for (let i = 0; i < opts.length; i++) {
    const name = String(opts[i] || '').trim();
    if (!name) continue;
    const cat = bprCategory(name);
    await pool.query(
      'INSERT INTO products (name, bpr_category, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [name, cat && cat !== 'Unknown' ? cat : 'Software', (i + 1) * 10]);
  }
}

// Read products ordered for display (sort_order, then name).
export async function listProducts() {
  const { rows } = await pool.query(
    "SELECT * FROM products ORDER BY COALESCE(sort_order, 999999) ASC, lower(name) ASC");
  return rows;
}

// Refresh the in-memory Product -> BPR Category map from the DB. Call after any product change.
export async function loadCatalog() {
  const rows = await listProducts();
  setCatalog(rows.map((r) => [r.name, r.bpr_category]));
}

// Seed the first sales period (Q2 2026) and tag existing sales_support rows to it.
async function initSalesPeriods() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sales_periods');
  if (rows[0].n === 0) {
    await pool.query(`INSERT INTO sales_periods (period, quarter, year, status) VALUES ('Q2 2026', 2, 2026, 'open')`);
  }
  await pool.query(`UPDATE sales_support SET period = 'Q2 2026' WHERE period IS NULL`);
}

// ---- Closed months (month-end lock) ----
export async function listClosedMonths() {
  const { rows } = await pool.query('SELECT month, close_date, closed_by, closed_at FROM closed_months ORDER BY closed_at DESC');
  return rows;
}
export async function closeMonth(month, closeDate, by) {
  const { rows } = await pool.query(
    `INSERT INTO closed_months (month, close_date, closed_by) VALUES ($1, $2, $3)
       ON CONFLICT (month) DO UPDATE SET close_date = EXCLUDED.close_date, closed_by = EXCLUDED.closed_by, closed_at = now()
       RETURNING month, close_date, closed_by, closed_at`,
    [month, closeDate, by || null]);
  return rows[0];
}
export async function reopenMonth(month) {
  await pool.query('DELETE FROM closed_months WHERE month = $1', [month]);
}

// ---- Sales Support periods ----
export async function listPeriods() {
  const { rows } = await pool.query('SELECT period, quarter, year, status, closed_at FROM sales_periods ORDER BY year ASC, quarter ASC');
  return rows;
}
export async function getOpenPeriod() {
  const { rows } = await pool.query(`SELECT * FROM sales_periods WHERE status='open' ORDER BY year DESC, quarter DESC LIMIT 1`);
  return rows[0];
}
export async function closeAllOpenPeriods() {
  await pool.query(`UPDATE sales_periods SET status='closed', closed_at=now() WHERE status='open'`);
}
export async function getPeriod(period) {
  const { rows } = await pool.query('SELECT * FROM sales_periods WHERE period=$1', [period]);
  return rows[0];
}
export async function closePeriod(period) {
  const { rows } = await pool.query(
    `UPDATE sales_periods SET status='closed', closed_at=now() WHERE period=$1 RETURNING *`, [period]);
  return rows[0];
}
export async function latestPeriod() {
  const { rows } = await pool.query('SELECT * FROM sales_periods ORDER BY year DESC, quarter DESC LIMIT 1');
  return rows[0];
}
export async function createPeriod(quarter, year) {
  const period = `Q${quarter} ${year}`;
  await pool.query(
    `INSERT INTO sales_periods (period, quarter, year, status) VALUES ($1, $2, $3, 'open')
     ON CONFLICT (period) DO UPDATE SET status='open', closed_at=NULL`,
    [period, quarter, year]
  );
  return { period, quarter, year, status: 'open' };
}
export async function getRowPeriod(table, id) {
  const { rows } = await pool.query(`SELECT period FROM ${table} WHERE id=$1`, [id]);
  return rows[0] ? rows[0].period : null;
}

// ---- Notifications (e.g. GoLive date changes, for billing users) ----
// Returns every unresolved warning (the "For Immediate Action" set), each carrying its
// own `dismissed` flag so the header bell can hide acknowledged ones without resolving them.
export async function listNotifications() {
  const { rows } = await pool.query('SELECT id, target_tab, booking_id, message, created_at, dismissed FROM notifications WHERE resolved = false ORDER BY created_at DESC, id DESC');
  return rows;
}
export async function createNotification(targetTab, rowId, message) {
  await pool.query('INSERT INTO notifications (target_tab, booking_id, message) VALUES ($1, $2, $3)', [targetTab, rowId, message]);
}
// Bell "✕": acknowledge — hide from the bell, but keep the warning on the dashboard.
export async function dismissNotification(id) {
  await pool.query('UPDATE notifications SET dismissed = true WHERE id=$1', [id]);
}
// Dashboard "Resolve": clear the warning entirely (also clears it from the bell).
export async function resolveNotification(id) {
  await pool.query('UPDATE notifications SET resolved = true, dismissed = true WHERE id=$1', [id]);
}

// Seed the first admin if there are no users yet, so a fresh deploy isn't locked out.
// Configurable via ADMIN_USERNAME / ADMIN_PASSWORD env vars (defaults: admin / admin).
async function ensureAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || 'admin';
  await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
    [username, hashPassword(password), 'admin']
  );
  console.log(`Seeded initial admin "${username}". Log in and change the password right away.`);
}

// ---- User accounts ----
export async function getUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username]);
  return rows[0];
}
export async function listUsers() {
  const { rows } = await pool.query('SELECT id, username, role, account_owner, convert_access, created_at FROM users ORDER BY username ASC');
  return rows;
}
export async function createUser({ username, password, role, account_owner, convert_access }) {
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, role, account_owner, convert_access) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role, account_owner, convert_access, created_at',
    [username, hashPassword(password), role, account_owner || null, !!convert_access]
  );
  return rows[0];
}
export async function updateUser(id, { role, password, account_owner, convert_access }) {
  const sets = [];
  const vals = [];
  if (role) { vals.push(role); sets.push(`role=$${vals.length}`); }
  if (password) { vals.push(hashPassword(password)); sets.push(`password_hash=$${vals.length}`); }
  if (account_owner !== undefined) { vals.push(account_owner || null); sets.push(`account_owner=$${vals.length}`); }
  if (convert_access !== undefined) { vals.push(!!convert_access); sets.push(`convert_access=$${vals.length}`); }
  if (!sets.length) {
    const { rows } = await pool.query('SELECT id, username, role, account_owner, convert_access, created_at FROM users WHERE id=$1', [id]);
    return rows[0];
  }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id, username, role, account_owner, convert_access, created_at`,
    vals
  );
  return rows[0];
}
export async function deleteUser(id) { await pool.query('DELETE FROM users WHERE id=$1', [id]); }
export async function getUserById(id) {
  const { rows } = await pool.query('SELECT id, username, role, account_owner, convert_access, created_at FROM users WHERE id=$1', [id]);
  return rows[0];
}
export async function countAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin'`);
  return rows[0].n;
}

const TABLES = {
  bookings: BOOKING_FIELDS,
  churn: CHURN_FIELDS,
  sales_support: SALES_SUPPORT_FIELDS,
  salesforce_recon: SALESFORCE_RECON_FIELDS,
  legacy_golives: LEGACY_GOLIVE_FIELDS,
  legacy_churn: LEGACY_CHURN_FIELDS,
  products: PRODUCT_FIELDS,
};

// Normalize an incoming value for a given field type before writing.
function clean(value, type) {
  if (value === undefined || value === null || value === '') return null;
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    const d = new Date(value);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  return String(value);
}

export async function listRows(table) {
  const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return rows;
}

export async function insertRow(table, data) {
  const fields = TABLES[table];
  const keys = fields.map((f) => f.key);
  const values = fields.map((f) => clean(data[f.key], f.type));
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols}) VALUES (${params}) RETURNING *`,
    values
  );
  return rows[0];
}

export async function updateRow(table, id, data) {
  const fields = TABLES[table].filter((f) => f.key in data);
  if (fields.length === 0) {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id]);
    return rows[0];
  }
  const sets = fields.map((f, i) => `"${f.key}"=$${i + 1}`);
  const values = fields.map((f) => clean(data[f.key], f.type));
  sets.push(`updated_at=now()`);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id=$${values.length} RETURNING *`,
    values
  );
  return rows[0];
}

export async function deleteRow(table, id) {
  await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
}

export async function replaceAll(table, rowsData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${table} RESTART IDENTITY`);
    const fields = TABLES[table];
    const keys = fields.map((f) => f.key);
    const cols = keys.map((k) => `"${k}"`).join(', ');
    for (const data of rowsData) {
      const values = fields.map((f) => clean(data[f.key], f.type));
      const params = keys.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(`INSERT INTO ${table} (${cols}) VALUES (${params})`, values);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
