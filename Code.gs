/**
 * ============================================================
 * 株式会社住岡 はっぴーらんど 勤怠管理システム
 * Google Apps Script バックエンド（Code.gs）
 *
 * 設計方針：
 *   - 可読性・保守性・拡張性を最優先
 *   - 各処理に「なぜそうするか」のコメントを付与
 *   - エラーは必ずキャッチし、ユーザー向け日本語 + 開発者向けログを出力
 *   - Phase2（申請・カレンダー・ToDo・管理）対応済み
 *
 * スクリプトプロパティ設定（必須）：
 *   API_KEY        : 任意の英数字文字列
 *   SPREADSHEET_ID : 対象スプレッドシートのID
 *
 * 作成者  : 田中沙亜
 * 作成日  : 2026-04-07
 * バージョン: 2.0.0（Phase2対応）
 * ============================================================
 */


// ============================================================
// 定数定義
// マジックナンバー・マジックストリングを排除し、変更箇所を一元管理
// ============================================================
const CONFIG = {
  SHEET: {
    MASTER      : "マスタ",
    STAMP       : "日次打刻",
    LOG         : "操作ログ",
    APPLICATION : "申請管理",
    OVER_UNDER  : "過不足・補填管理",
    TODO        : "ToDoリスト",
  },

  // マスタシートの列インデックス（0始まり）
  MASTER_COL: {
    NAME    : 0,
    ROLE    : 1,
    PIN     : 2,
    PASSWORD: 3,
    WEEKDAY : 4,
    LUNCH   : 5,
  },

  // 打刻シートの列インデックス（0始まり）
  STAMP_COL: {
    DATE    : 0,
    NAME    : 1,
    ROLE    : 2,
    TIME_IN : 3,
    TIME_OUT: 4,
    LUNCH   : 5,
    REPORT  : 6,
  },

  // 操作ログシートの列インデックス（0始まり）
  LOG_COL: {
    TIMESTAMP: 0,
    ACTION   : 1,
    NAME     : 2,
    DETAIL   : 3,
  },

  // 申請管理シートの列インデックス（0始まり）
  APPLICATION_COL: {
    ID         : 0,
    APPLIED_AT : 1,
    NAME       : 2,
    ROLE       : 3,
    TYPE       : 4,
    TARGET_DATE: 5,
    TIME       : 6,
    REASON     : 7,
    STATUS     : 8,
    APPROVED_BY: 9,
    APPROVED_AT: 10,
  },

  // 過不足・補填管理シートの列インデックス（0始まり）
  OVER_UNDER_COL: {
    NAME          : 0,
    YEAR_MONTH    : 1,
    SCHEDULED_MIN : 2,
    ACTUAL_MIN    : 3,
    SHORTAGE_MIN  : 4,
    SUPPLEMENT_MIN: 5,
    REMAINING_MIN : 6,
  },

  // ToDoリストシートの列インデックス（0始まり）
  TODO_COL: {
    ID        : 0,
    NAME      : 1,
    TYPE      : 2,
    CONTENT   : 3,
    DUE_DATE  : 4,
    DONE      : 5,
    CREATED_AT: 6,
    CREATED_BY: 7,
  },

  ROLE: {
    STAFF: "職員",
    USER : "利用者",
  },

  STAMP_TYPE: {
    IN : "in",
    OUT: "out",
  },

  APPLICATION_TYPE: {
    ABSENCE   : "休み",
    LATE      : "遅刻",
    EARLY     : "早退",
    SUPPLEMENT: "補填",
  },

  APPLICATION_STATUS: {
    PENDING : "審査中",
    APPROVED: "承認",
    REJECTED: "却下",
  },

  TODO_TYPE: {
    PERSONAL: "personal",
    NOTICE  : "notice",
  },

  TIMEZONE       : "Asia/Tokyo",
  DATE_FORMAT    : "yyyy-MM-dd",
  DATETIME_FORMAT: "yyyy-MM-dd HH:mm:ss",
};


