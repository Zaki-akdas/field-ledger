/**
 * Windowed sign-in failure tracker.
 *
 * Unlike pure middleware throttling, the login route verifies credentials
 * BEFORE consulting these counters, so a correct password always succeeds —
 * a typo burst can never lock a real salesman out for the full window. Each
 * failed attempt is recorded against three keys with different caps:
 *   • per code per IP   (max 15) — a typo'd password at one desk
 *   • per code, all IPs (max 60) — distributed guessing of one account
 *   • per IP, all codes (max 200) — spraying many codes from one network
 * A successful sign-in clears the code's own keys, giving it a fresh budget.
 * In-memory per process (like the previous limiter); Vercel's ephemeral
 * instances reset counters on cold start, which is acceptable for this role.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX = { codeIp: 15, code: 60, ip: 200 };

const store = new Map(); // key -> number[] (timestamps within the window)
const keyCodeIp = (code, ip) => `codeIp:${code}:${ip}`;
const keyCode = (code) => `code:${code}`;
const keyIp = (ip) => `ip:${ip}`;

function push(key, now) {
  const cut = now - WINDOW_MS;
  const list = (store.get(key) || []).filter((t) => t > cut);
  list.push(now);
  store.set(key, list);
}

function count(key, now) {
  const cut = now - WINDOW_MS;
  const list = (store.get(key) || []).filter((t) => t > cut);
  if (list.length) store.set(key, list);
  else store.delete(key);
  return list.length;
}

/** Record one failed sign-in (code is already lower-cased/trimmed). */
export function noteFailure(code, ip, now = Date.now()) {
  push(keyCodeIp(code, ip), now);
  push(keyCode(code), now);
  push(keyIp(ip), now);
}

/** Which cap is exceeded right now: 'code', 'ip', or null when under all. */
export function overLimit(code, ip, now = Date.now()) {
  if (count(keyCode(code), now) >= MAX.code || count(keyCodeIp(code, ip), now) >= MAX.codeIp) return 'code';
  if (count(keyIp(ip), now) >= MAX.ip) return 'ip';
  return null;
}

/** A successful sign-in proves the code isn't under attack — reset its budget. */
export function clearSuccess(code, ip) {
  store.delete(keyCodeIp(code, ip));
  store.delete(keyCode(code));
}
