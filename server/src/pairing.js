// Free-style capture: the phone sends every photo it takes, in order, with when it was
// taken and how the phone moved since the photo before (see web/src/capture.js). Here
// the photos of one session are sorted: shelves (spines, read as a shelf scan), front
// covers and back covers, which are then paired into books. Nothing on the phone
// decides what a photo is: a book turned over on a shelf moves in the picture as much as
// the phone moving on to the next book does, and the phone guessed wrong (3 Nov 2026).
//
// Signals, per photo: what it shows (the vision model, one word), barcodes (a back cover
// almost always has one). Per pair of photos: how alike the covers' colours are (front
// and back of a book share paper, colours and the publisher's logo), how alike the
// pictures are (the same side photographed twice), how close in the session, and, for
// the likely pairs, the vision model shown both pictures ("the same book?"). The model
// says yes too easily (3 Nov test: 8 of 11 pairs, 4 of them wrong), so its answer only
// tips close calls; colour and closeness decide. The phone's own movement is logged with
// each photo (meta) but not used yet: there is no data on what it looks like.
import sharp from 'sharp';
import { generate, readBookCodes } from './vision.js';
import { cropCover } from './covers.js';
import { step } from './trace.js';

const KIND_PROMPT = `What does this photo show? Answer with one word:
SHELF - several books side by side (spines on a shelf, or a stack)
FRONT - the front cover of one book (its title, usually big, and often a picture)
BACK - the back cover of one book (paragraphs of text about the book, often a barcode)
OTHER - anything else (an open book, a blurry picture, no book)`;

const SAME_PROMPT = 'Image 1 is the front cover of a book. Image 2 is the back cover of a book. Are they the two covers of the same book (same design, colours, publisher, title or author)? Answer YES or NO.';
const TWIN_PROMPT = 'Do these two photos show the same side of the same book (the same cover)? Answer YES or NO.';

const WINDOW = 5;        // a book's two covers are at most this many photos apart
const TWIN = 0.86;       // grey-picture likeness above which two photos are surely the same cover
const TWIN_MAYBE = 0.6;  // between this and TWIN the vision model is asked
const PAIR_MIN = 1.0;    // a front and a back become a book only with at least this score

export async function classify(buf) {
  const jpeg = await sharp(buf).rotate().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const answer = (await generate(jpeg, KIND_PROMPT, 6)).trim().toUpperCase();
  const kind = /SHELF/.test(answer) ? 'shelf' : /FRONT/.test(answer) ? 'front' : /BACK/.test(answer) ? 'back' : 'other';
  const codes = kind === 'shelf' ? [] : await readBookCodes(buf);
  // A barcode on a single cover is a back cover (fronts very rarely carry one).
  return { kind: codes.length && kind !== 'shelf' ? 'back' : kind, said: kind, codes };
}

