/**
 * Shared.gs — 新規シート定数・初期化関数・共通ユーティリティ
 *
 * 役割:
 *   A型事業所運営プラットフォームの「新規追加シート」に関する
 *   定数定義・ヘッダー初期化・行→オブジェクト変換をすべてここに集約する。
 *
 * 設計方針:
 *   - 既存 Code.gs の SHEET / EMPLOYEE_COL / ATTENDANCE_COL 等は変更しない
 *   - 本ファイルは「新規シート」のみを担当する
 *   - GAS は同一プロジェクト内でグローバル参照が効くため、
 *     Code.gs の generateId / getAllRows / getOrCreateSheet /
 *     createSuccessResponse / createErrorResponse / writeAuditLog /
 *     saveBackup / _safeTimeStr / convertDateForDisplay はそのまま使う
 *   - 列番号は 1始まり（スプレッドシートの列番号と一致させる）
 *   - 論理削除フラグ列は必ず最終列に配置する（列追加しやすくするため）
 *
 * 命名規則:
 *   SHEET_V2.*  — 新規シート名定数（既存 SHEET.* と衝突しないようプレフィックスを分ける）
 *   *_COL       — 各シートの列番号定数
 *   *_NUM_COLS  — 各シートの総列数（getAllRows の numCols に渡す値）
 *   init*Sheet  — シートのヘッダー初期化関数（getOrCreateSheet 後に呼ぶ）
 *   rowTo*      — シート行配列 → オブジェクト変換関数
 *
 * 依存関係（Code.gs から参照する関数）:
 *   generateId / getAllRows / getOrCreateSheet / createSuccessResponse /
 *   createErrorResponse / writeAuditLog / saveBackup / _safeTimeStr /
 *   convertDateForDisplay / validateDateFormat / formatDateToString
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// 新規シート名定数
//
// 既存 Code.gs の SHEET.* と衝突しないよう SHEET_V2 として定義する。
// Code.gs の SHEET を変更せずに拡張できる。
// ============================================================

var SHEET_V2 = {
  // ── タスク関連（最重要・本システムの中心エンティティ） ──
  TASKS              : 'tasks',              // タスク（3階層・自己参照）
  TASK_ASSIGNMENTS   : 'task_assignments',   // タスク担当者（多対多）
  TASK_HISTORIES     : 'task_histories',     // タスク変更履歴・差戻記録
  TASK_COMMENTS      : 'task_comments',      // タスクコメント（日報タスク別）

  // ── 案件・顧客関連 ──────────────────────────────────────
  // 注意: 顧客(CUSTOMERS)・案件(PROJECTS)は既存 ProjectServices.gs が
  //       SHEET.CUSTOMERS / SHEET.PROJECT_TASKS として定義・使用している。
  //       ProjectService リファクタリング時に統合する。
  PROJECT_MEMBERS    : 'project_members',    // 案件メンバー（利用者↔案件の多対多）

  // ── 日報・工数 ──────────────────────────────────────────
  DAILY_REPORTS      : 'daily_reports',      // 日報（全体コメント・引継ぎ）
  WORK_LOGS          : 'work_logs',          // 工数記録（task_id × user_id × 日次）

  // ── 相談 ────────────────────────────────────────────────
  // 既存 SHEET.CONSULTATIONS を改修して使う予定だが、
  // 移行期間中は consultation_recipients のみ新規追加する
  CONSULTATION_RECIPIENTS : 'consultation_recipients', // 相談送信先・既読管理

  // ── 通知 ────────────────────────────────────────────────
  // 既存 SHEET.NOTIFICATIONS を継続使用するため、ここには定義しない
};


// ============================================================
// tasksシート 列番号定数
//
// 本システムの中心エンティティ。
// 3階層（案件直下タスク / サブタスク）の自己参照構造を持つ。
//
// 列構成:
//   A(1):  id              - UUID
//   B(2):  project_id      - 案件ID（FK→案件シート、NULL可）
//   C(3):  parent_task_id  - 親タスクID（自己参照、'' = 最上位タスク）
//   D(4):  level           - 階層レベル（1=案件直下、2=サブタスク）
//   E(5):  title           - タスク名（必須）
//   F(6):  description     - 作業内容・詳細
//   G(7):  status          - ステータス（TASK_STATUS_V2 参照）
//   H(8):  review_required - レビュー必須フラグ（'true' | ''）
//   I(9):  priority        - 優先度（'高' | '中' | '低'）
//   J(10): due_date        - 期限（YYYY/MM/DD）
//   K(11): start_date      - 開始日（YYYY/MM/DD）
//   L(12): scheduled_hours - 予定工数（時間・数値）
//   M(13): completion_cond - 完了条件（テキスト）
//   N(14): created_by      - 作成者ID（FK→人員マスタ）
//   O(15): completed_at    - 完了日時（ISO 8601、未完了時は ''）
//   P(16): created_at      - 作成日時（ISO 8601）
//   Q(17): updated_at      - 更新日時（ISO 8601）
//   R(18): deleted         - 論理削除（'true' | ''）
//
// 自己参照の使い方（例）:
//   案件P001の配下:
//     タスクA     : project_id='P001', parent_task_id='',  level=1
//     サブタスクA1: project_id='P001', parent_task_id=<タスクAのid>, level=2
//
// ⚠️ 列を追加・変更する場合は以下をすべて更新すること:
//   1. TASK_COL の定数値
//   2. TASK_NUM_COLS の値
//   3. initTaskSheet のヘッダー配列
//   4. rowToTask の変換処理
// ============================================================

var TASK_COL = {
  ID              : 1,   // A: UUID
  PROJECT_ID      : 2,   // B: 案件ID（FK）
  PARENT_TASK_ID  : 3,   // C: 親タスクID（自己参照）
  LEVEL           : 4,   // D: 階層レベル
  TITLE           : 5,   // E: タスク名
  DESCRIPTION     : 6,   // F: 作業内容
  STATUS          : 7,   // G: ステータス
  REVIEW_REQUIRED : 8,   // H: レビュー必須フラグ
  PRIORITY        : 9,   // I: 優先度
  DUE_DATE        : 10,  // J: 期限
  START_DATE      : 11,  // K: 開始日
  SCHEDULED_HOURS : 12,  // L: 予定工数
  COMPLETION_COND : 13,  // M: 完了条件
  CREATED_BY      : 14,  // N: 作成者ID
  COMPLETED_AT    : 15,  // O: 完了日時
  CREATED_AT      : 16,  // P: 作成日時
  UPDATED_AT      : 17,  // Q: 更新日時
  DELETED         : 18,  // R: 論理削除
};
var TASK_NUM_COLS = 18;

// ============================================================
// task_assignmentsシート 列番号定数
//
// タスクと担当者の多対多を管理する。
// 同一 task_id に複数レコードを持つことで複数担当者を実現する。
//
// 列構成:
//   A(1): id         - UUID
//   B(2): task_id    - FK→tasks
//   C(3): user_id    - FK→人員マスタ
//   D(4): role       - '主担当' | '副担当'
//   E(5): created_at - 登録日時（ISO 8601）
// ============================================================

var TASK_ASSIGN_COL = {
  ID         : 1,  // A
  TASK_ID    : 2,  // B
  USER_ID    : 3,  // C
  ROLE       : 4,  // D
  CREATED_AT : 5,  // E
};
var TASK_ASSIGN_NUM_COLS = 5;

// ============================================================
// task_historiesシート 列番号定数
//
// タスクのステータス変更・レビュー承認・差戻をすべて記録する。
// 差戻時は reason が必須（空文字は受け付けない）。
//
// change_type の種類:
//   'status_change' — ステータスの一般的な変更
//   'rejection'     — レビューでの差戻（reason 必須）
//   'approval'      — レビュー承認
//   'edit'          — タスク内容の編集
//
// 列構成:
//   A(1): id          - UUID
//   B(2): task_id     - FK→tasks
//   C(3): changed_by  - 操作者ID（FK→人員マスタ）
//   D(4): change_type - 変更種別（上記参照）
//   E(5): from_status - 変更前ステータス（新規作成時は ''）
//   F(6): to_status   - 変更後ステータス
//   G(7): reason      - 差戻理由（rejection 時は必須、それ以外は任意）
//   H(8): created_at  - 記録日時（ISO 8601）
// ============================================================

var TASK_HISTORY_COL = {
  ID          : 1,  // A
  TASK_ID     : 2,  // B
  CHANGED_BY  : 3,  // C
  CHANGE_TYPE : 4,  // D
  FROM_STATUS : 5,  // E
  TO_STATUS   : 6,  // F
  REASON      : 7,  // G
  CREATED_AT  : 8,  // H
};
var TASK_HISTORY_NUM_COLS = 8;

// ============================================================
// task_commentsシート 列番号定数
//
// 日報（daily_reports）と紐付いたタスク別作業コメント。
// report_id が '' の場合は日報未作成時のスポット記録。
//
// 列構成:
//   A(1): id         - UUID
//   B(2): report_id  - FK→daily_reports（任意）
//   C(3): task_id    - FK→tasks（必須）
//   D(4): user_id    - FK→人員マスタ（必須）
//   E(5): content    - 作業コメント（必須）
//   F(6): work_date  - 作業日（YYYY/MM/DD）
//   G(7): created_at - 登録日時（ISO 8601）
// ============================================================

var TASK_COMMENT_COL = {
  ID         : 1,  // A
  REPORT_ID  : 2,  // B
  TASK_ID    : 3,  // C
  USER_ID    : 4,  // D
  CONTENT    : 5,  // E
  WORK_DATE  : 6,  // F
  CREATED_AT : 7,  // G
};
var TASK_COMMENT_NUM_COLS = 7;

// ============================================================
// project_membersシート 列番号定数
//
// 案件と利用者の多対多。
// 利用者は参加案件のタスクのみ閲覧可能。
//
// 列構成:
//   A(1): id         - UUID
//   B(2): project_id - FK→案件シート
//   C(3): user_id    - FK→人員マスタ（利用者のみ）
//   D(4): role       - '参加' | 'リーダー'
//   E(5): created_at - 登録日時（ISO 8601）
// ============================================================

var PROJECT_MEMBER_COL = {
  ID         : 1,  // A
  PROJECT_ID : 2,  // B
  USER_ID    : 3,  // C
  ROLE       : 4,  // D
  CREATED_AT : 5,  // E
};
var PROJECT_MEMBER_NUM_COLS = 5;

// ============================================================
// daily_reportsシート 列番号定数
//
// 退勤時に入力する日報の全体コメント・引継ぎ事項。
// タスク別コメントは task_comments シートで管理する（正規化）。
//
// 列構成:
//   A(1): id         - UUID
//   B(2): user_id    - FK→人員マスタ（必須）
//   C(3): work_date  - 勤務日（YYYY/MM/DD）
//   D(4): comment    - 全体コメント（本日の所感・全体進捗）
//   E(5): handover   - 引継ぎ事項
//   F(6): created_at - 登録日時（ISO 8601）
//   G(7): updated_at - 更新日時（ISO 8601）
// ============================================================

var DAILY_REPORT_COL = {
  ID         : 1,  // A
  USER_ID    : 2,  // B
  WORK_DATE  : 3,  // C
  COMMENT    : 4,  // D
  HANDOVER   : 5,  // E
  CREATED_AT : 6,  // F
  UPDATED_AT : 7,  // G
};
var DAILY_REPORT_NUM_COLS = 7;

// ============================================================
// work_logsシート 列番号定数
//
// タスクごとの日次工数記録。
// 退勤時または進捗報告時にスタッフが入力する（タイマー方式は使わない）。
// 案件ごとの工数集計は task.project_id を経由して行う。
//
// 列構成:
//   A(1): id         - UUID
//   B(2): task_id    - FK→tasks（必須）
//   C(3): user_id    - FK→人員マスタ（必須）
//   D(4): work_date  - 作業日（YYYY/MM/DD）
//   E(5): minutes    - 作業時間（分・数値）
//   F(6): memo       - メモ（任意）
//   G(7): created_at - 登録日時（ISO 8601）
// ============================================================

var WORK_LOG_COL = {
  ID         : 1,  // A
  TASK_ID    : 2,  // B
  USER_ID    : 3,  // C
  WORK_DATE  : 4,  // D
  MINUTES    : 5,  // E
  MEMO       : 6,  // F
  CREATED_AT : 7,  // G
};
var WORK_LOG_NUM_COLS = 7;

// ============================================================
// consultation_recipientsシート 列番号定数
//
// 相談の送信先と既読状態を管理する。
// consultations シートの1件に対して複数の recipient を持てる。
//
// 列構成:
//   A(1): id              - UUID
//   B(2): consultation_id - FK→相談シート
//   C(3): recipient_id    - 受信者ID（FK→人員マスタ）
//   D(4): is_read         - 既読フラグ（'true' | ''）
//   E(5): read_at         - 既読日時（ISO 8601、未読時は ''）
// ============================================================

var CONSULT_RECIPIENT_COL = {
  ID              : 1,  // A
  CONSULTATION_ID : 2,  // B
  RECIPIENT_ID    : 3,  // C
  IS_READ         : 4,  // D
  READ_AT         : 5,  // E
};
var CONSULT_RECIPIENT_NUM_COLS = 5;


// ============================================================
// タスクステータス定数（v2）
//
// 既存 AdminServices.gs の TASK_STATUSES / TASK_STATUSES_FOR_STAFF と
// 完全に分離した新定義。混在・参照を禁止する。
//
// レビューフロー:
//   review_required = false:
//     未着手 → 進行中 → 完了
//
//   review_required = true:
//     未着手 → 進行中 → レビュー待ち → 完了（職員が承認）
//                                    └→ 差戻 → 進行中（再作業）
//
// 権限ごとの遷移可能ステータス:
//   利用者(Lv1): '進行中', 'レビュー待ち'（review_required=true時）, '完了'（review_required=false時）
//   職員(Lv2):  すべてのステータスへ遷移可能
//   管理者(Lv3): すべてのステータスへ遷移可能
// ============================================================

var TASK_STATUS_V2 = {
  NOT_STARTED  : '未着手',
  IN_PROGRESS  : '進行中',
  REVIEW       : 'レビュー待ち',
  COMPLETED    : '完了',
  REJECTED     : '差戻',
};

// フロント用ドロップダウン表示順
var TASK_STATUS_LIST_V2 = ['未着手', '進行中', 'レビュー待ち', '完了', '差戻'];

// 利用者が自力で遷移できるステータス（職員のレビューが不要な場合）
var TASK_STATUS_FOR_USER = ['進行中', '完了'];

// レビュー必須タスクで利用者が遷移できるステータス（'完了'の代わりに'レビュー待ち'へ）
var TASK_STATUS_FOR_USER_REVIEW = ['進行中', 'レビュー待ち'];

// タスク変更種別
var TASK_CHANGE_TYPE = {
  STATUS_CHANGE : 'status_change',
  REJECTION     : 'rejection',
  APPROVAL      : 'approval',
  EDIT          : 'edit',
};

// タスク優先度
var TASK_PRIORITIES_V2 = ['高', '中', '低'];

// 担当者ロール
var TASK_ASSIGN_ROLES = ['主担当', '副担当'];

// 案件メンバーロール
var PROJECT_MEMBER_ROLES = ['参加', 'リーダー'];


// ============================================================
// シート初期化関数
//
// 各シートのヘッダー行を書き込む。
// getOrCreateSheet の直後に呼ぶ。
// ヘッダー行が存在する場合は何もしない（冪等性を保証する）。
// ============================================================

/**
 * tasksシートを初期化する。
 * ヘッダー行が存在する場合はスキップ（冪等）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initTaskSheet(sheet) {
  // ヘッダー行が既に存在する場合はスキップ（冪等性の保証）
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = [
    'id', 'project_id', 'parent_task_id', 'level',
    'title', 'description', 'status', 'review_required',
    'priority', 'due_date', 'start_date', 'scheduled_hours',
    'completion_cond', 'created_by', 'completed_at',
    'created_at', 'updated_at', 'deleted',
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initTaskSheet] ヘッダーを初期化しました');
}

/**
 * task_assignmentsシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initTaskAssignSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = ['id', 'task_id', 'user_id', 'role', 'created_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initTaskAssignSheet] ヘッダーを初期化しました');
}

/**
 * task_historiesシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initTaskHistorySheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = [
    'id', 'task_id', 'changed_by', 'change_type',
    'from_status', 'to_status', 'reason', 'created_at',
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initTaskHistorySheet] ヘッダーを初期化しました');
}

/**
 * task_commentsシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initTaskCommentSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = ['id', 'report_id', 'task_id', 'user_id', 'content', 'work_date', 'created_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initTaskCommentSheet] ヘッダーを初期化しました');
}

/**
 * project_membersシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initProjectMemberSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = ['id', 'project_id', 'user_id', 'role', 'created_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initProjectMemberSheet] ヘッダーを初期化しました');
}

/**
 * daily_reportsシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initDailyReportSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = ['id', 'user_id', 'work_date', 'comment', 'handover', 'created_at', 'updated_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initDailyReportSheet] ヘッダーを初期化しました');
}

/**
 * work_logsシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initWorkLogSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = ['id', 'task_id', 'user_id', 'work_date', 'minutes', 'memo', 'created_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initWorkLogSheet] ヘッダーを初期化しました');
}

/**
 * consultation_recipientsシートを初期化する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initConsultRecipientSheet(sheet) {
  if (sheet.getLastRow() >= 1 && sheet.getRange(1, 1).getValue() !== '') return;

  var headers = ['id', 'consultation_id', 'recipient_id', 'is_read', 'read_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('[initConsultRecipientSheet] ヘッダーを初期化しました');
}


// ============================================================
// 行→オブジェクト変換関数（rowTo* シリーズ）
//
// シートから読み込んだ配列行をオブジェクトに変換する。
// すべての値は型安全に処理し、不正値はデフォルト値にフォールバックする。
// ============================================================

/**
 * tasksシートの行配列をタスクオブジェクトに変換する。
 *
 * @param {Array} row - getAllRows が返す行配列（0始まりインデックス）
 * @returns {Object} タスクオブジェクト
 */
