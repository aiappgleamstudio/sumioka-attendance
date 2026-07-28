/**
 * Code.gs - A型事業所運営プラットフォーム メインファイル
 *
 * 役割:
 *   - POSTリクエストの受付（doPost）
 *   - app / action によるルーティング専用
 *   - 共通ユーティリティ（レスポンス生成・シート操作・日付変換・バックアップ）
 *
 * 設計方針:
 *   - GASプロジェクトは1つ。エントリポイントは doPost のみ
 *   - すべての例外は try/catch で捕捉し createErrorResponse に変換する
 *   - 日付はすべて YYYY-MM-DD 文字列で統一（Date オブジェクト不使用）
 *   - Code.gs は段階的にルーティング専用へ縮小する方針
 *     （Attendance → Employee → Auth の順で分離済み。次は Notification 等）
 *
 * ファイル分割構成（各ファイルの役割）:
 *   Code.gs              - エントリポイント・ルーティング・共通ユーティリティ（本ファイル）
 *   AuthService.gs       - 認証（authenticate / kintai_authenticate）
 *   AttendanceService.gs - 出退勤記録 CRUD（save / load / load_range / load_daily / delete）
 *   EmployeeService.gs   - 人員マスタ CRUD（save_employee / load_employees / delete_employee）
 *   DailyReportService.gs- 日報（save_daily_report / get_daily_report）
 *   Shared.gs            - 新規シート定数・初期化関数・行変換ユーティリティ
 *   TaskService.gs        - タスク3階層・レビュー・差戻・履歴・担当者管理
 *   ProjectService.gs    - 顧客・案件・案件メンバー・相談・通知・ダッシュボード（v2）
 *   AdminServices.gs     - 勤怠管理（Admin）・申請・カレンダー・給与・残業
 *   Services.gs          - 月次集計・ビューシート生成
 *   Payroll.gs           - 給与計算
 *
 * 廃止ファイル:
 *   ProjectServices.gs  - ProjectService.gs（v2）に完全置き換え済み
 *                         PROJECT_TASKS シートも廃止（tasks シートへ一本化）
 *
 * 日付の扱いについて:
 *   GAS は appendRow / setValues で 'YYYY-MM-DD' 文字列を渡しても
 *   自動的に Date オブジェクトとして解釈・保存する。
 *   これを防ぐため、日付列への書き込みは setValues に統一し、
 *   書き込み前に該当セルを setNumberFormat('@') でテキスト形式に指定してから書く。
 *   （この方針は AttendanceService.gs / EmployeeService.gs 等の分離先でも同様）
 *
 * @version 3.0.0
 */

'use strict';

// ============================================================
// 定数
// ============================================================

/** 対応する app 識別子 */
const VALID_APP = 'attendance';

/**
 * 対応する action 一覧。
 * doPost でホワイトリストチェックに使用する。
 * 新しい action を追加した場合は必ずここにも追記すること。
 */
