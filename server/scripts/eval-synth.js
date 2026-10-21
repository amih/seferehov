// Back covers with known text, for scripts/eval.js (synth): real Hebrew prose (the
// opening of random Hebrew Wikipedia articles) set in the Culmus fonts (apt install
// culmus) on a coloured cover, then spoiled the way phone photos are — turned a little,
// lit unevenly, blurred, noisy, JPEG-squeezed, lying on a table. The text put in is the
// truth, so word accuracy is measured without anyone typing it. Easier than real covers
// (one block of text, clean fonts): good for comparing engines and changes, and for
// calibrating the spell-check rate (see eval.js) that estimates accuracy on real photos.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const FONTS = ['David CLM', 'Frank Ruehl CLM', 'Miriam CLM', 'Nachlieli CLM', 'Simple CLM', 'Aharoni CLM', 'Drugulin CLM', 'Ellinia CLM', 'Hadasim CLM', 'Yehuda CLM', 'Keter YG', 'Shofar', 'DejaVu Sans', 'FreeSans', 'FreeSerif', 'Liberation Sans'];
// Background / ink pairs, light and dark covers.
const PALETTES = [['#f4efe4', '#1d1d1d'], ['#ffffff', '#222244'], ['#fde9c9', '#5a2a0a'], ['#e8f1f5', '#0d3b4f'], ['#1c2a39', '#f2f2f2'], ['#5b1a1a', '#fbe9d0'], ['#203b2a', '#eaf3e1'], ['#d9d2e9', '#2b1840']];
export const LEVELS = ['clean', 'phone', 'hard'];

// A tiny seeded random, so the same seed gives the same set.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function wikiTexts(n) {
  const out = [];
  const seen = new Set();
  const url = 'https://he.wikipedia.org/w/api.php?action=query&format=json&generator=random&grnnamespace=0&grnlimit=20&prop=extracts&exintro=1&explaintext=1&exlimit=20';
  for (let tries = 0; out.length < n && tries < n + 20; tries++) {
    const res = await fetch(url, { headers: { 'user-agent': 'seferehov-eval/1.0 (ami@seferehov.com)' } });
    if (!res.ok) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    for (const pg of Object.values((await res.json()).query?.pages ?? {})) {
      const text = String(pg.extract ?? '').replace(/[\u0591-\u05C7]/g, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      // Prose of blurb length, mostly Hebrew letters.
      const heb = (text.match(/[א-ת]/g) ?? []).length;
      if (out.length >= n || text.length < 180 || heb / text.length < 0.6 || seen.has(pg.title)) continue;
      seen.add(pg.title);
      out.push({ title: pg.title.replace(/\s*\([^)]*\)/g, ''), text: text.slice(0, 650).replace(/\s+\S*$/, '') });
    }
  }
  return out;
}

const escMarkup = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function render({ title, text }, level, rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const [bg, ink] = pick(PALETTES);
  const font = pick(FONTS);
  const W = 1200, H = 1800;
  // The whole text must be on the cover (it is the truth): smaller until it fits.
  let size = Math.round(40 + rand() * 18), block;
  for (;;) {
    block = await sharp({ text: {
      text: `<span foreground="${ink}"><span size="${Math.round(size * 1.6)}pt"><b>${escMarkup(title)}</b></span>\n\n${escMarkup(text)}</span>`,
      font: `${font} ${size}`, width: W - 200, align: 'left', rtl: true, rgba: true, dpi: 72, spacing: Math.round(size * 0.4),
    } }).png().toBuffer({ resolveWithObject: true });
    if (block.info.height <= H - 300 || size <= 24) break;
    size -= 4;
  }
  let cover = await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
    .composite([{ input: block.data, top: 180, left: W - 100 - block.info.width }]).png().toBuffer();
  if (level === 'clean') return { buffer: await sharp(cover).jpeg({ quality: 92 }).toBuffer(), font, size };

  // Uneven light: a soft dark corner.
  const shade = Buffer.from(`<svg width="${W}" height="${H}"><defs><radialGradient id="g" cx="${rand()}" cy="${rand()}" r="1.1">
    <stop offset="0.3" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${level === 'hard' ? 0.55 : 0.3}"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`);
  cover = await sharp(cover).composite([{ input: shade }]).png().toBuffer();
  // Lying on a table, photographed a little turned, from a distance.
  const angle = (rand() - 0.5) * (level === 'hard' ? 14 : 6);
  const table = pick(['#6b4f3a', '#3c3c3c', '#a89f91', '#2f3b2f']);
  const turned = await sharp(cover).rotate(angle, { background: table }).png().toBuffer({ resolveWithObject: true });
  const pad = Math.round(80 + rand() * 120);
  let img = sharp(turned.data).extend({ top: pad, bottom: pad, left: pad, right: pad, background: table });
  const scale = level === 'hard' ? 0.45 + rand() * 0.2 : 0.6 + rand() * 0.3;
  img = sharp(await img.png().toBuffer()).resize(Math.round((turned.info.width + 2 * pad) * scale));
  const blur = level === 'hard' ? 0.9 + rand() * 0.8 : 0.3 + rand() * 0.6;
  const { data, info } = await img.blur(blur).raw().toBuffer({ resolveWithObject: true });
  // Sensor noise.
  const amp = level === 'hard' ? 18 : 8;
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + (rand() - 0.5) * amp));
  const buffer = await sharp(data, { raw: info }).jpeg({ quality: level === 'hard' ? 55 : 78 }).toBuffer();
  return { buffer, font, size, angle: Math.round(angle * 10) / 10, blur: Math.round(blur * 10) / 10, scale: Math.round(scale * 100) / 100 };
}

// n covers at each level, as eval.js items (set 'synth').
export async function makeSynth(dir, n, seed = 1) {
  await mkdir(join(dir, 'img'), { recursive: true });
  const texts = await wikiTexts(n);
  const rand = rng(seed);
  const items = [];
  for (const [k, t] of texts.entries()) {
    for (const level of LEVELS) {
      const r = await render(t, level, rand);
      const id = `y-${seed}-${k}-${level}`;
      const file = `img/${id}.jpg`;
      await writeFile(join(dir, file), r.buffer);
      const { buffer, ...how } = r;
      items.push({ id, file, set: 'synth', kind: 'back', level, title: null, truth: `${t.title}\n${t.text}`, source: `he.wikipedia.org: ${t.title}`, ...how, status: 'done' });
    }
  }
  return items;
}
