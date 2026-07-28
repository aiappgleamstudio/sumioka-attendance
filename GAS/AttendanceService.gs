/**
 * AttendanceService.gs — 出退勤記録サービス
 *
 * 役割:
 *   出退勤記録（出勤・退勤・休憩・弁当・メモ）の CRUD を実装する。
 *   Code.gs から分離した最初のサービスファイル。
 *
 * 設計方針:
 *   - employee_id + date の複合キーで upsert する
 *   - date 列の自動Date変換を防ぐため setNumberFormat('@') を必ず使う
 *   - 上書き・削除前に必ずバックアップを取る（saveBackup）
 *   - 日付はフロント↔API間は YYYY-MM-DD、シート保存は YYYY/MM/DD で統一する
 *
 * エントリポイント:
 *   handleAttendanceAction(action, data) — Code.gs の switch から委譲される
 *
 * 実装するアクション:
 *   save       - 出退勤記録の保存（upsert）
 *   load       - 出退勤記録を1件取得
 *   load_range - 期間指定で出退勤記録を取得
 *   load_daily - 特定日の全ユーザー分を取得（管理者用）
 *   delete     - 出退勤記録を1件削除
 *
 * 依存ファイル:
 *   Code.gs — generateId / getAllRows / getOrCreateSheet /
 *             createSuccessResponse / createErrorResponse /
 *             saveBackup / validateDateFormat / convertDateForDisplay /
 *             _safeTimeStr / SHEET / ATTENDANCE_COL / ATTENDANCE_NUM_COLS
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

/**
 * 出退勤記録系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'save':
 *   case 'load':
 *   case 'load_range':
 *   case 'load_daily':
 *   case 'delete':
 *     return handleAttendanceAction(action, data, attendanceSheet);
 *
 * @param {string} action
 * @param {Object} data
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @returns {ContentService.TextOutput}
 */