const VALID_ACTIONS = [

  // ── 認証 ────────────────────────────────────────────────────
  'authenticate',         // Admin用：admin_role が空でない職員のみ通す
  'kintai_authenticate',  // 全ユーザー用：PIN+PWが一致すれば全員通す

  // ── 出退勤記録 CRUD ──────────────────────────────────────────
  'save',
  'load',
  'load_range',
  'load_daily',
  'delete',

  // ── 人員マスタ CRUD ──────────────────────────────────────────
  'save_employee',
  'load_employees',
  'delete_employee',

  // ── 集計・ビュー生成（Services.gs）──────────────────────────
  'monthly_report',
  'export_view',

  // ── Admin: ダッシュボード（AdminServices.gs）────────────────
  'admin_dashboard',

  // ── Admin: 勤怠管理（AdminServices.gs）─────────────────────
  'admin_attendance_list',
  'admin_edit_attendance',
  'admin_add_attendance',
  'admin_clear_attendance_field',

  // ── Admin: スタッフ管理（AdminServices.gs）──────────────────
  'admin_staff_list',
  'admin_add_staff',
  'admin_update_staff',
  'admin_delete_staff',

  // ── 申請管理（AdminServices.gs）────────────────────────────
  'submit_request',
  'get_my_requests',
  'admin_requests',
  'admin_update_request',
  'admin_edit_request',
  'save_attendance_status',

  // ── カレンダー（AdminServices.gs）──────────────────────────
  'get_calendar',
  'get_company_calendar',
  'save_company_calendar',

  // ── 旧個人タスク管理（AdminServices.gs）────────────────────
  // 旧 kintai.html / admin.html の個人タスク機能を継続サポート
  'get_tasks',
  'upsert_task',
  'delete_task',
  'admin_all_tasks',

  // ── 納期管理（AdminServices.gs）────────────────────────────
  'get_deadlines',
  'upsert_deadline',
  'delete_deadline',

  // ── 月次・補填（AdminServices.gs）──────────────────────────
  'get_my_status',
  'admin_monthly_fillup',

  // ── 給与計算（AdminServices.gs / Payroll.gs）────────────────
  'payroll_calculate',
  'payroll_load_settings',
  'payroll_save_settings',
  'payroll_save_incentive',

  // ── 残業指示（AdminServices.gs）────────────────────────────
  'create_overtime_instruction',
  'admin_overtime_instructions',
  'update_overtime_instruction_status',
  'delete_overtime_instruction',
  'submit_overtime_request',
  'admin_approve_overtime_request',
  'admin_reject_overtime_request',
  'get_overtime_instructions',

  // ── 打刻漏れ警告（AdminServices.gs）────────────────────────
  'check_missing_clocks',
  'check_missing_clocks_monthly',
  'get_my_missing_clocks',

  // ── テストデータ管理（開発用・本番では使用禁止）────────────
  'reset_test_data',
  'bulk_insert_dummy',

  // ── DailyReportService.gs（日報）───────────────────────────
  'save_daily_report',       // 日報の保存（新規 or 上書き）
  'get_daily_report',        // 日報の取得

  // ── TaskService.gs（タスク v2・tasks シート一本化）──────────
  'get_my_tasks',            // 自分の担当タスク取得（user.html 用）
  'get_tasks_by_project',    // 案件別タスクツリー取得（staff.html 用）
  'get_all_tasks',           // 全タスク一覧（admin.html 用）
  'get_task_detail',         // タスク詳細（担当者・履歴つき）
  'upsert_task_v2',          // タスク作成・更新（parent_task_id / review_required 対応）
  'update_task_status',      // ステータス更新（レビューフロー制御つき）
  'review_approve',          // レビュー承認（職員・管理者のみ）
  'review_reject',           // 差戻（理由必須）
  'delete_task_v2',          // タスク論理削除
  'get_task_history',        // タスク変更履歴取得
  'assign_task_user',        // 担当者追加
  'unassign_task_user',      // 担当者削除

  // ── ProjectService.gs v2（顧客・案件・相談・通知）──────────
  // レビュー（職員ホーム最優先表示用）
  'get_review_waiting_tasks',     // レビュー待ちタスク一覧（職員ホーム用）
  // 顧客マスタ
  'get_customers',
  'upsert_customer',
  'delete_customer',
  // 案件
  'get_projects',
  'upsert_project',
  'update_project_status',
  'delete_project',
  // 案件メンバー（新規）
  'get_project_members',
  'add_project_member',
  'remove_project_member',
  // タスクコメント（旧:作業メモ → task_comments シートへ移行）
  'get_task_comments',
  'add_task_comment',
  // 相談 v2（送信先選択対応）
  'get_consultations_v2',
  'get_consultation_list',        // get_consultations_v2 のエイリアス（名前統一）
  'send_consultation',
  'resolve_consultation',
  'change_consultation_status',   // resolve_consultation のエイリアス（名前統一）
  'reply_consultation',           // 相談への返信投稿（スレッド型）
  'mark_consultation_read',       // 相談の既読更新（consultation_recipients）
  // 通知
  'get_notifications',
  'mark_notification_read',
  'mark_all_notifications_read',
  // フェーズテンプレート
  'get_phase_templates',
  'upsert_phase_template',
  'delete_phase_template',
  // ダッシュボード（tasks シート参照版）
  'project_dashboard',
  // マスタ取得（UI ドロップダウン用）
  'get_project_masters',
];

