// Where were the photos taken (src/situation.js scoreSituation, src/capture.js cleanHints):
// the hand-set weights on typical sessions.
//   node --test test/   (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSituation, SURE } from '../src/situation.js';
import { cleanHints } from '../src/capture.js';

const lib = (m, code = 'abc12', id = 7) => ({ id, code, name: 'Herzl St.', m });

test('at a street library: mobile data, good GPS, daylight, next to it: that library, sure', () => {
  const g = scoreSituation({ lat: 32, lon: 34.8, acc: 6, net: 'cellular', exp: 1 / 1000, hour: 11, dow: 2 }, [lib(12)], 'box');
  assert.equal(g.kind, 'library');
  assert.equal(g.location.code, 'abc12');
  assert.ok(g.confidence >= 95, String(g.confidence));
});

test('at home: Wi-Fi, weak GPS, lamp light, evening, a bookcase in a room: home, sure', () => {
  const g = scoreSituation({ lat: 32, lon: 34.8, acc: 65, net: 'wifi', exp: 1 / 30, hour: 21, dow: 3 }, [], 'home');
  assert.equal(g.kind, 'home');
  assert.ok(g.confidence >= 95, String(g.confidence));
});

test('near the reader\'s home and on Wi-Fi, nothing else known: home, sure', () => {
  const g = scoreSituation({ nearHome: true, net: 'wifi' }, [], null);
  assert.equal(g.kind, 'home');
  assert.ok(g.confidence >= SURE);
});

test('outdoors with no known library near: a new library, always asked', () => {
  const g = scoreSituation({ lat: 32, lon: 34.8, acc: 5, net: 'cellular', exp: 1 / 2000, hour: 10, dow: 1 }, [], 'box');
  assert.equal(g.kind, 'new_library');
  assert.ok(g.confidence < SURE);
});

test('two libraries 15 m apart: which one is asked', () => {
  const g = scoreSituation({ lat: 32, lon: 34.8, acc: 5, net: 'cellular', exp: 1 / 2000 }, [lib(10), lib(25, 'xyz99', 8)], 'box');
  assert.equal(g.kind, 'library');
  assert.ok(g.confidence < SURE);
  assert.equal(g.candidates.length, 2);
});

test('a library 20 m away but on Wi-Fi in lamp light (a flat above the box): unsure', () => {
  const g = scoreSituation({ lat: 32, lon: 34.8, acc: 30, net: 'wifi', exp: 1 / 30, hour: 20, dow: 2 }, [lib(20)], null);
  assert.ok(g.confidence < SURE, `${g.kind} ${g.confidence}`);
});

test('no hints at all: unsure', () => {
  const g = scoreSituation({}, [], null);
  assert.ok(g.confidence < SURE);
});

test('hints are cleaned: unknown keys dropped, bad coordinates dropped with their accuracy', () => {
  assert.deepEqual(cleanHints('{"lat":32.1,"lon":34.8,"acc":8,"net":"wifi","ssid":"x","nearHome":false}'),
    { lat: 32.1, lon: 34.8, acc: 8, nearHome: false, net: 'wifi' });
  assert.deepEqual(cleanHints({ lat: 200, lon: 34.8, acc: 8, hour: 9 }), { hour: 9 });
  assert.equal(cleanHints('not json'), null);
});
