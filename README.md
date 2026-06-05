# PERQ Revenue Desk

A web app that replaces the **May 2026 Bookings** and **Churn Tracker** tabs of the
PERQ sales workbook with a shared, team-editable ledger backed by PostgreSQL.
All the spreadsheet's formula columns are reproduced exactly, and you can import your
existing workbook and export back to `.xlsx` at any time.

This is the **flat** layout: every file lives at the repository root (no subfolders),
which makes uploading to GitHub via the web uploader reliable.

## Files

- `server.js` — Express API + serves the web page + import/export endpoints
- `db.js` — PostgreSQL pool, auto-creates tables on boot, CRUD
- `compute.js` — formula logic (verified against the original workbook)
- `schema.js` — field definitions, dropdown options, Excel column mapping
- `importer.js` — parse the original `.xlsx` into rows
- `exporter.js` — rows back into an `.xlsx` (computed columns recalculated)
- `index.html`, `styles.css`, `app.js` — the web front end
- `package.json`, `railway.json`, `.gitignore`, `.env.example`

## Deploy on Railway

1. Put all the files in a GitHub repo (root level — no folders).
2. Railway: **New Project → Deploy from GitHub repo** → pick the repo.
3. **New → Database → Add PostgreSQL** in the same project.
4. App service → **Variables**: ensure `DATABASE_URL` references the Postgres service,
   and add `PORT` = `8080`.
5. App service → **Settings → Networking → Generate Domain**, target port `8080`.
6. Open the URL → click **Import .xlsx** → upload `2026_PERQ_Sales_Results.xlsx`.

Optional: add `APP_PASSWORD` to require a shared access key.
Set `DATABASE_SSL=true` only for an external Postgres that requires SSL.

## Run locally

```bash
npm install
export DATABASE_URL="postgresql://localhost:5432/perq"
export PORT=8080
npm start   # open http://localhost:8080
```
