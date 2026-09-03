import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`);
  },
});

function fileFilter(_req, file, cb) {
  const ok = /\.(xlsx|xls|csv|pdf|jpe?g|png|webp|heic)$/i.test(file.originalname || '');
  if (!ok) return cb(new Error('Unsupported file type. Use Excel, PDF, or a photo.'));
  cb(null, true);
}

export const upload = multer({ storage, fileFilter, limits: { fileSize: 12 * 1024 * 1024 } });
