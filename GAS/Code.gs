/**
 * Code.gs - 勤怠管理システム メインファイル
 *
 * 役割:
 *   - POSTリクエストの受付（doPost）
 *   - app / action によるルーティング
 *   - 人員マスタ CRUD の実装
 *   - 出退勤記録 CRUD は AttendanceService.gs へ委譲（2026-07-28 移管）
 *
 * 設計方針:
 *   - GASプロジェクトは1つ。エントリポイントは doPost のみ
 *   - すべての例外は try/catch で捕捉し createErrorResponse に変換する
 *   - 日付はすべて YYYY-MM-DD 文字列で統一（Date オブジェクト不使用）
 *   - upsert は employee_id + date の複合キーで検索してから書き込む
 *   - 削除は物理削除（複数削除時は後ろの行から順に実行）
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
 *
 * @version 1.4.0
 * @author  田中沙亜
 */

// ============================================================
// 定数
// ============================================================

/** 対応する app 識別子 */
const VALID_APP = 'attendance';

/** 対応する action 一覧 */
const VALID_ACTIONS = [
  // ── 既存アクション ──
  'authenticate',       // Admin用：admin_role が空でない職員のみ通す（v3.0.0〜）
  'kintai_authenticate', // Kintai用：is_adminチェックなし・職員であれば誰でも通す
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
  // 不正入力（202605-05-11 等）を GAS 側でも再バリデーションして弾く。
  'admin_edit_request',
  // Admin が「欠席・在宅・外出」を申請管理シートに直接登録するアクション。
  // 当日の体調変化に応じて上書き登録できるよう upsert 設計とする。
  'save_attendance_status',

  // ── カレンダー ──
  'get_calendar',
  'get_company_calendar',
  'save_company_calendar',

  // ── タスク管理 ──
  'get_tasks',
  'upsert_task',
  'delete_task',
  'admin_all_tasks',

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
  // 本番環境では使用しないこと。フロントのUIから実行する。
  'reset_test_data',
  'bulk_insert_dummy',

  // ── 残業指示 ──
  'create_overtime_instruction',       // Admin が残業指示を直接作成
  'admin_overtime_instructions',       // Admin が残業指示一覧を取得
  'update_overtime_instruction_status',// スタッフが承認/却下
  'delete_overtime_instruction',       // Admin が残業指示を削除
  'submit_overtime_request',           // Kintai: 残業申請を送信
  'admin_approve_overtime_request',    // Admin: 残業申請を承認
  'admin_reject_overtime_request',     // Admin: 残業申請を却下
  'get_overtime_instructions',         // スタッフが自分の残業指示を取得

  // ── 打刻漏れ警告 ──
  'check_missing_clocks',              // 指定日付の打刻漏れを検出
  'check_missing_clocks_monthly',      // 指定月全体の打刻漏れを検出（Admin月次確認用）
  'get_my_missing_clocks',             // スタッフが自分の打刻漏れを取得

  // ── ダッシュボード（Notion埋め込み用・閲覧専用） ──
  'get_dashboard_summary',             // 出退勤・タスク・申請の状況を集計して返す
];

