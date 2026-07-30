/**
 * Services.gs - 集計・レポート生成
 *
 * 役割:
 *   - 月次勤function generateMonthlyReport怠集計レポートの生成
 *   - Code.gs の CRUD を基盤として、より高度な集計処理を担う
 *
 * 設計方針:
 *   - このファイルの関数は handleAttendance から呼ばれる
 *   - 集計ロジックはすべてここに集約し、Code.gs には書かない
 *   - GAS の実行時間上限（6分）を意識し、重い処理は早期リターンを設ける
 *   - Code.gs の SHEET 定数・getAllRows・rowToEmployee・rowToAttendanceRecord を使用する
 *
 * @version 1.1.0
 * @author  田中沙亜
 */

// ============================================================
// 月次集計
// ============================================================

/**
 * 指定月の勤怠データを人員別に集計してレポートを生成する。
 *
 * handleAttendance の 'monthly_report' action から呼ばれる。
 *
 * 返り値の構造:
 *   {
 *     year_month   : '2026-04',
 *     generated_at : ISO 8601,
 *     report : [
 *       {
 *         employee_id        : string,
 *         employee_name      : string,
 *         employment_type    : string,
 *         work_days          : number,
 *         absent_days        : number,
 *         late_days          : number,
 *         early_leave_days   : number,
 *         holiday_days       : number,
 *         total_work_minutes : number,
 *         lunch_count        : number,
 *         records            : Object[],
 *       }
 *     ]
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {string} yearMonth - 'YYYY-MM' 形式
 * @returns {Object}
 */
function generateMonthlyReport(attendanceSheet, employeeSheet, yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error('year_month は YYYY-MM 形式で指定してください: ' + yearMonth);
  }

  Logger.log('[generateMonthlyReport] yearMonth=%s', yearMonth);

  const allAttendanceRows = getAllRows(attendanceSheet);
  const monthRecords = allAttendanceRows
  .filter(row => String(row[2]).replace(/\//g, '-').startsWith(yearMonth))
  .map(rowToAttendanceRecord);

  Logger.log('[generateMonthlyReport] 対象レコード数: %d', monthRecords.length);

  const employeeRows = getAllRows(employeeSheet);
  const employeeMap  = buildEmployeeMap(employeeRows);

  const groupedByEmployee = groupByEmployeeId(monthRecords);

  const report = Object.keys(groupedByEmployee).map(employeeId => {
    const records  = groupedByEmployee[employeeId];
    const employee = employeeMap[employeeId] || null;
    return aggregateEmployeeRecords(employeeId, employee, records);
  });

  report.sort((a, b) => a.employee_name.localeCompare(b.employee_name, 'ja'));

  return {
    year_month   : yearMonth,
    generated_at : new Date().toISOString(),
    report,
  };
}

function debugAttendanceRow() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  const rows  = getAllRows(sheet);
  
  if (rows.length === 0) {
    Logger.log('データなし');
    return;
  }
  
  // 最初の1行をインデックス付きで全列出力する
  rows[0].forEach((cell, i) => {
    Logger.log('row[%d] = %s', i, cell);
  });
}

// ============================================================
// 集計ヘルパー関数
// ============================================================

/**
 * 人員マスタの行データから id → 人員情報 のマップを生成する。
 *
 * フラット化後は rowToEmployee（Code.gs）で変換する。
 * 旧実装の safeJsonParse(row[2]) は不要になった。
 *
 * @param {Array[]} employeeRows - 人員マスタシートの全行データ
 * @returns {Object} { [id]: { id, name, employment_type, ... } }
 */
function buildEmployeeMap(employeeRows) {
  return employeeRows.reduce((map, row) => {
    const employee = rowToEmployee(row);
    // ID は文字列として統一する。シートから数値で返ってくる場合に
    // record.employee_id（String強制済）と型が不一致になるのを防ぐ。
    if (employee.id) map[String(employee.id)] = employee;
    return map;
  }, {});
}

/**
 * 勤怠レコードの配列を employee_id でグループ化する。
 *
 * @param {Object[]} records
 * @returns {Object} { [employee_id]: records[] }
 */
function groupByEmployeeId(records) {
  return records.reduce((groups, record) => {
    const id = record.employee_id;
    if (!groups[id]) groups[id] = [];
    groups[id].push(record);
    return groups;
  }, {});
}

