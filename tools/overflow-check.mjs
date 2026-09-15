/**
 * Layout regression check: renders every route in a real headless browser
 * (Edge/Chrome via the DevTools protocol — no extra npm deps) at a 320px
 * mobile viewport and fails when the document scrolls horizontally or any
 * element pokes outside the viewport without living in an intentional
 * overflow-x scroll container.
 *
 * jsdom can't do this: it has no layout engine, so getBoundingClientRect is
 * always zeros. This check exists because a -mx-4 chip bleed once widened
 * the whole document by 4px and nothing caught it.
 *
 *   npm run test:overflow          (needs the dev API on :4000, like smoke)
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
const PORT = Number(process.env.OVERFLOW_PORT || 4100);
const DEBUG_PORT = Number(process.env.OVERFLOW_CDP_PORT || 9333);
const VW = Number(process.env.OVERFLOW_WIDTH || 320);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };

/* --------------------------------------------------------- static server --- */
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
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
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace(/<script type="module"/g, '<script defer');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  };
  if (path.extname(file) !== '.html' && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
    return;
  }
  serveIndex();
});

/* ------------------------------------------------------------- find browser */
function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error(`💥 No Edge/Chrome found. Set BROWSER_PATH to your browser executable.`);
    process.exit(1);
  }
  return found;
}

/* -------------------------------------------------------------------- CDP --- */
let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }
    }, 20000);
  });
}

