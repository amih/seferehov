import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { clientsClaim } from 'workbox-core';

// The new worker installs in the background and then WAITS. The page decides
// when it is safe to switch (no upload in progress) and sends SKIP_WAITING.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Take control of the page on first install, so later updates can wait for it.
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// App routes (/l/ABC123, /add, …) all load the cached index.html.
// API and server-rendered pages are never handled by the worker.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [/^\/api\//, /^\/uploads\//, /^\/robots\.txt$/, /^\/sitemap/],
}));

// Uploaded photos never change (unique file names), so cache-first is safe.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/uploads/'),
  new CacheFirst({ cacheName: 'photos', plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * 86400 })] }),
);

// The book detector's runtime and model (bookai.js): large, fetched on first use, kept.
// The file names do not change between versions of the model, so a new model gets a new name.
registerRoute(
  ({ url }) => url.origin === self.location.origin && /^\/(mediapipe|models)\//.test(url.pathname),
  new CacheFirst({ cacheName: 'book-model', plugins: [new ExpirationPlugin({ maxEntries: 10 })] }),
);

// The comic's pictures and fonts: versioned names, fetched only by those who open it.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/comic-art/'),
  new CacheFirst({ cacheName: 'comic', plugins: [new ExpirationPlugin({ maxEntries: 30 })] }),
);

// Map tiles and book covers from other sites: show what we have, refresh in the background.
// Vector map (style, fonts, icons, tiles) — the tile URLs carry a dataset version.
registerRoute(
  ({ url }) => url.hostname === 'tiles.openfreemap.org',
  new StaleWhileRevalidate({ cacheName: 'vector-map', plugins: [new ExpirationPlugin({ maxEntries: 2000, maxAgeSeconds: 30 * 86400 })] }),
);
registerRoute(
  ({ url }) => url.hostname.endsWith('tile.openstreetmap.org'),
  new StaleWhileRevalidate({ cacheName: 'tiles', plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 14 * 86400 })] }),
);
registerRoute(
  ({ url }) => url.hostname === 'covers.openlibrary.org' || url.hostname.endsWith('books.google.com'),
  new CacheFirst({ cacheName: 'covers', plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 60 * 86400 })] }),
);

// Phone notifications: a book someone waits for was reported on a shelf.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch { data = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'סֵפֶרְחוֹב', {
    body: data.body || '', icon: '/icons/icon-v2-192.png', badge: '/icons/icon-v2-192.png', lang: 'he', dir: 'auto', data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.location.origin));
    return open ? open.navigate(url).then((c) => (c ?? open).focus()) : self.clients.openWindow(url);
  }));
});
