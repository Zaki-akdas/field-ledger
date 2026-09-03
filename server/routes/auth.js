import { Router } from 'express';
import { q1, qx } from '../db.js';
import { createSession, destroySession, verifyPassword, hashPassword, publicUser, requireAuth } from '../auth.js';

export const router = Router();

router.post('/login', async (req, res) => {
  const { code, password } = req.body || {};
  if (!code || !password) return res.status(400).json({ error: 'Enter your login code and password.' });
  const user = await q1('SELECT * FROM users WHERE lower(code) = lower($1) AND active = 1', [String(code).trim()]);
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Login code or password is wrong. Check and try again.' });
  }
  const token = await createSession(user.id);
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
