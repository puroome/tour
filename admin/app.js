import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { APP_CONFIG } from "../js/config.js";
import { normalizeQuizRows, uniqueRegions } from "../js/core.js";

const $ = (id) => document.getElementById(id);
const firebaseApp = initializeApp(APP_CONFIG.firebase);
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
const MUNIS = window.KOREA_MAP_DATA?.MUNIS || {};
const MAP_REGION_ALIASES = Object.freeze({ "광주특별시": "광주광역시", "전남광주통합특별시": "광주광역시" });
const state = { quizzes: [], students: [], activeTab: "students", loading: false };
const adminRequests = new Map();

function mapRegionIdFor(regionId) {
  const raw = String(regionId || "").trim();
  if (!raw) return "";
  if (MAP_REGION_ALIASES[raw]) return MAP_REGION_ALIASES[raw];
  if (MUNIS[raw]) return raw;
  const parts = raw.split(/\s+/).filter(Boolean);
  const municipality = parts.at(-1) || "";
  if (!MUNIS[municipality]) return raw;
  const province = parts.slice(0, -1).join(" ");
  return !province || MUNIS[municipality].prov === province ? municipality : raw;
}

function displayRegionName(region) {
  const raw = String(region || "").trim();
  const mapRegion = mapRegionIdFor(raw);
  if (mapRegion === "광주광역시") return "광주특별시";
  const province = MUNIS[mapRegion]?.prov || "";
  return province.endsWith("도") ? `${province} ${mapRegion}` : raw;
}

function missionKey(quiz) {
  return [quiz.placeName, Number(quiz.latitude).toFixed(5), Number(quiz.longitude).toFixed(5)].join("|");
}

function quizMissions() {
  const missions = new Map();
  state.quizzes.forEach((quiz) => {
    const key = missionKey(quiz);
    if (!missions.has(key)) missions.set(key, quiz);
  });
  return [...missions.values()];
}

function setVisible(id, visible) { $(id).classList.toggle("hidden", !visible); }

function showError(message) {
  $("admin-error-message").textContent = message;
  setVisible("admin-loading", false);
  setVisible("admin-login", false);
  setVisible("admin-dashboard", false);
  setVisible("admin-error", true);
}

function requestQuizData() {
  return new Promise((resolve, reject) => {
    const baseUrl = String(APP_CONFIG.tourApiProxyUrl || "").trim();
    if (!baseUrl) { reject(new Error("Apps Script 주소가 설정되지 않았습니다.")); return; }
    const url = new URL(baseUrl);
    const callbackName = `__adminQuiz_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("퀴즈 데이터 응답 시간이 초과되었습니다.")), 25000);
    function finish(error, value) {
      clearTimeout(timer);
      script.remove();
      window[callbackName] = () => {};
      setTimeout(() => { delete window[callbackName]; }, 60000);
      if (error) reject(error); else resolve(value);
    }
    window[callbackName] = (value) => finish(null, value);
    script.onerror = () => finish(new Error("퀴즈 데이터에 연결하지 못했습니다."));
    url.searchParams.set("action", "getQuizzes");
    url.searchParams.set("callback", callbackName);
    url.searchParams.set("t", String(Date.now()));
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function requestAdminDashboard(idToken) {
  return new Promise((resolve, reject) => {
    const requestId = `admin_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      adminRequests.delete(requestId);
      reject(new Error("관리 기록 응답 시간이 초과되었습니다."));
    }, 30000);
    adminRequests.set(requestId, { resolve, reject, timer });
    const form = document.createElement("form");
    form.method = "post";
    form.action = APP_CONFIG.tourApiProxyUrl;
    form.target = "admin-api-frame";
    form.hidden = true;
    const input = document.createElement("input");
    input.name = "payload";
    input.value = JSON.stringify({ action: "getAdminDashboard", requestId, idToken });
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "geoQuestAdminDashboard" || !data.requestId) return;
  const request = adminRequests.get(data.requestId);
  if (!request) return;
  adminRequests.delete(data.requestId);
  clearTimeout(request.timer);
  if (data.result?.success) request.resolve(data.result);
  else request.reject(new Error(data.result?.message || "관리 기록을 읽지 못했습니다."));
});

function studentLabel(student) {
  return `${student.name}(${student.studentId})`;
}

function rankingFor(missions, minimumCompleted = 1) {
  const missionKeys = new Set(missions.map(missionKey));
  const total = missionKeys.size;
  if (!total) return [];
  return state.students.map((student) => {
    const completed = new Set(student.completedMissions || []);
    const acquired = [...completed].filter((key) => missionKeys.has(key)).length;
    return { ...student, acquired, total, rate: acquired / total * 100 };
  }).filter((student) => student.acquired >= minimumCompleted)
    .sort((a, b) => b.rate - a.rate || b.acquired - a.acquired || a.name.localeCompare(b.name, "ko") || a.studentId.localeCompare(b.studentId, "ko"))
    .map((student, index) => ({ ...student, rank: index + 1 }));
}

function percentage(value) { return `${Math.round(value)}%`; }

const EMPTY_STUDENT_MESSAGE = "해당 학생이 없습니다.";

function emptyMarkup() { return `<div class="empty-ranking">${EMPTY_STUDENT_MESSAGE}</div>`; }

