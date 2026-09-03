import crypto from 'node:crypto';
import { q1, qx } from './db.js';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const test = crypto.scryptSync(password, salt, KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    return test.length === expected.length && crypto.timingSafeEqual(test, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- JWT auth ---
 * Sessions are signed HS256 JWTs (bearer token = the JWT itself). The token
 * carries the claims PostgREST derives from a JWT — sub = user id, role =
 * business role — and the request transaction plants them in the same GUC
 * PostgREST uses (request.jwt.claims), so app queries and any future
 * PostgREST endpoint authorize from the same claims. Tokens are also stored
 * in sessions so logout revokes them; the DB row is still joined per request
 * for a fresh role/name and the active check.
 */
const JWT_TTL_S = Number(process.env.JWT_TTL_SECONDS || 7 * 24 * 60 * 60);

/** Signing secret: pin with JWT_SECRET; otherwise derived from existing secrets. */
export function jwtSecret() {
  if (process.env.JWT_SECRET) return String(process.env.JWT_SECRET);
  const base = [process.env.DATABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .filter(Boolean)
    .join('|');
  return crypto.createHash('sha256').update(base || String(Date.now())).digest('hex');
}

const b64url = (value) => Buffer.from(value).toString('base64url');

/** Sign a session JWT for a user row: { sub, role, iat, exp }. */
export function signUserToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'field-ledger',
    sub: String(user.id),
    role: user.role,
    iat: now,
    exp: now + JWT_TTL_S,
  }));
  const sig = crypto.createHmac('sha256', jwtSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/** Verify a JWT's signature + expiry. Returns the payload, or null. */
export function verifyUserToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const expected = crypto.createHmac('sha256', jwtSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    const got = Buffer.from(sigB64);
    const want = Buffer.from(expected);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.iss !== 'field-ledger' || !Number.isFinite(payload.exp)) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSession(user) {
  const token = signUserToken(user);
  await qx('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
  return token;
}

export async function destroySession(token) {
  await qx('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function userForToken(token) {
  if (!token || !verifyUserToken(token)) return null;
  return q1(`
    SELECT u.id, u.code, u.name, u.role, u.phone
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = $1 AND u.active = 1`, [token]);
}

export function attachUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Store token for async resolution in middleware
  req._token = token;
  next();
}

/** Resolve the async user lookup — called after attachUser. */
export async function resolveUser(req, _res, next) {
  req.user = await userForToken(req._token);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (req.user.role !== role) {
      return res.status(403).json({ error: `This action needs ${role} access.` });
    }
    next();
  };
}

export function publicUser(u) {
  return { id: u.id, code: u.code, name: u.name, role: u.role, phone: u.phone };
}
