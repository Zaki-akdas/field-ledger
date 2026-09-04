import { Router } from 'express';
import { q1, qx } from '../db.js';
import { createSession, destroySession, verifyPassword, hashPassword, publicUser, requireAuth } from '../auth.js';
import { noteFailure, overLimit, clearSuccess } from '../loginThrottle.js';

/** Pre-auth user lookup — SECURITY DEFINER helper, legacy query as fallback. */
async function findUserByCode(code) {
  try {
    return await q1('SELECT * FROM app_find_user_by_code($1)', [code]);
  } catch (err) {
    if (err?.code === '42883') {
      console.warn('[auth] SECURITY DEFINER helpers missing — run tools/setup-rls.js; using legacy query');
      return await q1('SELECT * FROM users WHERE lower(code) = lower($1) AND active = 1', [code]);
    }
    throw err;
  }
}

export const router = Router();

router.post('/login', async (req, res) => {
  const { code, password } = req.body || {};
  if (!code || !password) return res.status(400).json({ error: 'Enter your login code and password.' });
  const attempted = String(code).trim().toLowerCase();
  const user = await findUserByCode(attempted);
  // Credentials are verified BEFORE the failure counters are consulted, so a
  // correct password always succeeds — a typo burst can never lock a real
  // salesman out for the full window (see loginThrottle.js). Each wrong
  // attempt records against its budgets; once a cap trips, further failures
  // get a 429 instead of a 401 until the window rolls or a success clears it.
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    noteFailure(attempted, req.ip);
    if (overLimit(attempted, req.ip)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Too many failed sign-in attempts for this code. Please try again in 15 minutes.' });
    }
    return res.status(401).json({ error: 'Login code or password is wrong. Check and try again.' });
  }
  // A successful sign-in proves the code isn't under attack — give it a
  // fresh failure budget so one typo burst can't linger for the full window.
  clearSuccess(attempted, req.ip);
  const token = await createSession(user);
  res.json({ token, user: publicUser(user) });
});

router.post('/logout', async (req, res) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) await destroySession(token);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/password', requireAuth, async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  const user = await q1('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!current || !verifyPassword(String(current), user.password_hash)) {
    return res.status(400).json({ error: 'Current password is wrong.' });
  }
  if (!next || String(next).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  await qx('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(next)), user.id]);
  res.json({ ok: true });
});
