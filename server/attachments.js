import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/**
 * The offline queue carries photos as compressed data URLs; when the entry
 * finally syncs we materialise it next to the normally-uploaded files.
 */
export function saveDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  const [, mime, b64] = m;
  const ext = EXT_BY_MIME[mime.toLowerCase()] || '.bin';
  if (!ext || ext === '.bin') return null;
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(b64, 'base64'));
  return name;
}
