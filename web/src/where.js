// "Where is it?": the shelf photos a book was seen in, its spine outlined, the books beside
// it named, and (for the reader's own scans) a name for the place: "living room, left
// bookcase". Shown on the book's page when there is such a photo.
import { api } from './api.js';
import { esc, timeAgo, toast } from './ui.js';
import { t } from './i18n.js';

const pts = (poly) => poly.map(([x, y]) => `${x},${y}`).join(' ');

function neighboursLine(n) {
  if (!n) return '';
  const name = (list) => list.map((x) => `«${esc(x)}»`).join(', ');
  if (n.axis === 'pile') {
    const parts = [n.above.length && t('where.under', { books: name(n.above.slice(0, 1)) }), n.below.length && t('where.on', { books: name(n.below.slice(0, 1)) })].filter(Boolean);
    return parts.length ? `<p class="small">${parts.join(' · ')}</p>` : '';
  }
  // The photo's left and right: in a Hebrew page they are still the photo's sides.
  const parts = [n.left.length && t('where.left', { books: name(n.left) }), n.right.length && t('where.right', { books: name(n.right) })].filter(Boolean);
  return parts.length ? `<p class="small">${parts.join('<br>')}</p>` : '';
}

export async function whereBox(el, bookId) {
  if (!el || !bookId) return;
  let seen = [];
  try { ({ seen } = await api(`/api/books/${bookId}/where`)); } catch { return; }
  if (!seen.length) return;
  el.innerHTML = `<h2>📍 ${t('where.title')}</h2>${seen.map((s, i) => `
    <div class="where" data-i="${i}">
      <p class="where-place">${s.location ? `<a href="/l/${esc(s.location.code)}">${esc(s.location.name || t('free_library'))}</a>`
        : s.label ? `<b>${esc(s.label)}</b>` : `<span class="muted">${t(s.mine ? 'where.unnamed' : 'where.home')}</span>`}
        <span class="muted small"> · ${timeAgo(s.at)}</span></p>
      <div class="where-photo">
        <img src="${esc(s.photo)}" alt="" loading="lazy">
        ${s.poly ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <path class="dim" fill-rule="evenodd" style="fill: rgba(0, 0, 0, .55)" d="M0,0H1V1H0Z M${s.poly.map(([x, y]) => `${x},${y}`).join(' L')} Z"></path>
          <polygon class="me" points="${pts(s.poly)}"></polygon></svg>` : ''}
      </div>
      ${s.poly ? '' : `<p class="muted small">${t('where.no_outline')}</p>`}
      ${neighboursLine(s.neighbours)}
      ${s.mine && !s.location ? `<form class="row where-label"><input name="label" maxlength="80" dir="auto" value="${esc(s.label ?? '')}" placeholder="${esc(t('where.label_ph'))}">
        <button class="btn small">${t('where.label_save')}</button></form>` : ''}
    </div>`).join('')}`;
  el.querySelectorAll('.where-label').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const s = seen[Number(f.closest('.where').dataset.i)];
      try {
        await api(`/api/scans/${s.scan}/label`, { method: 'POST', json: { label: f.label.value } });
        toast(t('where.label_saved'));
        whereBox(el, bookId);
      } catch (err) { toast(err.message); }
    };
  });
}
