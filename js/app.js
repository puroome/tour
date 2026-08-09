import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { APP_CONFIG } from "./config.js";
import {
  distanceMeters,
  findRegionByCoordinates,
  formatDistance,
  normalizeQuizRows,
  projectCoordinatesToMap,
  rankNearbyQuizzes,
  safeOwnedRegions,
  uniqueRegions
} from "./core.js";

const $ = (id) => document.getElementById(id);
const mapData = window.KOREA_MAP_DATA || {};
const MUNIS = mapData.MUNIS || {};
const PROVINCES = mapData.PROVINCES || {};
const search = new URLSearchParams(location.search);
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname) || location.protocol === "file:";
const PREVIEW_MODE = IS_LOCAL && search.get("preview") === "1";
const BASE_MAP_VIEWBOX = [-8, -8, 776, 822];

const screens = {
  loading: $("loading-screen"),
  login: $("login-screen"),
  request: $("permission-request-screen"),
  denied: $("denied-screen"),
  app: $("app-shell")
};

const state = {
  user: null,
  canEdit: false,
  studentId: "",
  quizzes: [],
  position: null,
  ranked: [],
  owned: new Set(),
  acquired: {},
  ownedMissions: new Set(),
  acquiredMissions: {},
  photoUploads: {},
  photoUploadMission: null,
  photoUploading: false,
  legacyOwnedRegions: new Set(),
  mapPaths: new Map(),
  selectedMapRegion: null,
  mapAnimationFrame: null,
  mapBaseViewBox: BASE_MAP_VIEWBOX.slice(),
  watchId: null,
  currentQuiz: null,
  passportRegion: "",
  activeView: "passport",
  visibleMissions: [],
  tourSpots: [],
  tourOrigin: null,
  tourFetchedAt: 0,
  tourLoading: false,
  currentAddress: "",
  addressOrigin: null,
  addressFetchedAt: 0,
  addressFailedAt: 0,
  addressLoading: false,
  locationRefreshRequested: false,
  lastRenderAt: 0,
  toastTimer: null,
  preview: PREVIEW_MODE
};

const firebaseApp = initializeApp(APP_CONFIG.firebase);
const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);

const PREVIEW_QUIZZES = [
  {
    id: "preview-seoul",
    regionId: "서울특별시",
    placeName: "서울광장",
    latitude: 37.5663,
    longitude: 126.9779,
    radius: 150,
    question: "서울을 가로질러 서해로 흐르는 강은 무엇일까요?",
    choices: ["한강", "낙동강", "금강", "영산강"],
    answerIndex: 0,
    explanation: "한강은 서울의 중심부를 동서로 가로질러 흐릅니다.",
    active: true
  },
  {
    id: "preview-seoul-museum",
    regionId: "서울특별시",
    placeName: "국립중앙박물관",
    latitude: 37.5239,
    longitude: 126.9803,
    radius: 150,
    question: "국립중앙박물관이 소장·전시하는 자료와 가장 관련 깊은 분야는?",
    choices: ["한국의 역사와 문화", "해양 기상", "우주 발사체", "현대 자동차"],
    answerIndex: 0,
    explanation: "국립중앙박물관은 우리 역사와 문화유산을 보존하고 전시합니다.",
    active: true
  },
  {
    id: "preview-busan",
    regionId: "부산광역시",
    placeName: "부산시청",
    latitude: 35.1798,
    longitude: 129.0750,
    radius: 150,
    question: "부산의 대표적인 우리나라 최대 무역항은?",
    choices: ["인천항", "부산항", "군산항", "목포항"],
    answerIndex: 1,
    explanation: "부산항은 우리나라 최대 규모의 컨테이너 무역항입니다.",
    active: true
  },
  {
    id: "preview-jeju",
    regionId: "제주시",
    placeName: "제주시청",
    latitude: 33.4996,
    longitude: 126.5312,
    radius: 150,
    question: "제주도의 중앙에 있는 우리나라 최고봉은?",
    choices: ["지리산", "설악산", "한라산", "태백산"],
    answerIndex: 2,
    explanation: "한라산은 해발 1,947m로 대한민국에서 가장 높은 산입니다.",
    active: true
  }
];

const PREVIEW_TOUR_SPOTS = [
  { contentId: "preview-1", title: "덕수궁", address: "서울 중구 세종대로 99", distance: 210, image: "" },
  { contentId: "preview-2", title: "서울역사박물관", address: "서울 종로구 새문안로 55", distance: 940, image: "" },
  { contentId: "preview-3", title: "청계천", address: "서울 종로구 서린동", distance: 1100, image: "" }
];

function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
}

const VIEW_IDS = new Set(["passport", "quests", "map"]);

function switchView(view) {
  const nextView = VIEW_IDS.has(view) ? view : "passport";
  state.activeView = nextView;
  document.querySelectorAll(".app-view").forEach((element) => {
    const active = element.id === nextView;
    element.classList.toggle("active", active);
    element.setAttribute("aria-hidden", active ? "false" : "true");
    if (active) element.scrollTop = 0;
  });
  document.querySelectorAll(".bottom-nav [data-view]").forEach((link) => {
    const active = link.dataset.view === nextView;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function navigateToView(view) {
  const nextView = VIEW_IDS.has(view) ? view : "passport";
  if (location.hash !== `#${nextView}`) history.pushState({ view: nextView }, "", `#${nextView}`);
  switchView(nextView);
}

function setLoading(message) {
  $("loading-message").textContent = message;
  showScreen("loading");
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
}

// Files that change between deployments. map-data.js and the icons are static, so a hard
// refresh leaves them alone rather than re-downloading 188KB of map geometry every time.
const HARD_REFRESH_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./js/app.js",
  "./js/config.js",
  "./js/core.js"
];

// A phone has no Ctrl+Shift+R, and an installed PWA has no reload button at all. Three
// separate layers hold the old build, so all three have to go before reloading.
// Progress in localStorage is deliberately left alone: it is the one copy that survives a
// failed Firestore write.
async function hardRefreshApp() {
  showToast("앱을 새로 내려받는 중입니다...");
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    // Emptying the caches is not enough. The browser's own HTTP cache still holds the old
    // files and location.reload() cannot bypass it, so each asset is pulled from the network
    // with cache: "reload" to overwrite those entries before the reload reads them.
    await Promise.all(HARD_REFRESH_ASSETS.map((asset) => (
      fetch(asset, { cache: "reload" }).catch(() => {})
    )));
  } catch (error) {
    console.warn("Hard refresh cleanup failed; reloading anyway", error);
  }
  location.reload();
}

function updateNetworkStatus() {
  const offline = !navigator.onLine;
  $("offline-banner").classList.toggle("hidden", !offline);
  document.body.classList.toggle("is-offline", offline);
}

function normalizeRegionToken(name) {
  return String(name || "")
    .trim()
    .replaceAll(" ", "")
    .replace(/특별자치도$|특별자치시$|광역시$|특별시$|자치시$|시$|군$/u, "");
}

function regionFromAddress(address) {
  const parts = String(address || "").trim().split(/\s+/).filter(Boolean);
  const province = parts[0] || "";
  const addressRegionAliases = {
    "광주특별시": "광주광역시",
    "전남광주통합특별시": "광주광역시"
  };
  if (addressRegionAliases[province]) return addressRegionAliases[province];
  if (MUNIS[province]) return province;
  if (province === "강원특별자치도" && parts[1] === "고성군") return "고성군(강원)";
  if (province === "경상남도" && parts[1] === "고성군") return "고성군(경남)";
  return MUNIS[parts[1]] ? parts[1] : "";
}

function displayCurrentAddress(address) {
  const value = String(address || "").trim();
  const specialCity = /^(?:전남광주통합특별시|광주특별시|광주광역시)\s*(.*)$/u.exec(value);
  if (!specialCity) return value;
  const detail = specialCity[1].trim();
  return detail === "광주" || detail.startsWith("광주 ") ? detail : `광주${detail ? ` ${detail}` : ""}`;
}

function resolveRegionId(regionId, quiz) {
  const addressRegion = regionFromAddress(quiz?.address);
  if (addressRegion) return addressRegion;
  const coordinateRegion = findRegionByCoordinates(MUNIS, quiz);
  if (coordinateRegion) return coordinateRegion;
  if (MUNIS[regionId]) return regionId;
  const token = normalizeRegionToken(regionId);
  const matches = Object.keys(MUNIS).filter((name) => normalizeRegionToken(name) === token);
  if (matches.length === 1) return matches[0];
  return regionId;
}

function resolveQuizRegions(quizzes) {
  return quizzes.map((quiz) => ({ ...quiz, regionId: resolveRegionId(quiz.regionId, quiz) }));
}

async function loadSheetQuizzes() {
  if (state.preview) return Promise.resolve(PREVIEW_QUIZZES);
  const response = await loadAppsScriptAction("getQuizzes", { t: Date.now() }, "퀴즈 데이터");
  if (!response?.success) throw new Error(response?.message || "퀴즈 시트를 읽지 못했습니다.");
  return resolveQuizRegions(normalizeQuizRows(response));
}

const QUIZ_CACHE_KEY = "geoQuestQuizCache:v1";
const QUIZ_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function saveQuizCache(quizzes) {
  try {
    localStorage.setItem(QUIZ_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), quizzes }));
  } catch (error) {
    console.warn("Quiz cache save failed", error);
  }
}

function loadQuizCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(QUIZ_CACHE_KEY) || "null");
    if (!Array.isArray(cached?.quizzes) || !cached.quizzes.length) return null;
    if (Date.now() - Number(cached.savedAt) > QUIZ_CACHE_MAX_AGE_MS) return null;
    return cached.quizzes;
  } catch {
    return null;
  }
}

function applyLoadedQuizzes() {
  populatePassportRegionSelect();
  updateMapState({ renderSummary: true });
  updateProgressUI();
  if (state.position) updateNearby();
  else renderQuestList([]);
}

async function refreshQuizzes() {
  try {
    state.quizzes = await loadSheetQuizzes();
    if (!state.preview) saveQuizCache(state.quizzes);
    applyLoadedQuizzes();
    // A regionId the map does not know still opens its quiz but never colours a region,
    // which is a sheet mistake worth surfacing to whoever opens the console.
    const invalidCount = state.quizzes.filter((quiz) => !MUNIS[quiz.regionId]).length;
    if (invalidCount) console.warn(`${invalidCount} quiz rows carry a regionId that is not on the map`);
  } catch (error) {
    console.error("Quiz sheet load failed", error);
    // One failed load on a moving phone must not wipe a list that is already working.
    const fallback = state.quizzes.length ? state.quizzes : loadQuizCache();
    if (fallback?.length) {
      state.quizzes = fallback;
      applyLoadedQuizzes();
      showToast("퀴즈를 새로 불러오지 못해 저장된 목록을 사용합니다.");
    } else {
      state.quizzes = [];
      renderQuestError(error.message);
    }
  }
}

function loadAppsScriptAction(action, parameters = {}, label = "학생 명단", options = {}) {
  const proxyUrl = String(APP_CONFIG.tourApiProxyUrl || "").trim();
  if (!proxyUrl) return Promise.reject(new Error("Apps Script 주소가 설정되지 않았습니다."));
  const url = new URL(proxyUrl);
  url.searchParams.set("action", action);
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, String(value ?? "")));
  return loadAppsScriptProxy(url, label, options);
}

async function checkPermission(user) {
  if (state.preview) {
    return { status: "approved", approved: true, canEdit: true, displayName: "미리보기 학생", studentId: "00000" };
  }
  const email = String(user.email || "").trim().toLowerCase();
  const rosterSnapshot = await getDoc(doc(firestore, "roster", email));
  if (rosterSnapshot.exists()) {
    const roster = rosterSnapshot.data();
    return {
      status: roster.permissions,
      approved: roster.permissions === "approved",
      canEdit: roster.permissions === "approved" && roster.canEdit === true,
      displayName: roster.name || user.displayName || user.email?.split("@")[0],
      studentId: String(roster.studentId || "")
    };
  }

  const result = await loadAppsScriptAction("checkStudentPermission", { email: user.email || "" });
  if (!result?.success) throw new Error(result?.message || "학생 권한을 확인하지 못했습니다.");
  const status = result.status === "approved" ? "awaiting_sync" : (result.status || "not_found");
  return {
    status,
    approved: false,
    canEdit: false,
    displayName: user.displayName || user.email?.split("@")[0],
    studentId: ""
  };
}

function storageKey() {
  return `geoQuestProgress:${state.user?.uid || "preview"}`;
}

function loadLocalProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    return {
      ownedRegions: safeOwnedRegions(saved.ownedRegions),
      acquired: saved.acquired && typeof saved.acquired === "object" ? saved.acquired : {},
      ownedMissions: safeOwnedRegions(saved.ownedMissions),
      acquiredMissions: saved.acquiredMissions && typeof saved.acquiredMissions === "object" ? saved.acquiredMissions : {},
      photoUploads: saved.photoUploads && typeof saved.photoUploads === "object" ? saved.photoUploads : {},
      hasMissionProgress: Array.isArray(saved.ownedMissions)
    };
  } catch {
    return { ownedRegions: [], acquired: {}, ownedMissions: [], acquiredMissions: {}, photoUploads: {}, hasMissionProgress: false };
  }
}

function saveLocalProgress() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      ownedRegions: [...state.owned],
      acquired: state.acquired,
      ownedMissions: [...state.ownedMissions],
      acquiredMissions: state.acquiredMissions,
      photoUploads: state.photoUploads
    }));
  } catch (error) {
    console.warn("Local progress save failed", error);
  }
}

function progressDocument() {
  return doc(firestore, "users", state.user.uid, "apps", "geoQuest");
}

async function loadProgress() {
  const local = loadLocalProgress();
  state.legacyOwnedRegions = new Set(local.hasMissionProgress ? [] : local.ownedRegions);
  state.acquired = local.acquired;
  state.ownedMissions = new Set(local.ownedMissions);
  state.acquiredMissions = local.acquiredMissions;
  state.photoUploads = local.photoUploads;
  if (!state.preview) {
    try {
      const snapshot = await getDoc(progressDocument());
      if (snapshot.exists()) {
        const remote = snapshot.data();
        if (!Array.isArray(remote.ownedMissions)) {
          safeOwnedRegions(remote.ownedRegions).forEach((region) => state.legacyOwnedRegions.add(region));
        }
        safeOwnedRegions(remote.ownedMissions).forEach((mission) => state.ownedMissions.add(mission));
        state.acquired = { ...(remote.acquired || {}), ...state.acquired };
        state.acquiredMissions = { ...(remote.acquiredMissions || {}), ...state.acquiredMissions };
        state.photoUploads = { ...(remote.photoUploads || {}), ...state.photoUploads };
      }
    } catch (error) {
      console.warn("Cloud progress load failed; using local copy", error);
    }
  }
}

async function saveProgress() {
  saveLocalProgress();
  if (state.preview) return;
  try {
    await setDoc(progressDocument(), {
      ownedRegions: [...state.owned],
      acquired: state.acquired,
      ownedMissions: [...state.ownedMissions],
      acquiredMissions: state.acquiredMissions,
      photoUploads: state.photoUploads,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.warn("Cloud progress save failed; local copy retained", error);
    showToast("기기에 저장했습니다. 클라우드 동기화는 다음에 다시 시도합니다.");
  }
}

function buildMap() {
  const svg = $("korea-map");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", BASE_MAP_VIEWBOX.join(" "));
  state.mapBaseViewBox = BASE_MAP_VIEWBOX.slice();
  state.mapPaths.clear();
  for (const [name, muni] of Object.entries(MUNIS)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", muni.d);
    path.setAttribute("class", "muni");
    path.dataset.name = name;
    path.addEventListener("pointerenter", showMapTooltip);
    path.addEventListener("pointermove", moveMapTooltip);
    path.addEventListener("pointerleave", hideMapTooltip);
    path.addEventListener("click", () => zoomToMapRegion(name));
    path.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        zoomToMapRegion(name);
      }
    });
    svg.appendChild(path);
    state.mapPaths.set(name, path);
  }
  for (const province of Object.values(PROVINCES)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", province.d);
    path.setAttribute("class", "prov-border");
    svg.appendChild(path);
  }
  const dotLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  dotLayer.id = "map-quiz-dots";
  svg.appendChild(dotLayer);
  updateMapState({ renderSummary: true });
}

function showMapTooltip(event) {
  const name = event.currentTarget.dataset.name;
  const tooltip = $("map-tooltip");
  const missionCount = missionsForRegion(name).length;
  const owned = state.owned.has(name);
  tooltip.textContent = `${name} · ${owned ? "지역 완료" : missionCount ? `탐방지 ${missionCount}곳` : "미등록"}`;
  tooltip.classList.remove("hidden");
  moveMapTooltip(event);
}

function moveMapTooltip(event) {
  const tooltip = $("map-tooltip");
  tooltip.style.left = `${event.clientX + 13}px`;
  tooltip.style.top = `${event.clientY + 13}px`;
}

