import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { api, getMe } from '../api.js';
import { esc, getPosition, toast } from '../ui.js';
import { t, isRtl, lang } from '../i18n.js';
import { navigate } from '../nav.js';
import { captureShots, captureFiles, askMotion } from '../capture.js';

const VIEW_KEY = 'seferehov:mapView';
export const COMIC_KEY = 'seferehov:comicSeen'; // set when the comic was opened or the hint closed
const ISRAEL = [[29.45, 34.25], [33.34, 35.9]]; // first-visit view

// Green = added in the app or has books reported; pale = imported from OpenStreetMap, nothing known yet.
const isLive = (l) => l.source !== 'osm' || l.books > 0;
const pin = (books, kind) => L.divIcon({
  className: '',
  html: `<div class="pin ${kind}"><span>${books || '📚'}</span></div>`,
  ...(kind === 'osm'
    ? { iconSize: [26, 32], iconAnchor: [13, 30], popupAnchor: [0, -28] }
    : { iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -36] }),
});

const bubble = (n) => {
  const size = Math.round(Math.min(28 + 8 * Math.log10(n), 56));
  return L.divIcon({
    className: '',
    html: `<div class="bubble" style="width:${size}px;height:${size}px">${n >= 10000 ? `${Math.round(n / 1000)}k` : n}</div>`,
    iconSize: [size, size],
  });
};

// Opening the app (a fresh load, or back to it after a while) moves the map to where the reader
// is (Ami, 24 Nov), not to where the map was left. Coming back to the map from a library inside
// the app keeps the view.
const RECENTRE_AFTER_MS = 5 * 60_000;
let centredThisLoad = false;

function savedView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY)) || null; } catch { return null; }
}

