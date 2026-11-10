// Confidence rules (src/confidence.js) on real cases from the approval queue, Nov 2026.
//   node --test scripts/confidence-test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceOf } from '../src/confidence.js';

const read = (title, author, frames = [1], verified = true) =>
  ({ stage: 'read', source: 'vision+ocr', outcome: 'as_read', after: title, detail: { author, frames, verified } });
const spine = (title, author, evidence, more = {}) => ({ title, author, via: 'vision', crop: 'c.webp', verified: true, quality: 'medium', evidence, ...more });

test('seen twice, its own author, the main title: sure', () => {
  const item = spine('אני הורג', "ג'ורג'ו פאלטי", [read('אני הורג', "ג'ורג'ו פאלטי", [1, 2])]);
  assert.deepEqual(confidenceOf(item, { title: 'אני הורג', authors: ["ג'ורג'ו פאלטי"] }), [92, 'sure']);
});

test('seen once: catalogue + OCR', () => {
  const item = spine('The Clot Thickens', 'Malcolm Kendrick', [read('The Clot Thickens', 'Malcolm Kendrick')]);
  assert.deepEqual(confidenceOf(item, { title: 'The Clot Thickens: The Enduring Mystery', authors: ['Malcolm Kendrick'] }), [90, 'catalogue_ocr']);
});

test('a record naming no author', () => {
  const item = spine('גילה אלמגור', 'הקיץ של אביה', [read('גילה אלמגור', 'הקיץ של אביה')]);
  assert.deepEqual(confidenceOf(item, { title: 'גילה אלמגור', authors: [] }), [60, 'catalogue_no_author']);
});

test('corrected, then a record by someone else', () => {
  const item = spine('אל תלכי לשם', 'הדסה בן-עתו', [read('הדסה ב-ןעתו אל תלכי לשם', 'עקבי, יוחנן'),
    { stage: 'correct', source: 'index:hewiki', outcome: 'corrected', detail: { candidates: [{ ok: true, as: 0.5 }] } }]);
  assert.deepEqual(confidenceOf(item, { title: 'אל תלכי: חמישה סיפורים', authors: ['רותי טננולד'] }), [50, 'catalogue_other_author']);
});

test('an index correction that replaced the author by an unlike name', () => {
  const item = spine('על אדם עם אדם', 'אלי אילון', [read('אל, אדם, עולם', 'אלישבע זלצר'),
    { stage: 'correct', source: 'index:hewiki', outcome: 'corrected', detail: { candidates: [{ ok: true, as: 0.5 }] } }]);
  assert.deepEqual(confidenceOf(item, { title: 'על אדם עם אדם', authors: ['אלי אילון'] }), [60, 'corrected_weak_author']);
});

test('no author read off the spine', () => {
  const item = spine('3RD DEGREE', null, [read('3RD DEGREE', null, [1, 2])]);
  assert.deepEqual(confidenceOf(item, { title: '3rd Degree', authors: ['James Patterson'] }), [70, 'catalogue_no_author_read']);
});

test('no spine cut-out: whole shelf only', () => {
  const item = spine('The Millionaire Next Door', 'Thomas J. Stanley', [read('The Millionaire Next Door', 'Thomas J. Stanley')], { crop: null });
  assert.deepEqual(confidenceOf(item, { title: 'The Millionaire Next Door', authors: ['Thomas J. Stanley'] }), [45, 'catalogue_whole']);
});