/**
 * シート名定数（既存シート）。
 *
 * 新規追加シートは Shared.gs の SHEET_V2 を使用する。
 * このオブジェクトは既存シートのみを管理し、変更しない。
 */
const SHEET = {
  ATTENDANCE       : '出退勤記録',
  EMPLOYEES        : '人員マスタ',
  BACKUP           : '_バックアップ',
  REQUESTS         : '申請管理',
  COMPANY_CAL      : '会社カレンダー',
  TASKS            : 'タスク管理',      // 旧個人タスク（AdminServices.gs が使用）
  DEADLINES        : '納期管理',
  PAYROLL_SETTINGS : '給与設定',
  INCENTIVES       : 'インセンティブ',
  AUDIT_LOG        : '操作ログ',
  OVERTIME_INST    : '残業指示',
  // ProjectService.gs v2 が使用するシート
  CUSTOMERS        : '顧客マスタ',
  PROJECTS         : '案件',
  CONSULTATIONS    : '相談スレッド',
  NOTIFICATIONS    : '通知',
  PHASE_TEMPLATES  : 'フェーズテンプレート',
};

/** バックアップの最大保持件数（超えたら最古の1行を削除） */
const BACKUP_MAX_ROWS = 1000;

/**
 * 出退勤記録シートの列番号定数（1始まり）。
 *
 * 列構成（11列）:
 *   A(1):  id            - レコード識別子（UUID）
 *   B(2):  employee_id   - 職員識別子（UUID）
 *   C(3):  date          - 勤務日（YYYY/MM/DD テキスト形式）
 *   D(4):  status        - 勤怠区分（出勤 / 遅刻 / 早退 / 欠勤 / 休日）
 *   E(5):  time_in       - 出勤時刻（HH:MM）
 *   F(6):  time_out      - 退勤時刻（HH:MM）
 *   G(7):  break_minutes - 休憩時間（分）
 *   H(8):  work_minutes  - 実働時間（分）
 *   I(9):  lunch         - 弁当要否（有 / 無）
 *   J(10): memo          - メモ・業務内容
 *   K(11): updated_at    - 最終更新日時（ISO 8601）
 */
const ATTENDANCE_COL = {
  ID            : 1,
  EMPLOYEE_ID   : 2,
  DATE          : 3,
  STATUS        : 4,
  TIME_IN       : 5,
  TIME_OUT      : 6,
  BREAK_MINUTES : 7,
  WORK_MINUTES  : 8,
  LUNCH         : 9,
  MEMO          : 10,
  UPDATED_AT    : 11,
};
const ATTENDANCE_NUM_COLS = 11;

/**
 * 人員マスタシートの列番号定数（1始まり）。
 *
 * シート実態（23列）:
 *   A:ID  B:姓  C:名  D:PIN  E:パスワード  F:雇用形態
 *   G:所定始業時刻  H:所定終業時刻
 *   I:給与形態  J:時給(円)  K:月給(円)
 *   L:弁当デフォルト  M:勤務曜日  N:管理権限
 *   O:拠点  P:職種
 *   Q:健康保険  R:介護保険  S:厚生年金  T:雇用保険
 *   U:登録日時  V:更新日時  W:論理削除
 */
const EMPLOYEE_COL = {
  ID              : 1,   // A
  LAST_NAME       : 2,   // B
  FIRST_NAME      : 3,   // C
  PIN             : 4,   // D
  PASSWORD        : 5,   // E
  EMPLOYMENT_TYPE : 6,   // F
  SCHEDULED_START : 7,   // G
  SCHEDULED_END   : 8,   // H
  WAGE_TYPE       : 9,   // I
  HOURLY_WAGE     : 10,  // J
  MONTHLY_WAGE    : 11,  // K
  DEFAULT_LUNCH   : 12,  // L
  WORK_DAYS       : 13,  // M
  ADMIN_ROLE      : 14,  // N
  LOCATION        : 15,  // O
  JOB_TYPE        : 16,  // P
  INS_HEALTH      : 17,  // Q
  INS_CARE        : 18,  // R
  INS_PENSION     : 19,  // S
  INS_EMPLOYMENT  : 20,  // T
  CREATED_AT      : 21,  // U
  UPDATED_AT      : 22,  // V
  DELETED         : 23,  // W
};
const EMPLOYEE_NUM_COLS = 23;


