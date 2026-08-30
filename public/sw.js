// Service Worker for St. Cecilia Technology (Astro)
// Navigations: network-first (never stale HTML; offline page on failure)
// /_astro/* and other assets: network-first with cache fallback
// (v2: drop cache-first on /_astro — poisoned immutable 404s broke CSS)
// postbuild replaces this placeholder so every deployment owns a fresh cache.
const CACHE_NAME = 'st-cecilia-tech-astro-__SERVICE_WORKER_BUILD_SHA__';
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
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
        const contentType = response?.headers.get('content-type') || '';
        const isHtml = contentType.toLowerCase().startsWith('text/html');
        if (response && response.status === 200 && !isHtml) {
          const clone = response.clone();
          // Keep the response fast, but make the cache write part of this
          // fetch event's lifetime so it cannot be abandoned on teardown.
          event.waitUntil(
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone))
              .catch(() => undefined)
          );
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        const contentType = cached?.headers.get('content-type') || '';
        // Never substitute a cached document here. Navigations have their
        // dedicated /offline fallback above; this branch is for static assets.
        if (contentType.toLowerCase().startsWith('text/html')) {
          return Response.error();
        }
        return cached;
      })
  );
});
