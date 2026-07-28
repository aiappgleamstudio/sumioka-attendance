/**
 * ProjectServices.gs - 制作進行管理システム
 *
 * 役割:
 *   顧客・案件・タスク・作業メモ・相談・通知・フェーズテンプレートの
 *   CRUD アクションをすべて実装する。
 *
 * 設計方針:
 *   - Code.gs の SHEET / generateId / getAllRows / getOrCreateSheet /
 *     createSuccessResponse / createErrorResponse / saveBackup /
 *     convertDateForDisplay / writeAuditLog を使用する
 *   - 権限チェックは各関数の先頭で requirePermissionLevel() を呼ぶ
 *   - 通知生成は createNotification() 経由で行う（直接シートは触らない）
 *   - 日付: フロントから YYYY-MM-DD で受け取り YYYY/MM/DD でシートに保存
 *   - 案件ステータスとタスクステータスは定義を完全に分離する
 *   - 論理削除フラグが 'true' のレコードは常に除外する
 *   - シート読み込みは1回だけ行い、メモリ上でフィルタ・JOIN する
 *
 * このファイルが使うシート（SHEET 定数は Code.gs で定義）:
 *   SHEET.CUSTOMERS       顧客マスタ
 *   SHEET.PROJECTS        案件
 *   SHEET.PROJECT_TASKS   プロジェクトタスク
 *   SHEET.WORK_MEMOS      作業メモ
 *   SHEET.CONSULTATIONS   相談スレッド
 *   SHEET.NOTIFICATIONS   通知
 *   SHEET.PHASE_TEMPLATES フェーズテンプレート
 *
 * @version 1.0.0
 */

// ============================================================
// 列番号定数（1始まり）
// ============================================================

/**
 * 顧客マスタの列番号定数。
 *
 * 列構成:
 *   A(1): ID         - 顧客コード（C001形式）
 *   B(2): NAME       - 顧客名
 *   C(3): CONTACT    - 担当者名
 *   D(4): PHONE      - 電話番号
 *   E(5): EMAIL      - メールアドレス
 *   F(6): NOTES      - 備考
 *   G(7): CREATED_AT - 登録日時（ISO 8601）
 *   H(8): UPDATED_AT - 更新日時（ISO 8601）
 *   I(9): DELETED    - 論理削除（'true' | ''）
 */
var CUSTOMER_COL = {
  ID         : 1,  // A
  NAME       : 2,  // B
  CONTACT    : 3,  // C
  PHONE      : 4,  // D
  EMAIL      : 5,  // E
  NOTES      : 6,  // F
  CREATED_AT : 7,  // G
  UPDATED_AT : 8,  // H
  DELETED    : 9,  // I
};
var CUSTOMER_NUM_COLS = 9;

/**
 * 案件シートの列番号定数。
 *
 * コード体系:
 *   ID（案件コード）    : P001, P002 ...（内部キー・GAS自動採番）
 *   LEGACY_CODE（旧T）  : T001, T002 ...（既存スプシ互換・表示用）
 *
 * 案件区分ごとのステータスフローは PROJECT_STATUS_FLOW を参照。
 * このシートには「現在ステータス」のみ保持する。
 *
 * 列構成:
 *   A(1):  ID             - 案件コード（P001形式）
 *   B(2):  LEGACY_CODE    - 旧Tコード（T001形式）
 *   C(3):  CUSTOMER_ID    - 顧客コード（FK→顧客マスタ、NULL可）
 *   D(4):  NAME           - 案件名
 *   E(5):  DIVISION       - 案件区分（'社外'/'社内'/'練習'）
 *   F(6):  CATEGORY       - カテゴリー
 *   G(7):  STATUS         - 案件ステータス（区分別フロー参照）
 *   H(8):  PHASE_TEMPLATE - フェーズテンプレートID
 *   I(9):  START_DATE     - 作業開始日（YYYY-MM-DD）
 *   J(10): DUE_DATE       - 最終納期（YYYY-MM-DD）
 *   K(11): DELIVERY_DATE  - 納品日（YYYY-MM-DD）
 *   L(12): NOTES          - 備考
 *   M(13): CREATED_BY     - 作成者ID（FK→人員マスタ）
 *   N(14): CREATED_AT     - 作成日時（ISO 8601）
 *   O(15): UPDATED_AT     - 更新日時（ISO 8601）
 *   P(16): DELETED        - 論理削除（'true' | ''）
 */
var PROJECT_COL = {
  ID             : 1,   // A
  LEGACY_CODE    : 2,   // B
  CUSTOMER_ID    : 3,   // C
  NAME           : 4,   // D
  DIVISION       : 5,   // E
  CATEGORY       : 6,   // F
  STATUS         : 7,   // G
  PHASE_TEMPLATE : 8,   // H
  START_DATE     : 9,   // I
  DUE_DATE       : 10,  // J
  DELIVERY_DATE  : 11,  // K
  NOTES          : 12,  // L
  CREATED_BY     : 13,  // M
  CREATED_AT     : 14,  // N
  UPDATED_AT     : 15,  // O
  DELETED        : 16,  // P
};
var PROJECT_NUM_COLS = 16;

/**
 * プロジェクトタスクシートの列番号定数。
 *
 * コード体系:
 *   ID（タスクコード）      : P00101形式（案件コードP001+枝番01）
 *   LEGACY_TASK_CODE（旧T） : T00101形式（既存スプシ互換・表示用）
 *
 * タスクステータスは TASK_STATUSES を参照。
 * 案件ステータス（PROJECT_STATUS_FLOW）とは完全に独立している。
 *
 * 工数管理:
 *   タイマー方式は採用しない。
 *   退勤時または進捗報告時にスタッフが ACTUAL_HOURS を手入力する。
 *
 * 列構成:
 *   A(1):  ID               - タスクコード（P00101形式）
 *   B(2):  LEGACY_TASK_CODE - 旧タスクコード（T00101形式・表示用互換）
 *   C(3):  PROJECT_ID       - 案件コード（FK→案件、NULL可）
 *   D(4):  TITLE            - タスク名
 *   E(5):  WORK_CONTENT     - 作業内容
 *   F(6):  ASSIGNEE_ID      - 担当者ID（FK→人員マスタ）
 *   G(7):  ASSIGNEE_NAME    - 担当者名（非正規化・高速表示用）
 *   H(8):  REQUESTER_ID     - 依頼者ID（FK→人員マスタ）
 *   I(9):  STATUS           - タスクステータス（TASK_STATUSES 参照）
 *   J(10): CURRENT_PHASE    - 現在フェーズ名（テキスト）
 *   K(11): PRIORITY         - 優先度（'高'/'中'/'低'）
 *   L(12): START_DATE       - 作業開始日（YYYY-MM-DD）
 *   M(13): DUE_DATE         - 期限（YYYY-MM-DD）
 *   N(14): SCHEDULED_HOURS  - 予定工数（数値・時間単位）
 *   O(15): ACTUAL_HOURS     - 実績工数（数値・時間単位・手入力）
 *   P(16): FOLDER_MATERIAL  - 素材フォルダパス
 *   Q(17): FOLDER_WORK      - 作業フォルダパス
 *   R(18): FOLDER_DELIVERY  - 納品フォルダパス
 *   S(19): NOTES            - 備考
 *   T(20): COMPLETION_COND  - 完了条件
 *   U(21): INSTRUCTION      - 指示内容
 *   V(22): CREATED_AT       - 作成日時（ISO 8601）
 *   W(23): UPDATED_AT       - 更新日時（ISO 8601）
 *   X(24): DELETED          - 論理削除（'true' | ''）
 */
var PTASK_COL = {
  ID               : 1,   // A
  LEGACY_TASK_CODE : 2,   // B
  PROJECT_ID       : 3,   // C
  TITLE            : 4,   // D
  WORK_CONTENT     : 5,   // E
  ASSIGNEE_ID      : 6,   // F
  ASSIGNEE_NAME    : 7,   // G
  REQUESTER_ID     : 8,   // H
  STATUS           : 9,   // I
  CURRENT_PHASE    : 10,  // J
  PRIORITY         : 11,  // K
  START_DATE       : 12,  // L
  DUE_DATE         : 13,  // M
  SCHEDULED_HOURS  : 14,  // N
  ACTUAL_HOURS     : 15,  // O
  FOLDER_MATERIAL  : 16,  // P
  FOLDER_WORK      : 17,  // Q
  FOLDER_DELIVERY  : 18,  // R
  NOTES            : 19,  // S
  COMPLETION_COND  : 20,  // T
  INSTRUCTION      : 21,  // U
  CREATED_AT       : 22,  // V
  UPDATED_AT       : 23,  // W
  DELETED          : 24,  // X
};
var PTASK_NUM_COLS = 24;

/**
 * 作業メモシートの列番号定数。
 *
 * 役割:
 *   スタッフが退勤時または進捗報告時に入力する作業記録。
 *   既存スプシ「スタッフ別日報」の作業内容/進捗状況/メモ に対応する。
 *
 * 列構成:
 *   A(1):  ID           - UUID
 *   B(2):  TASK_ID      - タスクコード（FK→プロジェクトタスク、NULL可）
 *   C(3):  AUTHOR_ID    - 投稿者ID
 *   D(4):  AUTHOR_NAME  - 投稿者名（非正規化）
 *   E(5):  WORK_DATE    - 作業日（YYYY-MM-DD）
 *   F(6):  PHASE        - 作業時のフェーズ名
 *   G(7):  CONTENT      - 作業内容
 *   H(8):  PROGRESS     - 進捗状況（自由記述）
 *   I(9):  ACTUAL_HOURS - 実績工数（数値・時間単位）
 *   J(10): MEMO         - メモ
 *   K(11): CREATED_AT   - 投稿日時（ISO 8601）
 */
var MEMO_COL = {
  ID           : 1,   // A
  TASK_ID      : 2,   // B
  AUTHOR_ID    : 3,   // C
  AUTHOR_NAME  : 4,   // D
  WORK_DATE    : 5,   // E
  PHASE        : 6,   // F
  CONTENT      : 7,   // G
  PROGRESS     : 8,   // H
  ACTUAL_HOURS : 9,   // I
  MEMO         : 10,  // J
  CREATED_AT   : 11,  // K
};
var MEMO_NUM_COLS = 11;

/**
 * 相談スレッドシートの列番号定数。
 *
 * タスク単位でスレッドを持つ。同一タスクへの投稿を
 * CREATED_AT 昇順で並べることでスレッドを構成する。
 * PARENT_ID で返信先を表現する（NULL=スレッドの起点）。
 *
 * 列構成:
 *   A(1): ID          - UUID
 *   B(2): TASK_ID     - タスクコード（FK→プロジェクトタスク）
 *   C(3): PARENT_ID   - 返信先投稿ID（NULL=起点）
 *   D(4): AUTHOR_ID   - 投稿者ID
 *   E(5): AUTHOR_NAME - 投稿者名（非正規化）
 *   F(6): CONTENT     - 投稿内容
 *   G(7): CREATED_AT  - 投稿日時（ISO 8601）
 */
var CONSULT_COL = {
  ID          : 1,  // A
  TASK_ID     : 2,  // B
  PARENT_ID   : 3,  // C
  AUTHOR_ID   : 4,  // D
  AUTHOR_NAME : 5,  // E
  CONTENT     : 6,  // F
  CREATED_AT  : 7,  // G
};
var CONSULT_NUM_COLS = 7;

