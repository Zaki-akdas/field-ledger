/**
 * Outage drill for GET /api/status — proves the endpoint degrades the way the
 * header comment promises instead of just taking its word for it.
 *
 * Boots the REAL Express app (server/app.js imported as-is) against a
 * deliberately broken database, in two failure modes:
 *
 *   1. refused — nothing listens on the target port (connection refused)
 *   2. hang    — a TCP blackhole: accepts, never replies, so the pg pool must
 *                hit connectionTimeoutMillis and give up rather than hang
 *
 * In each mode it fires a cold-cache concurrent burst and asserts, from
 * OUTSIDE the process:
 *
 *   - every request answers HTTP 503 (never a hang, never a 500)
 *   - every answer arrives within the pool connect timeout + slack
 *   - pool connection attempts stay bounded (single-flight refresh)
 *   - cached follow-ups inside the TTL are 503 and sub-50ms
 *   - /api/health keeps answering during the outage
 *
 *   node tools/status-drill.mjs              # both modes
 *   FAIL_MODE=hang node tools/status-drill.mjs
 */
import net from 'node:net';
import http from 'node:http';
import { pool } from '../server/db.js';
import { app } from '../server/app.js';
import { resetStatusCacheForTests } from '../server/status.js';
// Keep in sync with server/status.js FAIL_BACKOFF_MS — the drill waits it
// out to prove recovery is detected within the promised window.
const FAIL_BACKOFF_MS = 60_000;

const BURST = 10;
const CONNECT_TIMEOUT_MS = Number(pool.options?.connectionTimeoutMillis) || 20000;
const SLACK_MS = 5000;
const CACHE_TTL_MS = 30_000;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: cond });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET /api/status, timed, resolving even on error. */
function hit(port, path = '/api/status', timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* non-JSON body */ }
        resolve({ code: res.statusCode, ms: Date.now() - started, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    req.on('error', (err) => resolve({ code: 0, ms: Date.now() - started, error: err.message }));
  });
}

/** TCP server that accepts and then ignores everything (mode 2). Counts
 * accepted sockets — the concrete measure of how many connection attempts
 * the app actually made (pool 'connect' only fires on SUCCESS, so it can't
 * count failed attempts). */
function blackhole() {
  return new Promise((resolve) => {
    let accepted = 0;
    const server = net.createServer(() => { accepted++; });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, accepted: () => accepted }));
  });
}

/** Boot the real app on an OS-assigned port; resolve once listening. */
function bootApp() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

/** Repoint the (already-constructed) pool at another URL. pg clients read
 * pool.options.connectionString per new connection, so mutating it (plus the
 * host/port pre-parsed copies) takes effect for every future connect. */
function repointPool(url) {
  pool.options.connectionString = url;
  const m = /@([^:/]+):(\d+)\//.exec(url);
  if (m) {
    pool.options.host = m[1];
    pool.options.port = Number(m[2]);
  }
  resetStatusCacheForTests();
}

/** Wait for all pending pool activity (connects, timeouts) to settle. */
async function quiesce() {
  await sleep(Math.min(CONNECT_TIMEOUT_MS + 2000, 22_000));
  pool.removeAllListeners('connect');
  pool.removeAllListeners('acquire');
}

let blackholeAccepted = null;
let lastFailAt = 0; // when the last mode's burst recorded its DB failure

