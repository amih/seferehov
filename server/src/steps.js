import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { one } from './db.js';
import { requireUser } from './auth.js';
import { readTrace, traceFilePath } from './trace.js';
import { normTitle, titleSimilarity } from './vision.js';

// "How this was read" on the approval screen: the steps of the scan's trace that made this
// one book — the photo as it arrived, the boxes the model drew, the photo turned for a
// lean, the cut-out, each way up it was read (model and OCR), the final cut and the
// catalogue lookup — with the picture each step looked at or made. Only the reader who
// scanned it (or an admin) sees them.

const KINDS_TOP = new Set(['image', 'barcodes', 'detect']);

// Items read before trace_at was kept: the cut-out whose reading gave this title (the
// queue's title may have been spell-checked since, so alike is enough), else the whole-image read.
function guessAt(steps, title) {
  if (!normTitle(title ?? '')) return null;
  const like = (x) => (x ? titleSimilarity(normTitle(x), normTitle(title)) : 0);
  let best = null, top = 0.75;
  for (const s of steps) {
    if (s.kind !== 'crop-read' || s.verdict !== 'kept') continue;
    const sc = Math.max(like(s.looking_for), ...(s.tries ?? []).filter((x) => x.angle === s.angle).map((x) => like(x.read?.title)));
    if (sc > top) { top = sc; best = s; }
  }
  if (best) return best.path;
  const whole = steps.find((s) => s.kind === 'whole-read' && s.books?.some((b) => like(b.title) > 0.75));
  return whole?.path ?? null;
}

export function itemSteps(trace, { source, title, trace_at: at0 }) {
  const steps = trace.steps ?? [];
  if (source === 'cover') return { at: null, guessed: false, steps };
  const at = at0?.length ? at0 : guessAt(steps, title);
  if (!at?.length) return { at: null, guessed: !at0, steps: [] };
  const photo = at[0];
  const inside = (s) => s.path?.length >= at.length && at.every((l, k) => s.path[k] === l);
  const top = steps.filter((s) => s.path?.length === 1 && s.path[0] === photo);
  const out = top.filter((s) => KINDS_TOP.has(s.kind));
  // The detect step's model answer (boxes) sits just before it.
  const above = (st) => st.path?.length > 1 && st.path.length < at.length && st.path.every((l, k) => at[k] === l);
  const cutOut = steps.find((s) => (inside(s) || above(s)) && s.kind === 'cut-out');
  const group = cutOut?.from?.match(/^lean group (\d+)/)?.[1];
  if (group) {
    const lean = top.filter((s) => s.kind === 'lean-group')[group - 1];
    if (lean) out.push(lean);
  }
  if (at.length === 1) out.push(...top.filter((s) => s.kind === 'whole-read'));
  else {
    // A spine read from a band of a larger cut-out: the cut-out's own steps come first.
    out.push(...steps.filter((st) => inside(st) || above(st)));
  }
  // The catalogue lookup and the verdict for this title.
  const want = normTitle(title ?? '');
  out.push(...steps.filter((s) => s.kind === 'match' && titleSimilarity(normTitle(s.read ?? ''), want) > 0.75).slice(-1));
  out.sort((a, b) => a.i - b.i);
  return { at, guessed: !at0?.length, steps: out };
}

async function itemFor(req, reply) {
  const item = await one(
    `SELECT i.id, i.title, i.trace_at, s.id AS scan_id, s.source, s.user_id
       FROM scan_items i JOIN scans s ON s.id = i.scan_id WHERE i.id = $1`, [Number(req.params.id) || 0]);
  if (!item || (item.user_id !== req.user.id && req.user.trust_level < 3)) { reply.code(404).send({ error: 'not_found' }); return null; }
  return item;
}

export default async function stepRoutes(app) {
  app.get('/api/queue/:id/steps', { preHandler: requireUser() }, async (req, reply) => {
    const item = await itemFor(req, reply);
    if (!item) return reply;
    const trace = await readTrace(item.scan_id);
    if (!trace) return { steps: [], gone: true };
    return { ...itemSteps(trace, item), files: `/api/queue/${item.id}/steps/` };
  });
  app.get('/api/queue/:id/steps/:file', { preHandler: requireUser() }, async (req, reply) => {
    const item = await itemFor(req, reply);
    if (!item) return reply;
    const path = traceFilePath(item.scan_id, req.params.file);
    if (!path?.endsWith('.jpg') || !await stat(path).catch(() => null)) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(createReadStream(path));
  });
}