/**
 * 通知シートの列番号定数。
 *
 * Phase 1: 画面内通知のみ（このシートへの書き込み）
 * Phase 2: sendDiscordNotification() を有効化（Webhook URL設定のみ）
 * Phase 3: sendLineWorksNotification() を追加
 *
 * 列構成:
 *   A(1): ID           - UUID
 *   B(2): RECIPIENT_ID - 受信者ID
 *   C(3): TYPE         - 通知種別（NOTIF_TYPE 参照）
 *   D(4): TITLE        - 通知タイトル
 *   E(5): BODY         - 通知本文
 *   F(6): TASK_ID      - 関連タスクID（任意）
 *   G(7): PROJECT_ID   - 関連案件ID（任意）
 *   H(8): IS_READ      - 既読フラグ（'true' | ''）
 *   I(9): CREATED_AT   - 作成日時（ISO 8601）
 */
var NOTIF_COL = {
  ID           : 1,  // A
  RECIPIENT_ID : 2,  // B
  TYPE         : 3,  // C
  TITLE        : 4,  // D
  BODY         : 5,  // E
  TASK_ID      : 6,  // F
  PROJECT_ID   : 7,  // G
  IS_READ      : 8,  // H
  CREATED_AT   : 9,  // I
};
var NOTIF_NUM_COLS = 9;

/**
 * フェーズテンプレートシートの列番号定数。
 *
 * PHASES は JSON 配列文字列として保存する。
 * 例: '["素材確認","カット編集","字幕","BGM","SE","サムネイル","書き出し","納品"]'
 *
 * 列構成:
 *   A(1): ID         - UUID
 *   B(2): NAME       - テンプレート名（例: '動画編集'）
 *   C(3): PHASES     - フェーズ名JSON配列
 *   D(4): CREATED_AT - 作成日時（ISO 8601）
 *   E(5): UPDATED_AT - 更新日時（ISO 8601）
 */
var PHASE_TPL_COL = {
  ID         : 1,  // A
  NAME       : 2,  // B
  PHASES     : 3,  // C
  CREATED_AT : 4,  // D
  UPDATED_AT : 5,  // E
};
var PHASE_TPL_NUM_COLS = 5;

// ============================================================
// マスター定数（実運用テスト後に調整可能）
// ============================================================

/**
 * 案件区分ごとのステータスフロー定義。
 *
 * 【重要】案件ステータスとタスクステータスは完全に別定義とする。
 * TASK_STATUSES とは一切関係がない。
 *
 * flow : 通常進行時の推奨順序
 * free : どのステータスからでも遷移可能なステータス
 *
 * バリデーション方針:
 *   GAS 側ではステータス値の有効性チェックのみ行う。
 *   フロー順の強制はしない（現場の例外運用に対応するため）。
 *   実運用テスト後にフローを変更する場合はこの定数のみ修正する。
 */
var PROJECT_STATUS_FLOW = {
  '社外': {
    statuses: [
      '引合い', '見積中', '受注確定', '制作中',
      '社内確認', '先方確認', '修正対応',
      '納品済', '請求済', '入金確認', '完了',
      '保留', 'キャンセル',
    ],
    flow: [
      '引合い', '見積中', '受注確定', '制作中',
      '社内確認', '先方確認', '修正対応',
      '納品済', '請求済', '入金確認', '完了',
    ],
    free: ['保留', 'キャンセル'],
  },
  '社内': {
    statuses: ['進行中', '社内確認', '完了', '保留'],
    flow    : ['進行中', '社内確認', '完了'],
    free    : ['保留'],
  },
  '練習': {
    statuses: ['進行中', '完了', '保留'],
    flow    : ['進行中', '完了'],
    free    : ['保留'],
  },
};

/**
 * タスクステータス定数。
 *
 * 【重要】案件ステータス（PROJECT_STATUS_FLOW）とは完全に独立した定義。
 * 混在・参照・比較を行ってはならない。
 *
 * 変更権限:
 *   Lv1スタッフ : TASK_STATUSES_FOR_STAFF のみ変更可
 *   Lv2以上    : 全ステータスへの変更可
 */
var TASK_STATUSES           = ['未着手', '作業中', '確認待ち', '修正依頼', '完了', '保留'];
var TASK_STATUSES_FOR_STAFF = ['作業中', '確認待ち', '保留'];

/**
 * 通知種別定数。
 *
 * 新しい通知種別を追加する場合はここだけ変更する。
 * フロントのアイコン・色表示はこの値を参照して切り替える。
 */
var NOTIF_TYPE = {
  NEW_TASK       : 'new_task',        // タスクが自分に割り当てられた
  INSTRUCTION    : 'instruction',     // 管理者から指示が追加された
  REVIEW_REQUEST : 'review_request',  // タスクが「確認待ち」になった（管理者宛）
  REVISION       : 'revision',        // タスクが「修正依頼」になった（担当者宛）
  CONSULTATION   : 'consultation',    // 相談が投稿された
  OVERDUE        : 'overdue',         // 期限超過
  PROJECT_STATUS : 'project_status',  // 案件ステータスが変更された
};

/**
 * 案件カテゴリーマスタ。
 * UI のドロップダウンに使用する。追加・変更はここだけ修正する。
 */
var PROJECT_CATEGORIES = ['動画', 'HP', 'デザイン', 'イラスト・漫画', '3D', 'その他'];

/**
 * 優先度マスタ。
 */
var TASK_PRIORITIES = ['高', '中', '低'];

// ============================================================
// エントリポイント
// ============================================================

/**
 * 制作進行管理系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'get_customers':
 *   case 'upsert_customer':
 *   ...
 *     return handleProjectAction(action, data, attendanceSheet, employeeSheet);
 *
 * @param {string} action
 * @param {Object} data
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @returns {ContentService.TextOutput}
 */