function podiumMarkup(ranking) {
  if (!ranking.length) return emptyMarkup();
  const classes = ["second", "first", "third"];
  const order = [ranking[1], ranking[0], ranking[2]];
  return order.map((student, index) => student ? `
    <article class="podium-card ${classes[index]}">
      <strong class="podium-rank">${student.rank}등</strong>
      <span class="podium-name">${studentLabel(student)}</span>
      <small class="podium-rate">${student.acquired}/${student.total} · ${percentage(student.rate)}</small>
    </article>` : "").join("");
}

function rankingMarkup(ranking, { medals = false } = {}) {
  const entries = medals ? ranking : ranking.slice(3);
  if (!entries.length) return medals ? emptyMarkup() : "";
  return entries.map((student) => {
    const medal = medals && student.rank <= 3
      ? `<img class="medal-image" src="./assets/medal-${["gold", "silver", "bronze"][student.rank - 1]}.svg" alt="${student.rank}등">`
      : `<span class="ranking-number">${student.rank}</span>`;
    return `<article class="ranking-row">
      ${medal}
      <div class="ranking-student"><strong>${studentLabel(student)}</strong><small>${student.acquired} / ${student.total} 장소 방문</small></div>
      <div class="ranking-rate">${percentage(student.rate)}<small>획득비율</small></div>
    </article>`;
  }).join("");
}

function sortedRegions() {
  return uniqueRegions(state.quizzes).sort((a, b) => displayRegionName(a).localeCompare(displayRegionName(b), "ko") || a.localeCompare(b, "ko"));
}

function setSelectOptions(select, items, label) {
  const previous = select.value;
  select.innerHTML = items.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(label(item))}</option>`).join("");
  select.value = items.includes(previous) ? previous : (items[0] || "");
}

function escapeHTML(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function refreshFilters() {
  const regions = sortedRegions();
  setSelectOptions($("admin-region-select"), regions, displayRegionName);
  setSelectOptions($("admin-theme-region-select"), regions, displayRegionName);
  refreshThemeSelect();
}

function refreshThemeSelect() {
  const region = $("admin-theme-region-select").value;
  const themes = [...new Set(quizMissions().filter((mission) => mission.regionId === region).map((mission) => mission.theme || "미분류"))]
    .sort((a, b) => a.localeCompare(b, "ko"));
  setSelectOptions($("admin-theme-select"), themes, (theme) => theme);
}

function renderStudents() {
  const ranking = rankingFor(quizMissions());
  $("student-rank-count").textContent = `${ranking.length}명`;
  $("student-podium").classList.toggle("empty", !ranking.length);
  $("student-podium").innerHTML = podiumMarkup(ranking);
  $("student-ranking").innerHTML = rankingMarkup(ranking);
}

function renderRegions() {
  const region = $("admin-region-select").value;
  const ranking = rankingFor(quizMissions().filter((mission) => mission.regionId === region));
  $("region-podium").classList.toggle("empty", !ranking.length);
  $("region-podium").innerHTML = podiumMarkup(ranking);
  $("region-ranking").innerHTML = rankingMarkup(ranking);
}

function renderThemes() {
  const region = $("admin-theme-region-select").value;
  const theme = $("admin-theme-select").value;
  const ranking = rankingFor(quizMissions().filter((mission) => mission.regionId === region && (mission.theme || "미분류") === theme), 3);
  $("theme-ranking").innerHTML = rankingMarkup(ranking, { medals: true });
}

function renderDashboard() {
  refreshFilters();
  renderStudents();
  renderRegions();
  renderThemes();
}

function showTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".dashboard-tabs [data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".dashboard-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${tab}-panel`));
}

async function loadDashboard(user) {
  if (state.loading) return;
  state.loading = true;
  setVisible("admin-login", false);
  setVisible("admin-error", false);
  setVisible("admin-dashboard", false);
  setVisible("admin-loading", true);
  try {
    const idToken = await user.getIdToken(true);
    const [quizResponse, dashboard] = await Promise.all([requestQuizData(), requestAdminDashboard(idToken)]);
    if (!quizResponse?.success) throw new Error(quizResponse?.message || "퀴즈 데이터를 읽지 못했습니다.");
    state.quizzes = normalizeQuizRows(quizResponse);
    state.students = Array.isArray(dashboard.students) ? dashboard.students : [];
    renderDashboard();
    setVisible("admin-loading", false);
    setVisible("admin-dashboard", true);
  } catch (error) {
    showError(error.message || "관리 기록을 불러오지 못했습니다.");
  } finally {
    state.loading = false;
  }
}

$("admin-login-button").addEventListener("click", async () => {
  $("admin-login-error").classList.add("hidden");
  try { await signInWithPopup(auth, googleProvider); }
  catch (error) { $("admin-login-error").textContent = error.message || "로그인에 실패했습니다."; $("admin-login-error").classList.remove("hidden"); }
});
$("admin-retry-button").addEventListener("click", () => auth.currentUser ? loadDashboard(auth.currentUser) : signOut(auth));
$("admin-refresh-button").addEventListener("click", () => auth.currentUser && loadDashboard(auth.currentUser));
$("admin-region-select").addEventListener("change", renderRegions);
$("admin-theme-region-select").addEventListener("change", () => { refreshThemeSelect(); renderThemes(); });
$("admin-theme-select").addEventListener("change", renderThemes);
document.querySelectorAll(".dashboard-tabs [data-tab]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
document.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener("dragstart", (event) => event.preventDefault());
onAuthStateChanged(auth, (user) => {
  if (user) loadDashboard(user);
  else { setVisible("admin-loading", false); setVisible("admin-error", false); setVisible("admin-dashboard", false); setVisible("admin-login", true); }
});