function hideMapTooltip() {
  $("map-tooltip").classList.add("hidden");
}

function currentMapViewBox() {
  const svg = $("korea-map");
  return (svg.getAttribute("viewBox") || BASE_MAP_VIEWBOX.join(" ")).split(/\s+/).map(Number);
}

// Keeps the pinched view from drifting far away from the region being inspected.
function clampMapAxis(value, size, baseStart, baseSize) {
  const slack = baseSize * .3;
  const min = baseStart - slack;
  const max = baseStart + baseSize + slack - size;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const MAX_MAP_ZOOM = 12;

const MAP_DRAG_THRESHOLD = 7;

function setupMapGestures() {
  const stage = $("map-stage");
  const svg = $("korea-map");
  let gesture = null;
  let moved = false;
  let suppressClick = false;

  const toSvgPoint = (clientX, clientY) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  };
  const touchGap = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY
  );
  const touchMid = (touches) => [
    (touches[0].clientX + touches[1].clientX) / 2,
    (touches[0].clientY + touches[1].clientY) / 2
  ];

  const beginGesture = (touches) => {
    const box = currentMapViewBox();
    if (touches.length >= 2) {
      const [midX, midY] = touchMid(touches);
      const anchor = toSvgPoint(midX, midY);
      const gap = touchGap(touches);
      if (!anchor || !gap) return null;
      return { type: "pinch", box: box, anchor: anchor, gap: gap };
    }
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    return {
      type: "pan",
      box: box,
      startX: touches[0].clientX,
      startY: touches[0].clientY,
      scaleX: matrix.a,
      scaleY: matrix.d
    };
  };

  stage.addEventListener("touchstart", (event) => {
    if (state.mapAnimationFrame) {
      cancelAnimationFrame(state.mapAnimationFrame);
      state.mapAnimationFrame = null;
    }
    gesture = beginGesture(event.touches);
    moved = false;
    // A drag fires no click, so its suppression flag would otherwise survive and swallow
    // the next genuine tap.
    suppressClick = false;
    // Never cancel a single touch: that also cancels the click the browser synthesises
    // for a tap, which is what selects a region or a quiz dot. touch-action: none
    // already stops the page from scrolling, so there is nothing else to suppress.
    if (event.touches.length > 1) {
      event.preventDefault();
      hideMapTooltip();
    }
  }, { passive: false });

  stage.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    const base = state.mapBaseViewBox;

    if (gesture.type === "pinch" && event.touches.length >= 2) {
      event.preventDefault();
      const gap = touchGap(event.touches);
      if (!gap) return;
      const width = Math.min(base[2], Math.max(base[2] / MAX_MAP_ZOOM, gesture.box[2] * gesture.gap / gap));
      const height = width * gesture.box[3] / gesture.box[2];
      // Size first, then shift the origin so the point under the fingers stays put.
      svg.setAttribute("viewBox", `${gesture.box[0]} ${gesture.box[1]} ${width} ${height}`);
      const [midX, midY] = touchMid(event.touches);
      const under = toSvgPoint(midX, midY);
      if (!under) return;
      const x = clampMapAxis(gesture.box[0] + (gesture.anchor.x - under.x), width, base[0], base[2]);
      const y = clampMapAxis(gesture.box[1] + (gesture.anchor.y - under.y), height, base[1], base[3]);
      svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
      moved = true;
      return;
    }

    if (gesture.type === "pan" && event.touches.length === 1) {
      const dx = event.touches[0].clientX - gesture.startX;
      const dy = event.touches[0].clientY - gesture.startY;
      // Below the threshold this is still a tap, so leave the event alone: cancelling it
      // would cancel the click too.
      if (!moved && Math.hypot(dx, dy) < MAP_DRAG_THRESHOLD) return;
      event.preventDefault();
      moved = true;
      hideMapTooltip();
      const x = clampMapAxis(gesture.box[0] - dx / gesture.scaleX, gesture.box[2], base[0], base[2]);
      const y = clampMapAxis(gesture.box[1] - dy / gesture.scaleY, gesture.box[3], base[1], base[3]);
      svg.setAttribute("viewBox", `${x} ${y} ${gesture.box[2]} ${gesture.box[3]}`);
    }
  }, { passive: false });

  const endGesture = (event) => {
    if (moved) suppressClick = true;
    if (event.touches.length) {
      // Lifting one finger of a pinch continues as a pan instead of jumping.
      gesture = beginGesture(event.touches);
      return;
    }
    gesture = null;
    moved = false;
  };
  stage.addEventListener("touchend", endGesture);
  stage.addEventListener("touchcancel", endGesture);

  // A drag must not also count as a tap on a region or a quiz dot.
  stage.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function animateMapViewBox(target) {
  const svg = $("korea-map");
  const current = (svg.getAttribute("viewBox") || BASE_MAP_VIEWBOX.join(" ")).split(/\s+/).map(Number);
  if (state.mapAnimationFrame) cancelAnimationFrame(state.mapAnimationFrame);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    svg.setAttribute("viewBox", target.join(" "));
    return;
  }
  const startedAt = performance.now();
  const duration = 520;
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const frame = current.map((value, index) => value + (target[index] - value) * eased);
    svg.setAttribute("viewBox", frame.join(" "));
    if (progress < 1) state.mapAnimationFrame = requestAnimationFrame(tick);
    else state.mapAnimationFrame = null;
  };
  state.mapAnimationFrame = requestAnimationFrame(tick);
}

function renderMapRegionSummary() {
  const section = $("map-region-summary");
  const regionId = state.selectedMapRegion;
  if (!regionId) {
    section.classList.add("hidden");
    return;
  }
  const missions = missionsForRegion(regionId);
  const completed = missions.filter(isMissionOwned).length;
  $("map-region-progress-title").textContent = `${regionId} 방문 기록`;
  $("map-region-progress-count").textContent = `${completed}/${missions.length}`;
  const themeOrder = new Map();
  missions.forEach((mission, index) => {
    const theme = String(mission.theme || "").trim() || "미분류";
    if (!themeOrder.has(theme)) themeOrder.set(theme, index);
  });
  const sortedMissions = missions.map((mission) => ({
    ...mission,
    displayDistance: state.position ? distanceMeters(state.position, mission) : Number.POSITIVE_INFINITY
  })).sort((a, b) => (
    a.displayDistance - b.displayDistance
    || a.placeName.localeCompare(b.placeName, "ko")
  ));
  const byTheme = new Map();
  sortedMissions.forEach((mission) => {
    const theme = String(mission.theme || "").trim() || "미분류";
    if (!byTheme.has(theme)) byTheme.set(theme, []);
    byTheme.get(theme).push(mission);
  });
  $("map-place-list").innerHTML = [...byTheme.entries()]
    .sort(([a], [b]) => themeOrder.get(a) - themeOrder.get(b))
    .map(([theme, themeMissions]) => {
      const themeCompleted = themeMissions.filter(isMissionOwned).length;
      const themeCompletion = themeMissions.length ? themeCompleted / themeMissions.length * 100 : 0;
      return `<section class="map-theme-group">
        <button type="button" class="map-theme-toggle" aria-expanded="false" style="--theme-completion:${themeCompletion}%"><span>${escapeHTML(theme)}</span><small>${themeCompleted}/${themeMissions.length}</small></button>
        <div class="map-theme-place-list">${themeMissions.map((mission) => {
          const owned = isMissionOwned(mission);
          const distance = state.position ? formatDistance(mission.displayDistance) : "위치 미확인";
          const missionIndex = sortedMissions.indexOf(mission);
          return `<div class="map-place-item${owned ? " completed" : ""}">
            <i aria-hidden="true"></i><button type="button" class="map-place-name" data-mission-index="${missionIndex}">${escapeHTML(placeLabel(mission))}</button><small>${owned ? "스탬프 획득" : escapeHTML(distance)}</small>
          </div>`;
        }).join("")}</div>
      </section>`;
    }).join("");
  $("map-place-list").querySelectorAll(".map-theme-toggle").forEach((button) => {
    const placeList = button.closest(".map-theme-group")?.querySelector(".map-theme-place-list");
    button.onclick = function() {
      if (!placeList) return;
      this.classList.toggle("active");
      placeList.classList.toggle("open");
      this.setAttribute("aria-expanded", String(placeList.classList.contains("open")));
    };
  });
  $("map-place-list").querySelectorAll(".map-place-name").forEach((button) => {
    button.addEventListener("click", () => showPlaceDescription(sortedMissions[Number(button.dataset.missionIndex)]));
  });
  section.classList.remove("hidden");
}

