/* PortableWeb PWA service worker */
const CACHE = 'portableweb-v12';
const DB_NAME = 'portableweb';
const STORE = 'bundle-files';

const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/manifest.json',
  '/app/jszip.min.js',
  '/icons/icon.svg',
];

/* ── IndexedDB helper ────────────────────────────────────────────────────── */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFile(sessionId, filePath) {
  const db = await openDB();
  const record = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(`${sessionId}/${filePath}`);
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
        return new Response(record.data, {
          status: 200,
          headers: { 'Content-Type': record.mime },
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