// ============================================================
// エントリポイント
// ============================================================

/**
 * POST リクエストを受け取る唯一のエントリポイント。
 *
 * フロントエンドから送られてくる JSON:
 *   { "app": "attendance", "action": "save", "data": { ... } }
 *
 * @param {Object} e - GAS が渡すイベントオブジェクト
 * @returns {ContentService.TextOutput} JSON レスポンス
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const { app, action, data } = payload;

    Logger.log('[doPost] app=%s, action=%s', app, action);

    if (app !== VALID_APP) {
      return createErrorResponse('アプリ識別子が不正です。', 'Invalid app: ' + app);
    }

    if (!action || !VALID_ACTIONS.includes(action)) {
      return createErrorResponse('操作が不正です。', 'Invalid action: ' + action);
    }

    return handleAttendance(action, data || {});

  } catch (err) {
    Logger.log('[doPost] Unexpected error: %s', err.message);
    return createErrorResponse('サーバーエラーが発生しました。', err.message);
  }
}


// ============================================================
// ルーティング
// ============================================================

/**
 * action を見て対応する実装ファイルの関数へ振り分ける。
 *
 * 振り分けルール:
 *   認証              → AuthService.gs の handleAuthAction()
 *   出退勤記録        → AttendanceService.gs の handleAttendanceAction()
 *   人員マスタ        → EmployeeService.gs の handleEmployeeAction()
 *   日報              → DailyReportService.gs の handleDailyReportAction()
 *   タスク（v2）      → TaskService.gs の handleTaskAction()
 *   案件・相談・通知  → ProjectService.gs の handleProjectActionV2()
 *   Admin系           → AdminServices.gs の handleAdminAction()
 *
 * Code.gs はルーティング専用。個別の実装は持たない
 * （段階的縮小：Attendance → Employee → Auth の順で分離済み）。
 *
 * @param {string} action - 操作名
 * @param {Object} data   - リクエストデータ
 * @returns {ContentService.TextOutput} JSON レスポンス
 */
