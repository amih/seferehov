import { api } from './api.js';
import { esc } from './ui.js';
import { t } from './i18n.js';

// "How this was read" under a book in the approval queue: every step that made this one
// book, each with the picture it looked at or made, so a wrong cut, a wrong way up or a
// misreading can be traced to the step where it happened.

const pct = (x) => (x == null ? '' : `${Math.round(x * 100)}%`);
const ms = (x) => (x == null ? '' : x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(1)} s`);

// Boxes drawn over a picture: W×H are the picture's own pixels (the trace copy may be smaller).
function boxes(src, W, H, list, mine) {
  if (!W || !H) return img(src);
  const rect = ([x1, y1, x2, y2], cls) => `<rect class="${cls}" x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" />`;
  return `<figure class="step-pic boxed"><span class="boxwrap"><img src="${esc(src)}" alt="" loading="lazy">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${list.map((b) => rect(b, 'other')).join('')}${mine ? rect(mine, 'mine') : ''}</svg></span>
    <figcaption class="muted small" dir="ltr">${W}×${H} px</figcaption></figure>`;
}
const img = (src) => (src ? `<figure class="step-pic"><img src="${esc(src)}" alt="" loading="lazy"><figcaption class="muted small" dir="ltr"></figcaption></figure>` : '');


function stepHtml(s, n, files, ctx) {
  const pic = (key) => (s[key] ? img(files + s[key]) : '');
  const where = s.path?.length > 1 ? `<span class="muted small" dir="ltr">${esc(s.path.slice(1).join(' › '))}</span>` : '';
  let body = '';
  switch (s.kind) {
    case 'image':
      body = `<p class="small">${t('steps.image_note')}${s.sharpness != null ? ` · ${t('steps.sharpness', { n: s.sharpness, min: s.blurry_below })}` : ''}${s.from_video ? ` · ${t('steps.from_video', { t: s.t?.toFixed?.(1) ?? '' })}` : ''}</p>${pic('image')}`;
      break;
    case 'barcodes':
      body = `<p class="small">${s.codes?.length ? s.codes.map(esc).join(', ') : t('steps.none')}</p>`;
      break;
    case 'detect': {
      const mine = ctx.cut?.from === 'straight' ? ctx.cut.box : null;
      body = `<p class="small">${t('steps.detect_note', { n: s.boxes?.length ?? 0 })}${mine ? '' : ctx.cut ? ` ${t('steps.detect_lean')}` : ''}</p>
        ${boxes(files + s.image, s.W, s.H, (s.boxes ?? []).map((b) => b.box), mine)}
        ${ctx.cut?.tilt != null ? `<p class="small">${t('steps.tilt', { deg: ctx.cut.tilt })}</p>` : ''}`;
      break;
    }
    case 'lean-group':
      body = `<p class="small">${t('steps.lean_note', { deg: s.tilt })}${s.note ? ` — <span class="muted">${esc(s.note)}</span>` : ''}</p>
        ${boxes(files + s.image, s.W, s.H, (s.boxes ?? []).map((b) => b.box), ctx.cut?.from?.startsWith('lean') ? ctx.cut.box : null)}`;
      break;
    case 'cut-out':
      body = `<p class="small">${t('steps.cut_note', { w: s.w, h: s.h })}${s.tilt != null ? ` · ${t('steps.tilt', { deg: s.tilt })}` : ''}</p>${pic('image')}`;
      break;
    case 'model':
      body = `<p class="small muted" dir="ltr">${esc(s.prompt?.slice(0, 140))}${s.prompt?.length > 140 ? '…' : ''}</p>
        <div class="step-pics">${pic('image')}${pic('image2')}</div>
        <pre class="step-answer" dir="auto">${esc(s.answer?.slice(0, 800) ?? '')}</pre><p class="muted small">${ms(s.ms)}</p>`;
      break;
    case 'ocr':
      body = `<div class="step-pics">${pic('image')}</div>
        ${s.lines?.length ? `<ul class="step-lines">${s.lines.map((l) => `<li dir="auto">${esc(l.text)} <span class="muted small">${pct(l.confidence)}</span></li>`).join('')}</ul>` : `<pre class="step-answer" dir="auto">${esc(s.text || t('steps.none'))}</pre>`}
        <p class="muted small">${esc(s.engine ?? '')} ${ms(s.ms)}</p>`;
      break;
    case 'crop-read':
      body = `<p class="small"><b>${esc(s.verdict ?? '')}</b>${s.angle != null ? ` · ${t('steps.angle', { deg: s.angle })}` : ''}${s.score != null ? ` · ${t('steps.score', { s: pct(s.score) })}` : ''}</p>
        ${s.looking_for ? `<p class="small">${t('steps.looking_for')} <b dir="auto">${esc(s.looking_for)}</b></p>` : ''}
        ${s.tries?.length ? `<table class="step-tries"><tr><th>${t('steps.way')}</th><th>${t('steps.model_read')}</th><th>${t('steps.ocr_agrees')}</th></tr>${s.tries.map((x) => `<tr class="${x.angle === s.angle ? 'chosen' : ''}"><td>${x.angle}°</td><td dir="auto">${esc(x.read?.title ?? '—')}${x.read?.author ? ` <span class="muted">| ${esc(x.read.author)}</span>` : ''}</td><td>${pct(x.score)}</td></tr>`).join('')}</table>` : ''}
        ${s.crop ? `<p class="small">${t('steps.final_cut')}</p>${pic('crop')}` : ''}
        ${s.note ? `<p class="muted small">${esc(s.note)}</p>` : ''}`;
      break;
    case 'find-spine':
      body = `<p class="small">${t('steps.find_note')} <b dir="auto">${esc(s.title)}</b> · ${t('steps.tilt', { deg: s.tilt })} · <b>${esc(s.verdict ?? '')}</b></p>${pic('image')}`;
      break;
    case 'whole-read':
      body = `<p class="small">${t('steps.whole_note')}</p>${pic('image')}<pre class="step-answer" dir="auto">${esc(s.answer?.slice(0, 1500) ?? '')}</pre>`;
      break;
    case 'spine-cut': {
      const edge = (e) => (e ? t('steps.edge', { deg: e.deg, s: e.strength }) : t('steps.no_edge'));
      body = `<p class="small">${t('steps.spine_cut_note')}</p>
        <p class="small">${t('steps.own_lean', { deg: s.lean ?? 0 })} · ${t('steps.top_edge')}: ${edge(s.top)} · ${t('steps.bottom_edge')}: ${edge(s.bottom)}</p>
        ${s.note ? `<p class="muted small">${esc(s.note)}</p>` : ''}<div class="step-pics">${pic('image')}${pic('crop')}</div>`;
      break;
    }
    case 'split-band':
      body = `<p class="small">${t('steps.band_note')}</p>${pic('crop')}
        <p class="small">OCR: <span dir="auto">${esc((s.ocr ?? []).join(' · '))}</span></p>
        <p class="small">${t('steps.model_read')}: <b dir="auto">${esc(s.read?.title ?? '—')}</b>${s.read?.author ? ` <span class="muted" dir="auto">| ${esc(s.read.author)}</span>` : ''} · ${t('steps.score', { s: pct(s.score) })} · <b>${esc(s.verdict ?? '')}</b></p>`;
      break;
    case 'web-search':
      body = `<p class="small">${t('steps.web_note')}</p>
        <p class="small muted" dir="auto">${esc(s.query ?? '')}</p>
        ${s.results?.length ? `<ol class="step-lines small">${s.results.map((r) => `<li dir="auto"><a href="${esc(r.url ?? '#')}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a> <span class="muted">${esc(r.text ?? '')}</span></li>`).join('')}</ol>` : ''}
        ${s.fixed ? `<p class="small">${t('steps.web_fixed')} <b dir="auto">${esc(s.fixed.title)}</b>${s.fixed.author ? ` <span class="muted" dir="auto">| ${esc(s.fixed.author)}</span>` : ''}</p>` : ''}
        <p class="small"><b>${esc(s.verdict ?? '')}</b> <span class="muted">${ms(s.ms)}</span></p>`;
      break;
    case 'local-index':
      body = `<p class="small">${t('steps.index_note')}</p>
        ${s.candidates?.length ? `<table class="step-tries"><tr><th>${t('field.title')}</th><th>${t('field.author')}</th><th></th></tr>${s.candidates.map((c) => `<tr class="${c.ok ? 'chosen' : ''}"><td dir="auto">${esc(c.title)}</td><td dir="auto">${esc(c.author ?? '—')}</td><td class="muted small" dir="ltr">${esc(c.source)} · ${pct(c.ts)}${c.as != null ? ` · ${pct(c.as)}` : ''}</td></tr>`).join('')}</table>` : `<p class="muted small">${t('steps.none')}</p>`}
        ${s.fixed ? `<p class="small">${t('steps.web_fixed')} <b dir="auto">${esc(s.fixed.title)}</b>${s.fixed.author ? ` <span class="muted" dir="auto">| ${esc(s.fixed.author)}</span>` : ''}</p>` : ''}
        <p class="small"><b>${esc(s.verdict ?? '')}</b></p>`;
      break;
    case 'match':
      body = `<p class="small" dir="auto">${esc(s.read ?? '')} → ${s.book ? `<b>${esc(s.book.title)}</b>${s.book.isbn13 ? ` <span class="muted">${esc(s.book.isbn13)}</span>` : ''}` : t('steps.no_catalogue')}</p><p class="small"><b>${esc(s.verdict ?? '')}</b></p>`;
      break;
    default:
      body = `${s.note ? `<p class="muted small">${esc(s.note)}</p>` : ''}${pic('image')}${pic('crop')}`;
  }
  return `<li class="step"><h4><span class="step-n">${n}</span> ${esc(t(`steps.k.${s.kind}`) || s.kind)} ${where}</h4>${body}</li>`;
}

