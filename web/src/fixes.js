import { api, getMe } from './api.js';
import { navigate } from './nav.js';
import { esc, timeAgo, toast } from './ui.js';
import { t } from './i18n.js';

// "Fix a mistake" on a book page: anyone signed in can correct the title, author,
// publisher, year, blurb or the text read from a cover photo — even what another reader
// approved. Trusted readers' fixes show at once; others wait for two votes (/fixes).
// Every change is kept: "History" lists them, with votes on waiting ones and an undo
// on the one showing now.
const FIELDS = ['title', 'authors', 'publisher', 'year', 'description'];

export function fixBox(el, bookId, { onSaved } = {}) {
  if (!el) return;
  let data = null;
  const load = async () => { data = await api(`/api/books/${bookId}/fixes`); return data; };
  const draw = () => {
    const waiting = data?.history.filter((f) => f.status === 'pending').length ?? 0;
    el.innerHTML = `<p class="row fix-row"><button class="btn small" data-fix>✏️ ${t('fix.button')}</button>
      ${data?.history.length ? `<button class="link small" data-history>${t('fix.history', { n: data.history.length })}${waiting ? ` · ${t('fix.n_waiting', { n: waiting })}` : ''}</button>` : ''}</p>`;
  };
  draw();
  load().then(draw, () => {});
  el.onclick = async (e) => {
    if (e.target.closest('[data-fix]')) {
      if (!await getMe()) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
      await load().catch(() => null);
      if (data && await fixForm(bookId, data)) { await load().catch(() => null); draw(); onSaved?.(); }
    } else if (e.target.closest('[data-history]')) {
      await load().catch(() => null);
      if (data) history(data, async () => { await load(); draw(); onSaved?.(); return data; });
    }
  };
}