function updateMapDots() {
  const layer = $("map-quiz-dots");
  if (!layer) return;
  layer.innerHTML = "";
  const regionId = state.selectedMapRegion;
  const path = state.mapPaths.get(regionId);
  const missions = missionsForRegion(regionId);
  if (!path || !missions.length) return;

  const bbox = path.getBBox();
  const radius = Math.max(1.4, Math.min(3.25, Math.max(bbox.width, bbox.height) * .0175));

  missions.forEach((mission) => {
    const position = projectCoordinatesToMap(mission);
    if (!position) return;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(position.x));
    circle.setAttribute("cy", String(position.y));
    circle.setAttribute("r", String(radius));
    circle.setAttribute("class", `quiz-dot${isMissionOwned(mission) ? " completed" : ""}`);
    circle.setAttribute("tabindex", "0");
    circle.setAttribute("role", "button");
    circle.setAttribute("aria-label", `${mission.placeName}, ${isMissionOwned(mission) ? "스탬프 획득" : "미획득"}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${mission.placeName} · ${isMissionOwned(mission) ? "스탬프 획득" : "미획득"}`;
    circle.appendChild(title);
    const activateDot = () => {
      layer.querySelectorAll(".dot-active").forEach((dot) => dot.classList.remove("dot-active"));
      circle.classList.add("dot-active");
      // SVG paints in document order, so re-appending lifts the dot above overlapping ones
      layer.appendChild(circle);
      showToast(title.textContent);
    };
    circle.addEventListener("click", (event) => {
      event.stopPropagation();
      activateDot();
    });
    circle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateDot();
      }
    });
    layer.appendChild(circle);
  });
}

function zoomToMapRegion(name) {
  const path = state.mapPaths.get(name);
  const missions = missionsForRegion(name);
  if (!path || !missions.length) {
    showToast("이 지역에는 등록된 퀴즈가 아직 없습니다.");
    return;
  }
  state.selectedMapRegion = name;
  const bbox = path.getBBox();
  const padding = Math.max(9, Math.max(bbox.width, bbox.height) * .24);
  const target = [bbox.x - padding, bbox.y - padding, bbox.width + padding * 2, bbox.height + padding * 2];
  state.mapBaseViewBox = target.slice();
  animateMapViewBox(target);
  $("map-title").textContent = name;
  $("map-back-button").classList.remove("hidden");
  updateMapState({ renderSummary: true });
}

function resetMapZoom() {
  state.selectedMapRegion = null;
  state.mapBaseViewBox = BASE_MAP_VIEWBOX.slice();
  animateMapViewBox(BASE_MAP_VIEWBOX);
  $("map-title").textContent = "방문 지도";
  $("map-back-button").classList.add("hidden");
  updateMapState({ renderSummary: true });
}

function updateMapState({ renderSummary = false } = {}) {
  syncDerivedOwnership();
  const registered = new Set(uniqueRegions(state.quizzes));
  const nearby = new Set(state.ranked.filter((quiz) => quiz.inRange).map((quiz) => quiz.regionId));
  state.mapPaths.forEach((path, name) => {
    path.classList.toggle("registered", registered.has(name));
    path.classList.toggle("owned", state.owned.has(name));
    path.classList.toggle("nearby", nearby.has(name));
    path.classList.toggle("map-selected", state.selectedMapRegion === name);
    if (registered.has(name)) {
      path.setAttribute("tabindex", "0");
      path.setAttribute("role", "button");
      path.setAttribute("aria-label", `${name} 상세 지도 열기`);
    } else {
      path.removeAttribute("tabindex");
      path.removeAttribute("role");
      path.removeAttribute("aria-label");
    }
  });
  updateMapDots();
  if (renderSummary) renderMapRegionSummary();
}

function updateProgressUI() {
  syncDerivedOwnership();
  // A selected region scopes the whole stat block to that region's own missions, matching
  // the per-theme breakdown below it instead of diluting the rate against every place.
  const missions = state.passportRegion ? missionsForRegion(state.passportRegion) : quizMissions();
  const ownedCount = missions.filter(isMissionOwned).length;
  const rate = missions.length ? Math.round(ownedCount / missions.length * 100) : 0;
  $("owned-count").textContent = String(ownedCount);
  $("registered-count").textContent = String(missions.length);
  $("completion-rate").textContent = `${rate}%`;
  $("completion-bar").style.width = `${rate}%`;
  renderPassportThemeStats();
}

function populatePassportRegionSelect() {
  const select = $("passport-region-select");
  const regions = uniqueRegions(state.quizzes).sort((a, b) => a.localeCompare(b, "ko"));
  if (!regions.includes(state.passportRegion)) state.passportRegion = "";
  select.innerHTML = `<option value="">전체 지역</option>${regions.map((region) => (
    `<option value="${escapeHTML(region)}">${escapeHTML(displayPassportRegionName(region))}</option>`
  )).join("")}`;
  select.value = state.passportRegion;
}

function displayPassportRegionName(region) {
  return region === "광주광역시" ? "광주특별시" : region;
}

function renderPassportThemeStats() {
  const regionId = state.passportRegion;
  const layout = $("passport-stat-layout");
  const panel = $("passport-theme-stats");
  layout.classList.toggle("region-selected", Boolean(regionId));
  panel.classList.toggle("hidden", !regionId);
  if (!regionId) {
    panel.innerHTML = "";
    return;
  }

  const themes = new Map();
  missionsForRegion(regionId).forEach((mission) => {
    const theme = String(mission.theme || "").trim() || "미분류";
    if (!themes.has(theme)) themes.set(theme, []);
    themes.get(theme).push(mission);
  });
  const rows = [...themes.entries()];
  panel.innerHTML = `
    <div class="passport-theme-list">${rows.map(([theme, missions]) => {
      const acquired = missions.filter(isMissionOwned).length;
      const rate = missions.length ? Math.round(acquired / missions.length * 100) : 0;
      return `<article class="passport-theme-row">
        <div><strong>${escapeHTML(theme)}</strong><span>${acquired}/${missions.length}</span></div>
        <div class="progress-track"><span style="width:${rate}%"></span></div>
      </article>`;
    }).join("")}</div>`;
}

function setLocationStatus(kind, title, detail) {
  const box = $("location-status");
  box.classList.toggle("active", kind === "active");
  box.classList.toggle("error", kind === "error");
  $("location-status-title").textContent = title;
  $("location-status-detail").textContent = detail;
}

function positionFromGeolocation(position) {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp
  };
}

async function loadCurrentAddress() {
  if (!state.position || state.addressLoading) return;
  if (state.preview) {
    const nearest = [...PREVIEW_QUIZZES].sort((a, b) => (
      distanceMeters(state.position, a) - distanceMeters(state.position, b)
    ))[0];
    state.currentAddress = `${nearest.regionId} ${nearest.placeName} 부근`;
    state.addressOrigin = { latitude: state.position.latitude, longitude: state.position.longitude };
    updateQuestHeadingAddress();
    setLocationStatus("active", "현재 위치", `${displayCurrentAddress(state.currentAddress)} · 정확도 약 ±${Math.round(state.position.accuracy || 0)}m`);
    return;
  }
  const proxyUrl = String(APP_CONFIG.tourApiProxyUrl || "").trim();
  if (!proxyUrl) return;
  if (state.addressFailedAt && Date.now() - state.addressFailedAt < 60000) return;
  const moved = state.addressOrigin ? distanceMeters(state.position, state.addressOrigin) : Number.POSITIVE_INFINITY;
  if (state.currentAddress && Date.now() - state.addressFetchedAt < 600000 && moved < 500) return;

  state.addressLoading = true;
  const requestOrigin = { latitude: state.position.latitude, longitude: state.position.longitude };
  try {
    const url = new URL(proxyUrl);
    url.searchParams.set("action", "reverseAddress");
    url.searchParams.set("lat", String(requestOrigin.latitude));
    url.searchParams.set("lng", String(requestOrigin.longitude));
    const data = await loadTourProxy(url);
    if (!data.success || !data.address) throw new Error(data.message || "Address response error");
    state.currentAddress = String(data.address);
    state.addressOrigin = requestOrigin;
    state.addressFetchedAt = Date.now();
    state.addressFailedAt = 0;
    updateQuestHeadingAddress();
    if (state.position && distanceMeters(state.position, requestOrigin) < 500) {
      setLocationStatus("active", "현재 위치", `${displayCurrentAddress(state.currentAddress)} · 정확도 약 ±${Math.round(state.position.accuracy || 0)}m`);
    }
  } catch (error) {
    console.warn("Reverse geocoding failed", error);
    state.addressFailedAt = Date.now();
    if (state.position && distanceMeters(state.position, requestOrigin) < 500) {
      setLocationStatus("active", "위치 확인 완료", `주소를 가져오지 못했어요 · 정확도 약 ±${Math.round(state.position.accuracy || 0)}m`);
    }
  } finally {
    state.addressLoading = false;
  }
}

