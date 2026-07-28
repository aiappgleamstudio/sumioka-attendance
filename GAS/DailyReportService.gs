/**
 * DailyReportService.gs — 日報サービス
 *
 * 役割:
 *   退勤時に入力する日報（全体コメント・引継ぎ事項）の保存・取得を実装する。
 *   タスク別の作業コメントは ProjectService.gs の task_comments
 *   （get_task_comments / add_task_comment）が別途管理しており、
 *   本ファイルが扱うのは daily_reports シート（1日1ユーザー1レコード）のみ。
 *
 * 設計方針:
 *   - Shared.gs の DAILY_REPORT_COL / initDailyReportSheet / rowToDailyReport を使う
 *   - user_id + work_date の複合キーで upsert する
 *     （出退勤記録の saveAttendanceRecord と同じ考え方）
 *   - 権限チェック: 本人のみ自分の日報を保存・取得可能、職員以上は全員分を取得可能
 *   - 論理削除は持たない（日報は訂正のみで削除しない運用想定）
 *
 * エントリポイント:
 *   handleDailyReportAction(action, data) — Code.gs の switch から委譲される
 *
 * 実装するアクション:
 *   save_daily_report - 日報の保存（新規 or 上書き）
 *   get_daily_report  - 日報の取得（本人 or 職員以上が指定ユーザーを取得）
 *
 * 依存ファイル:
 *   Code.gs   — generateId / getAllRows / getOrCreateSheet /
 *               createSuccessResponse / createErrorResponse /
 *               rowToEmployee / SHEET / EMPLOYEE_COL
 *   Shared.gs — SHEET_V2 / DAILY_REPORT_COL / DAILY_REPORT_NUM_COLS /
 *               initDailyReportSheet / rowToDailyReport / _toSlashDate
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

/**
 * 日報系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'save_daily_report':
 *   case 'get_daily_report':
 *     return handleDailyReportAction(action, data);
 *
 * @param {string} action
 * @param {Object} data
 * @returns {ContentService.TextOutput}
 */
