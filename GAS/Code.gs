/**
 * Code.gs - 勤怠管理システム メインファイル
 *
 * 役割:
 *   - POSTリクエストの受付（doPost）
 *   - app / action によるルーティング（実装は各 Service.gs に委譲）
 *   - シート定数・共通ユーティリティ（成功/エラーレスポンス生成、UUID生成、
 *     シート取得・初期化、日付フォーマット、JSONパース等）
 *
 * 設計方針:
 *   - GASプロジェクトは1つ。エントリポイントは doPost のみ
 *   - すべての例外は try/catch で捕捉し createErrorResponse に変換する
 *   - 日付はすべて YYYY-MM-DD 文字列で統一（Date オブジェクト不使用）
 *   - upsert は employee_id + date の複合キーで検索してから書き込む
 *   - 削除は物理削除（複数削除時は後ろの行から順に実行）
 *   - 本ファイルはルーティング専任とし、機能ごとの実装は各 Service.gs に置く
 *     （GAS は同一プロジェクト内でグローバル参照が効くため import 不要）
 *
 * 日付の扱いについて:
 *   GAS は appendRow / setValues で 'YYYY-MM-DD' 文字列を渡しても
 *   自動的に Date オブジェクトとして解釈・保存する。
 *   これを防ぐため、出退勤記録の date 列（C列）への書き込みは
 *   appendRowを使わず setValues に統一し、書き込み前に
 *   該当セルを setNumberFormat('@') でテキスト形式に指定してから書く。
 *   読み込み時は formatDateToString() で念のため正規化する。
 *
 * スプレッドシート構成:
 *   - 出退勤記録     : 日次出退勤記録
 *   - 人員マスタ     : 職員・利用者マスタ（employment_type で区別）
 *   - 勤務区分マスタ  : シフト・勤務区分マスタ（Phase 2 以降で実装）
 *   - _バックアップ  : 変更前データの自動バックアップ
 *
 * 人員マスタ 列構成（Migration.gs でフラット化済み）:
 *   A(1)  : ID             - UUID
 *   B(2)  : 姓             - 苗字（例: 住岡）
 *   C(3)  : 名             - 名前（例: 太郎）
 *   D(4)  : PIN            - ログイン用4桁数字（文字列として保存）
 *   E(5)  : パスワード     - 文字列として保存
 *   F(6)  : 雇用形態
 *   G(7)  : 所定労働時間
 *   H(8)  : 所定始業時刻
 *   I(9)  : 所定終業時刻
 *   J(10) : 所定休憩時間(分)
 *   K(11) : 給与形態
 *   L(12) : 時給(円)
 *   M(13) : 月給(円)
 *   N(14) : 弁当デフォルト
 *   O(15) : 勤務曜日       - カンマ区切り文字列
 *   P(16) : 管理権限       - '可' | '不可'
 *   Q(17) : 登録日時
 *   R(18) : 更新日時
 *
 * 変更履歴:
 *   v1.4.0: 氏名列を「姓」「名」2列に分割。PIN/PW を文字列強制保存に修正。
 *           時刻列（所定始業・終業）に setNumberFormat('@') を追加し 1899-12-30 問題を解消。
 *   v2.0.0: 【2026-07-30 全面改訂】GASバックエンドの重複解消・機能一本化・ファイル分割。
 *           - 人員マスタCRUD・認証の実装を EmployeeService.gs / AuthService.gs に一本化し、
 *             Code.gs 内の重複コピー（rowToEmployee/saveEmployee/loadEmployees/
 *             deleteEmployee/_setEmployeeTextFormat/authenticateEmployee/
 *             authenticateKintaiEmployee）を削除した。
 *           - safeJsonParse は Code.gs に一本化（AdminOpsService.gs 側の重複を削除）。
 *           - 巨大化していた Adminservice.gs（2934行）を AdminOpsService.gs /
 *             RequestService.gs / CalendarService.gs / DeadlineService.gs /
 *             OvertimeService.gs / AttendanceAlertService.gs の6ファイルに分割し、
 *             Adminservice.gs 自体は削除した。
 *           - 旧タスク管理（get_tasks/upsert_task/delete_task/admin_all_tasks、
 *             タスク管理シート）を全廃し、TaskService.gs の新タスク管理v2
 *             （tasks / task_assignments / task_histories シート）に一本化した。
 *           - 給与計算を Payroll.gs の精密計算版（社会保険・所得税・インセンティブ込み）
 *             に一本化した。アクション名は維持し実装先のみ差し替えた。
 *           - TaskService.gs / ProjectService.gs（v2） / DailyReportService.gs /
 *             AccountService.gs（新規）を doPost のルーティングに配線した。
 *           - 案件管理系（顧客・案件・相談・通知・フェーズテンプレート）で
 *             参照されるが未定義だった SHEET 定数（CUSTOMERS/PROJECTS/
 *             CONSULTATIONS/NOTIFICATIONS/PHASE_TEMPLATES）と、新規
 *             AccountService.gs 用の SHEET.ACCOUNTS を追加した。
 *           - admin_delete_request / cancel_request が VALID_ACTIONS 未登録で
 *             呼び出せなかったバグを修正した。
 *           - admin_attendance_list の呼び出し引数の不一致（ss が誤って
 *             attendanceSheet に渡り、実データが渡らず必ず例外になっていた）を修正した
 *             （AdminOpsService.gs 側で修正）。
 *           - 旧 ProjectServices.gs（v1・PROJECT_TASKS/WORK_MEMOS等）を削除した。
 *             ProjectService.gs（v2）と同名関数（getCustomers/getProjects/
 *             upsertProject 等）が重複定義されており、ファイル読み込み順によって
 *             v1実装がv2実装を上書きしてしまう不具合があったため。
 *
 * @version 2.0.0
 * @author  田中沙亜
 */

