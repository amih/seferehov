import { api, getMe } from './api.js';
import { navigate } from './nav.js';
import { esc, toast } from './ui.js';
import { t } from './i18n.js';

const QUESTIONS = ['summary', 'liked', 'recommend_to', 'when'];

// Under a book: one tap "I read it", then stars, then a few guided questions for a
// review in the reader's own words. Everything is public under the screen name.
// onSaved() runs after a change, so the page can show it.
export async function reviewBox(el, bookId, { onSaved = () => {} } = {}) {
  if (!el) return;
  const me = await getMe();
  let mine = null;
  if (me) mine = (await api(`/api/books/${bookId}/reviews`).catch(() => ({}))).mine ?? null;

  const save = async (body, quiet = false) => {
    try {
      const r = await api(`/api/books/${bookId}/review`, { method: 'PUT', json: body });
      mine = r.mine;
      if (!quiet) onSaved();
      render();
      return true;
    } catch (e) {
      const err = e.body?.error;
      if (err === 'screen_name_required') {
        sessionStorage.setItem('seferehov:next', location.pathname);
        navigate('/me?welcome=1');
        return false;
      }
      toast(err === 'copied' ? t('review.copied') : err === 'private_info' ? t('review.private') : e.message);
      return false;
    }
  };

  function render() {
    if (!me) {
      el.innerHTML = `<p><button class="btn primary" data-act="login">${t('review.btn_read')}</button> <span class="muted small">${t('review.login')}</span></p>`;
      return;
    }
    if (!mine) {
      el.innerHTML = `<div class="review-box"><p><button class="btn primary" data-act="read">${t('review.btn_read')}</button></p>
        <p class="muted small">${t('review.public_note')}</p></div>`;
      return;
    }
    const a = mine.answers ?? {};
    const wrote = QUESTIONS.some((k) => a[k]);
    el.innerHTML = `<div class="review-box">
      <p class="row"><span class="ok">${t('review.btn_read_on')}</span> <button class="btn small" data-act="unread">${t('review.undo')}</button></p>
      <p>${t('review.rate')} <span class="star-pick" role="radiogroup">${[1, 2, 3, 4, 5].map((n) =>
        `<button type="button" data-star="${n}" class="${mine.rating >= n ? 'on' : ''}" aria-label="${n}/5" aria-checked="${mine.rating === n}">★</button>`).join('')}</span></p>
      <details ${wrote ? '' : 'open'}><summary class="btn">${t(wrote ? 'review.edit' : 'review.write')}</summary>
        <form class="form review-form">
          <p class="muted small">${t('review.write_lead')}</p>
          ${QUESTIONS.map((k) => `<label>${t(`review.f_${k}`)}
            <textarea name="${k}" dir="auto" rows="${k === 'liked' ? 5 : 2}" placeholder="${esc(t(`review.f_${k}_ph`))}">${esc(a[k] ?? '')}</textarea></label>`).join('')}
          <p class="muted small">${t('review.public_note')}</p>
          <button class="btn primary">${t('review.save')}</button>
        </form></details></div>`;
    el.querySelector('.review-form').onsubmit = async (e) => {
      e.preventDefault();
      const answers = Object.fromEntries(QUESTIONS.map((k) => [k, e.target[k].value]));
      if (await save({ answers })) toast(t('review.saved'));
    };
  }

  el.onclick = (e) => {
    const b = e.target.closest('[data-act],[data-star]');
    if (!b) return;
    if (b.dataset.star) return save({ rating: Number(b.dataset.star) });
    if (b.dataset.act === 'login') return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
    if (b.dataset.act === 'read') return save({ read: true });
    if (b.dataset.act === 'unread') return save({ read: false });
  };
  render();
}
