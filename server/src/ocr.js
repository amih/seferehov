// The text printed on cover photos, read one photo at a time in the background, for the
// public book pages. The vision model is shared with the shelf scans, so this waits
// while any scan is queued or being read, and lets a fresh photo be cropped first.
// Clean Latin-script reads are shown at once; Hebrew reads (rough) and anything that
// looks like a model loop wait for an admin on /admin.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { one, q } from './db.js';
import { readCoverText } from './vision.js';

let log = console;
let busy = false;

// A model stuck in a loop repeats lines; a real cover hardly ever does.
export function looksLooped(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 8);
  if (lines.length < 4) return false;
  return new Set(lines).size / lines.length < 0.7;
}

async function next() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const waiting = await one(`SELECT 1 FROM scans WHERE status IN ('queued', 'processing') LIMIT 1`);
      if (waiting) return;
      const p = await one(
        `SELECT id, path FROM photos
          WHERE ocr_at IS NULL AND kind IN ('cover', 'back')
            AND (cropped_at IS NOT NULL OR created_at < now() - interval '1 hour')
          ORDER BY created_at DESC LIMIT 1`);
      if (!p) return;
      let r;
      try {
        r = await readCoverText(await readFile(join(config.uploadDir, p.path)));
      } catch (err) {
        // The model may be down or busy: this photo is tried again next round.
        if (err.code !== 'ENOENT') { log.warn({ err, photo: p.id }, 'cover text failed'); return; }
        r = { text: '' };
      }
      const text = r.text.slice(0, 8000);
      const status = text.length < 3 ? 'rejected' : r.hebrew || looksLooped(text) ? 'review' : 'auto';
      await q('UPDATE photos SET ocr_text = $2, ocr_status = $3, ocr_at = now() WHERE id = $1', [p.id, text || null, status]);
    }
  } finally {
    busy = false;
  }
}

export function startOcrWorker(logger) {
  log = logger;
  setInterval(() => next().catch((err) => log.error({ err }, 'ocr worker')), 90_000).unref();
}
