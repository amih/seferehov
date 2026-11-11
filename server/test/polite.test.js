// The catalogue gate (src/polite.js): spacing per site, a full waiting line refused at
// once, and a rest after "too many requests". Against a local HTTP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { politeFetch } from '../src/polite.js';

let srv, base;
const times = [];
before(async () => {
  srv = http.createServer((req, res) => {
    times.push(Date.now());
    if (req.url === '/limit') { res.writeHead(429, { 'retry-after': '60' }); return res.end(); }
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

test('requests to one site start at least a second apart', async () => {
  times.length = 0;
  await Promise.all([1, 2, 3].map(() => politeFetch(`${base}/a`)));
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(gaps.every((g) => g >= 950), `gaps ${gaps}`);
});

test('more than 30 waiting: the rest are refused at once, not queued', async () => {
  const all = await Promise.allSettled(Array.from({ length: 35 }, () => politeFetch(`${base}/a`)));
  const refused = all.filter((r) => r.status === 'rejected' && r.reason.busy && !r.reason.resting);
  assert.equal(refused.length, 5);
});

test('after a 429 the site is left alone', async () => {
  await politeFetch(`${base}/limit`);
  await assert.rejects(politeFetch(`${base}/a`), (e) => e.busy && e.resting);
});
