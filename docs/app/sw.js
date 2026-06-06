/* PortableWeb PWA service worker */
const CACHE = 'portableweb-v19';
const STORE = 'bundle-files';

const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/bundle-portal.html',
  '/app/manifest.json',
  '/app/jszip.min.js',
  '/fonts/fonts.css',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

/* ── Bundle sandbox guard ────────────────────────────────────────────────── */

/* Injected into the <head> of every HTML bundle response before any bundle
   script runs. Revokes APIs that would let a bundle escape its session:
   - indexedDB  : could read/write other sessions' databases
   - serviceWorker : could register a SW that shadows the viewer's own SW
   Workers are blocked at the CSP layer (worker-src 'none') so there is no
   worker context left that could bypass these overrides. */
const SANDBOX_GUARD =
  '<script>(function(){'
  + 'try{Object.defineProperty(window,"indexedDB",{get:function(){return undefined},configurable:false})}catch(e){}'
  + 'try{Object.defineProperty(navigator,"serviceWorker",{get:function(){return undefined},configurable:false})}catch(e){}'
  + '})()</script>';

function injectGuard(html) {
  const m = html.match(/<head(\s[^>]*)?>/i);
  if (m) return html.slice(0, m.index + m[0].length) + SANDBOX_GUARD + html.slice(m.index + m[0].length);
  return SANDBOX_GUARD + html;
}

/* ── IndexedDB helper ────────────────────────────────────────────────────── */

function openDB(sessionId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`portableweb-${sessionId}`, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFile(sessionId, filePath) {
  const db = await openDB(sessionId);
  const record = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(filePath);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record; // { data: Uint8Array, mime: string } | undefined
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch ───────────────────────────────────────────────────────────────── */

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  /* Bundle files: /app/bundle/<sessionId>/<path> — served from IndexedDB */
  const bundleMatch = url.pathname.match(/^\/app\/bundle\/([^/]+)\/(.*)/);
  if (bundleMatch) {
    const [, sessionId, filePath] = bundleMatch;
    const path = filePath || 'index.html';

    e.respondWith((async () => {
      try {
        const record = await getFile(sessionId, path);
        if (!record) {
          return new Response(`File not found in bundle: ${path}`, {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        const isHtml = record.mime === 'text/html';
        const body = isHtml
          ? new TextEncoder().encode(injectGuard(new TextDecoder().decode(record.data)))
          : record.data;

        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': record.mime,
            'Content-Security-Policy':
              `default-src 'self' blob: data:; ` +
              `script-src 'self' 'unsafe-inline' 'unsafe-eval'; ` +
              `style-src 'self' 'unsafe-inline'; ` +
              `img-src 'self' blob: data:; ` +
              `font-src 'self' data:; ` +
              `media-src 'self' blob: data:; ` +
              `connect-src /app/bundle/${sessionId}/; ` +
              `worker-src 'none'; ` +
              `form-action 'none';`,
          },
        });
      } catch (err) {
        return new Response('Service worker error: ' + err.message, { status: 500 });
      }
    })());
    return;
  }

  /* App shell: cache-first */
  if (!url.pathname.startsWith('/app/') && !url.pathname.startsWith('/icons/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
