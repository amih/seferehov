import { api, getMe } from './api.js';
import { dialog, esc, getPosition, toast } from './ui.js';
import { t, lang } from './i18n.js';

const KMS = [1, 5, 20, 50];

// "Tell me when this book shows up": at this library (if there is one), near me, or anywhere.
// Or any book by an author (kind 'author'), or with some words (kind 'words'): query.
export async function watchDialog({ book = null, kind = 'book', query = '', code = null, pos = null, km = 5 }) {
  if (!await getMe()) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
  const ok = await dialog({
    title: t(kind === 'book' ? 'watch.title' : `watch.title_${kind}`),
    html: `<p>${esc(kind === 'book' ? t('watch.body', { title: book.title }) : t(`watch.body_${kind}`, { q: query }))}</p>
      <div class="choices" id="watch-scope">
        ${code ? `<label><input type="radio" name="scope" value="here" checked> ${t('watch.here')}</label>` : ''}
        <label><input type="radio" name="scope" value="near" ${code ? '' : 'checked'}> ${t('watch.near')}
          <select name="km">${KMS.map((n) => `<option value="${n}" ${n === km ? 'selected' : ''}>${t('find.km', { n })}</option>`).join('')}</select></label>
        <label><input type="radio" name="scope" value="anywhere"> ${t('watch.anywhere')}</label>
      </div>`,
    ok: t('watch.save'),
    cancel: t('watch.cancel'),
    read: (el) => ({ scope: el.querySelector('input[name=scope]:checked').value, km: Number(el.querySelector('select[name=km]').value) }),
  });
  if (!ok) return;
  const body = kind === 'book' ? { book_id: book.id, scope: ok.scope, lang: lang() } : { kind, query, scope: ok.scope, lang: lang() };
  try {
    if (ok.scope === 'here') body.code = code;
    if (ok.scope === 'near') Object.assign(body, pos ?? await getPosition(), { km: ok.km });
    await api('/api/watches', { method: 'POST', json: body });
    toast(t('watch.saved'));
  } catch (e) { toast(e.message); }
}
