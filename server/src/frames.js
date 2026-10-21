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

// 64-bit difference hash; near-identical frames differ in only a few bits.
async function dhash(buf) {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return h;
}
const hamming = (a, b) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

// Turns a short video into the few still frames worth reading: samples FPS frames
// a second, keeps the sharpest per WINDOW_S, drops near-duplicates and blurry
// leftovers, and caps the count. Returns [{buffer, t}] in time order.
export async function pickFrames(videoPath) {
  const dir = await mkdtemp(join(tmpdir(), 'seferehov-frames-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-t', String(MAX_SECONDS), '-i', videoPath,
      '-vf', `fps=${FPS},scale='min(1600,iw)':-2`, '-q:v', '3', join(dir, '%04d.jpg')], { timeout: 180_000 });
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    const frames = [];
    for (const [i, f] of files.entries()) {
      const buffer = await readFile(join(dir, f));
      frames.push({ buffer, t: i / FPS, score: await sharpness(buffer), hash: await dhash(buffer) });
    }
    if (!frames.length) return [];

    // why: what became of each sampled frame (for the trace).
    for (const fr of frames) fr.why = 'not the sharpest in its window';
    const best = new Map();
    for (const fr of frames) {
      const w = Math.floor(fr.t / WINDOW_S);
      if (!best.has(w) || fr.score > best.get(w).score) best.set(w, fr);
    }
    let picks = [...best.values()].sort((a, b) => a.t - b.t);
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
        frames: frames.map((fr, i) => ({ t: fr.t, sharpness: Math.round(fr.score), why: fr.why, thumb: `f${i}` })),
      }, thumbs);
    }
    return picks.map(({ buffer, t }) => ({ buffer, t }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
