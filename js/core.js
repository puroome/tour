const EARTH_RADIUS_METERS = 6371008.8;
// 지도 경계(js/map-data.json, js/dong/*.json)를 만들 때 쓴 것과 똑같은 람베르트 정각원뿔
// 도법. 경계와 장소 점이 한 식에서 나오므로 따로 맞춰줄 보정이 필요 없다. 값을 바꾸려면
// tools/build_map.py 로 경계를 다시 만들고 그때 출력되는 수치를 그대로 옮겨야 한다.
const MAP_PROJECTION = Object.freeze({
  standardParallel1: 34,
  standardParallel2: 38,
  originLatitude: 36,
  originLongitude: 127.5,
  scale: 8230,
  offsetX: 335.3,
  offsetY: 384.3
});
const SVG_RING_CACHE = new WeakMap();

export function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

export function distanceMeters(a, b) {
  const lat1 = Number(a?.latitude);
  const lon1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lon2 = Number(b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const p1 = toRadians(lat1);
  const p2 = toRadians(lat2);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "거리 확인 불가";
  if (meters < 1000) return `${Math.max(0, Math.round(meters))}m`;
  const kilometers = meters < 10000
    ? Math.round(meters / 100) / 10
    : Math.round(meters / 1000);
  return `${kilometers}km`;
}

// 원뿔의 기울기(n)와 크기(f)는 기준 위도 두 개만으로 정해지는 상수라 한 번만 계산해 둔다.
const CONE = (() => {
  const quarter = Math.PI / 4;
  const parallel1 = toRadians(MAP_PROJECTION.standardParallel1);
  const parallel2 = toRadians(MAP_PROJECTION.standardParallel2);
  const n = Math.log(Math.cos(parallel1) / Math.cos(parallel2))
    / Math.log(Math.tan(quarter + parallel2 / 2) / Math.tan(quarter + parallel1 / 2));
  const f = Math.cos(parallel1) * Math.tan(quarter + parallel1 / 2) ** n / n;
  return {
    n: n,
    f: f,
    originRadius: f / Math.tan(quarter + toRadians(MAP_PROJECTION.originLatitude) / 2) ** n
  };
})();

export function projectCoordinatesToMap(point) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const radius = CONE.f / Math.tan(Math.PI / 4 + toRadians(latitude) / 2) ** CONE.n;
  const angle = CONE.n * toRadians(longitude - MAP_PROJECTION.originLongitude);
  return {
    x: MAP_PROJECTION.scale * radius * Math.sin(angle) + MAP_PROJECTION.offsetX,
    // 화면 좌표는 아래로 갈수록 커지므로 남북을 뒤집는다.
    y: MAP_PROJECTION.scale * (radius * Math.cos(angle) - CONE.originRadius) + MAP_PROJECTION.offsetY
  };
}

function svgPathRings(pathData) {
  return (String(pathData || "").match(/M[^M]*/g) || []).map((subpath) => {
    const numbers = (subpath.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const points = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) {
      points.push([numbers[index], numbers[index + 1]]);
    }
    return points;
  }).filter((ring) => ring.length >= 3);
}

