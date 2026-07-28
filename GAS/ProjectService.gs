/**
 * ProjectService.gs — 制作進行管理サービス（v2）
 *
 * 役割:
 *   顧客・案件・案件メンバー・相談・通知・フェーズテンプレート・
 *   ダッシュボードデータの CRUD を実装する。
 *
 * 【旧 ProjectServices.gs からの主な変更点】
 *   1. PROJECT_TASKS シート廃止
 *      → タスク処理はすべて TaskService.gs / tasks シートへ委譲
 *      → PTASK_COL / initProjectTaskSheet / rowToProjectTask を削除
 *      → upsertProjectTask / getProjectTasks 等のタスク関数を削除
 *
 *   2. 作業メモ（MEMO_COL）廃止
 *      → task_comments シート（Shared.gs 定義）に統合
 *      → get_work_memos / add_work_memo は get_task_comments / add_task_comment に改名
 *
 *   3. 相談（CONSULT_COL）刷新
 *      → project_id 列を追加（案件・タスク起点の両方に対応）
 *      → consultation_recipients シートで送信先を管理（Shared.gs 定義済み）
 *      → 送信先選択 API を追加
 *
 *   4. project_members シート追加
 *      → 案件と利用者の多対多を管理
 *      → 利用者は参加案件のみ閲覧可能（権限制御を実装）
 *
 *   5. getProjectDashboard を tasks シート参照に更新
 *      → TASK_STATUS_V2 / TASK_COL / TASK_ASSIGN_COL を使用
 *      → レビュー待ち件数・未着手件数を正確に集計
 *
 * 設計方針:
 *   - Code.gs の generateId / getAllRows / getOrCreateSheet /
 *     createSuccessResponse / createErrorResponse / writeAuditLog /
 *     saveBackup / rowToEmployee / convertDateForDisplay / validateDateFormat を使う
 *   - Shared.gs の SHEET_V2 / TASK_COL / TASK_ASSIGN_COL /
 *     TASK_STATUS_V2 / PROJECT_MEMBER_COL / TASK_COMMENT_COL /
 *     initProjectMemberSheet / initTaskCommentSheet /
 *     rowToTask / rowToProjectMember / rowToTaskComment /
 *     _toSlashDate / _normDateToHyphen / _toNumOrNull を使う
 *   - 権限チェックはすべての書き込み処理の先頭で行う
 *   - 論理削除フラグが 'true' のレコードは常に除外する
 *   - シート読み込みは処理あたり1回に集約する（N+1問題防止）
 *
 * エントリポイント:
 *   handleProjectActionV2(action, data) — Code.gs の switch から委譲
 *
 * 依存ファイル:
 *   Code.gs   — generateId / getAllRows / getOrCreateSheet /
 *               createSuccessResponse / createErrorResponse /
 *               writeAuditLog / saveBackup / rowToEmployee /
 *               convertDateForDisplay / SHEET / EMPLOYEE_COL /
 *               ATTENDANCE_COL
 *   Shared.gs — SHEET_V2 / TASK_COL / TASK_ASSIGN_COL /
 *               TASK_STATUS_V2 / TASK_COMMENT_COL /
 *               PROJECT_MEMBER_COL / CONSULT_RECIPIENT_COL /
 *               TASK_CHANGE_TYPE / TASK_PRIORITIES_V2 /
 *               initProjectMemberSheet / initTaskCommentSheet /
 *               initConsultRecipientSheet / initTaskSheet /
 *               initTaskAssignSheet / rowToTask / rowToTaskAssignment /
 *               rowToTaskComment / rowToDailyReport /
 *               _toSlashDate / _normDateToHyphen / _toNumOrNull
 *
 * @version 2.0.0
 */

'use strict';

// ============================================================
// 列番号定数（ProjectService.gs 固有）
// ============================================================

/**
 * 顧客マスタの列番号定数。（旧 ProjectServices.gs から継承・変更なし）
 *
 * 列構成（9列）:
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
  ID         : 1,
  NAME       : 2,
  CONTACT    : 3,
  PHONE      : 4,
  EMAIL      : 5,
  NOTES      : 6,
  CREATED_AT : 7,
  UPDATED_AT : 8,
  DELETED    : 9,
};
var CUSTOMER_NUM_COLS = 9;

/**
 * 案件シートの列番号定数。（旧 ProjectServices.gs から継承・変更なし）
 *
 * 列構成（16列）:
 *   A(1):  ID             - 案件コード（P001形式）
 *   B(2):  LEGACY_CODE    - 旧Tコード（T001形式・表示互換用）
 *   C(3):  CUSTOMER_ID    - 顧客コード（FK→顧客マスタ、NULL可）
 *   D(4):  NAME           - 案件名
 *   E(5):  DIVISION       - 案件区分（'社外'/'社内'/'練習'）
 *   F(6):  CATEGORY       - カテゴリー
 *   G(7):  STATUS         - 案件ステータス（PROJECT_STATUS_FLOW 参照）
 *   H(8):  PHASE_TEMPLATE - フェーズテンプレートID
 *   I(9):  START_DATE     - 作業開始日（YYYY/MM/DD）
 *   J(10): DUE_DATE       - 最終納期（YYYY/MM/DD）
 *   K(11): DELIVERY_DATE  - 納品日（YYYY/MM/DD）
 *   L(12): NOTES          - 備考
 *   M(13): CREATED_BY     - 作成者ID（FK→人員マスタ）
 *   N(14): CREATED_AT     - 作成日時（ISO 8601）
 *   O(15): UPDATED_AT     - 更新日時（ISO 8601）
 *   P(16): DELETED        - 論理削除（'true' | ''）
 */
var PROJECT_COL = {
  ID             : 1,
  LEGACY_CODE    : 2,
  CUSTOMER_ID    : 3,
  NAME           : 4,
  DIVISION       : 5,
  CATEGORY       : 6,
  STATUS         : 7,
  PHASE_TEMPLATE : 8,
  START_DATE     : 9,
  DUE_DATE       : 10,
  DELIVERY_DATE  : 11,
  NOTES          : 12,
  CREATED_BY     : 13,
  CREATED_AT     : 14,
  UPDATED_AT     : 15,
  DELETED        : 16,
};
var PROJECT_NUM_COLS = 16;

/**
 * 相談シートの列番号定数。（旧 ProjectServices.gs から刷新）
 *
 * 【変更点】
 *   - TASK_ID → project_id を追加（案件起点相談に対応）
 *   - PARENT_ID → consultation_recipients シートで送信先を管理
 *   - IS_RESOLVED（解決済みフラグ）を追加
 *   - DELETED（論理削除）を追加
 *
 * 列構成（9列）:
 *   A(1): ID          - UUID
 *   B(2): PROJECT_ID  - 案件ID（FK→案件、NULL可）
 *   C(3): TASK_ID     - タスクID（FK→tasks、NULL可）
 *   D(4): SENDER_ID   - 送信者ID（FK→人員マスタ）
 *   E(5): TITLE       - 件名
 *   F(6): MESSAGE     - 本文
 *   G(7): IS_RESOLVED - 解決済みフラグ（'true' | ''）
 *   H(8): CREATED_AT  - 作成日時（ISO 8601）
 *   I(9): DELETED     - 論理削除（'true' | ''）
 */
var CONSULT_V2_COL = {
  ID          : 1,
  PROJECT_ID  : 2,
  TASK_ID     : 3,
  SENDER_ID   : 4,
  TITLE       : 5,
  MESSAGE     : 6,
  IS_RESOLVED : 7,
  CREATED_AT  : 8,
  DELETED     : 9,
};
var CONSULT_V2_NUM_COLS = 9;

/**
 * 通知シートの列番号定数。（旧 ProjectServices.gs から継承・変更なし）
 *
 * 列構成（9列）:
 *   A(1): ID           - UUID
 *   B(2): RECIPIENT_ID - 受信者ID
 *   C(3): TYPE         - 通知種別（NOTIF_TYPE_V2 参照）
 *   D(4): TITLE        - タイトル
 *   E(5): BODY         - 本文
 *   F(6): TASK_ID      - 関連タスクID（任意）
 *   G(7): PROJECT_ID   - 関連案件ID（任意）
 *   H(8): IS_READ      - 既読フラグ（'true' | ''）
 *   I(9): CREATED_AT   - 作成日時（ISO 8601）
 */
var NOTIF_COL = {
  ID           : 1,
  RECIPIENT_ID : 2,
  TYPE         : 3,
  TITLE        : 4,
  BODY         : 5,
  TASK_ID      : 6,
  PROJECT_ID   : 7,
  IS_READ      : 8,
  CREATED_AT   : 9,
};
var NOTIF_NUM_COLS = 9;

/**
 * フェーズテンプレートシートの列番号定数。（旧 ProjectServices.gs から継承・変更なし）
 *
 * 列構成（5列）:
 *   A(1): ID         - UUID
 *   B(2): NAME       - テンプレート名
 *   C(3): PHASES     - フェーズ名JSON配列
 *   D(4): CREATED_AT - 作成日時（ISO 8601）
 *   E(5): UPDATED_AT - 更新日時（ISO 8601）
 */
var PHASE_TPL_COL = {
  ID         : 1,
  NAME       : 2,
  PHASES     : 3,
  CREATED_AT : 4,
  UPDATED_AT : 5,
};
var PHASE_TPL_NUM_COLS = 5;


// ============================================================
// マスター定数
// ============================================================

/**
 * 案件区分ごとのステータスフロー定義。（旧 ProjectServices.gs から継承・変更なし）
 * 案件ステータスとタスクステータス（TASK_STATUS_V2）は完全に独立した定義。
 */
var PROJECT_STATUS_FLOW = {
  '社外': {
    statuses: ['引合い','見積中','受注確定','制作中','社内確認','先方確認',
               '修正対応','納品済','請求済','入金確認','完了','保留','キャンセル'],
    flow    : ['引合い','見積中','受注確定','制作中','社内確認','先方確認',
               '修正対応','納品済','請求済','入金確認','完了'],
    free    : ['保留','キャンセル'],
  },
  '社内': {
    statuses: ['進行中','社内確認','完了','保留'],
    flow    : ['進行中','社内確認','完了'],
    free    : ['保留'],
  },
  '練習': {
    statuses: ['進行中','完了','保留'],
    flow    : ['進行中','完了'],
    free    : ['保留'],
  },
};

/** 案件カテゴリーマスタ */
var PROJECT_CATEGORIES = ['動画','HP','デザイン','イラスト・漫画','3D','その他'];

/**
 * 通知種別定数（v2）。Shared.gs の TASK_STATUS_V2 と連携する。
 * 旧 NOTIF_TYPE（ProjectServices.gs）から刷新。
 */