// ============================================================
// 定数
// ============================================================

/** 対応する app 識別子 */
const VALID_APP = 'attendance';

/** 対応する action 一覧 */
const VALID_ACTIONS = [
  // ── 認証・人員マスタ ──
  'authenticate',       // Admin/Portal用：admin_role が空でない職員のみ通す
  'kintai_authenticate', // Kintai/Staff用：is_adminチェックなし・職員であれば誰でも通す
  'save',
  'load',
  'load_range',
  'load_daily',
  'delete',
  'save_employee',
  'load_employees',
  'delete_employee',
  'monthly_report',
  'export_view',

  // ── Admin: ダッシュボード ──
  'admin_dashboard',

  // ── Admin: 勤怠管理 ──
  'admin_attendance_list',
  'admin_edit_attendance',
  'admin_add_attendance',
  'admin_clear_attendance_field', // 出勤 or 退勤時刻を単独でクリアする（v3.0.0〜）

  // ── Admin: スタッフ管理 ──
  'admin_staff_list',
  'admin_add_staff',
  'admin_update_staff',
  'admin_delete_staff',

  // ── 申請管理 ──
  'submit_request',
  'get_my_requests',
  'admin_requests',
  'admin_update_request',
  // Admin が申請内容（種別・対象日・時刻・理由・ステータス）を直接編集するアクション。
  'admin_edit_request',
  // Admin が申請を物理削除する（誤登録・不要データの削除用）。
  'admin_delete_request',
  // スタッフが自分の pending 申請を取り下げる（cancelled 状態に変更）。
  'cancel_request',
  // Admin が「欠席・在宅・外出」を申請管理シートに直接登録するアクション。
  'save_attendance_status',

  // ── カレンダー ──
  'get_calendar',
  'get_company_calendar',
  'save_company_calendar',

  // ── 納期管理 ──
  'get_deadlines',
  'upsert_deadline',
  'delete_deadline',

  // ── 月次・補填 ──
  'get_my_status',
  'admin_monthly_fillup',

  // ── 給与計算 ──
  'payroll_calculate',
  'payroll_load_settings',
  'payroll_save_settings',
  'payroll_save_incentive',

  // ── テストデータ管理（本番運用前のみ使用）──
  'reset_test_data',
  'bulk_insert_dummy',

  // ── 残業指示 ──
  'create_overtime_instruction',
  'admin_overtime_instructions',
  'update_overtime_instruction_status',
  'delete_overtime_instruction',
  'submit_overtime_request',
  'admin_approve_overtime_request',
  'admin_reject_overtime_request',
  'get_overtime_instructions',

  // ── 打刻漏れ警告 ──
  'check_missing_clocks',
  'check_missing_clocks_monthly',
  'get_my_missing_clocks',

  // ── タスク管理v2（TaskService.gs）──
  'get_my_tasks',
  'get_tasks_by_project',
  'get_all_tasks',
  'get_task_detail',
  'upsert_task_v2',
  'update_task_status',
  'review_approve',
  'review_reject',
  'delete_task_v2',
  'get_task_history',
  'assign_task_user',
  'unassign_task_user',

  // ── 案件・顧客・相談・通知・フェーズテンプレートv2（ProjectService.gs）──
  'get_customers',
  'upsert_customer',
  'delete_customer',
  'get_projects',
  'upsert_project',
  'update_project_status',
  'delete_project',
  'get_project_members',
  'add_project_member',
  'remove_project_member',
  'get_task_comments',
  'add_task_comment',
  'get_review_waiting_tasks',
  'get_consultations_v2',
  'get_consultation_list',
  'send_consultation',
  'resolve_consultation',
  'change_consultation_status',
  'reply_consultation',
  'mark_consultation_read',
  'get_notifications',
  'mark_notification_read',
  'mark_all_notifications_read',
  'get_phase_templates',
  'upsert_phase_template',
  'delete_phase_template',
  'project_dashboard',
  'get_project_masters',

  // ── 日報（DailyReportService.gs）──
  'save_daily_report',
  'get_daily_report',

  // ── アカウント管理（AccountService.gs、管理者のみ）──
  'get_accounts',
  'save_account',
  'delete_account',
];

