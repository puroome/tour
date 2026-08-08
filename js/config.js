export const APP_CONFIG = Object.freeze({
  appName: "발자국",
  sheetId: "130uj9eqwuHq6FTsXq_xBXh_qHT8Qb1WoCgCnHaQtsBE",
  sheetName: "quiz",
  sheetUrl: "https://docs.google.com/spreadsheets/d/130uj9eqwuHq6FTsXq_xBXh_qHT8Qb1WoCgCnHaQtsBE/edit?usp=sharing",
  // Code.gs를 웹 앱으로 배포한 뒤 /exec URL을 입력하세요. API 키는 이 파일에 넣지 않습니다.
  tourApiProxyUrl: "https://script.google.com/macros/s/AKfycbyKVIP9fWQlPcknWVzk67DiFWJcfVP8E_5WdgQci9U1z1TZN6moWzasGcN2tx53O6PS/exec",
  tourApiRadiusMeters: 300,
  tourApiResultCount: 5,
  // 카드는 20km 안에서 보이고, 활성화 반경은 시트의 반경m 값을 우선 사용합니다.
  questVisibilityRadiusMeters: 20000,
  questActivationRadiusMeters: 150,
  // 휴대폰의 GPS 콜드 스타트는 30초 이상 걸리고, 조금 전에 잡은 좌표는 그대로 다시 씁니다.
  locationWatchOptions: {
    enableHighAccuracy: true,
    timeout: 30000,
    maximumAge: 60000
  },
  // 위성 신호를 기다리는 동안 네트워크 기반 좌표로 화면을 먼저 채웁니다.
  locationQuickFixOptions: {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 300000
  },
  maxAccuracyAllowanceMeters: 0,
  firebase: {
    apiKey: "AIzaSyD91y-2vS26lj2ZjgZ8XffZI4IBpPP151I",
    authDomain: "tour-53b75.firebaseapp.com",
    projectId: "tour-53b75",
    storageBucket: "tour-53b75.firebasestorage.app",
    messagingSenderId: "952641260795",
    appId: "1:952641260795:web:1977671cb87cb9f898745e"
  }
});
