// Free-style capture, the server's half. The phone (web/src/capture.js) sends each photo
// of a camera session as it is taken: POST /api/captures (one photo, its number in the
// session, ms since the camera opened, and what the phone measured: barcodes it saw,
// how it moved). When the camera closes it says how many photos it took
// (POST /api/captures/:id/end). Once a session's photos are all here (or nothing came
// for a while: the phone may have died before saying "end"), they are sorted
// (pairing.js) and become the usual scans: one shelf scan per run of shelf photos, one
// cover scan per book (front and back, or only one side). The books then wait in the
// reader's queue, as before. Photos arriving after their session was sorted are sorted
// on their own later.
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';
import { locationByCode, visibleTo, distanceTo, createLocation } from './locations.js';
import { ownerOf } from './mybooks.js';
import { parseLatLon } from './util.js';
import { MEDIA_DIR, wake } from './scans.js';
import { sortShots } from './pairing.js';
import { withTrace } from './trace.js';
import { guessSituation, SURE } from './situation.js';
import { autoConfirmKnown, closeIfDone } from './approvals.js';
import { absorbOsmTwin } from './duplicates.js';

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/i;
const dirOf = (id) => join(MEDIA_DIR, `capture-${id}`);

export default async function captureRoutes(app) {
  app.post('/api/captures', { preHandler: requireUser(), config: { rateLimit: { max: 600, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart_required' });
    const fields = {};
    let tmp = null;
    try {
      for await (const part of req.parts({ limits: { files: 1, fileSize: MAX_PHOTO_BYTES } })) {
        if (part.type !== 'file') { fields[part.fieldname] = part.value; continue; }
        if (part.fieldname !== 'photo' || !UUID.test(fields.session ?? '')) { part.file.resume(); continue; }
        await mkdir(dirOf(fields.session), { recursive: true });
        tmp = join(dirOf(fields.session), `upload-${crypto.randomUUID()}.img`);
        await pipeline(part.file, createWriteStream(tmp));
        if (part.file.truncated) throw Object.assign(new Error('too_large'), { statusCode: 413 });
      }
    } catch (err) {
      if (tmp) await rm(tmp, { force: true });
      const status = err.statusCode === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400;
      return reply.code(status).send({ error: status === 413 ? 'too_large' : 'bad_upload' });
    }
    const seq = Number(fields.seq);
    if (!tmp || !Number.isInteger(seq) || seq < 0 || seq > 10_000) {
      if (tmp) await rm(tmp, { force: true });
      return reply.code(400).send({ error: 'no_media' });
    }
    const session = await openSession(req.user, fields.session, fields);
    if (!session) { await rm(tmp, { force: true }); return reply.code(404).send({ error: 'not_found' }); }
    await keepHints(session, fields.hints);
    const path = `${seq}.img`;
    await copyFile(tmp, join(dirOf(session.id), path));
    await rm(tmp, { force: true });
    let meta = {};
    try { meta = JSON.parse(fields.meta ?? '{}'); } catch {}
    await q(`INSERT INTO capture_shots (session_id, seq, taken_ms, meta, path) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_id, seq) DO NOTHING`, [session.id, seq, Number.isFinite(Number(fields.at)) ? Math.round(Number(fields.at)) : null, meta, path]);
    // A photo for a session already sorted: it is sorted on its own, later.
    await q(`UPDATE capture_sessions SET last_shot_at = now(), status = CASE WHEN status = 'done' THEN 'open' ELSE status END WHERE id = $1`, [session.id]);
    return { capture: { session: session.id, seq } };
  });

  // The camera closed: n photos were taken in this session. It may arrive before the
  // photos (outbox order), so it carries the session's settings too.
  app.post('/api/captures/:id/end', { preHandler: requireUser() }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_request' });
    const fields = {};
    if (req.isMultipart()) for await (const part of req.parts()) { if (part.type === 'file') part.file.resume(); else fields[part.fieldname] = part.value; }
    else Object.assign(fields, req.body ?? {});
    const session = await openSession(req.user, req.params.id, fields);
    if (!session) return reply.code(404).send({ error: 'not_found' });
    await keepHints(session, fields.hints);
    const n = Number(fields.n);
    await q(`UPDATE capture_sessions SET ended_at = now(), expected = $2 WHERE id = $1`, [session.id, Number.isInteger(n) && n >= 0 ? n : null]);
    soon();
    return { ok: true };
  });

  // Where were these photos taken: the reader's answer from the queue's card.
  app.post('/api/captures/:id/situation', { preHandler: requireUser(), config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_request' });
    const r = await answerSituation(req.user, req.params.id, req.body ?? {});
    if (r.error) return reply.code(r.status).send({ error: r.error, location: r.location });
    return r;
  });
}

// What the phone measured (web/src/hints.js), for guessing where the photos were taken: only
// for sessions opened from the map, and only the fields the guess uses.
const HINT_KEYS = { lat: 'n', lon: 'n', acc: 'n', nearHome: 'b', net: 's', exp: 'n', ct: 'n', hour: 'n', dow: 'n', light: 'n' };
export function cleanHints(raw) {
  let h;
  try { h = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!h || typeof h !== 'object') return null;
  const out = {};
  for (const [k, type] of Object.entries(HINT_KEYS)) {
    const v = h[k];
    if (type === 'n' && Number.isFinite(v)) out[k] = v;
    else if (type === 'b' && typeof v === 'boolean') out[k] = v;
    else if (type === 's' && typeof v === 'string') out[k] = v.slice(0, 20);
  }
  if (!(Math.abs(out.lat) <= 90 && Math.abs(out.lon) <= 180)) { delete out.lat; delete out.lon; delete out.acc; }
  return Object.keys(out).length ? out : null;
}
async function keepHints(session, raw) {
  if (!session.guessed || !raw) return;
  const h = cleanHints(raw);
  if (h) await q(`UPDATE capture_sessions SET hints = coalesce(hints, '{}'::jsonb) || $2 WHERE id = $1`, [session.id, h]);
}

// The session, created by its first photo with the library (or My books) and its settings.
// From the map (guess=1, no library): nowhere yet; the server guesses when it sorts the photos.
async function openSession(user, id, f) {
  const old = await one('SELECT * FROM capture_sessions WHERE id = $1', [id]);
  if (old) return old.user_id === user.id ? old : null;
  if (f.guess === '1' && !f.code) {
    return one(
      `INSERT INTO capture_sessions (id, user_id, kind, lang, guessed) VALUES ($1, $2, 'seen', $3, true)
       ON CONFLICT (id) DO UPDATE SET last_shot_at = now() RETURNING *`, [id, user.id, f.lang === 'en' ? 'en' : 'he']);
  }
  let loc = null;
  if (f.code) {
    loc = await locationByCode(String(f.code));
    if (!visibleTo(loc, user) || loc.status === 'removed') return null;
  }
  const { owner, friendName } = loc ? { owner: null, friendName: null } : ownerOf(f);
  const distance = loc ? await distanceTo(loc.id, parseLatLon(f.lat, f.lon)) : null;
  return one(
    `INSERT INTO capture_sessions (id, user_id, location_id, kind, lang, owner, friend_name, distance_m)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO UPDATE SET last_shot_at = now() RETURNING *`,
    [id, user.id, loc?.id ?? null, f.kind === 'added' ? 'added' : 'seen', f.lang === 'en' ? 'en' : 'he', owner, friendName, distance]);
}

// ---------------------------------------------------------------------------
// Sorting: one session at a time, when it is complete (all photos the phone said it
// took are here), or quiet: 3 minutes without "end" (the page died), 30 minutes with an
// "end" but photos missing (still in a phone's outbox, offline).
const READY_SQL = `
  SELECT s.* FROM capture_sessions s
   WHERE s.status = 'open' AND (s.retry_after IS NULL OR s.retry_after < now()) AND (
         (s.ended_at IS NOT NULL AND s.last_shot_at < now() - interval '5 seconds'
           AND (SELECT count(*) FROM capture_shots c WHERE c.session_id = s.id) >= coalesce(s.expected, 0))
      OR (s.ended_at IS NULL AND s.last_shot_at < now() - interval '3 minutes')
      OR s.last_shot_at < now() - interval '30 minutes')
   ORDER BY s.last_shot_at LIMIT 1`;

const RETRY_FOR_MS = 2 * 24 * 3600_000;
let busy = false, log = console, timer = null;
export function startCaptureWorker(logger) {
  log = logger;
  q(`UPDATE capture_sessions SET status = 'open' WHERE status = 'sorting'`).catch(() => {});
  setInterval(run, 30_000).unref();
}
function soon() { clearTimeout(timer); timer = setTimeout(run, 6_000); }

async function run() {
  if (busy) return;
  busy = true;
  try {
    for (let s; (s = await one(`UPDATE capture_sessions SET status = 'sorting' WHERE id = (${READY_SQL.replace('SELECT s.*', 'SELECT s.id')}) RETURNING *`));) {
      await sortSession(s).catch(async (err) => {
        // The model was out of reach (the graphics card busy for hours with a long job): the photos are kept and the
        // session is sorted again in 5 minutes, for up to 2 days. Before 25 Nov 2026 it failed at once, and a new
        // reader's first photos never reached the approval queue.
        if (err.modelUnavailable && Date.now() - new Date(s.created_at).getTime() < RETRY_FOR_MS) {
          log.warn({ err, session: s.id, tries: s.tries + 1 }, 'capture sort: model out of reach, trying again in 5 minutes');
          await q(`UPDATE capture_sessions SET status = 'open', tries = tries + 1, retry_after = now() + interval '5 minutes', error = $2 WHERE id = $1`,
            [s.id, String(err.message).slice(0, 300)]);
          return;
        }
        log.error({ err, session: s.id }, 'capture sort failed');
        await q(`UPDATE capture_sessions SET status = 'failed', error = $2 WHERE id = $1`, [s.id, String(err.message).slice(0, 300)]);
      });
    }
  } catch (err) {
    log.error({ err }, 'capture worker');
  } finally {
    busy = false;
  }
}

async function sortSession(s) {
  const rows = await many(`SELECT * FROM capture_shots WHERE session_id = $1 AND sorted_at IS NULL ORDER BY seq`, [s.id]);
  const dir = dirOf(s.id);
  const shots = [];
  for (const r of rows) shots.push({ seq: r.seq, meta: r.meta, row: r, buf: await readFile(join(dir, r.path)).catch(() => null) });
  const ok = shots.filter((x) => x.buf);
  const traceId = `capture-${s.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const result = ok.length ? await withTrace(traceId, { capture: s.id, user_id: s.user_id, location_id: s.location_id, shots: ok.length, created_at: s.created_at },
    () => sortShots(ok, { log: (x) => log.debug?.({ capture: s.id, ...x }, 'capture sort') })) : { shelves: [], books: [], other: [], info: [] };

  // From the map: where were they taken? Guessed once, on the session's first shelf photo.
  if (s.guessed && !s.guess && ok.length) {
    const first = ok[result.shelves[0]?.[0] ?? 0].buf;
    const g = await guessSituation(s.hints ?? {}, first);
    Object.assign(s, placeOf(g.kind, g.location, s.hints), { guess: g });
    await q(`UPDATE capture_sessions SET guess = $2, location_id = $3, owner = $4, friend_name = NULL, distance_m = $5 WHERE id = $1`,
      [s.id, g, s.location_id, s.owner, s.distance_m]);
    log.info({ capture: s.id, guess: g.kind, confidence: g.confidence, vision: g.vision }, 'capture situation guessed');
  }
  const situation = !s.guessed || s.answered_at ? null : s.guess?.confidence >= SURE ? 'sure' : 'ask';
  const scanOf = new Map();
  const newScan = async (source, media, files, bookCode = null) => {
    const id = crypto.randomUUID();
    await mkdir(join(MEDIA_DIR, id), { recursive: true });
    for (const [name, i] of files) await copyFile(join(dir, ok[i].row.path), join(MEDIA_DIR, id, name));
    await q(
      `INSERT INTO scans(id, location_id, user_id, kind, media, distance_m, lang, source, book_code, owner, friend_name, capture_id, situation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, s.location_id, s.user_id, s.kind, JSON.stringify(media), s.distance_m, s.lang, source, bookCode, s.owner, s.friend_name, s.id, situation]);
    for (const [, i] of files) scanOf.set(i, id);
    return id;
  };
  for (const shelf of result.shelves) {
    await newScan('photo', shelf.map((_, n) => ({ path: `${n}.img`, type: 'image' })), shelf.map((i, n) => [`${n}.img`, i]));
  }
  for (const b of result.books) {
    const files = [], media = [];
    const add = (name, i, type = 'image') => { files.push([name, i]); media.push({ path: name, type }); };
    if (b.front.length) add('0.img', b.front[0]);
    if (b.back.length) add('1.img', b.back[0]);
    b.front.slice(1, 3).forEach((i, n) => add(`x-front-${n + 2}.img`, i, 'extra'));
    b.back.slice(1, 3).forEach((i, n) => add(`x-back-${n + 2}.img`, i, 'extra'));
    // A barcode the phone saw while this book's photos were taken.
    const live = [...b.front, ...b.back].flatMap((i) => ok[i].meta?.codes ?? []).find((c) => typeof c === 'string');
    await newScan('cover', media.sort((x, y) => x.path.localeCompare(y.path)), files, live ? String(live).slice(0, 20) : null);
  }
  for (const [i, x] of ok.entries()) {
    const kind = result.info[i]?.kind ?? null;
    await q(`UPDATE capture_shots SET kind = $3, scan_id = $4, sorted_at = now() WHERE session_id = $1 AND seq = $2`, [s.id, x.seq, kind, scanOf.get(i) ?? null]);
  }
  for (const x of shots.filter((y) => !y.buf)) await q(`UPDATE capture_shots SET kind = 'missing', sorted_at = now() WHERE session_id = $1 AND seq = $2`, [s.id, x.seq]);
  for (const x of shots) await rm(join(dir, x.row.path), { force: true });
  const summary = { trace: traceId, shelves: result.shelves.map((r) => r.map((i) => ok[i].seq)),
    books: result.books.map((b) => ({ front: b.front.map((i) => ok[i].seq), back: b.back.map((i) => ok[i].seq), codes: b.codes })), other: result.other.map((i) => ok[i].seq) };
  // Photos that came while this was being sorted: the session opens again for them.
  await q(`UPDATE capture_sessions SET status = CASE WHEN EXISTS (SELECT 1 FROM capture_shots c WHERE c.session_id = $1 AND c.sorted_at IS NULL) THEN 'open' ELSE 'done' END,
             result = coalesce(result, '[]'::jsonb) || jsonb_build_array($2::jsonb), sorted_at = now() WHERE id = $1`, [s.id, summary]);
  wake();
  log.info({ capture: s.id, ...summary }, 'capture sorted');
}

