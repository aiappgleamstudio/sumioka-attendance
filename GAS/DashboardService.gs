/**
 * DashboardService.gs — Notionポータル埋め込み用ダッシュボード集計サービス
 *
 * 役割:
 *   dashboard.html（Notionページへの埋め込み・閲覧専用）向けに、
 *   本日の出退勤状況・タスクの進捗・未処理申請件数を横断集計して返す。
 *   データの正はスプレッドシートのまま変更せず、本ファイルは
 *   既存サービスの読み取り関数を呼び出して集計するだけの「薄い層」に徹する。
 *   出退勤・タスク・申請の生データ操作ロジックは一切持たない。
 *
 * 設計方針:
 *   - ProjectService.gs の getProjectDashboard() は SHEET.PROJECTS /
 *     SHEET.CONSULTATIONS / SHEET.NOTIFICATIONS を参照するが、これらは
 *     Code.gs の SHEET 定数に定義されていない（現状呼び出すとエラーになる）。
 *     本タスクのスコープ外の既存不具合のため、本ファイルではこの関数には
 *     依存せず、tasks / task_assignments シートを直接集計する。
 *   - 権限チェックは ProjectService.gs の _getOperatorProj / _requirePermProj を
 *     そのまま使う（同じ判定ロジックを再実装しない）。
 *     個人が特定できる出退勤・タスク情報を扱うため、職員以上（Lv2+）のみ許可し、
 *     未認証・権限不足のリクエストにはデータを一切返さずエラーにする。
 *   - CacheService（5分）で集計結果をキャッシュする。Notion埋め込みは
 *     複数人が同時に開く可能性があり、そのたびに複数シートを読み直すと
 *     GAS の実行回数・実行時間を圧迫するため。
 *     ただし認証チェックはキャッシュの有無に関わらず必ず先に行う
 *     （キャッシュ経由で未認証アクセスにデータが漏れるのを防ぐため）。
 *
 * エントリポイント:
 *   handleDashboardAction(action, data) — Code.gs の switch から委譲される
 *
 * 実装するアクション:
 *   get_dashboard_summary - 出退勤・タスク・申請の状況サマリーを取得
 *
 * 依存ファイル:
 *   Code.gs                   — getOrCreateSheet / getAllRows / loadEmployees /
 *                                createSuccessResponse / createErrorResponse /
 *                                SHEET / EMPLOYEE_COL
 *   AttendanceService.gs      — loadDailyAttendance
 *   AttendanceAlertService.gs — checkMissingClocks
 *   RequestService.gs         — adminRequests
 *   ProjectService.gs         — _getOperatorProj / _requirePermProj / _todayString
 *   Shared.gs                 — SHEET_V2 / TASK_COL / TASK_STATUS_V2 /
 *                                TASK_STATUS_LIST_V2 / initTaskSheet /
 *                                initTaskAssignSheet / rowToTask / rowToTaskAssignment
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

/**
 * ダッシュボード系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'get_dashboard_summary':
 *     return handleDashboardAction(action, data);
 *
 * @param {string} action
 * @param {Object} data
 * @returns {ContentService.TextOutput}
 */
