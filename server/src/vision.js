import sharp from 'sharp';
import { fixHebrew, knownWords, LOOKALIKE, unreverse } from './hebfix.js';
import { readBarcodes } from 'zxing-wasm/reader';
import { config } from './config.js';
import { normalizeIsbn, normalizeDanacode } from './util.js';
import { here, scope, step } from './trace.js';

// One line per book is far more reliable with small local models than JSON.
const PROMPT = `Read the book spines and covers in this photo. Write one line per distinct book, in the format:
TITLE | AUTHOR
Use the exact printed text in its original language and script (do not translate). Leave AUTHOR empty if not visible. If an ISBN number is printed, add it as: | ISBN
Skip spines you cannot read. Do not repeat a book. After the last book write END.`;

const MAX_LINES = 60;

// Long side ~1280 px keeps spine text legible without blowing the context window.
export async function prepare(buffer, angle, size = 1280) {
  return sharp(buffer).rotate().rotate(angle)
    .resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

// Spine text runs vertically, so each photo is read upright and turned both ways.
const ANGLES = [0, 90, 270];

// Reads books from one photo or video frame with the vision model. Returns
// [{title, author, isbn, crop, verified}]: each spine cut out, straightened and read on
// its own (far better for Hebrew, which needs the pixels), plus one whole-image read.
// verified: the cut-out's reading was confirmed by OCR (see readCrop); a book only the
// whole-image read found, with no confirmed cut-out, has none.
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
  await step('merged-reads', { note: 'cut-out reads first, then the whole-image read; repeats merged', books: books.map(brief) });
  // Books only the whole-image read found: find their spine too, so the reader
  // approving them sees the straightened cut-out, not the whole shelf.
  // The spine found is often one already cut out and read (the whole-image read misread its
  // title): that book is then dropped, not queued a second time under the misread title.
  // Otherwise the cut-out's own reading replaces the whole-image one.
  let books2 = books;
  const missing = books.filter((b) => !b.crop).slice(0, MAX_SPINES);
  if (missing.length) {
    const { data: upright, info } = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const placed = books.filter((b) => b.place);
    const gone = new Set();
    for (const b of missing) {
      try {
        const found = await scope(`find: ${b.title}`, async () => {
          const f = await findSpine(upright, W, H, b.title);
          if (!f) return null;
          // Same place and alike readings (a box can hold two spines, so place alone is not enough).
          const alike = (o) => !f.read?.title || [f.read.title, f.read.author].some((x) => x && [o.title, o.author].some((y) => y && titleSimilarity(x, y) >= 0.6));
          const twin = placed.find((o) => inPlace(o.place, f.center, W, H) && alike(o));
          if (twin) {
            await step('find-spine-twin', { note: 'the spine found is one already cut out and read: this whole-image reading is dropped', whole_read: b.title, same_as: twin.title });
            return { twin };
          }
          return f;
        });
        if (found?.twin) { gone.add(b); continue; }
        if (found) {
          const r = found.read;
          Object.assign(b, { crop: found.crop, at: found.at, verified: true, spot: found.spot });
          if (r?.title) Object.assign(b, { title: r.title, author: r.author || b.author, quality: r.quality ?? b.quality });
        }
      } catch { /* no cut-out */ }
    }
    books2 = mergeBooks(books.filter((b) => !gone.has(b)));
  }
  await step('frame-result', { books: books2.map(brief) });
  return books2;
}

const brief = (b) => ({ title: b.title, author: b.author ?? null, isbn: b.isbn ?? null, quality: b.quality, verified: b.verified, crop: !!b.crop });

// The front and back covers of one book, photographed one after the other: the title and
// author from the front, the ISBN or Danacode from a barcode (either side) or from the
// digits printed on the back. Barcodes in a photo of a whole cover are often too small
// to decode; the printed digits are read well, and an ISBN's check digit catches misreads.
const FRONT_PROMPT = 'This is the front cover of one book. Read its title and author exactly as printed, in the original language and script (do not translate). Answer one line: TITLE | AUTHOR. If unreadable answer NONE.';
const BACK_PROMPT = 'This is the back cover of a book. Find the ISBN, or the Israeli Danacode (דאנאקוד), printed on it, usually next to the barcode. Answer one line: ISBN <digits> or DANACODE <digits>. If there is neither, answer NONE.';
const PICK_PROMPT = (lines) => `This is the front cover of one book. OCR read these lines of text on it (text height in pixels in brackets):
${lines.map((l, i) => `${i + 1}. [${l.h}] ${l.text}`).join('\n')}
Which lines are the book's title, and which are the author's name? The title is usually the biggest text; the author's name is a person's name. Answer one line: TITLE | AUTHOR, copying the OCR text exactly (join lines of a title that spans several lines with a space). Leave AUTHOR empty if no author is printed.`;
const isHebrew = (s) => /[\u0590-\u05FF]/.test(s ?? '');

// codes: every ISBN/Danacode found, surest first (barcodes, then printed digits).
// unchecked: the printed Danacodes among them — no check digit, so the caller trusts
// one only when the catalogue's title for it matches the front cover.
// Hebrew covers are also read by OCR (text: front, then back), which checks the model:
// it reads the layout well but invents Hebrew letters it cannot make out. alternatives:
// other readings worth a catalogue lookup.
// The lines of one photo, corrected by what other frames of the same cover read: lines
// that are the same text (similar) vote, most votes then most words hspell knows; a line
// only another frame saw is added if it read it clearly. Measured on a real shelf video:
// frames differ in the words they get right (גליה עוד / גליה עוז); a stacked, sharpened
// picture read far worse than any one frame, so frames are read, not merged.
export async function voteLines(lines, others) {
  const groups = lines.map((l) => ({ ...l, votes: [l.text] }));
  for (const other of others) {
    for (const o of other) {
      let best = null, top = 0;
      for (const g of groups) { const x = titleSimilarity(g.text, o.text); if (x > top) [best, top] = [g, x]; }
      if (top >= 0.6) best.votes.push(o.text);
      else if (o.confidence >= 0.8 && normTitle(o.text).length >= 3) groups.push({ text: o.text, h: o.h, votes: [o.text] });
    }
  }
  for (const g of groups) {
    const count = new Map();
    for (const v of g.votes) count.set(v, (count.get(v) ?? 0) + 1);
    let win = g.text, winScore = -1;
    for (const [v, n] of count) { const score = n * 10 + await knownWords(v, 3); if (score > winScore) [win, winScore] = [v, score]; }
    g.text = win;
  }
  return groups.map(({ votes, ...l }) => l);
}

