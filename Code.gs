/**
 * 발자국 - Google Sheets 초기 설정 + TourAPI 프록시
 *
 * 탭 이름: user(학생 명단), quiz(퀴즈), db(TourAPI 장소목록)
 *
 * 사용법:
 * 1) 퀴즈 시트에서 확장 프로그램 > Apps Script를 엽니다.
 * 2) 이 파일의 내용을 붙여 넣고 저장합니다.
 * 3) setupQuizSheet 함수를 한 번 실행합니다.
 * 4) 스크립트 속성 TOUR_API_KEY를 설정하고 웹 앱으로 배포합니다.
 */

const GEO_QUEST_SHEET_ID = '130uj9eqwuHq6FTsXq_xBXh_qHT8Qb1WoCgCnHaQtsBE';
const GEO_QUEST_SHEET_NAME = 'quiz';
const TOUR_PLACE_CATALOG_SHEET_NAME = 'db';
const STUDENT_ROSTER_SHEET_NAME = 'user';
const STUDENT_ROSTER_HEADERS = ['Email', 'Name', 'ID', 'Permission', 'Edit'];
const FIREBASE_PROJECT_ID = 'tour-53b75';
const FIRESTORE_ROSTER_COLLECTION = 'roster';
const FIREBASE_WEB_API_KEY = 'AIzaSyD91y-2vS26lj2ZjgZ8XffZI4IBpPP151I';
const FIELD_PHOTO_FOLDER_ID = '14AX0s0hQWXghRHDMp-UJ6_I9E5_AnXRy';
const MAX_FIELD_PHOTO_BYTES = 5 * 1024 * 1024;
const TOUR_API_BASE_URL = 'https://apis.data.go.kr/B551011/KorService2';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const EDUCATIONAL_CONTENT_TYPES = new Set(['12', '14', '38', '39']); // 관광지, 문화시설, 쇼핑, 음식점
const EDUCATIONAL_CONTENT_LABELS = {
  '12': '관광지',
  '14': '문화시설',
  '38': '쇼핑',
  '39': '음식점'
};
const METROPOLITAN_REGION_NAMES = new Set([
  '서울특별시', '부산광역시', '대구광역시', '인천광역시',
  '광주광역시', '대전광역시', '울산광역시', '세종특별자치시'
]);
const METROPOLITAN_REGION_KEYWORDS = {
  '서울': '서울특별시',
  '부산': '부산광역시',
  '대구': '대구광역시',
  '인천': '인천광역시',
  '광주': '광주광역시',
  '대전': '대전광역시',
  '울산': '울산광역시',
  '세종': '세종특별자치시'
};
const GEO_QUEST_HEADERS = [
  '퀴즈ID', '지역ID', '장소명', '설명', '테마', '위도', '경도', '반경m',
  '문제', '보기1', '보기2', '보기3', '보기4', '정답', '해설', '활성', '주소'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧭 발자국')
    .addItem('시트 형식 만들기', 'setupQuizSheet')
    .addItem('db 장소목록 새로 만들기', 'buildTourPlaceCatalog')
    .addItem('선택 장소를 퀴즈로 추가', 'addSelectedTourPlacesToQuizSheet')
    .addItem('퀴즈 주소·지역 다시 채우기', 'repairQuizPlaceMetadata')
    .addItem('퀴즈 빈 행 정리', 'compactQuizRows')
    .addItem('퀴즈 데이터 검사', 'validateQuizSheet')
    .addItem('user 명단 → Firebase 동기화', 'syncStudentRosterToFirebase')
    .addSeparator()
    .addItem('TourAPI 연결 확인', 'testTourApiConnection')
    .addToUi();
}

function doGet(event) {
  const parameters = event && event.parameter ? event.parameter : {};
  try {
    const action = String(parameters.action || '');
    if (action === 'getQuizzes') return tourApiOutput_(getQuizData_(), parameters.callback);
    if (action === 'tourNearby') return tourApiOutput_(tourNearby_(parameters), parameters.callback);
    if (action === 'reverseAddress') return tourApiOutput_(reverseAddress_(parameters), parameters.callback);
    if (action === 'checkStudentPermission') {
      return tourApiOutput_(checkStudentPermission_(parameters), parameters.callback);
    }
    if (action === 'requestStudentPermission') {
      return tourApiOutput_(requestStudentPermission_(parameters), parameters.callback);
    }
    return tourApiOutput_({ success: false, message: '지원하지 않는 요청입니다.' }, parameters.callback);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return tourApiOutput_({ success: false, message: error.message || '요청 처리에 실패했습니다.' }, parameters.callback);
  }
}

function doPost(event) {
  let requestId = '';
  try {
    const rawPayload = event && event.parameter && event.parameter.payload
      ? event.parameter.payload
      : event && event.postData ? event.postData.contents || '{}' : '{}';
    const payload = JSON.parse(rawPayload);
    requestId = String(payload.requestId || '');
    if (String(payload.action || '') !== 'uploadFieldPhoto') {
      throw new Error('지원하지 않는 업로드 요청입니다.');
    }
    return photoUploadOutput_(uploadFieldPhoto_(payload), requestId);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return photoUploadOutput_({ success: false, message: error.message || '사진 업로드에 실패했습니다.' }, requestId);
  }
}