export function stepsBox(itemId) {
  return `<details class="steps" data-steps="${itemId}"><summary>🔬 ${t('steps.title')}</summary><div class="steps-body"><p class="muted">${t('loading')}</p></div></details>`;
}

// Loads the steps the first time the box is opened.
export function attachSteps(root) {
  const box = root.querySelector('details.steps');
  if (!box) return;
  box.addEventListener('toggle', async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const body = box.querySelector('.steps-body');
    try {
      const r = await api(`/api/queue/${box.dataset.steps}/steps`);
      if (!r.steps?.length) { body.innerHTML = `<p class="muted small">${t(r.gone ? 'steps.gone' : 'steps.none_found')}</p>`; return; }
      const cut = r.steps.find((s) => s.kind === 'cut-out');
      body.innerHTML = `${r.guessed ? `<p class="muted small">${t('steps.guessed')}</p>` : ''}<ol class="steps-list">${r.steps.map((s, k) => stepHtml(s, k + 1, r.files, { cut })).join('')}</ol>`;
      // The size of each picture as stored (the trace keeps copies of at most 1600 px).
      body.querySelectorAll('.step-pic:not(.boxed) img').forEach((im) => {
        const cap = () => { im.nextElementSibling.textContent = `${im.naturalWidth}×${im.naturalHeight} px`; };
        if (im.complete && im.naturalWidth) cap(); else im.addEventListener('load', cap, { once: true });
      });
    } catch {
      box.dataset.loaded = '';
      body.innerHTML = `<p class="note small">${t('offline')}</p>`;
    }
  });
}
