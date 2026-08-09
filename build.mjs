// 배포용 압축 빌드. Node.js가 있는 환경에서 한 번 실행해서 결과를 직접 확인한 뒤 사용하세요.
// 이 저장소는 평소 빌드 없이 원본 파일을 그대로 서빙하는 구조라, 이 스크립트는 그 구조를
// 건드리지 않습니다 — index.html·service-worker.js는 여전히 원본(js/app.js 등)을 가리키고,
// 압축 결과물은 .min.js/.min.css로 옆에 따로 생성될 뿐입니다. 실제로 쓰려면 index.html의
// <script> 경로와 service-worker.js의 APP_SHELL 목록을 .min 파일로 바꿔야 합니다.
//
//   npm install --save-dev esbuild
//   npm run build
import { build } from "esbuild";

await build({
  entryPoints: ["js/app.js", "js/core.js", "js/config.js"],
  bundle: false, // 파일 구조(ESM import 경로)를 그대로 유지 — app.min.js도 여전히
                 // "./core.js"/"./config.js"를 가리킨다. 필요하면 그 두 줄만 손으로
                 // "./core.min.js"/"./config.min.js"로 바꿔서 셋 다 압축본을 쓰게 하면 된다.
  minify: true,
  format: "esm",
  outdir: "js",
  entryNames: "[name].min",
  logLevel: "info"
});

await build({
  entryPoints: ["style.css"],
  bundle: false,
  minify: true,
  outdir: ".",
  entryNames: "[name].min",
  logLevel: "info"
});

console.log("완료: js/app.min.js, js/core.min.js, js/config.min.js, style.min.css");