function handleDashboardAction(action, data) {
  try {
    switch (action) {

      case 'get_dashboard_summary':
        return createSuccessResponse(getDashboardSummary(data));

      default:
        throw new Error('DashboardService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleDashboardAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// ダッシュボードサマリー取得
// ============================================================

/**
 * 出退勤・タスク・申請の状況サマリーを取得する。
 *
 * 入力:
 *   data.operator_id - 閲覧者の職員ID（必須・職員以上のみ許可）
 *
 * 出力:
 *   {
 *     generated_at : string,  // ISO 8601
 *     date         : string,  // 集計対象日（YYYY-MM-DD）
 *     attendance   : { total_staff_count, present_count, present_staff[],
 *                       absent_staff[], missing_clock_count },
 *     tasks        : { status_count, overdue_count, by_staff[] },
 *     requests     : { pending_count },
 *   }
 *
 * @param {Object} data
 * @returns {Object}
 */
function getDashboardSummary(data) {
  if (!data || !data.operator_id) {
    throw new Error('operator_id は必須です。');
  }

  // 未認証・権限不足は一切データを返さずここで弾く。
  // ProjectService.gs の既存判定をそのまま使う（Lv2=職員以上、Lv3=管理者）。
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, 'ダッシュボード参照');

  var cache    = CacheService.getScriptCache();
  var cacheKey = 'dashboard_summary_v1';
  var cached   = cache.get(cacheKey);
  if (cached) {
    Logger.log('[getDashboardSummary] キャッシュヒット: operator_id=%s', data.operator_id);
    return JSON.parse(cached);
  }

  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var summary = _buildDashboardSummary(ss);

  // 「見るだけ」画面のため多少の遅延は許容し、5分キャッシュで実行回数を抑える。
  cache.put(cacheKey, JSON.stringify(summary), 300);

  Logger.log('[getDashboardSummary] 集計完了・キャッシュ保存: operator_id=%s', data.operator_id);
  return summary;
}

/**
 * 出退勤・タスク・申請を横断集計する（内部用）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function _buildDashboardSummary(ss) {
  var today = _todayString(); // 'YYYY-MM-DD'（ProjectService.gs 定義を再利用）

  return {
    generated_at : new Date().toISOString(),
    date         : today,
    attendance   : _buildAttendanceSummary(ss, today),
    tasks        : _buildTaskSummary(ss, today),
    requests     : _buildRequestSummary(ss),
  };
}

/**
 * 本日の出退勤状況を集計する。
 *
 * 誰が出勤中か・誰が未出勤かは AttendanceService.gs の loadDailyAttendance の
 * 結果を職員一覧と突き合わせて判定する。打刻漏れ人数は
 * AttendanceAlertService.gs の checkMissingClocks（勤務曜日・会社休日・
 * 承認済み休暇を考慮した判定）をそのまま使う。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} today - YYYY-MM-DD
 * @returns {Object}
 */
function _buildAttendanceSummary(ss, today) {
  var employeeSheet   = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var attendanceSheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);

  var employees = loadEmployees(employeeSheet).employees
    .filter(function(e) { return !e.deleted; });

  var dailyRecords = loadDailyAttendance(attendanceSheet, today).records;
  var attMap = {};
  dailyRecords.forEach(function(r) { attMap[r.employee_id] = r; });

  var presentStaff = [];
  var absentStaff  = [];

  employees.forEach(function(e) {
    var rec       = attMap[e.id];
    var isPresent = !!(rec && rec.data.time_in);
    if (isPresent) {
      presentStaff.push({
        id       : e.id,
        name     : e.name,
        time_in  : rec.data.time_in,
        time_out : rec.data.time_out,
      });
    } else {
      absentStaff.push({ id: e.id, name: e.name });
    }
  });

  var missing = checkMissingClocks(ss, attendanceSheet, employeeSheet, { date: today }).missing;

  return {
    total_staff_count   : employees.length,
    present_count       : presentStaff.length,
    present_staff       : presentStaff,
    absent_staff        : absentStaff,
    missing_clock_count : missing.length,
  };
}

/**
 * 案件・タスクの進捗サマリーを集計する（担当者ごとの現在のタスク数・
 * ステータス内訳・期限超過件数）。
 *
 * tasks / task_assignments シートを直接読み、Shared.gs の行変換関数
 * （rowToTask / rowToTaskAssignment）で変換したうえで集計する。
 * 「現在のタスク」は完了以外のステータスを指す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} today - YYYY-MM-DD
 * @returns {Object}
 */
function _buildTaskSummary(ss, today) {
  var employeeSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var taskSheet      = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet    = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);

  var tasks = getAllRows(taskSheet)
    .map(rowToTask)
    .filter(function(t) { return !t.deleted; });

  var assignments = getAllRows(assignSheet).map(rowToTaskAssignment);

  // タスクID → 担当者ID配列
  var assigneesByTask = {};
  assignments.forEach(function(a) {
    if (!assigneesByTask[a.task_id]) assigneesByTask[a.task_id] = [];
    assigneesByTask[a.task_id].push(a.user_id);
  });

  var statusCount = {};
  TASK_STATUS_LIST_V2.forEach(function(s) { statusCount[s] = 0; });

  var overdueCount = 0;
  var byStaffMap    = {}; // user_id → { task_count, status_breakdown, overdue_count }

  tasks.forEach(function(t) {
    if (statusCount[t.status] !== undefined) statusCount[t.status]++;

    var isOverdue = t.status !== TASK_STATUS_V2.COMPLETED && !!t.due_date && t.due_date < today;
    if (isOverdue) overdueCount++;

    // 完了タスクは「現在のタスク数」の担当者別集計からは除外する
    if (t.status === TASK_STATUS_V2.COMPLETED) return;

    (assigneesByTask[t.id] || []).forEach(function(uid) {
      if (!byStaffMap[uid]) {
        byStaffMap[uid] = { task_count: 0, status_breakdown: {}, overdue_count: 0 };
        TASK_STATUS_LIST_V2.forEach(function(s) { byStaffMap[uid].status_breakdown[s] = 0; });
      }
      byStaffMap[uid].task_count++;
      if (byStaffMap[uid].status_breakdown[t.status] !== undefined) {
        byStaffMap[uid].status_breakdown[t.status]++;
      }
      if (isOverdue) byStaffMap[uid].overdue_count++;
    });
  });

  var empNameMap = {};
  getAllRows(employeeSheet).forEach(function(r) {
    empNameMap[r[EMPLOYEE_COL.ID - 1]] = rowToEmployee(r).name;
  });

  var byStaff = Object.keys(byStaffMap)
    .map(function(uid) {
      var s = byStaffMap[uid];
      return {
        id               : uid,
        name             : empNameMap[uid] || '(不明)',
        task_count       : s.task_count,
        status_breakdown : s.status_breakdown,
        overdue_count    : s.overdue_count,
      };
    })
    .sort(function(a, b) { return b.task_count - a.task_count; });

  return {
    status_count  : statusCount,
    overdue_count : overdueCount,
    by_staff      : byStaff,
  };
}

/**
 * 未処理の申請件数（休暇・残業申請）を集計する。
 *
 * 申請管理シートには休暇系の申請と、submitOvertimeRequest 経由で
 * 登録される残業申請（種別='残業'）が type 違いで同居している。
 * そのため type を絞らず status='pending' のみで集計すれば、
 * そのまま「休暇・残業申請」の合算件数になる。
 * RequestService.gs の adminRequests がすでに pending_count を
 * 算出しているため、それをそのまま使う。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function _buildRequestSummary(ss) {
  var result = adminRequests(ss, { status: 'pending' });
  return { pending_count: result.pending_count };
}