/** シート名（日本語）*/
const SHEET = {
  ATTENDANCE      : '出退勤記録',
  EMPLOYEES       : '人員マスタ',
  BACKUP          : '_バックアップ',
  REQUESTS        : '申請管理',        // 休み・遅刻・早退・補填の申請記録
  COMPANY_CAL     : '会社カレンダー',  // 会社休日・行事の登録
  TASKS           : 'タスク管理',      // 個人タスク
  DEADLINES       : '納期管理',        // 案件・納期管理
  PAYROLL_SETTINGS: '給与設定',        // 社保率・残業率・弁当代など
  INCENTIVES      : 'インセンティブ',  // 月次インセンティブ
  AUDIT_LOG       : '操作ログ',        // 管理者操作の監査ログ
  OVERTIME_INST   : '残業指示',        // 残業指示管理
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

      // ── 認証 ─────────────────────────────────────

      // Admin用認証：is_admin === true の職員のみ通す（Admin.html から呼ばれる）
      case 'authenticate':
        return createSuccessResponse(
          authenticateEmployee(employeeSheet, data.pin, data.password)
        );

      // Kintai用認証：職員であれば is_admin を問わず通す（kintai.html から呼ばれる）
      // Admin用とは別アクションにすることで、フロントからの source フラグ偽装を防ぐ
      case 'kintai_authenticate':
        return createSuccessResponse(
          authenticateKintaiEmployee(employeeSheet, data.pin, data.password)
        );

      // ── 出退勤記録 CRUD ──────────────────────────
      // 実装は AttendanceService.gs の handleAttendanceAction() に完全委譲する。
      // 【2026-07-28】以前はここに実装が直接書かれており、AttendanceService.gs
      // 側の同名関数と二重定義になっていた（後勝ちの不定動作リスクがあったため解消済み）。
      case 'save':
      case 'load':
      case 'load_range':
      case 'load_daily':
      case 'delete':
        return handleAttendanceAction(action, data, attendanceSheet);

      // ── 人員マスタ CRUD ───────────────────────────
      case 'save_employee':
        return createSuccessResponse(
          saveEmployee(employeeSheet, data)
        );

      case 'load_employees':
        return createSuccessResponse(
          loadEmployees(employeeSheet)
        );

      case 'delete_employee':
        return createSuccessResponse(
          deleteEmployee(employeeSheet, data.id)
        );

      // ── 集計（Services.gs）────────────────────────
      case 'monthly_report':
        return createSuccessResponse(
          generateMonthlyReport(attendanceSheet, employeeSheet, data.year_month)
        );

      // ── ビューシート生成（Services.gs）────────────
      // 管理者HTMLから手動実行。指定月の日次打刻シートを職員・利用者別に生成する。
      case 'export_view':
        return createSuccessResponse(
          exportViewSheets(attendanceSheet, employeeSheet, data.year_month)
        );

      // ── Admin系・申請・カレンダー・タスク・納期・給与（AdminServices.gs）──
      case 'admin_dashboard':
      case 'admin_attendance_list':
      case 'admin_edit_attendance':
      case 'admin_add_attendance':
      case 'admin_clear_attendance_field': // v3.0.0: 出勤/退勤時刻の単独クリア
      case 'admin_staff_list':
      case 'admin_add_staff':
      case 'admin_update_staff':
      case 'admin_delete_staff':
      case 'submit_request':
      case 'get_my_requests':
      case 'admin_requests':
      case 'admin_update_request':
      case 'admin_edit_request':
      // Admin が「欠席・在宅・外出」を申請管理シートに登録するアクション。
      // handleAdminAction 内の saveAttendanceStatus に委譲する。
      case 'save_attendance_status':
      case 'get_calendar':
      case 'get_company_calendar':
      case 'save_company_calendar':
      case 'get_tasks':
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
      // ── 残業指示 ──────────────────────────────────
      case 'create_overtime_instruction':
      case 'admin_overtime_instructions':
      case 'update_overtime_instruction_status':
      case 'delete_overtime_instruction':
      case 'submit_overtime_request':
      case 'admin_approve_overtime_request':
      case 'admin_reject_overtime_request':
      case 'get_overtime_instructions':
      // ── 打刻漏れ警告 ──────────────────────────────
      case 'check_missing_clocks':
      case 'check_missing_clocks_monthly':
      case 'get_my_missing_clocks':
        return handleAdminAction(action, data, attendanceSheet, employeeSheet);

      // ── ダッシュボード（DashboardService.gs）──────────────
      // Notionポータル埋め込み用の閲覧専用ダッシュボード。
      // 出退勤・タスク管理は別サービスファイルの担当範囲のため、
      // handleAdminAction には含めず専用のハンドラへ委譲する。
      case 'get_dashboard_summary':
        return handleDashboardAction(action, data);

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
// 人員マスタ CRUD（フラット列対応）
// ============================================================

/**
 * 職員を登録・更新する（upsert）。
 * data.id があれば上書き、なければ新規登録。
 *
 * 人員マスタ の列構成（v1.4.0 フラット化・姓名分割後）:
 *   A: ID, B: 姓, C: 名, D: PIN, E: パスワード, F: 雇用形態,
 *   G: 所定労働時間, H: 所定始業, I: 所定終業, J: 所定休憩(分),
 *   K: 給与形態, L: 時給, M: 月給, N: 弁当デフォルト,
 *   O: 勤務曜日, P: 管理権限, Q: 登録日時, R: 更新日時
 *
 * 呼び出し側が渡す data の構造:
 *   {
 *     id?            : string,   // 更新時のみ
 *     last_name      : string,   // 姓（必須）
 *     first_name     : string,   // 名（必須）
 *     pin            : string,   // 必須・4桁数字（文字列として保存）
 *     password       : string,   // 必須
 *     employee_data? : {
 *       employment_type?  : string,
 *       scheduled_hours?  : number,
 *       scheduled_start?  : string,   // HH:MM
 *       scheduled_end?    : string,   // HH:MM
 *       scheduled_break?  : number,   // 分
 *       wage_type?        : string,   // '時給' | '月給'
 *       hourly_wage?      : number,   // 時給（円）
 *       monthly_wage?     : number,   // 月給（円）
 *       default_lunch?    : boolean,
 *       work_days?        : string[] | string,
 *     }
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @returns {{ id: string, saved: boolean }}
 */
function saveEmployee(sheet, data) {
  // 後方互換: name（旧フォーマット）が渡された場合は姓・名に分割する。
  // スペース（半角・全角）で区切り、左側を姓、右側を名とする。
  // 新フォーマットでは last_name / first_name を直接渡す。
  let lastName, firstName;
  if (data.last_name || data.first_name) {
    lastName  = data.last_name  || '';
    firstName = data.first_name || '';
  } else if (data.name) {
    const parts = String(data.name).split(/[\s\u3000]+/);
    lastName  = parts[0] || '';
    firstName = parts.slice(1).join(' ') || '';
  } else {
    throw new Error('氏名（last_name + first_name または name）は必須です。');
  }

  const now = new Date().toISOString();
  const ed  = data.employee_data || {};

  // 勤務曜日は配列・文字列どちらで渡されてもカンマ区切り文字列に統一する。
  // スプレッドシートは配列を保存できないため。
  const workDays = Array.isArray(ed.work_days)
    ? ed.work_days.join(',')
    : (ed.work_days || '');

  // PIN とパスワードは必ず文字列として保存する。
  // GAS の setValues で数値型を渡すと、スプレッドシートが数値として解釈し
  // 先頭の '0' が消えてしまう（例: '0123' → 123）。String() で強制変換する。
  const pinStr      = String(data.pin      ?? '');
  const passwordStr = String(data.password ?? '');

  // EMPLOYEE_COL の定義順と必ず一致させること。
  // シート実態: 23列（所定労働時間・所定休憩時間なし、論理削除あり）
  const buildRow = (id, createdAt) => [
    id,                                          // A(1) : ID
    lastName,                                    // B(2) : 姓
    firstName,                                   // C(3) : 名
    pinStr,                                      // D(4) : PIN（文字列強制）
    passwordStr,                                 // E(5) : パスワード（文字列強制）
    ed.employment_type    || '',                 // F(6) : 雇用形態
    ed.scheduled_start    || '',                 // G(7) : 所定始業時刻
    ed.scheduled_end      || '',                 // H(8) : 所定終業時刻
    ed.wage_type          || '',                 // I(9) : 給与形態
    ed.hourly_wage        ?? '',                 // J(10): 時給
    ed.monthly_wage       ?? '',                 // K(11): 月給
    ed.default_lunch === true ? '有' : '無',     // L(12): 弁当デフォルト
    workDays,                                    // M(13): 勤務曜日
    ed.admin_role         || '',                 // N(14): 管理権限
    ed.location           || '',                 // O(15): 拠点
    ed.job_type           || '',                 // P(16): 職種
    ed.ins_health     === true ? '加入' : '未加入',  // Q(17): 健康保険
    ed.ins_care       === true ? '加入' : '未加入',  // R(18): 介護保険
    ed.ins_pension    === true ? '加入' : '未加入',  // S(19): 厚生年金
    ed.ins_employment === true ? '加入' : '未加入',  // T(20): 雇用保険
    createdAt,                                   // U(21): 登録日時
    now,                                         // V(22): 更新日時
    '',                                          // W(23): 論理削除（通常は空）
  ];

  const rows = getAllRows(sheet);

  if (data.id) {
    // 更新: 既存行を上書きする。登録日時（Q列）は変えない。
    const rowIndex = rows.findIndex(r => r[EMPLOYEE_COL.ID - 1] === data.id);
    if (rowIndex === -1) {
      throw new Error('指定された id の職員が見つかりません: ' + data.id);
    }

    const sheetRowNum = rowIndex + 2; // +2 = ヘッダー行 + 0始まり補正
    const createdAt   = rows[rowIndex][EMPLOYEE_COL.CREATED_AT - 1]; // 登録日時は保持

    // PIN・パスワード・時刻列をテキスト形式に固定してから書き込む。
    // setNumberFormat('@') で文字列セルに指定しないと、GAS が数値変換してしまう。
    _setEmployeeTextFormat(sheet, sheetRowNum);

    sheet.getRange(sheetRowNum, 1, 1, EMPLOYEE_NUM_COLS).setValues([
      buildRow(data.id, createdAt)
    ]);

    Logger.log('[saveEmployee] Updated: id=%s, lastName=%s, firstName=%s', data.id, lastName, firstName);
    return { id: data.id, saved: true };

  } else {
    // 新規登録: 末尾行に追加する。登録日時と更新日時は同じ値を使う。
    const newId     = generateId();
    const newRowNum = sheet.getLastRow() + 1;

    // PIN・パスワード・時刻列をテキスト形式に固定してから書き込む。
    _setEmployeeTextFormat(sheet, newRowNum);

    sheet.getRange(newRowNum, 1, 1, EMPLOYEE_NUM_COLS).setValues([
      buildRow(newId, now)
    ]);

    Logger.log('[saveEmployee] Created: id=%s, lastName=%s, firstName=%s', newId, lastName, firstName);
    return { id: newId, saved: true };
  }
}

/**
 * 人員マスタの指定行に対し、文字列として扱うべき列の書式を設定する。
 *
 * 設定対象:
 *   - D列（PIN）      : 先頭0が消えるのを防ぐ
 *   - E列（パスワード）: 同上
 *   - H列（所定始業）  : 1899-12-30 への自動変換を防ぐ
 *   - I列（所定終業）  : 同上
 *
 * setValues より前に呼ぶこと。順序が逆になると効果がない。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowNum - 1始まりの行番号
 */
function _setEmployeeTextFormat(sheet, rowNum) {
  // PIN列・パスワード列をテキスト形式に設定
  sheet.getRange(rowNum, EMPLOYEE_COL.PIN     ).setNumberFormat('@');
  sheet.getRange(rowNum, EMPLOYEE_COL.PASSWORD).setNumberFormat('@');
  // 時刻列をテキスト形式に設定（GASが HH:MM を日付シリアル値に変換するのを防ぐ）
  sheet.getRange(rowNum, EMPLOYEE_COL.SCHEDULED_START).setNumberFormat('@');
  sheet.getRange(rowNum, EMPLOYEE_COL.SCHEDULED_END  ).setNumberFormat('@');
}

/**
 * 全職員を取得する。
 *
 * 返り値の employee オブジェクト構造:
 *   {
 *     id              : string,
 *     name            : string,
 *     pin             : string,
 *     password        : string,
 *     employment_type : string,
 *     scheduled_hours : number | '',
 *     scheduled_start : string,
 *     scheduled_end   : string,
 *     scheduled_break : number | '',
 *     wage_type       : string,        // '時給' | '月給'
 *     hourly_wage     : number | '',   // 時給（円）
 *     monthly_wage    : number | '',   // 月給（円）
 *     default_lunch   : boolean,
 *     work_days       : string[],      // カンマ区切りを配列に変換して返す
 *     created_at      : string,
 *     updated_at      : string,
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {{ employees: Object[] }}
 */
function loadEmployees(sheet) {
  const rows = getAllRows(sheet);

  if (rows.length === 0) return { employees: [] };

  const employees = rows.map(row => rowToEmployee(row));

  Logger.log('[loadEmployees] count=%d', employees.length);
  return { employees };
}

/**
 * 職員を削除する（物理削除）。
 * 関連する勤怠記録は削除しない（参照整合性はアプリ側で管理）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} id
 * @returns {{ deleted: boolean, id: string }}
 */
function deleteEmployee(sheet, id) {
  if (!id) throw new Error('id は必須です。');

  const rows     = getAllRows(sheet);
  const rowIndex = rows.findIndex(r => r[EMPLOYEE_COL.ID - 1] === id);

  if (rowIndex === -1) {
    throw new Error('指定された id の職員が見つかりません: ' + id);
  }

  sheet.deleteRow(rowIndex + 2);
  Logger.log('[deleteEmployee] Deleted: id=%s', id);

  return { deleted: true, id };
}

// ============================================================
// 人員マスタ 変換ユーティリティ
// ============================================================

/**
 * 人員マスタの1行データを職員オブジェクトに変換する。
 *
 * EMPLOYEE_COL の定義と必ず一致させること。
 * インデックスは 0 始まりなので EMPLOYEE_COL の値から 1 引く。
 *
 * v1.4.0: 姓・名を個別フィールドで返し、後方互換のため name（結合）も返す。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToEmployee(row) {
  // 勤務曜日はカンマ区切り文字列を配列に変換して返す。
  // 空文字の場合は空配列にして呼び出し側での分岐を減らす。
  const workDaysRaw = row[EMPLOYEE_COL.WORK_DAYS - 1] || '';
  const workDays    = workDaysRaw
    ? String(workDaysRaw).split(',').map(d => d.trim()).filter(Boolean)
    : [];

  const lastName  = String(row[EMPLOYEE_COL.LAST_NAME  - 1] || '');
  const firstName = String(row[EMPLOYEE_COL.FIRST_NAME - 1] || '');

  // 所定始業・終業の時刻を安全な HH:MM 文字列に変換する。
  // GAS が Date型として返した場合（1899-12-30問題）も含め正規化する。
  const scheduledStart = _safeTimeStr(row[EMPLOYEE_COL.SCHEDULED_START - 1]);
  const scheduledEnd   = _safeTimeStr(row[EMPLOYEE_COL.SCHEDULED_END   - 1]);

  return {
    id              : row[EMPLOYEE_COL.ID              - 1],
    last_name       : lastName,
    first_name      : firstName,
    // 後方互換: フロントで name を参照している箇所のために結合値を提供する
    name            : lastName && firstName ? lastName + ' ' + firstName : lastName || firstName,
    pin             : String(row[EMPLOYEE_COL.PIN      - 1] || ''),
    password        : String(row[EMPLOYEE_COL.PASSWORD - 1] || ''),
    employment_type : row[EMPLOYEE_COL.EMPLOYMENT_TYPE - 1] || '',
    // scheduled_hours: シートに列がないため start/end から算出する。
    // start・end が両方揃っている場合のみ計算し、それ以外は null を返す。
    // フロントは null を受け取ったら '―' と表示する。
    scheduled_hours : (() => {
      const s = _safeTimeStr(row[EMPLOYEE_COL.SCHEDULED_START - 1]);
      const e = _safeTimeStr(row[EMPLOYEE_COL.SCHEDULED_END   - 1]);
      if (!s || !e) return null;
      const [sh, sm] = s.split(':').map(Number);
      const [eh, em] = e.split(':').map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm);
      return mins > 0 ? Math.round(mins / 60 * 10) / 10 : null;
    })(),
    scheduled_start : scheduledStart,
    scheduled_end   : scheduledEnd,
    // scheduled_break: シートに列がないため null を返す。
    // 将来的に列を追加した場合はここを修正する。
    scheduled_break : null,
    wage_type       : row[EMPLOYEE_COL.WAGE_TYPE       - 1] || '',
    // hourly_wage / monthly_wage は 0 が有効値のため '' と 0 を区別する
    hourly_wage     : row[EMPLOYEE_COL.HOURLY_WAGE     - 1] === '' ? ''
                        : Number(row[EMPLOYEE_COL.HOURLY_WAGE     - 1]),
    monthly_wage    : row[EMPLOYEE_COL.MONTHLY_WAGE    - 1] === '' ? ''
                        : Number(row[EMPLOYEE_COL.MONTHLY_WAGE    - 1]),
    default_lunch   : row[EMPLOYEE_COL.DEFAULT_LUNCH   - 1] === '有',
    work_days       : workDays,
    // admin_role: 管理権限ロールを文字列で返す。
    // シート実態の値: '管理者' | '給与計算担当' | '一般職員' | ''
    // 旧フォーマット後方互換: '可' → '管理者', '不可' → ''
    admin_role      : (() => {
      const raw = String(row[EMPLOYEE_COL.ADMIN_ROLE - 1] || '');
      if (raw === '可')   return '管理者'; // 旧フォーマット後方互換
      if (raw === '不可') return '';       // 旧フォーマット後方互換
      if (raw === '社長') return '管理者'; // 旧コード後方互換
      return ['管理者', '給与計算担当', '一般職員'].includes(raw) ? raw : '';
    })(),
    // 後方互換: is_admin フラグ。admin_role が空でなければ true。
    is_admin        : (() => {
      const raw = String(row[EMPLOYEE_COL.ADMIN_ROLE - 1] || '');
      return raw === '可' || raw === '社長' || ['管理者', '給与計算担当', '一般職員'].includes(raw);
    })(),
    created_at      : row[EMPLOYEE_COL.CREATED_AT      - 1],
    updated_at      : row[EMPLOYEE_COL.UPDATED_AT      - 1],

    // ── v2.0.0 追加: 拠点・職種・社会保険フラグ ──────────────
    // 旧データ（S〜X列が存在しない行）では row[18]〜row[23] が undefined になる。
    // || '' / === '加入' で安全にフォールバックする。
    location        : String(row[EMPLOYEE_COL.LOCATION       - 1] || ''),
    job_type        : String(row[EMPLOYEE_COL.JOB_TYPE       - 1] || ''),
    // 社保フラグは '加入' の場合のみ true。空・'未加入'・undefined はすべて false。
    ins_health      : row[EMPLOYEE_COL.INS_HEALTH     - 1] === '加入',
    ins_care        : row[EMPLOYEE_COL.INS_CARE       - 1] === '加入',
    ins_pension     : row[EMPLOYEE_COL.INS_PENSION    - 1] === '加入',
    ins_employment  : row[EMPLOYEE_COL.INS_EMPLOYMENT - 1] === '加入',
    // 論理削除フラグ: W列が 'true' の行は削除済みとして扱う
    deleted         : String(row[EMPLOYEE_COL.DELETED - 1] || '') === 'true',
  };
}

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
 * @param {Date|string|*} raw
 * @returns {string} 'HH:MM' または ''
 */
function _safeTimeStr(raw) {
  if (!raw) return '';

  if (raw instanceof Date) {
    // 年が 1899 以前は GAS の誤変換（1899-12-30 問題）→ 空文字
    if (raw.getFullYear() < 1900) return '';
    return String(raw.getHours()).padStart(2, '0') + ':' + String(raw.getMinutes()).padStart(2, '0');
  }

  if (typeof raw === 'string') {
    // 1899- で始まる文字列は誤変換データ → 空文字
    if (raw.startsWith('1899')) return '';
    // HH:MM 形式 → そのまま返す（先頭5文字）
    if (/^\d{1,2}:\d{2}/.test(raw)) return raw.slice(0, 5);
    // ISO 8601 文字列（T含む）→ Date 経由でローカル時刻を取り出す
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
  // マイグレーション途中（旧列数のシートを新 EMPLOYEE_NUM_COLS で読もうとする場合）など
  // 列数が定義値より少ない状態でも安全に動作させるため、実列数を上限とする。
  // 不足列は rowToEmployee / rowToAttendanceRecord 内でフォールバック（|| '' / === '加入'）する。
  const actualCols = sheet.getLastColumn();
  if (actualCols === 0) return []; // 空シート（ヘッダーもない）
  numCols = Math.min(numCols, actualCols);

  const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  // 出退勤記録シートは date 列（インデックス DATE-1）を文字列に正規化する。
  // GAS がセル値を Date オブジェクトとして返すことがあるため。
  if (sheet.getName() === SHEET.ATTENDANCE) {
    return values.map(row => {
      row[ATTENDANCE_COL.DATE - 1] = formatDateToString(row[ATTENDANCE_COL.DATE - 1]);
      return row;
    });
  }

  // 会社カレンダーシートも日付列（A列=インデックス0）を文字列に正規化する。
  // GAS がセル値を Date オブジェクトとして返すと String() が
  // "Sat Jan 01 2025 00:00:00 GMT+0900 (JST)" のような形式になり、
  // startsWith('2025-01') による月フィルタが必ず false になるバグを防ぐ。
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
  // 文字列で渡された場合も YYYY/MM/DD に統一する（YYYY-MM-DD が混在しないよう）
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
 * フロントからは YYYY-MM-DD で渡ってくる。
 * スプシ保存後は YYYY/MM/DD になるため、両形式を受け付ける。
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
 * スプシには YYYY/MM/DD で保存することで、そのまま見やすい表示になる。
 * 内部比較もゼロ埋めされた YYYY/MM/DD で行うため文字列大小比較が正しく動く。
 *
 * @param {string} dateStr - YYYY-MM-DD または YYYY/MM/DD
 * @returns {string} YYYY/MM/DD
 */
function convertDateForDisplay(dateStr) {
  // すでに YYYY/MM/DD 形式なら変換不要
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(dateStr)) return dateStr;
  // YYYY-MM-DD → YYYY/MM/DD に変換する
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

    // 上限超過時は最古の1行（ヘッダーの次の行）を削除
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
 * 【何をするか】
 *   1. 既存の「出退勤記録」シートの全データ行を削除する
 *   2. 新しいヘッダー行（11列）を書き込む
 *   3. _バックアップ シートに「マイグレーション実施」の記録を残す
 *
 * 【注意】
 *   - 実行すると既存の出退勤データはすべて削除される（復元不可）
 *   - マイグレーション前に Google スプレッドシートの「変更履歴」で
 *     バックアップを取っておくことを推奨する
 *   - 人員マスタ・バックアップ・勤務区分マスタは変更しない
 *
 * @returns {void}
 */
function migrateAttendanceSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);

  Logger.log('[migrateAttendanceSheet] 開始: シート "%s"', SHEET.ATTENDANCE);

  // ── Step 1: データ行をすべて削除する ──────────────────────
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.deleteRows(2, lastRow - 1);
    Logger.log('[migrateAttendanceSheet] %d 行削除完了', lastRow - 1);
  } else {
    Logger.log('[migrateAttendanceSheet] データ行なし。削除スキップ。');
  }

  // ── Step 2: 新しいヘッダーを書き込む ──────────────────────
  addSheetHeader(sheet, SHEET.ATTENDANCE);
  Logger.log('[migrateAttendanceSheet] ヘッダー更新完了（11列）');

  // ── Step 3: バックアップシートにマイグレーション記録を残す ─
  saveBackup(
    'migration',
    'attendance_sheet_reset',
    ['migrate', new Date().toISOString(), 'old: 5cols → new: 11cols']
  );

  SpreadsheetApp.flush();
  Logger.log('[migrateAttendanceSheet] 完了。出退勤記録シートが新形式にリセットされました。');
}

