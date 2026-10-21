import { api } from '../api.js';
import { t, lang } from '../i18n.js';
import { reviewBox } from '../review.js';
import { fixBox } from '../fixes.js';
import { contactOffer } from '../offers.js';

// Place, country, book and reader pages: the same HTML the server gives search engines.
// A book page also gets the reader's own "I read it" / stars / review box, and "Fix a mistake".
export default async function pageView(root) {
  root.innerHTML = `<section class="page"><p class="muted">${t('loading')}</p></section>`;
  try {
    const page = await api(`/api/pages?path=${encodeURIComponent(location.pathname)}&lang=${lang()}`);
    root.innerHTML = `<section class="page seo">${page.html}</section>`;
    document.title = page.title;
    const book = location.pathname.match(/^\/b\/(\d+)/);
    if (book) reviewBox(root.querySelector('#review-box'), Number(book[1]), { onSaved: () => pageView(root) });
    if (book) fixBox(root.querySelector('#fix-box'), Number(book[1]), { onSaved: () => pageView(root) });
    root.querySelectorAll('[data-offer-contact]').forEach((b) => {
      b.onclick = () => contactOffer(Number(b.dataset.offerContact), b.dataset.give === '1');
    });
  } catch (e) {
    root.innerHTML = `<section class="page"><h1>${t('notfound.title')}</h1><p>${t(e.status === 404 ? 'notfound.title' : 'offline')}</p><p><a href="/">${t('back.map')}</a></p></section>`;
  }
}
