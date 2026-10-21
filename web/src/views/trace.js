import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, timeAgo, toast } from '../ui.js';

// For the admin only (English): what every stage of reading a scan did — the video and
// the frames picked from it, the boxes the model drew, each cut-out read both ways up by
// the vision model and Surya, the catalogue lookups and why each book was kept or
// dropped. /admin/trace lists recent traces and takes a test upload (read the same way,
// nothing saved); /admin/trace/<id> shows one.
export default async function traceView(root, params) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
  if (me.trust_level < 3) { root.innerHTML = '<section class="page"><h1>Admins only</h1></section>'; return; }
  return params?.[0] ? showTrace(root, params[0]) : showList(root);
}

const sec = (ms) => (ms == null ? '…' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
const FLOW = { photo: '📷 Shelf photos', video: '🎬 Shelf video', cover: '📕 Covers', undefined: '' };

async function showList(root) {
  root.innerHTML = `<section class="page admin trace" dir="ltr" lang="en">
    <p><a href="/admin">← Admin</a></p>
    <h1>🔬 Traces</h1>
    <p class="muted small">Every scan and cover read keeps a trace for 30 days: each stage's pictures, what the models were asked and answered, and why each book was kept or dropped.</p>
    <form class="trace-upload card">
      <b>Test upload</b> <span class="muted small">— read the same way as a reader's upload; nothing goes to any queue.</span>
      <div class="row"><label><input type="radio" name="source" value="shelf" checked> Shelf photos or a video</label>
        <label><input type="radio" name="source" value="cover"> One book: front, then back</label></div>
      <input type="file" name="files" multiple accept="image/*,video/*">
      <button class="btn primary">Read with trace</button>
    </form>
    <div id="list"><p class="muted">Loading…</p></div></section>`;
  root.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.files.files.length) return toast('Choose photos or a video');
    const form = new FormData();
    form.append('source', f.source.value);
    for (const file of f.files.files) form.append('files', file, file.name);
    f.querySelector('button').disabled = true;
    try {
      const { id } = await api('/api/admin/traces', { method: 'POST', form });
      navigate(`/admin/trace/${id}`);
    } catch (err) { toast(err.message); f.querySelector('button').disabled = false; }
  };
  const { traces } = await api('/api/admin/traces');
  root.querySelector('#list').innerHTML = traces.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Steps</th><th>Took</th><th></th></tr></thead><tbody>
    ${traces.map((t) => `<tr><td><a href="/admin/trace/${esc(t.id)}">${timeAgo(t.started)}</a></td>
      <td>${esc(t.meta?.flow === 'admin test' ? `🧪 Test · ${FLOW[t.meta.source] ?? ''}` : t.meta?.flow === 'cover text' ? '🔤 Cover text' : FLOW[t.meta?.source] ?? t.id)}</td>
      <td>${t.steps ?? ''}</td><td>${t.ms == null ? '<i>running…</i>' : sec(t.ms)}</td><td>${t.error ? `⚠️ ${esc(t.error)}` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No traces yet.</p>';
}

async function showTrace(root, id) {
  root.innerHTML = `<section class="page admin trace" dir="ltr" lang="en"><p><a href="/admin/trace">← Traces</a></p><div id="t"><p class="muted">Loading…</p></div></section>`;
  const box = root.querySelector('#t');
  let timer = null;
  const load = async () => {
    let data;
    try { data = await api(`/api/admin/traces/${id}`); } catch (err) {
      // A test upload just sent: its trace starts in a moment.
      if (err.status === 404) { timer = setTimeout(load, 2000); return; }
      throw err;
    }
    const open = new Set([...box.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
    const y = window.scrollY;
    box.innerHTML = render(id, data, open);
    window.scrollTo(0, y);
    wire(box);
    if (data.trace.ms == null) timer = setTimeout(load, 5000); // still running
  };
  await load();
  return () => clearTimeout(timer);
}

const src = (id, file) => `/api/admin/traces/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

function render(id, { trace, items }, open) {
  const img = (file, cls = '') => (file ? `<a href="${src(id, file)}" target="_blank"><img class="${cls}" src="${src(id, file)}" loading="lazy" alt=""></a>` : '');
  const steps = [...trace.steps].sort((a, b) => a.i - b.i);
  const video = steps.find((s) => s.kind === 'input' && s.video);

  // Boxes drawn over a picture (in the picture's own pixels, W×H).
  const boxes = (s, file, list, extra = '') => `<div class="overlay">${img(file)}
    <svg viewBox="0 0 ${s.W} ${s.H}" preserveAspectRatio="none">${extra}${list.map((b, k) => {
      const [x1, y1, x2, y2] = b.box;
      const lean = b.tilt != null && Math.abs(b.tilt) >= 5;
      return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" class="${lean ? 'lean' : 'ok'}"/><text x="${x1 + 4}" y="${y1 + Math.max(14, s.H / 40)}" font-size="${Math.max(14, s.H / 40)}">${k + 1}${b.tilt != null ? ` · ${b.tilt}°` : ''}</text>`;
    }).join('')}</svg></div>`;
  const poly = (pts, cls) => (pts ? `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" class="${cls}"/>` : '');
  const bookList = (books) => (books?.length ? `<ol class="books">${books.map((b) => `<li dir="auto"><b>${esc(b.title)}</b>${b.author ? ` — ${esc(b.author)}` : ''}${b.isbn ? ` · ISBN ${esc(b.isbn)}` : ''}
    <span class="muted small">${b.quality ?? ''}${b.verified === true ? ' · ✓ OCR agreed' : b.verified === false ? ' · ✗ OCR disagreed' : b.verified === null ? ' · OCR down' : ''}${b.crop ? ' · cut-out' : ''}</span></li>`).join('')}</ol>` : '<p class="muted small">none</p>');
  const verdict = (v) => (v ? `<span class="verdict ${/^(kept|to the queue|cut out|cut-out kept)/.test(v) ? 'good' : /^dropped|nothing|no /.test(v) ? 'bad' : ''}">${esc(v)}</span>` : '');
  const note = (s) => (s.note ? `<p class="muted small">${esc(s.note)}</p>` : '');

  const one = (s) => {
    switch (s.kind) {
      case 'input':
        if (s.video) return `<h3>The video</h3><video id="video" src="${src(id, s.video)}" controls muted playsinline></video>`;
        return `<h3>Sent</h3>${note(s)}<div class="pics">${['front', 'back', 'image'].map((k) => img(s[k])).join('')}</div>${s.code_scanned ? `<p>Code scanned: ${esc(s.code_scanned)}</p>` : ''}`;
      case 'frames': {
        const picked = s.frames.filter((f) => f.why === 'picked').length;
        return `<h3>Frames: ${picked} picked of ${s.frames.length} sampled</h3>
          <p class="muted small">${s.fps} frames a second; the sharpest in each ${s.window_s} s window, minus near-duplicates and blurry ones (sharpness under 35% of the median ${Math.round(s.median_sharpness)}). Click a frame to see it in the video.</p>
          <div class="strip">${s.frames.map((f) => `<figure class="${f.why === 'picked' ? 'picked' : ''}" data-t="${f.t}" title="${esc(f.why)}">
            <img src="${src(id, s[f.thumb])}" loading="lazy" alt=""><figcaption>${f.t.toFixed(1)} s · ${f.sharpness}<br>${esc(f.why === 'picked' ? '✓ picked' : f.why)}</figcaption></figure>`).join('')}</div>`;
      }
      case 'image': return `<div class="pics">${img(s.image, 'big')}</div>${s.t != null ? `<p class="muted small">at ${s.t.toFixed(1)} s <button class="link" data-seek="${s.t}">▶ show in video</button></p>` : ''}`;
      case 'barcodes': return `<p>Barcodes: ${s.codes.length ? s.codes.map(esc).join(', ') : '<span class="muted">none</span>'}</p>`;
      case 'detect': return `<h3>Spines found: ${s.boxes.length}</h3>${note(s)}${boxes(s, s.image, s.boxes)}<p class="muted small">Green: straight · orange: leaning (turned upright below)</p>`;
      case 'lean-group': return `<h3>Lean group: ${s.tilt}° (${s.boxes_in_group} boxes)</h3>${note(s)}${boxes(s, s.image, s.boxes, s.area.map(([x1, y1, x2, y2]) => `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" class="area"/>`).join(''))}`;
      case 'whole-read': return `<h3>Whole-picture read</h3>${note(s)}${bookList(s.books)}<details><summary class="small">Model's answer</summary><pre dir="auto">${esc(s.answer)}</pre></details>`;
      case 'merged-reads': return `<h3>All reads of this picture, merged</h3>${note(s)}${bookList(s.books)}`;
      case 'frame-result': return `<h3>Result for this picture</h3>${bookList(s.books)}`;
      case 'cut-out': return `<div class="pics">${img(s.image, 'crop')}</div><p class="muted small">from ${esc(s.from)} · ${s.w}×${s.h} px</p>`;
      case 'crop-read': return `${verdict(s.verdict)}${s.looking_for ? ` <span class="small">looking for <b dir="auto">${esc(s.looking_for)}</b></span>` : ''}${note(s)}
        ${s.tries ? `<div class="tries">${s.tries.map((x) => `<div class="try ${x.angle === s.angle && s.verdict === 'kept' ? 'chosen' : ''}">
          <b>${x.angle}°</b> · match ${x.score}<br>
          <span class="small">Model:</span> <span dir="auto">${x.read ? `<b>${esc(x.read.title)}</b>${x.read.author ? ` — ${esc(x.read.author)}` : ''} <span class="muted small">${x.read.quality}</span>` : '<i>NONE</i>'}</span><br>
          <span class="small">Surya lines:</span><ul class="small">${x.lines.map((l) => `<li dir="auto" class="${l.score >= 0.5 ? 'hit' : ''}">${esc(l.text)} <span class="muted">conf ${l.confidence} · match ${l.score}</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>`).join('')}</div>` : ''}
        ${s.crop ? `<p class="small">Final cut-out (the title band):</p><div class="pics">${img(s.crop, 'crop')}</div>` : ''}`;
      case 'find-spine': return `${verdict(s.verdict)} <span class="small">${esc(s.title)} · lean ${s.tilt}°</span>${note(s)}<div class="pics">${img(s.image, 'crop')}</div>`;
      case 'model': return `<details class="call"><summary>🤖 ${esc(s.prompt.slice(0, 70))}… <span class="muted">${sec(s.ms)}</span></summary>
        <div class="callbody">${img(s.image, 'thumb')}<div><p class="small muted">${esc(s.model)}</p><pre class="small">${esc(s.prompt)}</pre><b class="small">Answer</b><pre dir="auto">${esc(s.answer)}</pre></div></div></details>`;
      case 'ocr': return `<details class="call"><summary>🔤 ${esc(s.engine)}: ${s.lines ? `${s.lines.length} lines` : `${s.text.length} chars`} <span class="muted">${s.ms != null ? sec(s.ms) : ''}</span></summary>
        <div class="callbody">${img(s.image, 'thumb')}<div>${s.lines ? `<ul class="small">${s.lines.map((l) => `<li dir="auto">${esc(l.text)} <span class="muted">${(l.confidence ?? 0).toFixed(2)}</span></li>`).join('')}</ul>` : `<pre dir="auto">${esc(s.text)}</pre>`}</div></div></details>`;
      case 'spell-check': return `<p class="small">✏️ Spell check: ${s.changes.length ? s.changes.map(([a, b]) => `<span dir="rtl">${esc(a)} → <b>${esc(b)}</b></span>`).join(', ') : 'no changes'}${s.unknown.length ? ` <span class="muted">(unknown: <span dir="rtl">${s.unknown.map(esc).join(', ')}</span>)</span>` : ''}</p>`;
      case 'cover-text': return `<h3>Cover text</h3>${note(s)}<pre dir="auto">${esc(s.text)}</pre>`;
      case 'cover-crop': return `<h3>Cut out the cover</h3>${verdict(s.verdict)}${note(s)}<div class="pics">${s.before ? `<div class="overlay">${img(s.before)}<svg viewBox="0 0 ${s.W} ${s.H}" preserveAspectRatio="none">${poly(s.model, 'model')}${poly(s.quad, 'quad')}</svg></div>` : ''}${img(s.after)}</div>
        <p class="muted small">Red: the model's corners · green: the outline used</p>`;
      case 'cover-read': return `<h3>Read the cover</h3><p dir="auto"><b>${esc(s.title ?? '—')}</b>${s.author ? ` — ${esc(s.author)}` : ''} <span class="muted small">${s.quality}</span></p>
        <p class="small">Barcodes: ${s.barcodes.join(', ') || 'none'} · codes: ${s.codes.join(', ') || 'none'}${s.unchecked.length ? ` · no check digit: ${s.unchecked.join(', ')}` : ''}</p>`;
      case 'merge': return `<h3>All pictures together: ${s.found.length} books</h3>${note(s)}<div class="table-wrap"><table><thead><tr><th>Title</th><th>Via</th><th>Pictures</th><th>OCR</th></tr></thead><tbody>
        ${s.found.map((f) => `<tr><td dir="auto">${esc(f.title ?? f.isbn)}${f.author ? `<br><span class="muted small">${esc(f.author)}</span>` : ''}</td><td>${f.via}</td><td>${f.frames.join(', ')}</td><td>${f.verified === true ? '✓' : f.verified === false ? '✗' : f.verified === null ? 'down' : 'whole-image only'}${f.crop ? ' · cut-out' : ''}</td></tr>`).join('')}</tbody></table></div>`;
      case 'match': return `<tr><td dir="auto">${esc(s.read ?? s.queue_title ?? s.isbn ?? '')}</td><td dir="auto">${s.book ? `<a href="/b/${s.book.id}" target="_blank">${esc(s.book.title)}</a>` : '<span class="muted">no catalogue match</span>'}</td><td>${verdict(s.verdict ?? (s.queue_title ? `to the queue: ${s.queue_title}` : ''))}${s.codes_tried ? `<br><span class="small muted">codes tried: ${s.codes_tried.join(', ') || 'none'}</span>` : ''}</td></tr>`;
      case 'error': return `<p class="verdict bad">⚠️ ${esc(s.error)}</p>`;
      default: return `<pre class="small">${esc(JSON.stringify(s, null, 1))}</pre>`;
    }
  };

  // Steps under the same scope (a frame, a cut-out…) go together, in order.
  const tree = { steps: [], kids: new Map() };
  for (const s of steps) {
    let node = tree;
    for (const label of s.path) {
      if (!node.kids.has(label)) { node.kids.set(label, { steps: [], kids: new Map(), first: s.i }); node.steps.push({ group: label }); }
      node = node.kids.get(label);
    }
    node.steps.push(s);
  }
  // A frame or photo, closed: how many spines were boxed, how many books came out.
  const frameSummary = (node) => {
    const all = [...node.steps, ...[...node.kids.values()].flatMap((k) => k.steps)];
    const det = node.steps.find((s) => s.kind === 'detect');
    const res = node.steps.find((s) => s.kind === 'frame-result' || s.kind === 'cover-crop');
    const img = node.steps.find((s) => s.kind === 'image');
    const kept = all.filter((s) => s.kind === 'crop-read' && s.verdict === 'kept' && /^cut-out/.test(s.path.at(-1))).length;
    const cuts = all.filter((s) => s.kind === 'cut-out').length;
    return `${img?.image ? `<img class="mini" src="${src(id, img.image)}" loading="lazy" alt="">` : ''}
      <span class="small muted">${det ? `${det.boxes.length} boxes · ` : ''}${cuts ? `${kept}/${cuts} cut-outs confirmed · ` : ''}${res?.books ? `${res.books.length} books` : res?.verdict ? esc(res.verdict) : ''}</span>`;
  };
  const summary = (node) => {
    const read = node.steps.find((s) => s.kind === 'crop-read' || s.kind === 'find-spine');
    const cut = node.steps.find((s) => s.kind === 'cut-out' || s.kind === 'find-spine');
    const title = read?.tries?.find((x) => x.angle === read.angle)?.read?.title ?? read?.title;
    return `${cut?.image ? `<img class="mini" src="${src(id, cut.image)}" loading="lazy" alt="">` : ''} ${verdict(read?.verdict)} ${title ? `<span dir="auto">${esc(title)}</span>` : ''}`;
  };
  const draw = (node, key) => {
    let html = '';
    let matches = [];
    const flush = () => {
      if (matches.length) html += `<h3>Catalogue lookups</h3><div class="table-wrap"><table><thead><tr><th>Read</th><th>Catalogue</th><th>Verdict</th></tr></thead><tbody>${matches.join('')}</tbody></table></div>`;
      matches = [];
    };
    for (const s of node.steps) {
      if (s.kind === 'match') { matches.push(one(s)); continue; }
      flush();
      if (s.group) {
        const kid = node.kids.get(s.group);
        const k = `${key}/${s.group}`;
        const small = /^(cut-out|find:)/.test(s.group);
        html += `<details class="scope ${small ? 'small-scope' : ''}" data-key="${esc(k)}" ${open.has(k) ? 'open' : ''}>
          <summary><b>${esc(s.group)}</b> ${small ? summary(kid) : frameSummary(kid)}</summary><div class="scope-body">${draw(kid, k)}</div></details>`;
      } else if (!(s.kind === 'input' && s.video && video !== s)) html += `<div class="step k-${s.kind}">${one(s)}</div>`;
    }
    flush();
    return html;
  };

  const m = trace.meta ?? {};
  const decided = items?.length ? `<h2>In the reader's queue</h2><div class="table-wrap"><table><thead><tr><th></th><th>Title</th><th>Catalogue</th><th>Quality</th><th>Reader's decision</th></tr></thead><tbody>
    ${items.map((x) => `<tr><td>${x.crop_path ? `<img class="mini" src="/uploads/${esc(x.crop_path)}" alt="">` : ''}</td><td dir="auto">${esc(x.title)}${x.author ? `<br><span class="muted small">${esc(x.author)}</span>` : ''}</td>
      <td dir="auto">${esc(x.book_title ?? '—')}</td><td>${x.quality}</td><td>${esc([x.decision, x.outcome].filter(Boolean).join(' · ') || 'waiting')}</td></tr>`).join('')}</tbody></table></div>` : '';
  const models = steps.filter((s) => s.kind === 'model');
  const ocrs = steps.filter((s) => s.kind === 'ocr');
  return `<h1>${esc(m.flow === 'admin test' ? `🧪 Test · ${FLOW[m.source] ?? ''}` : m.flow === 'cover text' ? '🔤 Cover text' : FLOW[m.source] ?? 'Trace')}</h1>
    <p class="muted small">${new Date(trace.started).toLocaleString('en-GB')} · ${trace.ms == null ? '<b>still running…</b> (refreshes by itself)' : `took ${sec(trace.ms)}`} · ${steps.length} steps ·
      ${models.length} vision-model calls (${sec(models.reduce((a, s) => a + s.ms, 0))}) · ${ocrs.length} OCR calls${m.files ? ` · ${m.files.map(esc).join(', ')}` : ''}${m.scan ? ` · scan ${esc(m.scan)}` : ''}</p>
    ${trace.error ? `<p class="verdict bad">⚠️ ${esc(trace.error)}</p>` : ''}
    ${draw(tree, '')}${decided}`;
}

function wire(box) {
  box.onclick = (e) => {
    const f = e.target.closest('[data-t], [data-seek]');
    const v = box.querySelector('#video');
    if (!f || !v) return;
    e.preventDefault();
    v.currentTime = Number(f.dataset.t ?? f.dataset.seek);
    v.pause();
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}
