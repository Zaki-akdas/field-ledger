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

export async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await qx('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

export async function destroySession(token) {
  await qx('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function userForToken(token) {
  if (!token) return null;
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
