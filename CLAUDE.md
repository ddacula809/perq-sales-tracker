# CLAUDE.md — PERQ Revenue Desk

Context for Claude Code. Read this before making changes.

## What this is

A web app that replaces two tabs of an Excel sales workbook (`May 2026` bookings
and `Churn Tracker`) with a shared, team-editable ledger backed by PostgreSQL.
The app reproduces every formula column from the original spreadsheet exactly,
and can import the original `.xlsx` and export an updated `.xlsx`.

Users are a sales-ops team (mostly non-technical). Favor clarity and reliability
over cleverness.

## Stack & layout

- Node.js (ES modules) + Express. PostgreSQL via `pg`. SheetJS (`xlsx`) for import/export.
  Vanilla-JS front end, **no build step**.
- **Flat repo** — every file is at the repository root, no subfolders. Keep it that way:
  Railway runs `node server.js` from the root, and the frontend files are served by
  explicit routes. Do not reintroduce a `src/` or `public/` folder.

Files:
- `server.js` — Express API, serves the page (`/`, `/app.js`, `/styles.css`), import/export.
- `db.js` — Postgres pool, auto-creates `bookings` & `churn` tables on boot, CRUD helpers.
- `schema.js` — **single source of truth** for fields, dropdown options, and the Excel
  column mapping. Add/rename/retype a field here and the DB, importer, exporter, and
  frontend forms all follow.
- `compute.js` — the formula logic. **Verified against the original workbook's cached
  values — do not change the math without re-verifying.**
- `importer.js` — parse the original `.xlsx` (reads only the `May 2026` and `Churn Tracker`
  sheets by name; ignores all other tabs).
- `exporter.js` — rebuild both tabs as an `.xlsx` with computed columns recalculated.
- `index.html`, `styles.css`, `app.js` — front end. Tabs: **Dashboard** (default),
  **May 2026 Bookings**, **Churn Tracker**.

## Data model & flow

- Only **editable** fields are stored in Postgres. **Computed** fields are derived on
  every read by `compute.js` (never stored) — so they're always correct and there's no
  cache to invalidate. The exporter recomputes them too.
- Tables are created automatically on boot from `schema.js`. No migration tool.
- **Import replaces ALL rows** in both tables (full reseed via `TRUNCATE` + insert).
  It is not an upsert.

## Formula logic (must stay exact)

Bookings:
- `formula_column` — booking-type bucket from Pilot Type + CTAM Type.
- `bpr_prod_category` — Product → Software / Pulse / Website / Digital Advertising /
  Tools for Google / Unknown.
- `offset_amount` — equals MRR on License Transfers, else null.
- `annual_value` — New-Paid → MRR×12; otherwise Contract Term × MRR.
- `company_total_booking` — 0 for New-Free and (New-Paid + Straight-to-Pay);
  Re-rate → (MRR−OldMRR)×ContractTerm floored at 0; License Transfer →
  (MRR−offset)×BookedTerm; else BookedTerm × MRR.
- `commissionable_bookings` — New-Free → 0; Re-rate → (MRR−OldMRR)×(ContractTerm−PaidMonths);
  Pilot+Conversion → (ContractTerm−3)×MRR; New-Paid / License Transfer → MRR×ContractTerm;
  else equals company_total_booking.

Churn (proration for a partial final month):
- `final_invoice_month` = month of Last Date Under Contract.
- `ar_final_invoice_amount` = MRR / days-in-that-month × day-of-month.
- `prorated_churn_amount` = AR − MRR (negative remainder); `prorated_churn_month` its month.
- `final_churn_month` = the month AFTER Last Date Under Contract; `final_churn_amount` = −AR.

## Gotchas (already handled — don't regress)

- **Dates**: `db.js` registers a pg type parser for OID 1082 so DATE columns return as
  plain `YYYY-MM-DD` strings. Without it, `<input type="date">` renders blank and dates
  can timezone-shift. Keep that parser.
- **Money fields** in the grid are text inputs that show formatted `$` values but parse
  back to plain numbers on save (`parseMoney` in `app.js`). Server-side `clean()`/`num()`
  also strip `$` and commas defensively.
- The original sheet's `CTAM Type` column had a broken `XLOOKUP` to a deleted sheet; here
  it's just a dropdown.

## Environment (Railway)

- `DATABASE_URL` — Postgres (Railway injects from the Postgres service).
- `PORT` — set to `8080`; the app listens on `process.env.PORT`. Railway's domain target
  port must match.
- `DATABASE_SSL` — `true` only for an external Postgres that needs SSL; unset for Railway internal.
- `APP_PASSWORD` — optional shared access key; when set, the API requires header `x-app-key`.

## Workflow expectations

- This repo auto-deploys: a push to the default branch on GitHub triggers a Railway deploy.
  After making a change, commit with a clear message and push.
- Keep the flat structure and the entry point `node server.js` intact, or the deploy breaks.
- After schema or compute changes, sanity-check by importing the original workbook and
  spot-checking a License Transfer, a Re-rate, and a churn row against expected values.

## Run locally

```bash
npm install
export DATABASE_URL="postgresql://localhost:5432/perq"
export PORT=8080
npm start            # http://localhost:8080
```
