import sharp from 'sharp';
import { readBarcodes } from 'zxing-wasm/reader';
import { config } from './config.js';
import { normalizeIsbn, normalizeDanacode } from './util.js';

// One line per book is far more reliable with small local models than JSON.
const PROMPT = `Read the book spines and covers in this photo. Write one line per distinct book, in the format:
TITLE | AUTHOR
Use the exact printed text in its original language and script (do not translate). Leave AUTHOR empty if not visible. If an ISBN number is printed, add it as: | ISBN
Skip spines you cannot read. Do not repeat a book. After the last book write END.`;

const MAX_LINES = 60;

// Long side ~1280 px keeps spine text legible without blowing the context window.
async function prepare(buffer, angle, size = 1280) {
  return sharp(buffer).rotate().rotate(angle)
    .resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

// Spine text runs vertically, so each photo is read upright and turned both ways.
const ANGLES = [0, 90, 270];

// Reads books from one photo or video frame with the vision model. Returns
// [{title, author, isbn}]: each spine cut out, straightened and read on its own (far
// better for Hebrew, which needs the pixels), plus one whole-image read.
// { spines: false } reads only the whole image, at three angles (fast).
export async function readBooks(buffer, { spines = true } = {}) {
  const all = [];
  if (!spines) {
    for (const angle of ANGLES) all.push(...await readOnce(await prepare(buffer, angle)));
    return mergeBooks(all);
  }
  // Spine-by-spine reads come first: they are the more accurate ones.
  try { all.push(...await readSpines(buffer)); } catch { /* keep the whole-image read */ }
  all.push(...await readOnce(await prepare(buffer, 0)));
  const books = mergeBooks(all);
  // Books only the whole-image read found: find their spine too, so the reader
  // approving them sees the straightened cut-out, not the whole shelf.
  const missing = books.filter((b) => !b.crop).slice(0, MAX_SPINES);
  if (missing.length) {
    const { data: upright, info } = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
    for (const b of missing) {
      try { b.crop = await findSpine(upright, info.width, info.height, b.title); } catch { /* no cut-out */ }
    }
  }
  return books;
}

// The front and back covers of one book, photographed one after the other: the title and
// author from the front, the ISBN or Danacode from a barcode (either side) or from the
// digits printed on the back. Barcodes in a photo of a whole cover are often too small
// to decode; the printed digits are read well, and an ISBN's check digit catches misreads.
const FRONT_PROMPT = 'This is the front cover of one book. Read its title and author exactly as printed, in the original language and script (do not translate). Answer one line: TITLE | AUTHOR. If unreadable answer NONE.';
const BACK_PROMPT = 'This is the back cover of a book. Find the ISBN, or the Israeli Danacode (דאנאקוד), printed on it, usually next to the barcode. Answer one line: ISBN <digits> or DANACODE <digits>. If there is neither, answer NONE.';
// codes: every ISBN/Danacode found, surest first (barcodes, then printed digits).
// unchecked: the printed Danacodes among them — no check digit, so the caller trusts
// one only when the catalogue's title for it matches the front cover.
export async function readCover(front, back = null) {
  let book = null;
  for (const angle of [0, 90, 270]) {
    [book] = parseBooks((await generate(await prepare(front, angle), FRONT_PROMPT, 120)).trim().split('\n')[0]);
    if (book && book.quality !== 'low') break;
  }
  const codes = [...(back ? await readBookCodes(back) : []), ...await readBookCodes(front)];
  const fromBarcodes = codes.length;
  if (!codes.length && back) {
    const printed = parsePrintedCode(await generate(await prepare(back, 0, 1600), BACK_PROMPT, 40));
    // Surya reads Hebrew print (the Danacode line) better than the vision model.
    const ocr = !printed || !normalizeIsbn(printed) ? codesInText(await surya(back).catch(() => '')) : [];
    codes.push(...ocr, ...(printed ? [printed] : []));
  }
  const unique = [...new Set(codes)];
  // Barcodes and ISBNs carry a check digit; a Danacode read from print does not.
  const unchecked = fromBarcodes ? [] : unique.filter((c) => !normalizeIsbn(c));
  return { title: book?.title ?? null, author: book?.author ?? null, quality: book?.quality ?? 'low', isbn: unique[0] ?? null, codes: unique, unchecked };
}

// ISBNs and Danacodes in OCR text: "ISBN 978-…", "דאנאקוד: 239-597", "מסת"ב …".
export function codesInText(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    for (const m of line.matchAll(/(?:ISBN|מסת"?ב)[^\dX]{0,6}([\dX][\dX\s-]{8,20})/gi)) {
      const c = normalizeIsbn(m[1]);
      if (c) out.push(c);
    }
    if (/דא?נאקוד|דנקוד|danacode/i.test(line)) {
      for (const m of line.matchAll(/\b(\d{1,4}\s?-\s?\d{2,7})\b/g)) {
        const c = normalizeDanacode(m[1]);
        if (c) out.push(c);
      }
    }
  }
  return [...new Set(out)];
}

// "ISBN 978-0-385-54647-8" / "DANACODE 239-597" → the ISBN-13 or the Danacode's 12 digits.
export function parsePrintedCode(answer) {
  const m = String(answer ?? '').match(/(ISBN|DANACODE)\s*:?\s*([0-9Xx][0-9Xx\s-]{4,20})/i);
  if (!m) return null;
  const digits = m[2].trim();
  return m[1].toUpperCase() === 'ISBN' ? normalizeIsbn(digits) ?? normalizeDanacode(digits) : normalizeDanacode(digits) ?? normalizeIsbn(digits);
}

// All the text printed on one cover photo, for the book page. Hebrew is read by Surya
// OCR (ocr/surya_server.py; Tesseract if it is down): the vision model invents Hebrew
// text it cannot make out, but copies Latin print almost perfectly.
const TEXT_PROMPT = 'Transcribe all the text printed on this book cover, exactly as printed, in its original language and script (do not translate). Keep paragraphs. Skip barcodes. Output only the text.';
export async function readCoverText(buffer) {
  const text = (await generate(await prepare(buffer, 0, 1600), TEXT_PROMPT, 1200)).trim();
  if (!/[\u0590-\u05FF]/.test(text)) return { text, hebrew: false };
  const better = await surya(buffer).catch(() => '') || await tesseract(buffer).catch(() => '');
  return { text: better || text, hebrew: true };
}

async function surya(buffer) {
  const jpeg = await sharp(buffer).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const res = await fetch(`${config.ocrUrl}/ocr`, { method: 'POST', body: jpeg, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`ocr ${res.status}`);
  return (await res.json()).text?.trim() ?? '';
}

async function tesseract(buffer) {
  const { execFile } = await import('node:child_process');
  const png = await sharp(buffer).rotate().resize(2400, 2400, { fit: 'inside' }).grayscale().png().toBuffer();
  return new Promise((resolve, reject) => {
    const p = execFile('tesseract', ['-', '-', '-l', 'heb+eng', '--psm', '3'], { timeout: 120_000, maxBuffer: 4 << 20 },
      (err, out) => (err ? reject(err) : resolve(out.trim())));
    p.stdin.end(png);
  });
}

// The four corners of the book cover in a photo of one book (held in a hand, lying on
// a table): [[x, y] × 4] as fractions of the upright picture's width and height, or null.
const CORNERS_PROMPT = 'This photo shows one book. Find the four corners of the book cover (the printed rectangle, not the hand or background). Output JSON: [{"point_2d":[x,y],"label":"top-left"},{"point_2d":[x,y],"label":"top-right"},{"point_2d":[x,y],"label":"bottom-right"},{"point_2d":[x,y],"label":"bottom-left"}]';
export async function coverCorners(buffer) {
  const jpeg = await sharp(buffer).rotate().resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  const out = await generate(jpeg, CORNERS_PROMPT, 300);
  // Qwen3-VL answers in 0–1000 coordinates relative to the image.
  const pts = [...out.matchAll(/"point_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)].map((m) => [m[1] / 1000, m[2] / 1000]);
  return pts.length === 4 ? pts : null;
}

async function generate(jpeg, prompt, numPredict) {
  const res = await fetch(`${config.vision.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.vision.model, prompt, images: [jpeg.toString('base64')], stream: false, think: false,
      keep_alive: '3m', options: { num_ctx: 8192, num_predict: numPredict, temperature: 0, repeat_penalty: 1.1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}`);
  return (await res.json()).response ?? '';
}

const MAX_SPINES = 30;
const SPINE_PROMPT = 'This is one book spine or cover. Read its title and author exactly as printed, in the original language and script. Answer one line: TITLE | AUTHOR. If unreadable answer NONE.';
const iou = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
};
// Vowel points mostly show up when the model guesses at Hebrew it cannot read.
const niqqud = (s) => (s.match(/[\u05B0-\u05BC\u05C1\u05C2]/g) ?? []).length;

const DETECT_PROMPT = 'Locate every individual book spine or book cover in this image. Output JSON list: [{"bbox_2d":[x1,y1,x2,y2]}]';
const MAX_TILT_GROUPS = 3;

// Boxes around every spine/cover, in pixels of `jpeg` (full size W×H).
async function detect(jpeg, W, H) {
  const small = await sharp(jpeg).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  const out = await generate(small, DETECT_PROMPT, 1500);
  // Qwen3-VL answers in 0–1000 coordinates relative to the image.
  const boxes = [...out.matchAll(/"bbox_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)]
    .map((m) => m.slice(1, 5).map(Number))
    .map(([x1, y1, x2, y2]) => [x1 * W / 1000, y1 * H / 1000, x2 * W / 1000, y2 * H / 1000])
    .filter(([x1, y1, x2, y2]) => x2 - x1 > 10 && y2 - y1 > 10);
  return boxes.filter((b, i) => !boxes.slice(0, i).some((o) => iou(o, b) > 0.6));
}

const cut = (img, W, H, [x1, y1, x2, y2], pad) => {
  const left = Math.max(0, Math.floor(x1 - pad));
  const top = Math.max(0, Math.floor(y1 - pad));
  return sharp(img).extract({ left, top, width: Math.min(W - left, Math.ceil(x2 - x1 + 2 * pad)), height: Math.min(H - top, Math.ceil(y2 - y1 + 2 * pad)) }).toBuffer();
};

// Where a point of a W×H picture lands after sharp.rotate(deg) (clockwise, canvas grows to fit).
export function rotatePoint([x, y], W, H, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const W2 = W * Math.abs(c) + H * Math.abs(s), H2 = W * Math.abs(s) + H * Math.abs(c);
  const dx = x - W / 2, dy = y - H / 2;
  return [W2 / 2 + dx * c - dy * s, H2 / 2 + dx * s + dy * c];
}

const LOCATE_PROMPT = (title) => `Locate the book spine or cover with the title "${title.replace(/"/g, '')}" in this image. Output JSON: [{"bbox_2d":[x1,y1,x2,y2]}]`;
// Same book? Most words of the shorter title appear in the other one.
export function sameTitle(a, b) {
  const [x, y] = [normTitle(a).split(' '), normTitle(b).split(' ')].map((w) => w.filter(Boolean));
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.length > 0 && short.filter((w) => long.has(w)).length / short.length >= 0.5;
}

// The straightened cut-out of one named book, the way readSpines makes it: locate it,
// turn the photo upright for its lean, cut, and turn the text level. Kept only when
// reading the cut-out gives the same title back (else the box was the wrong book).
async function findSpine(upright, W, H, title) {
  const small = await sharp(upright).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  const m = (await generate(small, LOCATE_PROMPT(title), 200)).match(/\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
  let box = [x1 * W / 1000, y1 * H / 1000, x2 * W / 1000, y2 * H / 1000];
  if (box[2] - box[0] < 10 || box[3] - box[1] < 10) return null;
  let img = upright, w = W, h = H;
  const tilt = await dominantTilt(await cut(upright, W, H, box, 4));
  if (Math.abs(tilt) >= 5) {
    const turned = await sharp(upright).rotate(-tilt, { background: '#ffffff' }).toBuffer({ resolveWithObject: true });
    const pts = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map((p) => rotatePoint(p, W, H, -tilt));
    ({ data: img, info: { width: w, height: h } } = turned);
    // An upright box around a leaning spine (width s, length L) is s·cos+L·sin wide and
    // s·sin+L·cos tall; solve for s and keep that much around the middle.
    const c = Math.cos(Math.abs(tilt) * Math.PI / 180), sn = Math.sin(Math.abs(tilt) * Math.PI / 180);
    const [bw, bh] = [box[2] - box[0], box[3] - box[1]].sort((a, z) => a - z);
    const cx = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
    const half = Math.max(10, (bw * c - bh * sn) / (c * c - sn * sn)) / 2;
    box = [cx - half, Math.min(...pts.map((p) => p[1])), cx + half, Math.max(...pts.map((p) => p[1]))];
    box = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w, box[2]), Math.min(h, box[3])];
  }
  const piece = await cut(img, w, h, box, Math.min(box[2] - box[0], box[3] - box[1]) * 0.06 + 6);
  const bw = box[2] - box[0], bh = box[3] - box[1];
  for (const angle of bh > bw * 1.3 ? [270, 90] : [0]) {
    const jpeg = await sharp(piece).rotate(angle).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    const [read] = parseBooks((await generate(jpeg, SPINE_PROMPT, 80)).trim().split('\n')[0]);
    if (read && sameTitle(read.title, title)) return jpeg;
  }
  return null;
}

// Books on a public shelf lean, and an upright box around a leaning spine takes in its
// neighbours too. So: measure the lean inside every box, group boxes that lean the
// same way, turn the whole photo upright for each group and find the spines again —
// standing straight, each one gets a box of its own. Then read spine by spine.
async function readSpines(buffer) {
  const { data: upright, info } = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const boxes = (await detect(upright, W, H)).slice(0, MAX_SPINES);
  for (const b of boxes) b.tilt = await dominantTilt(await cut(upright, W, H, b, 4));

  const crops = [];
  const straight = boxes.filter((b) => Math.abs(b.tilt) < 5);
  for (const b of straight) crops.push({ img: await cut(upright, W, H, b, Math.min(b[2] - b[0], b[3] - b[1]) * 0.06 + 6), w: b[2] - b[0], h: b[3] - b[1] });

  // Lean groups: tilts within 6° of each other, the biggest groups first.
  const groups = [];
  for (const b of boxes.filter((x) => Math.abs(x.tilt) >= 5).sort((a, z) => a.tilt - z.tilt)) {
    const g = groups.at(-1);
    if (g && b.tilt - g[0].tilt < 6) g.push(b); else groups.push([b]);
  }
  groups.sort((a, z) => z.length - a.length);
  for (const g of groups.slice(0, MAX_TILT_GROUPS)) {
    const tilt = g.reduce((acc, b) => acc + b.tilt, 0) / g.length;
    const turned = await sharp(upright).rotate(-tilt, { background: '#ffffff' }).toBuffer({ resolveWithObject: true });
    const { width: W2, height: H2 } = turned.info;
    // The area the group's boxes cover, in the turned photo.
    const area = g.map((b) => {
      const pts = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map((p) => rotatePoint(p, W, H, -tilt));
      return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    });
    const inArea = ([x1, y1, x2, y2]) => {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      return area.some((a) => cx >= a[0] && cx <= a[2] && cy >= a[1] && cy <= a[3]);
    };
    let found = [];
    try { found = (await detect(turned.data, W2, H2)).filter(inArea); } catch { /* fall back to the leaning boxes */ }
    if (!found.length) found = area;
    for (const b of found.slice(0, MAX_SPINES)) {
      crops.push({ img: await cut(turned.data, W2, H2, b, Math.min(b[2] - b[0], b[3] - b[1]) * 0.06 + 6), w: b[2] - b[0], h: b[3] - b[1] });
    }
  }

  const books = [];
  for (const { img, w, h } of crops.slice(0, MAX_SPINES * 2)) {
    // Spine text runs top-to-bottom on most books; try that first, then the other way.
    let best = null;
    for (const angle of h > w * 1.3 ? [270, 90] : [0]) {
      const jpeg = await sharp(img).rotate(angle).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      const line = (await generate(jpeg, SPINE_PROMPT, 80)).trim().split('\n')[0];
      const [b] = /^NONE\b/i.test(line) ? [] : parseBooks(line);
      if (b && (!best || (best.quality === 'low' && b.quality !== 'low'))) best = { ...b, crop: jpeg };
      if (best && best.quality !== 'low') break;
    }
    if (best) books.push(best);
  }
  return books;
}

// The main direction of the edges in a picture, in degrees from upright, folded into
// [-45, 45): spine sides, cover sides and printed lines all agree on it. Rotating
// the picture by -tilt (sharp: positive = clockwise) makes them straight.
export async function dominantTilt(image) {
  const { data: p, info } = await sharp(image).greyscale().resize(360, 360, { fit: 'inside' }).raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const hist = new Float64Array(90);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = p[i - w + 1] + 2 * p[i + 1] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - 1] - p[i + w - 1];
      const gy = p[i + w - 1] + 2 * p[i + w] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - w] - p[i - w + 1];
      const m2 = gx * gx + gy * gy;
      if (m2 < 3600) continue; // flat or noise
      const a = Math.atan2(gy, gx) * 180 / Math.PI; // gradient ⟂ edge: 0 for an upright edge
      const folded = ((((a + 45) % 90) + 90) % 90); // 0..90, 45 = upright
      hist[Math.min(89, Math.floor(folded))] += Math.sqrt(m2);
    }
  }
  // Smooth (the folded circle wraps) and take the peak, refined between bins.
  const sm = hist.map((_, i) => [-2, -1, 0, 1, 2].reduce((acc, d) => acc + hist[(i + d + 90) % 90] * (3 - Math.abs(d)), 0));
  let k = 0;
  for (let i = 1; i < 90; i++) if (sm[i] > sm[k]) k = i;
  const a = sm[(k + 89) % 90], b = sm[k], c = sm[(k + 1) % 90];
  const off = a - 2 * b + c ? (a - c) / (2 * (a - 2 * b + c)) : 0;
  return k + 0.5 + off - 45;
}

// Streams the answer and stops early when the model starts looping (small vision
// models tend to repeat one line until the token limit).
async function readOnce(jpeg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  const res = await fetch(`${config.vision.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.vision.model,
      prompt: PROMPT,
      images: [jpeg.toString('base64')],
      stream: true,
      think: false,
      keep_alive: '3m',
      options: { num_ctx: 8192, num_predict: 1200, temperature: 0, repeat_penalty: 1.15 },
    }),
    signal: ctrl.signal,
  });
  if (!res.ok) { clearTimeout(timer); throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 200)}`); }

  let text = '';
  let buf = '';
  const counts = new Map();
  const decoder = new TextDecoder();
  try {
    outer: for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        text += msg.response ?? '';
        if (msg.done) break outer;
        if (/\bEND\s*$/.test(text)) break outer;
        const lines = text.split('\n');
        const last = lines.at(-2); // last complete line
        if (last != null && msg.response?.includes('\n')) {
          const key = normTitle(last.split('|')[0]);
          const n = (counts.get(key) ?? 0) + 1;
          counts.set(key, n);
          if (n >= 3 || lines.length > MAX_LINES) break outer;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // closes the stream; Ollama stops generating
  }
  return parseBooks(text);
}

// "TITLE | AUTHOR | ISBN" lines; tolerates bullets, numbering and code fences.
export function parseBooks(text) {
  const out = [];
  for (let line of String(text ?? '').split('\n')) {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/`/g, '').trim();
    if (!line || /^END\b/i.test(line)) continue;
    const [rawTitle, rawAuthor, rawIsbn] = line.split('|').map((x) => x?.trim());
    const title = clean(rawTitle);
    if (!title || title.length < 2 || /^(title|none|unreadable)$/i.test(title)) continue;
    const isbnDigits = String(rawIsbn ?? '').replace(/[^0-9X]/gi, '');
    out.push({ title, author: /^(none|unknown|n\/a)$/i.test(clean(rawAuthor)) ? null : clean(rawAuthor) || null, isbn: isbnDigits.length >= 10 ? isbnDigits : null, quality: readQuality(line) });
  }
  return mergeBooks(out);
}

// Drops repeats; "SELF AND IDENTITY" and "Handbook of Self and Identity" count as one.
export function mergeBooks(books) {
  const out = [];
  for (const b of books) {
    const k = normTitle(b.title);
    if (!k) continue;
    const dup = out.find((o) => {
      const ok = normTitle(o.title);
      return ok === k || (Math.min(ok.length, k.length) >= 6 && (ok.includes(k) || k.includes(ok)));
    });
    if (!dup) { out.push({ ...b }); continue; }
    if (dup.quality === 'low' && b.quality !== 'low') Object.assign(dup, { title: b.title, author: b.author || dup.author, quality: b.quality });
    else if (b.title.length > dup.title.length && b.quality !== 'low') dup.title = b.title;
    dup.author ||= b.author;
    dup.isbn ||= b.isbn;
    dup.crop ||= b.crop;
  }
  return out.slice(0, MAX_LINES);
}

// Printed Hebrew titles almost never carry vowel points; the model adds them when it
// guesses. Strip them (better catalogue matches) and remember the read was shaky.
const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0591-\u05C7]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) : '');

// low = probably garbled: guessed vowel points, stray symbols, or too short.
export function readQuality(raw) {
  const s = String(raw ?? '');
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  const odd = (s.match(/[^\p{L}\p{N}\s.,:;'"’\-–&!?()]/gu) ?? []).length;
  if (niqqud(s) >= 3 || letters < 3 || odd > 2) return 'low';
  return 'medium';
}

// For matching: lower case, no punctuation, no Hebrew vowel points.
export const normTitle = (s) => String(s ?? '').toLowerCase()
  .normalize('NFKD').replace(/[֑-ׇ̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ISBN barcodes (EAN-13 starting 978/979) anywhere in the photo.
export async function readIsbnBarcodes(buffer) {
  try {
    const img = await sharp(buffer).rotate().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
    const found = await readBarcodes(img, { formats: ['EAN13'], tryHarder: true, maxNumberOfSymbols: 20 });
    return [...new Set(found.filter((b) => b.isValid && /^97[89]\d{10}$/.test(b.text)).map((b) => b.text))];
  } catch {
    return [];
  }
}

// ISBN barcodes, and Danacodes (printed as UPC-A), on one book's cover.
export async function readBookCodes(buffer) {
  try {
    const img = await sharp(buffer).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
    const found = await readBarcodes(img, { formats: ['EAN13', 'UPCA'], tryHarder: true, maxNumberOfSymbols: 4 });
    return [...new Set(found.filter((b) => b.isValid).map((b) => normalizeIsbn(b.text) ?? normalizeDanacode(b.text)).filter(Boolean))];
  } catch {
    return [];
  }
}