function handleProjectAction(action, data, attendanceSheet, employeeSheet) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    switch (action) {

      // ── 顧客マスタ ────────────────────────────────
      case 'get_customers':
        return createSuccessResponse(getCustomers(ss, data));
      case 'upsert_customer':
        return createSuccessResponse(upsertCustomer(ss, employeeSheet, data));
      case 'delete_customer':
        return createSuccessResponse(deleteCustomer(ss, employeeSheet, data));

      // ── 案件 ──────────────────────────────────────
      case 'get_projects':
        return createSuccessResponse(getProjects(ss, data));
      case 'upsert_project':
        return createSuccessResponse(upsertProject(ss, employeeSheet, data));
      case 'update_project_status':
        return createSuccessResponse(updateProjectStatus(ss, employeeSheet, data));
      case 'delete_project':
        return createSuccessResponse(deleteProject(ss, employeeSheet, data));

      // ── タスク ────────────────────────────────────
      case 'get_project_tasks':
        return createSuccessResponse(getProjectTasks(ss, data));
      case 'upsert_project_task':
        return createSuccessResponse(upsertProjectTask(ss, employeeSheet, data));
      case 'update_task_status':
        return createSuccessResponse(updateTaskStatus(ss, employeeSheet, data));
      case 'update_task_phase':
        return createSuccessResponse(updateTaskPhase(ss, employeeSheet, data));
      case 'delete_project_task':
        return createSuccessResponse(deleteProjectTask(ss, employeeSheet, data));

      // ── 作業メモ ──────────────────────────────────
      case 'get_work_memos':
        return createSuccessResponse(getWorkMemos(ss, data));
      case 'add_work_memo':
        return createSuccessResponse(addWorkMemo(ss, data));

      // ── 相談スレッド ──────────────────────────────
      case 'get_consultations':
        return createSuccessResponse(getConsultations(ss, data));
      case 'post_consultation':
        return createSuccessResponse(postConsultation(ss, employeeSheet, data));

      // ── 通知 ──────────────────────────────────────
      case 'get_notifications':
        return createSuccessResponse(getNotifications(ss, data));
      case 'mark_notification_read':
        return createSuccessResponse(markNotificationRead(ss, data));
      case 'mark_all_notifications_read':
        return createSuccessResponse(markAllNotificationsRead(ss, data));

      // ── フェーズテンプレート ──────────────────────
      case 'get_phase_templates':
        return createSuccessResponse(getPhaseTemplates(ss));
      case 'upsert_phase_template':
        return createSuccessResponse(upsertPhaseTemplate(ss, employeeSheet, data));
      case 'delete_phase_template':
        return createSuccessResponse(deletePhaseTemplate(ss, employeeSheet, data));

      // ── ダッシュボード ────────────────────────────
      case 'project_dashboard':
        return createSuccessResponse(
          getProjectDashboard(ss, attendanceSheet, employeeSheet, data)
        );

      // ── マスタ取得（UI ドロップダウン用）─────────
      case 'get_project_masters':
        return createSuccessResponse(getProjectMasters());

      default:
        throw new Error('Unhandled project action: ' + action);
    }
  } catch (err) {
    Logger.log('[handleProjectAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}

// ============================================================
// 権限チェック
// ============================================================

/**
 * 人員マスタの employee オブジェクトから権限レベルを返す。
 *
 * 既存の admin_role 値をレベル数値に変換する。
 * フロントから employee_id を受け取り、人員マスタを参照して判定する。
 * フロント側の権限チェックは改ざんリスクがあるため必ずGAS側でも検証する。
 *
 * @param {Object} employee - rowToEmployee() の戻り値
 * @returns {number} 1 | 2 | 3
 */
function getPermissionLevel(employee) {
  if (!employee) return 0;
  if (employee.admin_role === '管理者') return 3;
  if (employee.admin_role === '給与計算担当') return 2;
  if (employee.admin_role === '一般職員') return 2;
  return 1; // 空文字 = スタッフ
}

/**
 * 指定レベル以上でなければエラーを投げる。
 * 各アクション関数の先頭で必ず呼ぶ。
 *
 * @param {Object} employee    - rowToEmployee() の戻り値
 * @param {number} required    - 必要な最低権限レベル
 * @throws {Error} 権限不足の場合
 */
function requirePermissionLevel(employee, required) {
  if (getPermissionLevel(employee) < required) {
    throw new Error('この操作を行う権限がありません。');
  }
}

/**
 * employee_id から人員マスタのレコードを取得する。
 *
 * 権限チェックが必要なアクション関数はこの関数を使って
 * employee オブジェクトを取得してから requirePermissionLevel() に渡す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {string} employeeId
 * @returns {Object} employee
 * @throws {Error} 見つからない場合
 */
function getEmployeeOrThrow(employeeSheet, employeeId) {
  if (!employeeId) throw new Error('employee_id は必須です。');
  var rows = getAllRows(employeeSheet);
  var row  = rows.find(function(r) {
    return String(r[EMPLOYEE_COL.ID - 1]) === String(employeeId);
  });
  if (!row) throw new Error('操作者の情報が見つかりません: ' + employeeId);
  return rowToEmployee(row);
}

/**
 * タスクステータス変更の権限・値を検証する。
 *
 * ルール:
 *   - TASK_STATUSES に含まれない値は拒否する
 *   - スタッフ（Lv1）: 自分担当タスクかつ TASK_STATUSES_FOR_STAFF のみ変更可
 *   - 職員（Lv2以上）: 全ステータスへの変更可
 *
 * @param {Object} employee  - 操作者
 * @param {Object} task      - 変更対象タスク（rowToProjectTask の戻り値）
 * @param {string} newStatus - 変更後ステータス
 * @throws {Error} 権限不足またはルール違反の場合
 */
function validateTaskStatusChange(employee, task, newStatus) {
  // 有効な値かチェックする（案件ステータスとは完全に別の検証）
  if (TASK_STATUSES.indexOf(newStatus) === -1) {
    throw new Error('無効なタスクステータスです: ' + newStatus);
  }

  var level = getPermissionLevel(employee);

  // Lv2以上は全ステータスへの変更を許可する
  if (level >= 2) return;

  // Lv1（スタッフ）: 自分のタスクのみ操作可
  if (task.assignee_id !== employee.id) {
    throw new Error('他の担当者のタスクは変更できません。');
  }

  // Lv1: 変更可能なステータスに制限する
  if (TASK_STATUSES_FOR_STAFF.indexOf(newStatus) === -1) {
    throw new Error('「' + newStatus + '」への変更は職員のみが行えます。');
  }
}

/**
 * 案件ステータスの値が案件区分のフローに存在するか検証する。
 *
 * 【重要】タスクステータスとは完全に分離した検証。
 *
 * @param {string} division  - 案件区分
 * @param {string} newStatus - 変更後の案件ステータス
 * @throws {Error} 無効なステータスの場合
 */
function validateProjectStatus(division, newStatus) {
  var flow = PROJECT_STATUS_FLOW[division];
  if (!flow) throw new Error('無効な案件区分です: ' + division);
  if (flow.statuses.indexOf(newStatus) === -1) {
    throw new Error(
      '案件区分「' + division + '」に「' + newStatus + '」は無効なステータスです。'
    );
  }
}

// ============================================================
// シート初期化（ヘッダー行の設定）
// ============================================================

/**
 * 顧客マスタシートを初期化する。
 * シートが空の場合のみヘッダーを書き込む。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initCustomerSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, CUSTOMER_NUM_COLS).setValues([[
    '顧客コード', '顧客名', '担当者名', '電話番号', 'メールアドレス',
    '備考', '登録日時', '更新日時', '論理削除',
  ]]);
}

/**
 * 案件シートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initProjectSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, PROJECT_NUM_COLS).setValues([[
    '案件コード', '旧Tコード', '顧客コード', '案件名', '案件区分',
    'カテゴリー', 'ステータス', 'フェーズテンプレート',
    '作業開始日', '最終納期', '納品日',
    '備考', '作成者ID', '作成日時', '更新日時', '論理削除',
  ]]);
  // 日付列をテキスト形式に固定する（GASの自動変換を防ぐ）
  sheet.getRange(1, PROJECT_COL.START_DATE   ).setNumberFormat('@');
  sheet.getRange(1, PROJECT_COL.DUE_DATE     ).setNumberFormat('@');
  sheet.getRange(1, PROJECT_COL.DELIVERY_DATE).setNumberFormat('@');
}

/**
 * プロジェクトタスクシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initProjectTaskSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, PTASK_NUM_COLS).setValues([[
    'タスクコード', '旧タスクコード', '案件コード', 'タスク名', '作業内容',
    '担当者ID', '担当者名', '依頼者ID',
    'ステータス', '現在フェーズ', '優先度',
    '作業開始日', '期限',
    '予定工数(h)', '実績工数(h)',
    '素材フォルダ', '作業フォルダ', '納品フォルダ',
    '備考', '完了条件', '指示内容',
    '作成日時', '更新日時', '論理削除',
  ]]);
}

/**
 * 作業メモシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initWorkMemoSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, MEMO_NUM_COLS).setValues([[
    'ID', 'タスクコード', '投稿者ID', '投稿者名',
    '作業日', 'フェーズ', '作業内容', '進捗状況',
    '実績工数(h)', 'メモ', '投稿日時',
  ]]);
}

/**
 * 相談スレッドシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initConsultationSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, CONSULT_NUM_COLS).setValues([[
    'ID', 'タスクコード', '返信先ID', '投稿者ID', '投稿者名', '内容', '投稿日時',
  ]]);
}

/**
 * 通知シートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initNotificationSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, NOTIF_NUM_COLS).setValues([[
    'ID', '受信者ID', '通知種別', 'タイトル', '本文',
    'タスクコード', '案件コード', '既読', '作成日時',
  ]]);
}

/**
 * フェーズテンプレートシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initPhaseTemplateSheet(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, PHASE_TPL_NUM_COLS).setValues([[
    'ID', 'テンプレート名', 'フェーズ(JSON)', '作成日時', '更新日時',
  ]]);
}

// ============================================================
// 行データ → オブジェクト変換
// ============================================================

/**
 * 顧客マスタのシート行データをオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToCustomer(row) {
  return {
    id         : String(row[CUSTOMER_COL.ID         - 1] || ''),
    name       : String(row[CUSTOMER_COL.NAME       - 1] || ''),
    contact    : String(row[CUSTOMER_COL.CONTACT    - 1] || ''),
    phone      : String(row[CUSTOMER_COL.PHONE      - 1] || ''),
    email      : String(row[CUSTOMER_COL.EMAIL      - 1] || ''),
    notes      : String(row[CUSTOMER_COL.NOTES      - 1] || ''),
    created_at : String(row[CUSTOMER_COL.CREATED_AT - 1] || ''),
    updated_at : String(row[CUSTOMER_COL.UPDATED_AT - 1] || ''),
  };
}

/**
 * 案件シートの行データをオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToProject(row) {
  return {
    id             : String(row[PROJECT_COL.ID             - 1] || ''),
    legacy_code    : String(row[PROJECT_COL.LEGACY_CODE    - 1] || ''),
    customer_id    : String(row[PROJECT_COL.CUSTOMER_ID    - 1] || ''),
    name           : String(row[PROJECT_COL.NAME           - 1] || ''),
    division       : String(row[PROJECT_COL.DIVISION       - 1] || ''),
    category       : String(row[PROJECT_COL.CATEGORY       - 1] || ''),
    status         : String(row[PROJECT_COL.STATUS         - 1] || ''),
    phase_template : String(row[PROJECT_COL.PHASE_TEMPLATE - 1] || ''),
    start_date     : _normDateStr(row[PROJECT_COL.START_DATE    - 1]),
    due_date       : _normDateStr(row[PROJECT_COL.DUE_DATE      - 1]),
    delivery_date  : _normDateStr(row[PROJECT_COL.DELIVERY_DATE - 1]),
    notes          : String(row[PROJECT_COL.NOTES          - 1] || ''),
    created_by     : String(row[PROJECT_COL.CREATED_BY     - 1] || ''),
    created_at     : String(row[PROJECT_COL.CREATED_AT     - 1] || ''),
    updated_at     : String(row[PROJECT_COL.UPDATED_AT     - 1] || ''),
  };
}

/**
 * プロジェクトタスクシートの行データをオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToProjectTask(row) {
  return {
    id               : String(row[PTASK_COL.ID               - 1] || ''),
    legacy_task_code : String(row[PTASK_COL.LEGACY_TASK_CODE - 1] || ''),
    project_id       : String(row[PTASK_COL.PROJECT_ID       - 1] || ''),
    title            : String(row[PTASK_COL.TITLE            - 1] || ''),
    work_content     : String(row[PTASK_COL.WORK_CONTENT     - 1] || ''),
    assignee_id      : String(row[PTASK_COL.ASSIGNEE_ID      - 1] || ''),
    assignee_name    : String(row[PTASK_COL.ASSIGNEE_NAME    - 1] || ''),
    requester_id     : String(row[PTASK_COL.REQUESTER_ID     - 1] || ''),
    status           : String(row[PTASK_COL.STATUS           - 1] || ''),
    current_phase    : String(row[PTASK_COL.CURRENT_PHASE    - 1] || ''),
    priority         : String(row[PTASK_COL.PRIORITY         - 1] || '中'),
    start_date       : _normDateStr(row[PTASK_COL.START_DATE - 1]),
    due_date         : _normDateStr(row[PTASK_COL.DUE_DATE   - 1]),
    scheduled_hours  : _toNum(row[PTASK_COL.SCHEDULED_HOURS  - 1]),
    actual_hours     : _toNum(row[PTASK_COL.ACTUAL_HOURS     - 1]),
    folder_material  : String(row[PTASK_COL.FOLDER_MATERIAL  - 1] || ''),
    folder_work      : String(row[PTASK_COL.FOLDER_WORK      - 1] || ''),
    folder_delivery  : String(row[PTASK_COL.FOLDER_DELIVERY  - 1] || ''),
    notes            : String(row[PTASK_COL.NOTES            - 1] || ''),
    completion_cond  : String(row[PTASK_COL.COMPLETION_COND  - 1] || ''),
    instruction      : String(row[PTASK_COL.INSTRUCTION      - 1] || ''),
    created_at       : String(row[PTASK_COL.CREATED_AT       - 1] || ''),
    updated_at       : String(row[PTASK_COL.UPDATED_AT       - 1] || ''),
  };
}

/**
 * 作業メモシートの行データをオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToWorkMemo(row) {
  return {
    id           : String(row[MEMO_COL.ID           - 1] || ''),
    task_id      : String(row[MEMO_COL.TASK_ID      - 1] || ''),
    author_id    : String(row[MEMO_COL.AUTHOR_ID    - 1] || ''),
    author_name  : String(row[MEMO_COL.AUTHOR_NAME  - 1] || ''),
    work_date    : _normDateStr(row[MEMO_COL.WORK_DATE - 1]),
    phase        : String(row[MEMO_COL.PHASE        - 1] || ''),
    content      : String(row[MEMO_COL.CONTENT      - 1] || ''),
    progress     : String(row[MEMO_COL.PROGRESS     - 1] || ''),
    actual_hours : _toNum(row[MEMO_COL.ACTUAL_HOURS - 1]),
    memo         : String(row[MEMO_COL.MEMO         - 1] || ''),
    created_at   : String(row[MEMO_COL.CREATED_AT   - 1] || ''),
  };
}

/**
 * 相談スレッドシートの行データをオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToConsultation(row) {
  return {
    id          : String(row[CONSULT_COL.ID          - 1] || ''),
    task_id     : String(row[CONSULT_COL.TASK_ID     - 1] || ''),
    parent_id   : String(row[CONSULT_COL.PARENT_ID   - 1] || ''),
    author_id   : String(row[CONSULT_COL.AUTHOR_ID   - 1] || ''),
    author_name : String(row[CONSULT_COL.AUTHOR_NAME - 1] || ''),
    content     : String(row[CONSULT_COL.CONTENT     - 1] || ''),
    created_at  : String(row[CONSULT_COL.CREATED_AT  - 1] || ''),
  };
}

/**
 * フェーズテンプレートシートの行データをオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToPhaseTemplate(row) {
  var phasesRaw = row[PHASE_TPL_COL.PHASES - 1];
  var phases    = [];
  try {
    phases = phasesRaw ? JSON.parse(phasesRaw) : [];
  } catch (_) {
    phases = [];
  }
  return {
    id         : String(row[PHASE_TPL_COL.ID         - 1] || ''),
    name       : String(row[PHASE_TPL_COL.NAME       - 1] || ''),
    phases     : phases,
    created_at : String(row[PHASE_TPL_COL.CREATED_AT - 1] || ''),
    updated_at : String(row[PHASE_TPL_COL.UPDATED_AT - 1] || ''),
  };
}

// ============================================================
// ユーティリティ（このファイル内専用）
// ============================================================

/**
 * Date オブジェクトまたは日付文字列を YYYY-MM-DD 文字列に正規化する。
 * 空・無効値は '' を返す。
 *
 * @param {*} value
 * @returns {string} 'YYYY-MM-DD' または ''
 */
function _normDateStr(value) {
  if (!value && value !== 0) return '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    var y = value.getFullYear();
    var m = String(value.getMonth() + 1).padStart(2, '0');
    var d = String(value.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  // 文字列の場合は YYYY/MM/DD → YYYY-MM-DD に統一する
  return String(value).replace(/\//g, '-').slice(0, 10);
}

/**
 * 任意の値を数値に変換する。空・無効値は null を返す。
 *
 * @param {*} v
 * @returns {number|null}
 */
function _toNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/**
 * 日付文字列をスプレッドシート保存用の YYYY/MM/DD に変換する。
 * 空文字はそのまま返す。
 *
 * 既存の convertDateForDisplay() と同じ変換。
 * このファイル内では _toSpreadsheetDate() として明示的に使う。
 *
 * @param {string} dateStr - 'YYYY-MM-DD' または ''
 * @returns {string} 'YYYY/MM/DD' または ''
 */
function _toSpreadsheetDate(dateStr) {
  if (!dateStr) return '';
  return String(dateStr).replace(/-/g, '/');
}

/**
 * 案件コード（P001形式）を自動採番する。
 *
 * 既存レコードの最大番号 + 1 を返す。
 * 既存スプシの旧Tコード（T001形式）と連番が衝突しないよう、
 * ID管理シートの最大番号を参照してから採番する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} projectSheet
 * @param {number} [startFrom] - 最小番号（省略時は1）
 * @returns {string} 'P001' 形式
 */
function generateProjectCode(projectSheet, startFrom) {
  var rows = getAllRows(projectSheet).filter(function(r) {
    return r[PROJECT_COL.DELETED - 1] !== 'true';
  });

  var maxNum = (startFrom || 0);
  rows.forEach(function(r) {
    var code = String(r[PROJECT_COL.ID - 1] || '');
    var match = code.match(/^P(\d+)$/);
    if (match) {
      var n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });

  return 'P' + String(maxNum + 1).padStart(3, '0');
}

/**
 * タスクコード（P00101形式）を自動採番する。
 *
 * 指定案件コードの既存タスクの最大枝番 + 1 を返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} taskSheet
 * @param {string} projectId - 案件コード（例: 'P001'）
 * @returns {string} 'P00101' 形式
 */
function generateTaskCode(taskSheet, projectId) {
  var rows = getAllRows(taskSheet).filter(function(r) {
    return String(r[PTASK_COL.PROJECT_ID - 1]) === projectId &&
           r[PTASK_COL.DELETED - 1] !== 'true';
  });

  // 案件コードの数字部分を取り出す（P001 → 001）
  var projectNum = projectId.replace(/^P/, '');

  var maxBranch = 0;
  rows.forEach(function(r) {
    var code = String(r[PTASK_COL.ID - 1] || '');
    // P00101 → 01 部分（末尾2桁）を抽出
    var pattern = new RegExp('^P' + projectNum + '(\\d+)$');
    var match   = code.match(pattern);
    if (match) {
      var n = parseInt(match[1], 10);
      if (n > maxBranch) maxBranch = n;
    }
  });

  return 'P' + projectNum + String(maxBranch + 1).padStart(2, '0');
}

/**
 * 顧客コード（C001形式）を自動採番する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} customerSheet
 * @returns {string} 'C001' 形式
 */
function generateCustomerCode(customerSheet) {
  var rows = getAllRows(customerSheet).filter(function(r) {
    return r[CUSTOMER_COL.DELETED - 1] !== 'true';
  });

  var maxNum = 0;
  rows.forEach(function(r) {
    var code  = String(r[CUSTOMER_COL.ID - 1] || '');
    var match = code.match(/^C(\d+)$/);
    if (match) {
      var n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });

  return 'C' + String(maxNum + 1).padStart(3, '0');
}

// ============================================================
// 顧客マスタ
// ============================================================

/**
 * 顧客一覧を取得する。
 *
 * 入力:
 *   data.keyword (opt) - 顧客名・担当者名の部分一致フィルタ
 *
 * 出力:
 *   { customers: Object[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getCustomers(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.CUSTOMERS);
  initCustomerSheet(sheet);

  var rows = getAllRows(sheet).filter(function(r) {
    return r[CUSTOMER_COL.DELETED - 1] !== 'true';
  });

  // キーワードフィルタ（顧客名・担当者名の部分一致）
  if (data.keyword) {
    var kw = String(data.keyword).toLowerCase();
    rows = rows.filter(function(r) {
      var name    = String(r[CUSTOMER_COL.NAME    - 1] || '').toLowerCase();
      var contact = String(r[CUSTOMER_COL.CONTACT - 1] || '').toLowerCase();
      return name.indexOf(kw) !== -1 || contact.indexOf(kw) !== -1;
    });
  }

  var customers = rows.map(rowToCustomer);
  Logger.log('[getCustomers] count=%d', customers.length);
  return { customers: customers, count: customers.length };
}

/**
 * 顧客を作成・更新する（upsert）。
 *
 * 入力:
 *   data.customer_id (opt) - 更新時に指定
 *   data.operator_id       - 操作者ID（権限チェック用）
 *   data.name              - 顧客名（必須）
 *   data.contact (opt)     - 担当者名
 *   data.phone (opt)       - 電話番号
 *   data.email (opt)       - メールアドレス
 *   data.notes (opt)       - 備考
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function upsertCustomer(ss, employeeSheet, data) {
  // 権限チェック: Lv2以上のみ
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.name) throw new Error('顧客名は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.CUSTOMERS);
  initCustomerSheet(sheet);

  var now  = new Date().toISOString();
  var rows = getAllRows(sheet);
  var id   = data.customer_id;

  if (id) {
    // 更新
    var idx = rows.findIndex(function(r) {
      return String(r[CUSTOMER_COL.ID - 1]) === id;
    });
    if (idx === -1) throw new Error('顧客が見つかりません: ' + id);

    var rowNum     = idx + 2;
    var createdAt  = rows[idx][CUSTOMER_COL.CREATED_AT - 1];

    sheet.getRange(rowNum, 1, 1, CUSTOMER_NUM_COLS).setValues([[
      id,
      data.name    || '',
      data.contact || '',
      data.phone   || '',
      data.email   || '',
      data.notes   || '',
      createdAt,
      now,
      '',
    ]]);

  } else {
    // 新規作成
    id = generateCustomerCode(sheet);
    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, CUSTOMER_NUM_COLS).setValues([[
      id,
      data.name    || '',
      data.contact || '',
      data.phone   || '',
      data.email   || '',
      data.notes   || '',
      now,
      now,
      '',
    ]]);
  }

  SpreadsheetApp.flush();
  Logger.log('[upsertCustomer] id=%s, name=%s', id, data.name);
  return { id: id, saved: true };
}

/**
 * 顧客を論理削除する。
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data - { customer_id, operator_id }
 * @returns {Object}
 */
function deleteCustomer(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.customer_id) throw new Error('customer_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.CUSTOMERS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[CUSTOMER_COL.ID - 1]) === data.customer_id;
  });
  if (idx === -1) throw new Error('顧客が見つかりません: ' + data.customer_id);

  sheet.getRange(idx + 2, CUSTOMER_COL.DELETED   ).setValue('true');
  sheet.getRange(idx + 2, CUSTOMER_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action   : 'delete_customer',
    admin_id : data.operator_id,
    target_id: data.customer_id,
    reason   : '顧客を論理削除',
  });

  Logger.log('[deleteCustomer] id=%s', data.customer_id);
  return { deleted: true, id: data.customer_id };
}

// ============================================================
// 案件
// ============================================================

/**
 * 案件一覧を取得する。
 *
 * 入力:
 *   data.division (opt)    - 案件区分フィルタ
 *   data.status (opt)      - ステータスフィルタ
 *   data.customer_id (opt) - 顧客コードフィルタ
 *   data.keyword (opt)     - 案件名の部分一致フィルタ
 *   data.include_done (opt)- true の場合「完了/キャンセル」も含める
 *
 * 出力:
 *   { projects: Object[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getProjects(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  initProjectSheet(sheet);

  var rows = getAllRows(sheet).filter(function(r) {
    return r[PROJECT_COL.DELETED - 1] !== 'true';
  });

  // 完了・キャンセルを除外する（デフォルト: 除外）
  if (!data.include_done) {
    rows = rows.filter(function(r) {
      var st = String(r[PROJECT_COL.STATUS - 1] || '');
      return st !== '完了' && st !== 'キャンセル';
    });
  }

  // 各種フィルタを適用する
  if (data.division)    rows = rows.filter(function(r) { return r[PROJECT_COL.DIVISION    - 1] === data.division;    });
  if (data.status)      rows = rows.filter(function(r) { return r[PROJECT_COL.STATUS      - 1] === data.status;      });
  if (data.customer_id) rows = rows.filter(function(r) { return r[PROJECT_COL.CUSTOMER_ID - 1] === data.customer_id; });

  if (data.keyword) {
    var kw = String(data.keyword).toLowerCase();
    rows = rows.filter(function(r) {
      return String(r[PROJECT_COL.NAME - 1] || '').toLowerCase().indexOf(kw) !== -1;
    });
  }

  // 納期昇順でソートする（期限が近い順に表示するため）
  rows.sort(function(a, b) {
    var da = String(a[PROJECT_COL.DUE_DATE - 1] || '9999-99-99');
    var db = String(b[PROJECT_COL.DUE_DATE - 1] || '9999-99-99');
    return da.localeCompare(db);
  });

  var projects = rows.map(rowToProject);
  Logger.log('[getProjects] count=%d', projects.length);
  return { projects: projects, count: projects.length };
}

/**
 * 案件を作成・更新する（upsert）。
 *
 * 入力:
 *   data.project_id (opt)     - 更新時に指定（省略で新規作成）
 *   data.legacy_code (opt)    - 旧Tコード（T001形式）
 *   data.operator_id          - 操作者ID（権限チェック用）
 *   data.customer_id (opt)    - 顧客コード
 *   data.name                 - 案件名（必須）
 *   data.division             - 案件区分（必須）
 *   data.category (opt)       - カテゴリー
 *   data.status (opt)         - ステータス（省略時は区分のデフォルト）
 *   data.phase_template (opt) - フェーズテンプレートID
 *   data.start_date (opt)     - 作業開始日（YYYY-MM-DD）
 *   data.due_date (opt)       - 最終納期（YYYY-MM-DD）
 *   data.delivery_date (opt)  - 納品日（YYYY-MM-DD）
 *   data.notes (opt)          - 備考
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function upsertProject(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.name)     throw new Error('案件名は必須です。');
  if (!data.division) throw new Error('案件区分は必須です。');

  // 案件区分が定義済みか確認する
  if (!PROJECT_STATUS_FLOW[data.division]) {
    throw new Error('無効な案件区分です: ' + data.division);
  }

  var sheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  initProjectSheet(sheet);

  var now  = new Date().toISOString();
  var rows = getAllRows(sheet);
  var id   = data.project_id;

  // デフォルトステータス: 区分のフローの最初の状態
  var defaultStatus = PROJECT_STATUS_FLOW[data.division].flow[0];
  var status        = data.status || defaultStatus;

  // ステータス値を検証する（案件ステータスとタスクステータスは完全に別）
  validateProjectStatus(data.division, status);

  // 日付をスプレッドシート保存形式（YYYY/MM/DD）に変換する
  var startDate    = _toSpreadsheetDate(data.start_date    || '');
  var dueDate      = _toSpreadsheetDate(data.due_date      || '');
  var deliveryDate = _toSpreadsheetDate(data.delivery_date || '');

  if (id) {
    // 更新
    var idx = rows.findIndex(function(r) {
      return String(r[PROJECT_COL.ID - 1]) === id;
    });
    if (idx === -1) throw new Error('案件が見つかりません: ' + id);

    var rowNum    = idx + 2;
    var createdAt = rows[idx][PROJECT_COL.CREATED_AT - 1];
    var createdBy = rows[idx][PROJECT_COL.CREATED_BY - 1];

    // 日付列をテキスト形式に固定してから書き込む
    sheet.getRange(rowNum, PROJECT_COL.START_DATE   ).setNumberFormat('@');
    sheet.getRange(rowNum, PROJECT_COL.DUE_DATE     ).setNumberFormat('@');
    sheet.getRange(rowNum, PROJECT_COL.DELIVERY_DATE).setNumberFormat('@');

    sheet.getRange(rowNum, 1, 1, PROJECT_NUM_COLS).setValues([[
      id,
      data.legacy_code    || rows[idx][PROJECT_COL.LEGACY_CODE    - 1] || '',
      data.customer_id    || rows[idx][PROJECT_COL.CUSTOMER_ID    - 1] || '',
      data.name,
      data.division,
      data.category       || rows[idx][PROJECT_COL.CATEGORY       - 1] || '',
      status,
      data.phase_template || rows[idx][PROJECT_COL.PHASE_TEMPLATE - 1] || '',
      startDate,
      dueDate,
      deliveryDate,
      data.notes !== undefined ? data.notes : rows[idx][PROJECT_COL.NOTES - 1] || '',
      createdBy,
      createdAt,
      now,
      '',
    ]]);

  } else {
    // 新規作成
    id = generateProjectCode(sheet);
    var newRow = sheet.getLastRow() + 1;

    sheet.getRange(newRow, PROJECT_COL.START_DATE   ).setNumberFormat('@');
    sheet.getRange(newRow, PROJECT_COL.DUE_DATE     ).setNumberFormat('@');
    sheet.getRange(newRow, PROJECT_COL.DELIVERY_DATE).setNumberFormat('@');

    sheet.getRange(newRow, 1, 1, PROJECT_NUM_COLS).setValues([[
      id,
      data.legacy_code    || '',
      data.customer_id    || '',
      data.name,
      data.division,
      data.category       || '',
      status,
      data.phase_template || '',
      startDate,
      dueDate,
      deliveryDate,
      data.notes          || '',
      data.operator_id,
      now,
      now,
      '',
    ]]);
  }

  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action   : data.project_id ? 'update_project' : 'create_project',
    admin_id : data.operator_id,
    target_id: id,
    reason   : '案件を' + (data.project_id ? '更新' : '作成'),
  });

  Logger.log('[upsertProject] id=%s, name=%s', id, data.name);
  return { id: id, saved: true };
}

/**
 * 案件ステータスのみを更新する。
 *
 * 案件完了処理もこの関数を使用する。
 * ステータス値は区分ごとのフローに含まれる値のみ許可する。
 *
 * 入力:
 *   data.project_id  - 案件コード（必須）
 *   data.operator_id - 操作者ID（必須）
 *   data.status      - 変更後ステータス（必須）
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function updateProjectStatus(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.project_id) throw new Error('project_id は必須です。');
  if (!data.status)     throw new Error('status は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PROJECT_COL.ID - 1]) === data.project_id &&
           r[PROJECT_COL.DELETED - 1] !== 'true';
  });
  if (idx === -1) throw new Error('案件が見つかりません: ' + data.project_id);

  var division = String(rows[idx][PROJECT_COL.DIVISION - 1] || '');
  validateProjectStatus(division, data.status);

  var rowNum = idx + 2;
  sheet.getRange(rowNum, PROJECT_COL.STATUS    ).setValue(data.status);
  sheet.getRange(rowNum, PROJECT_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action   : 'update_project_status',
    admin_id : data.operator_id,
    target_id: data.project_id,
    reason   : '案件ステータスを「' + data.status + '」に変更',
  });

  Logger.log('[updateProjectStatus] id=%s → %s', data.project_id, data.status);
  return { updated: true, id: data.project_id, status: data.status };
}

/**
 * 案件を論理削除する。
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data - { project_id, operator_id }
 * @returns {Object}
 */
function deleteProject(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.project_id) throw new Error('project_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PROJECT_COL.ID - 1]) === data.project_id;
  });
  if (idx === -1) throw new Error('案件が見つかりません: ' + data.project_id);

  sheet.getRange(idx + 2, PROJECT_COL.DELETED   ).setValue('true');
  sheet.getRange(idx + 2, PROJECT_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action   : 'delete_project',
    admin_id : data.operator_id,
    target_id: data.project_id,
    reason   : '案件を論理削除',
  });

  Logger.log('[deleteProject] id=%s', data.project_id);
  return { deleted: true, id: data.project_id };
}

