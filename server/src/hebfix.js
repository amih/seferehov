// Hebrew OCR mixes up letters that look alike in print (ד/ר, ב/כ, ק/פ…). A word the
// Hebrew spell checker (hspell) does not know is replaced by the one spelling, one
// look-alike letter (or one י, or one doubled letter) away, that it does know. When
// two such spellings are equally likely, or the word is short, it is left alone.
// Measured on a back cover: 92% of words right before, 95% after. Without hspell
// installed (apt install hspell) the text is returned as it is.
import { spawn } from 'node:child_process';
import { step } from './trace.js';

// Most common confusions first: the rank breaks ties between candidates.
export const LOOKALIKE = [['ד', 'ר'], ['ב', 'כ'], ['ק', 'פ'], ['ה', 'ח'], ['ו', 'ז'], ['ו', 'י'], ['ק', 'מ'], ['ח', 'ת'],
  ['ה', 'ת'], ['ן', 'ו'], ['ם', 'ס'], ['ט', 'מ'], ['נ', 'ג'], ['ע', 'צ']];
const WORD = /[א-ת֑-ׇ]+/g;
const plain = (w) => w.replace(/[֑-ׇ]/g, '');

// hspell speaks ISO-8859-8: Hebrew letters are 0xE0–0xFA there.
const toLatin8 = (s) => Buffer.from([...s].map((c) => { const n = c.charCodeAt(0); return n >= 0x5d0 && n <= 0x5ea ? n - 0x5d0 + 0xe0 : n < 128 ? n : 0x20; }));
const fromLatin8 = (b) => [...b].map((n) => (n >= 0xe0 && n <= 0xfa ? String.fromCharCode(n - 0xe0 + 0x5d0) : String.fromCharCode(n))).join('');

// The words hspell does not know.
function unknown(words) {
  if (!words.length) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const p = spawn('hspell', [], { timeout: 60_000 });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', reject);
    p.on('close', () => resolve(new Set(fromLatin8(Buffer.concat(out)).split('\n').slice(1).map((l) => l.trim()).filter(Boolean))));
    p.stdin.end(toLatin8(words.join('\n')));
  });
}

function candidates(w) {
  const c = new Map();
  const add = (s, rank) => { if (!c.has(s)) c.set(s, rank); };
  [...w].forEach((ch, i) => {
    LOOKALIKE.forEach(([a, b], rank) => {
      if (ch === a) add(w.slice(0, i) + b + w.slice(i + 1), rank);
      if (ch === b) add(w.slice(0, i) + a + w.slice(i + 1), rank);
    });
    if (i && w[i - 1] === ch) add(w.slice(0, i) + w.slice(i + 1), 3);
  });
  for (let i = 1; i < w.length; i++) add(`${w.slice(0, i)}י${w.slice(i)}`, 6);
  return c;
}

export async function fixHebrew(text) {
  try {
    const words = [...new Set((text.match(WORD) ?? []).map(plain).filter((w) => w.length >= 4))];
    const wrong = [...await unknown(words)].map((w) => [w, candidates(w)]);
    const bad = await unknown([...new Set(wrong.flatMap(([, c]) => [...c.keys()]))]);
    const fix = new Map();
    for (const [w, c] of wrong) {
      const ok = [...c].filter(([s]) => !bad.has(s)).sort((a, b) => a[1] - b[1]);
      if (ok.length && (ok.length === 1 || ok[0][1] < ok[1][1])) fix.set(w, ok[0][0]);
    }
    await step('spell-check', { note: 'hspell: unknown words swapped for the one known word a look-alike letter away', unknown: wrong.map(([w]) => w), changes: [...fix] });
    return text.replace(WORD, (m) => fix.get(plain(m)) ?? m);
  } catch {
    return text;
  }
}
