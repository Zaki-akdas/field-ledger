// Throwaway probe: can we spawn Edge/Chrome headless with CDP on this machine?
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';

const candidates = process.platform === 'win32' ? [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
] : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

for (const c of candidates) console.log(fs.existsSync(c) ? 'FOUND ' + c : 'no    ' + c);

const browser = process.env.BROWSER_PATH || candidates.find((p) => fs.existsSync(p));
if (!browser) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(os.tmpdir() + '/oc-probe-');
console.log('spawning:', browser);
const proc = spawn(browser, [
  '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=360,740', 'about:blank',
], { stdio: 'ignore' });

proc.on('error', (e) => { console.log('spawn error:', e.message); process.exit(1); });
proc.on('exit', (code) => console.log('proc exit:', code));

const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  try {
    const v = await (await fetch('http://127.0.0.1:9333/json/version')).json();
    console.log('CDP OK after', Date.now() - t0, 'ms:', v.Browser);
    proc.kill();
    setTimeout(() => process.exit(0), 400);
    break;
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (Date.now() - t0 > 14000) { console.log('CDP never came up'); proc.kill(); process.exit(1); }