// ============================================================
// エントリーポイント
// ============================================================

/**
 * POSTリクエストのエントリーポイント。
 * リクエストを解析し、actionに応じたハンドラへ振り分ける。
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createErrorResponse("リクエストが不正です。");
    }

    const body = JSON.parse(e.postData.contents);

    if (!validateApiKey(body.apiKey)) {
      return createErrorResponse("APIキーが不正です。");
    }

    const action  = body.action;
    const payload = body.payload || {};

    switch (action) {
      case "login"              : return handleLogin(payload);
      case "stamp"              : return handleStamp(payload);
      case "apply"              : return handleApply(payload);
      case "getApplications"    : return handleGetApplications(payload);
      case "getAllApplications"  : return handleGetAllApplications(payload);
      case "approve"            : return handleApprove(payload);
      case "getOverUnder"       : return handleGetOverUnder(payload);
      case "getTodo"            : return handleGetTodo(payload);
      case "saveTodo"           : return handleSaveTodo(payload);
      case "deleteTodo"         : return handleDeleteTodo(payload);
      case "getStampSummary"    : return handleGetStampSummary(payload);
      case "getAllStamps"        : return handleGetAllStamps(payload);
      default:
        return createErrorResponse("不明なアクション: " + action);
    }

  } catch (err) {
    Logger.log("[doPost] 予期しないエラー: " + err.message + "\n" + err.stack);
    return createErrorResponse("サーバーエラーが発生しました。管理者に連絡してください。");
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "株式会社住岡 勤怠管理システム 稼働中" }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// 認証処理
// ============================================================

function validateApiKey(apiKey) {
  const storedKey = PropertiesService.getScriptProperties().getProperty("API_KEY");
  if (!storedKey) {
    Logger.log("[validateApiKey] スクリプトプロパティ 'API_KEY' が設定されていません。");
    return false;
  }
  return apiKey === storedKey;
}

/**
 * ログイン処理。
 * マスタシートからPINとパスワードで完全一致検索を行う。
 */
function handleLogin(payload) {
  const { pin, password } = payload;
  if (!pin || !password) return createErrorResponse("PINとパスワードを入力してください。");

  try {
    const sheet = getSheet(CONFIG.SHEET.MASTER);
    const data  = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const row     = data[i];
      const rowPin  = String(row[CONFIG.MASTER_COL.PIN]).trim();
      const rowPass = String(row[CONFIG.MASTER_COL.PASSWORD]).trim();

      if (rowPin === String(pin).trim() && rowPass === String(password).trim()) {
        const name = String(row[CONFIG.MASTER_COL.NAME]).trim();
        const role = String(row[CONFIG.MASTER_COL.ROLE]).trim();
        writeLog("login", name, "ログイン成功 [区分: " + role + "]");
        return createSuccessResponse({ name, role });
      }
    }

    Logger.log("[handleLogin] 認証失敗: pin=" + pin);
    return createErrorResponse("PINまたはパスワードが正しくありません。");

  } catch (err) {
    Logger.log("[handleLogin] エラー: " + err.message);
    return createErrorResponse("ログイン処理中にエラーが発生しました。");
  }
}


// ============================================================
// 打刻処理（Phase1）
// ============================================================

function handleStamp(payload) {
  const { type } = payload;
  if (!type) return createErrorResponse("打刻種別（type）が指定されていません。");
  switch (type) {
    case CONFIG.STAMP_TYPE.IN : return handleStampIn(payload);
    case CONFIG.STAMP_TYPE.OUT: return handleStampOut(payload);
    default: return createErrorResponse("不明な打刻種別: " + type);
  }
}

/**
 * 出勤打刻処理。
 * 同日に既に出勤レコードがある場合はエラーを返す（二重打刻防止）。
 */
