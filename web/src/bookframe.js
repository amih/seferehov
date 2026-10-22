// Is there a book in the picture? A book lying on a table or held in a hand shows as a
// large box: four long, straight edges where the brightness steps the same way all
// along (the cover on one side, the table on the other), with print inside. A floor, a
// wall or a table top has no such box, or nothing printed in it. Busy rooms can fool it
// (about a third of room photos pass, against six books in seven), so the camera uses
// it together with a real pause and the size of the books before.
// g: grey pixels of a small copy (about 160 px wide), w × h.
const SLOPES = [-0.14, -0.07, 0, 0.07, 0.14]; // up to ~8° off straight
const EDGE = 14;    // brightness step that counts as an edge pixel
const LINE = 0.55;  // share of a side's length that must be edge, stepping the same way
const AREA = 0.2;   // the box covers at least this share of the picture
const INK = 0.02;   // share of print-like pixels inside the box

// How much of a line is edge stepping the same way: x = a + s·(y − mid) for y in
// t0..t1 (a left or right side), or, with vertical = false, y = a + s·(x − mid) (a top
// or bottom side). The step is taken across 4 px, so a soft edge still counts.
function lineScore(g, w, h, vertical, a, s, t0, t1, mid) {
  let pos = 0, neg = 0, n = 0;
  for (let t = t0; t < t1; t += 2) {
    const c = Math.round(a + s * (t - mid));
    let d;
    if (vertical) { if (c < 2 || c >= w - 2 || t < 0 || t >= h) continue; d = g[t * w + c + 2] - g[t * w + c - 2]; }
    else { if (c < 2 || c >= h - 2 || t < 0 || t >= w) continue; d = g[(c + 2) * w + t] - g[(c - 2) * w + t]; }
    n++;
    if (d > EDGE) pos++; else if (d < -EDGE) neg++;
  }
  return n ? Math.max(pos, neg) / n : 0;
}
function bestLine(g, w, h, vertical, t0, t1, a0, a1, mid) {
  let best = { at: -1, s: 0, score: 0 };
  for (const s of SLOPES) {
    for (let a = a0; a < a1; a++) {
      const score = lineScore(g, w, h, vertical, a, s, t0, t1, mid);
      if (score > best.score) best = { at: a, s, score };
    }
  }
  return best;
}

export function bookInFrame(g, w, h) {
  // First guess: sides found over the middle half; then each side is measured only
  // along the box the other sides close.
  let top = { at: Math.round(h * 0.25) }, bottom = { at: Math.round(h * 0.75) };
  let left = { at: Math.round(w * 0.25) }, right = { at: Math.round(w * 0.75) };
  for (let pass = 0; pass < 2; pass++) {
    const y0 = top.at, y1 = bottom.at, x0 = left.at, x1 = right.at;
    const ym = (y0 + y1) / 2, xm = (x0 + x1) / 2;
    left = bestLine(g, w, h, true, y0, y1, 2, Math.round(w * 0.45), ym);
    right = bestLine(g, w, h, true, y0, y1, Math.round(w * 0.55), w - 2, ym);
    top = bestLine(g, w, h, false, x0, x1, 2, Math.round(h * 0.45), xm);
    bottom = bestLine(g, w, h, false, x0, x1, Math.round(h * 0.55), h - 2, xm);
  }
  const area = ((right.at - left.at) * (bottom.at - top.at)) / (w * h);
  const score = Math.min(left.score, right.score, top.score, bottom.score);
  // Print: pixels much darker or lighter than their neighbours (letters, a picture's lines).
  let ink = 0, n = 0;
  for (let y = top.at + 1; y < bottom.at - 1; y++) {
    for (let x = left.at + 1; x < right.at - 1; x++) {
      const i = y * w + x;
      if (Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]) > 100) ink++;
      n++;
    }
  }
  ink = n ? ink / n : 0;
  return { ok: score >= LINE && area >= AREA && ink >= INK, score, area, ink };
}
