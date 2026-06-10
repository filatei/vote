import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { config } from '../config';

// Ensure the upload directory exists at startup.
fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

// Only allow safe raster image types. NB: SVG is intentionally excluded — it
// can carry scripts and would be an XSS vector when served from our origin.
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = ALLOWED[file.mimetype] ?? '.bin';
    cb(null, `${randomBytes(16).toString('hex')}${ext}`);
  },
});

export const uploadContestantImage = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(null, false); // silently drop; route treats "no file" as no change
  },
}).single('image');

/** Absolute path to a stored upload, given its public basename. */
export function uploadPath(filename: string): string {
  return path.join(config.UPLOAD_DIR, filename);
}
