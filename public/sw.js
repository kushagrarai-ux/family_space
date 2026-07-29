const CACHE_NAME = 'family-space-v6';
// Only cache truly versioned assets (app.js?v=N, style.css) — NOT HTML
const STATIC_ASSETS = [
  '/style.css',
  '/manifest.json',
  '/favicon.svg'
];

// Install: pre-cache versioned assets only
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   HTML (/ or .html)  → network-first, fall back to cache
//   API / uploads      → network only
//   Other static       → cache-first
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-only for API calls
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return;
  }

  // Network-first for HTML so users always get the latest shell
  const isHtml = url.pathname === '/' || url.pathname.endsWith('.html') ||
                 !url.pathname.includes('.');
  if (isHtml) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for versioned static assets (CSS, JS, images)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
