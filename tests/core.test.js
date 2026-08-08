import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  distanceMeters,
  findRegionByCoordinates,
  formatDistance,
  normalizeQuizRows,
  projectCoordinatesToMap,
  rankNearbyQuizzes,
  safeOwnedRegions
} from "../js/core.js";

const mapContext = {};
vm.createContext(mapContext);
vm.runInContext(`${readFileSync(new URL("../js/map-data.js", import.meta.url), "utf8")};globalThis.TEST_MUNIS=MUNIS;`, mapContext);
const TEST_MUNIS = mapContext.TEST_MUNIS;

test("distanceMeters returns a realistic Seoul-to-Busan distance", () => {
  const meters = distanceMeters(
    { latitude: 37.5665, longitude: 126.9780 },
    { latitude: 35.1796, longitude: 129.0756 }
  );
  assert.ok(meters > 320_000 && meters < 340_000);
  assert.equal(formatDistance(987), "987m");
  assert.equal(formatDistance(1530), "1.5km");
});

test("normalizeQuizRows maps the Korean sheet schema and ignores inactive rows", () => {
  const cols = ["퀴즈ID", "지역ID", "장소명", "위도", "경도", "반경m", "문제", "보기1", "보기2", "보기3", "보기4", "정답", "해설", "활성"]
    .map((label, index) => ({ id: String.fromCharCode(65 + index), label }));
  const response = {
    table: {
      cols,
      rows: [
        { c: ["q1", "서울특별시", "서울광장", 37.5, 126.9, 150, "문제", "가", "나", "다", "라", 2, "해설", true].map((v) => ({ v })) },
        { c: ["q2", "부산광역시", "부산시청", 35.1, 129.0, 150, "문제", "가", "나", "다", "라", 1, "해설", false].map((v) => ({ v })) }
      ]
    }
  };
  const rows = normalizeQuizRows(response);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "q1");
  assert.equal(rows[0].answerIndex, 1);
  assert.equal(rows[0].radius, 150);
});

test("rankNearbyQuizzes includes a capped GPS accuracy allowance", () => {
  const quizzes = [{
    id: "q1", regionId: "서울특별시", latitude: 37, longitude: 127.001,
    radius: 50, question: "q", choices: ["a", "b"], answerIndex: 0
  }];
  const result = rankNearbyQuizzes(quizzes, { latitude: 37, longitude: 127, accuracy: 500 }, 75);
  assert.equal(result[0].effectiveRadius, 125);
  assert.equal(result[0].inRange, true);
});

test("rankNearbyQuizzes uses the radius supplied by the sheet", () => {
  const quizzes = [{
    id: "q1", regionId: "광주광역시", latitude: 35, longitude: 127.002,
    radius: 250, question: "q", choices: ["a", "b"], answerIndex: 0
  }];
  const result = rankNearbyQuizzes(quizzes, { latitude: 35, longitude: 127, accuracy: 0 }, 0);
  assert.ok(result[0].distance > 150 && result[0].distance < 250);
  assert.equal(result[0].effectiveRadius, 250);
  assert.equal(result[0].inRange, true);
});

test("safeOwnedRegions deduplicates and rejects invalid values", () => {
  assert.deepEqual(safeOwnedRegions(["서울특별시", "서울특별시", " 제주시 ", null, 3]), ["서울특별시", "제주시"]);
  assert.deepEqual(safeOwnedRegions("서울특별시"), []);
});

test("coordinates project to the real SVG map and resolve the correct municipality", () => {
  const nampyeong = { latitude: 35.044, longitude: 126.839 };
  const projected = projectCoordinatesToMap(nampyeong);
  assert.ok(projected.x > 267 && projected.x < 269);
  assert.ok(projected.y > 527 && projected.y < 530);
  assert.equal(findRegionByCoordinates(TEST_MUNIS, nampyeong), "나주시");
  assert.equal(findRegionByCoordinates(TEST_MUNIS, { latitude: 35.16, longitude: 126.8526 }), "광주광역시");
});