function handleAttendanceAction(action, data, attendanceSheet) {
  try {
    switch (action) {

      case 'save':
        return createSuccessResponse(saveAttendanceRecord(attendanceSheet, data));

      case 'load':
        return createSuccessResponse(
          loadAttendanceRecord(attendanceSheet, data.employee_id, data.date)
        );

      case 'load_range':
        return createSuccessResponse(
          loadAttendanceRange(attendanceSheet, data.employee_id, data.start_date, data.end_date)
        );

      case 'load_daily':
        return createSuccessResponse(loadDailyAttendance(attendanceSheet, data.date));

      case 'delete':
        return createSuccessResponse(deleteAttendanceRecord(attendanceSheet, data.id));

      default:
        throw new Error('AttendanceService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleAttendanceAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 出退勤記録 CRUD
// ============================================================

/**
 * 出退勤記録を保存する（upsert）。
 *
 * employee_id + date の複合キーで既存行を検索し、
 * 存在すれば上書き、なければ新規追加する。
 *
 * 【重要】date 列の書き込みについて:
 *   appendRow を使うと GAS が date 文字列を自動で Date オブジェクトに変換する。
 *   これを防ぐため、新規追加時も setValues を使い、
 *   書き込み前に対象セルを setNumberFormat('@') でテキスト形式に指定する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @returns {{ id: string, saved: boolean, timestamp: string }}
 */
function saveAttendanceRecord(sheet, data) {
  const { employee_id, date: rawDate } = data;

  if (!employee_id) throw new Error('employee_id は必須です。');
  if (!rawDate)     throw new Error('date は必須です。');
  validateDateFormat(rawDate);

  // フロントから YYYY-MM-DD で渡ってくる date をスプシ表示用の YYYY/MM/DD に変換する
  const date = convertDateForDisplay(rawDate);
  const ad   = data.attendance_data || {};
  const now  = new Date().toISOString();

  // employee_id + date の複合キーで既存行を検索する
  const rows     = getAllRows(sheet);
  const existIdx = rows.findIndex(
    r => r[ATTENDANCE_COL.EMPLOYEE_ID - 1] === employee_id &&
         r[ATTENDANCE_COL.DATE        - 1] === date
  );

  let recordId;
  let targetRowNum;

  if (existIdx !== -1) {
    // 上書き: バックアップを取ってから既存行を更新する
    recordId     = rows[existIdx][ATTENDANCE_COL.ID - 1];
    targetRowNum = existIdx + 2;
    saveBackup(SHEET.ATTENDANCE, recordId, rows[existIdx]);
    Logger.log('[saveAttendanceRecord] Updated: id=%s', recordId);
  } else {
    // 新規追加
    recordId     = generateId();
    targetRowNum = sheet.getLastRow() + 1;
    Logger.log('[saveAttendanceRecord] Created: id=%s', recordId);
  }

  // 文字列として保存すべき列をテキスト形式に固定する（setValues より必ず前に呼ぶ）
  sheet.getRange(targetRowNum, ATTENDANCE_COL.DATE    ).setNumberFormat('@');
  sheet.getRange(targetRowNum, ATTENDANCE_COL.TIME_IN ).setNumberFormat('@');
  sheet.getRange(targetRowNum, ATTENDANCE_COL.TIME_OUT).setNumberFormat('@');

  sheet.getRange(targetRowNum, 1, 1, ATTENDANCE_NUM_COLS).setValues([[
    recordId,
    employee_id,
    date,
    ad.status        || '',
    ad.time_in       || '',
    ad.time_out      || '',
    ad.break_minutes ?? '',
    ad.work_minutes  ?? '',
    ad.lunch === true ? '有' : '無',
    ad.memo          || '',
    now,
  ]]);

  SpreadsheetApp.flush();
  return { id: recordId, saved: true, timestamp: now };
}

/**
 * 出退勤記録を1件取得する。
 * 該当レコードが存在しない場合は { record: null } を返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} employeeId
 * @param {string} date - YYYY-MM-DD
 * @returns {{ record: Object|null }}
 */
function loadAttendanceRecord(sheet, employeeId, date) {
  if (!employeeId) throw new Error('employee_id は必須です。');
  if (!date)       throw new Error('date は必須です。');
  validateDateFormat(date);

  const dateKey = convertDateForDisplay(date);
  const rows    = getAllRows(sheet);
  const row     = rows.find(r => r[1] === employeeId && r[2] === dateKey);

  if (!row) {
    Logger.log('[loadAttendanceRecord] Not found: employee_id=%s, date=%s', employeeId, date);
    return { record: null };
  }

  return { record: rowToAttendanceRecord(row) };
}

/**
 * 指定期間の出退勤記録を取得する。
 * YYYY/MM/DD 文字列のゼロ埋め大小比較で範囲絞り込みを行う。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} employeeId
 * @param {string} startDate - YYYY-MM-DD（含む）
 * @param {string} endDate   - YYYY-MM-DD（含む）
 * @returns {{ records: Object[], count: number }}
 */
function loadAttendanceRange(sheet, employeeId, startDate, endDate) {
  if (!employeeId) throw new Error('employee_id は必須です。');
  if (!startDate)  throw new Error('start_date は必須です。');
  if (!endDate)    throw new Error('end_date は必須です。');
  validateDateFormat(startDate);
  validateDateFormat(endDate);

  const startKey = convertDateForDisplay(startDate);
  const endKey   = convertDateForDisplay(endDate);

  if (startKey > endKey) {
    throw new Error('start_date は end_date 以前の日付を指定してください。');
  }

  const rows    = getAllRows(sheet);
  const records = rows
    .filter(r => r[1] === employeeId && r[2] >= startKey && r[2] <= endKey)
    .map(rowToAttendanceRecord);

  Logger.log('[loadAttendanceRange] employee_id=%s, %s〜%s, count=%d',
    employeeId, startKey, endKey, records.length);

  return { records, count: records.length };
}

/**
 * 特定日の全ユーザー分の出退勤記録を取得する（管理者用）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} date - YYYY-MM-DD
 * @returns {{ records: Object[] }}
 */
function loadDailyAttendance(sheet, date) {
  if (!date) throw new Error('date は必須です。');
  validateDateFormat(date);

  const dateKey = convertDateForDisplay(date);
  const rows    = getAllRows(sheet);
  const records = rows.filter(r => r[2] === dateKey).map(rowToAttendanceRecord);

  Logger.log('[loadDailyAttendance] date=%s, count=%d', dateKey, records.length);
  return { records };
}

/**
 * 出退勤記録を1件削除する（物理削除）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} id
 * @returns {{ deleted: boolean, id: string }}
 */
function deleteAttendanceRecord(sheet, id) {
  if (!id) throw new Error('id は必須です。');

  const rows     = getAllRows(sheet);
  const rowIndex = rows.findIndex(r => r[0] === id);

  if (rowIndex === -1) {
    throw new Error('指定された id のレコードが見つかりません: ' + id);
  }

  saveBackup(SHEET.ATTENDANCE, id, rows[rowIndex]);
  sheet.deleteRow(rowIndex + 2);
  Logger.log('[deleteAttendanceRecord] Deleted: id=%s', id);

  return { deleted: true, id };
}


// ============================================================
// 行→オブジェクト変換
// ============================================================

/**
 * シートの1行データを出退勤レコードオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToAttendanceRecord(row) {
  return {
    id          : row[ATTENDANCE_COL.ID          - 1],
    employee_id : String(row[ATTENDANCE_COL.EMPLOYEE_ID - 1]),
    date        : row[ATTENDANCE_COL.DATE        - 1],
    data        : {
      status        : row[ATTENDANCE_COL.STATUS        - 1] || '',
      time_in       : _safeTimeStr(row[ATTENDANCE_COL.TIME_IN  - 1]),
      time_out      : _safeTimeStr(row[ATTENDANCE_COL.TIME_OUT - 1]),
      break_minutes : row[ATTENDANCE_COL.BREAK_MINUTES - 1] === '' ? null : Number(row[ATTENDANCE_COL.BREAK_MINUTES - 1]),
      work_minutes  : row[ATTENDANCE_COL.WORK_MINUTES  - 1] === '' ? null : Number(row[ATTENDANCE_COL.WORK_MINUTES  - 1]),
      lunch         : row[ATTENDANCE_COL.LUNCH         - 1] === '有',
      memo          : row[ATTENDANCE_COL.MEMO          - 1] || '',
    },
    updated_at  : row[ATTENDANCE_COL.UPDATED_AT  - 1],
  };
}
