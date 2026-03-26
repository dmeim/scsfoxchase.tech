// Service Worker for St. Cecilia Technology
const CACHE_NAME = 'st-cecilia-tech-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/games.html',
  '/404.html',
  '/offline.html',
  '/css/styles.css',
  '/css/carousel.css',
  '/js/carousel.js',
  '/js/games.js',
  '/js/placeholder-images.js',
  '/data/games/_index.json',
  '/data/games/_trending.json',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/webfonts/fa-solid-900.woff2'
];

// Offline fallback page
const OFFLINE_PAGE = '/offline.html';

// Install event - cache assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caching assets...');
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache, fall back to network, then offline page
self.addEventListener('fetch', event => {
  // Skip cross-origin requests except for CDN
  if (!event.request.url.startsWith(self.location.origin) && 
      !event.request.url.startsWith('https://cdnjs.cloudflare.com')) {
    return;
  }
  
  // HTML navigation requests - network first with offline fallback
  if (event.request.mode === 'navigate' || 
      (event.request.method === 'GET' && 
       event.request.headers.get('accept').includes('text/html'))) {
    
    event.respondWith(
      fetch(event.request)
        .catch(error => {
          console.log('Fetch failed; returning offline page instead.', error);
          return caches.match(OFFLINE_PAGE);
        })
    );
    return;
  }
  
  // Special handling for game data files - network first, then cache
  if (event.request.url.includes('/data/games/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  
  // For other assets - network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200) {
          return response;
        }

        // Clone the response to store in cache
        const responseClone = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => cache.put(event.request, responseClone));

        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