// A phone streams fixes while its accuracy converges, and rebuilding every quest card and
// map path on each one costs far more than it shows.
const RENDER_MIN_MOVE_METERS = 10;
const RENDER_MAX_INTERVAL_MS = 15000;
// Neither a street address nor a 300m spot list means anything at a coarser fix than this.
const REMOTE_LOOKUP_MAX_ACCURACY_METERS = 1000;

function shouldRerenderForPosition(previous) {
  if (!previous) return true;
  if (Date.now() - state.lastRenderAt >= RENDER_MAX_INTERVAL_MS) return true;
  return distanceMeters(previous, state.position) >= RENDER_MIN_MOVE_METERS;
}

function handleLocation(position) {
  const previous = state.position;
  state.position = positionFromGeolocation(position);
  const accuracy = Math.round(state.position.accuracy || 0);
  const addressDistance = state.addressOrigin ? distanceMeters(state.position, state.addressOrigin) : Number.POSITIVE_INFINITY;
  if (state.currentAddress && addressDistance < 500) {
    setLocationStatus("active", "현재 위치", `${displayCurrentAddress(state.currentAddress)} · 정확도 약 ±${accuracy}m`);
  } else {
    setLocationStatus("active", "위치 확인 완료", `주소 확인 중 · 정확도 약 ±${accuracy}m`);
  }
  const button = $("location-button");
  button.disabled = false;
  button.innerHTML = "<span>📍</span> 현재 위치 새로고침";
  button.setAttribute("aria-busy", "false");
  if (shouldRerenderForPosition(previous)) {
    state.lastRenderAt = Date.now();
    updateNearby();
  }
  if (accuracy <= REMOTE_LOOKUP_MAX_ACCURACY_METERS) {
    loadCurrentAddress();
    loadNearbyTourSpots();
  }
  if (state.locationRefreshRequested) {
    state.locationRefreshRequested = false;
    showToast("현재 위치를 새로 확인했습니다.");
  }
}

function handleLocationError(error) {
  const wasRefreshRequested = state.locationRefreshRequested;
  state.locationRefreshRequested = false;
  const button = $("location-button");
  button.disabled = false;
  button.setAttribute("aria-busy", "false");
  // A watch that already has a fix still times out in a tunnel or a basement. Keep the last
  // known position on screen instead of replacing it with a failure the student cannot act on.
  if (state.position && !wasRefreshRequested) {
    button.innerHTML = "<span>📍</span> 현재 위치 새로고침";
    return;
  }
  const messages = {
    1: ["위치 권한이 꺼져 있어요", "브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요."],
    2: ["현재 위치를 찾지 못했어요", "야외나 창가에서 잠시 후 다시 시도해 주세요."],
    3: ["위치 확인 시간이 초과됐어요", "네트워크와 GPS를 확인한 뒤 다시 눌러 주세요."]
  };
  const [title, detail] = messages[error?.code] || ["위치 확인에 실패했어요", "잠시 후 다시 시도해 주세요."];
  setLocationStatus("error", title, detail);
  button.innerHTML = "<span>📍</span> 위치 다시 확인하기";
}

function startLocationWatch() {
  if (state.preview) {
    const wasRefreshRequested = state.locationRefreshRequested;
    const selected = PREVIEW_QUIZZES.find((quiz) => quiz.id === search.get("place"))
      || PREVIEW_QUIZZES.find((quiz) => quiz.regionId === search.get("region"))
      || PREVIEW_QUIZZES[0];
    handleLocation({
      coords: { latitude: selected.latitude, longitude: selected.longitude, accuracy: 12 },
      timestamp: Date.now()
    });
    if (!wasRefreshRequested) showToast("로컬 미리보기 위치를 사용합니다.");
    return;
  }
  if (!navigator.geolocation) {
    handleLocationError({ code: 2 });
    return;
  }
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  setLocationStatus("", "위치를 찾는 중...", "GPS 확인 중");
  const button = $("location-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = "<span>📍</span> 위치 찾는 중...";
  // A network fix lands in about a second while the satellite lock behind it can take half a
  // minute from cold, so the coarse position fills the screen in the meantime.
  navigator.geolocation.getCurrentPosition(
    (position) => { if (!state.position) handleLocation(position); },
    () => {},
    APP_CONFIG.locationQuickFixOptions
  );
  state.watchId = navigator.geolocation.watchPosition(
    handleLocation,
    handleLocationError,
    APP_CONFIG.locationWatchOptions
  );
}

function refreshCurrentLocation() {
  state.locationRefreshRequested = true;
  if (state.preview || state.watchId === null || !navigator.geolocation) {
    startLocationWatch();
    return;
  }
  // Restarting the watch would throw away the satellite lock it has been building, which is
  // exactly what makes repeated taps take longer rather than shorter. Ask the running watch
  // for one extra fix instead.
  const button = $("location-button");
  button.setAttribute("aria-busy", "true");
  button.innerHTML = "<span>📍</span> 위치 확인 중...";
  navigator.geolocation.getCurrentPosition(
    handleLocation,
    handleLocationError,
    { ...APP_CONFIG.locationWatchOptions, maximumAge: 15000 }
  );
}

function startFieldPhotoCapture(mission) {
  if (!hasMissionAnswer(mission)) {
    showToast("퀴즈 정답 후 현장 사진을 올릴 수 있습니다.");
    return;
  }
  if (state.photoUploading) {
    showToast("사진을 올리는 중입니다.");
    return;
  }
  state.photoUploadMission = mission;
  const input = $("photo-upload-input");
  input.value = "";
  input.click();
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("사진 파일을 읽지 못했습니다."));
    };
    image.src = url;
  });
}

