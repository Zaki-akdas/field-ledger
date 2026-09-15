// One-off probe: boot the built app in jsdom, log in as admin, log every fetch
// (url, status, ms), then dump the body text. Answers "why does the
// reconciliation page never render in the smoke test".
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
vc.on('warn', (...a) => errors.push(`console.warn: ${a.join(' ')}`));
vc.on('log', (...a) => console.log('  [page]', ...a));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (dom) => dom.window.document.body.textContent.replace(/\s+/g, ' ').trim();

async function boot(pathname = '/') {
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}${pathname}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const base = `http://127.0.0.1:${PORT}`;
  const orig = dom.window.fetch || ((u, i) => fetch(new URL(String(u), base).href, i));
  dom.window.fetch = async (input, init) => {
    const url = new URL(String(input), base).href;
    const t0 = Date.now();
    try {
      const res = await orig(new URL(String(input), base).href, init);
      console.log(`  fetch ${res.status} ${Date.now() - t0}ms ${url.slice(base.length)}`);
      return res;
    } catch (e) {
      console.log(`  fetch ERR ${Date.now() - t0}ms ${url.slice(base.length)} :: ${e.message}`);
      throw e;
    }
  };
  if (!dom.window.crypto?.randomUUID) {
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto, configurable: true });
  }
  await wait(1500);
  return dom;
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const dom = await boot('/');
  const doc = dom.window.document;

  const setInput = (el, v) => {
    const proto = dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const inputs = [...doc.querySelectorAll('input')];
  setInput(inputs[0], 'admin');
  setInput(inputs[1], 'admin123');
  await wait(120);
  doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  console.log('── waiting for reconciliation page (max 45s)…');
  const t0 = Date.now();
  for (;;) {
    const t = text(dom);
    if (t.includes('Variance') && /₹/.test(t)) { console.log(`rendered after ${Date.now() - t0}ms`); break; }
    if (Date.now() - t0 > 45000) { console.log('TIMEOUT — body was:', t.slice(0, 300)); break; }
    await wait(500);
  }

  console.log('── errors captured:', errors.length);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ', e.slice(0, 300));
  dom.window.close();
  server.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
