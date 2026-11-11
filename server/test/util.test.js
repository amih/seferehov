import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo } from '../src/util.js';

test('memo: callers at the same time share one computation', async () => {
  let runs = 0;
  const fn = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return runs; };
  const [a, b] = await Promise.all([memo('t1', 1000, fn), memo('t1', 1000, fn)]);
  assert.equal(runs, 1);
  assert.equal(a, b);
});

test('memo: a failure is not kept', async () => {
  let runs = 0;
  await assert.rejects(memo('t2', 1000, async () => { runs++; throw new Error('x'); }));
  await new Promise((r) => setImmediate(r));
  assert.equal(await memo('t2', 1000, async () => ++runs), 2);
});