async function runMode(mode) {
  console.log(`\n── mode: ${mode} ─────────────────────────────────────────`);

  if (mode === 'refused') {
    repointPool('postgresql://drill:nopass@127.0.0.1:9/no-such-db');
    console.log('  target: 127.0.0.1:9 (nothing listens — ECONNREFUSED)');
  } else {
    const bh = await blackhole();
    blackholeAccepted = bh.accepted;
    repointPool(`postgresql://drill:nopass@127.0.0.1:${bh.port}/blackhole`);
    console.log(`  target: 127.0.0.1:${bh.port} (TCP blackhole — accepts, never replies)`);
  }

  const server = await bootApp();
  const port = server.address().port;

  let poolEvents = 0;
  const onEvent = () => { poolEvents++; };
  pool.on('connect', onEvent);
  pool.on('acquire', onEvent);

  // Cold cache + fully concurrent burst: every request misses together.
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: BURST }, () => hit(port)));
  const wall = Date.now() - t0;

  check('all burst requests answered (no hang)', burst.every((r) => r.code > 0),
    `${burst.filter((r) => r.code > 0).length}/${BURST} in ${wall}ms wall`);
  check('all burst responses are 503', burst.every((r) => r.code === 503),
    `codes: ${[...new Set(burst.map((r) => r.code))].join(',')}`);
  check('db check failed inside the payload', burst.every((r) => r.body?.checks?.database?.ok === false),
    String(burst[0]?.body?.checks?.database?.error || '').slice(0, 80));
  check('burst never outlives the connect timeout', wall < CONNECT_TIMEOUT_MS + SLACK_MS,
    `${wall}ms (limit ~${CONNECT_TIMEOUT_MS + SLACK_MS}ms)`);
  check('pool connection attempts bounded (single-flight)', poolEvents <= BURST,
    `${poolEvents} connect/acquire events across a ${BURST}-request burst`);

  // Cached follow-ups inside the TTL window.
  const cached = await Promise.all([hit(port), hit(port), hit(port)]);
  check('cached hits within TTL still 503', cached.every((r) => r.code === 503),
    `codes: ${cached.map((r) => r.code).join(',')}`);
  check('cached hits are fast (<50ms)', cached.every((r) => r.ms < 50),
    `slowest ${Math.max(...cached.map((r) => r.ms))}ms`);

  lastFailAt = Date.now(); // snapshot (and its recorded failure) completed here

  // ── Short-circuit: the TTL expires DURING the outage ──
  // Wait out the 30 s cache window FROM THE BURST END (the burst itself
  // may have consumed much of it — 20 s of 30 in hang mode), then hit
  // again. The check failed well within the 60 s backoff, so the endpoint
  // must replay that failure instantly (cached: true) instead of re-paying
  // the full connect timeout. In hang mode this also proves no new TCP
  // connection is attempted.
  const acceptedBefore = blackholeAccepted ? blackholeAccepted() : null;
  const lapseStart = Date.now();
  const cacheSetAt = t0 + wall;
  await sleep(Math.max(CACHE_TTL_MS - (Date.now() - cacheSetAt) + 2000, 2000));
  const afterLapse = await hit(port);
  const lapseWait = Date.now() - lapseStart;
  check('hit after TTL lapse during outage is 503', afterLapse.code === 503, `HTTP ${afterLapse.code}`);
  check('hit after TTL lapse is instant (short-circuit)', afterLapse.ms < 2000,
    `${afterLapse.ms}ms (would be ~${CONNECT_TIMEOUT_MS}ms without the short-circuit; incl. ${lapseWait}ms TTL wait)`);
  check('short-circuited check flagged cached:true',
    Object.values(afterLapse.body?.checks || {}).some((c) => c?.cached === true),
    JSON.stringify(Object.fromEntries(Object.entries(afterLapse.body?.checks || {}).map(([k, v]) => [k, v.cached === true]))));
  if (mode === 'hang') {
    const acceptedAfter = blackholeAccepted();
    check('short-circuit opened no new connection', acceptedAfter === acceptedBefore,
      `${acceptedAfter - acceptedBefore} new TCP connections after TTL lapse`);
  }
  const stillDown = await hit(port);
  check('follow-up hit after short-circuit still 503 (cache updated)', stillDown.code === 503, `HTTP ${stillDown.code} in ${stillDown.ms}ms`);

  const health = await hit(port, '/api/health', 15_000);
  check('/api/health still answers during outage', health.code === 200, `HTTP ${health.code}`);

  server.close();
  await quiesce();
  if (mode === 'hang') {
    // The real single-flight proof: N concurrent requests must produce a
    // handful of connection attempts (one refresh + recovery probes), not
    // one attempt per request.
    const attempts = blackholeAccepted ? blackholeAccepted() : -1;
    check('connection attempts ≪ request count (single-flight)', attempts >= 1 && attempts <= 4,
      `${attempts} TCP connections accepted for a ${BURST}-request burst`);
  }
}

const origUrl = process.env.DATABASE_URL;
const modes = process.env.FAIL_MODE ? [process.env.FAIL_MODE] : ['refused', 'hang'];
for (const mode of modes) await runMode(mode);

// ── Recovery: repoint at the good DB and expect green again ──
console.log('\n── recovery ──────────────────────────────────────────────');
repointPool(origUrl);
const server = await bootApp();
const port = server.address().port;
// Recovery blindness bound: the failure memory expires FAIL_BACKOFF_MS after
// the last probe (here: the short-circuit hit in the last mode). Waiting it
// out proves the endpoint does NOT replay a stale failure forever — it must
// go green within the promised window, not stick at 503 until restart.
console.log(`  waiting out the ${FAIL_BACKOFF_MS / 1000}s failure backoff…`);
// Measured from when the last failure was RECORDED (the burst), not drill
// start — replayed failures don't refresh the memory, so this is the true
// recovery bound.
await sleep(Math.max(FAIL_BACKOFF_MS - (Date.now() - lastFailAt) + 2000, 2000));
await hit(port); // first probe after backoff expiry — re-tests the real DB, may be slow once
const ok = await hit(port);
check('status is 200 again after the outage', ok.code === 200, `HTTP ${ok.code} in ${ok.ms}ms`);
check('all three checks ok after recovery',
  ['database', 'storage', 'backup'].every((k) => ok.body?.checks?.[k]?.ok === true),
  Object.entries(ok.body?.checks || {}).map(([k, v]) => `${k}=${v.ok}`).join(' '));
server.close();

await pool.end().catch(() => {});
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} drill checks passed`);
process.exit(failed.length ? 1 : 0);
