import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ACCEPTED = '\\.(xlsx|xls|csv|pdf|jpe?g|png|webp|heic)$';

function fileFilter(_req, file, cb) {
  const ok = new RegExp(ACCEPTED, 'i').test(file.originalname || '');
  if (!ok) return cb(new Error('Unsupported file type. Use Excel, PDF, or a photo.'));
  cb(null, true);
}

/**
 * Spreadsheet batch uploads land in the OS temp dir so ExcelJS / the PDF
 * parser can read them by path, and the route deletes the file after parsing.
 *
 * Never write these into the project directory: serverless hosts (Vercel)
 * mount the bundle read-only, so anything under the repo would fail with
 * EROFS — the OS temp dir (Vercel's /tmp) is the one writable scratch space.
 */
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, `tmp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`);
  },
});

/** Spreadsheet uploads (parsed immediately, temp file deleted by the route). */
export const upload = multer({ storage: diskStorage, fileFilter, limits: { fileSize: 12 * 1024 * 1024 } });

/** Photo uploads stay in memory and are written to attachment storage. */
export const photoUpload = multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: 12 * 1024 * 1024 } });
