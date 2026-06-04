// db.js — PostgreSQL access layer. Tables are created from the schema definitions
// on boot, so a fresh Railway Postgres is ready with no manual migration.
import pg from 'pg';
import { BOOKING_FIELDS, CHURN_FIELDS } from './schema.js';
import { hashPassword } from './auth.js';

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
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'standard',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username))');
  await ensureColumns('bookings', BOOKING_FIELDS);
  await ensureColumns('churn', CHURN_FIELDS);
  await runOnce('offset_amount_backfill_v1', backfillOffsetAmount);
  await runOnce('booking_period_backfill_v1', backfillBookingPeriod);
  await ensureAdmin();
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
  const { rows } = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY username ASC');
  return rows;
}
export async function createUser({ username, password, role }) {
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
    [username, hashPassword(password), role]
  );
  return rows[0];
}
export async function updateUser(id, { role, password }) {
  const sets = [];
  const vals = [];
  if (role) { vals.push(role); sets.push(`role=$${vals.length}`); }
  if (password) { vals.push(hashPassword(password)); sets.push(`password_hash=$${vals.length}`); }
  if (!sets.length) {
    const { rows } = await pool.query('SELECT id, username, role, created_at FROM users WHERE id=$1', [id]);
    return rows[0];
  }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id, username, role, created_at`,
    vals
  );
  return rows[0];
}
export async function deleteUser(id) { await pool.query('DELETE FROM users WHERE id=$1', [id]); }
export async function getUserById(id) {
  const { rows } = await pool.query('SELECT id, username, role, created_at FROM users WHERE id=$1', [id]);
  return rows[0];
}
export async function countAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin'`);
  return rows[0].n;
}

const TABLES = {
  bookings: BOOKING_FIELDS,
  churn: CHURN_FIELDS,
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