/** シート名（日本語）*/
const SHEET = {
  ATTENDANCE      : '出退勤記録',
  EMPLOYEES       : '人員マスタ',
  BACKUP          : '_バックアップ',
  REQUESTS        : '申請管理',        // 休み・遅刻・早退・補填の申請記録
  COMPANY_CAL     : '会社カレンダー',  // 会社休日・行事の登録
  TASKS           : 'タスク管理',      // 【廃止】旧タスク管理v1。新v2は Shared.gs の SHEET_V2.TASKS('tasks') を使う
  DEADLINES       : '納期管理',        // 案件・納期管理
  PAYROLL_SETTINGS: '給与設定',        // 社保率・残業率・弁当代など
  INCENTIVES      : 'インセンティブ',  // 月次インセンティブ
  AUDIT_LOG       : '操作ログ',        // 管理者操作の監査ログ
  OVERTIME_INST   : '残業指示',        // 残業指示管理

  // ── v2.0.0 追加: 制作進行管理（ProjectService.gs）が参照するシート名 ──
  // 【2026-07-30】これらは ProjectService.gs / 旧ProjectServices.gs から
  // 参照されていたが Code.gs 側に定義がなく、getOrCreateSheet(ss, undefined) と
  // なって動作しない状態だった。ProjectService.gs を配線するにあたり追加した。
  CUSTOMERS       : '顧客マスタ',        // 顧客マスタ
  PROJECTS        : '案件管理',          // 案件
  CONSULTATIONS   : '相談',              // 相談v2
  NOTIFICATIONS   : '通知',              // 通知
  PHASE_TEMPLATES : 'フェーズテンプレート', // フェーズテンプレート

  // ── v2.0.0 追加: アカウント管理（AccountService.gs、新規）──
  ACCOUNTS        : 'アカウント管理',
};

/** バックアップの最大保持件数（超えたら最古の1行を削除） */
const BACKUP_MAX_ROWS = 1000;

/**
 * 出退勤記録シートの列番号定数（1始まり）。
 *
 * 列番号をハードコードすると列追加のたびに全箇所を修正する必要が生じる。
 * ここに集約することで変更箇所を1箇所に限定する。
 *
 * 列構成:
 *   A(1): id          - レコード識別子（UUID）
 *   B(2): employee_id - 職員識別子（UUID）
 *   C(3): date        - 勤務日（YYYY-MM-DD テキスト形式）
 *   D(4): status      - 勤怠区分（出勤 / 遅刻 / 早退 / 欠勤 / 休日）
 *   E(5): time_in     - 出勤時刻（HH:MM）
 *   F(6): time_out    - 退勤時刻（HH:MM）
 *   G(7): break_minutes - 休憩時間（分）
 *   H(8): work_minutes  - 実働時間（分）
 *   I(9): lunch       - 弁当要否（有 / 無）
 *   J(10): memo       - メモ・業務内容
 *   K(11): updated_at - 最終更新日時（ISO 8601）
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

/** 出退勤記録シートの総列数（ATTENDANCE_COL の最大値と一致させる） */
const ATTENDANCE_NUM_COLS = 11;

