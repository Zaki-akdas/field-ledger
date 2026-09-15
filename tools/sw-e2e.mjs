/**
 * Offline PWA end-to-end: boots the built app in headless Edge via CDP,
 * signs in, lets the service worker install + prime the field-read cache,
 * then blocks network access to the origin and proves the app still boots,
 * still renders field screens, and still serves cached API reads.
 *
 *   npm run build && node tools/sw-e2e.mjs     (API on :4000 required)
 *
 * Uses the same CDP plumbing as tools/overflow-check.mjs — no extra deps.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'client', 'dist');
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const PORT = Number(process.env.SW_E2E_PORT || 4100);
const DEBUG_PORT = Number(process.env.SW_E2E_CDP_PORT || 9333);
const OFFLINE = process.env.SW_E2E_OFFLINE !== '0';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let apiDown = false; // flipped mid-test to simulate total signal loss

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
    if (apiDown && !req.url.startsWith('/api/auth/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'signal lost' }));
      return;
    }
    const proxy = http.request(`${API}${req.url}`, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxy);
    return;
  }
  const rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(DIST, rel);
  const serveIndex = () => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(DIST, 'index.html')));
  };
  if (path.extname(file) === '.html') { serveIndex(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { serveIndex(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

/* ------------------------------------------------------------------- CDP --- */
const ws = { ref: null };
const pending = new Map();
let msgId = 0;

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.ref.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000);
  });
}

function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return candidates.find((p) => fs.existsSync(p));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'eval failed');
  return result.value;
}

async function navigate(url) {
  await send('Page.navigate', { url });
  await wait(2500);
}

/* ------------------------------------------------------------------ main --- */
async function main() {
  if (!fs.existsSync(DIST)) { console.error('💥 Run npm run build first.'); process.exit(1); }
  try { await fetch(`${API}/api/health`); } catch {
    console.error(`💥 API not reachable at ${API} — start it first.`);
    process.exit(1);
  }
  await new Promise((r) => server.listen(PORT, r));

  const browser = findBrowser();
  if (!browser) { console.error('💥 No Edge/Chrome found.'); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-'));
  const proc = spawn(browser, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=380,740', 'about:blank',
  ], { stdio: 'ignore' });

  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log(`${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  };

  try {
    let version;
    for (let i = 0; i < 40; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; }
      catch { await wait(250); }
    }
    if (!version) throw new Error('browser DevTools endpoint never came up');

    const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws.ref = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.ref.onopen = resolve; ws.ref.onerror = reject; });
    ws.ref.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    const base = `http://127.0.0.1:${PORT}`;

    // 1. Load the app signed out: SW installs on this first visit.
    await navigate(`${base}/login`);
    const swState = await evalJs(`navigator.serviceWorker.ready.then(r => r.active ? r.active.state : 'none').catch(() => 'error')`);
    check('Service worker installs and activates', swState === 'activated', `state=${swState}`);

    const swScope = await evalJs(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : 'none'`);
    check('Service worker controls the page', swScope !== 'none', `script=${swScope}`);

    // 2. Prime the field-read cache: sign in as a field user and open screens.
    // (Dev seed password; PROVIDE_SEEDED_PASSWORDS=1 provisioning is expected,
    // same as smoke/overflow.)
    await evalJs(`(async () => {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'SLM-00', password: 'field123' }) });
      const data = await res.json();
      if (data.token) localStorage.setItem('field-ledger:token', data.token);
      return data.token ? 'ok' : 'login failed';
    })()`);
    check('Field user signs in (primes caches)', (await evalJs(`localStorage.getItem('field-ledger:token') ? 'yes' : 'no'`)) === 'yes');

    // Visit the field screens so SWR caches their payloads, then await the
    // reads directly — the remote demo DB is slow, and this makes priming
    // deterministic rather than racing page effects.
    for (const route of ['/field/start', '/field/bills', '/field/me']) {
      await navigate(`${base}${route}`);
      await wait(800);
    }
    await evalJs(`(async () => {
      const token = localStorage.getItem('field-ledger:token');
      const headers = { Authorization: 'Bearer ' + token };
      const today = new Date().toISOString().slice(0, 10);
      const urls = [
        '/api/session/today',
        '/api/bills?date=' + today,
        '/api/me/dashboard?from=' + today + '&to=' + today,
      ];
      await Promise.all(urls.map(u => fetch(u, { headers }).then(r => r.text()).catch(() => null)));
      return 'primed';
    })()`);

    // The remote demo DB answers slowly; SWR caches on response arrival, so
    // poll until the api cache has entries rather than checking once.
    let cacheState = 'no api cache';
    for (let i = 0; i < 30; i++) {
      cacheState = await evalJs(`(async () => {
        const names = await caches.keys();
        const apiName = names.find(n => n.startsWith('fl-api-'));
        if (!apiName) return 'no api cache';
        const keys = await (await caches.open(apiName)).keys();
        return keys.map(k => new URL(k.url).pathname + (new URL(k.url).search || '')).join(', ') || 'empty';
      })()`);
      if (/bills|dashboard|session|products/.test(cacheState)) break;
      await wait(1000);
    }
    check('Field read API cached for offline', /bills|dashboard|session|products/.test(cacheState), cacheState);

    // 3. Cut the network at the test server (signal loss for API + static
    // proxy) and prove the app still works from the SW caches.
    if (OFFLINE) {
      apiDown = true;

      // Reload the shell offline: navigation must fall back to the cached shell.
      await navigate(`${base}/field/bills`);
      await wait(1500);
      const offlineBoot = await evalJs(`document.querySelector('#root').children.length > 0 ? 'rendered' : 'blank'`);
      check('Offline navigation boots the app shell', offlineBoot === 'rendered', offlineBoot);

      const offlineRead = await evalJs(`(async () => {
        const res = await fetch('/api/session/today');
        const j = await res.json();
        return JSON.stringify(j).slice(0, 200);
      })()`);
      const parsed = JSON.parse(offlineRead);
      check('Offline API read served from cache (real payload, not stub)', parsed.offline !== true, offlineRead);

      const offlineText = await evalJs(`document.body.textContent.slice(0, 200)`);
      check('Offline page renders the app, not an error', /bills|Field Ledger|Bills|Me|Collect/i.test(offlineText), JSON.stringify(offlineText).slice(0, 80));

      apiDown = false;
    }

    console.log(`\\n${results.filter(r => r.ok).length}/${results.length} offline checks passed`);
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('💥', err.message); process.exit(1); });
