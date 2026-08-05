// Service Worker for St. Cecilia Technology (Astro)
// Navigations: network-first (never stale HTML; offline page on failure)
// /_astro/* and other assets: network-first with cache fallback
// (v2: drop cache-first on /_astro — poisoned immutable 404s broke CSS)
const CACHE_NAME = 'st-cecilia-tech-astro-v17';
const OFFLINE_PAGE = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // fetch+put (not cache.add) so redirect responses still store under /offline
        fetch(OFFLINE_PAGE, { redirect: 'follow' }).then((response) => {
          if (!response || !response.ok) {
            throw new Error('Failed to precache offline page');
          }
          return cache.put(OFFLINE_PAGE, response);
        })
      )
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('Clearing old cache:', name);
              return caches.delete(name);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept Worker APIs / WebSocket upgrades (whiteboard sync)
  if (url.pathname.startsWith('/api/')) return;

  // HTML navigations — always network; never serve stale HTML
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  // Same-origin assets (including hashed /_astro/*) — network-first, cache for offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
