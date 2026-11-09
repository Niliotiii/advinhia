/* AdivinhIA service worker — offline support.
 *
 * The game runs inference locally, so once the app shell, the hashed JS/CSS,
 * and the model files are cached, the whole experience works with no network.
 *
 * Strategy:
 *  - Precache the app entry + the model files (stable URLs) on install.
 *  - For other same-origin GET requests (hashed assets, fonts), use
 *    stale-while-revalidate: serve from cache if present, and refresh the
 *    cache in the background.
 *  - Bump CACHE_VERSION to invalidate old caches on deploy.
 */
const CACHE_VERSION = "adivinhia-v1";

// Stable URLs worth precaching up front. Hashed build assets are cached
// on-demand at runtime (their names change every build).
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/model/model.json",
  "/model/group1-shard1of1.bin",
  "/model/class_names.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Never touch multiplayer routes. /room/:code may be a WebSocket upgrade
  // (which must reach the Worker/Durable Object directly) and the /room page
  // requires a live connection — caching it would break online play.
  if (sameOrigin && url.pathname.startsWith("/room")) {
    return; // fall through to the network
  }
  if (req.headers.get("Upgrade") === "websocket") {
    return;
  }

  // Navigation requests: network-first, so a fresh deploy's HTML (which points
  // at new hashed assets) is always preferred when online. We refresh the
  // cached shell on every successful load, and fall back to it only offline.
  // This prevents a stale cached HTML from referencing assets that no longer
  // exist after a deploy.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => {
              c.put("/index.html", copy.clone());
              c.put("/", copy);
            });
          }
          return res;
        })
        .catch(() =>
          caches.match("/index.html").then((r) => r || caches.match("/")),
        ),
    );
    return;
  }

  // Same-origin assets + Google Fonts: stale-while-revalidate.
  const isFont =
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com";

  if (sameOrigin || isFont) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
