import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ACCEPTED = '\\.(xlsx|xls|csv|pdf|jpe?g|png|webp|heic)$';

function fileFilter(_req, file, cb) {
  const ok = new RegExp(ACCEPTED, 'i').test(file.originalname || '');
  if (!ok) return cb(new Error('Unsupported file type. Use Excel, PDF, or a photo.'));
  cb(null, true);
}

/**
 * Spreadsheet batch uploads stay on disk so ExcelJS can read them by path;
 * the route removes the temp file after parsing.
 */
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, `tmp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`);
  },
});

/** Spreadsheet uploads (parsed immediately, temp file deleted by the route). */
export const upload = multer({ storage: diskStorage, fileFilter, limits: { fileSize: 12 * 1024 * 1024 } });

/** Photo uploads stay in memory and are written to attachment storage. */
export const photoUpload = multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: 12 * 1024 * 1024 } });
