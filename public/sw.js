// Service Worker for St. Cecilia Technology (Astro)
// Navigations: network-first (never stale HTML; offline page on failure)
// /_astro/* hashed assets: cache-first
// Other same-origin assets: network-first with cache fallback
const CACHE_NAME = 'st-cecilia-tech-astro-v1';
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

  // HTML navigations — always network; never serve stale HTML
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  // Hashed Astro build assets — cache-first (content-addressed filenames)
  if (url.pathname.startsWith('/_astro/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Other same-origin assets — network-first, cache for offline fallback
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