/**
 * 1人分の勤怠レコードを集計してサマリーを返す。
 *
 * status の種類と勤務日カウントの定義:
 *   '出勤' → work_days++
 *   '遅刻' → work_days++, late_days++
 *   '早退' → work_days++, early_leave_days++
 *   '欠勤' → absent_days++
 *   '休日' → holiday_days++
 *
 * @param {string}      employeeId
 * @param {Object|null} employee
 * @param {Object[]}    records
 * @returns {Object}
 */
function aggregateEmployeeRecords(employeeId, employee, records) {
  records.sort((a, b) => a.date.localeCompare(b.date));

  let workDays       = 0;
  let absentDays     = 0;
  let lateDays       = 0;
  let earlyLeaveDays = 0;
  let holidayDays    = 0;
  let totalWorkMin   = 0;
  let lunchCount     = 0;

  records.forEach(record => {
    const d      = record.data || {};
    const status = d.status || '';

    switch (status) {
      case '出勤': workDays++;                       break;
      case '遅刻': workDays++; lateDays++;           break;
      case '早退': workDays++; earlyLeaveDays++;     break;
      case '欠勤': absentDays++;                     break;
      case '休日': holidayDays++;                    break;
      default:
        Logger.log(
          '[aggregateEmployeeRecords] 未定義ステータス: "%s" (employee_id=%s, date=%s)',
          status, employeeId, record.date
        );
    }

    totalWorkMin += Number(d.work_minutes) || 0;
    if (d.lunch === true) lunchCount++;
  });

  // 所定労働時間の合計を計算する。
  // employee.scheduled_start と scheduled_end から1日の所定時間（分）を算出し、
  // 出勤日数で掛け算する。設定がない場合は scheduled_minutes = null を返し、
  // フロント側で「―」を表示して誤った計算をしないようにする。
  let scheduledMinutes = null;
  let balanceMinutes   = null;

  if (employee && employee.scheduled_start && employee.scheduled_end) {
    const parseTime = t => {
      const [h, m] = String(t).split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const startMin    = parseTime(employee.scheduled_start);
    const endMin      = parseTime(employee.scheduled_end);
    const dayScheduled = Math.max(0, endMin - startMin); // 1日の所定時間（分）
    scheduledMinutes   = dayScheduled * workDays;
    balanceMinutes     = totalWorkMin - scheduledMinutes;
  }

  return {
    employee_id        : employeeId,
    employee_name      : employee ? employee.name : '（不明）',
    employment_type    : employee ? (employee.employment_type || '') : '',
    work_days          : workDays,
    absent_days        : absentDays,
    late_days          : lateDays,
    early_leave_days   : earlyLeaveDays,
    holiday_days       : holidayDays,
    total_work_minutes : totalWorkMin,
    scheduled_minutes  : scheduledMinutes, // 所定合計（フロントの残不足計算に使用）
    balance_minutes    : balanceMinutes,   // 残不足（実働 - 所定）
    lunch_count        : lunchCount,
    records,
  };
}

// ============================================================
// ビューシート生成
// ============================================================

/**
 * 指定月の日次打刻ビューシートを職員・利用者別に生成する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {string} yearMonth - 'YYYY-MM' 形式
 * @returns {{ staff_rows: number, user_rows: number, year_month: string }}
 */
function exportViewSheets(attendanceSheet, employeeSheet, yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error('year_month は YYYY-MM 形式で指定してください: ' + yearMonth);
  }

  Logger.log('[exportViewSheets] 開始: yearMonth=%s', yearMonth);

  const allRows    = getAllRows(attendanceSheet);
  const monthRows  = allRows
    .filter(row => String(row[ATTENDANCE_COL.DATE - 1]).startsWith(yearMonth))
    .map(rowToAttendanceRecord);

  Logger.log('[exportViewSheets] 対象レコード数: %d', monthRows.length);

  const employeeRows = getAllRows(employeeSheet);
  const employeeMap  = buildEmployeeMap(employeeRows);

  // employment_type === '利用者' を利用者、それ以外を職員として扱う
  const staffRecords = monthRows.filter(r => {
    const emp = employeeMap[r.employee_id];
    return emp && emp.employment_type !== '利用者';
  });

  const userRecords = monthRows.filter(r => {
    const emp = employeeMap[r.employee_id];
    return emp && emp.employment_type === '利用者';
  });

  Logger.log('[exportViewSheets] 職員: %d件, 利用者: %d件',
    staffRecords.length, userRecords.length);

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const staffSheetName = '日次打刻_職員_'  + yearMonth;
  const userSheetName  = '日次打刻_利用者_' + yearMonth;

  const staffCount = writeStaffViewSheet(ss, staffSheetName, staffRecords, employeeMap);
  const userCount  = writeUserViewSheet(ss, userSheetName,  userRecords,  employeeMap);

  SpreadsheetApp.flush();

  Logger.log('[exportViewSheets] 完了: 職員=%d行, 利用者=%d行', staffCount, userCount);

  return {
    year_month  : yearMonth,
    staff_rows  : staffCount,
    user_rows   : userCount,
    staff_sheet : staffSheetName,
    user_sheet  : userSheetName,
  };
}

