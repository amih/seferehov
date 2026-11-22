import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, stateFor } from '../../web/src/nav.js';

// Walks a fake history the way the browser would, with plan() deciding each step.
function browser(start = '/') {
  const entries = [{ url: start, state: stateFor(null, start) }];
  let i = 0;
  const go = (to, opt) => {
    const p = plan(entries[i].state, entries[i].url, to, opt);
    if (p.go) { i += p.go; assert.ok(i >= 0, 'went below the map'); return; }
    if (p.push) { entries.splice(i + 1, Infinity, { url: p.url, state: p.push }); i++; }
    else entries[i] = { url: p.url, state: p.replace };
  };
  const back = () => { i--; return i >= 0 ? entries[i].url : 'left the app'; };
  return { go, back, at: () => entries[i].url, steps: () => i };
}

test('back returns to the screen it came from, then the map, then leaves', () => {
  const b = browser();
  b.go('/l/ab12'); b.go('/l/ab12/b/7');
  assert.equal(b.back(), '/l/ab12');
  assert.equal(b.back(), '/');
  assert.equal(b.back(), 'left the app');
});

test('a screen already in the trail is gone back to, not piled up', () => {
  const b = browser();
  b.go('/l/ab12'); b.go('/l/ab12/b/7'); b.go('/l/ab12'); // "← back to the library"
  assert.equal(b.at(), '/l/ab12');
  assert.equal(b.steps(), 1);
  b.go('/l/ab12/b/8'); b.go('/books'); b.go('/');
  assert.equal(b.steps(), 0);
});

test('replace: pager, redirects and typed searches take the current step', () => {
  const b = browser();
  b.go('/l/ab12'); b.go('/l/ab12/b/7'); b.go('/l/ab12/b/8', { replace: true }); b.go('/l/ab12/b/9', { replace: true });
  assert.equal(b.back(), '/l/ab12');
  const c = browser();
  c.go('/queue'); c.go('/login?next=/queue'); c.go('/queue', { replace: true }); // signed in: back to where it was
  assert.equal(c.at(), '/queue');
  assert.equal(c.back(), '/');
});

test('menu screens stack: books → settings → back → books', () => {
  const b = browser();
  b.go('/books'); b.go('/settings'); b.go('/about');
  assert.equal(b.back(), '/settings');
  assert.equal(b.back(), '/books');
});

test('older history entries get a trail', () => {
  assert.deepEqual(stateFor({ overMap: true }, '/l/x'), { overMap: true, depth: 1, trail: ['/', '/l/x'] });
  assert.deepEqual(stateFor(null, '/'), { depth: 0, trail: ['/'] });
  assert.equal(stateFor(null, '/l/x'), null);
});

test('the map on the map is not a new step', () => {
  const b = browser();
  b.go('/');
  assert.equal(b.steps(), 0);
});
