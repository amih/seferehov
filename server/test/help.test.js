// Help check (src/help.js helpVerdict): when the volunteers' votes settle a book.
//   node --test test/   (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpVerdict } from '../src/help.js';

const v = (vote, trusted = false) => ({ vote, trusted });

test('no votes, or one vote by a new volunteer: still open', () => {
  assert.equal(helpVerdict([]), null);
  assert.equal(helpVerdict([v(true)]), null);
  assert.equal(helpVerdict([v(false)]), null);
});

test('two volunteers say right, nobody wrong: approved', () => {
  assert.equal(helpVerdict([v(true), v(true)]), 'approved');
});

test('two volunteers say wrong, nobody right: declined', () => {
  assert.equal(helpVerdict([v(false), v(false)]), 'declined');
});

test('mixed votes stay open, however many', () => {
  assert.equal(helpVerdict([v(true), v(false)]), null);
  assert.equal(helpVerdict([v(true), v(false), v(true)]), null);
  assert.equal(helpVerdict([v(false), v(true), v(false)]), null);
});

test('one trusted volunteer settles it alone, mixed votes included', () => {
  assert.equal(helpVerdict([v(true, true)]), 'approved');
  assert.equal(helpVerdict([v(false, true)]), 'declined');
  assert.equal(helpVerdict([v(true), v(false), v(true, true)]), 'approved');
  assert.equal(helpVerdict([v(true), v(false, true)]), 'declined');
});