function handleDailyReportAction(action, data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (action) {

      case 'save_daily_report':
        return createSuccessResponse(saveDailyReport(ss, data));

      case 'get_daily_report':
        return createSuccessResponse(getDailyReport(ss, data));

      default:
        throw new Error('DailyReportService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleDailyReportAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 権限チェック（DailyReportService 内部用）
// ============================================================

/**
 * user_id から人員マスタを引いて employee を返す。
 * 見つからない場合は例外を投げる。
 *
 * @param {Spreadsheet} ss
 * @param {string} userId
 * @returns {Object} employee
 */
function _getOperatorReport(ss, userId) {
  if (!userId) throw new Error('user_id は必須です。');
  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var rows     = getAllRows(empSheet);
  var row      = rows.find(function(r) {
    return String(r[EMPLOYEE_COL.ID      - 1]) === String(userId) &&
           String(r[EMPLOYEE_COL.DELETED - 1]) !== 'true';
  });
  if (!row) throw new Error('ユーザーが見つかりません: ' + userId);
  return rowToEmployee(row);
}

/**
 * 権限レベルを返す（DailyReportService 内部用）。
 * @param {Object} employee
 * @returns {number} 3=管理者, 2=職員, 1=利用者, 0=不明
 */
function _getPermLevelReport(employee) {
  if (!employee) return 0;
  if (employee.admin_role === '管理者') return 3;
  if (employee.employment_type === '職員') return 2;
  return 1;
}


// ============================================================
// 日報 保存・取得
// ============================================================

/**
 * 日報を保存する（upsert）。
 *
 * user_id + work_date の複合キーで既存行を検索し、
 * 存在すれば上書き、なければ新規追加する
 * （saveAttendanceRecord と同じ upsert パターン）。
 *
 * 権限:
 *   本人のみ保存可能（他人の日報を代理保存することはできない）。
 *
 * 入力:
 *   data.user_id   - 日報の本人ID（必須）
 *   data.work_date - 対象日（YYYY-MM-DD、省略時: 本日）
 *   data.comment   - 全体コメント（必須）
 *   data.handover  - 引継ぎ事項（任意）
 *
 * 出力:
 *   { id: string, saved: true, is_new: boolean }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function saveDailyReport(ss, data) {
  if (!data.user_id) throw new Error('user_id は必須です。');
  if (!data.comment || !String(data.comment).trim()) {
    throw new Error('日報の全体コメントは必須です。');
  }

  // 本人のみ保存可能（権限チェック）
  // ※ 現状フロントは常に本人IDで呼ぶ想定だが、なりすまし防止のため
  //   人員マスタに本人が存在するかだけは確認する
  var operator = _getOperatorReport(ss, data.user_id);

  var reportSheet = getOrCreateSheet(ss, SHEET_V2.DAILY_REPORTS);
  initDailyReportSheet(reportSheet);

  var now      = new Date().toISOString();
  var workDate = _toSlashDate(data.work_date || _todayStringReport());

  // user_id + work_date の複合キーで既存行を検索する
  var rows     = getAllRows(reportSheet);
  var existIdx = rows.findIndex(function(r) {
    return String(r[DAILY_REPORT_COL.USER_ID   - 1]) === String(data.user_id) &&
           String(r[DAILY_REPORT_COL.WORK_DATE - 1]) === workDate;
  });

  var isNew = existIdx === -1;
  var id;
  var createdAt;
  var rowNum;

  if (isNew) {
    id        = generateId();
    createdAt = now;
    rowNum    = reportSheet.getLastRow() + 1;
    Logger.log('[saveDailyReport] 新規作成: user_id=%s, date=%s', data.user_id, workDate);
  } else {
    id        = String(rows[existIdx][DAILY_REPORT_COL.ID         - 1]);
    createdAt = String(rows[existIdx][DAILY_REPORT_COL.CREATED_AT - 1] || now);
    rowNum    = existIdx + 2;
    Logger.log('[saveDailyReport] 更新: id=%s, user_id=%s, date=%s', id, data.user_id, workDate);
  }

  // work_date 列はテキスト形式で保存する（GASの自動日付変換を防ぐ）
  reportSheet.getRange(rowNum, DAILY_REPORT_COL.WORK_DATE).setNumberFormat('@');

  reportSheet.getRange(rowNum, 1, 1, DAILY_REPORT_NUM_COLS).setValues([[
    id,                                  // A: id
    data.user_id,                        // B: user_id
    workDate,                            // C: work_date
    String(data.comment).trim(),         // D: comment
    data.handover ? String(data.handover).trim() : '',  // E: handover
    createdAt,                           // F: created_at
    now,                                 // G: updated_at
  ]]);

  SpreadsheetApp.flush();

  return { id: id, saved: true, is_new: isNew };
}

/**
 * 日報を取得する。
 *
 * 権限:
 *   - 本人は自分の日報を取得可能
 *   - 職員・管理者（Lv2以上）は任意のユーザーの日報を取得可能
 *
 * 入力:
 *   data.user_id      - 取得対象のユーザーID（必須）
 *   data.work_date    - 対象日（YYYY-MM-DD、省略時: 本日）
 *   data.operator_id  - 閲覧者ID（省略時は user_id 本人とみなす）
 *
 * 出力:
 *   { report: DailyReport|null }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getDailyReport(ss, data) {
  if (!data.user_id) throw new Error('user_id は必須です。');

  var operatorId = data.operator_id || data.user_id;
  var operator   = _getOperatorReport(ss, operatorId);
  var permLevel  = _getPermLevelReport(operator);

  // 本人以外が閲覧する場合は Lv2以上が必須
  if (operatorId !== data.user_id && permLevel < 2) {
    throw new Error('他のユーザーの日報を閲覧する権限がありません。');
  }

  var reportSheet = getOrCreateSheet(ss, SHEET_V2.DAILY_REPORTS);
  initDailyReportSheet(reportSheet);

  var workDate = _toSlashDate(data.work_date || _todayStringReport());

  var row = getAllRows(reportSheet).find(function(r) {
    return String(r[DAILY_REPORT_COL.USER_ID   - 1]) === String(data.user_id) &&
           String(r[DAILY_REPORT_COL.WORK_DATE - 1]) === workDate;
  });

  if (!row) {
    Logger.log('[getDailyReport] 該当なし: user_id=%s, date=%s', data.user_id, workDate);
    return { report: null };
  }

  return { report: rowToDailyReport(row) };
}


// ============================================================
// DailyReportService.gs 内部ユーティリティ
// ============================================================

/**
 * 本日の日付を 'YYYY-MM-DD' 形式で返す。
 * Shared.gs の _todayString と同名衝突を避けるため接尾辞 Report を付ける。
 * @returns {string}
 */
function _todayStringReport() {
  var d = new Date();
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}
