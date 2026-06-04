// auth.js — password hashing and signed session tokens using only node:crypto.
// No external dependencies (keeps the flat, build-free repo simple on Railway).
import crypto from 'node:crypto';

// Secret for signing tokens. Set SESSION_SECRET in Railway so tokens survive restarts
// and can't be forged. Falls back to APP_PASSWORD or a constant (dev only).
const SECRET = process.env.SESSION_SECRET || process.env.APP_PASSWORD || 'perq-insecure-default-set-SESSION_SECRET';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// ---- Passwords (scrypt with a per-password random salt) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Tokens (compact "<payload>.<hmac>", base64url) ----
export function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
