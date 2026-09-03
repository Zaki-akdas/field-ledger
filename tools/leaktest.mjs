/**
 * Request-transaction leak test — asserts pooled connections never carry RLS
 * context between requests.
 *
 * Each HTTP request runs inside one database transaction whose RLS claims are
 * planted with set_config('request.jwt.claims', …, is_local=true). is_local is
 * what makes the context die with the transaction — if a future change drops
 * it (or plants claims outside BEGIN) the GUC would persist on the backend
 * session after COMMIT/ROLLBACK and leak into whatever query rides that
 * pooled connection next.
 *
 * To make that observable, PGPOOL_MAX is forced to 1 so every request and
 * the probe queries between them reuse the SAME database backend. The test
 * then alternates two actors across many request cycles and asserts the
 * claims GUC is visible only while a request transaction is open, and is
 * gone from the pooled connection after both COMMIT and ROLLBACK.
 *
 * Runs against DATABASE_URL directly — no API server needed. Authoritative
 * against a plain Postgres (CI); against Supabase's transaction-mode pooler
 * the backend reuse guarantee is weaker, but CI covers the deterministic
 * case.
 *
 *   node tools/leaktest.mjs        (reads .env via the npm script)
 */
// Must be set before db.js is imported — the pool reads it at construction.
process.env.PGPOOL_MAX = '1';

const { requestStore, q1, finalizeRequest } = await import('../server/db.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${label}`); } else {
    fail += 1;
    failures.push(label);
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Claims GUC as seen by a query right now (null/'' when no actor). */
const claimsNow = async () => {
  const row = await q1("SELECT current_setting('request.jwt.claims', true) AS c");
  return row ? (row.c ?? null) : null;
};
const expected = (id, role) => JSON.stringify({ sub: String(id), role });
// Clean means no actor: NULL (never set in this session) or '' (the empty
// placeholder default once a custom GUC is known — normal Postgres semantics
// after the is_local value reverts; it carries no user identity).
const clean = (v) => v === null || v === '' || v === undefined;
const describe = (v) => (v === null || v === undefined ? String(v) : JSON.stringify(v));

/**
 * One full request lifecycle: run work inside a request scope (the first
 * query opens the transaction and plants the actor's claims), finalize it
 * (COMMIT, or ROLLBACK when `rollback` simulates an errored response), and
 * report what the claims GUC showed during the request and on the pooled
 * connection afterwards.
 */
async function requestCycle(user, { rollback = false } = {}) {
  const seen = { during: null, after: null };
  await requestStore.run({ user, client: null, begin: null, done: false, rollback }, async () => {
    seen.during = await claimsNow(); // first DB touch: BEGIN + set claims
    await finalizeRequest();
  });
  seen.after = await claimsNow(); // on the same single pooled backend
  return seen;
}

console.log('Pool size forced to 1 — every request and probe query shares one backend.\n');

// Baseline: a fresh pooled connection has no claims.
check('Baseline: no claims on the pooled connection', clean(await claimsNow()));

const ADMIN = { id: 7, role: 'admin' };
const SALES = { id: 3, role: 'salesman' };
const OTHER = { id: 9, role: 'salesman' };

// Alternating requests — the sharpest test for cross-request leakage.
for (let i = 0; i < 6; i += 1) {
  const user = i % 2 === 0 ? ADMIN : SALES;
  const seen = await requestCycle(user);
  check(`Cycle ${i + 1}: claims visible inside the request (${user.role})`, seen.during === expected(user.id, user.role), `got ${describe(seen.during)}`);
  check(`Cycle ${i + 1}: claims gone from the pooled connection after COMMIT`, clean(seen.after), `leaked ${describe(seen.after)}`);
}

// Rollback path — an errored response must leave nothing behind either.
{
  const seen = await requestCycle(OTHER, { rollback: true });
  check('Rollback request: claims visible during the request', seen.during === expected(OTHER.id, OTHER.role), `got ${describe(seen.during)}`);
  check('Rollback request: claims gone from the pooled connection after ROLLBACK', clean(seen.after), `leaked ${describe(seen.after)}`);
}

// And once more, after everything, the shared backend stays clean.
check('Final: no claims remain on the pooled connection', clean(await claimsNow()));

console.log(fail === 0
  ? `\nLEAK TEST: ${pass} passed, 0 failed ✅`
  : `\nLEAK TEST: ${pass} passed, ${fail} FAILED ❌ — ${failures.join('; ')}`);
process.exit(fail === 0 ? 0 : 1);