/**
 * 人員マスタ（人員マスタシート）の列番号定数（1始まり）。
 *
 * 列番号をハードコードすると列追加のたびに全箇所を修正する必要が生じる。
 * ここに集約することで変更箇所を1箇所に限定する。
 *
 * 列構成（スプレッドシートの実際の並び順と必ず一致させること）:
 *   A(1)  : ID              - UUID
 *   B(2)  : 姓              - 苗字（例: 住岡）
 *   C(3)  : 名              - 名前（例: 太郎）
 *   D(4)  : PIN             - ログイン用4桁数字（文字列として保存）
 *   E(5)  : パスワード      - 文字列として保存
 *   F(6)  : 雇用形態        - '職員' | '利用者'
 *   G(7)  : 所定労働時間    - 数値（時間）
 *   H(8)  : 所定始業時刻    - HH:MM（テキスト形式で保存）
 *   I(9)  : 所定終業時刻    - HH:MM（テキスト形式で保存）
 *   J(10) : 所定休憩時間(分) - 数値（分）
 *   K(11) : 給与形態        - '時給' | '月給'
 *   L(12) : 時給(円)        - 数値
 *   M(13) : 月給(円)        - 数値
 *   N(14) : 弁当デフォルト  - '有' | '無'
 *   O(15) : 勤務曜日        - カンマ区切り文字列（例: '月,火,水'）
 *   P(16) : 管理権限        - '管理者' | '給与計算担当' | '一般職員' | ''
 *            空文字 = Admin ログイン不可の一般スタッフ
 *   Q(17) : 登録日時        - ISO 8601
 *   R(18) : 更新日時        - ISO 8601
 *
 * ⚠️ v1.4.0 変更点: 旧 B(2)「氏名」を B(2)「姓」C(3)「名」の2列に分割。
 *    以降の列番号がすべて+1ずれているため、既存のシートデータは
 *    migrateEmployeeSheet() で移行してから使用すること。
 *
 * ⚠️ 列を追加・変更した場合は必ずこの定数・EMPLOYEE_NUM_COLS・
 *    addSheetHeader の EMPLOYEES ヘッダー配列をセットで修正すること。
 */
// ============================================================
// 【重要】シートの実際の列構成に合わせた定義
//
// シート実態（人員マスタ・23列）:
//   A:ID  B:姓  C:名  D:PIN  E:パスワード  F:雇用形態
//   G:所定始業時刻  H:所定終業時刻
//   I:給与形態  J:時給(円)  K:月給(円)
//   L:弁当デフォルト  M:勤務曜日  N:管理権限
//   O:拠点  P:職種
//   Q:健康保険  R:介護保険  S:厚生年金  T:雇用保険
//   U:登録日時  V:更新日時  W:論理削除
//
// ※「所定労働時間」「所定休憩時間」列はシートに存在しない。
//    これらが必要な箇所では scheduled_start/end から計算する。
// ============================================================
const EMPLOYEE_COL = {
  ID              : 1,   // A: UUID
  LAST_NAME       : 2,   // B: 姓
  FIRST_NAME      : 3,   // C: 名
  PIN             : 4,   // D: PIN（文字列として照合）
  PASSWORD        : 5,   // E: パスワード
  EMPLOYMENT_TYPE : 6,   // F: 雇用形態（'職員' | '利用者'）
  SCHEDULED_START : 7,   // G: 所定始業時刻（HH:MM）
  SCHEDULED_END   : 8,   // H: 所定終業時刻（HH:MM）
  WAGE_TYPE       : 9,   // I: 給与形態（'時給' | '月給'）
  HOURLY_WAGE     : 10,  // J: 時給（円）
  MONTHLY_WAGE    : 11,  // K: 月給（円）
  DEFAULT_LUNCH   : 12,  // L: 弁当デフォルト（'有' | '無'）
  WORK_DAYS       : 13,  // M: 勤務曜日（カンマ区切り）
  ADMIN_ROLE      : 14,  // N: 管理権限（'管理者'|'給与計算担当'|'一般職員'|''）
  LOCATION        : 15,  // O: 拠点
  JOB_TYPE        : 16,  // P: 職種
  INS_HEALTH      : 17,  // Q: 健康保険（'加入' | '未加入'）
  INS_CARE        : 18,  // R: 介護保険（'加入' | '未加入'）
  INS_PENSION     : 19,  // S: 厚生年金（'加入' | '未加入'）
  INS_EMPLOYMENT  : 20,  // T: 雇用保険（'加入' | '未加入'）
  CREATED_AT      : 21,  // U: 登録日時（ISO 8601）
  UPDATED_AT      : 22,  // V: 更新日時（ISO 8601）
  DELETED         : 23,  // W: 論理削除（'true' | ''）
};

