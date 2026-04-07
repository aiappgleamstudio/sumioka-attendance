/**
 * ============================================================
 * 住岡福祉会 はっぴーらんど 勤怠管理システム
 * Google Apps Script バックエンド（Code.gs）
 *
 * 設計方針：
 *   - 可読性・保守性・拡張性を最優先
 *   - 各処理に「なぜそうするか」のコメントを付与
 *   - エラーは必ずキャッチし、ユーザー向け日本語 + 開発者向けログを出力
 *   - Phase2（申請・カレンダー等）を見据えたアクション分岐構造
 *
 * 【スクリプトプロパティ設定（必須）】
 *   API_KEY        : 任意の英数字文字列（例: sumioka-happyland-2026）
 *   SPREADSHEET_ID : 対象スプレッドシートのID
 *
 * 作成者  : 田中沙亜
 * 作成日  : 2026-04-07
 * バージョン: 1.0.0
 * ============================================================
 */


// ============================================================
// 定数定義
// マジックナンバー・マジックストリングを排除し、変更箇所を一元管理
// ============================================================
const CONFIG = {
  // シート名（スプレッドシート上のタブ名と完全一致させること）
  SHEET: {
    MASTER : "マスタ",
    STAMP  : "日次打刻",
    LOG    : "操作ログ",
  },

  // マスタシートの列インデックス（0始まり）
  MASTER_COL: {
    NAME    : 0,  // 氏名
    ROLE    : 1,  // 区分（職員 or 利用者）
    PIN     : 2,  // PIN（4桁）
    PASSWORD: 3,  // パスワード
    WEEKDAY : 4,  // 利用曜日（将来用）
    LUNCH   : 5,  // 弁当デフォルト（要 or 不要）
  },

  // 打刻シートの列インデックス（0始まり）
  STAMP_COL: {
    DATE   : 0,  // 日付（YYYY-MM-DD）
    NAME   : 1,  // 氏名
    ROLE   : 2,  // 区分
    TIME_IN : 3, // 出勤時刻
    TIME_OUT: 4, // 退勤時刻
    LUNCH  : 5,  // 弁当要否
    REPORT : 6,  // 業務内容
  },

  // 操作ログシートの列インデックス（0始まり）
  LOG_COL: {
    TIMESTAMP: 0, // 記録日時
    ACTION   : 1, // アクション種別
    NAME     : 2, // 操作者氏名
    DETAIL   : 3, // 詳細
  },

  // 区分の許容値
  ROLE: {
    STAFF: "職員",
    USER : "利用者",
  },

  // 打刻種別
  STAMP_TYPE: {
    IN : "in",
    OUT: "out",
  },

  // タイムゾーン（JSTで統一）
  TIMEZONE: "Asia/Tokyo",
  DATE_FORMAT: "yyyy-MM-dd",
  DATETIME_FORMAT: "yyyy-MM-dd HH:mm:ss",
};


// ============================================================
// エントリーポイント
// GASのWeb Appとして公開されたとき、POSTリクエストを受け付ける
// ============================================================

/**
 * POSTリクエストのエントリーポイント。
 * リクエストを解析し、actionに応じたハンドラへ振り分ける。
 *
 * @param {Object} e - GASが受け取るイベントオブジェクト
 * @returns {TextOutput} JSON形式のレスポンス
 */
function doPost(e) {
  // CORSプリフライト対応のためにdoGetも定義（後述）
  try {
    // リクエストボディをJSONとしてパース
    // postData.contentsが空の場合はエラーを返す
    if (!e || !e.postData || !e.postData.contents) {
      return createErrorResponse("リクエストが不正です。");
    }

    const body = JSON.parse(e.postData.contents);

    // APIキー検証（最初に行うことで不正アクセスを早期遮断）
    if (!validateApiKey(body.apiKey)) {
      return createErrorResponse("APIキーが不正です。");
    }

    const action  = body.action;
    const payload = body.payload || {};

    // actionに応じて処理を振り分ける
    // 将来のPhase2で "apply"（申請）などを追加しやすい構造にしている
    switch (action) {
      case "login":
        return handleLogin(payload);

      case "stamp":
        return handleStamp(payload);

      // ── Phase2 予約アクション（未実装） ──────────────────
      // case "apply":
      //   return handleApply(payload);
      // case "getCalendar":
      //   return handleGetCalendar(payload);
      // case "approve":
      //   return handleApprove(payload);
      // ────────────────────────────────────────────────────

      default:
        return createErrorResponse(`不明なアクション: ${action}`);
    }

  } catch (err) {
    // 予期しないエラーをキャッチ。開発者向けにスタックトレースも記録
    Logger.log(`[doPost] 予期しないエラー: ${err.message}\n${err.stack}`);
    return createErrorResponse("サーバーエラーが発生しました。管理者に連絡してください。");
  }
}

