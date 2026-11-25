// On a laptop or desktop screen the app opens as a large phone floating on a grey background, the same
// screens a phone shows. ⤢ in the header fills the window; ⤡ brings the phone back. The choice is kept.
// index.html sets the class before the first paint; style.css applies it only on wide screens (FRAMED).
import { t } from './i18n.js';

export const FRAMED = '(min-width: 900px) and (min-height: 600px)';
const KEY = 'seferehov:wide';

// In the phone frame the screen scrolls inside #view, not the window.
const scroller = () => {
  const v = document.getElementById('view');
  return v && getComputedStyle(v).overflowY === 'auto' ? v : null;
};
export const scrollPos = () => scroller()?.scrollTop ?? window.scrollY;
export function scrollToY(y) {
  const s = scroller();
  if (s) s.scrollTop = y; else window.scrollTo(0, y);
}

export function initFrame() {
  const btn = document.getElementById('frame-btn');
  if (!btn) return;
  const show = () => {
    const framed = document.documentElement.classList.contains('framed');
    btn.textContent = framed ? '⤢' : '⤡';
    btn.title = t(framed ? 'frame.max' : 'frame.phone');
    btn.setAttribute('aria-label', btn.title);
  };
  btn.onclick = () => {
    const framed = document.documentElement.classList.toggle('framed');
    try { localStorage.setItem(KEY, framed ? '0' : '1'); } catch { /* private mode: for this visit only */ }
    show();
    window.dispatchEvent(new Event('resize')); // the map redraws for its new size
  };
  show();
  document.addEventListener('seferehov:lang', show);
}