function photoUploadOutput_(result, requestId) {
  const message = JSON.stringify({
    type: 'geoQuestPhotoUpload',
    requestId: String(requestId || ''),
    result: result
  }).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput(
    `<script>window.top.postMessage(${message}, '*');</script>`
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getQuizData_() {
  const spreadsheet = SpreadsheetApp.openById(GEO_QUEST_SHEET_ID);
  const sheet = spreadsheet.getSheetByName(GEO_QUEST_SHEET_NAME);
  if (!sheet) throw new Error('quiz 탭을 찾을 수 없습니다.');
  ensureQuizAddressHeader_(sheet);
  const lastRow = Math.max(1, sheet.getLastRow());
  const values = sheet.getRange(1, 1, lastRow, GEO_QUEST_HEADERS.length).getValues();
  const headers = values[0].map(value => String(value || '').trim());
  const missing = GEO_QUEST_HEADERS.filter(header => !headers.includes(header));
  if (missing.length) throw new Error(`퀴즈 필수 헤더가 없습니다: ${missing.join(', ')}`);
  return {
    success: true,
    table: {
      cols: headers.map((header, index) => ({ id: String(index), label: header, type: 'string' })),
      rows: values.slice(1).map(row => ({
        c: row.map(value => ({ v: value instanceof Date ? value.toISOString() : value }))
      }))
    }
  };
}

function studentRosterContext_() {
  const spreadsheet = SpreadsheetApp.openById(GEO_QUEST_SHEET_ID);
  const sheet = spreadsheet.getSheetByName(STUDENT_ROSTER_SHEET_NAME);
  if (!sheet) throw new Error('user 탭이 없습니다. Email, Name, ID, Permission, Edit 헤더로 직접 만들어 주세요.');
  const values = sheet.getDataRange().getDisplayValues();
  const headers = (values[0] || []).map(value => String(value).trim());
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  const missing = STUDENT_ROSTER_HEADERS.filter(header => indexes[header] === undefined);
  if (missing.length) throw new Error(`user 탭 필수 헤더가 없습니다: ${missing.join(', ')}`);
  return { sheet: sheet, values: values, indexes: indexes };
}

function normalizeStudentEmail_(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('올바른 Google 계정 이메일이 필요합니다.');
  }
  return email;
}

function normalizeYesNo_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['yes', 'y', 'true', 'approved'].includes(normalized)) return 'yes';
  if (['no', 'n', 'false', 'denied'].includes(normalized)) return 'no';
  return '';
}

function studentPermissionResult_(row, indexes) {
  if (!row) return { success: true, status: 'not_found', canEdit: false };
  const permission = normalizeYesNo_(row[indexes.Permission]);
  return {
    success: true,
    status: permission === 'yes' ? 'approved' : permission === 'no' ? 'denied' : 'pending',
    canEdit: permission === 'yes' && normalizeYesNo_(row[indexes.Edit]) === 'yes'
  };
}

function checkStudentPermission_(parameters) {
  const email = normalizeStudentEmail_(parameters.email);
  const context = studentRosterContext_();
  const row = context.values.slice(1).find(value => (
    String(value[context.indexes.Email] || '').trim().toLowerCase() === email
  ));
  return studentPermissionResult_(row, context.indexes);
}

function requestStudentPermission_(parameters) {
  const email = normalizeStudentEmail_(parameters.email);
  const name = String(parameters.name || '').trim();
  const studentId = String(parameters.studentId || '').trim();
  if (!name || name.length > 40) throw new Error('이름은 1~40자로 입력해 주세요.');
  if (!/^\d{5}$/.test(studentId)) throw new Error('학번은 숫자 5자리로 입력해 주세요.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const context = studentRosterContext_();
    const existingRow = context.values.slice(1).find(value => (
      String(value[context.indexes.Email] || '').trim().toLowerCase() === email
    ));
    if (existingRow) {
      return Object.assign(
        studentPermissionResult_(existingRow, context.indexes),
        { message: 'user 탭에 이미 등록된 계정입니다.' }
      );
    }
    const duplicateIdRow = context.values.slice(1).find(value => (
      String(value[context.indexes.ID] || '').trim() === studentId
    ));
    if (duplicateIdRow) throw new Error('이미 등록된 학번입니다. 학번을 다시 확인해 주세요.');

    const row = new Array(Math.max(context.sheet.getLastColumn(), STUDENT_ROSTER_HEADERS.length)).fill('');
    row[context.indexes.Email] = email;
    row[context.indexes.Name] = name;
    row[context.indexes.ID] = studentId;
    row[context.indexes.Permission] = '';
    row[context.indexes.Edit] = '';
    context.sheet.appendRow(row);
    const savedRow = context.sheet.getLastRow();
    context.sheet.getRange(savedRow, context.indexes.ID + 1).setNumberFormat('@').setValue(studentId);
    return {
      success: true,
      status: 'pending',
      canEdit: false,
      message: '권한 요청을 user 탭에 등록했습니다.'
    };
  } finally {
    lock.releaseLock();
  }
}

function verifiedPhotoUploader_(idToken) {
  const token = String(idToken || '').trim();
  if (token.length < 100) throw new Error('로그인 확인 정보가 없습니다. 다시 로그인해 주세요.');
  const response = UrlFetchApp.fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: token }),
      muteHttpExceptions: true
    }
  );
  if (response.getResponseCode() !== 200) throw new Error('로그인 확인에 실패했습니다. 다시 로그인해 주세요.');
  const user = (JSON.parse(response.getContentText() || '{}').users || [])[0];
  const email = normalizeStudentEmail_(user && user.email);
  const context = studentRosterContext_();
  const row = context.values.slice(1).find(value => (
    String(value[context.indexes.Email] || '').trim().toLowerCase() === email
  ));
  const permission = studentPermissionResult_(row, context.indexes);
  if (permission.status !== 'approved') throw new Error('승인된 계정만 현장 사진을 올릴 수 있습니다.');
  const studentId = String(row[context.indexes.ID] || '').trim();
  const canEdit = permission.canEdit === true;
  if (studentId && !/^\d{5}$/.test(studentId)) throw new Error('user 탭의 학번은 숫자 5자리여야 합니다.');
  if (!studentId && !canEdit) throw new Error('user 탭에서 학번을 확인해 주세요.');
  return { studentId: studentId || 'master' };
}

function uploadFieldPhoto_(payload) {
  const uploader = verifiedPhotoUploader_(payload.idToken);
  const missionKey = String(payload.missionKey || '').trim();
  if (!missionKey || missionKey.length > 500) throw new Error('장소 정보를 확인할 수 없습니다.');
  const imageData = String(payload.imageData || '').replace(/^data:image\/[^;]+;base64,/i, '');
  if (!imageData || !/^[A-Za-z0-9+/=\s]+$/.test(imageData)) throw new Error('올바른 사진 파일이 필요합니다.');
  const bytes = Utilities.base64Decode(imageData.replace(/\s/g, ''));
  if (!bytes.length || bytes.length > MAX_FIELD_PHOTO_BYTES) {
    throw new Error('사진은 5MB 이하로 올려 주세요.');
  }
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  const fileName = `${uploader.studentId}-${timestamp}.jpg`;
  const folder = DriveApp.getFolderById(FIELD_PHOTO_FOLDER_ID);
  const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', fileName));
  return {
    success: true,
    fileName: fileName,
    fileId: file.getId(),
    url: `https://drive.google.com/uc?export=view&id=${encodeURIComponent(file.getId())}`,
    uploadedAt: new Date().toISOString()
  };
}