// ============================================================
// 認証
// ============================================================

/**
 * PIN + パスワードで職員を認証する。
 *
 * 認証ルール:
 *   - employment_type === '職員' のみログイン可
 *   - employment_type === '利用者' は認証拒否（管理者ダッシュボードへのアクセス不可）
 *   - PIN + パスワードが一致しても利用者であれば弾く
 *
 * セキュリティ上の注意:
 *   - PIN/パスワードの不一致と利用者拒否を同じエラーメッセージにする。
 *     理由: エラーを分けると「このPINは存在する」という情報が漏れるため。
 *   - パスワードは平文で保存・照合する（社内システムのため許容）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - 人員マスタシート
 * @param {string} pin      - 入力された PIN（4桁）
 * @param {string} password - 入力されたパスワード
 * @returns {{ employee: Object }}
 */
function authenticateEmployee(sheet, pin, password) {
  if (!pin)      throw new Error('PIN は必須です。');
  if (!password) throw new Error('パスワードは必須です。');

  const rows = getAllRows(sheet);

  // PIN + パスワードが一致する行を探す。
  // 文字列型に統一して比較することで型の違いによるミスマッチを防ぐ。
  const matched = rows.find(row =>
    String(row[EMPLOYEE_COL.PIN      - 1]) === String(pin) &&
    String(row[EMPLOYEE_COL.PASSWORD - 1]) === String(password)
  );

  if (!matched) {
    throw new Error('PIN またはパスワードが正しくありません。');
  }

  const employee = rowToEmployee(matched);

  // 利用者はログイン不可。
  // v3.0.0: admin_role が空（一般スタッフ）もログイン不可。
  // PIN/パスワード不一致と同じメッセージにして情報漏洩を防ぐ。
  // ※ '一般職員' は Admin にログインできる（給与は非表示）。
  const canLogin = employee.employment_type === '職員' && employee.admin_role !== '';
  if (!canLogin) {
    Logger.log(
      '[authenticateEmployee] ログイン拒否: id=%s, name=%s, employment_type=%s, admin_role=%s',
      employee.id, employee.name, employee.employment_type, employee.admin_role
    );
    throw new Error('PIN またはパスワードが正しくありません。');
  }

  // パスワードはレスポンスから除外してフロントに渡さない。
  delete employee.password;

  Logger.log('[authenticateEmployee] 認証成功: id=%s, name=%s', employee.id, employee.name);

  return { employee };
}

