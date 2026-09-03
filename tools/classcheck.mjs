/**
 * Guards against the failure mode you cannot see without a browser: a
 * mistyped Tailwind class (especially a responsive variant like
 * "md:table-cell") silently compiles to nothing, and a column you meant to
 * hide on phones stays visible.
 *
 *   npm run build && node tools/classcheck.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const cssFile = fs.readdirSync(path.join(ROOT, 'client', 'dist', 'assets'))
  .find((f) => f.endsWith('.css'));
const css = fs.readFileSync(path.join(ROOT, 'client', 'dist', 'assets', cssFile), 'utf8');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx') || p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'client', 'src'));
const missing = new Map();

const escapeClass = (c) => `.${c.replace(/([.:[\]/%!#(),+*~>='"&])/g, '\\$1')}`;

const TOKEN = /^[a-z0-9:[\]./._%()+,'!#&-]+$/;   // Tailwind utilities are lowercase
const SINGLE_WORD = new Set([
  'flex', 'grid', 'hidden', 'block', 'inline', 'table', 'truncate', 'relative', 'absolute',
  'fixed', 'sticky', 'static', 'italic', 'underline', 'uppercase', 'lowercase', 'capitalize',
  'antialiased', 'container', 'num', 'panel', 'label', 'input', 'table-dense', 'safe-bottom',
  'no-scrollbar', 'snap-x-scroll', 'resize-none', 'shrink', 'grow', 'border', 'rounded',
]);
const looksLikeClass = (t) => t.includes('-') || t.includes(':') || SINGLE_WORD.has(t);

/** Pulls class strings out of className="..." and balanced cx(...) calls. */
function extractClassStrings(src) {
  const out = [];
  for (const m of src.matchAll(/className\s*=\s*"([^"]*)"/g)) out.push(m[1]);
  let idx = 0;
  while ((idx = src.indexOf('cx(', idx)) !== -1) {
    let depth = 1;
    let i = idx + 3;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
      i += 1;
    }
    for (const m of src.slice(idx, i).matchAll(/["'`]([^"'`\n]*)["'`]/g)) out.push(m[1]);
    idx = i;
  }
  return out;
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const raw of extractClassStrings(src)) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    if (!tokens.every((t) => TOKEN.test(t) && looksLikeClass(t))) continue;
    if (tokens.some((t) => t.includes('${'))) continue;

    for (const cls of tokens) {
      if (!css.includes(escapeClass(cls))) {
        const rel = path.relative(ROOT, file);
        if (!missing.has(cls)) missing.set(cls, new Set());
        missing.get(cls).add(rel);
      }
    }
  }
}

// Classes defined in index.css under @layer components/utilities, or applied
// through parent selectors — not a problem.
const KNOWN_CUSTOM = new Set([
  'panel', 'label', 'input', 'input-mono', 'num', 'table-dense', 'safe-bottom',
  'no-scrollbar', 'snap-x-scroll', 'divide-line', 'divide-y', 'divide-x',
]);

const real = [...missing.entries()].filter(([cls]) => !KNOWN_CUSTOM.has(cls));

if (real.length === 0) {
  console.log(`✅ all classes in ${files.length} source files exist in the built CSS`);
} else {
  console.log(`⚠️  ${real.length} class(es) not found in the built CSS:`);
  for (const [cls, where] of real) {
    console.log(`   ${cls.padEnd(34)} ${[...where].join(', ')}`);
  }
}

// Explicitly assert the responsive hiding rules survived compilation.
const required = [
  '.md\\:table-cell', '.lg\\:table-cell', '.xl\\:table-cell', '.sm\\:table-cell',
  '.sm\\:border-b-0', '.sm\\:border-r', '.sm\\:grid-cols-4', '.sm\\:text-\\[34px\\]',
  '.text-\\[30px\\]', '.w-full', '.flex-1',
];
const absent = required.filter((r) => !css.includes(r));
console.log(absent.length ? `❌ missing responsive rules: ${absent.join(', ')}` : '✅ responsive column-hiding rules compiled');
process.exit(absent.length ? 1 : 0);