var NOTIF_TYPE_V2 = {
  NEW_TASK        : 'new_task',        // タスクが自分に割り当てられた
  INSTRUCTION     : 'instruction',     // 管理者から指示が追加された
  REVIEW_REQUEST  : 'review_request',  // タスクが「レビュー待ち」になった（職員宛）
  REVISION        : 'revision',        // タスクが「差戻」になった（担当者宛）
  REVIEW_APPROVED : 'review_approved', // タスクが承認・完了になった（担当者宛）
  CONSULTATION    : 'consultation',    // 相談が投稿された
  OVERDUE         : 'overdue',         // 期限超過
  PROJECT_STATUS  : 'project_status',  // 案件ステータスが変更された
};


// ============================================================
// エントリポイント
// ============================================================

/**
 * 制作進行管理系アクションのハンドラ（v2）。
 *
 * Code.gs の handleAttendance() switch 文から委譲される。
 * 旧 handleProjectAction() の後継。
 *
 * @param {string} action
 * @param {Object} data
 * @returns {ContentService.TextOutput}
 */
function handleProjectActionV2(action, data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (action) {

      // ── 顧客マスタ ──────────────────────────────────────
      case 'get_customers':
        return createSuccessResponse(getCustomers(ss, data));
      case 'upsert_customer':
        return createSuccessResponse(upsertCustomer(ss, data));
      case 'delete_customer':
        return createSuccessResponse(deleteCustomer(ss, data));

      // ── 案件 ────────────────────────────────────────────
      case 'get_projects':
        return createSuccessResponse(getProjects(ss, data));
      case 'upsert_project':
        return createSuccessResponse(upsertProject(ss, data));
      case 'update_project_status':
        return createSuccessResponse(updateProjectStatus(ss, data));
      case 'delete_project':
        return createSuccessResponse(deleteProject(ss, data));

      // ── 案件メンバー ─────────────────────────────────────
      case 'get_project_members':
        return createSuccessResponse(getProjectMembers(ss, data));
      case 'add_project_member':
        return createSuccessResponse(addProjectMember(ss, data));
      case 'remove_project_member':
        return createSuccessResponse(removeProjectMember(ss, data));

      // ── タスクコメント（旧:作業メモ） ──────────────────
      case 'get_task_comments':
        return createSuccessResponse(getTaskComments(ss, data));
      case 'add_task_comment':
        return createSuccessResponse(addTaskComment(ss, data));

      // ── レビュー（職員ホーム最優先表示用） ─────────────────
      case 'get_review_waiting_tasks':
        return createSuccessResponse(getReviewWaitingTasks(ss, data));

      // ── 相談 ────────────────────────────────────────────
      case 'get_consultations_v2':
      case 'get_consultation_list':  // get_consultations_v2 のエイリアス
        return createSuccessResponse(getConsultationsV2(ss, data));
      case 'send_consultation':
        return createSuccessResponse(sendConsultation(ss, data));
      case 'resolve_consultation':
      case 'change_consultation_status':  // resolve_consultation のエイリアス
        return createSuccessResponse(resolveConsultation(ss, data));
      case 'reply_consultation':
        return createSuccessResponse(replyConsultation(ss, data));
      case 'mark_consultation_read':
        return createSuccessResponse(markConsultationRead(ss, data));

      // ── 通知 ────────────────────────────────────────────
      case 'get_notifications':
        return createSuccessResponse(getNotifications(ss, data));
      case 'mark_notification_read':
        return createSuccessResponse(markNotificationRead(ss, data));
      case 'mark_all_notifications_read':
        return createSuccessResponse(markAllNotificationsRead(ss, data));

      // ── フェーズテンプレート ─────────────────────────────
      case 'get_phase_templates':
        return createSuccessResponse(getPhaseTemplates(ss));
      case 'upsert_phase_template':
        return createSuccessResponse(upsertPhaseTemplate(ss, data));
      case 'delete_phase_template':
        return createSuccessResponse(deletePhaseTemplate(ss, data));

      // ── ダッシュボード ───────────────────────────────────
      case 'project_dashboard':
        return createSuccessResponse(getProjectDashboard(ss, data));

      // ── マスタ取得（UI ドロップダウン用） ────────────────
      case 'get_project_masters':
        return createSuccessResponse(getProjectMasters());

      default:
        throw new Error('ProjectService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleProjectActionV2] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 権限チェック（ProjectService 内部用）
// ============================================================

/**
 * operator_id から人員マスタを引いて employee を返す。
 * 見つからない場合は例外を投げる。
 *
 * @param {string} operatorId
 * @returns {Object} employee
 */
function _getOperatorProj(operatorId) {
  if (!operatorId) throw new Error('operator_id は必須です。');
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var rows    = getAllRows(empSheet);
  var row     = rows.find(function(r) {
    return String(r[EMPLOYEE_COL.ID      - 1]) === String(operatorId) &&
           String(r[EMPLOYEE_COL.DELETED - 1]) !== 'true';
  });
  if (!row) throw new Error('操作者が見つかりません: ' + operatorId);
  return rowToEmployee(row);
}

/**
 * 権限レベルを返す（ProjectService 内部用）。
 *
 * @param {Object} employee
 * @returns {number} 3=管理者, 2=職員, 1=利用者, 0=不明
 */
function _getPermLevelProj(employee) {
  if (!employee) return 0;
  if (employee.admin_role === '管理者') return 3;
  if (employee.employment_type === '職員') return 2;
  return 1;
}

/**
 * 権限レベルチェック。不足していれば例外を投げる。
 *
 * @param {Object} employee
 * @param {number} required
 * @param {string} [context]
 */
function _requirePermProj(employee, required, context) {
  if (_getPermLevelProj(employee) < required) {
    throw new Error((context || '操作') + ' を行う権限がありません。');
  }
}

/**
 * 利用者が指定案件の参加メンバーかどうかを確認する。
 *
 * 職員・管理者は常に true を返す（全案件閲覧可）。
 * 利用者は project_members に登録されている案件のみ閲覧可。
 *
 * @param {string}   userId    - 確認対象ユーザーID
 * @param {number}   permLevel - 権限レベル（_getPermLevelProj の戻り値）
 * @param {string}   projectId - 案件ID
 * @param {Array[][]} memberRows - project_members シートの全行
 * @returns {boolean}
 */
function _canAccessProject(userId, permLevel, projectId, memberRows) {
  // 職員・管理者は全案件にアクセス可能
  if (permLevel >= 2) return true;

  // 利用者は参加案件のみ閲覧可
  return memberRows.some(function(r) {
    return String(r[PROJECT_MEMBER_COL.PROJECT_ID - 1]) === String(projectId) &&
           String(r[PROJECT_MEMBER_COL.USER_ID    - 1]) === String(userId);
  });
}


// ============================================================
// シート初期化
// ============================================================

/**
 * 顧客マスタシートを初期化する（冪等）。
 * @param {Sheet} sheet
 */
function initCustomerSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;
  sheet.getRange(1, 1, 1, CUSTOMER_NUM_COLS).setValues([[
    '顧客コード','顧客名','担当者名','電話番号','メールアドレス',
    '備考','登録日時','更新日時','論理削除',
  ]]);
}

/**
 * 案件シートを初期化する（冪等）。
 * @param {Sheet} sheet
 */
function initProjectSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;
  sheet.getRange(1, 1, 1, PROJECT_NUM_COLS).setValues([[
    '案件コード','旧Tコード','顧客コード','案件名','案件区分',
    'カテゴリー','ステータス','フェーズテンプレート',
    '作業開始日','最終納期','納品日',
    '備考','作成者ID','作成日時','更新日時','論理削除',
  ]]);
  // 日付列はテキスト形式で保存する（GAS自動変換防止）
  [PROJECT_COL.START_DATE, PROJECT_COL.DUE_DATE, PROJECT_COL.DELIVERY_DATE].forEach(function(col) {
    sheet.getRange(1, col).setNumberFormat('@');
  });
}

/**
 * 相談シート（v2）を初期化する（冪等）。
 * @param {Sheet} sheet
 */
function initConsultationSheetV2(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;
  sheet.getRange(1, 1, 1, CONSULT_V2_NUM_COLS).setValues([[
    'ID','案件ID','タスクID','送信者ID','件名','本文','解決済み','作成日時','論理削除',
  ]]);
}

/**
 * 通知シートを初期化する（冪等）。
 * @param {Sheet} sheet
 */
function initNotificationSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;
  sheet.getRange(1, 1, 1, NOTIF_NUM_COLS).setValues([[
    'ID','受信者ID','通知種別','タイトル','本文',
    'タスクID','案件ID','既読','作成日時',
  ]]);
}

/**
 * フェーズテンプレートシートを初期化する（冪等）。
 * @param {Sheet} sheet
 */
function initPhaseTemplateSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;
  sheet.getRange(1, 1, 1, PHASE_TPL_NUM_COLS).setValues([[
    'ID','テンプレート名','フェーズ(JSON)','作成日時','更新日時',
  ]]);
}


// ============================================================
// 行→オブジェクト変換
// ============================================================

/**
 * 顧客マスタの行→オブジェクト変換。
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
 * 案件シートの行→オブジェクト変換。
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
    start_date     : _normDateToHyphen(row[PROJECT_COL.START_DATE    - 1]),
    due_date       : _normDateToHyphen(row[PROJECT_COL.DUE_DATE      - 1]),
    delivery_date  : _normDateToHyphen(row[PROJECT_COL.DELIVERY_DATE - 1]),
    notes          : String(row[PROJECT_COL.NOTES          - 1] || ''),
    created_by     : String(row[PROJECT_COL.CREATED_BY     - 1] || ''),
    created_at     : String(row[PROJECT_COL.CREATED_AT     - 1] || ''),
    updated_at     : String(row[PROJECT_COL.UPDATED_AT     - 1] || ''),
    // フロント用拡張フィールド（JOIN後に付与）
    members        : [],
    task_summary   : null,
  };
}

/**
 * 案件メンバーシートの行→オブジェクト変換。
 * @param {Array} row
 * @returns {Object}
 */
function rowToProjectMember(row) {
  return {
    id         : String(row[PROJECT_MEMBER_COL.ID         - 1] || ''),
    project_id : String(row[PROJECT_MEMBER_COL.PROJECT_ID - 1] || ''),
    user_id    : String(row[PROJECT_MEMBER_COL.USER_ID    - 1] || ''),
    role       : String(row[PROJECT_MEMBER_COL.ROLE       - 1] || '参加'),
    created_at : String(row[PROJECT_MEMBER_COL.CREATED_AT - 1] || ''),
  };
}

/**
 * 相談シート（v2）の行→オブジェクト変換。
 * @param {Array} row
 * @returns {Object}
 */
