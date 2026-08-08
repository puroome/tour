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
  locationWatchOptions: {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 10000
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