function rowToTask(row) {
  return {
    id              : String(row[TASK_COL.ID              - 1] || ''),
    project_id      : String(row[TASK_COL.PROJECT_ID      - 1] || ''),
    parent_task_id  : String(row[TASK_COL.PARENT_TASK_ID  - 1] || ''),
    level           : Number(row[TASK_COL.LEVEL           - 1]) || 1,
    title           : String(row[TASK_COL.TITLE           - 1] || ''),
    description     : String(row[TASK_COL.DESCRIPTION     - 1] || ''),
    status          : String(row[TASK_COL.STATUS          - 1] || TASK_STATUS_V2.NOT_STARTED),
    // 'true' 文字列のみ true として扱う（Boolean(row[...])にしないこと：'false'文字列もtrueになるため）
    review_required : String(row[TASK_COL.REVIEW_REQUIRED - 1] || '') === 'true',
    priority        : String(row[TASK_COL.PRIORITY        - 1] || '中'),
    // 日付はスプシから YYYY/MM/DD で取得される。フロントへは YYYY-MM-DD で返す。
    due_date        : _normDateToHyphen(row[TASK_COL.DUE_DATE   - 1]),
    start_date      : _normDateToHyphen(row[TASK_COL.START_DATE - 1]),
    scheduled_hours : _toNumOrNull(row[TASK_COL.SCHEDULED_HOURS - 1]),
    completion_cond : String(row[TASK_COL.COMPLETION_COND - 1] || ''),
    created_by      : String(row[TASK_COL.CREATED_BY      - 1] || ''),
    completed_at    : String(row[TASK_COL.COMPLETED_AT    - 1] || ''),
    created_at      : String(row[TASK_COL.CREATED_AT      - 1] || ''),
    updated_at      : String(row[TASK_COL.UPDATED_AT      - 1] || ''),
    deleted         : String(row[TASK_COL.DELETED         - 1] || '') === 'true',
    // フロント描画用の拡張フィールド（JOIN後に付与する）
    assignees       : [],  // task_assignments から JOIN して付与する
    subtasks        : [],  // 同シート内の parent_task_id 一致行を付与する
  };
}

