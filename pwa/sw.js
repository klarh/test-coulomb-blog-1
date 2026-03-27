const CACHE_NAME = 'coulomb-v5';
const PYODIDE_VERSION = '0.27.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Immutable CDN / package hosts — safe to cache forever
const IMMUTABLE_HOSTS = [
  'cdn.jsdelivr.net',
  'files.pythonhosted.org',
];

self.addEventListener('install', (event) => {
  // Pre-cache critical Pyodide assets so first load after SW install is fast
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        `${PYODIDE_CDN}pyodide.js`,
        `${PYODIDE_CDN}pyodide.asm.js`,
        `${PYODIDE_CDN}pyodide.asm.wasm`,
        `${PYODIDE_CDN}python_stdlib.zip`,
        `${PYODIDE_CDN}pyodide-lock.json`,
        `${PYODIDE_CDN}micropip-0.8.0-py3-none-any.whl`,
      ]).catch(() => {
        // Non-fatal — assets will be cached on first use instead
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

function isImmutable(url) {
  try {
    const host = new URL(url).hostname;
    return IMMUTABLE_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Cache-first for immutable CDN assets (Pyodide, PyPI wheels, etc.)
  if (isImmutable(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Stale-while-revalidate for app assets: serve from cache instantly,
  // update cache in background. First visit builds cache; subsequent visits
  // are instant from cache with background refresh.
  if (new URL(url).origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Network-only for external API calls (GitHub, etc.)
  event.respondWith(fetch(event.request));
});
