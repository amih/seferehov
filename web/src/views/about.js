import { contactHtml } from '../ui.js';
import { t } from '../i18n.js';

export default function aboutView(root) {
  root.innerHTML = `
  <section class="page">
    <h1>${t('about.title')}</h1>
    <p>${t('about.lead_html')}</p>
    <p><a href="/comic">📖 ${t('about.comic')}</a></p>
    <ul>
      <li>${t('about.li1')}</li>
      <li>${t('about.li2')}</li>
      <li>${t('about.li3')}</li>
    </ul>
    <h2>${t('shelves.title')}</h2>
    <p>${t('shelves.note_html')}</p>
    <p><a href="/places">${t('seo.places_h1')}</a> · <a href="/c/il">${t('seo.israel')}</a></p>
    <h2>${t('how.title')}</h2>
    <p>${t('how.body_html')}</p>
    <h2>${t('who.title')}</h2>
    <p>${t('who.body')}</p>
    ${contactHtml()}
    <p><a class="btn" href="/settings">⚙️ ${t('settings.title')}</a></p>
    <h2>${t('about.data')}</h2>
    <p class="small">${t('about.data_html')}</p>
    <p class="small">${t('who.footnote')}</p>
  </section>`;
}
