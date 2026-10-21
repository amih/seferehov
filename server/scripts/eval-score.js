// Scores for scripts/eval.js: how close a reading is to the checked text. Words are
// compared after normTitle (lower case, no punctuation, no vowel points); final letters
// stay as printed, so ם read as ס counts as a mistake.
import { normTitle } from '../src/vision.js';

const words = (s) => normTitle(s).split(' ').filter(Boolean);

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Share of the true words found in the reading, in any order (a cover's columns and
// boxes may come out in another order without any word being wrong).
export function wordsFound(truth, read) {
  const want = words(truth);
  if (!want.length) return null;
  const have = new Map();
  for (const w of words(read)) have.set(w, (have.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of want) if (have.get(w) > 0) { hit++; have.set(w, have.get(w) - 1); }
  return hit / want.length;
}

// Share of the words read that are real (on the cover): low when a model invents text.
export function wordsReal(truth, read) {
  const got = words(read);
  if (!got.length) return null;
  return wordsFound(read, truth);
}

// 1 − word error rate, in reading order, never below 0.
export function wordAccuracy(truth, read) {
  const a = words(truth);
  if (!a.length) return null;
  return Math.max(0, 1 - editDistance(a, words(read)) / a.length);
}

// 1 − character error rate (spaces between words count as one character).
export function charAccuracy(truth, read) {
  const a = [...words(truth).join(' ')];
  if (!a.length) return null;
  return Math.max(0, 1 - editDistance(a, [...words(read).join(' ')]) / a.length);
}

// Share of the title's words in the reading (the catalogue title may carry a subtitle
// the spine leaves out, so 0.8 counts as found).
export const titleFound = wordsFound;
export const TITLE_HIT = 0.8;

export const mean = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
export const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
