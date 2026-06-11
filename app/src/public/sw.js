/* Torama Vote service worker — conservative, voting-safe caching.
 * - GET only. Never touches POST (votes/payments always hit the network).
 * - Skips /admin, /account, and *.json (private + always-fresh data).
 * - Static assets + uploads: stale-while-revalidate.
 * - Public navigations: network-first with cached fallback (offline app feel).
 */
const CACHE = 'tv-cache-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache private areas or dynamic JSON (e.g. live results).
  if (
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/account') ||
    url.pathname.endsWith('.json')
  ) {
    return;
  }

  // Static assets + uploads → stale-while-revalidate.
  if (
    url.pathname.startsWith('/static/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname === '/favicon.ico'
  ) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const network = fetch(req)
            .then((res) => {
              if (res && res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || network;
        }),
      ),
    );
    return;
  }

  // Public page navigations → network-first, fall back to cache then home.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('/'))),
    );
  }
});
