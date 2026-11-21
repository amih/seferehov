// The phone's home points for the one camera (web/src/hints.js): near home means no coordinates sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metres, nearHome, HOME_M } from '../../web/src/hints.js';

const home = { lat: 32.0853, lon: 34.7818 };

test('metres: 0.001° of latitude is about 111 m', () => {
  assert.ok(Math.abs(metres(home, { lat: home.lat + 0.001, lon: home.lon }) - 111) < 1);
});

test('near home: within 150 m, or within the fix\'s accuracy up to 300 m', () => {
  assert.equal(nearHome([home], { lat: home.lat + 0.001, lon: home.lon, acc: 20 }), true);
  assert.equal(nearHome([home], { lat: home.lat + 0.002, lon: home.lon, acc: 20 }), false);
  assert.equal(nearHome([home], { lat: home.lat + 0.002, lon: home.lon, acc: 250 }), true);
  assert.equal(nearHome([home], { lat: home.lat + 0.004, lon: home.lon, acc: 2000 }), false);
  assert.ok(HOME_M === 150);
});

test('no home points or no fix: unknown', () => {
  assert.equal(nearHome([], { lat: 1, lon: 1 }), null);
  assert.equal(nearHome([home], null), null);
});
