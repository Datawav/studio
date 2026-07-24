// SeedHammer Studio service worker: cache the app shell and the shared
// font data so the tool works offline once installed.
const CACHE = 'sh-studio-v17';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './glyphs.js',
  './nfc-bus.js',
  './emu.js',
  './canvas.js',
  './tracer.js',
  './studio-core.js',
];
// The wasm blobs (emu.wasm, studio-core.wasm) and their wasm_exec.js are
// intentionally NOT precached: several MB, fetched lazily (the emulator on
// first tab open, the cost model shortly after load). The fetch handler below
// caches them opportunistically once fetched, so a second visit works offline.

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the shell, falling back to network; network responses
// are cached so a first online visit primes the offline copy.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      // Only cache successful, same-origin, basic responses. Caching a 404
      // would pin it — a stored error would then be served forever, and the
      // page could never recover. res.ok also rules out opaque/error responses.
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});
