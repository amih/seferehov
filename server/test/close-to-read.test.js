// A correction is taken only when close to what was read (src/refindex.js closeToRead):
// real fixes and wrong matches from lab 055 (413 approved spines, 20 Nov 2026).
//   node --test test/   (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeToRead } from '../src/refindex.js';

test('kept: a letter misread', () => assert.ok(closeToRead('שעות קהות', 'שעות מתות', ['אורי אדלמן'])));
test('kept: a cut-off English title completed', () => assert.ok(closeToRead('THE NURSES SAW', 'What the Nurses Saw: An Investigation into Systemic Medical Failures', ['Ken McCarthy'])));
test('kept: words read out of order', () => assert.ok(closeToRead('מצטערת מצטערת שאני לא', 'מצטערת שאני לא מצטערת', ['קרולין מקלר'])));
test('kept: title and author read the wrong way round', () => assert.ok(closeToRead('ידיעות אחרונות', 'Naomi Shemer № 3', ['ידיעות אחרונות'])));
test('kept: the subtitle read as the title', () => assert.ok(closeToRead('Collected Studies of Jonas C. Greenfield on Semitic Philology', 'Al Kanfei Yonah: Collected Studies of Jonas C. Greenfield on Semitic Philology', [])));
test('blocked: another book by the same author', () => assert.ok(!closeToRead('המטרה בצל עץ', 'המסע בצל המטרה', ['איציק פלג'])));
test('blocked: a different book', () => assert.ok(!closeToRead('אחרי מוות', 'ילד', ['אמיר אור'])));
test('blocked: the author read as the title', () => assert.ok(!closeToRead('נופים איטליים חבל איילת', 'מנחם מרכוס', ['שמעון לב'])));
test('no reading: nothing to compare', () => assert.ok(closeToRead(null, 'ספר', [])));
