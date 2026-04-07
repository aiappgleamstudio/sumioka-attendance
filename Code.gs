/**
 * ============================================================
 *
 * Google Apps Script Code.gs
 *
 *
 *   -
 *   -
 *   -  +
 *   - Phase2
 *
 *
 *   API_KEY        : : sumioka-happyland-2026
 *   SPREADSHEET_ID : ID
 *
 *   :
 *   : 2026-04-07
 * : 1.0.0
 * ============================================================
 */


// ============================================================
//
//
// ============================================================
const CONFIG = {
  //
  SHEET: {
    MASTER : "",
    STAMP  : "",
    LOG    : "",
  },

  // 0
  MASTER_COL: {
    NAME    : 0,  //
    ROLE    : 1,  //  or
    PIN     : 2,  // PIN4
    PASSWORD: 3,  //
    WEEKDAY : 4,  //
    LUNCH   : 5,  //  or
  },

  // 0
  STAMP_COL: {
    DATE   : 0,  // YYYY-MM-DD
    NAME   : 1,  //
    ROLE   : 2,  //
    TIME_IN : 3, //
    TIME_OUT: 4, //
    LUNCH  : 5,  //
    REPORT : 6,  //
  },

  // 0
  LOG_COL: {
    TIMESTAMP: 0, //
    ACTION   : 1, //
    NAME     : 2, //
    DETAIL   : 3, //
  },

  //
  ROLE: {
    STAFF: "",
    USER : "",
  },

  //
  STAMP_TYPE: {
    IN : "in",
    OUT: "out",
  },

  // JST
  TIMEZONE: "Asia/Tokyo",
  DATE_FORMAT: "yyyy-MM-dd",
  DATETIME_FORMAT: "yyyy-MM-dd HH:mm:ss",
};


// ============================================================
//
// GASWeb AppPOST
// ============================================================

/**
 * POST
 * action
 *
 * @param {Object} e - GAS
 * @returns {TextOutput} JSON
 */
function doPost(e) {
  // CORSdoGet
  try {
    // JSON
    // postData.contents
    if (!e || !e.postData || !e.postData.contents) {
      return createErrorResponse("");
    }

    const body = JSON.parse(e.postData.contents);

    // API
    if (!validateApiKey(body.apiKey)) {
      return createErrorResponse("API");
    }

    const action  = body.action;
    const payload = body.payload || {};

    // action
    // Phase2 "apply"
    switch (action) {
      case "login":
        return handleLogin(payload);

      case "stamp":
        return handleStamp(payload);

      //  Phase2
      // case "apply":
      //   return handleApply(payload);
      // case "getCalendar":
      //   return handleGetCalendar(payload);
      // case "approve":
      //   return handleApprove(payload);
      //

      default:
        return createErrorResponse(`: ${action}`);
    }

  } catch (err) {
    //
    Logger.log(`[doPost] : ${err.message}\n${err.stack}`);
    return createErrorResponse("");
  }
}

/**
 * GETCORS +
 * fetch
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "  " }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
//
// ============================================================

/**
 * API
 * API
 *
 * @param {string} apiKey - API
 * @returns {boolean} true
 */
function validateApiKey(apiKey) {
  const storedKey = PropertiesService.getScriptProperties().getProperty("API_KEY");

  //
  if (!storedKey) {
    Logger.log("[validateApiKey]  'API_KEY' ");
    return false;
  }

  return apiKey === storedKey;
}

/**
 *
 * PIN
 *
 * @param {Object} payload - { pin: string, password: string }
 * @returns {TextOutput} { success, name, role } or { success, message }
 */
