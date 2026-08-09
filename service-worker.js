const CACHE_NAME = "geo-quest-v26";
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
  "./js/map-region-meta.json"
];
// js/map-data.json(600KB 안팎)과 js/dong/*.json 은 지도 탭에 들어갈 때만 필요하다. 첫 로딩을
// 무겁게 하지 않으려고 미리 받지 않고, 아래 fetch 처리기가 한 번 받은 뒤부터 캐시에 남긴다.

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

// 같은 출처로 오는 GET 요청은 전부 정적 파일이다(Firestore·Apps Script·Firebase 호출은
// 전부 다른 origin이라 위에서 이미 걸러짐). 그래서 네트워크 응답을 기다리지 않고 캐시가
// 있으면 즉시 그걸 돌려주고(stale), 동시에 백그라운드로 최신 파일을 받아 다음 로딩을 위해
// 캐시를 갱신한다(revalidate). 배포 직후 첫 로딩만 이전 버전을 보고, 그 다음 로딩부터
// 새 버전이 반영된다 — 즉시 최신이 필요하면 "앱 새로 불러오기" 버튼이 그 역할을 한다.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached || caches.match("./index.html"));
      return cached || networkFetch;
    })
  );
});