function handleAttendance(action, data) {
  const ss              = SpreadsheetApp.getActiveSpreadsheet();
  const attendanceSheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  const employeeSheet   = getOrCreateSheet(ss, SHEET.EMPLOYEES);

  try {
    switch (action) {

      // ── AuthService.gs（認証） ───────────────────────────────
      case 'authenticate':
      case 'kintai_authenticate':
        return handleAuthAction(action, data, employeeSheet);

      // ── AttendanceService.gs（出退勤記録） ───────────────────
      case 'save':
      case 'load':
      case 'load_range':
      case 'load_daily':
      case 'delete':
        return handleAttendanceAction(action, data, attendanceSheet);

      // ── EmployeeService.gs（人員マスタ） ──────────────────────
      case 'save_employee':
      case 'load_employees':
      case 'delete_employee':
        return handleEmployeeAction(action, data, employeeSheet);

      // ── 集計・ビュー生成（Services.gs）───────────────────────
      case 'monthly_report':
        return createSuccessResponse(
          generateMonthlyReport(attendanceSheet, employeeSheet, data.year_month)
        );

      case 'export_view':
        return createSuccessResponse(
          exportViewSheets(attendanceSheet, employeeSheet, data.year_month)
        );

      // ── Admin系（AdminServices.gs に委譲）────────────────────
      case 'admin_dashboard':
      case 'admin_attendance_list':
      case 'admin_edit_attendance':
      case 'admin_add_attendance':
      case 'admin_clear_attendance_field':
      case 'admin_staff_list':
      case 'admin_add_staff':
      case 'admin_update_staff':
      case 'admin_delete_staff':
      case 'submit_request':
      case 'get_my_requests':
      case 'admin_requests':
      case 'admin_update_request':
      case 'admin_edit_request':
      case 'save_attendance_status':
      case 'get_calendar':
      case 'get_company_calendar':
      case 'save_company_calendar':
      case 'get_tasks':          // 旧個人タスク（AdminServices.gs が管理）
      case 'upsert_task':
      case 'delete_task':
      case 'admin_all_tasks':
      case 'get_deadlines':
      case 'upsert_deadline':
      case 'delete_deadline':
      case 'get_my_status':
      case 'admin_monthly_fillup':
      case 'payroll_calculate':
      case 'payroll_load_settings':
      case 'payroll_save_settings':
      case 'payroll_save_incentive':
      case 'create_overtime_instruction':
      case 'admin_overtime_instructions':
      case 'update_overtime_instruction_status':
      case 'delete_overtime_instruction':
      case 'submit_overtime_request':
      case 'admin_approve_overtime_request':
      case 'admin_reject_overtime_request':
      case 'get_overtime_instructions':
      case 'check_missing_clocks':
      case 'check_missing_clocks_monthly':
      case 'get_my_missing_clocks':
        return handleAdminAction(action, data, attendanceSheet, employeeSheet);

      // ── テストデータ管理（開発用・本番では使用禁止）──────────
      case 'reset_test_data':
        return createSuccessResponse(resetTestData());

      case 'bulk_insert_dummy':
        return createSuccessResponse(bulkInsertDummyAttendance(data.year_month || null));

      // ── DailyReportService.gs（日報）───────────────────────
      case 'save_daily_report':
      case 'get_daily_report':
        return handleDailyReportAction(action, data);

      // ── TaskService.gs v2（tasks シート一本化）────────────────
      // タスクに関するすべての処理を TaskService.gs に委譲する。
      // PROJECT_TASKS シートは廃止済み。旧アクション（upsert_project_task 等）
      // は削除済みのため、フロントも新アクションへ移行すること。
      case 'get_my_tasks':
      case 'get_tasks_by_project':
      case 'get_all_tasks':
      case 'get_task_detail':
      case 'upsert_task_v2':
      case 'update_task_status':
      case 'review_approve':
      case 'review_reject':
      case 'delete_task_v2':
      case 'get_task_history':
      case 'assign_task_user':
      case 'unassign_task_user':
        return handleTaskAction(action, data);

      // ── ProjectService.gs v2（顧客・案件・メンバー・相談・通知）
      // 旧 ProjectServices.gs は廃止済み。
      // 旧アクション（get_project_tasks / upsert_project_task 等）は
      // TaskService に移行済みのためここには存在しない。
      case 'get_review_waiting_tasks':  // レビュー待ちタスク一覧（職員ホーム用）
      case 'get_customers':
      case 'upsert_customer':
      case 'delete_customer':
      case 'get_projects':
      case 'upsert_project':
      case 'update_project_status':
      case 'delete_project':
      case 'get_project_members':
      case 'add_project_member':
      case 'remove_project_member':
      case 'get_task_comments':
      case 'add_task_comment':
      case 'get_consultations_v2':
      case 'get_consultation_list':     // get_consultations_v2 のエイリアス
      case 'send_consultation':
      case 'resolve_consultation':
      case 'change_consultation_status':// resolve_consultation のエイリアス
      case 'reply_consultation':        // 相談への返信
      case 'mark_consultation_read':    // 相談の既読更新
      case 'get_notifications':
      case 'mark_notification_read':
      case 'mark_all_notifications_read':
      case 'get_phase_templates':
      case 'upsert_phase_template':
      case 'delete_phase_template':
      case 'project_dashboard':
      case 'get_project_masters':
        return handleProjectActionV2(action, data);

      default:
        throw new Error('Unhandled action: ' + action);
    }

  } catch (err) {
    Logger.log('[handleAttendance] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 共通ユーティリティ（時刻変換）
//
// _safeTimeStr は AttendanceService.gs（rowToAttendanceRecord）と
// EmployeeService.gs（rowToEmployee）の両方から参照される共通関数のため、
// どちらのサービスにも属さずこの Code.gs に残している。
// ============================================================

/**
 * GAS から返ってきた時刻値を安全な 'HH:MM' 文字列に変換する。
 *
 * GAS はスプレッドシートの時刻セルを Date オブジェクトとして返すことがある。
 * その際、年が 1899 になる（1899-12-30 問題）。
 *
 * @param {Date|string|*} raw
 * @returns {string} 'HH:MM' または ''
 */
function _safeTimeStr(raw) {
  if (!raw) return '';

  if (raw instanceof Date) {
    if (raw.getFullYear() < 1900) return '';
    return String(raw.getHours()).padStart(2, '0') + ':' + String(raw.getMinutes()).padStart(2, '0');
  }

  if (typeof raw === 'string') {
    if (raw.startsWith('1899')) return '';
    if (/^\d{1,2}:\d{2}/.test(raw)) return raw.slice(0, 5);
    if (raw.includes('T')) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    }
  }

  return '';
}


// ============================================================
// 共通ユーティリティ
// ============================================================

/**
 * 成功レスポンスを生成して返す。
 *
 * @param {Object} data
 * @returns {ContentService.TextOutput}
 */
function createSuccessResponse(data) {
  const response = { success: true, data };
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * エラーレスポンスを生成して返す。
 * error_message はそのまま画面に表示できる日本語メッセージ。
 * error_detail は開発者向け（ユーザーには見せない）。
 *
 * @param {string} message
 * @param {string} [detail='']
 * @returns {ContentService.TextOutput}
 */
function createErrorResponse(message, detail) {
  const response = {
    success       : false,
    error_message : message,
    error_detail  : detail || '',
  };
  Logger.log('[createErrorResponse] %s | %s', message, detail || '');
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * UUID v4 を生成する。
 *
 * @returns {string}
 */
function generateId() {
  return Utilities.getUuid();
}

/**
 * 指定した名前のシートを取得し、存在しない場合は作成する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} sheetName
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateSheet(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (sheet) return sheet;

  const newSheet = ss.insertSheet(sheetName);
  addSheetHeader(newSheet, sheetName);
  Logger.log('[getOrCreateSheet] Created sheet: %s', sheetName);
  return newSheet;
}

/**
 * シートの種類に応じてヘッダー行を追加する。
 * 新規シートのヘッダーはここで定義する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} sheetName
 */
function addSheetHeader(sheet, sheetName) {
  const headers = {
    [SHEET.ATTENDANCE] : [
      '記録ID','個人ID','日付',
      '勤怠区分','出勤時刻','退勤時刻',
      '休憩(分)','実働(分)','弁当',
      'メモ','更新日',
    ],
    [SHEET.EMPLOYEES] : [
      'ID','姓','名','PIN','パスワード',
      '雇用形態','所定始業時刻','所定終業時刻',
      '給与形態','時給(円)','月給(円)','弁当デフォルト','勤務曜日','管理権限',
      '拠点','職種','健康保険','介護保険','厚生年金','雇用保険',
      '登録日時','更新日時','論理削除',
    ],
    [SHEET.BACKUP] : ['timestamp', 'app', 'id', 'data'],
  };

  if (headers[sheetName]) {
    sheet.getRange(1, 1, 1, headers[sheetName].length).setValues([headers[sheetName]]);
  }
}

/**
 * シートの全データ行を取得する（ヘッダー行を除く）。
 * date 列は getAllRows 内で文字列に正規化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array[]}
 */
function getAllRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  // シートによって読み込む列数を明示的に指定する
  // （getLastColumn() を使うと空列が混入した場合に余分な列を読む恐れがあるため）
  let numCols;
  switch (sheet.getName()) {
    case SHEET.ATTENDANCE:
      numCols = ATTENDANCE_NUM_COLS;
      break;
    case SHEET.EMPLOYEES:
      numCols = EMPLOYEE_NUM_COLS;
      break;
    case SHEET.REQUESTS:
      numCols = REQ_NUM_COLS; // AdminServices.gs で定義
      break;
    default:
      numCols = sheet.getLastColumn();
  }

  // 実際の列数を超えた getRange は GAS が例外を投げるため上限を設ける
  const actualCols = sheet.getLastColumn();
  if (actualCols === 0) return [];
  numCols = Math.min(numCols, actualCols);

  const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  // 出退勤記録の date 列を文字列に正規化する
  if (sheet.getName() === SHEET.ATTENDANCE) {
    return values.map(row => {
      row[ATTENDANCE_COL.DATE - 1] = formatDateToString(row[ATTENDANCE_COL.DATE - 1]);
      return row;
    });
  }

  // 会社カレンダーの日付列を文字列に正規化する
  if (sheet.getName() === SHEET.COMPANY_CAL) {
    return values.map(row => {
      row[0] = formatDateToString(row[0]);
      return row;
    });
  }

  return values;
}

/**
 * Date オブジェクトまたは文字列を YYYY/MM/DD 形式の文字列に変換する。
 * GAS はスプレッドシートの日付セルを Date オブジェクトとして返すことがある。
 *
 * @param {string|Date} value
 * @returns {string} YYYY/MM/DD
 */
function formatDateToString(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
  return String(value).replace(/-/g, '/');
}

/**
 * JSON 文字列を安全にパースする。
 * パース失敗時はデフォルト値を返す。
 *
 * @param {string} jsonStr
 * @param {*} defaultValue
 * @returns {*}
 */
function safeJsonParse(jsonStr, defaultValue) {
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    return defaultValue;
  }
}

/**
 * 日付文字列が YYYY-MM-DD または YYYY/MM/DD 形式かを検証する。
 *
 * @param {string} dateStr
 */
function validateDateFormat(dateStr) {
  if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(dateStr)) {
    throw new Error('日付は YYYY-MM-DD または YYYY/MM/DD 形式で指定してください: ' + dateStr);
  }
}

/**
 * フロントから受け取った YYYY-MM-DD をスプシ保存用の YYYY/MM/DD に変換する。
 *
 * @param {string} dateStr - YYYY-MM-DD または YYYY/MM/DD
 * @returns {string} YYYY/MM/DD
 */
function convertDateForDisplay(dateStr) {
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(dateStr)) return dateStr;
  return dateStr.replace(/-/g, '/');
}


