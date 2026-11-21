// Where were these photos taken? The one camera on the map (docs/ONE_CAMERA_PLAN.md, 21 Nov 2026)
// asks the reader nothing first; the phone sends what it measured (web/src/hints.js) and the
// server guesses: at home (the reader's books), at a known public library, or at a new one.
// The reader checks the guess in the approval queue; every answer is a label for tuning this.
//
// The weights are set by hand for now. Each hint adds points to "home" or "outside":
//   - a known library within 30 m (or the GPS's own accuracy): outside +2.5; within 80 m: +1;
//   - the phone is near a place the reader confirmed as home before: home +3 (not near: −1);
//   - Wi-Fi: home +1.5; mobile data: outside +1;
//   - GPS accurate to 12 m or better: outside +1; worse than 40 m: home +1; no fix: home +0.5;
//   - light: a short exposure (1/400 s or less) is daylight: outside +1.5; 1/50 s or longer: home +1;
//     without the exposure, the colour of the light: bluer than 5,200 K outside +0.5, warmer than 3,800 K home +0.5;
//   - evenings, nights, Friday evening and Saturday: home +0.5;
//   - the vision model on the first shelf photo: a street book box or public bookcase: outside +2.5;
//     a bookcase in a room: home +2.5.
// The chance of home is the logistic of (home − outside). Outside means the nearest known library
// when one is within 80 m, else a new library. A new library is never sure (the reader confirms it
// before it is created), nor is a library with another one within 40 m of it.
import sharp from 'sharp';
import { many } from './db.js';
import { generate } from './vision.js';

export const SURE = 75; // like the books: 🟢 75+, 🟡 45–74, 🔴 under 45
const NEAR_M = 30, CLOSE_M = 80, LOOK_M = 300;

const logistic = (x) => 1 / (1 + Math.exp(-x));

// hints: { lat, lon, acc, nearHome, net, exp, ct, hour, dow }; libraries: nearest first,
// [{ id, code, name, m }]; vision: 'box' | 'home' | 'hand' | 'other' | null.
export function scoreSituation(hints = {}, libraries = [], vision = null) {
  let home = 0, out = 0;
  const why = [];
  const add = (side, pts, k, v) => { if (side === 'home') home += pts; else out += pts; why.push(v == null ? { k, side } : { k, v, side }); };
  const h = hints ?? {};
  const lib = libraries[0] ?? null;
  const acc = Number.isFinite(h.acc) ? h.acc : null;
  if (lib) {
    if (lib.m <= Math.max(NEAR_M, Math.min(acc ?? 0, CLOSE_M))) add('out', 2.5, 'near_lib', lib.m);
    else if (lib.m <= CLOSE_M) add('out', 1, 'near_lib', lib.m);
  } else if (Number.isFinite(h.lat)) why.push({ k: 'far_lib', v: LOOK_M, side: 'home' });
  if (h.nearHome === true) add('home', 3, 'near_home');
  else if (h.nearHome === false) add('out', 1, 'not_home');
  if (h.net === 'wifi' || h.net === 'ethernet') add('home', 1.5, 'wifi');
  else if (h.net === 'cellular') add('out', 1, 'cellular');
  if (acc != null && acc <= 12) add('out', 1, 'gps_good', Math.round(acc));
  else if (acc != null && acc > 40) add('home', 1, 'gps_weak', Math.round(acc));
  else if (acc == null && h.nearHome !== true) add('home', 0.5, 'gps_none');
  if (Number.isFinite(h.exp) && h.exp > 0) {
    if (h.exp <= 1 / 400) add('out', 1.5, 'bright');
    else if (h.exp >= 1 / 50) add('home', 1, 'dim');
  } else if (Number.isFinite(h.ct)) {
    if (h.ct >= 5200) add('out', 0.5, 'daylight');
    else if (h.ct <= 3800) add('home', 0.5, 'lamp');
  }
  if (Number.isFinite(h.hour) && (h.hour >= 19 || h.hour < 7 || h.dow === 6 || (h.dow === 5 && h.hour >= 17))) add('home', 0.5, 'evening');
  if (vision === 'box') add('out', 2.5, 'seen_box');
  else if (vision === 'home') add('home', 2.5, 'seen_room');

  const pHome = logistic(home - out);
  let kind, confidence = Math.round(100 * Math.max(pHome, 1 - pHome)), location = null;
  if (pHome >= 0.5) kind = 'home';
  else if (lib && lib.m <= CLOSE_M) {
    kind = 'library'; location = lib;
    if (libraries[1] && libraries[1].m - lib.m < 40) confidence = Math.min(confidence, SURE - 1); // which of two?
  } else {
    kind = 'new_library'; confidence = Math.min(confidence, SURE - 1);
  }
  return { kind, location, confidence, why, candidates: libraries.slice(0, 3), points: { home: +home.toFixed(2), out: +out.toFixed(2) } };
}

// The libraries around the photos, nearest first.
export async function librariesNear(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return many(
    `SELECT id, code, name, ST_Distance(geom, ST_MakePoint($2, $1)::geography)::int AS m FROM locations
      WHERE status NOT IN ('rejected', 'removed') AND ST_DWithin(geom, ST_MakePoint($2, $1)::geography, $3)
      ORDER BY geom <-> ST_MakePoint($2, $1)::geography LIMIT 3`, [lat, lon, LOOK_M]).catch(() => []);
}

const PLACE_PROMPT = 'Where was this photo of books taken? Answer with one word: BOX (a street book box, a public '
  + 'bookcase, or a cabinet of books outdoors or in a public place), HOME (a bookcase or shelves inside a home), HAND '
  + '(one book held in a hand or lying on a table), or OTHER.';

// One short question to the vision model about one photo; null when it cannot answer.
export async function placeSeen(buffer) {
  try {
    const jpeg = await sharp(buffer).rotate().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
    const a = String(await Promise.race([generate(jpeg, PLACE_PROMPT, 5), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 120_000))])).toUpperCase();
    return a.includes('BOX') ? 'box' : a.includes('HOME') ? 'home' : a.includes('HAND') ? 'hand' : 'other';
  } catch {
    return null;
  }
}

export async function guessSituation(hints, photo) {
  const libraries = await librariesNear(Number(hints?.lat), Number(hints?.lon));
  const vision = photo ? await placeSeen(photo) : null;
  return { ...scoreSituation(hints, libraries, vision), vision };
}