function handleLogin(payload) {
  const { pin, password } = payload;

  //
  if (!pin || !password) {
    return createErrorResponse("PIN");
  }

  try {
    const sheet = getSheet(CONFIG.SHEET.MASTER);
    const data  = sheet.getDataRange().getValues();

    // 1index 1
    for (let i = 1; i < data.length; i++) {
      const row      = data[i];
      const rowPin   = String(row[CONFIG.MASTER_COL.PIN]).trim();
      const rowPass  = String(row[CONFIG.MASTER_COL.PASSWORD]).trim();

      // PIN
      //
      if (rowPin === String(pin).trim() && rowPass === String(password).trim()) {
        const name = String(row[CONFIG.MASTER_COL.NAME]).trim();
        const role = String(row[CONFIG.MASTER_COL.ROLE]).trim();

        writeLog("login", name, ` [: ${role}]`);
        Logger.log(`[handleLogin] : ${name} (${role})`);

        return createSuccessResponse({ name, role });
      }
    }

    //
    // PIN
    Logger.log(`[handleLogin] : pin=${pin}`);
    return createErrorResponse("PIN");

  } catch (err) {
    Logger.log(`[handleLogin] : ${err.message}`);
    return createErrorResponse("");
  }
}


// ============================================================
//
// ============================================================

/**
 *
 * typein/out
 *
 * @param {Object} payload -
 * @returns {TextOutput}
 */
function handleStamp(payload) {
  const { type } = payload;

  if (!type) {
    return createErrorResponse("type");
  }

  switch (type) {
    case CONFIG.STAMP_TYPE.IN:
      return handleStampIn(payload);

    case CONFIG.STAMP_TYPE.OUT:
      return handleStampOut(payload);

    default:
      return createErrorResponse(`: ${type}`);
  }
}

/**
 *
 *
 *
 * @param {Object} payload - { type, name, role, lunch }
 * @returns {TextOutput}
 */
function handleStampIn(payload) {
  const { name, role, lunch } = payload;

  //
  if (!name || !role || !lunch) {
    return createErrorResponse("");
  }

  //
  if (lunch !== "" && lunch !== "") {
    return createErrorResponse("");
  }

  try {
    const sheet   = getSheet(CONFIG.SHEET.STAMP);
    const today   = getTodayString();
    const nowTime = getNowDatetime();

    //
    const existing = findStampRecord(sheet, today, name);
    if (existing !== null) {
      return createErrorResponse("");
    }

    //
    //
    const newRow = Array(Object.keys(CONFIG.STAMP_COL).length).fill("");
    newRow[CONFIG.STAMP_COL.DATE]    = today;
    newRow[CONFIG.STAMP_COL.NAME]    = name;
    newRow[CONFIG.STAMP_COL.ROLE]    = role;
    newRow[CONFIG.STAMP_COL.TIME_IN] = nowTime;
    newRow[CONFIG.STAMP_COL.LUNCH]   = lunch;
    // TIME_OUT  REPORT

    sheet.appendRow(newRow);

    writeLog("stamp_in", name, ` [: ${lunch}]`);
    Logger.log(`[handleStampIn] : ${name} / ${today} / ${nowTime}`);

    return createSuccessResponse({ stampTime: nowTime });

  } catch (err) {
    Logger.log(`[handleStampIn] : ${err.message}`);
    return createErrorResponse("");
  }
}

/**
 *
 *
 *
 *
 * @param {Object} payload - { type, name, role, report }
 * @returns {TextOutput}
 */
function handleStampOut(payload) {
  const { name, role, report } = payload;

  //
  if (!name || !role) {
    return createErrorResponse("");
  }

  //
  if (!report || String(report).trim() === "") {
    return createErrorResponse("");
  }

  try {
    const sheet   = getSheet(CONFIG.SHEET.STAMP);
    const today   = getTodayString();
    const nowTime = getNowDatetime();

    //
    const rowIndex = findStampRecord(sheet, today, name);

    //
    if (rowIndex === null) {
      return createErrorResponse("");
    }

    //
    // getValues()rowIndex
    const allData = sheet.getDataRange().getValues();
    const existingOut = allData[rowIndex][CONFIG.STAMP_COL.TIME_OUT];
    if (existingOut && String(existingOut).trim() !== "") {
      return createErrorResponse("");
    }

    //
    // getDataRange()0setValue1 +1
    const sheetRow = rowIndex + 1;
    sheet.getRange(sheetRow, CONFIG.STAMP_COL.TIME_OUT + 1).setValue(nowTime);
    sheet.getRange(sheetRow, CONFIG.STAMP_COL.REPORT + 1).setValue(String(report).trim());

    writeLog("stamp_out", name, ` [: ${String(report).trim().slice(0, 30)}...]`);
    Logger.log(`[handleStampOut] : ${name} / ${today} / ${nowTime}`);

    return createSuccessResponse({ stampTime: nowTime });

  } catch (err) {
    Logger.log(`[handleStampOut] : ${err.message}`);
    return createErrorResponse("");
  }
}