// The cover cut out (or the photo as it is), a colour histogram of it and a small grey copy.
export async function features(buf) {
  const crop = await cropCover(buf).catch(() => null);
  const img = crop ?? await sharp(buf).rotate().jpeg().toBuffer();
  const { data } = await sharp(img).resize(48, 72, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const hist = new Float32Array(8 * 4 * 4);
  const grey = new Float32Array(48 * 72);
  for (let i = 0; i < grey.length; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    grey[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const [h, s, v] = hsv(r, g, b);
    hist[Math.min(7, Math.floor(h * 8)) * 16 + Math.min(3, Math.floor(s * 4)) * 4 + Math.min(3, Math.floor(v * 4))]++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= grey.length;
  const thumb = await sharp(img).resize(640, 640, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  return { cropped: !!crop, hist, grey, thumb };
}

function hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx ? d / mx : 0, mx];
}

// Histogram intersection, 0–1.
export const colourLike = (a, b) => a.reduce((s, x, i) => s + Math.min(x, b[i]), 0);
// Correlation of the grey copies, 0–1 (negative counts as 0).
export function pictureLike(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return Math.max(0, ab / Math.sqrt(aa * bb || 1));
}

const yes = async (images, prompt) => /^\s*YES/i.test(await generate(images, prompt, 4));

// shots: [{ seq, buf, meta }] in the order taken. Returns
//   { shelves: [[i, …]], books: [{ front: [i…], back: [i…], codes }], other: [i…] }
// with indexes into shots; each side's first index is its best picture.
export async function sortShots(shots, { log = () => {} } = {}) {
  const info = [];
  for (const [i, s] of shots.entries()) {
    const c = await classify(s.buf);
    const f = c.kind === 'front' || c.kind === 'back' ? await features(s.buf) : null;
    info.push({ i, ...c, f });
    log({ shot: i, kind: c.kind, said: c.said, codes: c.codes, cropped: f?.cropped ?? null });
  }
  await step('shots-sorted', { note: 'what each photo shows (vision model; a barcode makes a cover a back cover)', shots: info.map(({ i, kind, said, codes }) => ({ i, kind, said, codes })) });

  // The same side photographed again (a retake, or a second pass): one group per cover.
  const groups = [];
  for (const x of info.filter((x) => x.f)) {
    let into = null;
    for (const g of groups) {
      if (g.kind !== x.kind || x.i - g.idx.at(-1) > WINDOW + 3) continue;
      const like = Math.max(...g.idx.map((j) => pictureLike(info[j].f.grey, x.f.grey)));
      const col = Math.max(...g.idx.map((j) => colourLike(info[j].f.hist, x.f.hist)));
      const twin = like >= TWIN && col >= 0.6 ? true
        : like >= TWIN_MAYBE && col >= 0.5 ? await yes([info[g.idx[0]].f.thumb, x.f.thumb], TWIN_PROMPT) : false;
      log({ twin: [g.idx[0], x.i], like: +like.toFixed(2), col: +col.toFixed(2), same: twin });
      if (twin) { into = g; break; }
    }
    if (into) into.idx.push(x.i); else groups.push({ kind: x.kind, idx: [x.i] });
  }

  // Fronts and backs: every pair near each other in the session is scored, best first.
  const fronts = groups.filter((g) => g.kind === 'front'), backs = groups.filter((g) => g.kind === 'back');
  const cands = [];
  for (const F of fronts) for (const B of backs) {
    const gap = Math.min(...F.idx.flatMap((a) => B.idx.map((b) => Math.abs(a - b))));
    if (gap > WINDOW) continue;
    const near = F.idx.flatMap((a) => B.idx.map((b) => [a, b])).sort((p, q) => Math.abs(p[0] - p[1]) - Math.abs(q[0] - q[1]))[0];
    const col = Math.max(...F.idx.flatMap((a) => B.idx.map((b) => colourLike(info[a].f.hist, info[b].f.hist))));
    let score = col + 1 / gap * 0.6 + (near[1] > near[0] ? 0.15 : 0); // a back usually comes after its front
    cands.push({ F, B, gap, col, score });
  }
  cands.sort((a, b) => b.score - a.score);
  // The vision model looks at the likely pairs (both covers side by side).
  for (const c of cands.slice(0, 3 * Math.max(fronts.length, backs.length))) {
    c.same = await yes([info[c.F.idx[0]].f.thumb, info[c.B.idx[0]].f.thumb], SAME_PROMPT);
    c.score += c.same ? 0.5 : -0.7;
    log({ pair: [c.F.idx, c.B.idx], gap: c.gap, col: +c.col.toFixed(2), same: c.same, score: +c.score.toFixed(2) });
  }
  cands.sort((a, b) => b.score - a.score);
  const used = new Set(), books = [];
  for (const c of cands) {
    if (c.score < PAIR_MIN || used.has(c.F) || used.has(c.B)) continue;
    used.add(c.F); used.add(c.B);
    books.push({ front: c.F.idx, back: c.B.idx });
  }
  for (const g of groups) if (!used.has(g)) books.push(g.kind === 'front' ? { front: g.idx, back: [] } : { front: [], back: g.idx });
  for (const b of books) b.codes = [...new Set([...b.back, ...b.front].flatMap((i) => info[i].codes))];
  books.sort((a, b) => Math.min(...a.front, ...a.back) - Math.min(...b.front, ...b.back));

  // Shelf photos next to each other are read together (a spine seen twice counts once), 8 at most.
  const shelves = [];
  let run = [];
  for (const x of info) {
    if (x.kind === 'shelf' && run.length < 8 && (!run.length || x.i - run.at(-1) <= 2)) run.push(x.i);
    else if (x.kind === 'shelf') { shelves.push(run); run = [x.i]; }
  }
  if (run.length) shelves.push(run);
  const other = info.filter((x) => x.kind === 'other').map((x) => x.i);
  await step('shots-paired', { note: 'covers grouped (same side twice) and paired (front + back)', books: books.map(({ front, back, codes }) => ({ front, back, codes })), shelves, other,
    pairs: cands.map((c) => ({ front: c.F.idx, back: c.B.idx, gap: c.gap, colour: +c.col.toFixed(2), same: c.same ?? null, score: +c.score.toFixed(2) })) });
  return { shelves, books, other, info: info.map(({ f, ...x }) => x) };
}
