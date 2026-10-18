// Matomo page views, cookie-less. Configured at build time from (gitignored)
// web/.env.production.local: VITE_MATOMO_URL, VITE_MATOMO_SITE_ID.
const url = import.meta.env.VITE_MATOMO_URL?.replace(/\/?$/, '/');
const siteId = import.meta.env.VITE_MATOMO_SITE_ID;
const _paq = (window._paq = window._paq || []);
const NO_TRACK = 'seferehov:notrack';
let started = false;

// Admins' devices are never counted, on any network, even after logging out.
export function dontTrackThisDevice() {
  try { localStorage.setItem(NO_TRACK, '1'); } catch {}
}

export function tracked() {
  try { return !localStorage.getItem(NO_TRACK); } catch { return true; }
}

export function trackPageView() {
  if (!url || !siteId || !tracked()) return;
  if (!started) {
    started = true;
    _paq.push(['disableCookies']);
    _paq.push(['enableLinkTracking']);
    _paq.push(['setTrackerUrl', `${url}matomo.php`]);
    _paq.push(['setSiteId', siteId]);
    const s = document.createElement('script');
    s.async = true;
    s.src = `${url}matomo.js`;
    document.head.append(s);
  }
  _paq.push(['setCustomUrl', location.pathname + location.search]);
  _paq.push(['setDocumentTitle', document.title]);
  _paq.push(['trackPageView']);
}