// ============================================================
// タスク
// ============================================================

/**
 * タスク一覧を取得する。
 *
 * 入力:
 *   data.project_id (opt)   - 案件コードフィルタ（省略時は全件）
 *   data.assignee_id (opt)  - 担当者IDフィルタ
 *   data.status (opt)       - タスクステータスフィルタ
 *   data.include_done (opt) - true の場合「完了」も含める
 *
 * 出力:
 *   { tasks: Object[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getProjectTasks(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  initProjectTaskSheet(sheet);

  var rows = getAllRows(sheet).filter(function(r) {
    return r[PTASK_COL.DELETED - 1] !== 'true';
  });

  // デフォルト: 完了タスクを除外する
  if (!data.include_done) {
    rows = rows.filter(function(r) {
      return String(r[PTASK_COL.STATUS - 1]) !== '完了';
    });
  }

  // 各種フィルタを適用する
  if (data.project_id)  rows = rows.filter(function(r) { return String(r[PTASK_COL.PROJECT_ID  - 1]) === data.project_id;  });
  if (data.assignee_id) rows = rows.filter(function(r) { return String(r[PTASK_COL.ASSIGNEE_ID - 1]) === data.assignee_id; });
  if (data.status)      rows = rows.filter(function(r) { return String(r[PTASK_COL.STATUS      - 1]) === data.status;      });

  // 期限昇順でソートする
  rows.sort(function(a, b) {
    var da = String(a[PTASK_COL.DUE_DATE - 1] || '9999-99-99');
    var db = String(b[PTASK_COL.DUE_DATE - 1] || '9999-99-99');
    return da.localeCompare(db);
  });

  var tasks = rows.map(rowToProjectTask);
  Logger.log('[getProjectTasks] count=%d', tasks.length);
  return { tasks: tasks, count: tasks.length };
}

/**
 * タスクを作成・更新する（upsert）。
 *
 * 新規作成時は通知を生成する（担当者への割り当て通知）。
 *
 * 入力:
 *   data.task_id (opt)         - 更新時に指定
 *   data.operator_id           - 操作者ID（必須）
 *   data.project_id (opt)      - 案件コード（NULL可）
 *   data.legacy_task_code (opt)- 旧T番号（T00101形式）
 *   data.title                 - タスク名（必須）
 *   data.work_content (opt)    - 作業内容
 *   data.assignee_id (opt)     - 担当者ID
 *   data.assignee_name (opt)   - 担当者名
 *   data.requester_id (opt)    - 依頼者ID
 *   data.status (opt)          - ステータス（省略時: '未着手'）
 *   data.current_phase (opt)   - 現在フェーズ
 *   data.priority (opt)        - 優先度（省略時: '中'）
 *   data.start_date (opt)      - 作業開始日
 *   data.due_date (opt)        - 期限
 *   data.scheduled_hours (opt) - 予定工数
 *   data.actual_hours (opt)    - 実績工数
 *   data.folder_material (opt) - 素材フォルダパス
 *   data.folder_work (opt)     - 作業フォルダパス
 *   data.folder_delivery (opt) - 納品フォルダパス
 *   data.notes (opt)           - 備考
 *   data.completion_cond (opt) - 完了条件
 *   data.instruction (opt)     - 指示内容
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function upsertProjectTask(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.title) throw new Error('タスク名は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  initProjectTaskSheet(sheet);

  var now    = new Date().toISOString();
  var rows   = getAllRows(sheet);
  var id     = data.task_id;
  var status = data.status || '未着手';

  // タスクステータスの値を検証する（案件ステータスとは完全に別）
  if (TASK_STATUSES.indexOf(status) === -1) {
    throw new Error('無効なタスクステータスです: ' + status);
  }

  var startDate = _toSpreadsheetDate(data.start_date || '');
  var dueDate   = _toSpreadsheetDate(data.due_date   || '');

  var isNewTask = !id;

  if (id) {
    // 更新
    var idx = rows.findIndex(function(r) {
      return String(r[PTASK_COL.ID - 1]) === id;
    });
    if (idx === -1) throw new Error('タスクが見つかりません: ' + id);

    var rowNum    = idx + 2;
    var createdAt = rows[idx][PTASK_COL.CREATED_AT - 1];
    var existing  = rows[idx];

    sheet.getRange(rowNum, PTASK_COL.START_DATE).setNumberFormat('@');
    sheet.getRange(rowNum, PTASK_COL.DUE_DATE  ).setNumberFormat('@');

    sheet.getRange(rowNum, 1, 1, PTASK_NUM_COLS).setValues([[
      id,
      data.legacy_task_code !== undefined ? data.legacy_task_code : existing[PTASK_COL.LEGACY_TASK_CODE - 1] || '',
      data.project_id       !== undefined ? data.project_id       : existing[PTASK_COL.PROJECT_ID       - 1] || '',
      data.title,
      data.work_content     !== undefined ? data.work_content     : existing[PTASK_COL.WORK_CONTENT     - 1] || '',
      data.assignee_id      !== undefined ? data.assignee_id      : existing[PTASK_COL.ASSIGNEE_ID      - 1] || '',
      data.assignee_name    !== undefined ? data.assignee_name    : existing[PTASK_COL.ASSIGNEE_NAME    - 1] || '',
      data.requester_id     !== undefined ? data.requester_id     : existing[PTASK_COL.REQUESTER_ID     - 1] || '',
      status,
      data.current_phase    !== undefined ? data.current_phase    : existing[PTASK_COL.CURRENT_PHASE    - 1] || '',
      data.priority         || existing[PTASK_COL.PRIORITY        - 1] || '中',
      startDate || _toSpreadsheetDate(_normDateStr(existing[PTASK_COL.START_DATE - 1])),
      dueDate   || _toSpreadsheetDate(_normDateStr(existing[PTASK_COL.DUE_DATE   - 1])),
      data.scheduled_hours !== undefined ? data.scheduled_hours   : existing[PTASK_COL.SCHEDULED_HOURS  - 1] || '',
      data.actual_hours    !== undefined ? data.actual_hours      : existing[PTASK_COL.ACTUAL_HOURS     - 1] || '',
      data.folder_material !== undefined ? data.folder_material   : existing[PTASK_COL.FOLDER_MATERIAL  - 1] || '',
      data.folder_work     !== undefined ? data.folder_work       : existing[PTASK_COL.FOLDER_WORK      - 1] || '',
      data.folder_delivery !== undefined ? data.folder_delivery   : existing[PTASK_COL.FOLDER_DELIVERY  - 1] || '',
      data.notes           !== undefined ? data.notes             : existing[PTASK_COL.NOTES            - 1] || '',
      data.completion_cond !== undefined ? data.completion_cond   : existing[PTASK_COL.COMPLETION_COND  - 1] || '',
      data.instruction     !== undefined ? data.instruction       : existing[PTASK_COL.INSTRUCTION      - 1] || '',
      createdAt,
      now,
      '',
    ]]);

  } else {
    // 新規作成
    id = data.project_id
      ? generateTaskCode(sheet, data.project_id)
      : generateId(); // 案件なしタスクは UUID

    var newRow = sheet.getLastRow() + 1;

    sheet.getRange(newRow, PTASK_COL.START_DATE).setNumberFormat('@');
    sheet.getRange(newRow, PTASK_COL.DUE_DATE  ).setNumberFormat('@');

    sheet.getRange(newRow, 1, 1, PTASK_NUM_COLS).setValues([[
      id,
      data.legacy_task_code || '',
      data.project_id       || '',
      data.title,
      data.work_content     || '',
      data.assignee_id      || '',
      data.assignee_name    || '',
      data.requester_id     || '',
      status,
      data.current_phase    || '',
      data.priority         || '中',
      startDate,
      dueDate,
      data.scheduled_hours  || '',
      data.actual_hours     || '',
      data.folder_material  || '',
      data.folder_work      || '',
      data.folder_delivery  || '',
      data.notes            || '',
      data.completion_cond  || '',
      data.instruction      || '',
      now,
      now,
      '',
    ]]);
  }

  SpreadsheetApp.flush();

  // 新規タスク割り当て時の通知
  if (isNewTask && data.assignee_id) {
    createNotification(ss, {
      recipient_id: data.assignee_id,
      type        : NOTIF_TYPE.NEW_TASK,
      title       : '新しいタスクが割り当てられました',
      body        : data.title + (data.due_date ? '（期限: ' + data.due_date + '）' : ''),
      task_id     : id,
      project_id  : data.project_id || '',
    });
  }

  // 指示内容がある場合の通知
  if (isNewTask && data.instruction && data.assignee_id) {
    createNotification(ss, {
      recipient_id: data.assignee_id,
      type        : NOTIF_TYPE.INSTRUCTION,
      title       : '作業指示があります',
      body        : data.title + '：' + data.instruction.slice(0, 50),
      task_id     : id,
      project_id  : data.project_id || '',
    });
  }

  Logger.log('[upsertProjectTask] id=%s, title=%s', id, data.title);
  return { id: id, saved: true };
}

/**
 * タスクステータスのみを更新する。
 *
 * ステータス変更に応じて通知を生成する:
 *   確認待ち → 依頼者・Lv2以上スタッフに通知
 *   修正依頼 → 担当者に通知
 *
 * 入力:
 *   data.task_id     - タスクコード（必須）
 *   data.operator_id - 操作者ID（必須）
 *   data.status      - 変更後ステータス（必須）
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function updateTaskStatus(ss, employeeSheet, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.status)      throw new Error('status は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);

  var sheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PTASK_COL.ID - 1]) === data.task_id &&
           r[PTASK_COL.DELETED - 1] !== 'true';
  });
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);

  var task = rowToProjectTask(rows[idx]);

  // 権限・値を検証する（タスクステータス専用の検証）
  validateTaskStatusChange(operator, task, data.status);

  var rowNum = idx + 2;
  sheet.getRange(rowNum, PTASK_COL.STATUS    ).setValue(data.status);
  sheet.getRange(rowNum, PTASK_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  // ステータスに応じた通知を生成する
  if (data.status === '確認待ち' && task.requester_id) {
    createNotification(ss, {
      recipient_id: task.requester_id,
      type        : NOTIF_TYPE.REVIEW_REQUEST,
      title       : '確認依頼があります',
      body        : task.title + ' が確認待ちになりました',
      task_id     : data.task_id,
      project_id  : task.project_id,
    });
  }

  if (data.status === '修正依頼' && task.assignee_id) {
    createNotification(ss, {
      recipient_id: task.assignee_id,
      type        : NOTIF_TYPE.REVISION,
      title       : '修正依頼があります',
      body        : task.title + ' に修正依頼が届いています',
      task_id     : data.task_id,
      project_id  : task.project_id,
    });
  }

  Logger.log('[updateTaskStatus] id=%s → %s', data.task_id, data.status);
  return { updated: true, id: data.task_id, status: data.status };
}

/**
 * タスクの現在フェーズのみを更新する。
 *
 * フェーズ変更は担当者本人もLv1から実行可能。
 * 変更内容は作業メモに自動ログを残す。
 *
 * 入力:
 *   data.task_id      - タスクコード（必須）
 *   data.operator_id  - 操作者ID（必須）
 *   data.current_phase - 変更後フェーズ名（必須）
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function updateTaskPhase(ss, employeeSheet, data) {
  if (!data.task_id)       throw new Error('task_id は必須です。');
  if (!data.operator_id)   throw new Error('operator_id は必須です。');
  if (!data.current_phase) throw new Error('current_phase は必須です。');

  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);

  var sheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PTASK_COL.ID - 1]) === data.task_id &&
           r[PTASK_COL.DELETED - 1] !== 'true';
  });
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);

  var task = rowToProjectTask(rows[idx]);

  // Lv1スタッフは自分担当タスクのみフェーズ変更可
  if (getPermissionLevel(operator) < 2 && task.assignee_id !== operator.id) {
    throw new Error('他の担当者のタスクのフェーズは変更できません。');
  }

  var prevPhase = task.current_phase;
  var rowNum    = idx + 2;
  sheet.getRange(rowNum, PTASK_COL.CURRENT_PHASE).setValue(data.current_phase);
  sheet.getRange(rowNum, PTASK_COL.UPDATED_AT   ).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  // フェーズ変更ログを作業メモに自動追記する
  addWorkMemo(ss, {
    task_id     : data.task_id,
    author_id   : operator.id,
    author_name : operator.name,
    work_date   : _normDateStr(new Date()),
    phase       : data.current_phase,
    content     : '[自動] フェーズ変更: ' + (prevPhase || '（未設定）') + ' → ' + data.current_phase,
    progress    : '',
    actual_hours: null,
    memo        : '',
  });

  Logger.log('[updateTaskPhase] id=%s → %s', data.task_id, data.current_phase);
  return { updated: true, id: data.task_id, current_phase: data.current_phase };
}

/**
 * タスクを論理削除する。
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data - { task_id, operator_id }
 * @returns {Object}
 */