function rowToConsultationV2(row) {
  return {
    id          : String(row[CONSULT_V2_COL.ID          - 1] || ''),
    project_id  : String(row[CONSULT_V2_COL.PROJECT_ID  - 1] || ''),
    task_id     : String(row[CONSULT_V2_COL.TASK_ID     - 1] || ''),
    sender_id   : String(row[CONSULT_V2_COL.SENDER_ID   - 1] || ''),
    title       : String(row[CONSULT_V2_COL.TITLE       - 1] || ''),
    message     : String(row[CONSULT_V2_COL.MESSAGE     - 1] || ''),
    is_resolved : String(row[CONSULT_V2_COL.IS_RESOLVED - 1] || '') === 'true',
    created_at  : String(row[CONSULT_V2_COL.CREATED_AT  - 1] || ''),
    // フロント用拡張フィールド
    recipients  : [],
  };
}

/**
 * 通知シートの行→オブジェクト変換。
 * @param {Array} row
 * @returns {Object}
 */
function rowToNotification(row) {
  return {
    id           : String(row[NOTIF_COL.ID           - 1] || ''),
    recipient_id : String(row[NOTIF_COL.RECIPIENT_ID - 1] || ''),
    type         : String(row[NOTIF_COL.TYPE         - 1] || ''),
    title        : String(row[NOTIF_COL.TITLE        - 1] || ''),
    body         : String(row[NOTIF_COL.BODY         - 1] || ''),
    task_id      : String(row[NOTIF_COL.TASK_ID      - 1] || ''),
    project_id   : String(row[NOTIF_COL.PROJECT_ID   - 1] || ''),
    is_read      : String(row[NOTIF_COL.IS_READ      - 1] || '') === 'true',
    created_at   : String(row[NOTIF_COL.CREATED_AT   - 1] || ''),
  };
}

/**
 * フェーズテンプレートの行→オブジェクト変換。
 * @param {Array} row
 * @returns {Object}
 */
function rowToPhaseTemplate(row) {
  var phasesRaw = row[PHASE_TPL_COL.PHASES - 1];
  var phases    = [];
  try { phases = phasesRaw ? JSON.parse(phasesRaw) : []; } catch (_) { phases = []; }
  return {
    id         : String(row[PHASE_TPL_COL.ID         - 1] || ''),
    name       : String(row[PHASE_TPL_COL.NAME       - 1] || ''),
    phases     : phases,
    created_at : String(row[PHASE_TPL_COL.CREATED_AT - 1] || ''),
    updated_at : String(row[PHASE_TPL_COL.UPDATED_AT - 1] || ''),
  };
}


// ============================================================
// 採番ユーティリティ
// ============================================================

/**
 * 案件コード（P001形式）を自動採番する。
 * @param {Sheet} projectSheet
 * @returns {string} 'P001' 形式
 */
function _generateProjectCode(projectSheet) {
  var rows   = getAllRows(projectSheet).filter(function(r) {
    return String(r[PROJECT_COL.DELETED - 1]) !== 'true';
  });
  var maxNum = 0;
  rows.forEach(function(r) {
    var match = String(r[PROJECT_COL.ID - 1] || '').match(/^P(\d+)$/);
    if (match) { var n = parseInt(match[1], 10); if (n > maxNum) maxNum = n; }
  });
  return 'P' + String(maxNum + 1).padStart(3, '0');
}

/**
 * 顧客コード（C001形式）を自動採番する。
 * @param {Sheet} customerSheet
 * @returns {string} 'C001' 形式
 */