function syncStudentRosterToFirebase() {
  const ui = SpreadsheetApp.getUi();
  const context = studentRosterContext_();
  const roster = {};
  const errors = [];
  const seenEmails = new Set();
  const seenIds = new Set();
  const syncedAt = Date.now();

  context.values.slice(1).forEach((row, offset) => {
    const sheetRow = offset + 2;
    const rawEmail = String(row[context.indexes.Email] || '').trim();
    const name = String(row[context.indexes.Name] || '').trim();
    const studentId = String(row[context.indexes.ID] || '').trim();
    const rawPermission = String(row[context.indexes.Permission] || '').trim();
    const rawEdit = String(row[context.indexes.Edit] || '').trim();
    if (![rawEmail, name, studentId, rawPermission, rawEdit].some(Boolean)) return;

    let email = '';
    try {
      email = normalizeStudentEmail_(rawEmail);
    } catch (error) {
      errors.push(`${sheetRow}행: ${error.message}`);
      return;
    }
    if (!name) errors.push(`${sheetRow}행: Name이 비어 있습니다.`);
    if (seenEmails.has(email)) errors.push(`${sheetRow}행: Email이 중복됩니다.`);
    if (studentId && seenIds.has(studentId)) errors.push(`${sheetRow}행: ID가 중복됩니다.`);

    const permissionFlag = normalizeYesNo_(rawPermission);
    const editFlag = normalizeYesNo_(rawEdit);
    if (rawPermission && !permissionFlag) errors.push(`${sheetRow}행: Permission은 yes, no 또는 빈칸이어야 합니다.`);
    if (rawEdit && !editFlag) errors.push(`${sheetRow}행: Edit는 yes, no 또는 빈칸이어야 합니다.`);
    const isAdministrator = editFlag === 'yes';
    if (studentId && !/^\d{5}$/.test(studentId)) {
      errors.push(`${sheetRow}행: ID를 입력할 경우 숫자 5자리여야 합니다.`);
    } else if (!studentId && !isAdministrator) {
      errors.push(`${sheetRow}행: 일반 학생의 ID는 숫자 5자리로 입력해야 합니다.`);
    }
    seenEmails.add(email);
    if (studentId) seenIds.add(studentId);
    if (errors.some(message => message.startsWith(`${sheetRow}행:`))) return;

    const permission = permissionFlag === 'yes'
      ? 'approved'
      : permissionFlag === 'no' ? 'denied' : 'pending';
    const firebaseKey = email.replace(/\./g, '_');
    roster[firebaseKey] = {
      email: email,
      name: name,
      studentId: studentId,
      permissions: permission,
      canEdit: permission === 'approved' && editFlag === 'yes',
      syncedAt: syncedAt
    };
  });

  if (errors.length) {
    ui.alert(`user 탭 오류 ${errors.length}개\n\n${errors.slice(0, 30).join('\n')}`);
    return;
  }
  const studentCount = Object.keys(roster).length;
  if (!studentCount) {
    ui.alert('동기화할 학생이 없습니다. 기존 Firebase 명단을 보호하기 위해 동기화를 중단했습니다.');
    return;
  }
  const confirmation = ui.alert(
    'Firestore 학생 명단 동기화',
    `학생 ${studentCount}명의 현재 시트 내용을 Firestore roster에 반영합니다.\n시트에서 삭제된 계정은 roster에서도 삭제됩니다. 계속할까요?`,
    ui.ButtonSet.YES_NO
  );
  if (confirmation !== ui.Button.YES) return;

  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` };
  const existingEmails = listFirestoreRosterEmails_(firestoreBase, headers);
  const requests = Object.values(roster).map(student => ({
    url: `${firestoreBase}/${FIRESTORE_ROSTER_COLLECTION}/${encodeURIComponent(student.email)}`,
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify({
      fields: {
        email: { stringValue: student.email },
        name: { stringValue: student.name },
        studentId: { stringValue: student.studentId },
        permissions: { stringValue: student.permissions },
        canEdit: { booleanValue: student.canEdit },
        syncedAt: { timestampValue: new Date(syncedAt).toISOString() }
      }
    }),
    headers: headers,
    muteHttpExceptions: true
  }));
  existingEmails
    .filter(email => !roster[email.replace(/\./g, '_')])
    .forEach(email => requests.push({
      url: `${firestoreBase}/${FIRESTORE_ROSTER_COLLECTION}/${encodeURIComponent(email)}`,
      method: 'delete',
      headers: headers,
      muteHttpExceptions: true
    }));

  executeFirestoreRequests_(requests);
  ui.alert(`Firestore 동기화 완료: 학생 ${studentCount}명`);
}

function listFirestoreRosterEmails_(firestoreBase, headers) {
  const emails = [];
  let pageToken = '';
  do {
    const query = [`pageSize=1000`];
    if (pageToken) query.push(`pageToken=${encodeURIComponent(pageToken)}`);
    const response = UrlFetchApp.fetch(
      `${firestoreBase}/${FIRESTORE_ROSTER_COLLECTION}?${query.join('&')}`,
      { method: 'get', headers: headers, muteHttpExceptions: true }
    );
    const status = response.getResponseCode();
    if (status === 404) return emails;
    if (status < 200 || status >= 300) {
      throw new Error(`Firestore 명단 조회 실패 (${status}): ${response.getContentText().slice(0, 300)}`);
    }
    const data = JSON.parse(response.getContentText() || '{}');
    (data.documents || []).forEach(document => {
      const encodedId = String(document.name || '').split('/').pop();
      if (encodedId) emails.push(decodeURIComponent(encodedId));
    });
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);
  return emails;
}

function executeFirestoreRequests_(requests) {
  for (let start = 0; start < requests.length; start += 100) {
    const batch = requests.slice(start, start + 100);
    const responses = UrlFetchApp.fetchAll(batch);
    responses.forEach((response, index) => {
      const status = response.getResponseCode();
      if (status < 200 || status >= 300) {
        const request = batch[index];
        throw new Error(
          `Firestore 동기화 실패 (${status}, ${request.method.toUpperCase()}): ` +
          response.getContentText().slice(0, 300)
        );
      }
    });
  }
}

function reverseAddress_(parameters) {
  const latitude = Number(parameters.lat);
  const longitude = Number(parameters.lng);
  if (!Number.isFinite(latitude) || latitude < 32 || latitude > 39 ||
      !Number.isFinite(longitude) || longitude < 124 || longitude > 132) {
    throw new Error('대한민국 안의 올바른 위치가 필요합니다.');
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = ['reverse-osm-v1', latitude.toFixed(4), longitude.toFixed(4)].join(':');
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const lastRequestAt = Number(properties.getProperty('NOMINATIM_LAST_REQUEST_AT')) || 0;
    const waitMs = Math.max(0, 1100 - (Date.now() - lastRequestAt));
    if (waitMs) Utilities.sleep(waitMs);

    const appUrl = ScriptApp.getService().getUrl() || 'https://script.google.com/';
    const query = [
      'format=jsonv2',
      'addressdetails=1',
      'zoom=18',
      'accept-language=ko',
      `lat=${encodeURIComponent(latitude)}`,
      `lon=${encodeURIComponent(longitude)}`
    ].join('&');
    const response = UrlFetchApp.fetch(`${NOMINATIM_REVERSE_URL}?${query}`, {
      method: 'get',
      headers: {
        'Accept-Language': 'ko',
        'Referer': appUrl,
        'User-Agent': `GeoQuest-Education/1.0 (${appUrl})`
      },
      muteHttpExceptions: true
    });
    properties.setProperty('NOMINATIM_LAST_REQUEST_AT', String(Date.now()));
    if (response.getResponseCode() !== 200) throw new Error('현재 주소를 확인하지 못했습니다.');

    const data = JSON.parse(response.getContentText());
    const address = data.address || {};
    const parts = [
      address.state,
      address.city || address.county,
      address.city_district || address.borough,
      address.suburb || address.town || address.village,
      address.road || address.pedestrian,
      address.house_number
    ].map(value => String(value || '').trim()).filter((value, index, list) => value && list.indexOf(value) === index);
    const result = {
      success: true,
      address: parts.length >= 2 ? parts.join(' ') : String(data.display_name || '').trim(),
      source: 'OpenStreetMap'
    };
    if (!result.address) throw new Error('현재 주소 정보가 없습니다.');
    cache.put(cacheKey, JSON.stringify(result), 21600);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function tourNearby_(parameters) {
  const latitude = Number(parameters.lat);
  const longitude = Number(parameters.lng);
  if (!Number.isFinite(latitude) || latitude < 32 || latitude > 39 ||
      !Number.isFinite(longitude) || longitude < 124 || longitude > 132) {
    throw new Error('대한민국 안의 올바른 위치가 필요합니다.');
  }

  const radius = Math.min(20000, Math.max(100, Math.round(Number(parameters.radius) || 5000)));
  const limit = Math.min(10, Math.max(1, Math.round(Number(parameters.limit) || 5)));
  const cacheKey = ['tour-edu-v1', latitude.toFixed(3), longitude.toFixed(3), radius, limit].join(':');
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const result = fetchTourNearbyData_(latitude, longitude, radius, limit);
  cache.put(cacheKey, JSON.stringify(result), 300);
  return result;
}

function fetchTourNearbyData_(latitude, longitude, radius, limit) {
  // 한 번만 호출한 뒤 교육용 장소를 추리기 위해 충분한 수를 거리순으로 요청합니다.
  const requestedRows = Math.min(100, Math.max(40, limit * 20));
  const responseData = fetchTourApi_('locationBasedList2', {
    mapX: longitude,
    mapY: latitude,
    radius: radius,
    arrange: 'E',
    numOfRows: requestedRows,
    pageNo: 1
  });
  const body = responseData.body;
  const list = responseData.items;
  const items = list.map(item => ({
    contentId: String(item.contentid || ''),
    contentTypeId: String(item.contenttypeid || ''),
    title: String(item.title || '').trim(),
    address: [item.addr1, item.addr2].filter(Boolean).join(' ').trim(),
    latitude: Number(item.mapy),
    longitude: Number(item.mapx),
    distance: Number(item.dist),
    image: String(item.firstimage || item.firstimage2 || '')
  })).filter(item => (
    EDUCATIONAL_CONTENT_TYPES.has(item.contentTypeId) &&
    item.title &&
    Number.isFinite(item.distance)
  )).slice(0, limit);

  return {
    success: true,
    items: items,
    totalCount: items.length,
    sourceTotalCount: Number(body.totalCount) || list.length
  };
}

function fillTourPlaceData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GEO_QUEST_SHEET_NAME);
  if (!sheet) throw new Error('quiz 탭을 찾을 수 없습니다.');
  ensureQuizAddressHeader_(sheet);

  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length < 2) {
    SpreadsheetApp.getUi().alert('장소명을 입력한 퀴즈 행이 없습니다.');
    return;
  }

  const headers = values[0].map(value => String(value).trim());
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  const missing = GEO_QUEST_HEADERS.filter(header => index[header] === undefined);
  if (missing.length) throw new Error(`필수 헤더가 없습니다: ${missing.join(', ')}`);

  let filledCount = 0;
  const errors = [];
  values.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const placeName = String(row[index['장소명']] || '').trim();
    if (!placeName) return;

    const hasRequiredPlaceData = Boolean(row[index['퀴즈ID']]) &&
      Boolean(row[index['지역ID']]) &&
      Number.isFinite(Number(row[index['위도']])) &&
      Number.isFinite(Number(row[index['경도']])) &&
      Number(row[index['반경m']]) > 0;
    if (hasRequiredPlaceData) return;

    try {
      const place = searchTourPlace_(placeName);
      if (!row[index['퀴즈ID']]) row[index['퀴즈ID']] = `tour-${place.contentId}-${String(line).padStart(3, '0')}`;
      if (!row[index['지역ID']]) row[index['지역ID']] = inferRegionId_(place.address);
      row[index['장소명']] = place.title;
      row[index['주소']] = place.address;
      row[index['위도']] = place.latitude;
      row[index['경도']] = place.longitude;
      if (!Number(row[index['반경m']])) row[index['반경m']] = 150;
      row[index['활성']] = true;
      filledCount += 1;
    } catch (error) {
      errors.push(`${line}행 ${placeName}: ${error.message}`);
    }
  });

  if (filledCount) {
    sheet.getRange(2, 1, values.length - 1, headers.length).setValues(values.slice(1));
    sheet.getRange(2, 6, values.length - 1, 2).setNumberFormat('0.000000');
  }

  const summary = `TourAPI 장소 정보 ${filledCount}개를 자동으로 채웠습니다.`;
  const errorText = errors.length ? `\n\n확인 필요 ${errors.length}개\n${errors.slice(0, 10).join('\n')}` : '';
  SpreadsheetApp.getUi().alert(summary + errorText);
}

function buildTourPlaceCatalog() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(TOUR_PLACE_CATALOG_SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    const answer = SpreadsheetApp.getUi().alert(
      '기존 db 장소목록을 새로 만들까요?',
      'db 탭의 기존 내용이 최신 TourAPI 데이터로 교체됩니다.',
      SpreadsheetApp.getUi().ButtonSet.YES_NO
    );
    if (answer !== SpreadsheetApp.getUi().Button.YES) return;
  }
  if (!sheet) sheet = spreadsheet.insertSheet(TOUR_PLACE_CATALOG_SHEET_NAME);

  const oldFilter = sheet.getFilter();
  if (oldFilter) oldFilter.remove();
  sheet.clear();
  const headers = ['선택', '장소명', '유형', '주소', '위도', '경도', '콘텐츠ID'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#173f35')
    .setFontColor('#fffdf7')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  let nextRow = 2;
  let savedCount = 0;
  [...EDUCATIONAL_CONTENT_TYPES].forEach(contentTypeId => {
    let pageNo = 1;
    let totalPages = 1;
    while (pageNo <= totalPages && pageNo <= 200) {
      const responseData = fetchTourApi_('areaBasedList2', {
        contentTypeId: contentTypeId,
        arrange: 'A',
        numOfRows: 1000,
        pageNo: pageNo
      });
      const totalCount = Number(responseData.body.totalCount) || 0;
      totalPages = Math.max(1, Math.ceil(totalCount / 1000));
      const rows = responseData.items.map(item => {
        const latitude = Number(item.mapy);
        const longitude = Number(item.mapx);
        return [
          false,
          String(item.title || '').trim(),
          EDUCATIONAL_CONTENT_LABELS[contentTypeId],
          [item.addr1, item.addr2].filter(Boolean).join(' ').trim(),
          latitude,
          longitude,
          String(item.contentid || '')
        ];
      }).filter(row => (
        row[1] && row[6] && Number.isFinite(row[4]) && Number.isFinite(row[5])
      ));

      if (rows.length) {
        ensureSheetRows_(sheet, nextRow + rows.length - 1);
        sheet.getRange(nextRow, 1, rows.length, headers.length).setValues(rows);
        nextRow += rows.length;
        savedCount += rows.length;
      }
      if (!responseData.items.length) break;
      pageNo += 1;
    }
  });

  if (savedCount) {
    sheet.getRange(2, 1, savedCount, 1).insertCheckboxes();
    sheet.getRange(2, 5, savedCount, 2).setNumberFormat('0.000000');
    sheet.getRange(1, 1, savedCount + 1, headers.length).createFilter();
  }
  sheet.setColumnWidth(1, 60);
  sheet.setColumnWidth(2, 240);
  sheet.setColumnWidth(3, 90);
  sheet.setColumnWidth(4, 360);
  sheet.setColumnWidths(5, 2, 110);
  sheet.setColumnWidth(7, 120);
  SpreadsheetApp.getUi().alert(`퀴즈로 사용할 수 있는 장소 ${savedCount}개를 db 탭에 저장했습니다.`);
}

function addSelectedTourPlacesToQuizSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const catalogSheet = spreadsheet.getSheetByName(TOUR_PLACE_CATALOG_SHEET_NAME);
  const quizSheet = spreadsheet.getSheetByName(GEO_QUEST_SHEET_NAME);
  if (!catalogSheet || catalogSheet.getLastRow() < 2) {
    throw new Error('먼저 db 장소목록 새로 만들기를 실행해 주세요.');
  }
  if (!quizSheet) throw new Error('quiz 탭을 찾을 수 없습니다.');
  ensureQuizAddressHeader_(quizSheet);
  compactQuizRows_(quizSheet);
  repairQuizRegionIds_(quizSheet, catalogSheet);

  const catalogRows = catalogSheet.getRange(2, 1, catalogSheet.getLastRow() - 1, 7).getValues();
  const selectedRows = catalogRows.filter(row => row[0] === true);
  if (!selectedRows.length) {
    SpreadsheetApp.getUi().alert('db 탭에서 퀴즈를 만들 장소를 먼저 체크해 주세요.');
    return;
  }

  const quizValues = quizSheet.getDataRange().getValues();
  const quizHeaders = quizValues[0].map(value => String(value).trim());
  const missing = GEO_QUEST_HEADERS.filter(header => !quizHeaders.includes(header));
  if (missing.length) throw new Error(`quiz 탭 필수 헤더가 없습니다: ${missing.join(', ')}`);

  const existingIds = new Set(quizValues.slice(1).map(row => String(row[0] || '').trim()).filter(Boolean));
  const existingPlaces = new Set(quizValues.slice(1).map(row => (
    [String(row[2] || '').trim(), Number(row[5]).toFixed(5), Number(row[6]).toFixed(5)].join('|')
  )));
  const rowsToAdd = [];
  let skippedCount = 0;

  selectedRows.forEach(row => {
    const placeName = String(row[1] || '').trim();
    const address = String(row[3] || '').trim();
    const latitude = Number(row[4]);
    const longitude = Number(row[5]);
    const contentId = String(row[6] || '').trim();
    const quizId = `tour-${contentId}`;
    const placeKey = [placeName, latitude.toFixed(5), longitude.toFixed(5)].join('|');
    if (existingIds.has(quizId) || existingPlaces.has(placeKey)) {
      skippedCount += 1;
      return;
    }
    rowsToAdd.push([
      quizId,
      inferRegionId_(address),
      placeName,
      '',
      '',
      latitude,
      longitude,
      150,
      '', '', '', '', '', '', '',
      true,
      address
    ]);
    existingIds.add(quizId);
    existingPlaces.add(placeKey);
  });

  if (rowsToAdd.length) {
    const startRow = quizSheet.getLastRow() + 1;
    ensureSheetRows_(quizSheet, startRow + rowsToAdd.length - 1);
    quizSheet.getRange(startRow, 1, rowsToAdd.length, GEO_QUEST_HEADERS.length).setValues(rowsToAdd);
    quizSheet.getRange(startRow, 6, rowsToAdd.length, 2).setNumberFormat('0.000000');
    applyQuizDataValidations_(quizSheet, startRow, rowsToAdd.length);
  }
  catalogSheet.getRange(2, 1, catalogRows.length, 1).uncheck();
  SpreadsheetApp.getUi().alert(
    `선택 장소 ${rowsToAdd.length}개를 quiz 탭에 추가했습니다.` +
    (skippedCount ? `\n이미 등록된 장소 ${skippedCount}개는 건너뛰었습니다.` : '')
  );
}

function ensureSheetRows_(sheet, requiredRows) {
  const missingRows = requiredRows - sheet.getMaxRows();
  if (missingRows > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missingRows);
}

function compactQuizRows() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GEO_QUEST_SHEET_NAME);
  if (!sheet) throw new Error('quiz 탭을 찾을 수 없습니다.');
  ensureQuizAddressHeader_(sheet);
  const rowCount = compactQuizRows_(sheet);
  const catalogSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TOUR_PLACE_CATALOG_SHEET_NAME);
  const correctedCount = repairQuizRegionIds_(sheet, catalogSheet);
  SpreadsheetApp.getUi().alert(
    `퀴즈 ${rowCount}개를 2행부터 빈칸 없이 정리했습니다.` +
    (correctedCount ? `\n주소·지역 정보 ${correctedCount}개를 다시 채웠습니다.` : '')
  );
}

function ensureQuizAddressHeader_(sheet) {
  const descriptionColumn = GEO_QUEST_HEADERS.indexOf('설명') + 1;
  const descriptionHeader = sheet.getRange(1, descriptionColumn).getDisplayValue().trim();
  if (descriptionHeader !== '설명') {
    if (descriptionHeader && descriptionHeader !== '테마' && descriptionHeader !== '위도') {
      throw new Error('quiz 탭의 D열을 비운 뒤 다시 실행해 주세요. D열은 장소 설명 열로 사용합니다.');
    }
    sheet.insertColumnAfter(descriptionColumn - 1);
    sheet.getRange(1, descriptionColumn).setValue('설명');
  }

  const themeColumn = GEO_QUEST_HEADERS.indexOf('테마') + 1;
  const themeHeader = sheet.getRange(1, themeColumn).getDisplayValue().trim();
  if (themeHeader !== '테마') {
    if (themeHeader && themeHeader !== '위도') {
      throw new Error('quiz 탭의 E열을 비운 뒤 다시 실행해 주세요. E열은 테마 열로 사용합니다.');
    }
    if (themeHeader === '위도') sheet.insertColumnAfter(themeColumn - 1);
    sheet.getRange(1, themeColumn).setValue('테마');
  }
  const addressColumn = GEO_QUEST_HEADERS.indexOf('주소') + 1;
  const currentValue = sheet.getRange(1, addressColumn).getDisplayValue().trim();
  if (currentValue && currentValue !== '주소') throw new Error('quiz 탭의 Q1 셀을 비운 뒤 다시 실행해 주세요. Q열은 주소 열로 사용합니다.');
  if (!currentValue) sheet.getRange(1, addressColumn).setValue('주소');
}

function repairQuizPlaceMetadata() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const quizSheet = spreadsheet.getSheetByName(GEO_QUEST_SHEET_NAME);
  const catalogSheet = spreadsheet.getSheetByName(TOUR_PLACE_CATALOG_SHEET_NAME);
  if (!quizSheet) throw new Error('quiz 탭을 찾을 수 없습니다.');
  if (!catalogSheet || catalogSheet.getLastRow() < 2) throw new Error('db 탭을 먼저 만들어 주세요.');
  ensureQuizAddressHeader_(quizSheet);
  const repairedCount = repairQuizRegionIds_(quizSheet, catalogSheet);
  SpreadsheetApp.getUi().alert(`퀴즈 ${repairedCount}개의 주소·지역 정보를 확인했습니다.`);
}

function compactQuizRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    applyQuizDataValidations_(sheet, 2, Math.max(1, sheet.getMaxRows() - 1));
    return 0;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, GEO_QUEST_HEADERS.length).getValues();
  const quizRows = values.filter(row => row.slice(0, GEO_QUEST_HEADERS.indexOf('활성')).some(value => value !== '' && value !== null));
  sheet.getRange(2, 1, lastRow - 1, GEO_QUEST_HEADERS.length).clearContent();
  if (quizRows.length) {
    ensureSheetRows_(sheet, quizRows.length + 1);
    sheet.getRange(2, 1, quizRows.length, GEO_QUEST_HEADERS.length).setValues(quizRows);
    sheet.getRange(2, 6, quizRows.length, 2).setNumberFormat('0.000000');
  }
  applyQuizDataValidations_(sheet, 2, Math.max(1, sheet.getMaxRows() - 1));
  return quizRows.length;
}

function applyQuizDataValidations_(sheet, startRow, rowCount) {
  const answerRule = SpreadsheetApp.newDataValidation()
    .requireNumberBetween(1, 4)
    .setAllowInvalid(false)
    .setHelpText('정답 보기 번호 1~4 중 하나를 입력하세요.')
    .build();
  const checkboxRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .setAllowInvalid(false)
    .build();
  sheet.getRange(startRow, 14, rowCount, 1).setDataValidation(answerRule);
  sheet.getRange(startRow, 16, rowCount, 1).setDataValidation(checkboxRule);
}

function repairQuizRegionIds_(quizSheet, catalogSheet) {
  if (!catalogSheet || catalogSheet.getLastRow() < 2 || quizSheet.getLastRow() < 2) return 0;
  ensureQuizAddressHeader_(quizSheet);
  const catalogRows = catalogSheet.getRange(2, 1, catalogSheet.getLastRow() - 1, 7).getValues();
  const addressByContentId = new Map(catalogRows.map(row => [String(row[6] || '').trim(), String(row[3] || '').trim()]));
  const rowCount = quizSheet.getLastRow() - 1;
  const quizRows = quizSheet.getRange(2, 1, rowCount, GEO_QUEST_HEADERS.length).getValues();
  let correctedCount = 0;
  quizRows.forEach(row => {
    const match = String(row[0] || '').match(/^tour-(\d+)/);
    if (!match) return;
    const address = addressByContentId.get(match[1]);
    if (!address) return;
    const expectedRegionId = inferRegionId_(address);
    let changed = false;
    if (expectedRegionId && String(row[1] || '') !== expectedRegionId) {
      row[1] = expectedRegionId;
      changed = true;
    }
    if (String(row[16] || '') !== address) {
      row[16] = address;
      changed = true;
    }
    if (changed) correctedCount += 1;
  });
  if (correctedCount) {
    quizSheet.getRange(2, 2, rowCount, 1).setValues(quizRows.map(row => [row[1]]));
    quizSheet.getRange(2, 17, rowCount, 1).setValues(quizRows.map(row => [row[16]]));
  }
  return correctedCount;
}

function searchTourPlace_(keyword) {
  const responseData = fetchTourApi_('searchKeyword2', {
    keyword: keyword,
    arrange: 'A',
    numOfRows: 30,
    pageNo: 1
  });
  const candidates = responseData.items.map(item => ({
    contentId: String(item.contentid || ''),
    contentTypeId: String(item.contenttypeid || ''),
    title: String(item.title || '').trim(),
    address: [item.addr1, item.addr2].filter(Boolean).join(' ').trim(),
    latitude: Number(item.mapy),
    longitude: Number(item.mapx)
  })).filter(item => (
    EDUCATIONAL_CONTENT_TYPES.has(item.contentTypeId) &&
    item.contentId &&
    item.title &&
    Number.isFinite(item.latitude) &&
    Number.isFinite(item.longitude)
  ));

  const normalizedKeyword = normalizePlaceName_(keyword);
  const exact = candidates.find(item => normalizePlaceName_(item.title) === normalizedKeyword);
  if (exact) return exact;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new Error('관광지·문화시설·쇼핑·음식점 검색 결과가 없습니다.');
  throw new Error(`정확한 장소명을 입력해 주세요. 후보: ${candidates.slice(0, 5).map(item => item.title).join(', ')}`);
}

function inferRegionId_(address) {
  const parts = String(address || '').trim().split(/\s+/).filter(Boolean);
  const province = parts[0] || '';
  const municipality = parts[1] || '';
  if (METROPOLITAN_REGION_NAMES.has(province)) return province;
  if (province === '강원특별자치도' && municipality === '고성군') return '고성군(강원)';
  if (province === '경상남도' && municipality === '고성군') return '고성군(경남)';
  if (/[시군]$/.test(municipality)) return municipality;
  const metropolitanKeyword = Object.keys(METROPOLITAN_REGION_KEYWORDS).find(keyword => province.includes(keyword));
  if (metropolitanKeyword) return METROPOLITAN_REGION_KEYWORDS[metropolitanKeyword];
  return municipality || province;
}

function normalizePlaceName_(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '').trim();
}

function fetchTourApi_(path, parameters) {
  const storedKey = PropertiesService.getScriptProperties().getProperty('TOUR_API_KEY');
  if (!storedKey) throw new Error('스크립트 속성 TOUR_API_KEY를 설정해 주세요.');

  let decodedKey = storedKey.trim();
  try {
    decodedKey = decodeURIComponent(decodedKey);
  } catch (error) {
    // 이미 디코딩된 키이거나 퍼센트 문자가 포함된 키는 원문을 사용합니다.
  }

  const query = Object.assign({
    serviceKey: decodedKey,
    MobileOS: 'ETC',
    MobileApp: 'GeoQuest',
    _type: 'json'
  }, parameters || {});
  const queryString = Object.keys(query)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join('&');
  const response = UrlFetchApp.fetch(`${TOUR_API_BASE_URL}/${path}?${queryString}`, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true
  });
  if (response.getResponseCode() !== 200) throw new Error('TourAPI 서버가 응답하지 않습니다.');

  let data;
  try {
    data = JSON.parse(response.getContentText('UTF-8'));
  } catch (error) {
    throw new Error('TourAPI 응답 형식을 확인할 수 없습니다.');
  }
  const envelope = data && data.response ? data.response : {};
  const header = envelope.header || {};
  if (!['0000', '0'].includes(String(header.resultCode || ''))) {
    throw new Error(`TourAPI 오류: ${String(header.resultMsg || '요청 정보를 확인해 주세요.')}`);
  }
  const body = envelope.body || {};
  const rawItems = body.items && body.items.item ? body.items.item : [];
  return {
    body: body,
    items: Array.isArray(rawItems) ? rawItems : [rawItems]
  };
}

function tourApiOutput_(payload, callback) {
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const callbackName = String(callback || '');
  const validCallback = /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callbackName);
  return ContentService
    .createTextOutput(validCallback ? `${callbackName}(${json});` : json)
    .setMimeType(validCallback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function testTourApiConnection() {
  const result = fetchTourNearbyData_(37.5663, 126.9779, 1000, 3);
  SpreadsheetApp.getUi().alert(`TourAPI 연결 완료: 서울광장 주변 ${result.items.length}곳을 확인했습니다.`);
}

function setupQuizSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet.getId() !== GEO_QUEST_SHEET_ID) {
    throw new Error('연결된 발자국 퀴즈 시트에서 실행해 주세요.');
  }

  const sheet = spreadsheet.getSheetByName(GEO_QUEST_SHEET_NAME) || spreadsheet.getSheets()[0];
  ensureQuizAddressHeader_(sheet);
  const isEmpty = sheet.getLastRow() === 0 || sheet.getRange(1, 1).getDisplayValue() === '';
  if (isEmpty) {
    sheet.getRange(1, 1, 1, GEO_QUEST_HEADERS.length).setValues([GEO_QUEST_HEADERS]);
  } else {
    const current = sheet.getRange(1, 1, 1, GEO_QUEST_HEADERS.length).getDisplayValues()[0];
    if (current.join('|') !== GEO_QUEST_HEADERS.join('|')) {
      const proceed = SpreadsheetApp.getUi().alert(
        '기존 1행을 헤더로 바꿀까요?',
        '현재 1행의 값은 보존되지 않습니다.',
        SpreadsheetApp.getUi().ButtonSet.YES_NO
      );
      if (proceed !== SpreadsheetApp.getUi().Button.YES) return;
      sheet.getRange(1, 1, 1, GEO_QUEST_HEADERS.length).setValues([GEO_QUEST_HEADERS]);
    }
  }

  const header = sheet.getRange(1, 1, 1, GEO_QUEST_HEADERS.length);
  header
    .setBackground('#173f35')
    .setFontColor('#fffdf7')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 34);

  const widths = [110, 120, 150, 330, 120, 100, 100, 90, 330, 150, 150, 150, 150, 65, 330, 65, 360];
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));

  applyQuizDataValidations_(sheet, 2, Math.max(1, sheet.getMaxRows() - 1));

  if (sheet.getLastRow() === 1) {
    sheet.getRange(2, 1, 3, GEO_QUEST_HEADERS.length).setValues(sampleQuizRows_());
  }
  compactQuizRows_(sheet);

  sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), GEO_QUEST_HEADERS.length)
    .setVerticalAlignment('middle')
    .setWrap(true);
  const availableRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 6, availableRows, 2).setNumberFormat('0.000000');
  sheet.getRange(2, 8, availableRows, 1).setNumberFormat('0');
  sheet.getRange(1, 1).setNote('db 탭에서 선택한 장소를 추가하면 자동 생성됩니다.');
  sheet.getRange(1, 2).setNote('TourAPI 주소를 기준으로 자동 입력합니다.');
  sheet.getRange(1, 3).setNote('db 탭에서 선택한 장소가 자동 입력됩니다.');
  sheet.getRange(1, 4).setNote('장소를 클릭했을 때 학생에게 보여 줄 소개를 입력하세요.');
  sheet.getRange(1, 5).setNote('장소의 주제 또는 분류를 자유롭게 입력하세요.');
  sheet.getRange(1, 6, 1, 2).setNote('db 탭의 TourAPI 좌표가 자동 입력됩니다.');
  sheet.getRange(1, 8).setNote('퀴즈 활성 반경 150m가 자동 입력됩니다.');
  sheet.getRange(1, 14).setNote('보기1=1, 보기2=2, 보기3=3, 보기4=4');
  sheet.getRange(1, 17).setNote('db 탭의 TourAPI 주소가 자동 입력됩니다.');
  SpreadsheetApp.getUi().alert('발자국 quiz 탭 형식을 만들었습니다. 예시 행은 자유롭게 수정하거나 삭제하세요.');
}

function validateQuizSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GEO_QUEST_SHEET_NAME);
  if (!sheet) throw new Error('quiz 탭을 찾을 수 없습니다.');
  ensureQuizAddressHeader_(sheet);
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) {
    SpreadsheetApp.getUi().alert('검사할 퀴즈가 없습니다.');
    return;
  }

  const headers = values[0].map(value => value.trim());
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  const missing = GEO_QUEST_HEADERS.filter(header => index[header] === undefined);
  if (missing.length) {
    SpreadsheetApp.getUi().alert(`필수 헤더가 없습니다: ${missing.join(', ')}`);
    return;
  }

  const seenIds = new Set();
  const errors = [];
  values.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    if (row.slice(0, GEO_QUEST_HEADERS.indexOf('활성')).every(value => value === '')) return;
    const id = row[index['퀴즈ID']].trim();
    const region = row[index['지역ID']].trim();
    const latitude = Number(row[index['위도']]);
    const longitude = Number(row[index['경도']]);
    const radius = Number(row[index['반경m']]);
    const answer = Number(row[index['정답']]);
    if (!id) errors.push(`${line}행: 퀴즈ID가 비어 있습니다.`);
    else if (seenIds.has(id)) errors.push(`${line}행: 퀴즈ID '${id}'가 중복됩니다.`);
    else seenIds.add(id);
    if (!region) errors.push(`${line}행: 지역ID가 비어 있습니다.`);
    if (!Number.isFinite(latitude) || latitude < 32 || latitude > 39) errors.push(`${line}행: 위도를 확인하세요.`);
    if (!Number.isFinite(longitude) || longitude < 124 || longitude > 132) errors.push(`${line}행: 경도를 확인하세요.`);
    if (!Number.isFinite(radius) || radius <= 0) errors.push(`${line}행: 반경m은 1 이상의 숫자여야 합니다.`);
    if (![1, 2, 3, 4].includes(answer)) errors.push(`${line}행: 정답은 1~4 중 하나여야 합니다.`);
    if (!row[index['문제']].trim()) errors.push(`${line}행: 문제가 비어 있습니다.`);
    for (let choice = 1; choice <= 4; choice += 1) {
      if (!row[index[`보기${choice}`]].trim()) errors.push(`${line}행: 보기${choice}가 비어 있습니다.`);
    }
  });

  const message = errors.length
    ? `수정할 항목 ${errors.length}개\n\n${errors.slice(0, 30).join('\n')}${errors.length > 30 ? '\n…' : ''}`
    : `검사 완료: ${seenIds.size}개 퀴즈에 오류가 없습니다.`;
  SpreadsheetApp.getUi().alert(message);
}

function sampleQuizRows_() {
  return [
    ['seoul-001', '서울특별시', '서울광장', '', '', 37.5663, 126.9779, 150, '서울을 가로질러 서해로 흐르는 강은 무엇일까요?', '한강', '낙동강', '금강', '영산강', 1, '한강은 서울의 중심부를 동서로 가로질러 흐릅니다.', true, '서울특별시 중구 세종대로 110'],
    ['busan-001', '부산광역시', '부산시청', '', '', 35.1798, 129.0750, 150, '부산의 대표적인 우리나라 최대 무역항은?', '인천항', '부산항', '군산항', '목포항', 2, '부산항은 우리나라 최대 규모의 컨테이너 무역항입니다.', true, '부산광역시 연제구 중앙대로 1001'],
    ['jeju-001', '제주시', '제주시청', '', '', 33.4996, 126.5312, 150, '제주도 중앙에 있는 우리나라 최고봉은?', '지리산', '설악산', '한라산', '태백산', 3, '한라산은 해발 1,947m로 대한민국에서 가장 높은 산입니다.', true, '제주특별자치도 제주시 광양9길 10']
  ];
}