// ============================================================
//
// ============================================================

/**
 *
 *
 *
 * @param {string} sheetName -
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(sheetName) {
  const ssId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");

  //
  if (!ssId) {
    throw new Error(" 'SPREADSHEET_ID' ");
  }

  const ss    = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(`${sheetName}`);
  }

  return sheet;
}

/**
 *
 * getDataRange()0
 * null
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet -
 * @param {string} targetDate - YYYY-MM-DD
 * @param {string} targetName -
 * @returns {number|null} 0null
 */
function findStampRecord(sheet, targetDate, targetName) {
  const data = sheet.getDataRange().getValues();

  // 1
  for (let i = 1; i < data.length; i++) {
    const row     = data[i];
    const rawDate = row[CONFIG.STAMP_COL.DATE];
    const rowName = String(row[CONFIG.STAMP_COL.NAME]).trim();

    //
    // instanceof Date  false  "Tue Apr 07 2026..."
    // Date-like
    // new Date()  formatDate  YYYY-MM-DD
    // Invalid Date
    let rowDate;
    try {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        rowDate = Utilities.formatDate(d, CONFIG.TIMEZONE, CONFIG.DATE_FORMAT);
      } else {
        rowDate = String(rawDate).trim();
      }
    } catch (e) {
      rowDate = String(rawDate).trim();
    }

    if (rowDate === targetDate && rowName === targetName) {
      return i; //
    }
  }

  return null; //
}

/**
 * YYYY-MM-DDJST
 * GASJST
 *
 * @returns {string} YYYY-MM-DD
 */
function getTodayString() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, CONFIG.DATE_FORMAT);
}

/**
 * YYYY-MM-DD HH:mm:ssJST
 *
 * @returns {string} YYYY-MM-DD HH:mm:ss
 */
function getNowDatetime() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, CONFIG.DATETIME_FORMAT);
}

/**
 *
 *
 *
 *
 * @param {string} action  - : "login", "stamp_in"
 * @param {string} name    -
 * @param {string} detail  -
 */
function writeLog(action, name, detail) {
  try {
    const sheet = getSheet(CONFIG.SHEET.LOG);
    const logRow = Array(Object.keys(CONFIG.LOG_COL).length).fill("");
    logRow[CONFIG.LOG_COL.TIMESTAMP] = getNowDatetime();
    logRow[CONFIG.LOG_COL.ACTION]    = action;
    logRow[CONFIG.LOG_COL.NAME]      = name;
    logRow[CONFIG.LOG_COL.DETAIL]    = detail;
    sheet.appendRow(logRow);
  } catch (err) {
    //
    Logger.log(`[writeLog] : ${err.message}`);
  }
}


// ============================================================
//
// ============================================================

/**
 *
 *  success: true  data
 *
 * @param {Object} data -
 * @returns {TextOutput}
 */
function createSuccessResponse(data) {
  const response = Object.assign({ success: true }, data);
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 *
 * successfalsemessage
 *
 * @param {string} message -
 * @returns {TextOutput}
 */
function createErrorResponse(message) {
  const response = { success: false, message };
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// Phase2
//
// ============================================================

/**
 * [Phase2]
 * @param {Object} payload -
 */
// function handleApply(payload) {
//   // TODO: Phase2
// }

/**
 * [Phase2]
 * @param {Object} payload - { name, year, month }
 */
// function handleGetCalendar(payload) {
//   // TODO: Phase2
// }

/**
 * [Phase2]
 * @param {Object} payload - { applicationId, status }
 */
// function handleApprove(payload) {
//   // TODO: Phase2
// }
