import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast } from '../ui.js';

// For the admin only (English, for a laptop): /admin/spine-check shows the cut-outs the lab is
// unsure about, one at a time, large, with the shelf photo it came from. One key per answer;
// Enter takes the lab's guess; ← goes back. The answers tell the lab which cut-outs to cut again.
const LABEL = {
  good: 'Good: one spine, readable',
  trim: 'Neighbours or outside text in the cut',
  angle: 'Bad angle',
  cut_off: 'Cut off: part of the spine is missing',
  pile: 'A pile: no one main spine',
  unreadable: 'Too small, blurry or washed out',
  not_spine: 'Not a book spine (a cover, a page…)',
};
const pts = (poly) => poly.map((p) => p.join(',')).join(' ');

export default async function spineCheckView(root) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
  if (me.trust_level < 3) { root.innerHTML = '<section class="page"><h1>Admins only</h1></section>'; return; }
  root.innerHTML = '<section class="page sc" dir="ltr" lang="en"><p class="muted">Loading…</p></section>';
  const { items, answers = [] } = await api('/api/admin/spine-check');
  const sec = root.querySelector('section');
  if (!items.length) { sec.innerHTML = '<p><a href="/admin">← Admin</a></p><h1>Spine check</h1><p class="note">The lab has nothing to ask now.</p>'; return; }
  let i = Math.max(0, items.findIndex((x) => !x.answer));

  const show = () => {
    const done = items.filter((x) => x.answer).length;
    if (i >= items.length) {
      const left = items.findIndex((x) => !x.answer);
      sec.innerHTML = `<p><a href="/admin">← Admin</a></p><h1>Spine check</h1>
        <p class="note">${left < 0 ? `All ${items.length} answered. Thank you.` : `${done} of ${items.length} answered.`}
        ${left < 0 ? '' : `<button class="btn small primary" data-go="${left}">Go to the first one not answered</button>`}
        <button class="btn small" data-go="${items.length - 1}">← Back to the last one</button></p>`;
      return;
    }
    const it = items[i];
    sec.innerHTML = `
      <div class="sc-top"><a href="/admin">← Admin</a><span class="muted">${i + 1} of ${items.length} · ${done} answered</span></div>
      <div class="sc-crop"><img alt="the cut-out" src="${esc(it.crop)}"></div>
      <p class="muted small" dir="auto">#${it.id} · ${esc(it.title ?? '')} · ${esc(it.decision ?? 'not decided')}${it.note ? ` · lab: ${esc(it.note)}` : ''}</p>
      <div class="sc-answers">${answers.map((a, k) => `<button class="btn${it.answer === a ? ' primary' : ''}${it.guess === a ? ' sc-guess' : ''}" data-a="${a}">
        <kbd>${k + 1}</kbd> ${esc(LABEL[a] ?? a)}${it.guess === a ? ' <span class="small">(lab’s guess: Enter)</span>' : ''}</button>`).join('')}</div>
      <p class="muted small">Keys: 1–${answers.length} answer · Enter = the lab’s guess · ← back · → skip</p>
      ${it.photo ? `<div class="sc-photo"><img alt="the shelf photo" src="${esc(it.photo)}">
        ${it.poly ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts(it.poly)}"/></svg>` : ''}</div>
        <p class="muted small">The shelf photo; the yellow outline is where the app thinks this book is.</p>` : ''}`;
  };

  const answer = async (a) => {
    const it = items[i];
    if (!it || !a) return;
    try {
      await api(`/api/admin/spine-check/${it.id}`, { method: 'POST', json: { answer: a } });
      it.answer = a;
      i++;
      show();
    } catch (e) { toast(e.message || 'Not saved'); }
  };

  sec.onclick = (e) => {
    const b = e.target.closest('[data-a]');
    if (b) answer(b.dataset.a);
    else if (e.target.closest('[data-go]')) { i = Number(e.target.closest('[data-go]').dataset.go); show(); }
  };
  const onKey = (e) => {
    if (!sec.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= answers.length) { e.preventDefault(); answer(answers[n - 1]); }
    else if (e.key === 'Enter' && items[i]?.guess) { e.preventDefault(); answer(items[i].guess); }
    else if (e.key === 'ArrowLeft' && i > 0) { i--; show(); }
    else if (e.key === 'ArrowRight' && i < items.length) { i++; show(); }
  };
  document.addEventListener('keydown', onKey);
  show();
}