function deleteProjectTask(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.task_id) throw new Error('task_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PTASK_COL.ID - 1]) === data.task_id;
  });
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);

  sheet.getRange(idx + 2, PTASK_COL.DELETED   ).setValue('true');
  sheet.getRange(idx + 2, PTASK_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  Logger.log('[deleteProjectTask] id=%s', data.task_id);
  return { deleted: true, id: data.task_id };
}

// ============================================================
// 作業メモ
// ============================================================

/**
 * 作業メモ一覧を取得する。
 *
 * 入力:
 *   data.task_id (opt)      - タスクコードフィルタ
 *   data.author_id (opt)    - 投稿者IDフィルタ
 *   data.work_date (opt)    - 作業日フィルタ（YYYY-MM-DD）
 *
 * 出力:
 *   { memos: Object[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getWorkMemos(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.WORK_MEMOS);
  initWorkMemoSheet(sheet);

  var rows = getAllRows(sheet);

  if (data.task_id)   rows = rows.filter(function(r) { return String(r[MEMO_COL.TASK_ID   - 1]) === data.task_id;              });
  if (data.author_id) rows = rows.filter(function(r) { return String(r[MEMO_COL.AUTHOR_ID - 1]) === data.author_id;            });
  if (data.work_date) {
    var wdKey = _toSpreadsheetDate(data.work_date);
    rows = rows.filter(function(r) {
      return _toSpreadsheetDate(_normDateStr(r[MEMO_COL.WORK_DATE - 1])) === wdKey;
    });
  }

  // 投稿日時昇順（古い順に表示）
  rows.sort(function(a, b) {
    return String(a[MEMO_COL.CREATED_AT - 1]).localeCompare(String(b[MEMO_COL.CREATED_AT - 1]));
  });

  var memos = rows.map(rowToWorkMemo);
  return { memos: memos, count: memos.length };
}

/**
 * 作業メモを追記する。
 *
 * スタッフが退勤時または進捗報告時に呼ぶ。
 * updateTaskPhase() からも自動呼び出しされる（フェーズ変更ログ）。
 *
 * 入力:
 *   data.task_id (opt)      - タスクコード（NULL可）
 *   data.author_id          - 投稿者ID（必須）
 *   data.author_name        - 投稿者名（必須）
 *   data.work_date          - 作業日（YYYY-MM-DD・必須）
 *   data.phase (opt)        - フェーズ名
 *   data.content            - 作業内容（必須）
 *   data.progress (opt)     - 進捗状況
 *   data.actual_hours (opt) - 実績工数
 *   data.memo (opt)         - メモ
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function addWorkMemo(ss, data) {
  if (!data.author_id)  throw new Error('author_id は必須です。');
  if (!data.author_name)throw new Error('author_name は必須です。');
  if (!data.work_date)  throw new Error('work_date は必須です。');
  if (!data.content)    throw new Error('content は必須です。');

  var sheet  = getOrCreateSheet(ss, SHEET.WORK_MEMOS);
  initWorkMemoSheet(sheet);

  var id      = generateId();
  var now     = new Date().toISOString();
  var rowNum  = sheet.getLastRow() + 1;
  var workDate = _toSpreadsheetDate(data.work_date);

  sheet.getRange(rowNum, MEMO_COL.WORK_DATE).setNumberFormat('@');

  sheet.getRange(rowNum, 1, 1, MEMO_NUM_COLS).setValues([[
    id,
    data.task_id      || '',
    data.author_id,
    data.author_name,
    workDate,
    data.phase        || '',
    data.content,
    data.progress     || '',
    data.actual_hours !== undefined && data.actual_hours !== null ? data.actual_hours : '',
    data.memo         || '',
    now,
  ]]);

  SpreadsheetApp.flush();
  Logger.log('[addWorkMemo] id=%s, author=%s', id, data.author_id);
  return { id: id, saved: true };
}

// ============================================================
// 相談スレッド
// ============================================================

/**
 * 相談スレッドを取得する。
 *
 * 入力:
 *   data.task_id - タスクコード（必須）
 *
 * 出力:
 *   { consultations: Object[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getConsultations(ss, data) {
  if (!data.task_id) throw new Error('task_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  initConsultationSheet(sheet);

  var rows = getAllRows(sheet).filter(function(r) {
    return String(r[CONSULT_COL.TASK_ID - 1]) === data.task_id;
  });

  // 投稿日時昇順（スレッド表示のため古い順）
  rows.sort(function(a, b) {
    return String(a[CONSULT_COL.CREATED_AT - 1]).localeCompare(String(b[CONSULT_COL.CREATED_AT - 1]));
  });

  var consultations = rows.map(rowToConsultation);
  return { consultations: consultations, count: consultations.length };
}

/**
 * 相談を投稿する。
 *
 * 投稿後、タスクの依頼者・Lv2以上の全員に通知を送る。
 *
 * 入力:
 *   data.task_id     - タスクコード（必須）
 *   data.author_id   - 投稿者ID（必須）
 *   data.author_name - 投稿者名（必須）
 *   data.content     - 投稿内容（必須）
 *   data.parent_id (opt) - 返信先投稿ID
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function postConsultation(ss, employeeSheet, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.author_id)   throw new Error('author_id は必須です。');
  if (!data.author_name) throw new Error('author_name は必須です。');
  if (!data.content)     throw new Error('内容は必須です。');

  var sheet  = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  initConsultationSheet(sheet);

  var id     = generateId();
  var now    = new Date().toISOString();
  var rowNum = sheet.getLastRow() + 1;

  sheet.getRange(rowNum, 1, 1, CONSULT_NUM_COLS).setValues([[
    id,
    data.task_id,
    data.parent_id   || '',
    data.author_id,
    data.author_name,
    data.content,
    now,
  ]]);

  SpreadsheetApp.flush();

  // タスクの依頼者に通知を送る（投稿者自身には送らない）
  var taskSheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  var taskRows  = getAllRows(taskSheet).filter(function(r) {
    return String(r[PTASK_COL.ID - 1]) === data.task_id;
  });

  if (taskRows.length > 0) {
    var task = rowToProjectTask(taskRows[0]);

    if (task.requester_id && task.requester_id !== data.author_id) {
      createNotification(ss, {
        recipient_id: task.requester_id,
        type        : NOTIF_TYPE.CONSULTATION,
        title       : '相談が投稿されました',
        body        : data.author_name + '：' + data.content.slice(0, 50),
        task_id     : data.task_id,
        project_id  : task.project_id,
      });
    }
  }

  Logger.log('[postConsultation] id=%s, task=%s', id, data.task_id);
  return { id: id, saved: true };
}

// ============================================================
// 通知
// ============================================================

/**
 * 通知を生成してシートに書き込む。
 *
 * 通知の失敗はメイン処理に影響させないため try/catch で握り潰す。
 * saveBackup() と同じ設計方針。
 *
 * Phase 2: この関数の末尾で sendDiscordNotification() を有効化する。
 * Discord通知の ON/OFF は GASスクリプトプロパティの
 * 'DISCORD_WEBHOOK_URL' の有無で切り替える（設定なし=スキップ）。
 *
 * @param {Spreadsheet} ss
 * @param {Object} notif - { recipient_id, type, title, body, task_id, project_id }
 */
