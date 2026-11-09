/* ADBoard Mobile service worker. Scope /m/ only. Version bump to refresh.
   Own cache prefix: never deletes or reads the desktop worker's caches, and
   never answers with the desktop shell. */
const CACHE_PREFIX = "adboard-m-";
const CACHE_VERSION = "adboard-m-v3";
const SCOPE = "/m/";
const SCREENS = ["control", "devices", "macros", "more"].concat(
  ["manage", "apps", "files", "automate", "developer", "hosts", "events", "storage", "settings"].map((id) => "more/" + id),
);
const SHELL = ["/m/"]
  .concat(SCREENS.map((id) => "/m/" + id + "/"))
  .concat(["/m/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon.svg"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
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
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isNetworkOnly(path) {
  if (path.startsWith("/api/") || path.startsWith("/ws")) return true;
  return /\.(mp4|webm|m4s|m3u8|ts|aac|mp3|wav|ogg)$/i.test(path);
}

/* Shell documents of this app only: /m and its screens (/m/control/, /m/more/manage/ …), never a file. */
function isShell(path) {
  if (path === "/m/manifest.webmanifest") return true;
  if (path !== "/m" && !path.startsWith("/m/")) return false;
  return !/\.[a-z0-9]+$/i.test(path) || path === "/m/index.html";
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (isNetworkOnly(path)) return;
  const accept = request.headers.get("accept") || "";
  if (accept.includes("video/") || accept.includes("audio/")) return;

  // Hashed Next assets are shared by both apps and immutable: cache-first.
  if (path.startsWith("/_next/static/")) {
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

  if (isShell(path)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Offline: this app's own shell, never "/".
        .catch(() => caches.match(request).then((hit) => hit || caches.match(SCOPE))),
    );
  }
});