export default function mapView(root, _, query) {
  root.innerHTML = `
    <div id="map"></div>
    <button class="fab-locate" title="${t('map.locate')}" aria-label="${t('map.locate')}">◎</button>
    <div class="fab-row"><button class="fab-cam" aria-label="${esc(t('map.camera'))}">📸 ${t('map.camera')}</button><a class="fab-search" href="/search">${t('map.search')}</a></div>
    <div class="cam-sheet" hidden><button class="sheet-x" aria-label="${esc(t('menu.close'))}">✕</button>
      <div class="shots" id="capture-panel" hidden></div>
      <input type="file" accept="image/*" multiple hidden id="cam-files"></div>`;
  // Newcomers get one line pointing to the comic, until they open it or close the line.
  let seen = true;
  try { seen = !!localStorage.getItem(COMIC_KEY); } catch {}
  if (!seen) {
    root.insertAdjacentHTML('beforeend', `<div class="comic-hint"><a href="/comic">📖 ${t('comic.hint')} <b>${t('comic.hint_go')}</b></a><button aria-label="${t('menu.close')}">✕</button></div>`);
    root.querySelector('.comic-hint button').onclick = (e) => {
      try { localStorage.setItem(COMIC_KEY, '1'); } catch {}
      e.currentTarget.parentElement.remove();
    };
  }
  // /?at=lat,lon,zoom — links from the place pages
  const at = (query?.get('at') ?? '').split(',').map(Number);
  const start = at.length === 3 && at.every(Number.isFinite) ? { lat: at[0], lon: at[1], zoom: at[2] } : savedView();
  const map = L.map('map', { zoomControl: false, maxZoom: 19 });
  if (start) map.setView([start.lat, start.lon], start.zoom);
  else map.fitBounds(ISRAEL);
  let removed = false;
  import('../basemap.js').then((m) => m.basemap()).then((layer) => { if (!removed) layer.addTo(map); });
  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: (c) => {
      const n = c.getChildCount();
      const live = c.getAllChildMarkers().some((m) => m.options.live);
      const size = n < 10 ? 'small' : n < 100 ? 'medium' : 'large';
      return L.divIcon({ html: `<div><span>${n}</span></div>`, className: `marker-cluster marker-cluster-${size}${live ? ' live' : ''}`, iconSize: L.point(40, 40) });
    },
  });
  map.addLayer(cluster);
  const bubbles = L.layerGroup().addTo(map);
  const shown = new Map();
  let me = null;

  // The area asked for is widened to a grid of half map tiles at this zoom (and the width to
  // 200 px steps), so that small moves ask for nothing new and many phones ask for the same
  // areas, which the server and the network can then answer from their copies.
  let lastAsked = null;
  async function load() {
    const b = map.getBounds();
    const zoom = map.getZoom();
    const step = 360 / 2 ** Math.floor(zoom) / 2;
    const snap = (n, round, lim) => Math.min(Math.max(round(n / step) * step, -lim), lim).toFixed(5);
    const bbox = [snap(b.getWest(), Math.floor, 180), snap(b.getSouth(), Math.floor, 90), snap(b.getEast(), Math.ceil, 180), snap(b.getNorth(), Math.ceil, 90)].join(',');
    const px = Math.max(200, Math.round(map.getSize().x / 200) * 200);
    const ask = `/api/locations?bbox=${bbox}&zoom=${Math.floor(zoom)}&px=${px}`;
    if (ask === lastAsked) return;
    lastAsked = ask;
    try {
      const { locations, clusters } = await api(ask);
      if (zoom !== map.getZoom()) return; // a newer load is coming
      bubbles.clearLayers();
      if (clusters) {
        map.removeLayer(cluster);
        for (const c of clusters) {
          if (c.n === 1) { bubbles.addLayer(L.marker([c.lat, c.lon], { icon: pin(0, 'osm') }).on('click', () => map.setView([c.lat, c.lon], 15))); continue; }
          bubbles.addLayer(L.marker([c.lat, c.lon], { icon: bubble(c.n) }).on('click', () => map.setView([c.lat, c.lon], Math.min(zoom + 3, 16))));
        }
        return;
      }
      map.addLayer(cluster);
      for (const l of locations) {
        if (shown.has(l.code)) continue;
        const kind = l.status === 'pending' ? 'pending' : isLive(l) ? 'live' : 'osm';
        const m = L.marker([l.lat, l.lon], { icon: pin(l.books, kind), live: kind !== 'osm', zIndexOffset: kind === 'osm' ? 0 : 1000 });
        m.bindPopup(`<div dir="${isRtl() ? 'rtl' : 'ltr'}"><strong>${esc(l.name || t('free_library'))}</strong><br>
          ${l.books ? t('map.books', { n: l.books }) : t('map.no_books')}
          ${l.status === 'pending' ? `<br><em>${t('map.pending')}</em>` : ''}
          <br><a href="/l/${l.code}">${t('map.open')}</a></div>`);
        cluster.addLayer(m);
        shown.set(l.code, m);
      }
    } catch { lastAsked = null; /* offline: keep what is shown */ }
  }

  let timer;
  map.on('moveend', () => {
    const c = map.getCenter();
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() })); } catch {}
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  load();

  // fly: animate there at street level (the button); centre: jump there (opening the app).
  async function locate(fly = true, centre = false) {
    try {
      const p = await getPosition();
      if (!root.isConnected) return;
      if (me) me.setLatLng([p.lat, p.lon]);
      else me = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2a7de1', fillOpacity: 1 }).addTo(map);
      if (fly) map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 16)); // street level, like Google Maps
      else if (centre) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
    } catch (e) { if (fly) toast(e.message); }
  }
  root.querySelector('.fab-locate').onclick = () => locate(true);
  // Search opens on every book around what the map shows; typing narrows it down.
  root.querySelector('.fab-search').onclick = (e) => {
    const c = map.getCenter();
    const z = map.getZoom();
    const km = z >= 15 ? 1 : z >= 12 ? 5 : z >= 10 ? 20 : 50;
    e.currentTarget.href = `/search?${new URLSearchParams({ km, at: `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`, from: t('find.map_area') })}`;
  };
  // Where the reader is: on opening the app the map moves there (if the phone already allows
  // location, so no question pops up over a saved view); otherwise only the blue dot.
  const linked = at.length === 3 && at.every(Number.isFinite);
  (async () => {
    const granted = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state === 'granted').catch(() => false);
    if (!start) return locate(false, true);
    if (!granted) return;
    locate(false, !linked && !centredThisLoad);
  })();
  centredThisLoad = true;
  let hiddenAt = 0;
  const onVisible = () => {
    if (!root.isConnected) return document.removeEventListener('visibilitychange', onVisible);
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > RECENTRE_AFTER_MS) locate(false, true);
  };
  document.addEventListener('visibilitychange', onVisible);

  // One camera for everything (docs/ONE_CAMERA_PLAN.md): no question first. The phone's hints go
  // with the photos and the server guesses where they were taken; the reader checks it in the queue.
  const sheet = root.querySelector('.cam-sheet');
  const request = () => ({ lang: lang() });
  const cam = captureShots({ panel: sheet.querySelector('#capture-panel'), request, guess: true, screen: 'map' });
  root.querySelector('.fab-cam').onclick = async () => {
    askMotion(); // iPhone: the motion sensors are asked for within the tap (cam.start() comes after an await)
    if (!await getMe()) return navigate('/login?next=/');
    sheet.hidden = false;
    if (!await cam.start()) sheet.querySelector('#cam-files').click();
  };
  sheet.querySelector('#cam-files').onchange = async (e) => {
    const pos = await getPosition({ timeout: 8000 }).catch(() => null);
    const n = await captureFiles(e.target.files, () => ({ lang: lang(), guess: '1', hints: JSON.stringify(pos ? { lat: pos.lat, lon: pos.lon, acc: Math.round(pos.accuracy) } : {}) }));
    e.target.value = '';
    if (n) toast(t('capture.sent_guess', { n }));
    sheet.hidden = true;
  };
  sheet.querySelector('.sheet-x').onclick = async () => { await cam.stop(); sheet.hidden = true; };

  return () => { removed = true; document.removeEventListener('visibilitychange', onVisible); cam.stop(false); map.remove(); };
}
