import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixedWord, surelyHebrew, ocrHebrewFor } from '../src/vision.js';

const ocr = (...texts) => ({ boxes: texts.map((text) => ({ text, confidence: 0.9 })) });

test('mixedWord: a word turning to Latin or Arabic letters halfway', () => {
  assert.equal(mixedWord('ניקוס קסנakis'), true);
  assert.equal(mixedWord("לורנס ס' סמيث"), true);
  assert.equal(mixedWord('הכלה המשחררת'), false);
  assert.equal(mixedWord('ה-DNA של העסק'), false); // two words
  assert.equal(mixedWord('Harry Potter והאבן'), false); // whole words in each script
  assert.equal(mixedWord(null), false);
});

test('surelyHebrew: Hebrew reading and Hebrew print found by the OCR', () => {
  assert.equal(surelyHebrew({ title: 'זורבה היווני', author: 'ניקוס קסנakis' }, ocr('זורבה היווני')), true);
  assert.equal(surelyHebrew({ title: 'זורבה היווני', author: 'ניקוס קסנakis' }, ocr('ZORBA')), false);
  assert.equal(surelyHebrew({ title: 'The Greek', author: 'Kazantzakis' }, ocr('זורבה')), false);
});

test('ocrHebrewFor: only the mixed word is replaced, by the OCR word for it', () => {
  assert.equal(ocrHebrewFor("העולם בשנת 2050 לורנס ס' סמيث", ocr("הלה בשנה 2050 לורנס ס '", 'סמית')), "העולם בשנת 2050 לורנס ס' סמית");
  assert.equal(ocrHebrewFor('ניקוס קסנakis', ocr('Kazantzakis')), null);
});
