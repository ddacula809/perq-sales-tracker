// db.js — PostgreSQL access layer. Tables are created from the schema definitions
// on boot, so a fresh Railway Postgres is ready with no manual migration.
import pg from 'pg';
import { BOOKING_FIELDS, CHURN_FIELDS } from './schema.js';

const { Pool } = pg;

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
