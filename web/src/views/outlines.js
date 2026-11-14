import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast } from '../ui.js';

// For the admin only (English, for a laptop): spine outlines by hand. /admin/outlines lists
// approved books with no outline on their shelf photo, and outlines on one photo that lie on
// top of each other. /admin/outlines/<item> edits one: drag on the photo to draw a box, drag
// a corner to fit a leaning spine, drag inside to move it, [ ] to turn it, the wheel to zoom.
// "Not visible" marks a book that can't be seen on its photo.
const LIST = 'seferehov:outlines'; // the order of the list, for "save and next"

export default async function outlinesView(root, [id]) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
  if (me.trust_level < 3) { root.innerHTML = '<section class="page"><h1>Admins only</h1></section>'; return; }
  return id ? editor(root, Number(id)) : list(root);
}

const pts = (poly) => poly.map((p) => p.join(',')).join(' ');
const photoName = (it) => `${it.scan.slice(0, 8)}:${it.frame ?? '?'}`;

async function list(root) {
  root.innerHTML = '<section class="page outlines" dir="ltr" lang="en"><p class="muted">Loading…</p></section>';
  const d = await api('/api/admin/outlines');
  const order = [...d.overlapping.flat().map((x) => x.id), ...d.missing.map((x) => x.id)];
  sessionStorage.setItem(LIST, JSON.stringify(order));
  const thumb = (items) => `<div class="ol-thumb"><img src="${esc(items[0].photo)}" alt="" loading="lazy">
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">${items.filter((x) => x.poly).map((x) => `<polygon points="${pts(x.poly)}"/>`).join('')}</svg></div>`;
  root.querySelector('section').innerHTML = `
    <p><a href="/admin">← Admin</a></p>
    <h1>Spine outlines</h1>
    <p>Each approved book should have its spine outlined on its shelf photo: the book page shows it under "Where is it",
      and the lab trains its spine finders on these outlines. Open a book, drag on the photo to draw its outline, then save;
      or mark it "not visible" when it can't be seen on that photo. <b>Save and next</b> walks through both lists.</p>
    <h2>Outlines on top of each other (${d.overlapping.length} ${d.overlapping.length === 1 ? 'place' : 'places'})</h2>
    ${d.overlapping.length ? d.overlapping.map((g) => `<div class="card ol-group">${thumb(g)}<div>
        <p class="muted small">Photo ${esc(photoName(g[0]))}: ${g.length} books outlined in the same place. Usually one of them is the spine that is really there.</p>
        <ul>${g.map((x) => `<li><a href="/admin/outlines/${x.id}" dir="auto">${esc(x.title)}</a>${x.byAdmin ? ' <span class="muted small">(by hand)</span>' : ''}</li>`).join('')}</ul></div></div>`).join('')
      : '<p class="note">None.</p>'}
    <h2>Approved books with no outline (${d.missing.length})</h2>
    ${d.missing.length ? `<div class="table-wrap"><table><thead><tr><th>Book</th><th>Photo</th><th>Suggested</th><th>Scanned</th></tr></thead><tbody>
      ${d.missing.map((x) => `<tr><td><a href="/admin/outlines/${x.id}" dir="auto">${esc(x.title)}</a></td><td>${esc(photoName(x))}</td><td>${x.suggested ? `✓ ${x.suggested}` : ''}</td><td>${new Date(x.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="note">Every approved book has an outline.</p>'}`;
}

async function editor(root, id) {
  root.innerHTML = '<section class="ol-edit" dir="ltr" lang="en"><p class="muted">Loading…</p></section>';
  const { item, others, suggestions = [], finder } = await api(`/api/admin/outlines/${id}`);
  const order = JSON.parse(sessionStorage.getItem(LIST) ?? '[]');
  const next = order[order.indexOf(id) + 1] ?? null;
  const copy = (q) => q.map((p) => [...p]);
  // No outline yet and the finder has a guess: start from it, so approving is one key.
  const guess = !item.poly && !item.hidden ? suggestions.find((x) => x.guess) ?? (suggestions.length === 1 ? suggestions[0] : null) : null;
  const start = item.poly ?? guess?.poly ?? null;
  let poly = start ? copy(start) : null;
  let zoom = 1;
  const M = 0.15; // room around the photo, for spines cut by its edge

  root.querySelector('section').innerHTML = `
    <div class="ol-stage"><div class="ol-canvas"><img alt="shelf photo" src="${esc(item.photo)}"><svg aria-label="outlines"></svg></div></div>
    <aside class="ol-side">
      <p><a href="/admin/outlines">← All outlines</a></p>
      <h1 dir="auto">${esc(item.title)}</h1>
      <p class="muted small">Photo ${esc(photoName(item))}${item.book ? ` · <a href="/b/${item.book}" target="_blank">book page</a>` : ''}
        ${item.hidden ? ' · <b>marked not visible</b>' : item.byAdmin ? ' · outlined by hand' : item.poly ? ' · outlined by the app' : ' · <b>no outline</b>'}</p>
      ${item.crop ? `<p class="small">What the app cut out and read:</p><img class="ol-crop" src="${esc(item.crop)}" alt="">` : ''}
      ${suggestions.length ? `<p class="small ol-sugnote">${guess ? '<b>Suggested outline (yellow): check it, fix it if needed, then <kbd>Enter</kbd>.</b> ' : ''}Dashed green: ${suggestions.length} spine${suggestions.length === 1 ? '' : 's'} ${esc(finder ?? 'the spine finder')} found where no other book is outlined. Click one to use it.</p>` : ''}
      <p class="small">Drag on the photo to draw a box (it may go past the photo's edge). Drag a corner to fit a leaning spine, drag inside to move it,
        <kbd>[</kbd> <kbd>]</kbd> to turn it. Mouse wheel to zoom. <kbd>Enter</kbd> saves.</p>
      <p class="row"><button class="btn primary" id="save">✓ Save${next ? ' and next' : ''}</button>
        <button class="btn" id="hide">Not visible</button></p>
      <p class="row"><button class="btn small" id="reset">Undo changes</button>${next ? '<button class="btn small" id="skip">Skip →</button>' : ''}</p>
      ${others.length ? `<h2>Other books on this photo</h2><ul class="ol-others">${others.map((o) => `<li><a href="/admin/outlines/${o.id}" dir="auto" data-id="${o.id}">${esc(o.title)}</a>${o.poly ? '' : ' <span class="muted small">(no outline)</span>'}</li>`).join('')}</ul>` : ''}
    </aside>`;

  const stage = root.querySelector('.ol-stage'), canvas = root.querySelector('.ol-canvas');
  const img = canvas.querySelector('img'), svg = canvas.querySelector('svg');
  await (img.decode?.().catch(() => {}) ?? Promise.resolve());
  const W = img.naturalWidth || 1, H = img.naturalHeight || 1;
  svg.setAttribute('viewBox', `${-M * W} ${-M * H} ${W * (1 + 2 * M)} ${H * (1 + 2 * M)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const fit = () => {
    const w = Math.min(stage.clientWidth / (1 + 2 * M), (stage.clientHeight / (1 + 2 * M)) * (W / H)) * zoom, h = (w * H) / W;
    Object.assign(canvas.style, { width: `${w * (1 + 2 * M)}px`, height: `${h * (1 + 2 * M)}px` });
    Object.assign(img.style, { width: `${w}px`, height: `${h}px`, left: `${M * w}px`, top: `${M * h}px` });
  };
  fit();

  const px = (p) => [p[0] * W, p[1] * H];
  const hot = (o) => o.poly && poly && overlaps(o.poly, poly);
  function draw() {
    const r = Math.max(W, H) / 120; // handle size in photo pixels
    svg.innerHTML = `<rect class="ol-edge" x="0" y="0" width="${W}" height="${H}"/>` + others.filter((o) => o.poly).map((o) => `<polygon class="ol-other${hot(o) ? ' hot' : ''}" data-id="${o.id}" points="${pts(o.poly.map(px))}"><title>${esc(o.title)}</title></polygon>`).join('')
      + suggestions.map((x, i) => `<polygon class="ol-sug" data-s="${i}" points="${pts(x.poly.map(px))}"><title>${esc(finder ?? '')} ${x.score ?? ''}</title></polygon>`).join('')
      + (poly ? `<polygon class="ol-me" points="${pts(poly.map(px))}"/>${poly.map((p, i) => `<circle class="ol-h" data-i="${i}" cx="${p[0] * W}" cy="${p[1] * H}" r="${r / zoom}"/>`).join('')}` : '');
  }
  draw();

  // Pointer → fraction of the photo (below 0 or above 1 past its edges, up to the margin).
  const at = (e) => {
    const b = img.getBoundingClientRect(), lim = (v) => Math.min(1 + M, Math.max(-M, v));
    return [lim((e.clientX - b.left) / b.width), lim((e.clientY - b.top) / b.height)];
  };
  let drag = null;
  svg.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const p = at(e);
    const h = e.target.closest('.ol-h');
    if (h) drag = { kind: 'corner', i: Number(h.dataset.i) };
    else if (e.target.closest('.ol-sug')) { poly = copy(suggestions[Number(e.target.closest('.ol-sug').dataset.s)].poly); draw(); return; }
    else if (e.target.closest('.ol-me')) drag = { kind: 'move', from: p, start: poly.map((q) => [...q]) };
    else { drag = { kind: 'new', from: p }; poly = null; }
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  svg.onpointermove = (e) => {
    if (!drag) return;
    const p = at(e);
    if (drag.kind === 'corner') poly[drag.i] = p;
    else if (drag.kind === 'move') {
      const dx = p[0] - drag.from[0], dy = p[1] - drag.from[1];
      poly = drag.start.map(([x, y]) => [x + dx, y + dy]);
    } else {
      const [x1, y1] = drag.from, [x2, y2] = p;
      poly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    }
    draw();
  };
  svg.onpointerup = () => {
    // A click without a drag leaves no outline: keep the old one.
    if (drag?.kind === 'new' && poly && Math.abs(poly[2][0] - poly[0][0]) < 0.003 && Math.abs(poly[2][1] - poly[0][1]) < 0.003) poly = start ? copy(start) : null;
    drag = null;
    draw();
  };

  // Turn about the centre, in the photo's pixels (so the corners stay square).
  const turn = (deg) => {
    if (!poly) return;
    const c = [0, 1].map((k) => poly.reduce((a, p) => a + p[k], 0) / 4);
    const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    poly = poly.map(([x, y]) => {
      const dx = (x - c[0]) * W, dy = (y - c[1]) * H;
      return [c[0] + (dx * cos - dy * sin) / W, c[1] + (dx * sin + dy * cos) / H];
    });
    draw();
  };

  // Zoom towards the pointer; the stage scrolls.
  stage.onwheel = (e) => {
    e.preventDefault();
    const b = canvas.getBoundingClientRect();
    const fx = (e.clientX - b.left) / b.width, fy = (e.clientY - b.top) / b.height;
    zoom = Math.min(8, Math.max(1, zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    fit();
    draw();
    const nb = canvas.getBoundingClientRect();
    stage.scrollLeft += nb.left + fx * nb.width - e.clientX;
    stage.scrollTop += nb.top + fy * nb.height - e.clientY;
  };

  const go = () => navigate(next ? `/admin/outlines/${next}` : '/admin/outlines');
  async function save(json) {
    try {
      await api(`/api/admin/outlines/${id}`, { method: 'POST', json });
      toast(json.hidden ? 'Marked not visible' : 'Outline saved');
      go();
    } catch (err) { toast(err.message); }
  }
  root.querySelector('#save').onclick = () => (poly ? save({ poly }) : toast('Draw the outline first: drag on the photo'));
  root.querySelector('#hide').onclick = () => save({ hidden: true });
  root.querySelector('#reset').onclick = () => { poly = start ? copy(start) : null; draw(); };
  const skip = root.querySelector('#skip');
  if (skip) skip.onclick = go;

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (e.key === '[') turn(-1);
    else if (e.key === ']') turn(1);
    else if (e.key === 'Enter') root.querySelector('#save').click();
    else return;
    e.preventDefault();
  };
  const onResize = () => { fit(); draw(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  document.body.classList.add('wide-page');
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    document.body.classList.remove('wide-page');
  };
}

function overlaps(a, b) {
  const box = (p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
  const [x1, y1, x2, y2] = box(a), [u1, v1, u2, v2] = box(b);
  const w = Math.min(x2, u2) - Math.max(x1, u1), h = Math.min(y2, v2) - Math.max(y1, v1);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / ((x2 - x1) * (y2 - y1) + (u2 - u1) * (v2 - v1) - w * h) > 0.5;
}
