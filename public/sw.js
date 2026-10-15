/*
 * RealtyPacer service worker — deliberately conservative.
 * Caches ONLY versioned static assets (/_next/static, /icons) and the offline
 * page. Never caches HTML of signed-in pages, API responses, customer data,
 * payments, files or auth pages. Navigations go to the network; if the network
 * is unreachable, the generic offline page is shown.
 */
const STATIC_CACHE = "rp-static-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll([OFFLINE_URL, "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  // Sent on sign-out: drop everything this worker cached.
  if (event.data === "clear-caches") event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // writes (incl. payments) always go to the network; never queued offline
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  const cacheable = url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");
  if (!cacheable) return;
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    }),
  );
});
