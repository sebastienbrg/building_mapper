// Service Worker for TeZeLoMa Offline PWA
const CACHE_NAME = 'tezeloma-shell-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/hyparquet.bundle.js',
  './vendor/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && !key.startsWith('tezeloma-data')) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Let data chunks be handled by Cache API in app.js or cache-first for app shell
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