function handleStampIn(payload) {
  const { name, role, lunch } = payload;
  if (!name || !role || !lunch) return createErrorResponse("氏名・区分・弁当要否は必須です。");
  if (lunch !== "要" && lunch !== "不要") return createErrorResponse("弁当要否は「要」または「不要」で指定してください。");

  try {
    const sheet   = getSheet(CONFIG.SHEET.STAMP);
    const today   = getTodayString();
    const nowTime = getNowDatetime();

    if (findStampRecord(sheet, today, name) !== null) {
      return createErrorResponse("本日は既に出勤打刻済みです。");
    }

    const newRow = Array(Object.keys(CONFIG.STAMP_COL).length).fill("");
    newRow[CONFIG.STAMP_COL.DATE]    = today;
    newRow[CONFIG.STAMP_COL.NAME]    = name;
    newRow[CONFIG.STAMP_COL.ROLE]    = role;
    newRow[CONFIG.STAMP_COL.TIME_IN] = nowTime;
    newRow[CONFIG.STAMP_COL.LUNCH]   = lunch;
    sheet.appendRow(newRow);

    writeLog("stamp_in", name, "出勤打刻 [弁当: " + lunch + "]");
    return createSuccessResponse({ stampTime: nowTime });

  } catch (err) {
    Logger.log("[handleStampIn] エラー: " + err.message);
    return createErrorResponse("出勤打刻処理中にエラーが発生しました。");
  }
}

/**
 * 退勤打刻処理。
 * 同日の出勤レコードを検索し、退勤時刻と業務内容を書き込む。
 */
function handleStampOut(payload) {
  const { name, role, report } = payload;
  if (!name || !role) return createErrorResponse("氏名・区分は必須です。");
  if (!report || String(report).trim() === "") return createErrorResponse("業務内容を入力してから退勤してください。");

  try {
    const sheet    = getSheet(CONFIG.SHEET.STAMP);
    const today    = getTodayString();
    const nowTime  = getNowDatetime();
    const rowIndex = findStampRecord(sheet, today, name);

    if (rowIndex === null) return createErrorResponse("本日の出勤打刻が見つかりません。先に出勤打刻をしてください。");

    const allData    = sheet.getDataRange().getValues();
    const existingOut = allData[rowIndex][CONFIG.STAMP_COL.TIME_OUT];
    if (existingOut && String(existingOut).trim() !== "") {
      return createErrorResponse("本日は既に退勤打刻済みです。修正が必要な場合は管理者に連絡してください。");
    }

    const sheetRow = rowIndex + 1;
    sheet.getRange(sheetRow, CONFIG.STAMP_COL.TIME_OUT + 1).setValue(nowTime);
    sheet.getRange(sheetRow, CONFIG.STAMP_COL.REPORT + 1).setValue(String(report).trim());

    writeLog("stamp_out", name, "退勤打刻 [業務: " + String(report).trim().slice(0, 30) + "...]");
    return createSuccessResponse({ stampTime: nowTime });

  } catch (err) {
    Logger.log("[handleStampOut] エラー: " + err.message);
    return createErrorResponse("退勤打刻処理中にエラーが発生しました。");
  }
}


// ============================================================
// 申請処理（Phase2）
// ============================================================

/**
 * 申請送信処理。
 * 休み・遅刻・早退・補填の申請をシートに記録する。
 */