function municipalityRings(municipality) {
  if (!municipality || typeof municipality !== "object") return [];
  if (!SVG_RING_CACHE.has(municipality)) SVG_RING_CACHE.set(municipality, svgPathRings(municipality.d));
  return SVG_RING_CACHE.get(municipality);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    const crosses = (y1 > point.y) !== (y2 > point.y)
      && point.x < (x2 - x1) * (point.y - y1) / (y2 - y1) + x1;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function findRegionByCoordinates(municipalities, location) {
  const point = projectCoordinatesToMap(location);
  if (!point || !municipalities || typeof municipalities !== "object") return "";
  for (const [name, municipality] of Object.entries(municipalities)) {
    if (municipalityRings(municipality).some((ring) => pointInRing(point, ring))) return name;
  }
  return "";
}

// 경계 자료가 단순화돼 있어 성산일출봉·호미곶처럼 곶 끝이나 작은 섬에 있는 장소는 어느
// 폴리곤에도 들어가지 않는다. 소속 시·군은 이미 정해진 상태에서 그 안의 읍·면·동만 고르는
// 자리에 쓰라고 만든 함수라, 담고 있는 곳이 없으면 가장 가까운 경계선을 고른다.
export function nearestRegionByCoordinates(municipalities, location) {
  const inside = findRegionByCoordinates(municipalities, location);
  if (inside) return inside;
  const point = projectCoordinatesToMap(location);
  if (!point || !municipalities || typeof municipalities !== "object") return "";
  let best = "";
  let bestGap = Number.POSITIVE_INFINITY;
  for (const [name, municipality] of Object.entries(municipalities)) {
    for (const ring of municipalityRings(municipality)) {
      for (const [x, y] of ring) {
        const gap = (x - point.x) ** 2 + (y - point.y) ** 2;
        if (gap < bestGap) {
          bestGap = gap;
          best = name;
        }
      }
    }
  }
  return best;
}

export function parseBoolean(value, defaultValue = true) {
  if (value === "" || value === null || value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  return !["false", "0", "n", "no", "off", "비활성"].includes(normalized);
}

export function parseAnswer(value, choices) {
  const number = Number.parseInt(String(value).trim(), 10);
  if (number >= 1 && number <= choices.length) return number - 1;
  const textIndex = choices.findIndex((choice) => choice.trim() === String(value).trim());
  return textIndex;
}

function cellValue(cell) {
  if (!cell) return "";
  if (cell.v !== null && cell.v !== undefined) return cell.v;
  return cell.f ?? "";
}

function pick(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== "") return row[alias];
  }
  return "";
}

export function normalizeQuizRows(response) {
  const table = response?.table;
  if (!table || !Array.isArray(table.cols) || !Array.isArray(table.rows)) return [];
  const headers = table.cols.map((col, index) => String(col?.label || col?.id || index).trim());

  return table.rows.map((sourceRow, rowIndex) => {
    const row = {};
    headers.forEach((header, index) => { row[header] = cellValue(sourceRow?.c?.[index]); });
    const choices = [1, 2, 3, 4]
      .map((number) => String(pick(row, [`보기${number}`, `선택${number}`, `choice${number}`])).trim())
      .filter(Boolean);
    const latitude = Number(pick(row, ["위도", "latitude", "lat"]));
    const longitude = Number(pick(row, ["경도", "longitude", "lng", "lon"]));
    const radius = Number(pick(row, ["반경m", "반경(m)", "반경", "radius"]));
    const regionId = String(pick(row, ["지역ID", "지역", "regionId", "region"])).trim();
    const question = String(pick(row, ["문제", "질문", "question"])).trim();
    const answerIndex = parseAnswer(pick(row, ["정답", "answer"]), choices);
    return {
      id: String(pick(row, ["퀴즈ID", "ID", "id"]) || `row-${rowIndex + 2}`).trim(),
      regionId,
      placeName: String(pick(row, ["장소명", "장소", "placeName"]) || regionId).trim(),
      description: String(pick(row, ["설명", "장소설명", "placeDescription"])).trim(),
      theme: String(pick(row, ["테마", "주제", "theme"])).trim(),
      address: String(pick(row, ["주소", "소재지", "address"])).trim(),
      latitude,
      longitude,
      radius: Number.isFinite(radius) && radius > 0 ? radius : 150,
      question,
      choices,
      answerIndex,
      explanation: String(pick(row, ["해설", "explanation"])).trim(),
      active: parseBoolean(pick(row, ["활성", "사용", "active"]), true)
    };
  }).filter((quiz) => quiz.active
    && quiz.regionId
    && quiz.question
    && Number.isFinite(quiz.latitude)
    && Number.isFinite(quiz.longitude)
    && quiz.choices.length >= 2
    && quiz.answerIndex >= 0
    && quiz.answerIndex < quiz.choices.length);
}

export function rankNearbyQuizzes(quizzes, position, maxAccuracyAllowanceMeters = 75) {
  const accuracy = Math.max(0, Number(position?.accuracy) || 0);
  const allowance = Math.min(accuracy, Math.max(0, maxAccuracyAllowanceMeters));
  return quizzes.map((quiz) => {
    const distance = distanceMeters(position, quiz);
    return {
      ...quiz,
      distance,
      effectiveRadius: quiz.radius + allowance,
      inRange: distance <= quiz.radius + allowance
    };
  }).sort((a, b) => a.distance - b.distance);
}

export function uniqueRegions(quizzes) {
  return [...new Set(quizzes.map((quiz) => quiz.regionId).filter(Boolean))];
}

export function safeOwnedRegions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}