/**
 * task_assignmentsシートの行配列を担当者オブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToTaskAssignment(row) {
  return {
    id         : String(row[TASK_ASSIGN_COL.ID         - 1] || ''),
    task_id    : String(row[TASK_ASSIGN_COL.TASK_ID    - 1] || ''),
    user_id    : String(row[TASK_ASSIGN_COL.USER_ID    - 1] || ''),
    role       : String(row[TASK_ASSIGN_COL.ROLE       - 1] || '主担当'),
    created_at : String(row[TASK_ASSIGN_COL.CREATED_AT - 1] || ''),
  };
}

/**
 * task_historiesシートの行配列を履歴オブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToTaskHistory(row) {
  return {
    id          : String(row[TASK_HISTORY_COL.ID          - 1] || ''),
    task_id     : String(row[TASK_HISTORY_COL.TASK_ID     - 1] || ''),
    changed_by  : String(row[TASK_HISTORY_COL.CHANGED_BY  - 1] || ''),
    change_type : String(row[TASK_HISTORY_COL.CHANGE_TYPE - 1] || ''),
    from_status : String(row[TASK_HISTORY_COL.FROM_STATUS - 1] || ''),
    to_status   : String(row[TASK_HISTORY_COL.TO_STATUS   - 1] || ''),
    reason      : String(row[TASK_HISTORY_COL.REASON      - 1] || ''),
    created_at  : String(row[TASK_HISTORY_COL.CREATED_AT  - 1] || ''),
  };
}

/**
 * task_commentsシートの行配列をコメントオブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToTaskComment(row) {
  return {
    id         : String(row[TASK_COMMENT_COL.ID         - 1] || ''),
    report_id  : String(row[TASK_COMMENT_COL.REPORT_ID  - 1] || ''),
    task_id    : String(row[TASK_COMMENT_COL.TASK_ID    - 1] || ''),
    user_id    : String(row[TASK_COMMENT_COL.USER_ID    - 1] || ''),
    content    : String(row[TASK_COMMENT_COL.CONTENT    - 1] || ''),
    work_date  : _normDateToHyphen(row[TASK_COMMENT_COL.WORK_DATE - 1]),
    created_at : String(row[TASK_COMMENT_COL.CREATED_AT - 1] || ''),
  };
}

/**
 * daily_reportsシートの行配列を日報オブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToDailyReport(row) {
  return {
    id         : String(row[DAILY_REPORT_COL.ID         - 1] || ''),
    user_id    : String(row[DAILY_REPORT_COL.USER_ID    - 1] || ''),
    work_date  : _normDateToHyphen(row[DAILY_REPORT_COL.WORK_DATE - 1]),
    comment    : String(row[DAILY_REPORT_COL.COMMENT    - 1] || ''),
    handover   : String(row[DAILY_REPORT_COL.HANDOVER   - 1] || ''),
    created_at : String(row[DAILY_REPORT_COL.CREATED_AT - 1] || ''),
    updated_at : String(row[DAILY_REPORT_COL.UPDATED_AT - 1] || ''),
  };
}

/**
 * work_logsシートの行配列を工数オブジェクトに変換する。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToWorkLog(row) {
  return {
    id         : String(row[WORK_LOG_COL.ID         - 1] || ''),
    task_id    : String(row[WORK_LOG_COL.TASK_ID    - 1] || ''),
    user_id    : String(row[WORK_LOG_COL.USER_ID    - 1] || ''),
    work_date  : _normDateToHyphen(row[WORK_LOG_COL.WORK_DATE - 1]),
    // 分は必ず整数として扱う（小数は切り捨て）
    minutes    : Math.floor(_toNumOrNull(row[WORK_LOG_COL.MINUTES - 1]) || 0),
    memo       : String(row[WORK_LOG_COL.MEMO       - 1] || ''),
    created_at : String(row[WORK_LOG_COL.CREATED_AT - 1] || ''),
  };
}


// ============================================================
// Shared.gs 内部ユーティリティ
//
// このファイル内でのみ使用するプライベート関数。
// 他ファイルから呼ぶ必要がある場合は public 関数として切り出すこと。
// ============================================================

/**
 * スプレッドシートから読んだ日付値を YYYY-MM-DD 文字列に正規化する。
 *
 * GAS は日付セルを Date 型で返すことがあり、
 * また YYYY/MM/DD で保存したものも Date 型に変換される。
 * フロントへは YYYY-MM-DD で返すことを統一する。
 *
 * @param {Date|string|*} value
 * @returns {string} 'YYYY-MM-DD' または ''
 */