function handleApply(payload) {
  const { name, role, type, targetDate, time, reason } = payload;

  if (!name || !role || !type || !targetDate) {
    return createErrorResponse("氏名・区分・種別・対象日は必須です。");
  }

  const validTypes = Object.values(CONFIG.APPLICATION_TYPE);
  if (!validTypes.includes(type)) {
    return createErrorResponse("申請種別が正しくありません。");
  }

  try {
    const sheet     = getSheet(CONFIG.SHEET.APPLICATION);
    const nowTime   = getNowDatetime();
    // IDはタイムスタンプベースで生成（重複しにくい）
    const id        = "APP-" + new Date().getTime();

    const newRow = Array(Object.keys(CONFIG.APPLICATION_COL).length).fill("");
    newRow[CONFIG.APPLICATION_COL.ID]          = id;
    newRow[CONFIG.APPLICATION_COL.APPLIED_AT]  = nowTime;
    newRow[CONFIG.APPLICATION_COL.NAME]        = name;
    newRow[CONFIG.APPLICATION_COL.ROLE]        = role;
    newRow[CONFIG.APPLICATION_COL.TYPE]        = type;
    newRow[CONFIG.APPLICATION_COL.TARGET_DATE] = targetDate;
    newRow[CONFIG.APPLICATION_COL.TIME]        = time || "";
    newRow[CONFIG.APPLICATION_COL.REASON]      = reason || "";
    newRow[CONFIG.APPLICATION_COL.STATUS]      = CONFIG.APPLICATION_STATUS.PENDING;
    newRow[CONFIG.APPLICATION_COL.APPROVED_BY] = "";
    newRow[CONFIG.APPLICATION_COL.APPROVED_AT] = "";
    sheet.appendRow(newRow);

    writeLog("apply", name, "申請送信 [種別: " + type + ", 対象日: " + targetDate + "]");
    return createSuccessResponse({ id, appliedAt: nowTime });

  } catch (err) {
    Logger.log("[handleApply] エラー: " + err.message);
    return createErrorResponse("申請処理中にエラーが発生しました。");
  }
}

/**
 * 自分の申請一覧を取得する。
 * 新しい順で返す。
 */
function handleGetApplications(payload) {
  const { name } = payload;
  if (!name) return createErrorResponse("氏名は必須です。");

  try {
    const sheet = getSheet(CONFIG.SHEET.APPLICATION);
    const data  = sheet.getDataRange().getValues();
    const col   = CONFIG.APPLICATION_COL;

    const result = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[col.NAME]).trim() !== name) continue;

      result.push({
        id        : String(row[col.ID]),
        appliedAt : String(row[col.APPLIED_AT]),
        type      : String(row[col.TYPE]),
        targetDate: String(row[col.TARGET_DATE]),
        time      : String(row[col.TIME]),
        reason    : String(row[col.REASON]),
        status    : String(row[col.STATUS]),
        approvedBy: String(row[col.APPROVED_BY]),
        approvedAt: String(row[col.APPROVED_AT]),
      });
    }

    // 新しい順に並べ替え
    result.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
    return createSuccessResponse({ applications: result });

  } catch (err) {
    Logger.log("[handleGetApplications] エラー: " + err.message);
    return createErrorResponse("申請一覧の取得中にエラーが発生しました。");
  }
}

/**
 * 全員の申請一覧を取得する（管理者用）。
 * 審査中のものを先頭にして返す。
 */
function handleGetAllApplications(payload) {
  try {
    const sheet = getSheet(CONFIG.SHEET.APPLICATION);
    const data  = sheet.getDataRange().getValues();
    const col   = CONFIG.APPLICATION_COL;

    const result = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[col.ID]) continue; // 空行スキップ

      result.push({
        id        : String(row[col.ID]),
        appliedAt : String(row[col.APPLIED_AT]),
        name      : String(row[col.NAME]),
        role      : String(row[col.ROLE]),
        type      : String(row[col.TYPE]),
        targetDate: String(row[col.TARGET_DATE]),
        time      : String(row[col.TIME]),
        reason    : String(row[col.REASON]),
        status    : String(row[col.STATUS]),
        approvedBy: String(row[col.APPROVED_BY]),
        approvedAt: String(row[col.APPROVED_AT]),
      });
    }

    // 審査中を先頭、その後は新しい順
    result.sort((a, b) => {
      if (a.status === CONFIG.APPLICATION_STATUS.PENDING && b.status !== CONFIG.APPLICATION_STATUS.PENDING) return -1;
      if (a.status !== CONFIG.APPLICATION_STATUS.PENDING && b.status === CONFIG.APPLICATION_