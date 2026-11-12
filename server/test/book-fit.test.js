// Book pages that show another book than the one photographed get noindex (seo.js titleFits).
// Cases from the live pages on 12 Nov 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFits } from '../src/seo.js';

test('a wrong catalogue match does not fit what was read', () => {
  assert.equal(titleFits('ארוחת הערב החגיגית השביעית: אורחי הכבוד ג\'נט ואברהם הלפרין', 'ארוחת הערב הרמן קור ארוחת הערב חרמן קוֹך', ['Israel Council of "Yisrael Hatzair"']), false);
  assert.equal(titleFits('Charlotte\'s Web with Stuart Little and Trumpet of the Swan', 'THE TRUMPET OF THE WIND E.D. WHITE', ['E. B. White']), false);
});

test('OCR slips, spelling variants and subtitles still fit', () => {
  assert.equal(titleFits('לוקה ויטיאלו', 'לוקה ויטיאל קורה ריייל'), true);
  assert.equal(titleFits('היהודייה מטולדו : רומן', 'היהודיה מטולדו ליון פויכטוונגר'), true);
  assert.equal(titleFits('You can win: winners don\'t do different things they do things differently', 'WINNERS DON\'T DO DIFFERENT THINGS THEY DO THINGS DIFFERENTLY SHIV KHERA'), true);
  assert.equal(titleFits('Penguin Readers Starter Level: the Knight\'s Tale', 'The Knight\'s Tale Geoffrey Chaucer'), true);
  assert.equal(titleFits('Eleanor & Park', 'Park rainbow rowell', ['Rainbow Rowell']), true);
});

test('nothing read (barcode, typed by a reader): trusted', () => {
  assert.equal(titleFits('Anything', ''), true);
  assert.equal(titleFits('Anything', null), true);
});