// A sheet over the page; returns its element and a close function.
function sheet(html) {
  const el = document.createElement('div');
  el.className = 'dialog-back';
  el.innerHTML = `<div class="dialog fix-sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  document.body.append(el);
  return { el, close };
}

const fieldLabel = (f) => (f.field === 'cover_text' ? t(f.photo_kind === 'back' ? 'fix.f.back_text' : 'fix.f.front_text') : t(`fix.f.${f.field}`));

function fixForm(bookId, { book, texts, me }) {
  return new Promise((resolve) => {
    const box = (field, value, long) => long
      ? `<textarea name="${field}" dir="auto" rows="${field === 'description' ? 5 : 6}">${esc(value ?? '')}</textarea>`
      : `<input name="${field}" dir="auto" value="${esc(value ?? '')}"${field === 'year' ? ' inputmode="numeric" maxlength="4"' : ''}>`;
    const { el, close } = sheet(`
      <h2>✏️ ${t('fix.title')}</h2>
      <p class="muted small">${t(me?.live ? 'fix.how_live' : 'fix.how_pending')}</p>
      <form class="form fix-form">
        ${FIELDS.map((f) => `<label>${t(`fix.f.${f}`)} ${box(f, book[f], f === 'description')}</label>`).join('')}
        ${texts.map((x) => `<div class="fix-text"><img src="${esc(x.url)}" alt="">
          <label>${t(x.kind === 'back' ? 'fix.f.back_text' : 'fix.f.front_text')} <textarea data-photo="${esc(x.photo_id)}" dir="auto" rows="6">${esc(x.text)}</textarea></label></div>`).join('')}
        <label>${t('fix.note')} <input name="note" dir="auto" maxlength="300" placeholder="${esc(t('fix.note_hint'))}"></label>
      </form>
      <div class="dialog-actions"><button class="btn primary" data-save>✓ ${t('fix.save')}</button><button class="btn" data-close>${t('cancel')}</button></div>`);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) resolve(false); });
    el.querySelector('[data-save]').onclick = async (e) => {
      const form = el.querySelector('form');
      const changes = {};
      for (const f of FIELDS) if (form[f].value.trim() !== String(book[f] ?? '').trim()) changes[f] = form[f].value;
      const textChanges = {};
      form.querySelectorAll('textarea[data-photo]').forEach((ta) => {
        const was = texts.find((x) => x.photo_id === ta.dataset.photo)?.text ?? '';
        if (ta.value.trim() !== was.trim()) textChanges[ta.dataset.photo] = ta.value;
      });
      if (!Object.keys(changes).length && !Object.keys(textChanges).length) { close(); resolve(false); return; }
      e.target.disabled = true;
      try {
        const r = await api(`/api/books/${bookId}/fixes`, { method: 'POST', json: { changes, texts: textChanges, note: form.note.value } });
        toast(r.pending ? t('fix.sent', { n: r.pending }) : t('fix.done'));
        close();
        resolve(true);
      } catch (err) {
        toast(t(`fix.err.${err.message}`) === `fix.err.${err.message}` ? err.message : t(`fix.err.${err.message}`));
        e.target.disabled = false;
      }
    };
  });
}

const statusLine = (f) => {
  const s = t(`fix.s.${f.status}`);
  return f.status === 'pending' ? `${s} · 👍 ${f.up} · 👎 ${f.down}` : s;
};
const diff = (f) => `<span class="fix-old" dir="auto">${esc(f.old_value || '—')}</span> → <b class="fix-new" dir="auto">${esc(f.new_value || '—')}</b>`;

// Every fix of the book, newest first.
function history(data, reload) {
  const { el, close } = sheet('');
  const draw = (d) => {
    el.firstElementChild.innerHTML = `<h2>${t('fix.history_title')}</h2>
      <ul class="fix-list">${d.history.map((f) => `<li data-id="${f.id}" class="s-${f.status}">
        <p class="small"><b>${esc(fieldLabel(f))}</b>${f.reverts ? ` · ↩ ${t('fix.an_undo')}` : ''} · ${esc(f.by_name)} · ${timeAgo(f.created_at)}</p>
        <p class="fix-diff">${diff(f)}</p>
        ${f.note ? `<p class="small">💬 ${esc(f.note)}</p>` : ''}
        <p class="small muted">${statusLine(f)}</p>
        <p class="row">${f.status === 'pending' && d.me?.can_vote && !f.mine
          ? `<button class="btn small ${f.my_vote === 1 ? 'primary' : ''}" data-vote="1">👍 ${t('fix.vote_up')}</button><button class="btn small ${f.my_vote === -1 ? 'danger' : ''}" data-vote="-1">👎 ${t('fix.vote_down')}</button>` : ''}
          ${f.undoable && d.me ? `<button class="btn small" data-undo>↩ ${t('fix.undo')}</button>` : ''}</p>
      </li>`).join('')}</ul>
      <div class="dialog-actions"><button class="btn" data-close>${t('menu.close')}</button></div>`;
  };
  draw(data);
  el.addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    const v = e.target.closest('[data-vote]');
    const u = e.target.closest('[data-undo]');
    if (!li || (!v && !u)) return;
    e.target.disabled = true;
    try {
      if (v) {
        const r = await api(`/api/fixes/${li.dataset.id}/vote`, { method: 'POST', json: { vote: Number(v.dataset.vote) } });
        toast(t(`fix.voted_${r.status}`));
      } else {
        const r = await api(`/api/fixes/${li.dataset.id}/undo`, { method: 'POST', json: {} });
        toast(r.status === 'pending' ? t('fix.sent', { n: 1 }) : t('fix.undone'));
      }
      draw(await reload());
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  return close;
}

// The to-do tab: fixes waiting for votes, with the cover to check them against.
export async function fixVoteList(root, tabs) {
  const { items, me } = await api('/api/fixes');
  root.innerHTML = `<section class="page">
    ${tabs}
    <h1>${t('fix.queue_title')}</h1>
    <p class="muted small">${t('fix.queue_how')}</p>
    ${!me.can_vote ? `<p class="note">${t('fix.cannot_vote')}</p>` : ''}
    <ul class="review fix-votes">${items.map((f) => `<li data-id="${f.id}">
      ${f.cover ? `<a href="${esc(f.cover)}" target="_blank"><img src="${esc(f.cover)}" alt=""></a>` : '<span class="noimg"></span>'}
      <div><a href="/b/${f.book_id}" dir="auto"><strong>${esc(f.title ?? '')}</strong></a><br>
        <span class="small"><b>${esc(fieldLabel(f))}</b>:</span> <span class="fix-diff">${diff(f)}</span><br>
        ${f.note ? `<span class="small">💬 ${esc(f.note)}</span><br>` : ''}
        <span class="muted small">${esc(f.by_name)} · ${timeAgo(f.created_at)} · 👍 ${f.up} · 👎 ${f.down}</span></div>
      <div class="col"><button class="btn primary" data-vote="1">👍 ${t('fix.vote_up')}</button><button class="btn" data-vote="-1">👎 ${t('fix.vote_down')}</button></div>
    </li>`).join('') || `<p class="muted">${t('review.nothing')}</p>`}</ul>
  </section>`;
  root.onclick = async (e) => {
    const b = e.target.closest('[data-vote]');
    if (!b) return;
    const li = b.closest('li');
    li.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const r = await api(`/api/fixes/${li.dataset.id}/vote`, { method: 'POST', json: { vote: Number(b.dataset.vote) } });
      toast(t(`fix.voted_${r.status}`));
      li.remove();
    } catch (err) { toast(err.message); li.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
  };
  return () => { root.onclick = null; };
}