// ============================================================
// バックアップ
// ============================================================

/**
 * 変更前のデータを _バックアップ シートに記録する。
 * バックアップ失敗はメイン処理に影響させないため try/catch で握り潰す。
 *
 * @param {string} app
 * @param {string} id
 * @param {Array}  data
 */
function saveBackup(app, id, data) {
  try {
    const ss        = SpreadsheetApp.getActiveSpreadsheet();
    const sheet     = getOrCreateSheet(ss, SHEET.BACKUP);
    const timestamp = new Date().toISOString();
    const newRowNum = sheet.getLastRow() + 1;

    sheet.getRange(newRowNum, 1, 1, 4).setValues([
      [timestamp, app, id, JSON.stringify(data)]
    ]);

    Logger.log('[saveBackup] Saved: app=%s, id=%s', app, id);

    // 上限超過時は最古の1行を削除する
    const lastRow = sheet.getLastRow();
    if (lastRow > BACKUP_MAX_ROWS + 1) {
      sheet.deleteRow(2);
      Logger.log('[saveBackup] Trimmed oldest backup row.');
    }

  } catch (err) {
    Logger.log('[saveBackup] Failed (non-critical): %s', err.message);
  }
}


// ============================================================
// マイグレーション
// ============================================================

/**
 * 出退勤記録シートを新しい列構成にリセットする。
 * GAS エディタから1回だけ手動実行する。
 *
 * @returns {void}
 */
function migrateAttendanceSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);

  Logger.log('[migrateAttendanceSheet] 開始: シート "%s"', SHEET.ATTENDANCE);

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.deleteRows(2, lastRow - 1);
    Logger.log('[migrateAttendanceSheet] %d 行削除完了', lastRow - 1);
  }

  addSheetHeader(sheet, SHEET.ATTENDANCE);
  Logger.log('[migrateAttendanceSheet] ヘッダー更新完了（11列）');

  saveBackup('migration', 'attendance_sheet_reset',
    ['migrate', new Date().toISOString(), 'old: 5cols → new: 11cols']);

  SpreadsheetApp.flush();
  Logger.log('[migrateAttendanceSheet] 完了');
}