function _generateCustomerCode(customerSheet) {
  var rows   = getAllRows(customerSheet).filter(function(r) {
    return String(r[CUSTOMER_COL.DELETED - 1]) !== 'true';
  });
  var maxNum = 0;
  rows.forEach(function(r) {
    var match = String(r[CUSTOMER_COL.ID - 1] || '').match(/^C(\d+)$/);
    if (match) { var n = parseInt(match[1], 10); if (n > maxNum) maxNum = n; }
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
 *   data.operator_id - 操作者ID（Lv2以上）
 *   data.keyword     - 顧客名・担当者名の部分一致フィルタ（任意）
 *
 * 出力:
 *   { customers: Customer[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getCustomers(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, '顧客一覧取得');

  var sheet = getOrCreateSheet(ss, SHEET.CUSTOMERS);
  initCustomerSheet(sheet);

  var rows = getAllRows(sheet).filter(function(r) {
    return String(r[CUSTOMER_COL.DELETED - 1]) !== 'true';
  });

  if (data.keyword) {
    var kw = String(data.keyword).toLowerCase();
    rows = rows.filter(function(r) {
      return String(r[CUSTOMER_COL.NAME    - 1] || '').toLowerCase().indexOf(kw) !== -1 ||
             String(r[CUSTOMER_COL.CONTACT - 1] || '').toLowerCase().indexOf(kw) !== -1;
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
 *   data.operator_id   - 操作者ID（Lv2以上）
 *   data.customer_id   - 顧客コード（更新時に指定）
 *   data.name          - 顧客名（必須）
 *   data.contact       - 担当者名（任意）
 *   data.phone         - 電話番号（任意）
 *   data.email         - メールアドレス（任意）
 *   data.notes         - 備考（任意）
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function upsertCustomer(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, '顧客登録・更新');

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
    var rowNum    = idx + 2;
    var createdAt = rows[idx][CUSTOMER_COL.CREATED_AT - 1];

    sheet.getRange(rowNum, 1, 1, CUSTOMER_NUM_COLS).setValues([[
      id, data.name,
      data.contact !== undefined ? data.contact : String(rows[idx][CUSTOMER_COL.CONTACT - 1] || ''),
      data.phone   !== undefined ? data.phone   : String(rows[idx][CUSTOMER_COL.PHONE   - 1] || ''),
      data.email   !== undefined ? data.email   : String(rows[idx][CUSTOMER_COL.EMAIL   - 1] || ''),
      data.notes   !== undefined ? data.notes   : String(rows[idx][CUSTOMER_COL.NOTES   - 1] || ''),
      createdAt, now, '',
    ]]);

  } else {
    // 新規作成
    id = _generateCustomerCode(sheet);
    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, CUSTOMER_NUM_COLS).setValues([[
      id, data.name,
      data.contact || '', data.phone || '', data.email || '', data.notes || '',
      now, now, '',
    ]]);
  }

  SpreadsheetApp.flush();
  writeAuditLog(ss, { action: 'upsert_customer', admin_id: data.operator_id, target_id: id });
  Logger.log('[upsertCustomer] id=%s', id);
  return { id: id, saved: true };
}

/**
 * 顧客を論理削除する。
 *
 * 入力:
 *   data.operator_id - 操作者ID（Lv3=管理者のみ）
 *   data.customer_id - 顧客コード（必須）
 *
 * 出力:
 *   { deleted: true, id: string }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function deleteCustomer(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 3, '顧客削除');

  if (!data.customer_id) throw new Error('customer_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.CUSTOMERS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[CUSTOMER_COL.ID - 1]) === data.customer_id;
  });
  if (idx === -1) throw new Error('顧客が見つかりません: ' + data.customer_id);

  var rowNum = idx + 2;
  sheet.getRange(rowNum, CUSTOMER_COL.DELETED   ).setValue('true');
  sheet.getRange(rowNum, CUSTOMER_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  writeAuditLog(ss, { action: 'delete_customer', admin_id: data.operator_id, target_id: data.customer_id });
  Logger.log('[deleteCustomer] id=%s', data.customer_id);
  return { deleted: true, id: data.customer_id };
}


// ============================================================
// 案件
// ============================================================

/**
 * 案件一覧を取得する。
 *
 * 権限制御:
 *   - 職員・管理者: 全案件を取得
 *   - 利用者: project_members に登録されている案件のみ取得
 *
 * 入力:
 *   data.operator_id   - 操作者ID（必須）
 *   data.keyword       - 案件名フィルタ（任意）
 *   data.status        - ステータスフィルタ（任意）
 *   data.division      - 区分フィルタ（任意）
 *   data.include_done  - true で完了・キャンセル含む（省略時: false）
 *   data.with_members  - true でメンバー一覧を付与（省略時: false）
 *
 * 出力:
 *   { projects: Project[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getProjects(ss, data) {
  var operator  = _getOperatorProj(data.operator_id);
  var permLevel = _getPermLevelProj(operator);

  var projectSheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  var memberSheet  = getOrCreateSheet(ss, SHEET_V2.PROJECT_MEMBERS);
  initProjectSheet(projectSheet);
  initProjectMemberSheet(memberSheet);

  var memberRows = getAllRows(memberSheet);

  var rows = getAllRows(projectSheet).filter(function(r) {
    if (String(r[PROJECT_COL.DELETED - 1]) === 'true') return false;

    // 利用者は参加案件のみ表示する
    if (permLevel < 2) {
      var pid = String(r[PROJECT_COL.ID - 1] || '');
      if (!_canAccessProject(operator.id, permLevel, pid, memberRows)) return false;
    }

    // 完了・キャンセルを除外する（include_done=true なら含める）
    if (!data.include_done) {
      var st = String(r[PROJECT_COL.STATUS - 1] || '');
      if (st === '完了' || st === 'キャンセル') return false;
    }

    return true;
  });

  // フィルタ適用
  if (data.status)   rows = rows.filter(function(r) { return String(r[PROJECT_COL.STATUS   - 1]) === data.status;   });
  if (data.division) rows = rows.filter(function(r) { return String(r[PROJECT_COL.DIVISION  - 1]) === data.division; });
  if (data.keyword) {
    var kw = String(data.keyword).toLowerCase();
    rows = rows.filter(function(r) {
      return String(r[PROJECT_COL.NAME - 1] || '').toLowerCase().indexOf(kw) !== -1;
    });
  }

  // 案件メンバーマップを構築する（project_id → ProjectMember[]）
  var memberMap = {};
  if (data.with_members) {
    memberRows.forEach(function(r) {
      var pid = String(r[PROJECT_MEMBER_COL.PROJECT_ID - 1] || '');
      if (!pid) return;
      if (!memberMap[pid]) memberMap[pid] = [];
      memberMap[pid].push(rowToProjectMember(r));
    });
  }

  // 納期昇順でソートする
  rows.sort(function(a, b) {
    var da = String(a[PROJECT_COL.DUE_DATE - 1] || '9999/99/99');
    var db = String(b[PROJECT_COL.DUE_DATE - 1] || '9999/99/99');
    return da.localeCompare(db);
  });

  var projects = rows.map(function(r) {
    var proj   = rowToProject(r);
    proj.members = data.with_members ? (memberMap[proj.id] || []) : [];
    return proj;
  });

  Logger.log('[getProjects] count=%d, user=%s', projects.length, data.operator_id);
  return { projects: projects, count: projects.length };
}

/**
 * 案件を作成・更新する（upsert）。
 *
 * 入力:
 *   data.operator_id    - 操作者ID（Lv2以上）
 *   data.project_id     - 案件コード（更新時に指定）
 *   data.customer_id    - 顧客コード（任意）
 *   data.name           - 案件名（必須）
 *   data.division       - 案件区分（必須: '社外'|'社内'|'練習'）
 *   data.category       - カテゴリー（任意）
 *   data.status         - ステータス（任意、省略時は区分の先頭ステータス）
 *   data.phase_template - フェーズテンプレートID（任意）
 *   data.start_date     - 作業開始日（YYYY-MM-DD、任意）
 *   data.due_date       - 最終納期（YYYY-MM-DD、任意）
 *   data.delivery_date  - 納品日（YYYY-MM-DD、任意）
 *   data.notes          - 備考（任意）
 *   data.members        - 初期メンバー [{ user_id, role }]（新規作成時のみ有効）
 *
 * 出力:
 *   { id: string, saved: true, is_new: boolean }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function upsertProject(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, '案件登録・更新');

  if (!data.name)     throw new Error('案件名は必須です。');
  if (!data.division) throw new Error('案件区分は必須です。');
  if (!PROJECT_STATUS_FLOW[data.division]) {
    throw new Error('無効な案件区分です: ' + data.division);
  }

  var projectSheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  var memberSheet  = getOrCreateSheet(ss, SHEET_V2.PROJECT_MEMBERS);
  initProjectSheet(projectSheet);
  initProjectMemberSheet(memberSheet);

  var now       = new Date().toISOString();
  var startDate = _toSlashDate(data.start_date    || '');
  var dueDate   = _toSlashDate(data.due_date      || '');
  var delivDate = _toSlashDate(data.delivery_date || '');
  var isNew     = !data.project_id;
  var id        = data.project_id || _generateProjectCode(projectSheet);

  // ステータスバリデーション
  var flow          = PROJECT_STATUS_FLOW[data.division];
  var defaultStatus = flow.statuses[0]; // 区分の先頭ステータス
  var status        = data.status || defaultStatus;
  if (flow.statuses.indexOf(status) === -1) {
    throw new Error('案件区分「' + data.division + '」に「' + status + '」は無効なステータスです。');
  }

  if (isNew) {
    // 新規作成
    var newRow = projectSheet.getLastRow() + 1;
    [PROJECT_COL.START_DATE, PROJECT_COL.DUE_DATE, PROJECT_COL.DELIVERY_DATE].forEach(function(col) {
      projectSheet.getRange(newRow, col).setNumberFormat('@');
    });

    projectSheet.getRange(newRow, 1, 1, PROJECT_NUM_COLS).setValues([[
      id,
      data.legacy_code    || '',
      data.customer_id    || '',
      data.name,
      data.division,
      data.category       || '',
      status,
      data.phase_template || '',
      startDate, dueDate, delivDate,
      data.notes          || '',
      data.operator_id,
      now, now, '',
    ]]);
    SpreadsheetApp.flush();

    // 初期メンバーを登録する
    if (data.members && Array.isArray(data.members)) {
      data.members.forEach(function(m) {
        if (!m.user_id) return;
        _appendProjectMember(memberSheet, id, m.user_id, m.role || '参加', now);
      });
      SpreadsheetApp.flush();
    }

  } else {
    // 更新
    var rows = getAllRows(projectSheet);
    var idx  = rows.findIndex(function(r) { return String(r[PROJECT_COL.ID - 1]) === id; });
    if (idx === -1) throw new Error('案件が見つかりません: ' + id);
    var existing = rows[idx];
    var rowNum   = idx + 2;

    [PROJECT_COL.START_DATE, PROJECT_COL.DUE_DATE, PROJECT_COL.DELIVERY_DATE].forEach(function(col) {
      projectSheet.getRange(rowNum, col).setNumberFormat('@');
    });

    projectSheet.getRange(rowNum, 1, 1, PROJECT_NUM_COLS).setValues([[
      id,
      data.legacy_code    !== undefined ? data.legacy_code    : String(existing[PROJECT_COL.LEGACY_CODE    - 1] || ''),
      data.customer_id    !== undefined ? data.customer_id    : String(existing[PROJECT_COL.CUSTOMER_ID    - 1] || ''),
      data.name,
      data.division,
      data.category       !== undefined ? data.category       : String(existing[PROJECT_COL.CATEGORY       - 1] || ''),
      status,
      data.phase_template !== undefined ? data.phase_template : String(existing[PROJECT_COL.PHASE_TEMPLATE - 1] || ''),
      startDate || _toSlashDate(_normDateToHyphen(existing[PROJECT_COL.START_DATE    - 1])),
      dueDate   || _toSlashDate(_normDateToHyphen(existing[PROJECT_COL.DUE_DATE      - 1])),
      delivDate || _toSlashDate(_normDateToHyphen(existing[PROJECT_COL.DELIVERY_DATE - 1])),
      data.notes !== undefined ? data.notes : String(existing[PROJECT_COL.NOTES - 1] || ''),
      String(existing[PROJECT_COL.CREATED_BY - 1] || ''),
      String(existing[PROJECT_COL.CREATED_AT - 1] || ''),
      now, '',
    ]]);
    SpreadsheetApp.flush();
  }

  writeAuditLog(ss, {
    action   : isNew ? 'create_project' : 'update_project',
    admin_id : data.operator_id,
    target_id: id,
  });
  Logger.log('[upsertProject] id=%s, is_new=%s', id, isNew);
  return { id: id, saved: true, is_new: isNew };
}

/**
 * 案件ステータスのみを更新する。
 *
 * 入力:
 *   data.operator_id - 操作者ID（Lv2以上）
 *   data.project_id  - 案件コード（必須）
 *   data.status      - 変更後ステータス（必須）
 *
 * 出力:
 *   { project_id: string, status: string, updated: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function updateProjectStatus(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, '案件ステータス更新');

  if (!data.project_id) throw new Error('project_id は必須です。');
  if (!data.status)     throw new Error('status は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PROJECT_COL.ID - 1]) === data.project_id &&
           String(r[PROJECT_COL.DELETED - 1]) !== 'true';
  });
  if (idx === -1) throw new Error('案件が見つかりません: ' + data.project_id);

  var division = String(rows[idx][PROJECT_COL.DIVISION - 1] || '');
  var flow     = PROJECT_STATUS_FLOW[division];
  if (!flow || flow.statuses.indexOf(data.status) === -1) {
    throw new Error('案件区分「' + division + '」に「' + data.status + '」は無効なステータスです。');
  }

  var rowNum = idx + 2;
  var now    = new Date().toISOString();
  sheet.getRange(rowNum, PROJECT_COL.STATUS    ).setValue(data.status);
  sheet.getRange(rowNum, PROJECT_COL.UPDATED_AT).setValue(now);
  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action    : 'update_project_status',
    admin_id  : data.operator_id,
    target_id : data.project_id,
    before    : String(rows[idx][PROJECT_COL.STATUS - 1] || ''),
    after     : data.status,
  });
  Logger.log('[updateProjectStatus] id=%s, status=%s', data.project_id, data.status);
  return { project_id: data.project_id, status: data.status, updated: true };
}

/**
 * 案件を論理削除する。
 *
 * 配下のタスクは削除しない（孤立を許容する）。
 * 案件削除後はタスク取得時に project_id フィルタで自動的に除外される。
 *
 * 入力:
 *   data.operator_id - 操作者ID（Lv3=管理者のみ）
 *   data.project_id  - 案件コード（必須）
 *
 * 出力:
 *   { deleted: true, id: string }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function deleteProject(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 3, '案件削除');

  if (!data.project_id) throw new Error('project_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[PROJECT_COL.ID - 1]) === data.project_id;
  });
  if (idx === -1) throw new Error('案件が見つかりません: ' + data.project_id);

  var rowNum = idx + 2;
  var now    = new Date().toISOString();
  sheet.getRange(rowNum, PROJECT_COL.DELETED   ).setValue('true');
  sheet.getRange(rowNum, PROJECT_COL.UPDATED_AT).setValue(now);
  SpreadsheetApp.flush();

  writeAuditLog(ss, { action: 'delete_project', admin_id: data.operator_id, target_id: data.project_id });
  Logger.log('[deleteProject] id=%s', data.project_id);
  return { deleted: true, id: data.project_id };
}


// ============================================================
// 案件メンバー
// ============================================================

/**
 * 案件のメンバー一覧を取得する。
 *
 * 入力:
 *   data.project_id  - 案件コード（必須）
 *   data.operator_id - 操作者ID（必須）
 *
 * 出力:
 *   { members: ProjectMember[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getProjectMembers(ss, data) {
  if (!data.project_id)  throw new Error('project_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var operator    = _getOperatorProj(data.operator_id);
  var memberSheet = getOrCreateSheet(ss, SHEET_V2.PROJECT_MEMBERS);
  initProjectMemberSheet(memberSheet);

  // アクセス権確認（利用者は参加案件のみ）
  var allMemberRows = getAllRows(memberSheet);
  if (!_canAccessProject(operator.id, _getPermLevelProj(operator), data.project_id, allMemberRows)) {
    throw new Error('この案件へのアクセス権がありません。');
  }

  var members = allMemberRows
    .filter(function(r) {
      return String(r[PROJECT_MEMBER_COL.PROJECT_ID - 1]) === String(data.project_id);
    })
    .map(rowToProjectMember);

  Logger.log('[getProjectMembers] project_id=%s, count=%d', data.project_id, members.length);
  return { members: members, count: members.length };
}

/**
 * 案件にメンバーを追加する。
 * 同一 project_id × user_id の重複は登録しない（冪等）。
 *
 * 入力:
 *   data.project_id  - 案件コード（必須）
 *   data.user_id     - 追加するユーザーID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *   data.role        - '参加'|'リーダー'（省略時: '参加'）
 *
 * 出力:
 *   { project_id: string, user_id: string, added: boolean }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function addProjectMember(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, '案件メンバー追加');

  if (!data.project_id) throw new Error('project_id は必須です。');
  if (!data.user_id)    throw new Error('user_id は必須です。');

  var memberSheet = getOrCreateSheet(ss, SHEET_V2.PROJECT_MEMBERS);
  initProjectMemberSheet(memberSheet);

  // 重複チェック
  var existing = getAllRows(memberSheet).find(function(r) {
    return String(r[PROJECT_MEMBER_COL.PROJECT_ID - 1]) === String(data.project_id) &&
           String(r[PROJECT_MEMBER_COL.USER_ID    - 1]) === String(data.user_id);
  });
  if (existing) {
    return { project_id: data.project_id, user_id: data.user_id, added: false,
             reason: '既に案件メンバーとして登録されています。' };
  }

  var role = (PROJECT_MEMBER_ROLES.indexOf(data.role) !== -1) ? data.role : '参加';
  var now  = new Date().toISOString();
  _appendProjectMember(memberSheet, data.project_id, data.user_id, role, now);
  SpreadsheetApp.flush();

  Logger.log('[addProjectMember] project_id=%s, user_id=%s, role=%s', data.project_id, data.user_id, role);
  return { project_id: data.project_id, user_id: data.user_id, added: true };
}

/**
 * 案件からメンバーを削除する（物理削除）。
 *
 * 入力:
 *   data.project_id  - 案件コード（必須）
 *   data.user_id     - 削除するユーザーID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *
 * 出力:
 *   { project_id: string, user_id: string, removed: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function removeProjectMember(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, '案件メンバー削除');

  if (!data.project_id) throw new Error('project_id は必須です。');
  if (!data.user_id)    throw new Error('user_id は必須です。');

  var memberSheet = getOrCreateSheet(ss, SHEET_V2.PROJECT_MEMBERS);
  var rows        = getAllRows(memberSheet);
  var idx = rows.findIndex(function(r) {
    return String(r[PROJECT_MEMBER_COL.PROJECT_ID - 1]) === String(data.project_id) &&
           String(r[PROJECT_MEMBER_COL.USER_ID    - 1]) === String(data.user_id);
  });
  if (idx === -1) throw new Error('指定したメンバーが見つかりません。');

  memberSheet.deleteRow(idx + 2);
  SpreadsheetApp.flush();

  Logger.log('[removeProjectMember] project_id=%s, user_id=%s', data.project_id, data.user_id);
  return { project_id: data.project_id, user_id: data.user_id, removed: true };
}


// ============================================================
// タスクコメント（旧:作業メモ → task_comments シートに一本化）
// ============================================================

/**
 * タスクコメント一覧を取得する。
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須）
 *
 * 出力:
 *   { comments: TaskComment[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getTaskComments(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var commentSheet = getOrCreateSheet(ss, SHEET_V2.TASK_COMMENTS);
  initTaskCommentSheet(commentSheet);

  var comments = getAllRows(commentSheet)
    .filter(function(r) {
      return String(r[TASK_COMMENT_COL.TASK_ID - 1]) === String(data.task_id);
    })
    .map(rowToTaskComment)
    .sort(function(a, b) { return a.created_at.localeCompare(b.created_at); }); // 古い順

  Logger.log('[getTaskComments] task_id=%s, count=%d', data.task_id, comments.length);
  return { comments: comments, count: comments.length };
}

/**
 * タスクコメントを追加する（作業メモ・進捗報告に使用）。
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須・投稿者）
 *   data.content     - コメント内容（必須）
 *   data.report_id   - 日報ID（任意）
 *   data.work_date   - 作業日（YYYY-MM-DD、省略時: 本日）
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function addTaskComment(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');
  if (!data.content)     throw new Error('コメント内容は必須です。');

  // タスクの存在確認
  var taskSheet = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var taskRows  = getAllRows(taskSheet);
  var taskRow   = taskRows.find(function(r) {
    return String(r[TASK_COL.ID - 1]) === data.task_id &&
           String(r[TASK_COL.DELETED - 1]) !== 'true';
  });
  if (!taskRow) throw new Error('タスクが見つかりません: ' + data.task_id);

  var commentSheet = getOrCreateSheet(ss, SHEET_V2.TASK_COMMENTS);
  initTaskCommentSheet(commentSheet);

  var now      = new Date().toISOString();
  var workDate = _toSlashDate(data.work_date || _todayString());
  var id       = generateId();
  var newRow   = commentSheet.getLastRow() + 1;

  commentSheet.getRange(newRow, TASK_COMMENT_COL.WORK_DATE).setNumberFormat('@');
  commentSheet.getRange(newRow, 1, 1, TASK_COMMENT_NUM_COLS).setValues([[
    id,
    data.report_id || '',
    data.task_id,
    data.operator_id,
    data.content,
    workDate,
    now,
  ]]);
  SpreadsheetApp.flush();

  Logger.log('[addTaskComment] id=%s, task_id=%s', id, data.task_id);
  return { id: id, saved: true };
}


// ============================================================
// 相談（v2）
// ============================================================

/**
 * 相談一覧を取得する（受信者別フィルタつき）。
 *
 * 権限制御:
 *   - 利用者: 自分が送信者または受信者の相談のみ
 *   - 職員・管理者: 全相談を取得可能（project_id フィルタあり）
 *
 * 入力:
 *   data.operator_id  - 操作者ID（必須）
 *   data.project_id   - 案件フィルタ（任意）
 *   data.task_id      - タスクフィルタ（任意）
 *   data.include_resolved - true で解決済み含む（省略時: false）
 *
 * 出力:
 *   { consultations: ConsultationV2[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getConsultationsV2(ss, data) {
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var operator    = _getOperatorProj(data.operator_id);
  var permLevel   = _getPermLevelProj(operator);

  var consultSheet    = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  var recipientSheet  = getOrCreateSheet(ss, SHEET_V2.CONSULTATION_RECIPIENTS);
  initConsultationSheetV2(consultSheet);
  initConsultRecipientSheet(recipientSheet);

  var recipientRows = getAllRows(recipientSheet);

  // 自分宛の consultation_id セットを構築する（利用者フィルタ用）
  var myConsultIds = {};
  if (permLevel < 2) {
    recipientRows.forEach(function(r) {
      if (String(r[CONSULT_RECIPIENT_COL.RECIPIENT_ID - 1]) === String(operator.id)) {
        myConsultIds[String(r[CONSULT_RECIPIENT_COL.CONSULTATION_ID - 1])] = true;
      }
    });
  }

  var rows = getAllRows(consultSheet).filter(function(r) {
    if (String(r[CONSULT_V2_COL.DELETED - 1]) === 'true') return false;
    if (!data.include_resolved && String(r[CONSULT_V2_COL.IS_RESOLVED - 1]) === 'true') return false;

    // 案件・タスクフィルタ
    if (data.project_id && String(r[CONSULT_V2_COL.PROJECT_ID - 1]) !== data.project_id) return false;
    if (data.task_id    && String(r[CONSULT_V2_COL.TASK_ID    - 1]) !== data.task_id)    return false;

    // 利用者は自分関連の相談のみ
    if (permLevel < 2) {
      var cid = String(r[CONSULT_V2_COL.ID       - 1] || '');
      var sid = String(r[CONSULT_V2_COL.SENDER_ID - 1] || '');
      if (sid !== String(operator.id) && !myConsultIds[cid]) return false;
    }

    return true;
  });

  // 受信者マップを構築する（consultation_id → recipients[]）
  var recipientMap = {};
  recipientRows.forEach(function(r) {
    var cid = String(r[CONSULT_RECIPIENT_COL.CONSULTATION_ID - 1] || '');
    if (!cid) return;
    if (!recipientMap[cid]) recipientMap[cid] = [];
    recipientMap[cid].push({
      recipient_id : String(r[CONSULT_RECIPIENT_COL.RECIPIENT_ID - 1] || ''),
      is_read      : String(r[CONSULT_RECIPIENT_COL.IS_READ      - 1] || '') === 'true',
      read_at      : String(r[CONSULT_RECIPIENT_COL.READ_AT      - 1] || ''),
    });
  });

  var consultations = rows
    .map(function(r) {
      var c        = rowToConsultationV2(r);
      c.recipients = recipientMap[c.id] || [];
      return c;
    })
    .sort(function(a, b) { return b.created_at.localeCompare(a.created_at); }); // 新しい順

  Logger.log('[getConsultationsV2] count=%d, user=%s', consultations.length, data.operator_id);
  return { consultations: consultations, count: consultations.length };
}

/**
 * 相談を送信する。
 *
 * 入力:
 *   data.operator_id  - 送信者ID（必須）
 *   data.project_id   - 案件ID（任意）
 *   data.task_id      - タスクID（任意）
 *   data.title        - 件名（必須）
 *   data.message      - 本文（必須）
 *   data.recipient_ids - 送信先ユーザーIDの配列（必須・1件以上）
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function sendConsultation(ss, data) {
  if (!data.operator_id)  throw new Error('operator_id は必須です。');
  if (!data.title)         throw new Error('件名は必須です。');
  if (!data.message)       throw new Error('本文は必須です。');
  if (!Array.isArray(data.recipient_ids) || data.recipient_ids.length === 0) {
    throw new Error('送信先を1件以上指定してください。');
  }

  var consultSheet   = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  var recipientSheet = getOrCreateSheet(ss, SHEET_V2.CONSULTATION_RECIPIENTS);
  initConsultationSheetV2(consultSheet);
  initConsultRecipientSheet(recipientSheet);

  var now     = new Date().toISOString();
  var id      = generateId();
  var newRow  = consultSheet.getLastRow() + 1;

  consultSheet.getRange(newRow, 1, 1, CONSULT_V2_NUM_COLS).setValues([[
    id,
    data.project_id || '',
    data.task_id    || '',
    data.operator_id,
    data.title,
    data.message,
    '',   // is_resolved
    now,
    '',   // deleted
  ]]);
  SpreadsheetApp.flush();

  // 送信先ごとに recipients レコードを追加する
  data.recipient_ids.forEach(function(recipientId) {
    if (!recipientId) return;
    var recRow = recipientSheet.getLastRow() + 1;
    recipientSheet.getRange(recRow, 1, 1, CONSULT_RECIPIENT_NUM_COLS).setValues([[
      generateId(), id, recipientId, '', '',
    ]]);
  });
  SpreadsheetApp.flush();

  // 送信先ごとに通知を生成する
  var notifSheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  initNotificationSheet(notifSheet);
  data.recipient_ids.forEach(function(recipientId) {
    if (!recipientId) return;
    _createNotification(notifSheet, {
      recipient_id : recipientId,
      type         : NOTIF_TYPE_V2.CONSULTATION,
      title        : '相談が届きました',
      body         : data.title,
      task_id      : data.task_id    || '',
      project_id   : data.project_id || '',
    }, now);
  });
  SpreadsheetApp.flush();

  Logger.log('[sendConsultation] id=%s, recipients=%d', id, data.recipient_ids.length);
  return { id: id, saved: true };
}

/**
 * 相談を解決済みにする。
 *
 * 入力:
 *   data.consultation_id - 相談ID（必須）
 *   data.operator_id     - 操作者ID（送信者または Lv2以上）
 *
 * 出力:
 *   { consultation_id: string, resolved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function resolveConsultation(ss, data) {
  if (!data.consultation_id) throw new Error('consultation_id は必須です。');
  if (!data.operator_id)     throw new Error('operator_id は必須です。');

  var operator     = _getOperatorProj(data.operator_id);
  var consultSheet = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  var rows         = getAllRows(consultSheet);

  var idx = rows.findIndex(function(r) {
    return String(r[CONSULT_V2_COL.ID - 1]) === data.consultation_id &&
           String(r[CONSULT_V2_COL.DELETED - 1]) !== 'true';
  });
  if (idx === -1) throw new Error('相談が見つかりません: ' + data.consultation_id);

  // 送信者本人または職員以上のみ解決可能
  var senderId = String(rows[idx][CONSULT_V2_COL.SENDER_ID - 1] || '');
  if (_getPermLevelProj(operator) < 2 && senderId !== String(operator.id)) {
    throw new Error('この相談を解決済みにする権限がありません。');
  }

  consultSheet.getRange(idx + 2, CONSULT_V2_COL.IS_RESOLVED).setValue('true');
  SpreadsheetApp.flush();

  Logger.log('[resolveConsultation] id=%s', data.consultation_id);
  return { consultation_id: data.consultation_id, resolved: true };
}


// ============================================================
// 通知
// ============================================================

/**
 * 通知一覧を取得する（自分宛のみ）。
 *
 * 入力:
 *   data.recipient_id - 受信者ID（必須）
 *   data.unread_only  - true で未読のみ（省略時: false）
 *   data.limit        - 取得件数上限（省略時: 50）
 *
 * 出力:
 *   { notifications: Notification[], unread_count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getNotifications(ss, data) {
  if (!data.recipient_id) throw new Error('recipient_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  initNotificationSheet(sheet);

  var limit = data.limit ? Math.min(Number(data.limit), 100) : 50;

  var rows = getAllRows(sheet).filter(function(r) {
    if (String(r[NOTIF_COL.RECIPIENT_ID - 1]) !== String(data.recipient_id)) return false;
    if (data.unread_only && String(r[NOTIF_COL.IS_READ - 1]) === 'true') return false;
    return true;
  });

  // 新しい順にソートして件数制限をかける
  rows.sort(function(a, b) {
    return String(b[NOTIF_COL.CREATED_AT - 1]).localeCompare(String(a[NOTIF_COL.CREATED_AT - 1]));
  });
  rows = rows.slice(0, limit);

  var notifications = rows.map(rowToNotification);
  var unreadCount   = notifications.filter(function(n) { return !n.is_read; }).length;

  return { notifications: notifications, unread_count: unreadCount };
}

/**
 * 通知を既読にする（1件）。
 * @param {Spreadsheet} ss
 * @param {Object} data - { notification_id, recipient_id }
 * @returns {Object}
 */
function markNotificationRead(ss, data) {
  if (!data.notification_id) throw new Error('notification_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) {
    return String(r[NOTIF_COL.ID - 1]) === String(data.notification_id);
  });
  if (idx === -1) throw new Error('通知が見つかりません: ' + data.notification_id);

  sheet.getRange(idx + 2, NOTIF_COL.IS_READ).setValue('true');
  SpreadsheetApp.flush();

  return { notification_id: data.notification_id, read: true };
}

/**
 * 通知をすべて既読にする（受信者単位）。
 * @param {Spreadsheet} ss
 * @param {Object} data - { recipient_id }
 * @returns {Object}
 */
function markAllNotificationsRead(ss, data) {
  if (!data.recipient_id) throw new Error('recipient_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  var rows  = getAllRows(sheet);
  var count = 0;

  rows.forEach(function(r, i) {
    if (String(r[NOTIF_COL.RECIPIENT_ID - 1]) !== String(data.recipient_id)) return;
    if (String(r[NOTIF_COL.IS_READ - 1]) === 'true') return;
    sheet.getRange(i + 2, NOTIF_COL.IS_READ).setValue('true');
    count++;
  });

  if (count > 0) SpreadsheetApp.flush();
  return { marked_count: count };
}


// ============================================================
// フェーズテンプレート
// ============================================================

/**
 * フェーズテンプレート一覧を取得する。
 * @param {Spreadsheet} ss
 * @returns {Object}
 */
function getPhaseTemplates(ss) {
  var sheet = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
  initPhaseTemplateSheet(sheet);
  return { templates: getAllRows(sheet).map(rowToPhaseTemplate) };
}

/**
 * フェーズテンプレートを作成・更新する。
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function upsertPhaseTemplate(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, 'フェーズテンプレート登録');

  if (!data.name) throw new Error('テンプレート名は必須です。');
  if (!Array.isArray(data.phases) || data.phases.length === 0) {
    throw new Error('フェーズは1つ以上指定してください。');
  }

  var sheet     = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
  initPhaseTemplateSheet(sheet);

  var now       = new Date().toISOString();
  var rows      = getAllRows(sheet);
  var id        = data.template_id;
  var phasesStr = JSON.stringify(data.phases);

  if (id) {
    var idx = rows.findIndex(function(r) { return String(r[PHASE_TPL_COL.ID - 1]) === id; });
    if (idx === -1) throw new Error('テンプレートが見つかりません: ' + id);
    sheet.getRange(idx + 2, 1, 1, PHASE_TPL_NUM_COLS).setValues([[
      id, data.name, phasesStr, String(rows[idx][PHASE_TPL_COL.CREATED_AT - 1] || ''), now,
    ]]);
  } else {
    id = generateId();
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, PHASE_TPL_NUM_COLS).setValues([[
      id, data.name, phasesStr, now, now,
    ]]);
  }

  SpreadsheetApp.flush();
  Logger.log('[upsertPhaseTemplate] id=%s', id);
  return { id: id, saved: true };
}

/**
 * フェーズテンプレートを物理削除する。
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function deletePhaseTemplate(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, 'フェーズテンプレート削除');

  if (!data.template_id) throw new Error('template_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r) { return String(r[PHASE_TPL_COL.ID - 1]) === data.template_id; });
  if (idx === -1) throw new Error('テンプレートが見つかりません: ' + data.template_id);

  sheet.deleteRow(idx + 2);
  SpreadsheetApp.flush();
  return { deleted: true, id: data.template_id };
}


// ============================================================
// ダッシュボード（tasks シート参照に更新）
// ============================================================

/**
 * 制作進行ダッシュボードデータを取得する（v2）。
 *
 * 旧実装との変更点:
 *   - PROJECT_TASKS シート → tasks シート（SHEET_V2.TASKS）に変更
 *   - PTASK_COL → TASK_COL に変更
 *   - TASK_STATUSES → TASK_STATUS_V2 に変更
 *   - 「確認待ち」→「レビュー待ち」に変更
 *   - task_assignments から担当者を取得（単数担当→多対多）
 *
 * 返すデータ:
 *   summary        : 本日の弁当数・未打刻人数・レビュー待ち件数・期限超過
 *   staff_status   : スタッフ別出勤状態・担当タスク
 *   project_alerts : 遅延案件・納期近・レビュー待ち案件
 *
 * @param {Spreadsheet} ss
 * @param {Object} data - { operator_id, date (opt): YYYY-MM-DD }
 * @returns {Object}
 */
function getProjectDashboard(ss, data) {
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, 'ダッシュボード参照');

  var today_slash = data.date
    ? String(data.date).replace(/-/g, '/')
    : _todaySlashString();
  var today_iso = today_slash.replace(/\//g, '-');

  // ── 1回ずつ全シートを読み込む ────────────────────────
  var empSheet       = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var attendSheet    = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  var projectSheet   = getOrCreateSheet(ss, SHEET.PROJECTS);
  var taskSheet      = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet    = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  var consultSheet   = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  var recipientSheet = getOrCreateSheet(ss, SHEET_V2.CONSULTATION_RECIPIENTS);
  initProjectSheet(projectSheet);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);
  initConsultationSheetV2(consultSheet);
  initConsultRecipientSheet(recipientSheet);

  var employeeRows  = getAllRows(empSheet);
  var attendRows     = getAllRows(attendSheet);
  var projectRows    = getAllRows(projectSheet).filter(function(r) { return String(r[PROJECT_COL.DELETED - 1]) !== 'true'; });
  var taskRows       = getAllRows(taskSheet).filter(function(r)    { return String(r[TASK_COL.DELETED    - 1]) !== 'true'; });
  var assignRows     = getAllRows(assignSheet);
  var consultRows    = getAllRows(consultSheet).filter(function(r) { return String(r[CONSULT_V2_COL.DELETED - 1]) !== 'true'; });
  var recipientRows  = getAllRows(recipientSheet);

  // ── 本日出退勤マップ（employee_id → row）───────────────
  var todayAttMap = {};
  attendRows.forEach(function(r) {
    var d = String(r[ATTENDANCE_COL.DATE - 1] || '').replace(/-/g, '/');
    if (d === today_slash) todayAttMap[String(r[ATTENDANCE_COL.EMPLOYEE_ID - 1] || '')] = r;
  });

  // ── 担当者→タスク一覧マップ（user_id → task row[]）────
  // task_assignments を経由して多対多を解決する
  var taskMap = {}; // task_id → task row
  taskRows.forEach(function(r) { taskMap[String(r[TASK_COL.ID - 1] || '')] = r; });

  var tasksByUser = {}; // user_id → task row[]
  assignRows.forEach(function(r) {
    var uid = String(r[TASK_ASSIGN_COL.USER_ID - 1] || '');
    var tid = String(r[TASK_ASSIGN_COL.TASK_ID - 1] || '');
    if (!uid || !tid) return;
    var taskRow = taskMap[tid];
    if (!taskRow) return;
    if (String(taskRow[TASK_COL.STATUS - 1]) === TASK_STATUS_V2.COMPLETED) return; // 完了は除外
    if (!tasksByUser[uid]) tasksByUser[uid] = [];
    tasksByUser[uid].push(taskRow);
  });

  // ── タスクステータス集計 ─────────────────────────────
  var statusCount = {};
  TASK_STATUS_LIST_V2.forEach(function(s) { statusCount[s] = 0; });
  taskRows.forEach(function(r) {
    var st = String(r[TASK_COL.STATUS - 1] || '');
    if (statusCount[st] !== undefined) statusCount[st]++;
  });

  // 期限超過タスク数
  var overdueTaskCount = taskRows.filter(function(r) {
    var st  = String(r[TASK_COL.STATUS  - 1] || '');
    var due = _normDateToHyphen(r[TASK_COL.DUE_DATE - 1]);
    return st !== TASK_STATUS_V2.COMPLETED && due && due < today_iso;
  }).length;

  // ── 弁当数（本日の出勤者で弁当=有の件数）────────────
  var lunchCount = attendRows.filter(function(r) {
    var d = String(r[ATTENDANCE_COL.DATE  - 1] || '').replace(/-/g, '/');
    return d === today_slash && String(r[ATTENDANCE_COL.LUNCH - 1]) === '有';
  }).length;

  // ── 未打刻人数（出勤予定日なのに打刻がない人数）──────
  // 簡易判定: 本日出勤記録が存在しない職員・利用者の人数
  var totalActive = employeeRows.filter(function(r) {
    return String(r[EMPLOYEE_COL.DELETED - 1]) !== 'true' && r[EMPLOYEE_COL.ID - 1];
  }).length;
  var clockedCount = Object.keys(todayAttMap).length;
  var missingCount = Math.max(0, totalActive - clockedCount);

  // ── 未返信相談数（解決済みでない相談のうち、誰も既読にしていないもの）─
  // 「未返信」の定義: is_resolved=false かつ、その相談の受信者全員が未読（is_read=false）
  // 1人でも既読にした時点で「対応中」とみなし、未返信からは除外する
  var readMap = {}; // consultation_id → 既読が1件以上あるか
  recipientRows.forEach(function(r) {
    var cid = String(r[CONSULT_RECIPIENT_COL.CONSULTATION_ID - 1] || '');
    if (!cid) return;
    if (String(r[CONSULT_RECIPIENT_COL.IS_READ - 1]) === 'true') readMap[cid] = true;
  });
  var unrepliedConsultCount = consultRows.filter(function(r) {
    var resolved = String(r[CONSULT_V2_COL.IS_RESOLVED - 1]) === 'true';
    if (resolved) return false;
    var cid = String(r[CONSULT_V2_COL.ID - 1] || '');
    return !readMap[cid]; // 誰も既読にしていない = 未対応
  }).length;

  // ── 進行中案件数（完了・キャンセルを除く全案件）────────
  var activeProjectCount = projectRows.filter(function(r) {
    var st = String(r[PROJECT_COL.STATUS - 1] || '');
    return st !== '完了' && st !== 'キャンセル';
  }).length;

  // ── スタッフ状況 ────────────────────────────────────
  var staffStatuses = employeeRows
    .filter(function(r) {
      return String(r[EMPLOYEE_COL.DELETED - 1]) !== 'true' && r[EMPLOYEE_COL.ID - 1];
    })
    .map(function(r) {
      var emp       = rowToEmployee(r);
      var attRow    = todayAttMap[emp.id];
      var isPresent = !!(attRow && attRow[ATTENDANCE_COL.TIME_IN - 1]);

      var myTaskRows = tasksByUser[emp.id] || [];
      var myTasks    = myTaskRows.map(function(tr) {
        var due = _normDateToHyphen(tr[TASK_COL.DUE_DATE - 1]);
        return {
          task_id        : String(tr[TASK_COL.ID       - 1] || ''),
          task_title     : String(tr[TASK_COL.TITLE    - 1] || ''),
          project_id     : String(tr[TASK_COL.PROJECT_ID - 1] || ''),
          status         : String(tr[TASK_COL.STATUS   - 1] || ''),
          priority       : String(tr[TASK_COL.PRIORITY - 1] || '中'),
          due_date       : due,
          is_overdue     : !!(due && due < today_iso),
          review_required: String(tr[TASK_COL.REVIEW_REQUIRED - 1] || '') === 'true',
          scheduled_hours: _toNumOrNull(tr[TASK_COL.SCHEDULED_HOURS - 1]),
        };
      });

      var scheduledWork = emp.scheduled_hours || 0;
      var totalPlanned  = myTasks.reduce(function(sum, t) { return sum + (t.scheduled_hours || 0); }, 0);

      return {
        id              : emp.id,
        name            : emp.name,
        employment_type : emp.employment_type,
        is_present      : isPresent,
        time_in         : attRow ? String(attRow[ATTENDANCE_COL.TIME_IN  - 1] || '') : '',
        time_out        : attRow ? String(attRow[ATTENDANCE_COL.TIME_OUT - 1] || '') : '',
        lunch           : attRow ? String(attRow[ATTENDANCE_COL.LUNCH    - 1] || '') === '有' : false,
        current_tasks   : myTasks,
        scheduled_hours : scheduledWork,
        planned_hours   : totalPlanned,
        available_hours : Math.max(0, scheduledWork - totalPlanned),
        has_overdue     : myTasks.some(function(t) { return t.is_overdue; }),
        has_review      : myTasks.some(function(t) { return t.status === TASK_STATUS_V2.REVIEW; }),
      };
    });

  // ── 要注意案件 ───────────────────────────────────────
  // レビュー待ちタスクを案件別に集計する（tasks シート参照）
  var reviewByProject = {};
  taskRows.forEach(function(r) {
    if (String(r[TASK_COL.STATUS - 1]) !== TASK_STATUS_V2.REVIEW) return;
    var pid = String(r[TASK_COL.PROJECT_ID - 1] || '');
    if (!pid) return;
    if (!reviewByProject[pid]) reviewByProject[pid] = [];
    reviewByProject[pid].push({
      task_id  : String(r[TASK_COL.ID    - 1] || ''),
      task_title: String(r[TASK_COL.TITLE - 1] || ''),
    });
  });

  var futureDays3 = new Date();
  futureDays3.setDate(futureDays3.getDate() + 3);
  var limit3_iso  = _normDateToHyphen(futureDays3);

  var overdueProjects = [];
  var dueSoonProjects = [];
  var reviewProjects  = [];

  projectRows.forEach(function(r) {
    var st  = String(r[PROJECT_COL.STATUS  - 1] || '');
    var due = _normDateToHyphen(r[PROJECT_COL.DUE_DATE - 1]);
    var pid = String(r[PROJECT_COL.ID      - 1] || '');
    if (st === '完了' || st === 'キャンセル') return;

    var base = {
      id      : pid,
      name    : String(r[PROJECT_COL.NAME        - 1] || ''),
      client  : String(r[PROJECT_COL.CUSTOMER_ID - 1] || ''),
      due_date: due,
      status  : st,
    };

    if (due && due < today_iso) {
      overdueProjects.push(Object.assign({}, base, {
        overdue_days: Math.floor((new Date(today_iso) - new Date(due)) / 86400000),
      }));
    } else if (due && due <= limit3_iso) {
      dueSoonProjects.push(Object.assign({}, base, {
        days_remaining: Math.ceil((new Date(due) - new Date(today_iso)) / 86400000),
      }));
    }

    if (reviewByProject[pid]) {
      reviewProjects.push(Object.assign({}, base, { tasks: reviewByProject[pid] }));
    }
  });

  return {
    summary: {
      lunch_count        : lunchCount,            // ← 最優先表示①
      missing_clock      : missingCount,           // ← 最優先表示②
      review_waiting     : statusCount[TASK_STATUS_V2.REVIEW] || 0,  // ← 最優先③
      today_attendance   : Object.keys(todayAttMap).length,          // ← 最優先④
      unreplied_consult  : unrepliedConsultCount,  // ← 最優先⑤
      active_project_count: activeProjectCount,    // ← 最優先⑥
      task_not_started   : statusCount[TASK_STATUS_V2.NOT_STARTED] || 0,
      task_in_progress    : statusCount[TASK_STATUS_V2.IN_PROGRESS] || 0,
      task_rejected       : statusCount[TASK_STATUS_V2.REJECTED]    || 0,
      task_overdue        : overdueTaskCount,
      total_active_staff   : totalActive,
    },
    staff_status   : staffStatuses,
    project_alerts : {
      overdue       : overdueProjects,
      due_soon      : dueSoonProjects,
      review_waiting: reviewProjects,
    },
  };
}


// ============================================================
// マスタ取得（UI ドロップダウン用）
// ============================================================

/**
 * フロントのドロップダウン用マスタデータを一括取得する。
 * 認証・権限チェックなしで呼べる（参照専用）。
 *
 * @returns {Object}
 */
function getProjectMasters() {
  return {
    project_status_flow  : PROJECT_STATUS_FLOW,
    project_categories   : PROJECT_CATEGORIES,
    task_statuses        : TASK_STATUS_LIST_V2,         // v2 統一
    task_priorities      : TASK_PRIORITIES_V2,          // Shared.gs
    notif_types          : NOTIF_TYPE_V2,
    project_member_roles : PROJECT_MEMBER_ROLES,        // Shared.gs
    task_assign_roles    : TASK_ASSIGN_ROLES,           // Shared.gs
  };
}


// ============================================================
// ProjectService.gs 内部ユーティリティ
// ============================================================

/**
 * 通知を1件生成する（内部用）。
 * 呼び出し側で SpreadsheetApp.flush() を忘れずに呼ぶこと。
 *
 * @param {Sheet}  notifSheet
 * @param {Object} entry - { recipient_id, type, title, body, task_id, project_id }
 * @param {string} now   - ISO 8601
 */
function _createNotification(notifSheet, entry, now) {
  try {
    initNotificationSheet(notifSheet);
    var newRow = notifSheet.getLastRow() + 1;
    notifSheet.getRange(newRow, 1, 1, NOTIF_NUM_COLS).setValues([[
      generateId(),
      entry.recipient_id || '',
      entry.type         || '',
      entry.title        || '',
      entry.body         || '',
      entry.task_id      || '',
      entry.project_id   || '',
      '',   // is_read（未読で作成）
      now,
    ]]);
  } catch (err) {
    // 通知生成の失敗はメイン処理に影響させない
    Logger.log('[_createNotification] Failed (non-critical): %s', err.message);
  }
}

/**
 * project_members シートに1行追加する。
 * 呼び出し側で SpreadsheetApp.flush() を忘れずに呼ぶこと。
 *
 * @param {Sheet}  sheet
 * @param {string} projectId
 * @param {string} userId
 * @param {string} role
 * @param {string} now
 */
function _appendProjectMember(sheet, projectId, userId, role, now) {
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, PROJECT_MEMBER_NUM_COLS).setValues([[
    generateId(), projectId, userId, role, now,
  ]]);
}

/**
 * 本日の日付を 'YYYY/MM/DD' 形式で返す。
 * @returns {string}
 */
function _todaySlashString() {
  var d = new Date();
  return d.getFullYear() + '/'
    + String(d.getMonth() + 1).padStart(2, '0') + '/'
    + String(d.getDate()).padStart(2, '0');
}

/**
 * 本日の日付を 'YYYY-MM-DD' 形式で返す。
 * @returns {string}
 */
function _todayString() {
  return _todaySlashString().replace(/\//g, '-');
}

// ============================================================
// ① get_review_waiting_tasks
//    職員ホームの最優先表示。自分がレビューすべきタスクを返す。
// ============================================================

/**
 * レビュー待ちタスク一覧を取得する（職員・管理者専用）。
 *
 * 取得対象:
 *   - status === 'レビュー待ち'
 *   - 論理削除されていない
 *   - operator_id が Lv2 以上（職員・管理者）のみアクセス可
 *
 * 返却データには以下を JOIN して付与する:
 *   - task.assignees（担当者リスト）
 *   - task.project_name（案件名、案件IDがある場合）
 *
 * 入力:
 *   data.operator_id  - 操作者ID（必須・Lv2以上）
 *   data.project_id   - 案件フィルタ（任意）
 *   data.limit        - 件数上限（省略時: 50）
 *
 * 出力:
 *   { tasks: ReviewTask[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getReviewWaitingTasks(ss, data) {
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  // 権限チェック: Lv2以上（職員・管理者）のみ
  var operator = _getOperatorProj(data.operator_id);
  _requirePermProj(operator, 2, 'レビュー待ちタスク取得');

  var taskSheet    = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet  = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  var projectSheet = getOrCreateSheet(ss, SHEET.PROJECTS);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);
  initProjectSheet(projectSheet);

  var limit = data.limit ? Math.min(Number(data.limit), 100) : 50;

  // レビュー待ちタスクを全件取得する
  var taskRows = getAllRows(taskSheet).filter(function(r) {
    if (String(r[TASK_COL.DELETED - 1]) === 'true') return false;
    if (String(r[TASK_COL.STATUS  - 1]) !== TASK_STATUS_V2.REVIEW) return false;
    if (data.project_id && String(r[TASK_COL.PROJECT_ID - 1]) !== data.project_id) return false;
    return true;
  });

  // 期限昇順でソートし件数制限をかける（期限なしは末尾）
  taskRows.sort(function(a, b) {
    var da = String(a[TASK_COL.DUE_DATE - 1] || '9999/99/99');
    var db = String(b[TASK_COL.DUE_DATE - 1] || '9999/99/99');
    return da.localeCompare(db);
  });
  taskRows = taskRows.slice(0, limit);

  // 担当者マップを構築する（task_id → user_id[]）
  var assignRows = getAllRows(assignSheet);
  var assignMap  = {};
  assignRows.forEach(function(r) {
    var tid = String(r[TASK_ASSIGN_COL.TASK_ID - 1] || '');
    var uid = String(r[TASK_ASSIGN_COL.USER_ID - 1] || '');
    if (!tid || !uid) return;
    if (!assignMap[tid]) assignMap[tid] = [];
    assignMap[tid].push({
      user_id    : uid,
      role       : String(r[TASK_ASSIGN_COL.ROLE - 1] || '主担当'),
    });
  });

  // 案件名マップを構築する（project_id → name）
  var projectRows = getAllRows(projectSheet);
  var projectNameMap = {};
  projectRows.forEach(function(r) {
    var pid  = String(r[PROJECT_COL.ID   - 1] || '');
    var name = String(r[PROJECT_COL.NAME - 1] || '');
    if (pid) projectNameMap[pid] = name;
  });

  var today = _todayString();
  var tasks = taskRows.map(function(r) {
    var task       = rowToTask(r);
    task.assignees  = assignMap[task.id] || [];
    task.project_name = task.project_id ? (projectNameMap[task.project_id] || '') : '';

    // 期限超過フラグを付与する
    task.is_overdue = !!(task.due_date && task.due_date < today);

    return task;
  });

  Logger.log('[getReviewWaitingTasks] count=%d, operator=%s', tasks.length, data.operator_id);
  return { tasks: tasks, count: tasks.length };
}


// ============================================================
// ② reply_consultation
//    既存の相談スレッドに返信を追加する。
//    返信は新しい consultation レコードとして保存し、
//    parent_consultation_id で親を参照するスレッド構造にする。
//
//    【設計判断】
//    consultation シートの CONSULT_V2_COL にはすでに project_id / task_id があるが、
//    parent_consultation_id は未定義。今回は「返信は別レコード」方式とし、
//    title フィールドに "Re: 元件名" を格納して識別する。
//    将来的に CONSULT_V2_COL に parent_id 列を追加する場合は
//    CONSULT_V2_COL / CONSULT_V2_NUM_COLS を更新すること。
// ============================================================

/**
 * 相談に返信する。
 *
 * 返信は新規 consultation レコードとして保存する。
 * 件名に "Re: 元件名" を付けてスレッドを識別する。
 * 返信受信者は元の送信者（sender）に自動設定する。
 *
 * 入力:
 *   data.consultation_id  - 返信先の相談ID（必須）
 *   data.operator_id      - 返信者ID（必須・受信者または Lv2以上）
 *   data.message          - 返信本文（必須）
 *
 * 出力:
 *   { id: string, saved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function replyConsultation(ss, data) {
  if (!data.consultation_id) throw new Error('consultation_id は必須です。');
  if (!data.operator_id)     throw new Error('operator_id は必須です。');
  if (!data.message || !String(data.message).trim()) {
    throw new Error('返信内容は必須です。');
  }

  var operator     = _getOperatorProj(data.operator_id);
  var consultSheet = getOrCreateSheet(ss, SHEET.CONSULTATIONS);
  var recSheet     = getOrCreateSheet(ss, SHEET_V2.CONSULTATION_RECIPIENTS);
  initConsultationSheetV2(consultSheet);
  initConsultRecipientSheet(recSheet);

  // 元の相談を取得する
  var rows = getAllRows(consultSheet);
  var origRow = rows.find(function(r) {
    return String(r[CONSULT_V2_COL.ID - 1]) === String(data.consultation_id) &&
           String(r[CONSULT_V2_COL.DELETED - 1]) !== 'true';
  });
  if (!origRow) throw new Error('返信先の相談が見つかりません: ' + data.consultation_id);

  var origSenderId = String(origRow[CONSULT_V2_COL.SENDER_ID  - 1] || '');
  var origTitle    = String(origRow[CONSULT_V2_COL.TITLE      - 1] || '');
  var origProjId   = String(origRow[CONSULT_V2_COL.PROJECT_ID - 1] || '');
  var origTaskId   = String(origRow[CONSULT_V2_COL.TASK_ID    - 1] || '');

  // アクセス権チェック:
  //   - 元の相談の受信者（自分が recipient_id に含まれる）または
  //   - 元の送信者本人 または
  //   - Lv2以上（職員・管理者）
  var permLevel = _getPermLevelProj(operator);
  var isRecipient = getAllRows(recSheet).some(function(r) {
    return String(r[CONSULT_RECIPIENT_COL.CONSULTATION_ID - 1]) === String(data.consultation_id) &&
           String(r[CONSULT_RECIPIENT_COL.RECIPIENT_ID   - 1]) === String(operator.id);
  });

  if (permLevel < 2 && operator.id !== origSenderId && !isRecipient) {
    throw new Error('この相談に返信する権限がありません。');
  }

  var now     = new Date().toISOString();
  var replyId = generateId();
  var newRow  = consultSheet.getLastRow() + 1;

  // 返信を新規レコードとして保存する
  consultSheet.getRange(newRow, 1, 1, CONSULT_V2_NUM_COLS).setValues([[
    replyId,
    origProjId,
    origTaskId,
    data.operator_id,
    'Re: ' + origTitle,     // 件名にプレフィックスを付けてスレッドを識別する
    String(data.message).trim(),
    '',                     // is_resolved
    now,
    '',                     // deleted
  ]]);
  SpreadsheetApp.flush();

  // 返信先（元の送信者）を受信者として登録する
  // 自分自身へは送らない（返信者が元の送信者の場合はスキップ）
  var replyRecipients = [];
  if (origSenderId && origSenderId !== data.operator_id) {
    replyRecipients.push(origSenderId);
  }

  replyRecipients.forEach(function(recipientId) {
    var recNewRow = recSheet.getLastRow() + 1;
    recSheet.getRange(recNewRow, 1, 1, CONSULT_RECIPIENT_NUM_COLS).setValues([[
      generateId(), replyId, recipientId, '', '',
    ]]);
  });
  SpreadsheetApp.flush();

  // 返信通知を送信する
  var notifSheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  initNotificationSheet(notifSheet);
  replyRecipients.forEach(function(recipientId) {
    _createNotification(notifSheet, {
      recipient_id : recipientId,
      type         : NOTIF_TYPE_V2.CONSULTATION,
      title        : '相談に返信がありました',
      body         : origTitle,
      project_id   : origProjId,
      task_id      : origTaskId,
    }, now);
  });
  SpreadsheetApp.flush();

  Logger.log('[replyConsultation] replyId=%s, origId=%s', replyId, data.consultation_id);
  return { id: replyId, saved: true };
}


// ============================================================
// ③ mark_consultation_read
//    consultation_recipients の is_read を更新する。
//    相談画面を開いた職員が「既読」にするために呼ぶ。
// ============================================================

/**
 * 相談を既読にする（受信者単位）。
 *
 * consultation_recipients シートの is_read を 'true' に更新する。
 * 自分が受信者として登録されているレコードのみ更新する。
 *
 * 入力:
 *   data.consultation_id - 相談ID（必須）
 *   data.operator_id     - 既読にするユーザーのID（必須）
 *
 * 出力:
 *   { consultation_id: string, read: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function markConsultationRead(ss, data) {
  if (!data.consultation_id) throw new Error('consultation_id は必須です。');
  if (!data.operator_id)     throw new Error('operator_id は必須です。');

  var recSheet = getOrCreateSheet(ss, SHEET_V2.CONSULTATION_RECIPIENTS);
  initConsultRecipientSheet(recSheet);

  var rows = getAllRows(recSheet);
  var now  = new Date().toISOString();
  var updated = 0;

  rows.forEach(function(r, i) {
    var cid = String(r[CONSULT_RECIPIENT_COL.CONSULTATION_ID - 1] || '');
    var uid = String(r[CONSULT_RECIPIENT_COL.RECIPIENT_ID   - 1] || '');
    var isRead = String(r[CONSULT_RECIPIENT_COL.IS_READ     - 1] || '');

    // 対象の相談かつ自分が受信者のレコードのみ更新する
    if (cid !== data.consultation_id) return;
    if (uid !== data.operator_id)     return;
    if (isRead === 'true')            return; // すでに既読はスキップ

    var rowNum = i + 2;
    recSheet.getRange(rowNum, CONSULT_RECIPIENT_COL.IS_READ ).setValue('true');
    recSheet.getRange(rowNum, CONSULT_RECIPIENT_COL.READ_AT ).setValue(now);
    updated++;
  });

  if (updated > 0) SpreadsheetApp.flush();

  Logger.log('[markConsultationRead] consultation_id=%s, operator=%s, updated=%d',
    data.consultation_id, data.operator_id, updated);
  return { consultation_id: data.consultation_id, read: true };
}
