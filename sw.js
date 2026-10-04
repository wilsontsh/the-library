/* The Library — service worker.
 * Bump VERSION on every deploy that changes any precached file, so clients pick up the new shell.
 */
const VERSION = 'lib-v27';

const SHELL_CACHE = 'shell-' + VERSION;
const COVERS_CACHE = 'covers';          // shared across versions, capped below
const COVERS_MAX = 400;
const NAV_TIMEOUT_MS = 3000;

const SCOPE = self.registration.scope;  // e.g. https://wilsontsh.github.io/the-library/
const u = (p) => new URL(p, SCOPE).href;

const SHELL_FILES = [
  'ladder.webp',
  'wall_blur.jpg',
  'lib/zxing-ean.js',
  'lib/scan.js',
  'lib/csv.js',
  'lib/qr.js',
  'lib/t2s.js',
  './',
  'index.html',
  'fonts.css',
  'fonts/cormorant-garamond-latin-500-normal.woff2',
  'fonts/cormorant-garamond-latin-600-normal.woff2',
  'fonts/cormorant-garamond-latin-700-normal.woff2',
  'fonts/cormorant-garamond-latin-ext-500-normal.woff2',
  'fonts/cormorant-garamond-latin-ext-600-normal.woff2',
  'fonts/cormorant-garamond-latin-ext-700-normal.woff2',
  'fonts/courier-prime-latin-400-normal.woff2',
  'fonts/courier-prime-latin-700-normal.woff2',
  'fonts/courier-prime-latin-ext-400-normal.woff2',
  'fonts/courier-prime-latin-ext-700-normal.woff2',
  'fonts/eb-garamond-latin-400-italic.woff2',
  'fonts/eb-garamond-latin-400-normal.woff2',
  'fonts/eb-garamond-latin-500-normal.woff2',
  'fonts/eb-garamond-latin-600-normal.woff2',
  'fonts/eb-garamond-latin-ext-400-italic.woff2',
  'fonts/eb-garamond-latin-ext-400-normal.woff2',
  'fonts/eb-garamond-latin-ext-500-normal.woff2',
  'fonts/eb-garamond-latin-ext-600-normal.woff2',
  'wall.jpg',
  'desk.jpg',
  'desk_blur.jpg',
  'catalogue.jpg',
  'catalogue_blur.jpg',
  'spines.webp',
  'ui_brass.png',
  'ui_leather.png',
  'silk.jpg',
  'exlibris.jpg',
  'parchment.jpg',
  'examples.json',
  'icon-180.png',
  'icon-512.png',
  'manifest.webmanifest',
].map(u);

const INDEX_URL = u('index.html');
const ROOT_URL = u('./');

const COVER_HOSTS = new Set(['covers.openlibrary.org', 'books.google.com', 'books.googleusercontent.com']);

// Always network-only (never touched by the cache).
function isNeverCache(url) {
  if (url.hostname === 'api.github.com') return true;
  if (url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com')) {
    if (url.pathname.startsWith('/books')) return true;
  }
  if (url.hostname === 'openlibrary.org' || url.hostname === 'www.openlibrary.org') {
    if (url.pathname === '/search.json' || url.pathname.startsWith('/works')) return true;
  }
  return false;
}

/* ---------- lifecycle ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache:'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600) so we get fresh files.
    await cache.addAll(SHELL_FILES.map((href) => new Request(href, { cache: 'reload' })));
    // If an older worker is already in control, this one will now sit in "waiting": tell the pages.
    if (self.registration.active) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: 'UPDATE_READY', version: VERSION });
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  else if (data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

/* ---------- strategies ---------- */

function isIndexLike(url) {
  return url.origin === self.location.origin &&
    (url.href.split(/[?#]/)[0] === ROOT_URL || url.href.split(/[?#]/)[0] === INDEX_URL);
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(request.url);
  // Store fresh copies under the canonical shell keys so offline fallback always finds them.
  const key = url.href.split(/[?#]/)[0] === INDEX_URL ? INDEX_URL : ROOT_URL;

  const network = fetch(request).then(async (res) => {
    if (res && res.ok && res.type === 'basic' && !res.redirected) {
      await cache.put(key, res.clone());
    }
    return res;
  });

  const cachedFallback = async () =>
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match(key)) ||
    (await cache.match(ROOT_URL)) ||
    (await cache.match(INDEX_URL));

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NAV_TIMEOUT_MS, 'timeout'); });

  try {
    const winner = await Promise.race([network, timeout]);
    if (winner !== 'timeout') { clearTimeout(timer); return winner; }
    // Network is slow: serve the cache if we have it, otherwise keep waiting for the network.
    const cached = await cachedFallback();
    return cached || await network;
  } catch (err) {
    clearTimeout(timer);
    const cached = await cachedFallback();
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function trimCovers(cache) {
  const keys = await cache.keys();          // insertion order: oldest first
  const excess = keys.length - COVERS_MAX;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidateCover(event) {
  const request = event.request;
  const cache = await caches.open(COVERS_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request).then(async (res) => {
    // Opaque (no-cors <img>) responses are fine for images.
    if (res && (res.ok || res.type === 'opaque')) {
      try {
        await cache.put(request, res.clone());
        await trimCovers(cache);
      } catch (_) { /* quota exceeded etc. — ignore */ }
    }
    return res;
  });

  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

/* ---------- router ---------- */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Explicitly network-only APIs: let the browser handle them untouched.
  if (isNeverCache(url)) return;

  // Cover images: stale-while-revalidate into the capped covers cache.
  if (COVER_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidateCover(event));
    return;
  }

  // Everything else cross-origin, or same-origin but outside our scope: untouched.
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;

  // Page navigations and index.html: network-first with timeout.
  if (request.mode === 'navigate' || isIndexLike(url)) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  // Same-origin static assets: cache-first.
  event.respondWith(cacheFirst(request));
});
