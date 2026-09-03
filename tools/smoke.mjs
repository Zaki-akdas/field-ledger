/**
 * Headless smoke test: boots the built app in jsdom, signs in as an admin and a
 * salesman, and walks the main screens. Fails on any React error or blank page.
 *
 *   npm run build:smoke && node tools/smoke.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'client', 'dist-smoke');
const API = 'http://127.0.0.1:4000';
const PORT = 4100;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
    const proxy = http.request(`${API}${req.url}`, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    req.pipe(proxy);
    return;
  }
  const rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, rel);
  // jsdom cannot execute type="module"; the smoke bundle is a classic script.
  const serveIndex = () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
      .replace(/<script type="module"/g, '<script defer');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  };
  if (path.extname(file) === '.html') { serveIndex(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { serveIndex(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(`jsdom: ${e.message}`));
vc.on('error', (...a) => errors.push(`console.error: ${a.join(' ')}`));
vc.on('warn', (...a) => {
  const m = a.join(' ');
  if (/Warning:/.test(m)) errors.push(`react: ${m}`);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (dom) => dom.window.document.body.textContent.replace(/\s+/g, ' ').trim();

// The remote Supabase demo DB answers each query in ~100-150ms, so a page that
// runs a dozen sequential queries can take seconds. Poll for the expected
// content instead of betting on a fixed sleep.
async function waitForText(dom, needle, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    const body = text(dom);
    if (body.includes(needle)) return true;
    if (Date.now() - t0 > ms) return false;
    await wait(400);
  }
}

async function boot(pathname = '/') {
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}${pathname}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  // jsdom has no fetch; hand it Node's, resolving relative URLs.
  const base = `http://127.0.0.1:${PORT}`;
  dom.window.fetch = (input, init) => fetch(new URL(String(input), base).href, init);
  if (!dom.window.crypto?.randomUUID) {
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto, configurable: true });
  }
  await wait(1500);
  return dom;
}

async function login(dom, code, password) {
  const doc = dom.window.document;
  const setInput = (el, v) => {
    const proto = el.type === 'password' ? dom.window.HTMLInputElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const inputs = [...doc.querySelectorAll('input')];
  setInput(inputs[0], code);
  setInput(inputs[1], password);
  await wait(120);
  doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  // Reconciliation over a remote database is ~30 sequential queries; be patient.
  await wait(9000);
}

async function click(dom, needle, tag = 'a,button') {
  const all = [...dom.window.document.querySelectorAll(tag)];
  const norm = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const el = all.find((e) => norm(e) === needle.toLowerCase())
    || all.find((e) => norm(e).includes(needle.toLowerCase()));
  if (!el) throw new Error(`Nothing clickable containing "${needle}"`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }));
  await wait(3600);
}

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function run() {
  await new Promise((r) => server.listen(PORT, r));

  /* ---------------------------------------------------------- admin side --- */
  const admin = await boot('/');
  let t = text(admin);
  check('Login screen renders', /Sign in/.test(t) && /Field Ledger/.test(t), t.slice(0, 80));

  await login(admin, 'admin', 'admin123');
  t = text(admin);
  check('Admin lands on reconciliation', /Expected/.test(t) && /Variance/.test(t), t.slice(0, 100));
  check('Hero shows rupee figures', /₹/.test(t));
  check('Salesman-wise table present', /Salesman-wise/.test(t));

  for (const [label, needle] of [
    ['Collection report', 'Grand total'],
    ['Salesmen', 'Billed'],
    ['Bills', 'Invoice'],
    ['Cancellations', 'Reason'],
    ['Shortages', 'Product'],
    ['Cash rollup', 'Denomination'],
    ['Upload bills', 'dispatch sheet'],
  ]) {
    await click(admin, label);
    const ok = await waitForText(admin, needle);
    const body = text(admin);
    check(`Admin → ${label}`, ok, ok ? '' : body.slice(0, 60));
  }

  await click(admin, 'Salesmen');
  const row = [...admin.window.document.querySelectorAll('tbody tr')][0];
  if (row) {
    row.dispatchEvent(new admin.window.MouseEvent('click', { bubbles: true, cancelable: true, view: admin.window }));
    const ok = await waitForText(admin, 'Collection entries');
    check('Admin → salesman drill-down', ok, ok ? '' : text(admin).slice(0, 80));
  }

  /* --------------------------------------------------------- field side --- */
  const field = await boot('/field/start');
  t = text(field);
  check('Field app redirects to login without a token', /Sign in/.test(t), t.slice(0, 60));

  await login(field, 'SLM-01', 'field123');
  t = text(field);
  check('Salesman lands on start day', /Start day|Today’s book|Today's book/.test(t), t.slice(0, 90));
  check('Step rail shows the four steps', /Visit shop/.test(t) && /End day/.test(t));

  await click(field, 'Bills');
  t = text(field);
  check('Field → bills list', /bills|bill/i.test(t), t.slice(0, 80));

  const firstBill = [...field.window.document.querySelectorAll('a[href^="/field/bills/"]')][0];
  if (firstBill) {
    firstBill.dispatchEvent(new field.window.MouseEvent('click', { bubbles: true, cancelable: true, view: field.window }));
    await wait(2800);
    t = text(field);
    check('Field → bill detail', /Expected/.test(t) && /Collected/.test(t), t.slice(0, 80));

    const collect = [...field.window.document.querySelectorAll('button')]
      .find((b) => /Deliver & collect|Collect the balance/.test(b.textContent || ''));
    if (collect) {
      collect.dispatchEvent(new field.window.MouseEvent('click', { bubbles: true, cancelable: true, view: field.window }));
      await wait(2800);
      t = text(field);
      check('Field → collect screen', /How was this paid/.test(t), t.slice(0, 80));
      check('Denomination grid present', /₹500/.test(t) && /Coins/.test(t));

      const fill = [...field.window.document.querySelectorAll('button')].find((b) => /^Fill ₹/.test(b.textContent || ''));
      if (fill) {
        fill.dispatchEvent(new field.window.MouseEvent('click', { bubbles: true, cancelable: true, view: field.window }));
        await wait(400);
        t = text(field);
        check('Fill cash populates the grid', /Save collection/.test(t) && !/Save collection · ₹0/.test(t));
      }
    }
  }

  await click(field, 'Me');
  t = text(field);
  check('Field → my numbers', /Collected/.test(t) && /Variance/.test(t), t.slice(0, 80));
  check('Sign out lives on Me, not in the tab bar', /Sign out/.test(t));

  const tabs = [...field.window.document.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
  check(
    'Bottom nav has exactly three tabs',
    tabs.length === 3 && tabs.join('|') === '/field/bills|/field/collect|/field/me',
    tabs.join('|'),
  );

  await click(field, 'Add bills');
  t = text(field);
  check('Field → add bills', /dispatch sheet|Invoice number/.test(t), t.slice(0, 80));

  await click(field, 'Me');
  await click(field, 'End day');
  t = text(field);
  check('Field → end day', /Today’s reconciliation|Day ended/.test(t), t.slice(0, 80));
  check('End day shows cash to deposit', /Cash to deposit/.test(t));
  check('End-day register with print/export actions', /Day's collection report/i.test(t) && /Print/.test(t) && /Excel/.test(t) && /PDF/.test(t), t.slice(0, 90));

  console.log('\n── Console output');
  if (errors.length === 0) console.log('   (none)');
  for (const e of [...new Set(errors)].slice(0, 15)) console.log('   ' + e.slice(0, 240));

  admin.window.close();
  field.window.close();
}

run()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length || errors.length) process.exit(1);
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 smoke crashed:', err.message);
    for (const e of [...new Set(errors)].slice(0, 10)) console.error('   ' + e.slice(0, 240));
    process.exit(1);
  })
  .finally(() => server.close());