// Edge occasionally drops one CDP command mid-session (seen right after a
// sign-out/navigation churn); a single retry has been enough every time.
async function sendWithRetry(method, params = {}) {
  try { return await send(method, params); }
  catch (e) {
    if (!/timed out/.test(e.message)) throw e;
    console.log(`   (retrying ${method} after a CDP stall)`);
    return send(method, params);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(expression) {
  const r = await sendWithRetry('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const txt = d.exception?.description || d.exception?.value || d.text || 'unknown';
    throw new Error(`page eval failed: ${String(txt).slice(0, 300)}`);
  }
  return r.result.value;
}

async function navigate(url, settleMs = 2500) {
  log('nav', url);
  await sendWithRetry('Page.navigate', { url });
  await wait(settleMs); // React mounts, then fetches book data over the network
  log('nav done', url);
}
const VERBOSE = process.env.OVERFLOW_VERBOSE === '1';
const log = (...a) => { if (VERBOSE) console.log('[check]', ...a); };

/* The probe: document-level horizontal scroll, plus any element outside the
   viewport that doesn't sit inside an intentional overflow-x scroll container
   (chips strips, tab rails — those scroll by design). */
const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const docOver = document.documentElement.scrollWidth - vw;
  const inScroller = (el) => {
    // A full-bleed strip is itself the intentional scroll container (it uses
    // -mx-4 to reach the screen edges), so count the element too — not just
    // its ancestors.
    for (let p = el; p; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const offenders = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) {
      offenders.push(el.tagName + '.' + (el.getAttribute('class') || '').slice(0, 60)
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    }
  });
  return { vw, docOver, count: offenders.length, offenders: offenders.slice(0, 5) };
})()`;

function loginScript(code, password) {
  return `(() => {
  const inputs = [...document.querySelectorAll('input')];
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  if (inputs.length < 2) return false;
  set(inputs[0], ${JSON.stringify(code)});
  set(inputs[1], ${JSON.stringify(password)});
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`;
}

/* ------------------------------------------------------------ routes to walk */
const ADMIN_ROUTES = (
  process.env.OVERFLOW_ADMIN || '/admin,/admin/collection,/admin/salesmen,/admin/shops,/admin/bills,/admin/cancellations,/admin/shortages,/admin/cash,/admin/upload,/admin/bank,/admin/trash,/admin/audit'
)
  .split(',')
  .map((s) => s.trim())
  // normalize: Git Bash's MSYS layer rewrites "/admin"-style env values into
  // Windows paths (C:/Program Files/Git/admin), so accept with or without slash
  .map((s) => (s.startsWith('/') ? s : `/${s.replace(/^[A-Za-z]:.*(\/admin.*)$/, '$1')}`))
  .filter(Boolean);
const FIELD_ROUTES = ['/field/start', '/field/bills', '/field/collect', '/field/upload', '/field/me', '/field/end'];
const PUBLIC_ROUTES = ['/login'];

/* --------------------------------------------------------------------- run */
async function run() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('💥 client/dist/index.html missing — run `npm run build` first (the verify chain does).');
    process.exit(1);
  }
  let health;
  try { health = await fetch(`${API}/api/health`); } catch { /* handled below */ }
  if (!health?.ok) {
    console.error(`💥 Dev API not reachable at ${API} — start it first (node --env-file=.env server/index.js).`);
    process.exit(1);
  }

  await new Promise((r) => server.listen(PORT, r));

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-check-'));
  const proc = spawn(browser, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=360,740', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    // Wait for the DevTools endpoint
    let version;
    for (let i = 0; i < 40; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; }
      catch { await wait(250); }
    }
    if (!version) throw new Error('browser DevTools endpoint never came up');

    const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: VW, height: 740, deviceScaleFactor: 2, mobile: true });

    const base = `http://127.0.0.1:${PORT}`;
    const results = [];

    const probeRoute = async (label, url) => {
      process.stdout.write(`… ${label} `);
      try {
        await navigate(base + url);
        var p = await evalJs(PROBE);
      } catch {
        // One retry of the whole probe — Edge occasionally stalls a CDP command
        // right after a heavy page (trash/audit churn sessions); a fresh attempt
        // has succeeded every time so far.
        await wait(1000);
        await navigate(base + url, 3500);
        p = await evalJs(PROBE);
      }
      const ok = p.docOver <= 0 && p.count === 0;
      results.push({ label, ok, p });
      console.log(ok ? '✅' : `❌ — doc +${p.docOver}px`);
      for (const o of p.offenders) console.log(`      ${o}`);
    };

    /* public */
    await navigate(base + '/login');
    for (const r of PUBLIC_ROUTES) await probeRoute('public ' + r, r);

    /* admin */
    await navigate(base + '/login', 800);
    log('login admin');
    await evalJs(loginScript(process.env.LOGIN_CODE || 'admin', process.env.LOGIN_PASSWORD || 'admin123'));
    await wait(3500); // sign-in round-trip, then redirect to /admin
    log('admin routes', ADMIN_ROUTES.length);
    for (const r of ADMIN_ROUTES) await probeRoute('admin ' + r, r);

    /* salesman */
    // Clear the admin session by revisiting the app origin first — localStorage
    // is off-limits on about:blank (SecurityError) and mid-redirect pages.
    await navigate(base + '/login', 1200);
    await evalJs(`try { localStorage.clear(); } catch {} 'ok'`);
    await navigate(base + '/login', 800);
    log('login salesman');
    await evalJs(loginScript(process.env.FIELD_CODE || 'SLM-00', process.env.FIELD_PASSWORD || 'field123'));
    await wait(3500);
    log('field routes');
    for (const r of FIELD_ROUTES) await probeRoute('field ' + r, r);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} routes clean at ${VW}px`);
    if (failed.length) {
      console.log('\nFix the offenders above: they widen the document or escape the viewport.');
      console.log('Elements inside overflow-x-auto strips are allowed — those scroll by design.');
      process.exitCode = 1;
    }
  } finally {
    try { await send('Browser.close'); } catch { /* may already be gone */ }
    try { proc.kill(); } catch { /* ditto */ }
    await wait(300);
    // Edge can hold the profile dir briefly after exit; a leftover temp dir is
    // harmless, so don't let cleanup failure fail the run.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    server.close();
  }
}

run().catch((err) => {
  console.error('💥 overflow-check crashed:', err.message);
  process.exitCode = 1;
  try { server.close(); } catch { /* noop */ }
});