// シートに存在しない列の番号を -1 で明示する（参照時は必ずガードを入れること）
const EMPLOYEE_COL_MISSING = {
  SCHEDULED_HOURS : -1,  // シートに列なし → start/end から計算
  SCHEDULED_BREAK : -1,  // シートに列なし → 固定値または設定から取得
};

// ⚠️ 列追加時はこの値・addSheetHeader・saveEmployee も必ず更新する。
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
      return createErrorResponse(
        'アプリ識別子が不正です。',
        'Invalid app: ' + app
      );
    }

    if (!action || !VALID_ACTIONS.includes(action)) {
      return createErrorResponse(
        '操作が不正です。',
        'Invalid action: ' + action
      );
    }

    return handleAttendance(action, data || {});

  } catch (err) {
    Logger.log('[doPost] Unexpected error: %s', err.message);
    return createErrorResponse(
      'サーバーエラーが発生しました。',
      err.message
    );
  }
}

// ============================================================
// ルーティング
// ============================================================

/**
 * action を見て対応する実装関数へ振り分ける。
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

      // ── 認証（AuthService.gs）─────────────────────
      case 'authenticate':
      case 'kintai_authenticate':
        return handleAuthAction(action, data, employeeSheet);

      // ── 出退勤記録 CRUD ──────────────────────────
      // 実装は AttendanceService.gs の handleAttendanceAction() に完全委譲する。
      case 'save':
      case 'load':
      case 'load_range':
      case 'load_daily':
      case 'delete':
        return handleAttendanceAction(action, data, attendanceSheet);

      // ── 人員マスタ CRUD（EmployeeService.gs）───────
      case 'save_employee':
      case 'load_employees':
      case 'delete_employee':
        return handleEmployeeAction(action, data, employeeSheet);

      // ── 集計（Services.gs）────────────────────────
      case 'monthly_report':
        return createSuccessResponse(
          generateMonthlyReport(attendanceSheet, employeeSheet, data.year_month)
        );

      // ── ビューシート生成（Services.gs）────────────
      case 'export_view':
        return createSuccessResponse(
          exportViewSheets(attendanceSheet, employeeSheet, data.year_month)
        );

      // ── Admin系・申請・カレンダー・納期・残業・打刻漏れ・給与（AdminOpsService.gs 以下）──
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
      case 'admin_delete_request': // 【修正】VALID_ACTIONS未登録で呼び出せなかったバグを修正
      case 'cancel_request':       // 【修正】同上
      case 'save_attendance_status':
      case 'get_calendar':
      case 'get_company_calendar':
      case 'save_company_calendar':
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

      // ── タスク管理v2（TaskService.gs）─────────────
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

      // ── 案件・顧客・相談・通知・フェーズテンプレートv2（ProjectService.gs）──
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
      case 'get_review_waiting_tasks':
      case 'get_consultations_v2':
      case 'get_consultation_list':
      case 'send_consultation':
      case 'resolve_consultation':
      case 'change_consultation_status':
      case 'reply_consultation':
      case 'mark_consultation_read':
      case 'get_notifications':
      case 'mark_notification_read':
      case 'mark_all_notifications_read':
      case 'get_phase_templates':
      case 'upsert_phase_template':
      case 'delete_phase_template':
      case 'project_dashboard':
      case 'get_project_masters':
        return handleProjectActionV2(action, data);

      // ── 日報（DailyReportService.gs）──────────────
      case 'save_daily_report':
      case 'get_daily_report':
        return handleDailyReportAction(action, data);

      // ── アカウント管理（AccountService.gs、管理者のみ）──
      case 'get_accounts':
      case 'save_account':
      case 'delete_account':
        return handleAccountAction(action, data);

      // ── テストデータ管理（本番運用前のみ使用）──────────────
      case 'reset_test_data':
        return createSuccessResponse(resetTestData());

      case 'bulk_insert_dummy':
        return createSuccessResponse(
          bulkInsertDummyAttendance(data.year_month || null)
        );

      default:
        throw new Error('Unhandled action: ' + action);
    }

  } catch (err) {
    Logger.log('[handleAttendance] action=%s, error=%s', action, err.message);
    return createErrorResponse(
      '処理中にエラーが発生しました。',
      err.message
    );
  }
}

// ============================================================
// 出退勤記録 CRUD
// ============================================================
//
// 【2026-07-28 移管済み】
// 出退勤記録の save/load/load_range/load_daily/delete の実装は
// AttendanceService.gs の以下の関数に完全移管した。
//   saveAttendanceRecord / loadAttendanceRecord / loadAttendanceRange /
//   loadDailyAttendance / deleteAttendanceRecord / rowToAttendanceRecord
// Code.gs に同名関数を再定義しないこと（後勝ちの二重定義バグの原因になる）。
// ============================================================

// ============================================================
// 人員マスタ CRUD
// ============================================================
//
// 【2026-07-30 移管済み】
// 人員マスタの save_employee/load_employees/delete_employee の実装は
// EmployeeService.gs の以下の関数に完全移管した。
//   saveEmployee / loadEmployees / deleteEmployee / _setEmployeeTextFormat /
//   rowToEmployee
// 認証（authenticate/kintai_authenticate）は AuthService.gs の
// authenticateEmployee / authenticateKintaiEmployee に完全移管した。
// Code.gs に同名関数を再定義しないこと（後勝ちの二重定義バグの原因になる）。
// ============================================================

/**
 * GAS から返ってきた時刻値を安全な 'HH:MM' 文字列に変換する。
 *
 * 問題:
 *   スプレッドシートの時刻セルを GAS が読むと、
 *   元のデータが "HH:MM" 文字列でも Date オブジェクトとして返ることがある。
 *   その際、年が 1899 になる（いわゆる 1899-12-30 問題）。
 *
 * 対策:
 *   - Date 型で年が 1900 未満 → 空文字を返す（意味のないデータ）
 *   - Date 型で正常 → getHours()/getMinutes() でローカル時刻を取り出す
 *   - 文字列の "1899..." → 空文字を返す
 *   - 文字列の "HH:MM..." → 先頭5文字を返す
 *   - ISO 8601 文字列 → Date を経由してローカル時刻を取り出す
 *
 * 注意: EmployeeService.gs の rowToEmployee / AttendanceService.gs の
 * rowToAttendanceRecord からも参照される共通関数のため、本ファイルに残す。
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
 *
 * 人員マスタは Migration.gs でフラット化済みのため、
 * 新規作成時も日本語フラットヘッダーで初期化する。
 *
 * 案件管理系（顧客・案件・相談・通知・フェーズテンプレート）・アカウント管理・
 * タスク管理v2等の新規シートは、各 init*Sheet() 関数（Shared.gs /
 * ProjectService.gs / AccountService.gs 等）が getOrCreateSheet 呼び出し直後に
 * 個別に呼ばれてヘッダーを設定するため、ここには追加しない。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} sheetName
 */