function createNotification(ss, notif) {
  try {
    var sheet  = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
    initNotificationSheet(sheet);

    var id     = generateId();
    var now    = new Date().toISOString();
    var rowNum = sheet.getLastRow() + 1;

    sheet.getRange(rowNum, 1, 1, NOTIF_NUM_COLS).setValues([[
      id,
      notif.recipient_id || '',
      notif.type         || '',
      notif.title        || '',
      notif.body         || '',
      notif.task_id      || '',
      notif.project_id   || '',
      false,                   // IS_READ: 未読。Boolean false を書き込む。
                               // setValue('false') では GAS が文字列/Booleanを混在させる
                               // ことがあるため、Boolean値で統一して書き込む。
                               // 読み取り時は String().toLowerCase()==='true' で比較する。
      now,
    ]]);

    Logger.log('[createNotification] type=%s, recipient=%s', notif.type, notif.recipient_id);

    // Phase 2: Discord通知（Webhook URLが設定されている場合のみ）
    // sendDiscordNotification(notif.title, notif.body);

  } catch (err) {
    // 通知失敗はメイン処理に影響させない（saveBackup と同じ設計）
    Logger.log('[createNotification] 失敗（非致命的）: %s', err.message);
  }
}

/**
 * 指定受信者の通知一覧を取得する。
 *
 * 入力:
 *   data.recipient_id       - 受信者ID（必須）
 *   data.unread_only (opt)  - true の場合未読のみ返す
 *   data.limit (opt)        - 最大件数（省略時: 50）
 *
 * 出力:
 *   { notifications: Object[], unread_count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getNotifications(ss, data) {
  if (!data.recipient_id) throw new Error('recipient_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  initNotificationSheet(sheet);

  // flush() を明示的に呼んでからシートを読む。
  //
  // 理由:
  //   markNotificationRead / markAllNotificationsRead が setValue() + flush() で
  //   IS_READ を更新した直後にこの関数を呼ぶと、GAS の内部キャッシュが
  //   古い getValues() 結果を返すことがある。
  //   flush() を再度呼ぶことでキャッシュをクリアし、最新値を確実に読む。
  SpreadsheetApp.flush();

  var rows = getAllRows(sheet).filter(function(r) {
    return String(r[NOTIF_COL.RECIPIENT_ID - 1]) === data.recipient_id;
  });

  // 既読フラグの型安全な判定関数。
  // setValue(true) で書いた Boolean true を getValue() で読むと Boolean true が返る。
  // String() で変換してから比較することで Boolean/文字列の両方に対応する。
  var _isRead = function(r) {
    return String(r[NOTIF_COL.IS_READ - 1]).toLowerCase() === 'true';
  };

  var unreadCount = rows.filter(function(r) { return !_isRead(r); }).length;

  if (data.unread_only) {
    rows = rows.filter(function(r) { return !_isRead(r); });
  }

  // 新しい順にソートする
  rows.sort(function(a, b) {
    return String(b[NOTIF_COL.CREATED_AT - 1]).localeCompare(String(a[NOTIF_COL.CREATED_AT - 1]));
  });

  var limit = data.limit || 50;
  rows = rows.slice(0, limit);

  var notifications = rows.map(function(r) {
    return {
      id           : String(r[NOTIF_COL.ID           - 1] || ''),
      recipient_id : String(r[NOTIF_COL.RECIPIENT_ID - 1] || ''),
      type         : String(r[NOTIF_COL.TYPE         - 1] || ''),
      title        : String(r[NOTIF_COL.TITLE        - 1] || ''),
      body         : String(r[NOTIF_COL.BODY         - 1] || ''),
      task_id      : String(r[NOTIF_COL.TASK_ID      - 1] || ''),
      project_id   : String(r[NOTIF_COL.PROJECT_ID   - 1] || ''),
      is_read      : String(r[NOTIF_COL.IS_READ - 1]).toLowerCase() === 'true',
      created_at   : String(r[NOTIF_COL.CREATED_AT   - 1] || ''),
    };
  });

  return { notifications: notifications, unread_count: unreadCount };
}

/**
 * 通知を既読にする。
 *
 * 入力:
 *   data.notification_id - 通知ID（必須）
 *   data.recipient_id    - 受信者ID（本人確認用・必須）
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function markNotificationRead(ss, data) {
  if (!data.notification_id) throw new Error('notification_id は必須です。');
  if (!data.recipient_id)    throw new Error('recipient_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[NOTIF_COL.ID - 1]) === data.notification_id &&
           String(r[NOTIF_COL.RECIPIENT_ID - 1]) === data.recipient_id;
  });
  if (idx === -1) throw new Error('通知が見つかりません: ' + data.notification_id);

  // Boolean true を書き込む（文字列'true'より確実にセルに反映される）
  sheet.getRange(idx + 2, NOTIF_COL.IS_READ).setValue(true);
  SpreadsheetApp.flush();

  return { updated: true, id: data.notification_id };
}

/**
 * 指定受信者の全通知を既読にする。
 *
 * 入力:
 *   data.recipient_id - 受信者ID（必須）
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function markAllNotificationsRead(ss, data) {
  if (!data.recipient_id) throw new Error('recipient_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  var rows  = getAllRows(sheet);
  var count = 0;

  // ループ内で逐次 setValue すると GAS の API 呼び出しが行数分発生して遅い。
  // 未読行の行番号を収集してから一括で setValue する。
  var targetRows = [];
  rows.forEach(function(r, i) {
    if (String(r[NOTIF_COL.RECIPIENT_ID - 1]) === data.recipient_id &&
        String(r[NOTIF_COL.IS_READ - 1]).toLowerCase() !== 'true') {
      targetRows.push(i + 2); // シート行番号（+2 = ヘッダー行 + 0始まり補正）
      count++;
    }
  });

  // 未読行を1行ずつ更新する（非連続行のため setValues 一括は使えない）
  // ただし flush は最後に1回だけ呼ぶことで書き込みをまとめる
  targetRows.forEach(function(rowNum) {
    sheet.getRange(rowNum, NOTIF_COL.IS_READ).setValue(true); // Boolean で書き込む
  });

  if (count > 0) SpreadsheetApp.flush();
  return { updated: count };
}

/**
 * Phase 2 実装予定: Discord Webhook 通知。
 *
 * スクリプトプロパティ 'DISCORD_WEBHOOK_URL' に Webhook URL を設定することで
 * 画面内通知に加えて Discord にも通知が届くようになる。
 * URL 未設定の場合は即座に return する（Phase 1 は常にスキップ）。
 *
 * @param {string} title
 * @param {string} body
 */
