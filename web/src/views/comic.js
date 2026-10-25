import { comicHtml } from '../comic.js';
import { lang } from '../i18n.js';
import { COMIC_KEY } from './map.js';

export default function comicView(root) {
  try { localStorage.setItem(COMIC_KEY, '1'); } catch {}
  root.innerHTML = comicHtml(lang());
}