/**
 * GETリクエストへの応答（CORS対応 + 死活確認用）。
 * フロントエンドのfetchがプリフライトを送る場合に備えて定義する。
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "住岡 勤怠管理システム 稼働中" }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// 認証処理
// ============================================================

/**
 * APIキーをスクリプトプロパティと照合する。
 * コードにAPIキーをハードコードしないことでセキュリティを確保する。
 *
 * @param {string} apiKey - リクエストに含まれるAPIキー
 * @returns {boolean} 一致すればtrue
 */
function validateApiKey(apiKey) {
  const storedKey = PropertiesService.getScriptProperties().getProperty("API_KEY");

  // スクリプトプロパティが未設定の場合は開発者向けにログを出して拒否
  if (!storedKey) {
    Logger.log("[validateApiKey] スクリプトプロパティ 'API_KEY' が設定されていません。");
    return false;
  }

  return apiKey === storedKey;
}

/**
 * ログイン処理。
 * マスタシートからPINとパスワードで完全一致検索を行う。
 *
 * @param {Object} payload - { pin: string, password: string }
 * @returns {TextOutput} { success, name, role } or { success, message }
 */
function handleLogin(payload) {
  const { pin, password } = payload;

  // 必須パラメータチェック
  if (!pin || !password) {
    return createErrorResponse("PINとパスワードを入力してください。");
  }

  try {
    const sheet = getSheet(CONFIG.SHEET.MASTER);
    const data  = sheet.getDataRange().getValues();

    // 1行目はヘッダーなのでスキップ（index 1から開始）
    for (let i = 1; i < data.length; i++) {
      const row      = data[i];
      const rowPin   = String(row[CONFIG.MASTER_COL.PIN]).trim();
      const rowPass  = String(row[CONFIG.MASTER_COL.PASSWORD]).trim();

      // PINとパスワードの完全一致で認証
      // 将来的にハッシュ化する場合はここを修正する
      if (rowPin === String(pin).trim() && rowPass === String(password).trim()) {
        const name = String(row[CONFIG.MASTER_COL.NAME]).trim();
        const role = String(row[CONFIG.MASTER_COL.ROLE]).trim();

        writeLog("login", name, `ログイン成功 [区分: ${role}]`);
        Logger.log(`[handleLogin] ログイン成功: ${name} (${role})`);

        return createSuccessResponse({ name, role });
      }
    }

    // 一致するレコードがなかった場合
    // セキュリティ上、PINが間違いかパスワードが間違いかを区別しない
    Logger.log(`[handleLogin] 認証失敗: pin=${pin}`);
    return createErrorResponse("PINまたはパスワードが正しくありません。");

  } catch (err) {
    Logger.log(`[handleLogin] エラー: ${err.message}`);
    return createErrorResponse("ログイン処理中にエラーが発生しました。");
  }
}


// ============================================================
// 打刻処理
// ============================================================

/**
 * 打刻処理のディスパッチャ。
 * type（in/out）に応じて出勤・退勤処理を呼び分ける。
 *
 * @param {Object} payload - 打刻情報
 * @returns {TextOutput} 処理結果
 */
function handleStamp(payload) {
  const { type } = payload;

  if (!type) {
    return createErrorResponse("打刻種別（type）が指定されていません。");
  }

  switch (type) {
    case CONFIG.STAMP_TYPE.IN:
      return handleStampIn(payload);

    case CONFIG.STAMP_TYPE.OUT:
      return handleStampOut(payload);

    default:
      return createErrorResponse(`不明な打刻種別: ${type}`);
  }
}

/**
 * 出勤打刻処理。
 * 同日に既に出勤レコードがある場合はエラーを返す（二重打刻防止）。
 *
 * @param {Object} payload - { type, name, role, lunch }
 * @returns {TextOutput} 処理結果
 */