// Where a session's books go for a situation: { location_id, owner, friend_name, distance_m }.
function placeOf(kind, location, hints, friendName = null) {
  if (kind === 'library' && location) {
    return { location_id: location.id, owner: null, friend_name: null, distance_m: Number.isFinite(location.m) ? location.m : null };
  }
  if (kind === 'home' || kind === 'friend') return { location_id: null, owner: kind === 'home' ? 'mine' : 'friend', friend_name: kind === 'friend' ? friendName : null, distance_m: null };
  return { location_id: null, owner: null, friend_name: null, distance_m: null }; // a new library: not yet created
}

// The reader's answer to "where were these taken?" (the queue's card), or the guess accepted
// (answer.kind 'right', also when the reader approves a book of a sure guess). Moves every scan of
// the session there; a new library is created now (with the usual review). Changing it is refused
// once a book of the session was approved somewhere.
export async function answerSituation(user, sessionId, answer) {
  const s = await one('SELECT * FROM capture_sessions WHERE id = $1 AND user_id = $2 AND guessed', [sessionId, user.id]);
  if (!s) return { error: 'not_found', status: 404 };
  let kind = answer?.kind, place;
  if (kind === 'right') {
    if (s.answered_at) return { ok: true };
    kind = s.guess?.kind;
    if (kind === 'new_library') return { error: 'answer_required', status: 422 };
    place = { location_id: s.location_id, owner: s.owner, friend_name: s.friend_name, distance_m: s.distance_m };
  } else if (kind === 'library') {
    const loc = await locationByCode(String(answer.code ?? ''));
    if (!visibleTo(loc, user) || loc.status === 'removed') return { error: 'not_found', status: 404 };
    const pos = parseLatLon(answer.lat ?? s.hints?.lat, answer.lon ?? s.hints?.lon);
    place = { location_id: loc.id, owner: null, friend_name: null, distance_m: await distanceTo(loc.id, pos) };
  } else if (kind === 'new_library') {
    const pos = parseLatLon(answer.lat ?? s.hints?.lat, answer.lon ?? s.hints?.lon);
    if (!pos) return { error: 'location_required', status: 422 };
    const loc = await createLocation(user, pos, { name: answer.name });
    if (loc.error) return { ...loc, status: 409 };
    place = { location_id: loc.id, owner: null, friend_name: null, distance_m: 0 };
  } else if (kind === 'home' || kind === 'friend') {
    place = placeOf(kind, null, null, kind === 'friend' ? String(answer.friend_name ?? '').trim().slice(0, 80) || null : null);
  } else return { error: 'bad_request', status: 400 };
  const moved = place.location_id !== s.location_id || place.owner !== s.owner || place.friend_name !== s.friend_name;
  if (moved && await one(`SELECT 1 FROM scan_items i JOIN scans x ON x.id = i.scan_id WHERE x.capture_id = $1 AND i.decision = 'approved' LIMIT 1`, [s.id])) {
    return { error: 'already_approved', status: 409 };
  }
  // At home or a friend's: the server keeps no coordinates of the place.
  const hints = kind === 'home' || kind === 'friend' ? Object.fromEntries(Object.entries(s.hints ?? {}).filter(([k]) => !['lat', 'lon', 'acc'].includes(k))) : s.hints;
  await q(`UPDATE capture_sessions SET location_id = $2, owner = $3, friend_name = $4, distance_m = $5, answer = $6, answered_at = now(), hints = $7 WHERE id = $1`,
    [s.id, place.location_id, place.owner, place.friend_name, place.distance_m, { kind: answer.kind, final: kind, at: new Date().toISOString() }, hints]);
  const scans = await many(
    `UPDATE scans SET location_id = $2, owner = $3, friend_name = $4, distance_m = $5, situation = NULL WHERE capture_id = $1 RETURNING *`,
    [s.id, place.location_id, place.owner, place.friend_name, place.distance_m]);
  // What waited for the place: books already on that library's shelf are confirmed.
  for (const scan of scans.filter((x) => x.status === 'done')) {
    await autoConfirmKnown(scan).catch((err) => log.warn({ err, scan: scan.id }, 'auto confirm'));
    await closeIfDone(scan.id);
  }
  if (place.location_id) await absorbOsmTwin(place.location_id).catch(() => null);
  return { ok: true, kind, code: place.location_id ? (await one('SELECT code FROM locations WHERE id = $1', [place.location_id]))?.code : null };
}