// ============================================================
// ビューシート書き込みヘルパー
// ============================================================

/**
 * シートをリセット（データ行削除 + ヘッダー上書き）して返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string}   sheetName
 * @param {string[]} headers
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function resetViewSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    Logger.log('[resetViewSheet] 新規作成: %s', sheetName);
  } else {
    if (sheet.getLastRow() >= 2) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    }
    Logger.log('[resetViewSheet] データ行リセット: %s', sheetName);
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  return sheet;
}

/**
 * 職員用ビューシートを生成する。
 *
 * 列構成:
 *   A: 氏名, B: 日付, C: ステータス, D: 出勤時刻, E: 退勤時刻,
 *   F: 休憩(分), G: 実働(分), H: 弁当, I: メモ,
 *   J: 雇用形態, K: 時給/月給
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string}   sheetName
 * @param {Object[]} records
 * @param {Object}   employeeMap
 * @returns {number} 書き込んだデータ行数
 */
function writeStaffViewSheet(ss, sheetName, records, employeeMap) {
  const headers = [
    '氏名', '日付', '勤怠区分', '出勤時刻', '退勤時刻',
    '休憩(分)', '実働(分)', '弁当', 'メモ',
    '雇用形態', '時給/月給',
  ];

  const sheet = resetViewSheet(ss, sheetName, headers);

  if (records.length === 0) {
    Logger.log('[writeStaffViewSheet] 書き込みデータなし: %s', sheetName);
    return 0;
  }

  records.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const nameA = (employeeMap[a.employee_id] || {}).name || '';
    const nameB = (employeeMap[b.employee_id] || {}).name || '';
    return nameA.localeCompare(nameB, 'ja');
  });

  const rows = records.map(record => {
    const emp = employeeMap[record.employee_id] || {};
    const d   = record.data || {};

    return [
      emp.name             || '（不明）',
      record.date,                         // スプシ保存時に YYYY/MM/DD 変換済み
      d.status             || '',
      d.time_in            || '',
      d.time_out           || '',
      d.break_minutes      ?? '',
      d.work_minutes       ?? '',
      d.lunch === true ? '有' : '無',
      d.memo               || '',
      emp.employment_type  || '',
      emp.hourly_wage      ?? '',
    ];
  });

  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  Logger.log('[writeStaffViewSheet] %d行書き込み完了: %s', rows.length, sheetName);
  return rows.length;
}

/**
 * 利用者用ビューシートを生成する。
 *
 * 列構成:
 *   A: 氏名, B: 日付, C: ステータス, D: 出勤時刻, E: 退勤時刻,
 *   F: 実働(分), G: 弁当, H: メモ
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string}   sheetName
 * @param {Object[]} records
 * @param {Object}   employeeMap
 * @returns {number} 書き込んだデータ行数
 */
function writeUserViewSheet(ss, sheetName, records, employeeMap) {
  const headers = [
    '氏名', '日付', '勤怠区分', '出勤時刻', '退勤時刻',
    '実働(分)', '弁当', 'メモ',
  ];

  const sheet = resetViewSheet(ss, sheetName, headers);

  if (records.length === 0) {
    Logger.log('[writeUserViewSheet] 書き込みデータなし: %s', sheetName);
    return 0;
  }

  records.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const nameA = (employeeMap[a.employee_id] || {}).name || '';
    const nameB = (employeeMap[b.employee_id] || {}).name || '';
    return nameA.localeCompare(nameB, 'ja');
  });

  const rows = records.map(record => {
    const emp = employeeMap[record.employee_id] || {};
    const d   = record.data || {};

    return [
      emp.name         || '（不明）',
      record.date,                     // スプシ保存時に YYYY/MM/DD 変換済み
      d.status         || '',
      d.time_in        || '',
      d.time_out       || '',
      d.work_minutes   ?? '',
      d.lunch === true ? '有' : '無',
      d.memo           || '',
    ];
  });

  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  Logger.log('[writeUserViewSheet] %d行書き込み完了: %s', rows.length, sheetName);
  return rows.length;
}