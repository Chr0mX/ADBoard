/* ADBoard app-shell service worker. Version bump to refresh caches. */
const CACHE_PREFIX = "pc-shell-";
const CACHE_VERSION = "pc-shell-v71";
/* The mobile app (/m/) has its own worker and caches (public/m/sw.js). This
   worker never touches them and never answers for /m. */
const MOBILE_PREFIX = "/m";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Add individually so one missing path (e.g. /index.html on next dev)
      // does not fail the whole install.
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            // optional shell asset
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()).then(() =>
      self.clients.matchAll({ type: "window" }).then((clients) => {
        for (const client of clients) {
          if ("navigate" in client) {
            void client.navigate(client.url);
          } else {
            client.postMessage({ type: "pc-sw-updated", version: CACHE_VERSION });
          }
        }
      }),
    ),
  );
});

function isMobilePath(path) {
  return path === MOBILE_PREFIX || path.startsWith(MOBILE_PREFIX + "/");
}

function isNetworkOnly(url) {
  const path = url.pathname;
  if (path.startsWith("/api/") || path.startsWith("/ws")) return true;
  if (/\.(mp4|webm|m4s|m3u8|ts|aac|mp3|wav|ogg)$/i.test(path)) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isMobilePath(url.pathname)) return;
  if (isNetworkOnly(url)) return;
  if (request.headers.get("accept")?.includes("video/") || request.headers.get("accept")?.includes("audio/")) {
    return;
  }

  // Hashed Next static assets: cache-first
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // App shell: network falling back to cache
  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match("/"))),
    );
  }
});