function addSheetHeader(sheet, sheetName) {
  const headers = {
    // 出退勤記録: ATTENDANCE_COL の順序と必ず一致させること。
    [SHEET.ATTENDANCE] : [
      '記録ID', '個人ID', '日付',
      '勤怠区分', '出勤時刻', '退勤時刻',
      '休憩(分)', '実働(分)', '弁当',
      'メモ', '更新日',
    ],
    // 人員マスタ: EMPLOYEE_COL の順序と必ず一致させること（23列）
    [SHEET.EMPLOYEES]  : [
      'ID', '姓', '名', 'PIN', 'パスワード',
      '雇用形態', '所定始業時刻', '所定終業時刻',
      '給与形態', '時給(円)', '月給(円)', '弁当デフォルト', '勤務曜日', '管理権限',
      '拠点', '職種', '健康保険', '介護保険', '厚生年金', '雇用保険',
      '登録日時', '更新日時', '論理削除',
    ],
    [SHEET.BACKUP]     : ['timestamp', 'app', 'id', 'data'],
  };

  if (headers[sheetName]) {
    sheet.getRange(1, 1, 1, headers[sheetName].length).setValues([headers[sheetName]]);
  }
}

/**
 * シートの全データ行を取得する（ヘッダー行を除く）。
 * date 列は formatDateToString() で必ず文字列に正規化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array[]}
 */
function getAllRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  // シートによって読み込む列数を明示的に指定する。
  // sheet.getLastColumn() を使うと空列が混入した場合に余分な列を読む恐れがあるため。
  let numCols;
  switch (sheet.getName()) {
    case SHEET.ATTENDANCE:
      numCols = ATTENDANCE_NUM_COLS;
      break;
    case SHEET.EMPLOYEES:
      numCols = EMPLOYEE_NUM_COLS;
      break;
    case SHEET.REQUESTS:
      // v2.1.0マイグレーション後のシートは16列構造。REQ_NUM_COLS=16 を指定して全列を読む。
      // 旧シート（列数が少ない場合）は Math.min(16, actualCols) で安全にフォールバックする。
      numCols = REQ_NUM_COLS;
      break;
    default:
      numCols = sheet.getLastColumn();
  }

  // シートの実際の列数を超えた getRange は GAS が例外を投げる。
  const actualCols = sheet.getLastColumn();
  if (actualCols === 0) return []; // 空シート（ヘッダーもない）
  numCols = Math.min(numCols, actualCols);

  const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  // 出退勤記録シートは date 列（インデックス DATE-1）を文字列に正規化する。
  if (sheet.getName() === SHEET.ATTENDANCE) {
    return values.map(row => {
      row[ATTENDANCE_COL.DATE - 1] = formatDateToString(row[ATTENDANCE_COL.DATE - 1]);
      return row;
    });
  }

  // 会社カレンダーシートも日付列（A列=インデックス0）を文字列に正規化する。
  if (sheet.getName() === SHEET.COMPANY_CAL) {
    return values.map(row => {
      row[0] = formatDateToString(row[0]);
      return row;
    });
  }

  return values;
}

// rowToAttendanceRecord は AttendanceService.gs に移管済み（重複削除、2026-07-28）。

/**
 * Date オブジェクトまたは文字列を YYYY-MM-DD 形式の文字列に変換する。
 *
 * GAS はスプレッドシートの日付セルを Date オブジェクトとして返すことがある。
 * タイムゾーンの影響を避けるため getFullYear/getMonth/getDate を使う。
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
 * 【2026-07-30】AdminOpsService.gs（旧 Adminservice.gs）にも同名関数の
 * 重複定義があったため削除し、本ファイルに一本化した。
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
 * フロントから受け取った YYYY-MM-DD をスプシ表示用の YYYY/MM/DD に変換する。
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
 * _バックアップ の列構成:
 *   A: timestamp, B: app, C: id, D: data(JSON)
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
 *
 * 【実行タイミング】
 *   このファイルを GAS にデプロイした後、GAS エディタ上で
 *   この関数を1回だけ手動実行する。それ以降は実行不要。
 *
 * 【注意】
 *   - 実行すると既存の出退勤データはすべて削除される（復元不可）
 *   - 人員マスタ・バックアップ・勤務区分マスタは変更しない
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
  } else {
    Logger.log('[migrateAttendanceSheet] データ行なし。削除スキップ。');
  }

  addSheetHeader(sheet, SHEET.ATTENDANCE);
  Logger.log('[migrateAttendanceSheet] ヘッダー更新完了（11列）');

  saveBackup(
    'migration',
    'attendance_sheet_reset',
    ['migrate', new Date().toISOString(), 'old: 5cols → new: 11cols']
  );

  SpreadsheetApp.flush();
  Logger.log('[migrateAttendanceSheet] 完了。出退勤記録シートが新形式にリセットされました。');
}
