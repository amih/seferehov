import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { step, tracing } from './trace.js';

const run = promisify(execFile);

const FPS = 3;            // frames sampled per second of video
const WINDOW_S = 1.5;     // keep the sharpest frame in each window
const MAX_SECONDS = 60;
export const MAX_FRAMES = 8;

// Sharpness = variance of the Laplacian (blurry frames score low).
async function sharpness(buf) {
  const { channels } = await sharp(buf).greyscale().resize(480, null, { withoutEnlargement: true })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .stats();
  return channels[0].stdev ** 2;
}

// A small grey copy, to see how much the picture moved from one frame to the next.
const tiny = (buf) => sharp(buf).greyscale().resize(160, 90, { fit: 'fill' }).raw().toBuffer();
const moved = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// 64-bit difference hash; near-identical frames differ in only a few bits.
async function dhash(buf) {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return h;
}
const hamming = (a, b) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

// Turns a short video into the few still frames worth reading: samples FPS frames a
// second, keeps the steadiest per WINDOW_S, drops near-duplicates and blurry leftovers,
// and caps the count. Returns [{buffer, t}] in time order. Sharpness alone mostly says
// how many spines are in view, not whether the camera was moving (measured on a real
// shelf video), so each window takes the frame that moved least from its neighbours
// among its sharper ones; a reader who stops for a second gives the best frames.
export async function pickFrames(videoPath) {
  const dir = await mkdtemp(join(tmpdir(), 'seferehov-frames-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-t', String(MAX_SECONDS), '-i', videoPath,
      '-vf', `fps=${FPS},scale='min(2400,iw)':-2`, '-q:v', '2', join(dir, '%04d.jpg')], { timeout: 180_000 });
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    const frames = [];
    for (const [i, f] of files.entries()) {
      const buffer = await readFile(join(dir, f));
      frames.push({ buffer, t: i / FPS, score: await sharpness(buffer), hash: await dhash(buffer), small: await tiny(buffer) });
    }
    if (!frames.length) return [];
    // Motion: the larger change to the frame before or after.
    frames.forEach((fr, i) => {
      const near = [frames[i - 1], frames[i + 1]].filter(Boolean);
      fr.motion = near.length ? Math.max(...near.map((o) => moved(fr.small, o.small))) : 0;
    });

    // why: what became of each sampled frame (for the trace).
    for (const fr of frames) fr.why = 'a steadier or sharper frame in its window';
    const windows = new Map();
    for (const fr of frames) {
      const w = Math.floor(fr.t / WINDOW_S);
      if (!windows.has(w)) windows.set(w, []);
      windows.get(w).push(fr);
    }
    let picks = [...windows.values()].map((list) => {
      const top = Math.max(...list.map((fr) => fr.score));
      return list.filter((fr) => fr.score >= top * 0.85).sort((a, b) => a.motion - b.motion)[0];
    }).sort((a, b) => a.t - b.t);
    picks = picks.filter((fr, i) => i === 0 || hamming(fr.hash, picks[i - 1].hash) > 5 || !(fr.why = 'same view as the frame before'));
    const median = [...picks].sort((a, b) => a.score - b.score)[Math.floor(picks.length / 2)].score;
    picks = picks.filter((fr) => fr.score >= median * 0.35 || !(fr.why = 'blurry'));
    if (picks.length > MAX_FRAMES) {
      const every = picks.length / MAX_FRAMES;
      const kept = new Set(Array.from({ length: MAX_FRAMES }, (_, i) => picks[Math.floor(i * every)]));
      for (const fr of picks) if (!kept.has(fr)) fr.why = `over the limit of ${MAX_FRAMES}`;
      picks = [...kept];
    }
    for (const fr of picks) fr.why = 'picked';
    if (tracing()) {
      const thumbs = {};
      for (const [i, fr] of frames.entries()) thumbs[`f${i}`] = await sharp(fr.buffer).resize(320).jpeg({ quality: 70 }).toBuffer();
      await step('frames', {
        fps: FPS, window_s: WINDOW_S, median_sharpness: median,
        frames: frames.map((fr, i) => ({ t: fr.t, sharpness: Math.round(fr.score), motion: Math.round(fr.motion), why: fr.why, thumb: `f${i}` })),
      }, thumbs);
    }
    return picks.map(({ buffer, t }) => ({ buffer, t }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