/**
 * Kintai 用認証。PIN + パスワードで職員を認証する。
 *
 * Admin用 authenticateEmployee との違い:
 *   - is_admin チェックを行わない。管理権限のない一般職員もログイン可。
 *   - employment_type === '職員' であることだけを確認する。
 *   - 利用者（employment_type === '利用者'）はログイン不可。
 *
 * 設計判断:
 *   authenticateEmployee とは別関数にすることで、
 *   フロントから "source: 'kintai'" のようなフラグを渡して
 *   チェックを回避する攻撃ベクターを排除している。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - 人員マスタシート
 * @param {string} pin      - 入力された PIN（4桁）
 * @param {string} password - 入力されたパスワード
 * @returns {{ employee: Object }}
 */
function authenticateKintaiEmployee(sheet, pin, password) {
  if (!pin)      throw new Error('PIN は必須です。');
  if (!password) throw new Error('パスワードは必須です。');

  const rows = getAllRows(sheet);

  // 【修正】全行を対象に PIN + パスワードの一致を確認する。
  // 文字列型に統一して比較することで、数値型PINなど型違いによるミスマッチを防ぐ。
  const matched = rows.find(row =>
    String(row[EMPLOYEE_COL.PIN      - 1]) === String(pin) &&
    String(row[EMPLOYEE_COL.PASSWORD - 1]) === String(password)
  );

  if (!matched) {
    throw new Error('PIN またはパスワードが正しくありません。');
  }

  const employee = rowToEmployee(matched);

  // 【修正】employment_type チェックを撤廃。
  // 旧: '職員' のみ許可していたため、雇用形態が空・未設定のユーザーがログインできなかった。
  // 新: PIN + パスワードが一致すれば全員ログイン可。利用者除外はAdmin側のみで行う。
  // ※ is_admin チェックはKintaiでは不要。管理機能はAdmin.htmlが担当する。

  // パスワードはレスポンスから除外してフロントに渡さない。
  delete employee.password;

  Logger.log(
    '[authenticateKintaiEmployee] 認証成功: id=%s, name=%s, is_admin=%s',
    employee.id, employee.name, employee.is_admin
  );

  return { employee };
}