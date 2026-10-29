// How far the camera moved between two tiny grey copies of the picture (same size): the
// shift that lines them up best. Used by the shelf camera (burst.js) for the phone's
// speed, and by the covers camera (shots.js) to tell moving on to the next book in a
// row from turning a book over in the hand.
export const R = 10; // largest shift looked for per tick; faster = moving on / lost

// Mean grey difference of b shifted by (dx, dy) from a, brightness change removed.
export function cost(a, b, w, h, ma, mb, dx, dy, s) {
  let d = 0, c = 0;
  const off = mb - ma;
  for (let y = R; y < h - R; y += s) {
    const ra = y * w, rb = (y + dy) * w + dx;
    for (let x = R; x < w - R; x += s) { d += Math.abs(b[rb + x] - a[ra + x] - off); c++; }
  }
  return d / c;
}
export const mean = (g) => { let m = 0; for (let i = 0; i < g.length; i++) m += g[i]; return m / g.length; };
// The shift that lines b up with a: every second shift on a coarse grid, then the best's neighbours.
export function align(a, b, w, h) {
  const ma = mean(a), mb = mean(b);
  let best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
    const err = cost(a, b, w, h, ma, mb, dx, dy, 4);
    if (err < best.err) best = { dx, dy, err };
  }
  const c = best;
  best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = c.dy - 1; dy <= c.dy + 1; dy++) for (let dx = c.dx - 1; dx <= c.dx + 1; dx++) {
    if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
    const err = cost(a, b, w, h, ma, mb, dx, dy, 3);
    if (err < best.err) best = { dx, dy, err };
  }
  best.edge = Math.max(Math.abs(best.dx), Math.abs(best.dy)) >= R - 1;
  best.plain = cost(a, b, w, h, ma, mb, 0, 0, 3);
  return best;
}

