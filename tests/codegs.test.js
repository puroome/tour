import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
vm.createContext(context);
const source = readFileSync(new URL("../Code.gs", import.meta.url), "utf8");
vm.runInContext(
  `${source};globalThis.__inferRegionId=inferRegionId_;globalThis.__googleAccountId=googleAccountId_;`,
  context
);
const inferRegionId = context.__inferRegionId;
const googleAccountId = context.__googleAccountId;

test("integrated province names prefer a second-level city or county", () => {
  assert.equal(
    inferRegionId("전남광주통합특별시 나주시 남평읍 남평향교길 45-12"),
    "나주시"
  );
  assert.equal(inferRegionId("전남광주통합특별시 남구 양림동"), "광주광역시");
});

test("standard metropolitan and duplicate county names remain compatible", () => {
  assert.equal(inferRegionId("광주광역시 남구 양림동"), "광주광역시");
  assert.equal(inferRegionId("강원특별자치도 고성군 간성읍"), "고성군(강원)");
  assert.equal(inferRegionId("경상남도 고성군 고성읍"), "고성군(경남)");
});

test("admins without a student id are told apart by their Google account id", () => {
  assert.equal(googleAccountId("puroome@gmail.com"), "puroome");
  assert.equal(googleAccountId("hong.gildong@school.kr"), "hong.gildong");
  assert.equal(googleAccountId("teacher+field@gmail.com"), "teacherfield");
  assert.notEqual(googleAccountId("jame@school.kr"), googleAccountId("mina@school.kr"));
  assert.equal(googleAccountId(""), "master");
});
