// oauth.js — a minimal OAuth 2.1 (authorization-code + PKCE, S256) authorization server so claude.ai
// can add the Revenue Desk as a Custom Connector (remote MCP). Teammates sign in with their existing
// Revenue Desk account during the OAuth flow, so each gets their own role-scoped, READ-ONLY access —
// no shared key. The issued token carries only the "read" scope and is validated on /mcp.
//
// OFF unless MCP_ENABLE=true and APP_BASE_URL is set (the app's public https URL). Uses only
// node:crypto + the pg pool — no external dependencies, keeping the flat, build-free repo intact.
import crypto from 'node:crypto';
import { pool, getUserByUsername, getUserById } from './db.js';
import { verifyPassword } from './auth.js';

const BASE = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
// Roles allowed to use the connector — the same "sees all data" roles as the in-app assistant
// (server.js /api/chat). Excludes account-scoped 'sales' and 'viewer' so the connector never widens
// a user's in-app read access.
const CONNECTOR_ROLES = new Set(['admin', 'standard', 'billing']);
const CODE_TTL_MS = 5 * 60 * 1000;              // authorization code: 5 minutes, single use
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // access token: 30 days
// Claude's fixed OAuth redirect (documented). We always accept it as a valid redirect URI.
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

export function connectorEnabled() { return process.env.MCP_ENABLE === 'true' && !!BASE; }
export function baseUrl() { return BASE; }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hashToken = (t) => b64url(sha256(t));
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

// ---- Discovery metadata ----
// RFC 9728 Protected Resource Metadata — advertised via the /mcp 401 so Claude finds the auth server.
export function protectedResourceMetadata(_req, res) {
  cors(res);
  res.json({
    resource: `${BASE}/mcp`,
    authorization_servers: [BASE],
    scopes_supported: ['read'],
    bearer_methods_supported: ['header'],
  });
}
// RFC 8414 Authorization Server Metadata.
export function authServerMetadata(_req, res) {
  cors(res);
  res.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/authorize`,
    token_endpoint: `${BASE}/token`,
    registration_endpoint: `${BASE}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read'],
  });
}

// ---- Dynamic Client Registration (RFC 7591) — public client, PKCE, no secret ----
export async function registerClient(req, res) {
  cors(res);
  const body = req.body || {};
  const redirects = (Array.isArray(body.redirect_uris) ? body.redirect_uris : [])
    .filter((u) => typeof u === 'string' && u);
  if (!redirects.includes(CLAUDE_CALLBACK)) redirects.push(CLAUDE_CALLBACK);
  const clientId = rand(16);
  await pool.query(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,$2,$3)',
    [clientId, String(body.client_name || 'Claude').slice(0, 200), redirects],
  );
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirects,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

async function getClient(clientId) {
  if (!clientId) return null;
  const r = await pool.query('SELECT * FROM oauth_clients WHERE client_id=$1', [clientId]);
  return r.rows[0] || null;
}
function redirectAllowed(client, redirectUri) {
  return !!client && Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri);
}

// ---- Authorization endpoint (login → auth code) ----
export async function authorizeGet(req, res) {
  const q = req.query || {};
  const client = await getClient(String(q.client_id || ''));
  const redirectUri = String(q.redirect_uri || '');
  if (!client || !redirectAllowed(client, redirectUri)) {
    return res.status(400).type('html').send(errorPage('Invalid client or redirect URI.'));
  }
  if (String(q.response_type || '') !== 'code') return badRedirect(res, redirectUri, q.state, 'unsupported_response_type');
  if (!q.code_challenge || String(q.code_challenge_method || '') !== 'S256') {
    return badRedirect(res, redirectUri, q.state, 'invalid_request');
  }
  res.type('html').send(loginPage(q, ''));
}