function sendDiscordNotification(title, body) {
  try {
    var webhookUrl = PropertiesService.getScriptProperties()
      .getProperty('DISCORD_WEBHOOK_URL');

    // Phase 1: URL未設定のためスキップ。Phase 2でプロパティを設定するだけで有効化される。
    if (!webhookUrl) return;

    UrlFetchApp.fetch(webhookUrl, {
      method     : 'post',
      contentType: 'application/json',
      payload    : JSON.stringify({ content: '**' + title + '**\n' + body }),
    });

    Logger.log('[sendDiscordNotification] 送信成功: %s', title);
  } catch (err) {
    Logger.log('[sendDiscordNotification] 失敗（非致命的）: %s', err.message);
  }
}

// ============================================================
// フェーズテンプレート
// ============================================================

/**
 * フェーズテンプレート一覧を取得する。
 *
 * 出力:
 *   { templates: Object[] }
 *
 * @param {Spreadsheet} ss
 * @returns {Object}
 */
function getPhaseTemplates(ss) {
  var sheet = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
  initPhaseTemplateSheet(sheet);

  var templates = getAllRows(sheet).map(rowToPhaseTemplate);
  return { templates: templates };
}

/**
 * フェーズテンプレートを作成・更新する。
 *
 * 入力:
 *   data.template_id (opt) - 更新時に指定
 *   data.operator_id       - 操作者ID（必須）
 *   data.name              - テンプレート名（必須）
 *   data.phases            - フェーズ名の配列（必須）
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function upsertPhaseTemplate(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.name)   throw new Error('テンプレート名は必須です。');
  if (!Array.isArray(data.phases) || data.phases.length === 0) {
    throw new Error('フェーズは1つ以上指定してください。');
  }

  var sheet = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
  initPhaseTemplateSheet(sheet);

  var now       = new Date().toISOString();
  var rows      = getAllRows(sheet);
  var id        = data.template_id;
  var phasesStr = JSON.stringify(data.phases);

  if (id) {
    var idx = rows.findIndex(function(r) {
      return String(r[PHASE_TPL_COL.ID - 1]) === id;
    });
    if (idx === -1) throw new Error('テンプレートが見つかりません: ' + id);

    var createdAt = rows[idx][PHASE_TPL_COL.CREATED_AT - 1];
    sheet.getRange(idx + 2, 1, 1, PHASE_TPL_NUM_COLS).setValues([[
      id, data.name, phasesStr, createdAt, now,
    ]]);
  } else {
    id = generateId();
    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, PHASE_TPL_NUM_COLS).setValues([[
      id, data.name, phasesStr, now, now,
    ]]);
  }

  SpreadsheetApp.flush();
  Logger.log('[upsertPhaseTemplate] id=%s, name=%s', id, data.name);
  return { id: id, saved: true };
}

/**
 * フェーズテンプレートを削除する（物理削除）。
 *
 * テンプレートは参照件数が少ないため物理削除を採用する。
 * 削除後も既存案件の phase_template フィールドには ID が残る（孤立を許容）。
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data - { template_id, operator_id }
 * @returns {Object}
 */