export async function readCover(front, back = null, extras = { front: [], back: [] }) {
  const reads = [];
  for (const angle of [0, 90, 270]) {
    const [b] = parseBooks((await generate(await prepare(front, angle), FRONT_PROMPT, 120)).trim().split('\n')[0]);
    if (b) reads.push(b);
    if (b && b.quality !== 'low') break;
  }
  let book = reads.find((b) => b.quality !== 'low') ?? reads[0] ?? null;
  const model = book;
  let text = '', pick = null, backText = null, variants = [];
  if (!book || reads.some((b) => isHebrew(b.title + b.author))) {
    const ocr = await suryaRead(front).catch(() => null);
    const lines = (ocr?.boxes ?? []).filter((b) => b.confidence >= 0.5 && /\p{L}{2}/u.test(b.text))
      .map((b) => ({ text: b.text.replace(/\s+/g, ' ').trim(), h: Math.round(b.bbox[3] - b.bbox[1]), bbox: b.bbox }));
    // More frames of the cover: read too, and they vote.
    const others = [];
    for (const x of extras.front) {
      const r = await suryaRead(x).catch(() => null);
      others.push((r?.boxes ?? []).filter((b) => b.confidence >= 0.5 && /\p{L}{2}/u.test(b.text))
        .map((b) => ({ text: b.text.replace(/\s+/g, ' ').trim(), h: Math.round(b.bbox[3] - b.bbox[1]), confidence: b.confidence })));
    }
    if (others.length) {
      const voted = await voteLines(lines, others);
      variants = [...new Set(others.flat().map((l) => l.text))];
      await step('frames-vote', { note: 'the OCR lines of each frame of the cover, compared', frames: others.length + 1, before: lines.map((l) => l.text), after: voted.map((l) => l.text) });
      lines.splice(0, lines.length, ...voted);
    }
    // The biggest lines (the title, the author) read again, close up (after the frames voted).
    if (lines.length) await rereadBigLines(front, lines).catch(() => null);
    if (lines.length) {
      // What any frame read counts as printed (and the big lines as first read, too).
      text = [...new Set([...lines.map((l) => l.text), ...lines.map((l) => l.was).filter(Boolean), ...variants])].join('\n');
      // The model picks the title and author among the OCR lines: OCR spelling, model layout.
      [pick] = parseBooks((await generate(await prepare(front, 0), PICK_PROMPT(lines.slice(0, 40)), 160)).trim().split('\n')[0]);
      const known = [...lines.map((l) => l.text), pick?.title, pick?.author].filter(Boolean);
      // A low-quality read OCR agrees with beats a clean one it does not (a cover read sideways).
      const agree = (b) => Math.max(0, ...known.map((k) => titleSimilarity(b.title, k)));
      for (const b of reads) if (agree(b) > agree(book) + 0.1) book = b;
      book = await reconcile(book ?? pick, known, pick);
      if (back) backText = await surya(back).catch(() => '');
    }
  }
  const codes = [...(back ? await readBookCodes(back) : []), ...await readBookCodes(front)];
  // A frame just after the back cover often holds the barcode closer, or steadier.
  for (const x of extras.back) if (!codes.length) codes.push(...await readBookCodes(x));
  const fromBarcodes = codes.length;
  if (!codes.length && back) {
    const printed = parsePrintedCode(await generate(await prepare(back, 0, 1600), BACK_PROMPT, 40));
    // Surya reads Hebrew print (the Danacode line) better than the vision model.
    const ocr = !printed || !normalizeIsbn(printed) ? codesInText(backText ?? await surya(back).catch(() => '')) : [];
    codes.push(...ocr, ...(printed ? [printed] : []));
  }
  const unique = [...new Set(codes)];
  // Barcodes and ISBNs carry a check digit; a Danacode read from print does not.
  const unchecked = fromBarcodes ? [] : unique.filter((c) => !normalizeIsbn(c));
  // Another frame's spelling of the title may be the one the catalogue knows (the vote can lose it).
  const spellings = book?.title ? variants.filter((v) => titleSimilarity(v, book.title) >= 0.6).slice(0, 3).map((title) => ({ title, author: book.author })) : [];
  const alternatives = [pick, model, ...spellings].filter((b) => b?.title && normTitle(b.title) !== normTitle(book?.title)).map((b) => ({ title: b.title, author: b.author ?? null }));
  await step('cover-read', { title: book?.title ?? null, author: book?.author ?? null, quality: book?.quality ?? 'low', model: model && { title: model.title, author: model.author }, pick: pick && { title: pick.title, author: pick.author }, alternatives, barcodes: codes.slice(0, fromBarcodes), codes: unique, unchecked });
  return { title: book?.title ?? null, author: book?.author ?? null, quality: book?.quality ?? 'low', isbn: unique[0] ?? null, codes: unique, unchecked,
    alternatives, text: [text, backText].filter(Boolean).join('\n'), frontText: text || null, backText: backText || null };
}

// The title and author are the biggest print on a cover, and the lines OCR misreads most
// (stylised display fonts). The 3 biggest lines are cut out, enlarged so a letter is ~60 px
// tall, and read again by Surya and Tesseract; the three readings vote (alike readings
// count together), and among the most voted the one with more words hspell knows wins.
const BIG_LINES = 3;
export async function rereadBigLines(front, lines) {
  const page = await sharp(front).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const { width: W, height: H } = await sharp(page).metadata();
  const big = [...lines].filter((l) => l.bbox && normTitle(l.text).replace(/ /g, '').length >= 3).sort((a, b) => b.h - a.h).slice(0, BIG_LINES);
  const changes = [];
  for (const l of big) {
    const [x1, y1, x2, y2] = l.bbox;
    const pad = (y2 - y1) * 0.25;
    const left = Math.max(0, Math.floor(x1 - pad)), top = Math.max(0, Math.floor(y1 - pad));
    const width = Math.min(W - left, Math.ceil(x2 - x1 + 2 * pad)), height = Math.min(H - top, Math.ceil(y2 - y1 + 2 * pad));
    if (width < 8 || height < 8) continue;
    const k = Math.min(3, Math.max(1, 90 / height));
    const piece = await sharp(page).extract({ left, top, width, height }).resize(Math.round(width * k), Math.round(height * k)).sharpen().jpeg({ quality: 92 }).toBuffer();
    const [s1, t1] = await Promise.all([
      suryaRead(piece).then((r) => (r.boxes ?? []).filter((b) => b.confidence >= 0.5).map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim()).catch(() => ''),
      tesseractLine(piece).catch(() => ''),
    ]);
    const reads = [l.text, s1, t1].filter((x) => normTitle(x).length >= 2);
    let win = l.text, top2 = -1;
    for (const r of reads) {
      const votes = reads.filter((o) => titleSimilarity(o, r) >= 0.8).length;
      const score = votes * 10 + await knownWords(r, 3);
      if (score > top2) [win, top2] = [r, score];
    }
    changes.push({ line: l.text, surya: s1, tesseract: t1, kept: win });
    if (win !== l.text) { l.was = l.text; l.text = win; }
  }
  await step('big-lines', { note: 'the biggest lines cut out, enlarged and read again by Surya and Tesseract; the readings vote', lines: changes });
  return lines;
}
async function tesseractLine(jpeg) {
  const { execFile } = await import('node:child_process');
  const png = await sharp(jpeg).grayscale().png().toBuffer();
  return new Promise((resolve, reject) => {
    const p = execFile('tesseract', ['-', '-', '-l', 'heb+eng', '--psm', '7'], { timeout: 30_000, maxBuffer: 1 << 20 },
      (err, out) => (err ? reject(err) : resolve(out.replace(/\s+/g, ' ').trim())));
    p.stdin.end(png);
  });
}

