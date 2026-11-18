// The spine cutter's answers and its fallback (vision.js cutSpines), against a fake service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const reply = { code: 200, body: { W: 10, H: 20, ms: 5, dropped_edge: 0, spines: [] } };
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => { res.writeHead(reply.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body)); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.SPINES_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_EMAILS = '';
const { cutSpines } = await import('../src/vision.js');

test('the cutter\'s answer is passed on', async () => {
  reply.code = 200;
  assert.deepEqual(await cutSpines(Buffer.from('x')), reply.body);
});

test('an error answer falls back, with the reason', async () => {
  reply.code = 500; reply.body = { error: 'boom' };
  const r = await cutSpines(Buffer.from('x'));
  assert.match(r.down, /HTTP 500/);
});

test('a stopped cutter falls back, with the reason', async () => {
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  const r = await cutSpines(Buffer.from('x'));
  assert.match(r.down, /not running|connection broke/);
});