function deletePhaseTemplate(ss, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  if (!data.template_id) throw new Error('template_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PHASE_TPL_COL.ID - 1]) === data.template_id;
  });
  if (idx === -1) throw new Error('テンプレートが見つかりません: ' + data.template_id);

  sheet.deleteRow(idx + 2);
  SpreadsheetApp.flush();

  Logger.log('[deletePhaseTemplate] id=%s', data.template_id);
  return { deleted: true, id: data.template_id };
}

// ============================================================
// 管理者ダッシュボード
// ============================================================

/**
 * 制作進行ダッシュボードデータを取得する。
 *
 * 返すデータ:
 *   summary         サマリーカード（出勤人数・タスク件数別集計）
 *   staff_status    スタッフ別状況（出勤状態・担当タスク・空き工数）
 *   project_alerts  要注意案件（遅延・納期近・確認待ち）
 *
 * 実行コスト:
 *   案件・タスク・出退勤記録・人員マスタを1回ずつ読む。
 *   GAS の6分制限を超えないよう、全件をメモリ上で JOIN する。
 *
 * @param {Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data - { date (opt): YYYY-MM-DD }
 * @returns {Object}
 */
function getProjectDashboard(ss, attendanceSheet, employeeSheet, data) {
  var operator = getEmployeeOrThrow(employeeSheet, data.operator_id);
  requirePermissionLevel(operator, 2);

  var today = data.date
    ? _toSpreadsheetDate(data.date)
    : _toSpreadsheetDate(_normDateStr(new Date()));

  // ── 1回ずつ全シートを読み込む ────────────────────
  var employeeRows  = getAllRows(employeeSheet);
  var attendRows    = getAllRows(attendanceSheet);
  var projectSheet  = getOrCreateSheet(ss, SHEET.PROJECTS);
  var taskSheet     = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
  initProjectSheet(projectSheet);
  initProjectTaskSheet(taskSheet);
  var projectRows = getAllRows(projectSheet).filter(function(r) { return r[PROJECT_COL.DELETED  - 1] !== 'true'; });
  var taskRows    = getAllRows(taskSheet).filter(function(r)    { return r[PTASK_COL.DELETED     - 1] !== 'true'; });

  // ── 本日の出退勤記録を Map に格納（employee_id → record）──
  var todayAttMap = {};
  attendRows.forEach(function(r) {
    if (String(r[ATTENDANCE_COL.DATE - 1]).replace(/-/g, '/') === today) {
      todayAttMap[String(r[ATTENDANCE_COL.EMPLOYEE_ID - 1])] = r;
    }
  });

  // ── 進行中タスクを担当者別 Map に格納 ────────────
  var tasksByAssignee = {};
  taskRows.forEach(function(r) {
    var st  = String(r[PTASK_COL.STATUS      - 1] || '');
    var aid = String(r[PTASK_COL.ASSIGNEE_ID - 1] || '');
    if (st === '完了' || !aid) return;
    if (!tasksByAssignee[aid]) tasksByAssignee[aid] = [];
    tasksByAssignee[aid].push(r);
  });

  // ── タスク件数集計 ───────────────────────────────
  var statusCount = {};
  TASK_STATUSES.forEach(function(s) { statusCount[s] = 0; });
  taskRows.forEach(function(r) {
    var st = String(r[PTASK_COL.STATUS - 1] || '');
    if (statusCount[st] !== undefined) statusCount[st]++;
  });

  // 期限超過タスク数
  var today_iso = today.replace(/\//g, '-');
  var overdueTaskCount = taskRows.filter(function(r) {
    var st  = String(r[PTASK_COL.STATUS  - 1] || '');
    var due = _normDateStr(r[PTASK_COL.DUE_DATE - 1]);
    return st !== '完了' && due && due < today_iso;
  }).length;

  // ── スタッフ状況を生成 ───────────────────────────
  var staffStatuses = employeeRows
    .filter(function(r) {
      return r[EMPLOYEE_COL.DELETED - 1] !== 'true' && r[EMPLOYEE_COL.ID - 1];
    })
    .map(function(r) {
      var emp       = rowToEmployee(r);
      var attRow    = todayAttMap[emp.id];
      var isPresent = !!(attRow && attRow[ATTENDANCE_COL.TIME_IN - 1]);
      var timeIn    = attRow ? String(attRow[ATTENDANCE_COL.TIME_IN  - 1] || '') : '';
      var timeOut   = attRow ? String(attRow[ATTENDANCE_COL.TIME_OUT - 1] || '') : '';
      var memo      = attRow ? String(attRow[ATTENDANCE_COL.MEMO       - 1] || '') : '';

      var myTasks = (tasksByAssignee[emp.id] || []).map(function(tr) {
        var dueDate  = _normDateStr(tr[PTASK_COL.DUE_DATE - 1]);
        return {
          task_id      : String(tr[PTASK_COL.ID            - 1] || ''),
          task_title   : String(tr[PTASK_COL.TITLE         - 1] || ''),
          project_id   : String(tr[PTASK_COL.PROJECT_ID    - 1] || ''),
          status       : String(tr[PTASK_COL.STATUS        - 1] || ''),
          current_phase: String(tr[PTASK_COL.CURRENT_PHASE - 1] || ''),
          due_date     : dueDate,
          is_overdue   : !!(dueDate && dueDate < today_iso),
          scheduled_hours: _toNum(tr[PTASK_COL.SCHEDULED_HOURS - 1]),
        };
      });

      // 所定労働時間 - 予定工数合計 = 空き工数
      var scheduledWork = emp.scheduled_hours || 0;
      var totalPlanned  = myTasks.reduce(function(sum, t) {
        return sum + (t.scheduled_hours || 0);
      }, 0);
      var available = Math.max(0, scheduledWork - totalPlanned);

      return {
        id             : emp.id,
        name           : emp.name,
        employment_type: emp.employment_type,
        is_present     : isPresent,
        time_in        : timeIn,
        time_out       : timeOut,
        today_plan     : memo,
        current_tasks  : myTasks,
        scheduled_hours: scheduledWork,
        planned_hours  : totalPlanned,
        available_hours: available,
        has_overdue    : myTasks.some(function(t) { return t.is_overdue; }),
      };
    });

  // ── 要注意案件を生成 ─────────────────────────────
  var overdueProjects  = [];
  var dueSoonProjects  = [];
  var reviewProjects   = [];

  // 確認待ちタスクを案件別に集計する
  var reviewTasksByProject = {};
  taskRows.forEach(function(r) {
    if (String(r[PTASK_COL.STATUS - 1]) !== '確認待ち') return;
    var pid = String(r[PTASK_COL.PROJECT_ID - 1] || '');
    if (!pid) return;
    if (!reviewTasksByProject[pid]) reviewTasksByProject[pid] = [];
    reviewTasksByProject[pid].push({
      task_id      : String(r[PTASK_COL.ID           - 1] || ''),
      task_title   : String(r[PTASK_COL.TITLE        - 1] || ''),
      assignee_name: String(r[PTASK_COL.ASSIGNEE_NAME- 1] || ''),
    });
  });

  var futureDays3 = new Date();
  futureDays3.setDate(futureDays3.getDate() + 3);
  var limit3 = _normDateStr(futureDays3);

  projectRows.forEach(function(r) {
    var st      = String(r[PROJECT_COL.STATUS   - 1] || '');
    var dueDate = _normDateStr(r[PROJECT_COL.DUE_DATE - 1]);
    var pid     = String(r[PROJECT_COL.ID       - 1] || '');
    var pname   = String(r[PROJECT_COL.NAME     - 1] || '');
    var client  = String(r[PROJECT_COL.CUSTOMER_ID - 1] || '');

    if (st === '完了' || st === 'キャンセル') return;

    var baseInfo = { id: pid, name: pname, client: client, due_date: dueDate, status: st };

    // 遅延案件: 納期が今日より前
    if (dueDate && dueDate < today_iso) {
      var daysOver = Math.floor(
        (new Date(today_iso) - new Date(dueDate)) / 86400000
      );
      overdueProjects.push(Object.assign({}, baseInfo, { overdue_days: daysOver }));
    }

    // 納期3日以内
    if (dueDate && dueDate >= today_iso && dueDate <= limit3) {
      var daysLeft = Math.ceil(
        (new Date(dueDate) - new Date(today_iso)) / 86400000
      );
      dueSoonProjects.push(Object.assign({}, baseInfo, { days_remaining: daysLeft }));
    }

    // 確認待ちタスクを持つ案件
    if (reviewTasksByProject[pid]) {
      reviewProjects.push(Object.assign({}, baseInfo, {
        tasks: reviewTasksByProject[pid],
      }));
    }
  });

  // ── サマリー集計 ─────────────────────────────────
  var presentCount = Object.keys(todayAttMap).filter(function(eid) {
    return !!todayAttMap[eid][ATTENDANCE_COL.TIME_IN - 1];
  }).length;

  return {
    summary: {
      today_attendance     : presentCount,
      task_not_started     : statusCount['未着手']  || 0,
      task_in_progress     : statusCount['作業中']  || 0,
      task_review_waiting  : statusCount['確認待ち']|| 0,
      task_revision        : statusCount['修正依頼']|| 0,
      task_on_hold         : statusCount['保留']    || 0,
      task_overdue         : overdueTaskCount,
    },
    staff_status   : staffStatuses,
    project_alerts : {
      overdue      : overdueProjects,
      due_soon     : dueSoonProjects,
      review_waiting: reviewProjects,
    },
  };
}

// ============================================================
// マスタ取得（UI ドロップダウン用）
// ============================================================

/**
 * UI ドロップダウン用マスタデータを一括取得する。
 *
 * フロントの案件・タスク作成フォームでドロップダウンに使用する。
 * この関数は認証・権限チェックなしで呼べる（マスタは参照専用）。
 *
 * 出力:
 *   {
 *     project_status_flow : 案件区分別ステータスフロー
 *     task_statuses       : タスクステータス一覧
 *     project_categories  : カテゴリー一覧
 *     task_priorities     : 優先度一覧
 *     notif_types         : 通知種別一覧
 *   }
 *
 * @returns {Object}
 */
function getProjectMasters() {
  return {
    project_status_flow: PROJECT_STATUS_FLOW,
    task_statuses      : TASK_STATUSES,
    task_statuses_for_staff: TASK_STATUSES_FOR_STAFF,
    project_categories : PROJECT_CATEGORIES,
    task_priorities    : TASK_PRIORITIES,
    notif_types        : NOTIF_TYPE,
  };
}