// Each field the model read is swapped for the OCR line it resembles (or for single OCR
// words when no line is close); when the spellings differ, the one with more words
// hspell knows wins, OCR on a tie. A model that put the author first is turned round.
export async function reconcile(book, known, pick) {
  if (!book) return book;
  const sim = (a, b) => (a && b ? titleSimilarity(a, b) : 0);
  let { title, author } = book;
  if (pick?.title && sim(pick.title, author) > Math.max(0.6, sim(pick.title, title))) [title, author] = [author, title];
  const better = async (ocr, read) => ((await knownWords(read, 4)) > (await knownWords(ocr, 4)) ? read : ocr);
  const words = [...new Set(known.flatMap((k) => k.split(' ')))].filter((w) => normTitle(w).length >= 4);
  const fix = async (v) => {
    if (!v) return v;
    let best = null, top = 0;
    for (const k of known) { const x = sim(v, k); if (x > top) [best, top] = [k, x]; }
    if (top >= 0.6) return better(best, v);
    let out = v;
    for (const w of v.split(' ').filter((x) => normTitle(x).length >= 4)) {
      let bw = null, bs = 0;
      for (const k of words) { const x = sim(w, k); if (x > bs) [bw, bs] = [k, x]; }
      if (bs >= 0.75 && bs < 1) out = out.replace(w, await better(bw, w));
    }
    return out;
  };
  title = (await fix(title)) || pick?.title || null;
  author = (await fix(author)) ?? null;
  if (title !== book.title || author !== book.author) await step('cover-reconcile', { note: 'model reading checked against OCR', from: { title: book.title, author: book.author }, to: { title, author } });
  return { ...book, title, author };
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
export const TEXT_PROMPT = 'Transcribe all the text printed on this book cover, exactly as printed, in its original language and script (do not translate). Keep paragraphs. Skip barcodes. Output only the text.';
export async function readCoverText(buffer) {
  const text = await unreverse((await generate(await prepare(buffer, 0, 1600), TEXT_PROMPT, 1200)).trim());
  if (!/[\u0590-\u05FF]/.test(text)) {
    await step('cover-text', { note: 'no Hebrew in the vision model\'s reading: it is used as it is', text });
    return { text, hebrew: false };
  }
  const better = await surya(buffer).catch(() => '') || await tesseract(buffer).catch(() => '');
  const out = better ? await fixHebrew(better) : text;
  await step('cover-text', { note: better ? 'Hebrew: OCR reading, then the spell check' : 'Hebrew, but OCR read nothing: the vision model\'s reading', text: out });
  return { text: out, hebrew: true };
}

async function surya(buffer) {
  return (await suryaRead(buffer)).text?.trim() ?? '';
}
// { text, lines, boxes: [{ text, bbox: [x1, y1, x2, y2], confidence }] } in the pixels
// of the picture as sent (upright, at most 2400 px).
export async function suryaRead(buffer) {
  const jpeg = await sharp(buffer).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const t0 = Date.now();
  const res = await fetch(`${config.ocrUrl}/ocr`, { method: 'POST', body: jpeg, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`ocr ${res.status}`);
  const out = await res.json();
  await step('ocr', { engine: 'surya', text: out.text ?? '', lines: out.boxes?.map((b) => ({ text: b.text, confidence: b.confidence, bbox: b.bbox })) ?? [], ms: Date.now() - t0 }, { image: jpeg }, { side: 1000 });
  return out;
}

export async function tesseract(buffer) {
  const { execFile } = await import('node:child_process');
  const png = await sharp(buffer).rotate().resize(2400, 2400, { fit: 'inside' }).grayscale().png().toBuffer();
  return new Promise((resolve, reject) => {
    const p = execFile('tesseract', ['-', '-', '-l', 'heb+eng', '--psm', '3'], { timeout: 120_000, maxBuffer: 4 << 20 },
      (err, out) => (err ? reject(err) : step('ocr', { engine: 'tesseract', text: out.trim() }).then(() => resolve(out.trim()))));
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

// jpeg: one picture, or several (the model sees them in order: "image 1", "image 2").
export async function generate(jpeg, prompt, numPredict) {
  const images = Array.isArray(jpeg) ? jpeg : [jpeg];
  const t0 = Date.now();
  // Ollama answers 500 when the GPU ran out of memory (another job loaded a model at the same
  // moment: a 37-photo session failed so on 8 Nov 2026); it then frees the memory, so the same
  // request is tried again a little later.
  let res;
  for (const wait of [0, 10_000, 30_000, 90_000]) {
    if (wait) { await step('model-retry', { status: res?.status ?? null, wait_ms: wait }); await new Promise((r) => setTimeout(r, wait)); }
    res = await fetch(`${config.vision.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.vision.model, prompt, images: images.map((b) => b.toString('base64')), stream: false, think: false,
        keep_alive: '3m', options: { num_ctx: 8192, num_predict: numPredict, temperature: 0, repeat_penalty: 1.1 },
      }),
      signal: AbortSignal.timeout(config.vision.timeoutMs),
    }).catch((err) => ({ ok: false, status: 0, err }));
    // Retried: a 5xx or a refused connection (Ollama restarting); not a time-out.
    if (res.ok || (res.status > 0 && res.status < 500) || res.err?.name === 'TimeoutError') break;
  }
  if (!res.ok) throw res.err ?? new Error(`vision ${res.status}`);
  const answer = (await res.json()).response ?? '';
  await step('model', { model: config.vision.model, prompt, answer, ms: Date.now() - t0 },
    Object.fromEntries(images.map((b, i) => [i ? `image${i + 1}` : 'image', b])), { side: 1000 });
  return answer;
}

const MAX_SPINES = 30;
export const SPINE_PROMPT = 'This is one book spine or cover. Read its title and author exactly as printed, in the original language and script. Answer one line: TITLE | AUTHOR. If unreadable answer NONE.';
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

// Is point p (in the upright W×H photo) on the spine at `place` (its box in the photo
// turned by -tilt, the way readSpines cut it)?
function inPlace({ tilt, box }, p, W, H) {
  const [x, y] = tilt ? rotatePoint(p, W, H, -tilt) : p;
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

// How sharp a photo is: the variance of the Laplacian on a grey copy of 1200 px. Measured on
// readers' shelf photos (Nov 2026): under ~150 no spine was read at all (motion blur), from
// ~475 most were.
export const BLURRY = 250;
export async function sharpness(buffer) {
  const { data, info } = await sharp(buffer).rotate().greyscale().resize(1200, 1200, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let n = 0, sum = 0, sum2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      sum += l; sum2 += l * l; n++;
    }
  }
  return Math.round(sum2 / n - (sum / n) ** 2);
}

// Where a point of a W×H picture lands after sharp.rotate(deg) (clockwise, canvas grows to fit).
export function rotatePoint([x, y], W, H, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const W2 = W * Math.abs(c) + H * Math.abs(s), H2 = W * Math.abs(s) + H * Math.abs(c);
  const dx = x - W / 2, dy = y - H / 2;
  return [W2 / 2 + dx * c - dy * s, H2 / 2 + dx * s + dy * c];
}

// Inverse of rotatePoint: where a point of the turned picture was in the W×H original.
export function unrotatePoint([x, y], W, H, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const W2 = W * Math.abs(c) + H * Math.abs(s), H2 = W * Math.abs(s) + H * Math.abs(c);
  const dx = x - W2 / 2, dy = y - H2 / 2;
  return [W / 2 + dx * c + dy * s, H / 2 - dx * s + dy * c];
}
// Where a spine is on its photo, to show it again later ("where is this book?"): the four
// corners of its box (cut in the photo turned by -tilt) in the upright photo, as fractions
// of its width and height.
export function spotOf({ tilt, box }, W, H) {
  const corners = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
  const pts = tilt ? corners.map((p) => unrotatePoint(p, W, H, -tilt)) : corners;
  return { poly: pts.map(([x, y]) => [Math.round(Math.min(1, Math.max(0, x / W)) * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y / H)) * 1000) / 1000]) };
}

const LOCATE_PROMPT = (title) => `Locate the book spine or cover with the title "${title.replace(/"/g, '')}" in this image. Output JSON: [{"bbox_2d":[x1,y1,x2,y2]}]`;
// The outline of one named book on a photo, located by the vision model (no reading back):
// for spines scanned before outlines were kept (scripts/spots.js). { poly } or null.
export async function locateSpine(buffer, title) {
  const { data: upright, info: { width: W, height: H } } = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
  const small = await sharp(upright).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  const m = (await generate(small, LOCATE_PROMPT(title), 200)).match(/\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
  if (!m) return null;
  const box = m.slice(1, 5).map((v, k) => Math.min(1, Math.max(0, Number(v) / 1000)) * (k % 2 ? H : W));
  if (box[2] - box[0] < 8 || box[3] - box[1] < 8 || (box[2] - box[0]) * (box[3] - box[1]) > 0.5 * W * H) return null;
  // The model's box often takes in the thin spines beside this one: narrowed to the band
  // where OCR finds its title (as when reading). Unconfirmed: the box as located.
  const pad = Math.min(box[2] - box[0], box[3] - box[1]) * 0.06 + 6;
  const read = await readCrop(await cut(upright, W, H, box, pad), box[2] - box[0], box[3] - box[1], title, { ownLines: false }).catch(() => null);
  const one = Array.isArray(read) ? null : read;
  const sure = !!one?.verified && !!one.across;
  return { ...spotOf({ tilt: 0, box: sure ? narrowed(box, cutArea(W, H, box, pad), one.across) : box }, W, H), how: sure ? 'located' : 'located-rough' };
}

// Same book? Most words of the shorter title appear in the other one.
export function sameTitle(a, b) {
  const [x, y] = [normTitle(a).split(' '), normTitle(b).split(' ')].map((w) => w.filter(Boolean));
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.length > 0 && short.filter((w) => long.has(w)).length / short.length >= 0.5;
}

// Does a catalogue title fit the text printed on the covers? Every word of its main
// title (before ':') must be on one line of it, one miss allowed in a long title; with
// full: true (the covers read in full by OCR) a subtitle of 3+ words needs one of them
// too (catalogues add descriptive subtitles no cover prints). readings: titles read off
// the front; one that goes on past the main title (a printed subtitle) must share a word
// with the catalogue's subtitle. A word may be misread by a letter or so (look-alike
// letters, a prefix letter).
const wordSeen = (w, seen) => seen.has(w) || (w.length >= 4 && [...seen].some((p) => Math.abs(p.length - w.length) <= 1 && titleSimilarity(p, w) >= 0.75));
export function coverAgrees(catalogueTitle, printed, { full = false, readings = [] } = {}) {
  const lines = String(printed ?? '').split('\n').map((l) => new Set(normTitle(l).split(' ').filter(Boolean))).filter((l) => l.size);
  const all = new Set(lines.flatMap((l) => [...l]));
  const terms = (s) => normTitle(s).split(' ').filter((x) => x.length > 1);
  const [main, ...rest] = String(catalogueTitle ?? '').split(':');
  const m = terms(main);
  if (!m.length || !lines.some((l) => m.filter((w) => wordSeen(w, l)).length >= m.length - (m.length >= 5 ? 1 : 0))) return false;
  const sub = terms(rest.join(' '));
  const mainSet = new Set(m), subSet = new Set(sub);
  for (const r of readings) {
    const w = terms(r ?? '');
    const extra = w.filter((x) => !wordSeen(x, mainSet));
    if (sub.length >= 2 && extra.length >= 2 && w.length - extra.length >= m.length - (m.length >= 5 ? 1 : 0) && !extra.some((x) => wordSeen(x, subSet))) return false;
  }
  return !full || sub.length < 3 || sub.some((w) => wordSeen(w, all));
}

// Consonant outline of a name, the same for Hebrew and its romanization ("Carman" and
// "קרמן" are both krmn): vowels and the letters that stand for them are dropped.
const OUTLINE = { ב: 'b', ג: 'g', ד: 'd', ז: 's', ח: 'k', ט: 't', כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm', נ: 'n', ן: 'n', ס: 's', פ: 'b', ף: 'b', צ: 's', ץ: 's', ק: 'k', ר: 'r', ש: 's', ת: 't' };
const outline = (w) => (isHebrew(w) ? [...w].map((c) => OUTLINE[c] ?? '').join('')
  : w.replace(/tz|ts|sh|zh|z|c(?=[eiy])/g, 's').replace(/ch|kh|ck|x|c|q/g, 'k').replace(/ph|p|f|v|w/g, 'b').replace(/j/g, 'g').replace(/th/g, 't').replace(/[^bdgklmnrst]/g, ''));
function editRatio(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length, 1);
}
// Is one of the catalogue's authors among the names read off the cover? Yes when either
// side has no name: only a clear mismatch says no.
export function authorsAgree(catalogueAuthors, readNames) {
  const names = (list) => list.filter(Boolean).flatMap((n) => normTitle(n).split(' ')).filter((w) => w.length >= 3);
  const [cat, read] = [names(catalogueAuthors ?? []), names(readNames ?? [])];
  if (!cat.length || !read.length) return true;
  return cat.some((c) => read.some((r) => (isHebrew(c) === isHebrew(r) ? titleSimilarity(c, r) >= 0.7
    : Math.min(outline(c).length, outline(r).length) >= 2 && editRatio(outline(c), outline(r)) >= 0.6)));
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
  const located = box;
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
  const read = await readCrop(piece, box[2] - box[0], box[3] - box[1], title);
  // Surya agreed with the title (verified), or, without Surya, the vision model reads it back.
  const ok = !!read && (read.verified || (read.verified === null && sameTitle(read.title, title)));
  await step('find-spine', { note: 'a book only the whole-image read found: located by title, cut out, read back', title, tilt: Math.round(tilt * 10) / 10, verdict: ok ? 'cut-out kept' : 'no cut-out' }, { image: piece });
  const center = [(located[0] + located[2]) / 2, (located[1] + located[3]) / 2];
  const area = cutArea(w, h, box, Math.min(box[2] - box[0], box[3] - box[1]) * 0.06 + 6);
  return ok ? { crop: read.crop, at: here(), read, center, spot: spotOf({ tilt: Math.abs(tilt) >= 5 ? tilt : 0, box: narrowed(box, area, read.across) }, W, H) } : null;
}

// Tesseract's words on a level strip (sparse text). Unlike Surya and the vision model it
// reads upside-down print badly, so it tells which way up a strip is when the other two
// read it both ways (Latin-script spines run bottom to top, Hebrew ones top to bottom).
export async function tesseractWords(jpeg) {
  const { execFile } = await import('node:child_process');
  const { width: w, height: h } = await sharp(jpeg).metadata();
  const k = Math.max(1, Math.min(160 / h, 2400 / w));
  const png = await sharp(jpeg).resize(Math.round(w * k), Math.round(h * k)).extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#ffffff' }).grayscale().png().toBuffer();
  return new Promise((resolve, reject) => {
    const p = execFile('tesseract', ['-', '-', '-l', 'eng+heb', '--psm', '11'], { timeout: 60_000, maxBuffer: 1 << 20 },
      (err, out) => (err ? reject(err) : resolve(out.replace(/\s+/g, ' ').trim())));
    p.stdin.end(png);
  });
}
const UPRIGHT_MARGIN = 0.2;

// One cut-out from a shelf photo: which way up it is, what it says, and a tight
// picture of just that one book. The vision model reads it both ways up, Surya OCR
// reads it both ways up, and the way where the two agree is the right one: each of
// them invents text for print it cannot read (upside-down Hebrew comes out as Latin
// letters), but they never invent the same text. The lines Surya found for the title
// and author mark the one spine; the picture is cut down to that band, so neighbours
// above and below are left out. With no agreement either way the cut-out is not used
// (verified: false). If Surya is not running: the old way, the vision model alone
// (verified: null). title: the book we are looking for (findSpine), read by the
// vision model elsewhere.
const ORIENT_OK = 0.5;
export async function readCrop(img, w, h, title = null, { split = false, ownLines = true } = {}) {
  const spine = h > w * 1.3;
  const angles = spine ? [270, 90] : [0, 180];
  const tries = await Promise.all(angles.map(async (angle) => {
    const jpeg = await sharp(img).rotate(angle).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    const [read, ocr] = await Promise.all([
      generate(jpeg, SPINE_PROMPT, 80).then((line) => (/^NONE\b/i.test(line.trim()) ? null : parseBooks(line.trim().split('\n')[0])[0] ?? null)),
      suryaRead(jpeg).catch(() => null),
    ]);
    return { angle, jpeg, read, ocr };
  }));
  if (tries.some((x) => !x.ocr?.boxes)) {
    // Surya is down: the vision model's reading alone, the clearer one.
    const ok = tries.filter((x) => x.read).sort((a, b) => (a.read.quality === 'low') - (b.read.quality === 'low'))[0];
    await step('crop-read', { note: 'Surya is down: the vision model alone', verdict: ok ? 'kept (unverified)' : 'nothing read', angle: ok?.angle ?? null, title: ok?.read?.title ?? null });
    return ok ? { ...ok.read, crop: ok.jpeg, verified: null, at: here() } : null;
  }
  for (const x of tries) {
    const want = title ? { title, author: x.read?.author } : x.read;
    x.lines = want ? x.ocr.boxes.filter((b) => b.confidence >= 0.5).map((b) => ({ ...b, score: Math.max(overlap(want.title, b.text), 0.8 * overlap(want.author, b.text)) })) : [];
    x.score = Math.max(0, ...x.lines.map((b) => b.score));
  }
  const order = [...tries];
  // Surya reads upside-down print too, so with a title to look for (findSpine) its lines can
  // match both ways up equally; the way the vision model read something wins a tie (or near tie).
  const rank = (x) => x.score + (x.read ? 0.15 : 0);
  let best = tries.sort((a, b) => rank(b) - rank(a))[0];
  // Both ways up confirmed (Latin print is read upside down as well as upright; on 7 Nov 2026
  // four English and Spanish spines were kept upside down): Tesseract decides.
  const other = tries.find((x) => x !== best);
  let upright = null;
  if (other.score >= ORIENT_OK && best.score - other.score < UPRIGHT_MARGIN) {
    const want = best.read ?? other.read ?? (title ? { title, author: null } : null);
    if (want) {
      const texts = await Promise.all([best, other].map((x) => tesseractWords(x.jpeg).catch(() => '')));
      const fit = texts.map((t) => Math.max(overlap(want.title, t), 0.8 * overlap(want.author, t)));
      upright = { angles: [best.angle, other.angle], tesseract: texts, fit: fit.map((f) => Math.round(f * 100) / 100) };
      // Tesseract's text must really hold the title or author the other way up: its garbage
      // from upright print matched "Nehls" 0.4 by chance and turned "The Indoctrinated Brain"
      // over (8 Nov 2026). All right turns in the traces fitted 0.55 or more.
      if (fit[1] - fit[0] >= UPRIGHT_MARGIN && fit[1] >= ORIENT_OK) {
        // Turned over, the reading stays the one Tesseract confirmed (the model may have read
        // a neighbour the other way up); Surya's lines are matched to it again.
        upright.turned = true;
        best = other;
        if (want.quality) best.read = want; // a reading, not just the title looked for
        best.lines = best.ocr.boxes.filter((b) => b.confidence >= 0.5).map((b) => ({ ...b, score: Math.max(overlap(want.title, b.text), 0.8 * overlap(want.author, b.text)) }));
        best.score = Math.max(0, ...best.lines.map((b) => b.score));
      }
    }
  }
  const report = (verdict, images = {}) => step('crop-read', {
    note: `vision model and Surya read it ${spine ? 'turned both ways (270° and 90°)' : 'upright and upside down'}; kept the way where Surya's lines match the model's title (score ≥ ${ORIENT_OK})`,
    looking_for: title, verdict, angle: best.angle, score: Math.round(best.score * 100) / 100, upright,
    tries: order.map((x) => ({ angle: x.angle, read: x.read ? { title: x.read.title, author: x.read.author, quality: x.read.quality } : null, score: Math.round(x.score * 100) / 100,
      lines: x.lines.map((b) => ({ text: b.text, confidence: Math.round(b.confidence * 100) / 100, score: Math.round(b.score * 100) / 100 })) })),
  }, images);
  // Looking for a title (findSpine): the cut-out's title must be in Surya's lines, the author
  // alone is not enough — the model sometimes takes the title from one spine and the
  // author from the next, and the cut then follows the wrong spine.
  if (title && best.score >= ORIENT_OK) {
    const lit = best.ocr.boxes.filter((b) => b.confidence >= 0.5);
    const titleSeen = Math.max(0, ...lit.map((b) => Math.max(overlap(title, b.text), overlap(best.read?.title, b.text))));
    if (titleSeen < ORIENT_OK) {
      await report('dropped: only the author was confirmed (the model may have mixed two spines)');
      return best.read ? { ...best.read, crop: null, verified: false, at: here() } : null;
    }
  }
  if (best.score < ORIENT_OK) {
    // Often two spines in one box: the model read one of them, Surya the other, so they never
    // agree. Surya's lines show where each spine's print is: cut one band per spine and read
    // each band on its own.
    if (split && spine) {
      const many = await splitByLines(tries);
      if (many.length) { await report(`split: the cut-out held ${many.length > 1 ? `${many.length} spines` : 'another spine'}, read band by band`); return many; }
    }
    await report(best.read ? 'dropped: Surya did not confirm the reading either way up' : 'nothing read');
    return best.read ? { ...best.read, crop: null, verified: false, at: here() } : null;
  }
  // Looking for a title (findSpine) that was misread: the band is cut around the lines of what
  // the model read on this cut-out, which is the reading kept.
  let lines = best.lines;
  // (ownLines false: the band of the title looked for, to locate that book.)
  if (title && best.read && ownLines) {
    const own = best.ocr.boxes.filter((b) => b.confidence >= 0.5)
      .map((b) => ({ ...b, score: Math.max(overlap(best.read.title, b.text), 0.8 * overlap(best.read.author, b.text)) }));
    if (own.some((b) => b.score >= 0.4)) lines = own;
  } else if (title && !ownLines) {
    lines = best.ocr.boxes.filter((b) => b.confidence >= 0.5).map((b) => ({ ...b, score: overlap(title, b.text) }));
  }
  let crop = best.jpeg, cutInfo = null;
  // A book lying flat shows its spine as a long level strip: cut and straightened the same way.
  if (spine || w >= 2.5 * h) ({ crop, info: cutInfo } = await spineCut(best.jpeg, lines));
  if (cutInfo) await step('spine-cut', { note: 'this spine turned level for its own lean; its edges found as straight lines at any angle; the neighbour beyond them painted grey', ...cutInfo }, { image: best.jpeg, crop });
  await report('kept', { crop });
  return { ...(best.read ?? { title, author: null, isbn: null, quality: 'medium' }), crop, verified: true, at: here(), across: await acrossOf(best, lines) };
}

// Which band of the cut-out is this book's spine: the lines of its title and author (as
// read level) span it, plus a third of their thickness each side for the cover's edges.
// A cut-out box often holds two or three thin spines; the band marks the one read.
// { axis: 'x' | 'y', range: [a, b] } as fractions of the cut-out (x for a standing spine,
// y for a book lying flat), or null.
async function acrossOf(best, lines) {
  const hits = (lines ?? []).filter((b) => b.score >= 0.4);
  if (!hits.length) return null;
  const { height: Hj } = await sharp(best.jpeg).metadata();
  let y1 = Math.min(...hits.map((b) => b.bbox[1])), y2 = Math.max(...hits.map((b) => b.bbox[3]));
  const pad = (y2 - y1) / 3;
  [y1, y2] = [Math.max(0, y1 - pad) / Hj, Math.min(Hj, y2 + pad) / Hj];
  const r = (v) => Math.round(v * 1000) / 1000;
  // The level picture was turned by best.angle (clockwise): its rows are, in the cut-out,
  // columns (90: left to right, 270: right to left) or rows (0, or 180: bottom to top).
  if (best.angle === 90) return { axis: 'x', range: [r(y1), r(y2)] };
  if (best.angle === 270) return { axis: 'x', range: [r(1 - y2), r(1 - y1)] };
  if (best.angle === 0) return { axis: 'y', range: [r(y1), r(y2)] };
  return { axis: 'y', range: [r(1 - y2), r(1 - y1)] };
}

// The spine's box narrowed to its band (see acrossOf). cut: where the cut-out was taken from
// the picture ({ left, top, width, height }).
export function narrowed(box, cut, across) {
  if (!across) return box;
  const [a, b] = across.range;
  return across.axis === 'x'
    ? [Math.max(box[0], cut.left + a * cut.width), box[1], Math.min(box[2], cut.left + b * cut.width), box[3]]
    : [box[0], Math.max(box[1], cut.top + a * cut.height), box[2], Math.min(box[3], cut.top + b * cut.height)];
}
const cutArea = (W, H, [x1, y1, x2, y2], pad) => {
  const left = Math.max(0, Math.floor(x1 - pad)), top = Math.max(0, Math.floor(y1 - pad));
  return { left, top, width: Math.min(W - left, Math.ceil(x2 - x1 + 2 * pad)), height: Math.min(H - top, Math.ceil(y2 - y1 + 2 * pad)) };
};

// The level cut-out (one way up, as read for readCrop), cut into one band per spine along
// Surya's lines: lines on the same rows are one spine. Each band is read by the vision model
// and kept when Surya's lines in it say the same.
const letterCount = (t) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
async function splitByLines(tries) {
  // The way up Surya reads most surely (upside-down print comes out garbled, less sure).
  const sure = (x) => {
    const ls = x.ocr.boxes.filter((b) => letterCount(b.text) >= 4);
    const n = ls.reduce((acc, b) => acc + letterCount(b.text), 0);
    return n ? ls.reduce((acc, b) => acc + b.confidence * letterCount(b.text), 0) / n : 0;
  };
  const x = [...tries].sort((a, b) => sure(b) - sure(a))[0];
  const all = x.ocr.boxes.filter((b) => b.confidence >= 0.5);
  const strong = all.filter((b) => b.confidence >= 0.7 && letterCount(b.text) >= 4).sort((a, b) => a.bbox[1] - b.bbox[1]);
  const groups = [];
  for (const b of strong) {
    const g = groups.find((gr) => gr.some((o) => Math.min(o.bbox[3], b.bbox[3]) - Math.max(o.bbox[1], b.bbox[1]) > 0.5 * Math.min(o.bbox[3] - o.bbox[1], b.bbox[3] - b.bbox[1])));
    if (g) g.push(b); else groups.push([b]);
  }
  const out = [];
  for (const [k, g] of groups.slice(0, 4).entries()) {
    await scope(`band ${k + 1}`, async () => {
      const text = g.map((b) => b.text).join(' ');
      const { crop: piece, info: cutInfo } = await spineCut(x.jpeg, all.map((b) => ({ ...b, score: g.includes(b) ? 1 : 0 })));
      if (cutInfo) await step('spine-cut', { note: 'this spine turned level for its own lean; its edges found as straight lines at any angle; the neighbour beyond them painted grey', ...cutInfo }, { image: x.jpeg, crop: piece });
      const line = await generate(piece, SPINE_PROMPT, 80);
      const read = /^NONE\b/i.test(line.trim()) ? null : parseBooks(line.trim().split('\n')[0])[0] ?? null;
      const score = read ? Math.max(overlap(read.title, text), 0.8 * overlap(read.author, text)) : 0;
      const ok = score >= ORIENT_OK;
      await step('split-band', { note: 'one spine\'s band, cut along Surya\'s lines and read on its own', angle: x.angle, ocr: g.map((b) => b.text), read: read && { title: read.title, author: read.author }, score: Math.round(score * 100) / 100, verdict: ok ? 'kept' : 'dropped: the model and Surya disagree' }, { crop: piece });
      if (ok) out.push({ ...read, crop: piece, verified: true, at: here() });
    });
  }
  return out;
}

// How much of `want` shows up in `text`: the share of want's letter pairs found in it.
export function overlap(want, text) {
  const pairs = (s) => {
    const n = normTitle(s).replace(/ /g, '');
    return Array.from({ length: Math.max(0, n.length - 1) }, (_, i) => n.slice(i, i + 2));
  };
  const a = pairs(want);
  if (a.length < 2) return 0;
  const b = new Set(pairs(text));
  return a.filter((p) => b.has(p)).length / a.length;
}

// The one spine in a level cut-out: the rows of the title (and author) lines, a little
// more above and below for the spine's own edges, cut at the strongest straight edge
// there (where the next spine starts).
export async function band(jpeg, lines) {
  const hits = lines.filter((b) => b.score >= 0.4).sort((a, b) => b.score - a.score);
  if (!hits.length) return jpeg;
  const first = hits[0].bbox;
  const lineH = first[3] - first[1];
  // Lines of the same spine sit next to the best one, not a spine further on.
  const mine = hits.filter((b) => b.bbox[1] < first[3] + lineH * 0.5 && b.bbox[3] > first[1] - lineH * 0.5);
  let y1 = Math.min(...mine.map((b) => b.bbox[1])), y2 = Math.max(...mine.map((b) => b.bbox[3]));
  // Never cut through other print on the same rows (a bigger title next to the author).
  for (const b of lines) {
    const [t, u] = [b.bbox[1], b.bbox[3]];
    if (Math.min(u, y2) - Math.max(t, y1) > (u - t) * 0.5) { y1 = Math.min(y1, t); y2 = Math.max(y2, u); }
  }
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const th = y2 - y1;
  // Row edge strength: mean change from one row to the next, across the whole width.
  const edge = (y) => {
    let sum = 0;
    for (let x = 0; x < W; x++) sum += Math.abs(data[(y + 1) * W + x] - data[y * W + x]);
    return sum / W;
  };
  const rows = Array.from({ length: H - 1 }, (_, y) => edge(y));
  const median = [...rows].sort((a, b) => a - b)[rows.length >> 1] || 1;
  // Going out from the print: the first clear edge (a local peak well above the usual row
  // change) is where this spine ends and the next begins. The strongest edge further out was
  // often the far side of the neighbour, which then came along in the cut. Print can reach
  // the spine's own edge, so the search starts a little inside the text lines.
  const nearest = (from, to) => {
    const step = from < to ? 1 : -1;
    const ok = (y) => y > 0 && y < H - 2 && rows[y] > median * 3 && rows[y] >= rows[y - 1] && rows[y] >= rows[y + 1];
    for (let y = Math.round(from); step > 0 ? y <= to : y >= to; y += step) if (ok(y)) return y;
    let at = -1, top = median * 2; // no clear edge: the strongest one, as before
    for (let y = Math.max(0, Math.round(Math.min(from, to))); y <= Math.min(H - 2, Math.round(Math.max(from, to))); y++) if (rows[y] > top) { top = rows[y]; at = y; }
    return at;
  };
  const up = nearest(y1 + th * 0.05, y1 - th * 0.6), down = nearest(y2 - th * 0.05, y2 + th * 0.6);
  y1 = up >= 0 ? up : y1 - th * 0.3;
  y2 = down >= 0 ? down + 1 : y2 + th * 0.3;
  // No edge found on a side: a spine is at least half as thick again as its print, so it
  // grows there (never past an edge that was found).
  const short = th * 1.5 - (y2 - y1);
  if (short > 0 && (up < 0 || down < 0)) {
    if (up < 0 && down < 0) { y1 -= short / 2; y2 += short / 2; } else if (up < 0) y1 -= short; else y2 += short;
  }
  const top = Math.max(0, Math.floor(y1)), height = Math.min(H, Math.ceil(y2)) - top;
  if (height < 12) return jpeg;
  return sharp(jpeg).extract({ left: 0, top, width: W, height }).jpeg({ quality: 90 }).toBuffer();
}

// The final cut of one spine at its own angle. The cut-out was turned level for the lean of
// its whole group, but each book leans a little its own way, and a neighbour that leans
// differently leaves a slanted edge that no level cut can follow. So: (1) the lean of this
// spine's own print is measured and the picture turned to make it level; (2) above and below
// the print, the edge where this spine ends is searched for as a straight line at any angle
// up to ±6° (the strongest colour change along a line that does not cross the print);
// (3) the cut takes in both lines, and what lies beyond them (the neighbour's wedge) is
// painted light grey. A side with no clear line falls back to the level cut of band().
const EDGE_MIN = 40; // mean colour change across a line (sum of R, G, B) that counts as an edge
export async function spineCut(jpeg, lines) {
  const hits = lines.filter((b) => b.score >= 0.4).sort((a, b) => b.score - a.score);
  if (!hits.length) return { crop: jpeg, info: null };
  const first = hits[0].bbox;
  const lineH = first[3] - first[1];
  const mine = hits.filter((b) => b.bbox[1] < first[3] + lineH * 0.5 && b.bbox[3] > first[1] - lineH * 0.5);
  const ux1 = Math.max(0, Math.min(...mine.map((b) => b.bbox[0]))), ux2 = Math.max(...mine.map((b) => b.bbox[2]));
  let y1 = Math.min(...mine.map((b) => b.bbox[1])), y2 = Math.max(...mine.map((b) => b.bbox[3]));
  const { width: W, height: H } = await sharp(jpeg).metadata();
  const th = y2 - y1;
  if (th < 6 || ux2 - ux1 < 30) return { crop: await band(jpeg, lines), info: null };

  // (1) This spine's own lean, from its print. The print alone can mislead (a slanted
  // ornament, letters' own strokes), so the cut is tried both as it is and turned by that
  // lean, and the one whose edges come out stronger and more level is kept.
  let measured = 0;
  try {
    const txt = await sharp(jpeg).extract({ left: Math.round(ux1), top: Math.max(0, Math.round(y1)), width: Math.round(Math.min(W, ux2) - ux1), height: Math.round(Math.min(H, y2) - Math.max(0, y1)) }).toBuffer();
    measured = await dominantTilt(txt);
  } catch { /* level as it is */ }
  if (Math.abs(measured) < 0.7 || Math.abs(measured) > 12) measured = 0;

  const attempt = async (lean) => {
    let img = jpeg, W2 = W, H2 = H;
    if (lean) {
      const turned = await sharp(jpeg).rotate(-lean, { background: '#ffffff' }).toBuffer({ resolveWithObject: true });
      img = turned.data; W2 = turned.info.width; H2 = turned.info.height;
    }
    // All the print on this spine's rows (title, author, publisher) is kept whole: its boxes in
    // the level picture. A slanted line of print filled a taller box than its own height.
    const tan = Math.abs(Math.tan(lean * Math.PI / 180));
    const level = ([a, b, c, d]) => {
      const [cx0, cy0] = lean ? rotatePoint([(a + c) / 2, (b + d) / 2], W, H, -lean) : [(a + c) / 2, (b + d) / 2];
      const hw = (c - a) / 2 * Math.cos(lean * Math.PI / 180), hh = Math.max((d - b) * 0.5, (d - b) - (c - a) * tan) / 2;
      return [cx0 - hw, cy0 - hh, cx0 + hw, cy0 + hh];
    };
    const print = lines.filter((b) => mine.includes(b) || Math.min(b.bbox[3], y2) - Math.max(b.bbox[1], y1) > (b.bbox[3] - b.bbox[1]) * 0.5).map((b) => level(b.bbox));
    const ty1 = Math.min(...print.map((b) => b[1])), ty2 = Math.max(...print.map((b) => b[3]));
    const { data } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x, y, c) => data[(y * W2 + x) * 3 + c];
    const cx = W2 / 2;
    // (2) The best straight edge on one side of the print.
    const search = (side, margin) => {
      let best = null;
      const edgeY = side < 0 ? ty1 : ty2;
      for (let deg = -6; deg <= 6; deg += 0.5) {
        const slope = Math.tan(deg * Math.PI / 180);
        // From inside the OCR box (a slanted edge can cross the middle there) to well outside.
        for (let d = -Math.round(th * margin); d <= th * 0.9; d++) {
          const y0 = edgeY + side * d;
          const at = (x) => y0 + (x - cx) * slope;
          // Never through the print: over each line of print the edge stays clear of it
          // (Surya's boxes run beyond the letters: their outer `margin` may be crossed).
          if (print.some((b) => { const m = (b[3] - b[1]) * margin; return side < 0 ? Math.max(at(b[0]), at(b[2])) > b[1] + m : Math.min(at(b[0]), at(b[2])) < b[3] - m; })) continue;
          let sum = 0, n = 0, all = 0;
          for (let x = 1; x < W2 - 1; x += 3) {
            all++;
            const y = Math.round(at(x));
            if (y < 3 || y > H2 - 4) continue;
            let dd = 0;
            for (let c = 0; c < 3; c++) dd += Math.abs(px(x, y - 2, c) - px(x, y + 2, c));
            sum += dd; n++;
          }
          if (n < all * 0.6) continue;
          const strength = sum / n;
          // The nearer and the more level edge, all else equal (this spine is level now).
          const score = strength * (1 - 0.3 * Math.max(0, d) / (th * 0.9)) * (1 - Math.abs(deg) / 18);
          if (!best || score > best.score) best = { score, strength, deg, y0, slope };
        }
      }
      return best && best.strength >= EDGE_MIN ? best : null;
    };
    // A neighbour's slanted edge can come within a few pixels of this spine's letters: it may
    // reach deeper into the OCR box only when it is far the clearest edge there.
    const edge = (side) => {
      const safe = search(side, 0.12), close = search(side, 0.45);
      return close && close.strength >= 150 && (!safe || close.score >= 2 * safe.score) ? close : safe;
    };
    let top = edge(-1), bottom = edge(1);
    // Edges far apart in angle are not both right (a spine's sides are nearly parallel, though
    // a neighbour's edge may slant): the clearer one is kept, the other side cut level.
    if (top && bottom && Math.abs(top.deg - bottom.deg) > 3) { if (top.score >= bottom.score) bottom = null; else top = null; }
    const score = (top?.score ?? 0) + (bottom?.score ?? 0);
    return { lean, W2, H2, px, cx, ty1, ty2, top, bottom, score };
  };
  const tries = [await attempt(0)];
  if (measured) tries.push(await attempt(measured));
  const pick = tries.sort((p, q) => q.score - p.score)[0];
  const { lean, W2, H2, px, cx, ty1, ty2, top, bottom } = pick;
  if (!pick.score) return { crop: await band(jpeg, lines), info: { lean: Math.round(measured * 10) / 10, top: null, bottom: null, note: 'no clear edge: level cut' } };
  // A side without a clear edge: level, a third of the print's height out (as band() would).
  const tth = ty2 - ty1;
  const lineAt = (e, fallback) => (e ? (x) => e.y0 + (x - cx) * e.slope : () => fallback);
  const yTop = lineAt(top, ty1 - tth * 0.3), yBot = lineAt(bottom, ty2 + tth * 0.3);
  const r0 = Math.max(0, Math.floor(Math.min(yTop(0), yTop(W2 - 1))));
  const r1 = Math.min(H2, Math.ceil(Math.max(yBot(0), yBot(W2 - 1))));
  if (r1 - r0 < 12) return { crop: await band(jpeg, lines), info: null };
  // (3) Only this spine: beyond its edges, light grey.
  const out = Buffer.alloc(W2 * (r1 - r0) * 3);
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < W2; x++) {
      const o = ((y - r0) * W2 + x) * 3;
      const outside = y < yTop(x) || y > yBot(x);
      for (let c = 0; c < 3; c++) out[o + c] = outside ? 236 : px(x, y, c);
    }
  }
  const crop = await sharp(out, { raw: { width: W2, height: r1 - r0, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  const info = { lean: Math.round(lean * 10) / 10, top: top && { deg: top.deg, strength: Math.round(top.strength) }, bottom: bottom && { deg: bottom.deg, strength: Math.round(bottom.strength) } };
  return { crop, info };
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
  await step('detect', {
    note: `the vision model's boxes; lean measured inside each (under 5° = straight)`,
    W, H, boxes: boxes.map((b) => ({ box: b.slice(0, 4).map(Math.round), tilt: Math.round(b.tilt * 10) / 10 })),
  }, { image: upright });

  const crops = [];
  const straight = boxes.filter((b) => Math.abs(b.tilt) < 5);
  const padOf = (b) => Math.min(b[2] - b[0], b[3] - b[1]) * 0.06 + 6;
  for (const b of straight) crops.push({ img: await cut(upright, W, H, b, padOf(b)), w: b[2] - b[0], h: b[3] - b[1], from: 'straight', box: b.slice(0, 4).map(Math.round), tilt: Math.round(b.tilt * 10) / 10, place: { tilt: 0, box: b.slice(0, 4) }, area: cutArea(W, H, b, padOf(b)) });

  // Lean groups: tilts within 6° of each other, the biggest groups first.
  const groups = [];
  for (const b of boxes.filter((x) => Math.abs(x.tilt) >= 5).sort((a, z) => a.tilt - z.tilt)) {
    const g = groups.at(-1);
    if (g && b.tilt - g[0].tilt < 6) g.push(b); else groups.push([b]);
  }
  groups.sort((a, z) => z.length - a.length);
  for (const [gi, g] of groups.slice(0, MAX_TILT_GROUPS).entries()) {
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
    const fallback = !found.length;
    if (fallback) found = area;
    await step('lean-group', {
      note: fallback ? 'no boxes found in the turned photo: the leaning boxes are used' : 'photo turned upright for this lean, boxes found again',
      tilt: Math.round(tilt * 10) / 10, boxes_in_group: g.length, W: W2, H: H2, area: area.map((a) => a.map(Math.round)), boxes: found.map((b) => ({ box: b.slice(0, 4).map(Math.round) })),
    }, { image: turned.data });
    for (const b of found.slice(0, MAX_SPINES)) {
      crops.push({ img: await cut(turned.data, W2, H2, b, padOf(b)), w: b[2] - b[0], h: b[3] - b[1], from: `lean group ${gi + 1}`, box: b.slice(0, 4).map(Math.round), tilt: Math.round(tilt * 10) / 10, place: { tilt, box: b.slice(0, 4) }, area: cutArea(W2, H2, b, padOf(b)) });
    }
  }

  const books = [];
  for (const [k, { img, w, h, from, box, tilt, place, area }] of crops.slice(0, MAX_SPINES * 2).entries()) {
    const b = await scope(`cut-out ${k + 1}`, async () => {
      await step('cut-out', { from, w: Math.round(w), h: Math.round(h), box, tilt }, { image: img });
      return readCrop(img, w, h, null, { split: true });
    });
    // A reading neither way up confirmed by OCR came from a jumble or upside-down print.
    // The outline kept is the spine's own band of the cut-out (split bands have none: the box).
    for (const x of [].concat(b ?? [])) if (x.verified !== false) books.push({ ...x, place, spot: spotOf({ tilt: place.tilt, box: narrowed(place.box, area, x.across) }, W, H) });
  }
  // Boxes overlap, so one spine can be read from two cut-outs: alike readings from cut-outs
  // that overlap are one book.
  const kept = [];
  for (const b of books) {
    const twin = kept.find((o) => o.place.tilt === b.place.tilt && o.place.box[0] < b.place.box[2] && b.place.box[0] < o.place.box[2]
      && titleSimilarity(o.title, b.title) >= 0.6);
    if (twin) { await step('same-spine', { note: 'read again from an overlapping cut-out: counted once', title: b.title, same_as: twin.title }); continue; }
    kept.push(b);
  }
  return kept;
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
  const timer = setTimeout(() => ctrl.abort(), config.vision.timeoutMs);
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
  const books = parseBooks(text);
  for (const b of books) b.at = here();
  await step('whole-read', { note: 'the whole picture read at once (stops early if the model repeats a line)', prompt: PROMPT, answer: text, books: books.map(brief) }, { image: jpeg }, { side: 1000 });
  return books;
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
    if (!dup.crop && b.crop) Object.assign(dup, { crop: b.crop, verified: b.verified, at: b.at, spot: b.spot });
    dup.spot ??= b.spot;
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

// How alike two readings of one title are, 0–1, for the same spine read in different
// video frames ("הולדת ונוס" / "הולדת ונום", "יום שני כחול" / "ים שני כחל"): edit
// distance where a look-alike Hebrew letter, a ו/י written or left out, or two letters
// swapped cost less; the same words in another order count as alike. Readings with
// different numbers in them (volume 1 and volume 2) are not alike.
const CHEAP = new Set(LOOKALIKE.map(([a, b]) => a + b).concat(LOOKALIKE.map(([a, b]) => b + a)));
const cost = (a, b) => (a === b ? 0 : CHEAP.has(a + b) ? 0.4 : 1);
const gapCost = (c) => ('וי'.includes(c) ? 0.4 : 1);
export function titleSimilarity(a, b) {
  const [x, y] = [normTitle(a), normTitle(b)];
  if (!x || !y) return 0;
  if (x === y) return 1;
  if ((x.match(/\d+/g) ?? []).join() !== (y.match(/\d+/g) ?? []).join()) return 0;
  if (x.split(' ').sort().join(' ') === y.split(' ').sort().join(' ')) return 0.95;
  const [p, q] = [[...x.replace(/ /g, '')], [...y.replace(/ /g, '')]];
  const d = [Array(q.length + 1).fill(0)];
  for (let j = 1; j <= q.length; j++) d[0][j] = d[0][j - 1] + gapCost(q[j - 1]);
  for (let i = 1; i <= p.length; i++) {
    d[i] = [d[i - 1][0] + gapCost(p[i - 1])];
    for (let j = 1; j <= q.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + gapCost(p[i - 1]), d[i][j - 1] + gapCost(q[j - 1]), d[i - 1][j - 1] + cost(p[i - 1], q[j - 1]));
      if (i > 1 && j > 1 && p[i - 1] === q[j - 2] && p[i - 2] === q[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 0.6);
    }
  }
  return Math.max(0, 1 - d[p.length][q.length] / Math.max(p.length, q.length));
}

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
