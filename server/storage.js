/**
 * Attachment storage — bills' invoice photos and collection screenshots.
 *
 * Where files live depends on the host:
 *
 *   - Supabase Storage (serverless / production): set SUPABASE_URL and
 *     SUPABASE_SERVICE_ROLE_KEY. Files go to a private bucket; the app
 *     streams them back through GET /uploads/:file, so attachment names in
 *     the database stay opaque and nothing is exposed publicly.
 *   - Local disk (dev, tests, VPS): when the keys are absent we keep the
 *     original behaviour — files land in server/uploads/.
 *
 * The database stores only the object/file name either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'field-ledger';
const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** True when Supabase Storage is configured; otherwise we use local disk. */
export const storageRemote = Boolean(URL && SERVICE_KEY);

const client = storageRemote
  ? createClient(URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'application/pdf': '.pdf', 'image/heic': '.heic',
};

const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));

function safeName(ext) {
  const e = String(ext || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${e || '.bin'}`;
}

/* ------------------------------------------------------------------ init --- */

let bucketReady = null;

/** Idempotent bucket creation — the service key bypasses storage policies. */
function ensureBucket() {
  if (!client) return Promise.resolve();
  if (bucketReady) return bucketReady;
  bucketReady = client.storage.createBucket(BUCKET, { public: false })
    .then(() => {
      console.log(`[storage] Bucket "${BUCKET}" ready in Supabase Storage`);
    })
    .catch((err) => {
      // Already exists, or this environment cannot create buckets (local Supabase
      // CLI sometimes needs manual creation). Uploads will surface the real error.
      console.warn(`[storage] Bucket ensure skipped: ${err.message}`);
    });
  return bucketReady;
}

/* --------------------------------------------------------------- writes --- */

/**
 * Store a file. Returns the storage object name (also the value kept in the
 * bills.attachment / collections.attachment columns), or null on failure.
 */
export async function saveFile({ data, contentType, ext }) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  const name = safeName(ext || EXT_BY_MIME[(contentType || '').toLowerCase()]);
  if (client) {
    await ensureBucket();
    const { error } = await client.storage.from(BUCKET).upload(name, data, {
      contentType: contentType || 'application/octet-stream',
      upsert: false,
    });
    if (error) {
      console.error('[storage] upload failed:', error.message);
      return null;
    }
    return name;
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, name), data);
  return name;
}

/**
 * The offline queue carries photos as compressed data URLs; when the entry
 * finally syncs we materialise it into storage. Returns the name or null.
 */
export async function saveDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  const [, mime, b64] = m;
  const ext = EXT_BY_MIME[mime.toLowerCase()];
  if (!ext) return null; // refuse anything we can't label (e.g. .bin)
  return saveFile({ data: Buffer.from(b64, 'base64'), contentType: mime, ext });
}

/** Remove a stored file (used by tests and any future delete flow). */
export async function deleteFile(name) {
  if (!name) return;
  if (client) {
    await client.storage.from(BUCKET).remove([name]);
    return;
  }
  await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(name))).catch(() => {});
}

/* ------------------------------------------------------------- signing --- */

const SIGN_TTL_SECONDS = Number(process.env.UPLOAD_SIGN_TTL || 60 * 60); // 1 hour default

/**
 * The signing secret for attachment URLs. Never committed: it is derived
 * from secrets already present in the environment, and can be pinned with
 * UPLOAD_SIGN_SECRET in production (multi-instance hosts need a stable
 * value so a URL signed by one instance verifies on another).
 */
function signingSecret() {
  if (process.env.UPLOAD_SIGN_SECRET) return String(process.env.UPLOAD_SIGN_SECRET);
  const base = [process.env.DATABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .filter(Boolean)
    .join('|');
  // Never a constant when only the public DB URL is known; hash what we have.
  return crypto.createHash('sha256').update(base || String(Date.now())).digest('hex');
}

/** Build a short-lived URL like /uploads/<name>?expires=…&sig=… */
export function signedUploadUrl(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.includes('..')) return null;
  const expires = Math.floor(Date.now() / 1000) + SIGN_TTL_SECONDS;
  const sig = crypto
    .createHmac('sha256', signingSecret())
    .update(`${base}.${expires}`)
    .digest('hex');
  return `/uploads/${encodeURIComponent(base)}?expires=${expires}&sig=${sig}`;
}

/**
 * Verify a signed /uploads request. Returns the file name when the signature
 * is valid and unexpired, else null (→ 403).
 */
export function verifySignedUpload(name, expires, sig) {
  const base = path.basename(String(name || ''));
  const exp = Number(expires);
  if (!base || !Number.isFinite(exp) || !sig || base.includes('..')) return null;
  // Reject an unbounded future expiry (nothing past ~14 days verifies, so a
  // leaked URL cannot be parked open-endedly even with a valid signature).
  if (exp < Math.floor(Date.now() / 1000) - 60 || exp > Math.floor(Date.now() / 1000) + 14 * 24 * 3600) return null;
  const expect = crypto
    .createHmac('sha256', signingSecret())
    .update(`${base}.${exp}`)
    .digest('hex');
  // Constant-time compare — the signature is the only gate here.
  const a = Buffer.from(expect);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? base : null;
}

/* ---------------------------------------------------------------- reads --- */

/**
 * Fetch a stored file. Returns { data, contentType } or null.
 * Local mode reads from disk; remote mode downloads via the service key.
 */
export async function readFile(name) {
  const base = path.basename(String(name || ''));
  if (!base) return null;
  if (client) {
    const { data, error } = await client.storage.from(BUCKET).download(base);
    if (error || !data) {
      if (error) console.error('[storage] download failed:', error.message);
      return null;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    return { data: buf, contentType: data.type || MIME_BY_EXT[path.extname(base).toLowerCase()] || 'application/octet-stream' };
  }
  const file = path.join(UPLOAD_DIR, base);
  if (!fs.existsSync(file)) return null;
  return {
    data: fs.readFileSync(file),
    contentType: MIME_BY_EXT[path.extname(base).toLowerCase()] || 'application/octet-stream',
  };
}