function handleStampIn(payload) {
  const { name, role, lunch } = payload;

  // 必須パラメータチェック
  if (!name || !role || !lunch) {
    return createErrorResponse("氏名・区分・弁当要否は必須です。");
  }

  // 弁当要否の値チェック（想定外の値が入らないようにする）
  if (lunch !== "要" && lunch !== "不要") {
    return createErrorResponse("弁当要否は「要」または「不要」で指定してください。");
  }

  try {
    const sheet   = getSheet(CONFIG.SHEET.STAMP);
    const today   = getTodayString();
    const nowTime = getNowDatetime();

    // 同日・同一人物のレコードが既にあるか確認（二重出勤防止）
    const existing = findStampRecord(sheet, today, name);
    if (existing !== null) {
      return createErrorResponse("本日は既に出勤打刻済みです。");
    }

    // 新規行を追加
    // 退勤・業務内容は退勤打刻時に書き込むため、この時点では空
    const newRow = Array(Object.keys(CONFIG.STAMP_COL).length).fill("");
    newRow[CONFIG.STAMP_COL.DATE]    = today;
    newRow[CONFIG.STAMP_COL.NAME]    = name;
    newRow[CONFIG.STAMP_COL.ROLE]    = role;
    newRow[CONFIG.STAMP_COL.TIME_IN] = nowTime;
    newRow[CONFIG.STAMP_COL.LUNCH]   = lunch;
    // TIME_OUT と REPORT は退勤打刻時に更新するため空のまま

    sheet.appendRow(newRow);

    writeLog("stamp_in", name, `出勤打刻 [弁当: ${lunch}]`);
    Logger.log(`[handleStampIn] 出勤打刻完了: ${name} / ${today} / ${nowTime}`);

    return createSuccessResponse({ stampTime: nowTime });

  } catch (err) {
    Logger.log(`[handleStampIn] エラー: ${err.message}`);
    return createErrorResponse("出勤打刻処理中にエラーが発生しました。");
  }
}

/**
 * 退勤打刻処理。
 * 同日の出勤レコードを検索し、退勤時刻と業務内容を書き込む。
 * 出勤レコードがない場合・既に退勤済みの場合はエラーを返す。
 *
 * @param {Object} payload - { type, name, role, report }
 * @returns {TextOutput} 処理結果
 */
function handleStampOut(payload) {
  const { name, role, report } = payload;

  // 必須パラメータチェック
  if (!name || !role) {
    return createErrorResponse("氏名・区分は必須です。");
  }

  // 業務内容は退勤時の必須入力（フロントでも制御するが、バックエンドでも保証する）
  if (!report || String(report).trim() === "") {
    return createErrorResponse("業務内容を入力してから退勤してください。");
  }

  try {
    const sheet   = getSheet(CONFIG.SHEET.STAMP);
    const today   = getTodayString();
    const nowTime = getNowDatetime();

    // 同日・同一人物のレコードを検索
    const rowIndex = findStampRecord(sheet, today, name);

    // 出勤レコードがない場合はエラー
    if (rowIndex === null) {
      return createErrorResponse("本日の出勤打刻が見つかりません。先に出勤打刻をしてください。");
    }

    // 既に退勤済みの場合はエラー（二重退勤防止）
    // getValues()はシートの全データを取得するため、rowIndexを使って該当行を参照
    const allData = sheet.getDataRange().getValues();
    const existingOut = allData[rowIndex][CONFIG.STAMP_COL.TIME_OUT];
    if (existingOut && String(existingOut).trim() !== "") {
      return createErrorResponse("本日は既に退勤打刻済みです。修正が必要な場合は管理者に連絡してください。");
    }

    // 退勤時刻・業務内容を書き込む
    // getDataRange()は0始まりのインデックス、setValueは1始まりの行番号なので +1
    const sheetRow = rowIndex + 1;
    sheet.getRange(sheetRow, CONFIG.STAMP_COL.TIME_OUT + 1).setValue(nowTime);
    sheet.getRange(sheetRow, CONFIG.STAMP_COL.REPORT + 1).setValue(String(report).trim());

    writeLog("stamp_out", name, `退勤打刻 [業務: ${String(report).trim().slice(0, 30)}...]`);
    Logger.log(`[handleStampOut] 退勤打刻完了: ${name} / ${today} / ${nowTime}`);

    return createSuccessResponse({ stampTime: nowTime });

  } catch (err) {
    Logger.log(`[handleStampOut] エラー: ${err.message}`);
    return createErrorResponse("退勤打刻処理中にエラーが発生しました。");
  }
}


// ============================================================
// ユーティリティ関数
// ============================================================

