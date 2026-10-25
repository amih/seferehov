// What each stage of reading a scan did, for the admin's trace view (/admin/trace):
// the pictures every stage looked at or made, what each model was asked and answered,
// and why each book was kept or dropped. Any code under withTrace() can call step();
// with no trace running, step() costs nothing. Traces live outside the public uploads
// (only admins see them) and are deleted after KEEP_DAYS. TRACE=0 turns them off.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

export const TRACE_DIR = resolve(process.env.TRACE_DIR || join(config.uploadDir, '..', 'scan-trace'));
const KEEP_DAYS = 365;
const IMAGE_SIDE = 1600;
const store = new AsyncLocalStorage();

// Runs fn with a trace named id (a scan id, or photo-<id>); saves trace.json at the end,
// also when fn fails (the error is part of the trace).
export async function withTrace(id, meta, fn) {
  if (process.env.TRACE === '0') return fn();
  const trace = { id, meta, started: new Date().toISOString(), steps: [], n: 0, dir: join(TRACE_DIR, id), files: new Map() };
  await rm(trace.dir, { recursive: true, force: true });
  await mkdir(trace.dir, { recursive: true });
  const t0 = Date.now();
  await save(trace);
  try {
    return await store.run({ trace, path: [] }, fn);
  } catch (err) {
    trace.error = String(err.message);
    throw err;
  } finally {
    trace.ms = Date.now() - t0;
    await save(trace).catch(() => {});
  }
}

// One save at a time per trace (the last one wins), each file swapped in whole.
const save = (trace) => (trace.saving = (trace.saving ?? Promise.resolve()).catch(() => {}).then(() => write(trace)));
const put = async (file, text) => { await writeFile(`${file}.tmp`, text); await rename(`${file}.tmp`, file); };
async function write({ dir, n, files, saving, ...t }) {
  await put(join(dir, 'trace.json'), JSON.stringify(t));
  // The list on /admin/trace reads only this.
  await put(join(dir, 'meta.json'), JSON.stringify({ id: t.id, meta: t.meta, started: t.started, ms: t.ms ?? null, error: t.error ?? null, steps: n }));
}

// Steps inside fn are filed under `label` (a frame, a cut-out, a way up…).
export function scope(label, fn) {
  const s = store.getStore();
  return s ? store.run({ trace: s.trace, path: [...s.path, label] }, fn) : fn();
}

export const tracing = () => !!store.getStore();

// One stage: data (JSON) plus pictures { key: Buffer }; each picture is saved as a
// JPEG (at most `side` px; once, however many steps show it) and its file name put in
// data[key]. Saved as it goes, so a scan that is still running (or crashed) can be
// looked at too.
export async function step(kind, data = {}, images = {}, { side = IMAGE_SIDE } = {}) {
  const s = store.getStore();
  if (!s) return;
  const { trace } = s;
  const i = ++trace.n;
  const out = { i, kind, path: s.path, at: Date.now(), ...data };
  for (const [key, buf] of Object.entries(images)) {
    if (!buf) continue;
    const hash = createHash('sha1').update(buf).digest('hex');
    if (trace.files.has(hash)) { out[key] = trace.files.get(hash); continue; }
    const file = `${i}-${key}.jpg`;
    try {
      await sharp(buf).rotate().resize(side, side, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(join(trace.dir, file));
      out[key] = file;
      trace.files.set(hash, file);
    } catch { /* not a picture */ }
  }
  trace.steps.push(out);
  // Every few seconds, so the page of a scan still being read can follow it.
  if (Date.now() - (trace.savedAt ?? 0) > 3000) { trace.savedAt = Date.now(); save(trace).catch(() => {}); }
}

// A file kept as it is (the original video, re-encoded without its metadata).
export function traceFile(name) {
  const s = store.getStore();
  return s ? join(s.trace.dir, name) : null;
}

export async function purgeTraces() {
  const cut = Date.now() - KEEP_DAYS * 86400_000;
  for (const d of await readdir(TRACE_DIR).catch(() => [])) {
    const p = join(TRACE_DIR, d);
    if ((await stat(p)).mtimeMs < cut) await rm(p, { recursive: true, force: true });
  }
}

// For the admin pages: recent traces (newest first), one trace, one of its files.
export async function listTraces(limit = 100) {
  const dirs = [];
  for (const d of await readdir(TRACE_DIR).catch(() => [])) {
    try { dirs.push({ d, mtime: (await stat(join(TRACE_DIR, d))).mtimeMs }); } catch { /* gone */ }
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { d, mtime } of dirs.slice(0, limit)) {
    try { out.push({ ...JSON.parse(await readFile(join(TRACE_DIR, d, 'meta.json'), 'utf8')), updated: new Date(mtime).toISOString() }); } catch { /* not a trace */ }
  }
  return out;
}

const SAFE = /^[\w-]+$/;
export async function readTrace(id) {
  if (!SAFE.test(id)) return null;
  try { return JSON.parse(await readFile(join(TRACE_DIR, id, 'trace.json'), 'utf8')); } catch { return null; }
}
export const traceFilePath = (id, file) => (SAFE.test(id) && /^[\w.-]+\.(jpg|mp4)$/.test(file) ? join(TRACE_DIR, id, file) : null);
