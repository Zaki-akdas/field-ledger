/**
 * Concurrency load check — the regression guard for connection-cap bugs.
 *
 * Fires a burst of parallel requests at the reconciliation-heavy endpoints —
 * the workload that used to exhaust Supabase's session cap with
 * EMAXCONNSESSION and hang the API — then asserts every response is a clean
 * HTTP 200 with no connection errors anywhere in the payload, and that the
 * API still answers afterwards.
 *
 *   node tools/loadtest.mjs                    # needs the API on :4000
 *   BASE=http://127.0.0.1:4000/api BURST=40 node tools/loadtest.mjs
 */
const BASE = (process.env.BASE || 'http://127.0.0.1:4000/api').replace(/\/+$/, '');
const BURST = Math.max(4, Number(process.env.BURST || 32));
const CODE = process.env.LOGIN_CODE || 'admin';
const PASSWORD = process.env.LOGIN_PASSWORD || 'admin123';

/* The read-heavy mix that previously pinned a DB session per request and
 * blew through Supabase's 15-session cap. /admin/reconciliation alone runs
 * ~30 sequential queries per salesman. */
const HEAVY = [
  '/admin/reconciliation',
  '/admin/bills',
  '/admin/salesmen',
  '/bills',
  '/me/dashboard',
];

/* Error strings that mean the connection layer gave out — the exact failure
 * this test exists to catch. */
const CONN_ERROR = /EMAXCONNSESSION|max clients|too many clients|remaining connection slots|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection (?:reset|refused|timed out|closed)|terminating connection/i;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`✅ ${label}`); }
  else { fail += 1; failures.push(label); console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function login() {
  try {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: CODE, password: PASSWORD }),
    });
    if (!res.ok) throw new Error(`login failed (${res.status})`);
    return (await res.json()).token;
  } catch (err) {
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(err.message)) {
      throw new Error(`cannot reach the API at ${BASE} — start it first (npm run dev:api)`, { cause: err });
    }
    throw err;
  }
}

async function main() {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };

  // Warm-up so the first-connection cost doesn't colour the burst.
  await Promise.all(HEAVY.map((p) => fetch(`${BASE}${p}`, { headers }).then((r) => r.arrayBuffer())));

  const started = Date.now();
  const jobs = [];
  for (let i = 0; i < BURST; i += 1) {
    const path = HEAVY[i % HEAVY.length];
    const t0 = Date.now();
    jobs.push(
      fetch(`${BASE}${path}`, { headers })
        .then(async (res) => {
          const text = await res.text();
          return { path, status: res.status, ms: Date.now() - t0, body: text.slice(0, 300) };
        })
        .catch((err) => ({ path, status: 0, ms: Date.now() - t0, body: String(err && err.message || err) })),
    );
  }
  const results = await Promise.all(jobs);
  const elapsed = Date.now() - started;

  const non200 = results.filter((r) => r.status !== 200);
  const connErrors = results.filter((r) => CONN_ERROR.test(r.body));
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length / 2)];
  const max = ms[ms.length - 1];

  check(`Burst of ${BURST} parallel requests completes (${elapsed}ms, p50 ${p50}ms, max ${max}ms)`, results.length === BURST);
  check('Every request returns HTTP 200', non200.length === 0,
    non200.length ? non200.slice(0, 3).map((r) => `${r.path} → ${r.status}: ${r.body.slice(0, 90)}`).join(' | ') : '');
  check('No connection-cap errors (EMAXCONNSESSION etc.)', connErrors.length === 0,
    connErrors.length ? connErrors.slice(0, 3).map((r) => `${r.path}: ${r.body.slice(0, 120)}`).join(' | ') : '');

  // The API must still be alive and answering after the burst.
  const sweep = await Promise.all(HEAVY.map((p) => fetch(`${BASE}${p}`, { headers }).then((r) => r.status)));
  check('API healthy after the burst', sweep.every((s) => s === 200), `post-burst: ${sweep.join(',')}`);

  console.log(fail === 0
    ? `\nLOADTEST: ${pass} passed, 0 failed ✅`
    : `\nLOADTEST: ${pass} passed, ${fail} FAILED ❌\n  ${failures.join('\n  ')}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`❌ LOADTEST crashed: ${err.message}`);
  process.exit(1);
});