export async function authorizePost(req, res) {
  const b = req.body || {};
  const client = await getClient(String(b.client_id || ''));
  const redirectUri = String(b.redirect_uri || '');
  if (!client || !redirectAllowed(client, redirectUri)) {
    return res.status(400).type('html').send(errorPage('Invalid client or redirect URI.'));
  }
  if (!b.code_challenge || String(b.code_challenge_method || '') !== 'S256') {
    return badRedirect(res, redirectUri, b.state, 'invalid_request');
  }
  const user = await getUserByUsername(String(b.username || '').trim());
  if (!user || !verifyPassword(b.password, user.password_hash)) {
    return res.status(200).type('html').send(loginPage(b, 'Invalid username or password.'));
  }
  if (!CONNECTOR_ROLES.has(user.role)) {
    return res.status(200).type('html').send(loginPage(b, 'Your account does not have access to the Claude connector.'));
  }
  const code = rand(32);
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await pool.query(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, scope, expires_at, used)
     VALUES ($1,$2,$3,$4,$5,'read',$6,false)`,
    [hashToken(code), client.client_id, redirectUri, String(b.code_challenge), user.id, expires],
  );
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (b.state) url.searchParams.set('state', String(b.state));
  res.redirect(302, url.toString());
}

// ---- Token endpoint ----
export async function tokenPost(req, res) {
  cors(res);
  const b = req.body || {};
  const grant = String(b.grant_type || '');
  try {
    if (grant === 'authorization_code') return await tokenFromCode(b, res);
    if (grant === 'refresh_token') return await tokenFromRefresh(b, res);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_request', error_description: e.message });
  }
}

async function tokenFromCode(b, res) {
  const code = String(b.code || '');
  if (!code) return res.status(400).json({ error: 'invalid_grant' });
  // Atomically claim the code (single use) so it can't be replayed.
  const upd = await pool.query('UPDATE oauth_codes SET used=true WHERE code_hash=$1 AND used=false RETURNING *', [hashToken(code)]);
  const row = upd.rows[0];
  if (!row) return res.status(400).json({ error: 'invalid_grant' });
  if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' });
  if (String(b.client_id || '') !== row.client_id) return res.status(400).json({ error: 'invalid_client' });
  if (String(b.redirect_uri || '') !== row.redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  const verifier = String(b.code_verifier || '');
  if (!verifier || b64url(sha256(verifier)) !== row.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  return res.json(await issueToken(row.client_id, row.user_id, row.scope));
}

async function tokenFromRefresh(b, res) {
  const refresh = String(b.refresh_token || '');
  if (!refresh) return res.status(400).json({ error: 'invalid_grant' });
  // Rotate: consume the old refresh token, issue a fresh pair.
  const del = await pool.query('DELETE FROM oauth_tokens WHERE refresh_hash=$1 RETURNING *', [hashToken(refresh)]);
  const row = del.rows[0];
  if (!row) return res.status(400).json({ error: 'invalid_grant' });
  return res.json(await issueToken(row.client_id, row.user_id, row.scope));
}

async function issueToken(clientId, userId, scope) {
  const access = rand(32);
  const refresh = rand(32);
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  await pool.query(
    'INSERT INTO oauth_tokens (token_hash, refresh_hash, client_id, user_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [hashToken(access), hashToken(refresh), clientId, userId, scope || 'read', expires],
  );
  return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(TOKEN_TTL_MS / 1000), refresh_token: refresh, scope: scope || 'read' };
}

// ---- Bearer validation for /mcp ----
export async function verifyAccessToken(token) {
  if (!token) return null;
  const r = await pool.query('SELECT * FROM oauth_tokens WHERE token_hash=$1', [hashToken(token)]);
  const row = r.rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = await getUserById(row.user_id);
  if (!user || !CONNECTOR_ROLES.has(user.role)) return null; // role may have changed since issuance
  return { user: { id: user.id, username: user.username, role: user.role, account_owner: user.account_owner || null }, scope: row.scope };
}
export function wwwAuthenticate() {
  return `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;
}

// ---- Small HTML helpers (login + error pages) ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hidden(q) {
  return ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
    .map((k) => (q[k] != null && q[k] !== '' ? `<input type="hidden" name="${k}" value="${esc(q[k])}">` : '')).join('');
}
function badRedirect(res, redirectUri, state, error) {
  try {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (state) url.searchParams.set('state', String(state));
    return res.redirect(302, url.toString());
  } catch { return res.status(400).type('html').send(errorPage(error)); }
}
const PAGE_CSS = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;max-width:380px;width:calc(100% - 32px);padding:28px;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.08)}
h1{font-size:19px;margin:0 0 4px}p{color:#555;font-size:14px;line-height:1.45;margin:6px 0}
label{display:block;font-size:12px;font-weight:600;color:#333;margin:14px 0 4px}
input[type=text],input[type=password],input:not([type]){width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccd;border-radius:8px;font-size:14px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#2f6df6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#255ad0}.err{background:#fdecec;color:#a3261e;border:1px solid #f3c2bd;padding:8px 10px;border-radius:8px;font-size:13px;margin-top:12px}
.note{font-size:12px;color:#888;margin-top:16px}`;
function loginPage(q, error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to PERQ Revenue Desk</title><style>${PAGE_CSS}</style></head><body>
<div class="card"><h1>PERQ Revenue Desk</h1>
<p>Sign in to let <strong>Claude</strong> read your Revenue Desk data.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/authorize" autocomplete="on">${hidden(q)}
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in &amp; connect</button></form>
<p class="note">Claude gets <strong>read-only</strong> access to bookings, churn, and forecasting data — it cannot change anything, and access matches your account's permissions.</p>
</div></body></html>`;
}
function errorPage(msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connection error</title><style>${PAGE_CSS}</style></head><body>
<div class="card"><h1>Connection error</h1><p>${esc(msg)}</p></div></body></html>`;
}
