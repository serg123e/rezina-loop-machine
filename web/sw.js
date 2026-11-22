// Offline copy of the app. VERSION is replaced with the commit on deploy (.github/workflows/web.yml),
// so every deploy fills a fresh cache and drops the old one.
const VERSION = 'dev';
const FILES = ['./', 'index.html', 'app.js', 'synth.js', 'worklet.js', 'sessions.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network first, so an online visit always gets the latest files; the cache serves offline
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request)
    .then((r) => {
      if (r.ok && new URL(e.request.url).origin === location.origin) {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return r;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