async function compressPhotoForUpload(file) {
  if (!String(file?.type || "").startsWith("image/")) throw new Error("사진 파일만 올릴 수 있습니다.");
  if (file.size > 15 * 1024 * 1024) throw new Error("원본 사진은 15MB 이하로 선택해 주세요.");
  const image = await loadImageElement(file);
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = Math.min(1, 1600 / Math.max(1, largestSide));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const compressed = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .84));
  if (!compressed) throw new Error("사진을 준비하지 못했습니다.");
  if (compressed.size > 5 * 1024 * 1024) throw new Error("사진 크기를 더 줄여 다시 촬영해 주세요.");
  return compressed;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(new Error("사진 데이터를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

function postFieldPhotoUpload(payload) {
  return new Promise((resolve, reject) => {
    const frame = $("photo-upload-frame");
    const requestId = `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => finish(new Error("사진 업로드 응답 시간이 초과되었습니다.")), 45000);
    const finish = (error, result) => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (event) => {
      const message = event.data;
      const isAppsScriptFrame = /^https:\/\/[^/]*googleusercontent\.com$/u.test(String(event.origin || ""));
      if (!isAppsScriptFrame || message?.type !== "geoQuestPhotoUpload" || message.requestId !== requestId) return;
      finish(null, message.result);
    };
    window.addEventListener("message", onMessage);
    const form = document.createElement("form");
    form.method = "post";
    form.action = APP_CONFIG.tourApiProxyUrl;
    form.target = frame.name;
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "payload";
    field.value = JSON.stringify({ ...payload, requestId });
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  });
}

async function uploadSelectedFieldPhoto(file) {
  const mission = state.photoUploadMission;
  state.photoUploadMission = null;
  if (!file || !mission) return;
  if (!hasMissionAnswer(mission)) {
    showToast("퀴즈 정답 후 현장 사진을 올릴 수 있습니다.");
    return;
  }
  state.photoUploading = true;
  showToast("현장 사진을 준비하는 중입니다.");
  try {
    const photo = await compressPhotoForUpload(file);
    if (state.preview) {
      state.photoUploads[missionKey(mission)] = {
        url: URL.createObjectURL(photo),
        fileName: "00000-preview.jpg",
        uploadedAt: new Date().toISOString()
      };
    } else {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("로그인 확인에 실패했습니다. 다시 로그인해 주세요.");
      const result = await postFieldPhotoUpload({
        action: "uploadFieldPhoto",
        idToken,
        missionKey: missionKey(mission),
        imageData: await blobToBase64(photo)
      });
      if (!result?.success || !result.url) throw new Error(result?.message || "사진 업로드에 실패했습니다.");
      state.photoUploads[missionKey(mission)] = {
        url: result.url,
        fileId: result.fileId || "",
        fileName: result.fileName || "현장 사진.jpg",
        uploadedAt: result.uploadedAt || new Date().toISOString()
      };
    }
    syncDerivedOwnership();
    updateMapState({ renderSummary: true });
    updateProgressUI();
    await saveProgress();
    renderQuestList(visibleQuizMissions());
    const quizDialog = $("quiz-dialog");
    if (quizDialog.open) quizDialog.close();
    showPlaceDescription(mission);
    showToast("현장 사진을 올렸습니다.");
  } catch (error) {
    console.error("Field photo upload failed", error);
    showToast(error.message || "사진 업로드에 실패했습니다.");
  } finally {
    state.photoUploading = false;
  }
}

function missionKey(quiz) {
  return [
    quiz.placeName,
    Number(quiz.latitude).toFixed(5),
    Number(quiz.longitude).toFixed(5)
  ].join("|");
}

function placeLabel(quiz) {
  const theme = String(quiz?.theme || "").trim();
  return theme ? `${quiz.placeName} (${theme})` : quiz.placeName;
}

function showPlaceDescription(place) {
  const description = String(place?.description || "").trim();
  const photo = photoUploadForMission(place);
  const photoUrl = photoDisplayUrl(photo);
  $("place-description-content").innerHTML = `
    <div class="place-description-head">
      <p class="eyebrow">${escapeHTML(place?.regionId || "현장 정보")}</p>
      <h2>${escapeHTML(placeLabel(place))}</h2>
    </div>
    <div class="place-description-body">
      <p>${escapeHTML(description || "관리자가 아직 장소 설명을 등록하지 않았습니다.")}</p>
      ${photoUrl ? `<section class="place-photo"><h3>현장 사진</h3><img src="${escapeHTML(photoUrl)}" alt="${escapeHTML(placeLabel(place))} 현장 사진" loading="lazy"></section>` : ""}
    </div>`;
  $("place-description-dialog").showModal();
}

function photoUploadForMission(mission) {
  return state.photoUploads[missionKey(mission)] || null;
}

function photoDisplayUrl(photo) {
  const storedUrl = String(photo?.url || "").trim();
  const storedId = String(photo?.fileId || "").trim();
  if (storedId) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(storedId)}&sz=w1600`;
  try {
    const fileId = new URL(storedUrl).searchParams.get("id");
    if (fileId) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
  } catch {
    // Keep the original URL for local preview object URLs and unexpected legacy formats.
  }
  return storedUrl;
}

function quizMissions(quizzes = state.quizzes) {
  const missions = new Map();
  quizzes.forEach((quiz) => {
    const key = missionKey(quiz);
    if (!missions.has(key)) missions.set(key, quiz);
  });
  return [...missions.values()];
}

function missionsForRegion(regionId) {
  return quizMissions().filter((mission) => mission.regionId === regionId);
}

function isMissionOwned(quiz) {
  const key = missionKey(quiz);
  return state.ownedMissions.has(key) && Boolean(state.photoUploads[key]?.url);
}

function hasMissionAnswer(quiz) {
  return state.ownedMissions.has(missionKey(quiz));
}

function syncDerivedOwnership() {
  const cleared = new Set();
  uniqueRegions(state.quizzes).forEach((regionId) => {
    const missions = missionsForRegion(regionId);
    if (missions.length && missions.every(isMissionOwned)) cleared.add(regionId);
  });
  state.owned = cleared;
}

function migrateLegacyProgress() {
  const migrated = state.legacyOwnedRegions.size > 0;
  state.legacyOwnedRegions.forEach((regionId) => {
    missionsForRegion(regionId).forEach((mission) => {
      const key = missionKey(mission);
      state.ownedMissions.add(key);
      if (!state.acquiredMissions[key]) {
        state.acquiredMissions[key] = {
          quizId: mission.id,
          regionId,
          placeName: mission.placeName,
          acquiredAt: state.acquired[regionId]?.acquiredAt || new Date().toISOString(),
          migrated: true
        };
      }
    });
  });
  state.legacyOwnedRegions.clear();
  syncDerivedOwnership();
  saveLocalProgress();
  return migrated;
}

function groupQuizMissions(ranked) {
  const missions = new Map();
  ranked.forEach((quiz) => {
    const key = missionKey(quiz);
    const current = missions.get(key);
    if (!current || (!current.inRange && quiz.inRange) || quiz.distance < current.distance) missions.set(key, quiz);
  });
  return [...missions.values()].sort((a, b) => {
    if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
    const aOwned = isMissionOwned(a);
    const bOwned = isMissionOwned(b);
    if (aOwned !== bOwned) return aOwned ? 1 : -1;
    return a.distance - b.distance;
  });
}

function visibleQuizMissions() {
  return groupQuizMissions(state.ranked.filter((quiz) => (
    quiz.distance <= APP_CONFIG.questVisibilityRadiusMeters
  )));
}

function updateNearby() {
  state.ranked = rankNearbyQuizzes(state.quizzes, state.position, APP_CONFIG.maxAccuracyAllowanceMeters);
  updateMapState();
  renderQuestList(visibleQuizMissions());
}

function renderTourSpots() {
  const section = $("tour-section");
  const list = $("tour-list");
  if (!state.tourSpots.length) {
    section.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  section.classList.remove("hidden");
  list.innerHTML = state.tourSpots.map((spot) => {
    const rawImageUrl = String(spot.image || "").trim();
    const imageUrl = /^https?:\/\//i.test(rawImageUrl) ? rawImageUrl.replace(/^http:/i, "https:") : "";
    const image = imageUrl
      ? `<img src="${escapeHTML(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : '<span class="tour-image-placeholder" aria-hidden="true">⌖</span>';
    return `<article class="tour-card">
      ${image}
      <div class="tour-card-body">
        <strong>${escapeHTML(spot.title)}</strong>
        <p>${escapeHTML(spot.address || "주소 정보 없음")}</p>
        <small>${escapeHTML(formatDistance(Number(spot.distance)))}</small>
      </div>
    </article>`;
  }).join("");
}

async function loadNearbyTourSpots() {
  if (!state.position) return;
  if (state.preview) {
    state.tourSpots = PREVIEW_TOUR_SPOTS.filter((spot) => spot.distance <= APP_CONFIG.tourApiRadiusMeters);
    renderTourSpots();
    return;
  }
  const proxyUrl = String(APP_CONFIG.tourApiProxyUrl || "").trim();
  if (!proxyUrl) {
    state.tourSpots = [];
    renderTourSpots();
    return;
  }
  const moved = state.tourOrigin ? distanceMeters(state.position, state.tourOrigin) : Number.POSITIVE_INFINITY;
  if (state.tourFetchedAt && Date.now() - state.tourFetchedAt < 120000 && moved < 300) return;
  if (state.tourLoading) return;

  state.tourLoading = true;
  try {
    const url = new URL(proxyUrl);
    url.searchParams.set("action", "tourNearby");
    url.searchParams.set("lat", String(state.position.latitude));
    url.searchParams.set("lng", String(state.position.longitude));
    url.searchParams.set("radius", String(APP_CONFIG.tourApiRadiusMeters));
    url.searchParams.set("limit", String(APP_CONFIG.tourApiResultCount));
    const data = await loadTourProxy(url);
    if (!data.success || !Array.isArray(data.items)) throw new Error(data.message || "TourAPI response error");
    state.tourSpots = data.items.filter((spot) => (
      Number.isFinite(Number(spot.distance)) &&
      Number(spot.distance) <= APP_CONFIG.tourApiRadiusMeters
    ));
    state.tourOrigin = { latitude: state.position.latitude, longitude: state.position.longitude };
    state.tourFetchedAt = Date.now();
    renderTourSpots();
  } catch (error) {
    console.warn("Nearby tourism data load failed", error);
    if (!state.tourSpots.length) renderTourSpots();
  } finally {
    state.tourLoading = false;
  }
}

// Apps Script answers through two redirects onto a second host, and a cellular connection
// can spend most of a short budget on the handshakes alone.
const PROXY_TIMEOUT_MS = 25000;
const PROXY_RETRY_DELAY_MS = 1200;

function requestAppsScriptProxy(url, label) {
  return new Promise((resolve, reject) => {
    const callbackName = `__geoQuestProxy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = setTimeout(() => finish(new Error(`${label} 응답 시간이 초과되었습니다.`)), PROXY_TIMEOUT_MS);

    function finish(error, data) {
      clearTimeout(timeout);
      script.remove();
      // A response that lands after the timeout still calls the global, so leave a no-op
      // behind instead of letting it throw into the console.
      window[callbackName] = () => {};
      setTimeout(() => { delete window[callbackName]; }, 60000);
      if (error) reject(error);
      else resolve(data);
    }

    window[callbackName] = (data) => finish(null, data);
    script.onerror = () => finish(new Error(`${label}에 연결하지 못했습니다.`));
    url.searchParams.set("callback", callbackName);
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

async function loadAppsScriptProxy(url, label = "Apps Script", { retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestAppsScriptProxy(url, label);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, PROXY_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function loadTourProxy(url) {
  return loadAppsScriptProxy(url, "TourAPI");
}

const LOCATE_EMPTY_BUTTON = '<button type="button" class="empty-compass empty-locate" aria-label="현재 위치 확인" title="현재 위치 확인"><span aria-hidden="true">📍</span></button>';

function updateQuestHeadingAddress() {
  const address = displayCurrentAddress(state.currentAddress);
  $("quest-heading-address").textContent = address ? `(${address})` : "";
}

function renderQuestError(message) {
  state.visibleMissions = [];
  $("quest-list").classList.add("hidden");
  const empty = $("quest-empty");
  empty.classList.remove("hidden");
  empty.innerHTML = `<span class="empty-compass">!</span><h3>퀴즈를 불러오지 못했어요.</h3><p>${escapeHTML(message)}<br>Apps Script 배포와 시트 헤더를 확인해 주세요.</p>`;
  $("quest-count-badge").textContent = "0";
}

function renderQuestList(items) {
  const list = $("quest-list");
  const empty = $("quest-empty");
  state.visibleMissions = items;
  updateQuestHeadingAddress();
  $("quest-count-badge").textContent = String(items.length);
  $("quest-count-badge").setAttribute("aria-label", `20km 주변 퀴즈 ${items.length}개`);

  if (!state.quizzes.length) {
    list.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML = '<span class="empty-compass">▦</span><h3>등록된 퀴즈가 없어요.</h3>';
    return;
  }
  if (!state.position) {
    list.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML = `${LOCATE_EMPTY_BUTTON}<h3>위치를 확인하세요.</h3>`;
    return;
  }
  if (!items.length) {
    list.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML = '<span class="empty-compass">⌖</span><h3>20km 안에 등록된 퀴즈가 없어요.</h3>';
    return;
  }

  empty.classList.add("hidden");
  list.classList.remove("hidden");
  list.innerHTML = "";
  items.forEach((item) => {
    const answered = hasMissionAnswer(item);
    const owned = isMissionOwned(item);
    const hasPhoto = Boolean(photoUploadForMission(item));
    const activationRadius = Math.max(1, Math.round(Number(item.radius) || APP_CONFIG.questActivationRadiusMeters));
    const activationDistance = formatDistance(activationRadius);
    const article = document.createElement("article");
    article.className = `quest-item${item.inRange ? " in-range" : ""}${owned ? " owned" : ""}${answered && !hasPhoto ? " photo-pending" : ""}`;
    const actionMarkup = !item.inRange
      ? `<button type="button" class="quest-action" disabled>${activationDistance} 안으로 이동하세요</button>`
      : owned
        ? `<div class="quest-action-group"><button type="button" class="quest-action completion-action quiz-retry-action">퀴즈 다시 풀기</button><button type="button" class="quest-action completion-action photo-retry-action">사진 다시 올리기</button></div>`
        : `<button type="button" class="quest-action${answered ? " photo-action" : ""}">${answered ? "현장 사진 올리기" : "현장 퀴즈 도전"}</button>`;
    article.innerHTML = `
      <div class="quest-meta">
        <span class="distance-badge">${escapeHTML(formatDistance(item.distance))}</span>
        <span class="range-badge${owned ? " done" : ""}${answered && !hasPhoto ? " photo-pending" : ""}">${item.inRange ? (owned ? "● 탐방 완료" : answered ? "● 사진 업로드 대기" : "● 도전 가능") : `${activationDistance} 안에서 활성화`}</span>
      </div>
      <h3><button type="button" class="place-name-button">${escapeHTML(placeLabel(item))}</button></h3>
      <p>${escapeHTML(item.regionId)} · ${owned ? "탐방 완료" : answered ? "정답 완료 · 사진 업로드 대기" : "미획득 장소"}</p>
      ${actionMarkup}`;
    article.querySelector(".place-name-button").addEventListener("click", () => showPlaceDescription(item));
    if (owned) {
      article.querySelector(".quiz-retry-action").addEventListener("click", () => openQuiz(item));
      article.querySelector(".photo-retry-action").addEventListener("click", () => startFieldPhotoCapture(item));
    } else {
      article.querySelector(".quest-action").addEventListener("click", () => {
        if (answered) startFieldPhotoCapture(item);
        else openQuiz(item);
      });
    }
    list.appendChild(article);
  });
}

function quizzesForMission(mission) {
  const key = missionKey(mission);
  return state.ranked.filter((quiz) => missionKey(quiz) === key && quiz.inRange);
}

function openQuiz(mission) {
  const candidates = quizzesForMission(mission);
  if (!candidates.length) {
    showToast("현재 위치를 다시 확인해 주세요.");
    return;
  }
  const quiz = candidates[Math.floor(Math.random() * candidates.length)];
  state.currentQuiz = quiz;
  const content = $("quiz-dialog-content");
  content.innerHTML = `
    <div class="quiz-head">
      <p class="eyebrow">${escapeHTML(quiz.regionId)} · 현장 퀴즈</p>
      <h2>${escapeHTML(quiz.placeName)}</h2>
      <p>${escapeHTML(formatDistance(quiz.distance))} 거리에서 도전 중</p>
    </div>
    <div class="quiz-body">
      <p class="quiz-question">${escapeHTML(quiz.question)}</p>
      <div class="choice-list"></div>
      <div id="quiz-feedback" class="quiz-feedback hidden"></div>
    </div>`;
  const choices = content.querySelector(".choice-list");
  quiz.choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    button.innerHTML = `<span>${index + 1}</span><b>${escapeHTML(choice)}</b>`;
    button.addEventListener("click", () => answerQuiz(index, button));
    choices.appendChild(button);
  });
  $("quiz-dialog").showModal();
}

async function answerQuiz(selectedIndex, button) {
  const quiz = state.currentQuiz;
  if (!quiz || button.disabled) return;
  const feedback = $("quiz-feedback");
  if (selectedIndex !== quiz.answerIndex) {
    button.classList.add("wrong");
    button.disabled = true;
    feedback.classList.remove("hidden");
    feedback.innerHTML = "<strong>아쉬워요!</strong> 다른 답을 한 번 더 생각해 보세요.";
    return;
  }

  const buttons = [...document.querySelectorAll(".choice-button")];
  buttons.forEach((choice) => { choice.disabled = true; });
  button.classList.add("correct");
  const key = missionKey(quiz);
  const alreadyAnswered = state.ownedMissions.has(key);
  if (!alreadyAnswered) {
    state.ownedMissions.add(key);
    state.acquiredMissions[key] = {
      quizId: quiz.id,
      regionId: quiz.regionId,
      placeName: quiz.placeName,
      acquiredAt: new Date().toISOString()
    };
    syncDerivedOwnership();
    updateMapState({ renderSummary: true });
    updateProgressUI();
    await saveProgress();
  }
  showSuccess(quiz, alreadyAnswered);
}

function showSuccess(quiz, alreadyOwned) {
  const explanation = quiz.explanation || "정답을 맞혔습니다. 멋진 탐험이었어요!";
  const regionCleared = state.owned.has(quiz.regionId);
  $("quiz-dialog-content").innerHTML = `
    <div class="success-view">
      <div class="success-seal">${alreadyOwned ? "복습" : "정답"}</div>
      <p class="eyebrow">정답입니다</p>
      <h2>${escapeHTML(quiz.placeName)}</h2>
      ${regionCleared ? `<strong class="region-clear-message">${escapeHTML(quiz.regionId)} 지역 완료</strong>` : ""}
      <p>${escapeHTML(explanation)}</p>
      <button id="success-photo-upload" class="primary-button success-photo-button" type="button">현장 사진 올리기</button>
    </div>`;
  $("success-photo-upload").addEventListener("click", () => {
    startFieldPhotoCapture(quiz);
    $("quiz-dialog").close();
  });
  renderQuestList(visibleQuizMissions());
}

function updateUserUI(permission) {
  const displayName = permission.displayName || "학생";
  state.canEdit = permission.canEdit === true;
  state.studentId = String(permission.studentId || "").trim();
  const nameButton = $("passport-user-name");
  nameButton.textContent = displayName;
  // Only an admin has a sheet to open, so only an admin sees the name read as a link.
  nameButton.classList.toggle("is-admin-link", state.canEdit);
  nameButton.title = state.canEdit ? "관리자 시트 열기" : "";
}

async function enterApp(permission) {
  setLoading("방문 기록을 불러오는 중...");
  await Promise.all([loadProgress(), refreshQuizzes()]);
  const migratedProgress = migrateLegacyProgress();
  if (migratedProgress) await saveProgress();
  buildMap();
  updateUserUI(permission);
  updateProgressUI();
  showScreen("app");
  startLocationWatch();
  const initialView = "passport";
  if (location.hash !== "#passport") {
    history.replaceState({ view: initialView }, "", `${location.pathname}${location.search}#passport`);
  }
  switchView(initialView);
  if (state.preview) showToast("로컬 미리보기 모드입니다.");
}

function showPermissionRequest(user) {
  $("request-email").textContent = user.email || "현재 계정";
  $("request-name").value = user.displayName || "";
  $("request-student-id").value = "";
  $("request-error").classList.add("hidden");
  $("request-submit-button").disabled = false;
  $("request-submit-button").textContent = "권한 요청";
  showScreen("request");
  requestAnimationFrame(() => (user.displayName ? $("request-student-id") : $("request-name")).focus());
}

function showPermissionStatus(status, user, detail = "") {
  const messages = {
    pending: {
      icon: "⏳",
      title: "승인 대기 중",
      message: "Jame의 승인 후 사용할 수 있어요."
    },
    denied: {
      icon: "🔒",
      title: "접근이 제한되었어요.",
      message: "승인이 거부되어있어요. Jame에게 문의하세요."
    },
    awaiting_sync: {
      icon: "↻",
      title: "승인 대기 중",
      message: "Jame의 승인 후 사용할 수 있어요."
    },
    error: {
      icon: "⚠️",
      title: "권한을 확인하지 못했어요.",
      message: detail || "잠시 후 다시 확인해 주세요."
    }
  };
  const content = messages[status] || messages.error;
  $("denied-icon").textContent = content.icon;
  $("denied-title").textContent = content.title;
  $("denied-message").textContent = content.message;
  $("denied-email").textContent = user.email || "현재 계정";
  showScreen("denied");
}

async function submitPermissionRequest(event) {
  event.preventDefault();
  if (!state.user) return;
  const name = $("request-name").value.trim();
  const studentId = $("request-student-id").value.trim();
  const errorBox = $("request-error");
  if (!name) {
    errorBox.textContent = "이름을 입력해 주세요.";
    errorBox.classList.remove("hidden");
    $("request-name").focus();
    return;
  }
  if (!/^\d{5}$/.test(studentId)) {
    errorBox.textContent = "학번은 숫자 5자리로 입력해 주세요.";
    errorBox.classList.remove("hidden");
    $("request-student-id").focus();
    return;
  }

  const button = $("request-submit-button");
  button.disabled = true;
  button.textContent = "요청 중...";
  errorBox.classList.add("hidden");
  try {
    // This one appends a roster row, so it is the single action that must not be retried.
    const result = await loadAppsScriptAction("requestStudentPermission", {
      email: state.user.email || "",
      name,
      studentId
    }, "학생 명단", { retries: 0 });
    if (!result?.success) throw new Error(result?.message || "권한 요청에 실패했습니다.");
    if (result.status === "approved") {
      await handleSignedInUser(state.user);
      return;
    }
    showPermissionStatus(result.status === "denied" ? "denied" : "pending", state.user);
  } catch (error) {
    console.error("Permission request failed", error);
    errorBox.textContent = error.message || "권한 요청에 실패했습니다.";
    errorBox.classList.remove("hidden");
    button.disabled = false;
    button.textContent = "권한 요청";
  }
}

async function handleSignedInUser(user) {
  state.user = user;
  setLoading("학생 권한을 확인하는 중...");
  try {
    const permission = await checkPermission(user);
    if (permission.status === "not_found") {
      showPermissionRequest(user);
      return;
    }
    if (!permission.approved) {
      showPermissionStatus(permission.status, user);
      return;
    }
    await enterApp(permission);
  } catch (error) {
    console.error("Permission check failed", error);
    showPermissionStatus("error", user, error.message);
    showToast("권한 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

async function login() {
  const button = $("login-button");
  const errorBox = $("login-error");
  button.disabled = true;
  errorBox.classList.add("hidden");
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error("Google sign-in failed", error);
    errorBox.textContent = error?.code === "auth/popup-blocked"
      ? "팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요."
      : "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    errorBox.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  if (state.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.user = null;
  state.canEdit = false;
  state.position = null;
  state.tourSpots = [];
  state.tourOrigin = null;
  state.tourFetchedAt = 0;
  state.currentAddress = "";
  state.addressOrigin = null;
  state.addressFetchedAt = 0;
  state.addressFailedAt = 0;
  state.lastRenderAt = 0;
  state.owned.clear();
  state.ownedMissions.clear();
  state.legacyOwnedRegions.clear();
  if (state.preview) {
    location.href = location.pathname;
    return;
  }
  await signOut(auth);
}

function bindEvents() {
  updateNetworkStatus();
  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("dragstart", (event) => event.preventDefault());
  window.addEventListener("offline", updateNetworkStatus);
  window.addEventListener("online", () => {
    updateNetworkStatus();
    if (!screens.app.classList.contains("hidden")) showToast("온라인으로 다시 연결되었어요.");
  });
  $("login-button").addEventListener("click", login);
  $("permission-request-form").addEventListener("submit", submitPermissionRequest);
  $("request-logout-button").addEventListener("click", logout);
  $("request-student-id").addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 5);
  });
  $("denied-logout-button").addEventListener("click", logout);
  $("retry-permission-button").addEventListener("click", () => state.user && handleSignedInUser(state.user));
  // The topbar is gone, so the passport cover itself carries these two actions: the
  // emblem logs out, and the name opens the admin sheet (only when canEdit is true).
  $("passport-logout-button").addEventListener("click", () => {
    if (confirm("로그아웃할까요?")) logout();
  });
  $("passport-user-name").addEventListener("click", () => {
    if (state.canEdit) window.open(APP_CONFIG.sheetUrl, "_blank", "noopener");
  });
  $("location-button").addEventListener("click", refreshCurrentLocation);
  $("quest-heading-address").addEventListener("click", refreshCurrentLocation);
  $("photo-upload-input").addEventListener("change", (event) => {
    uploadSelectedFieldPhoto(event.target.files?.[0]);
  });
  $("quest-empty").addEventListener("click", (event) => {
    if (event.target.closest(".empty-locate")) refreshCurrentLocation();
  });
  $("passport-stamp").addEventListener("click", () => {
    navigateToView("map");
    if (state.passportRegion) zoomToMapRegion(state.passportRegion);
    else resetMapZoom();
  });
  $("passport-region-select").addEventListener("change", (event) => {
    state.passportRegion = event.target.value;
    updateProgressUI();
  });
  $("map-back-button").addEventListener("click", resetMapZoom);
  setupMapGestures();
  // iOS Safari zooms the page on pinch even with user-scalable=no, so block its
  // proprietary gesture events. Touch events still reach the map's own pinch handler.
  ["gesturestart", "gesturechange", "gestureend"].forEach((type) => {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  });
  // Last line of defence for browsers that ignore user-scalable=no: refuse multi-touch
  // moves everywhere except the map, which runs its own zoom.
  document.addEventListener("touchmove", (event) => {
    if (event.touches.length < 2) return;
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest("#map-stage")) return;
    event.preventDefault();
  }, { passive: false });
  $("app-refresh-button").addEventListener("click", () => {
    if (confirm("앱을 완전히 새로 불러올까요?\n방문 기록은 지워지지 않습니다.")) hardRefreshApp();
  });
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToView(link.dataset.view);
    });
  });
  window.addEventListener("popstate", () => switchView(location.hash.slice(1)));
  $("quiz-dialog").addEventListener("close", () => { state.currentQuiz = null; });
}

async function init() {
  bindEvents();
  if (!Object.keys(MUNIS).length) {
    setLoading("지도 데이터를 읽지 못했습니다.");
    return;
  }
  if (state.preview) {
    await handleSignedInUser({ uid: "preview", email: "preview@local", displayName: "미리보기 학생", photoURL: "" });
    return;
  }
  onAuthStateChanged(auth, (user) => {
    if (user) handleSignedInUser(user);
    else {
      state.user = null;
      showScreen("login");
    }
  });
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(console.warn));
}

init();
