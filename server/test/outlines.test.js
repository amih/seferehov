import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxIou, overlapGroups, cleanPoly } from '../src/outlines.js';

const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

test('outlines: the same spot overlaps, neighbours on a shelf do not', () => {
  assert.ok(boxIou(rect(0.397, 0.805, 0.467, 0.999), rect(0.407, 0.805, 0.469, 0.993)) > 0.8);
  assert.equal(boxIou(rect(0.1, 0.2, 0.15, 0.6), rect(0.15, 0.2, 0.2, 0.6)), 0);
});

test('outlines: overlapping outlines are grouped per photo', () => {
  const it = (id, frame, poly) => ({ id, scan_id: 's', frame_path: frame, spot: { poly } });
  const groups = overlapGroups([
    it(1, 'a', rect(0.397, 0.805, 0.467, 0.999)), it(2, 'a', rect(0.397, 0.804, 0.465, 0.999)),
    it(3, 'a', rect(0.407, 0.805, 0.469, 0.993)), it(4, 'a', rect(0.04, 0.2, 0.11, 0.63)),
    it(5, 'b', rect(0.397, 0.805, 0.467, 0.999)),
  ]);
  assert.deepEqual(groups.map((g) => g.map((x) => x.id).sort()), [[1, 2, 3]]);
});

test('outlines: a hand-drawn outline is four corners, partly on the photo', () => {
  assert.deepEqual(cleanPoly([[-0.1, 0.2], [0.3, 0.2], [0.3, 1.2], [0, 0.9]]), [[-0.1, 0.2], [0.3, 0.2], [0.3, 1.2], [0, 0.9]]);
  assert.deepEqual(cleanPoly([[-0.9, 0.2], [0.3, 0.2], [0.3, 0.4], [-0.9, 0.4]]), [[-0.5, 0.2], [0.3, 0.2], [0.3, 0.4], [-0.5, 0.4]]);
  assert.equal(cleanPoly([[1.1, 0.2], [1.3, 0.2], [1.3, 0.4], [1.1, 0.4]]), null);
  assert.equal(cleanPoly([[0, 0], [1, 1]]), null);
  assert.equal(cleanPoly([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]), null);
  assert.equal(cleanPoly([[0, 0], [1, 0], ['x', 1], [0, 1]]), null);
});
