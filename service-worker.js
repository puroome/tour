const CACHE_NAME = "geo-quest-v18";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./favicon.png",
  "./google.png",
  "./passport.webp",
  "./icon-192.png",
  "./icon-512.png",
  "./js/app.js",
  "./js/config.js",
  "./js/core.js",
  "./js/map-data.js",
  "./js/map-data-export.js"
];

self.addEventListener("install", (event) => {
  // Without cache: "reload" a new worker happily fills its fresh cache from the browser's
  // stale HTTP cache, so a deploy can install and still serve the previous build.
  // addAll would reject the whole install over one missing file, so each asset is added on
  // its own and a miss only costs that asset its offline copy.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(
    APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch((error) => {
      console.warn("Precache skipped", url, error);
    }))
  )));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