function _normDateToHyphen(value) {
  if (!value && value !== 0) return '';

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    var y = value.getFullYear();
    var m = String(value.getMonth() + 1).padStart(2, '0');
    var d = String(value.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // 文字列の場合は YYYY/MM/DD → YYYY-MM-DD に変換する
  var str = String(value).replace(/\//g, '-');
  // YYYY-MM-DD 形式であることを確認してから返す
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);

  return '';
}

/**
 * 任意の値を数値に変換する。空・無効値は null を返す。
 *
 * @param {*} v
 * @returns {number|null}
 */
function _toNumOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/**
 * フロントから受け取った YYYY-MM-DD をスプシ保存用の YYYY/MM/DD に変換する。
 * 空文字はそのまま返す。
 *
 * @param {string} dateStr - 'YYYY-MM-DD' または ''
 * @returns {string} 'YYYY/MM/DD' または ''
 */
function _toSlashDate(dateStr) {
  if (!dateStr) return '';
  return String(dateStr).replace(/-/g, '/').slice(0, 10);
}


// ============================================================
// 全新規シートをまとめて初期化するセットアップ関数
//
// 新規スプレッドシートに初めてデプロイする際に
// GAS エディタから手動で1回だけ実行する。
// 既にヘッダーが存在するシートはスキップされる（冪等）。
// ============================================================

/**
 * 全新規シートをまとめて初期化する。
 * GAS エディタから手動で1回実行するセットアップ関数。
 *
 * @returns {Object} 初期化結果サマリ
 */
function setupAllNewSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = [];

  var sheetDefs = [
    { name: SHEET_V2.TASKS,                   initFn: initTaskSheet           },
    { name: SHEET_V2.TASK_ASSIGNMENTS,         initFn: initTaskAssignSheet     },
    { name: SHEET_V2.TASK_HISTORIES,           initFn: initTaskHistorySheet    },
    { name: SHEET_V2.TASK_COMMENTS,            initFn: initTaskCommentSheet    },
    { name: SHEET_V2.PROJECT_MEMBERS,          initFn: initProjectMemberSheet  },
    { name: SHEET_V2.DAILY_REPORTS,            initFn: initDailyReportSheet    },
    { name: SHEET_V2.WORK_LOGS,               initFn: initWorkLogSheet         },
    { name: SHEET_V2.CONSULTATION_RECIPIENTS,  initFn: initConsultRecipientSheet },
  ];

  sheetDefs.forEach(function(def) {
    try {
      var sheet = getOrCreateSheet(ss, def.name);
      def.initFn(sheet);
      results.push({ sheet: def.name, status: 'ok' });
      Logger.log('[setupAllNewSheets] %s: 初期化完了', def.name);
    } catch (err) {
      results.push({ sheet: def.name, status: 'error', message: err.message });
      Logger.log('[setupAllNewSheets] %s: エラー - %s', def.name, err.message);
    }
  });

  Logger.log('[setupAllNewSheets] 完了: %d シート処理', results.length);
  return { setup_results: results };
}