/**
 * スプレッドシートから指定シートを取得する。
 * シートが存在しない場合は明確なエラーをスローして、呼び出し元でキャッチできるようにする。
 *
 * @param {string} sheetName - シート名
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(sheetName) {
  const ssId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");

  // スクリプトプロパティが未設定の場合は開発者向けエラー
  if (!ssId) {
    throw new Error("スクリプトプロパティ 'SPREADSHEET_ID' が設定されていません。");
  }

  const ss    = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(`シート「${sheetName}」が見つかりません。スプレッドシートを確認してください。`);
  }

  return sheet;
}

/**
 * 打刻シートから、指定日・指定氏名のレコードを検索する。
 * 見つかった場合はgetDataRange()上のインデックス（0始まり）を返す。
 * 見つからなかった場合はnullを返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - 打刻シート
 * @param {string} targetDate - 対象日付（YYYY-MM-DD形式）
 * @param {string} targetName - 対象氏名
 * @returns {number|null} レコードの行インデックス（0始まり）またはnull
 */
function findStampRecord(sheet, targetDate, targetName) {
  const data = sheet.getDataRange().getValues();

  // 1行目はヘッダーなのでスキップ
  for (let i = 1; i < data.length; i++) {
    const row     = data[i];
    const rawDate = row[CONFIG.STAMP_COL.DATE];
    const rowName = String(row[CONFIG.STAMP_COL.NAME]).trim();

    // スプレッドシートの日付列はロケールによって挙動が異なる。
    // instanceof Date が false でも "Tue Apr 07 2026..." 形式の
    // Date-like オブジェクトになるケースがある（今回確認済み）。
    // new Date() で一度ラップし formatDate で YYYY-MM-DD に統一する。
    // Invalid Date の場合のみ文字列変換にフォールバック。
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
      return i; // 見つかった行のインデックスを返す
    }
  }

  return null; // 見つからなかった
}

/**
 * 今日の日付をYYYY-MM-DD形式のJSTで返す。
 * GASのデフォルトタイムゾーンがズレる場合があるため、明示的にJSTを指定する。
 *
 * @returns {string} YYYY-MM-DD形式の日付文字列
 */
function getTodayString() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, CONFIG.DATE_FORMAT);
}

/**
 * 現在日時をYYYY-MM-DD HH:mm:ss形式のJSTで返す。
 *
 * @returns {string} YYYY-MM-DD HH:mm:ss形式の日時文字列
 */
function getNowDatetime() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, CONFIG.DATETIME_FORMAT);
}

/**
 * 操作ログを操作ログシートに書き込む。
 * 監査対応のため、すべての打刻・ログイン操作を記録する。
 * ログ書き込み自体が失敗しても打刻処理は続行させるため、エラーはログのみで止めない。
 *
 * @param {string} action  - アクション種別（例: "login", "stamp_in"）
 * @param {string} name    - 操作者氏名
 * @param {string} detail  - 詳細情報
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
    // ログ書き込み失敗は業務処理を止めないが、開発者向けに記録する
    Logger.log(`[writeLog] ログ書き込みエラー: ${err.message}`);
  }
}


// ============================================================
// レスポンス生成ヘルパー
// ============================================================

/**
 * 成功レスポンスを生成する。
 * フロントエンドでは success: true を確認してから data を使用する。
 *
 * @param {Object} data - レスポンスに含める追加データ
 * @returns {TextOutput}
 */
function createSuccessResponse(data) {
  const response = Object.assign({ success: true }, data);
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * エラーレスポンスを生成する。
 * フロントエンドではsuccessがfalseのときmessageを表示する。
 *
 * @param {string} message - ユーザー向けエラーメッセージ（日本語）
 * @returns {TextOutput}
 */
function createErrorResponse(message) {
  const response = { success: false, message };
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// Phase2 予約関数（スタブ）
// 将来の申請・カレンダー機能追加時にここを実装する
// ============================================================

/**
 * [Phase2] 申請処理（休み・遅刻・早退・補填）
 * @param {Object} payload - 申請情報
 */
// function handleApply(payload) {
//   // TODO: Phase2で実装
// }

/**
 * [Phase2] カレンダー情報取得
 * @param {Object} payload - { name, year, month }
 */
// function handleGetCalendar(payload) {
//   // TODO: Phase2で実装
// }

/**
 * [Phase2] 申請承認・却下（管理者のみ）
 * @param {Object} payload - { applicationId, status }
 */
// function handleApprove(payload) {
//   // TODO: Phase2で実装
// }
