/**
 * TaskService.gs — タスク管理サービス
 *
 * 役割:
 *   本システムの中心エンティティ「タスク」に関する
 *   CRUD・レビューフロー・差戻・履歴・担当者管理をすべて実装する。
 *
 * 設計方針:
 *   - Shared.gs の TASK_COL / TASK_ASSIGN_COL / TASK_HISTORY_COL を使う
 *   - Code.gs の generateId / getAllRows / getOrCreateSheet /
 *     createSuccessResponse / createErrorResponse / writeAuditLog /
 *     rowToEmployee / convertDateForDisplay を使う
 *   - すべての書き込み前に権限チェックを行う
 *   - タスク取得は「階層ツリー構造」で返す（フロントでの再構築コストを削減）
 *   - ステータス変更は必ず task_histories に記録する
 *   - 差戻は reason 必須（空文字は reject する）
 *   - 論理削除フラグが 'true' のレコードはすべて除外する
 *   - シート読み込みは1回に集約し、メモリ上でフィルタ・JOIN する
 *
 * エントリポイント:
 *   handleTaskAction(action, data) — Code.gs の switch 文から委譲される
 *
 * 実装するアクション:
 *   get_my_tasks          - 自分に割り当てられたタスク一覧（user.html用）
 *   get_tasks_by_project  - 案件配下のタスク階層ツリー（staff.html用）
 *   get_all_tasks         - 全タスク一覧（admin.html用）
 *   upsert_task_v2        - タスク作成・更新（parent_task_id / review_required 対応）
 *   update_task_status    - ステータス更新（レビューフロー制御つき）
 *   review_approve        - レビュー承認（職員・管理者のみ）
 *   review_reject         - 差戻（職員・管理者のみ・reason 必須）
 *   delete_task_v2        - タスク論理削除（職員・管理者のみ）
 *   get_task_history      - タスク変更履歴取得
 *   assign_task_user      - 担当者追加
 *   unassign_task_user    - 担当者削除
 *
 * 依存ファイル:
 *   Code.gs  — generateId / getAllRows / getOrCreateSheet /
 *              createSuccessResponse / createErrorResponse /
 *              writeAuditLog / rowToEmployee / convertDateForDisplay /
 *              SHEET（既存シート名定数）/ EMPLOYEE_COL
 *   Shared.gs — SHEET_V2 / TASK_COL / TASK_ASSIGN_COL / TASK_HISTORY_COL /
 *               TASK_STATUS_V2 / TASK_CHANGE_TYPE /
 *               initTaskSheet / initTaskAssignSheet / initTaskHistorySheet /
 *               rowToTask / rowToTaskAssignment / rowToTaskHistory /
 *               _toSlashDate / _normDateToHyphen
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

/**
 * タスク管理系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'get_my_tasks':
 *   case 'get_tasks_by_project':
 *   ...
 *     return handleTaskAction(action, data);
 *
 * @param {string} action - アクション名
 * @param {Object} data   - リクエストデータ
 * @returns {ContentService.TextOutput} JSON レスポンス
 */
function handleTaskAction(action, data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (action) {

      // ── タスク取得 ───────────────────────────────────────
      case 'get_my_tasks':
        // 利用者・職員が自分のタスクを取得する（user.html / staff.html 共用）
        return createSuccessResponse(getMyTasks(ss, data));

      case 'get_tasks_by_project':
        // 案件配下のタスクを階層ツリーで取得する（staff.html / admin.html 用）
        return createSuccessResponse(getTasksByProject(ss, data));

      case 'get_all_tasks':
        // 全タスク一覧を取得する（admin.html 用）
        return createSuccessResponse(getAllTasksAdmin(ss, data));

      case 'get_task_detail':
        // タスク詳細を1件取得する（担当者・履歴つき）
        return createSuccessResponse(getTaskDetail(ss, data));

      // ── タスク作成・更新 ─────────────────────────────────
      case 'upsert_task_v2':
        // タスクを作成または更新する（parent_task_id / review_required 対応）
        return createSuccessResponse(upsertTaskV2(ss, data));

      // ── ステータス更新 ───────────────────────────────────
      case 'update_task_status':
        // レビューフローを考慮したステータス更新
        return createSuccessResponse(updateTaskStatusV2(ss, data));

      // ── レビュー操作 ─────────────────────────────────────
      case 'review_approve':
        // レビュー承認（職員・管理者のみ）
        return createSuccessResponse(reviewApprove(ss, data));

      case 'review_reject':
        // 差戻（職員・管理者のみ・reason 必須）
        return createSuccessResponse(reviewReject(ss, data));

      // ── タスク削除 ───────────────────────────────────────
      case 'delete_task_v2':
        // タスク論理削除（職員・管理者のみ）
        return createSuccessResponse(deleteTaskV2(ss, data));

      // ── 変更履歴 ─────────────────────────────────────────
      case 'get_task_history':
        // タスクの変更履歴を取得する
        return createSuccessResponse(getTaskHistory(ss, data));

      // ── 担当者管理 ───────────────────────────────────────
      case 'assign_task_user':
        // タスクに担当者を追加する
        return createSuccessResponse(assignTaskUser(ss, data));

      case 'unassign_task_user':
        // タスクから担当者を削除する
        return createSuccessResponse(unassignTaskUser(ss, data));

      default:
        throw new Error('TaskService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleTaskAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 権限チェック
// ============================================================

/**
 * 人員マスタから権限レベルを返す。
 *
 * @param {Object} employee - rowToEmployee の戻り値
 * @returns {number} 1=利用者, 2=職員, 3=管理者, 0=不明
 */
function _getPermLevelTask(employee) {
  if (!employee) return 0;
  if (employee.admin_role === '管理者') return 3;
  // 職員（一般職員・給与計算担当）は Lv2
  if (employee.employment_type === '職員') return 2;
  // 利用者
  return 1;
}

/**
 * 権限レベルを検証し、不足していれば例外を投げる。
 *
 * @param {Object} employee  - rowToEmployee の戻り値
 * @param {number} required  - 必要な最低権限レベル
 * @param {string} [context] - エラーメッセージ用のコンテキスト（省略可）
 */
function _requirePermTask(employee, required, context) {
  var level = _getPermLevelTask(employee);
  if (level < required) {
    var who = context || '操作';
    throw new Error(who + ' を行う権限がありません（権限レベル: ' + level + '、必要: ' + required + '）。');
  }
}

/**
 * operator_id から人員マスタを引いて employee オブジェクトを返す。
 * 見つからない場合は例外を投げる。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {string} operatorId
 * @returns {Object} employee
 */
function _getOperatorTask(employeeSheet, operatorId) {
  if (!operatorId) throw new Error('operator_id は必須です。');
  var rows = getAllRows(employeeSheet);
  var row  = rows.find(function(r) {
    return String(r[EMPLOYEE_COL.ID - 1]) === String(operatorId) &&
           String(r[EMPLOYEE_COL.DELETED - 1]) !== 'true';
  });
  if (!row) throw new Error('操作者が見つかりません: ' + operatorId);
  return rowToEmployee(row);
}


// ============================================================
// タスク取得
// ============================================================

/**
 * 自分に割り当てられたタスクを取得する。
 *
 * user.html の「本日のタスク」表示に使用する。
 * 担当者テーブルから自分の task_id を取得し、タスク情報とJOINして返す。
 *
 * 入力:
 *   data.user_id          - 取得対象のユーザーID（必須）
 *   data.include_done     - true の場合「完了」も含める（省略時: false）
 *   data.date             - 指定日の期限タスクのみ返す場合（省略時: 全件）
 *
 * 出力:
 *   { tasks: Task[], count: number }
 *   Task には assignees（担当者リスト）が付与される
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getMyTasks(ss, data) {
  if (!data.user_id) throw new Error('user_id は必須です。');

  var taskSheet   = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);

  // 担当者テーブルから自分の task_id を収集する
  var assignRows  = getAllRows(assignSheet);
  var myTaskIds   = assignRows
    .filter(function(r) { return String(r[TASK_ASSIGN_COL.USER_ID - 1]) === String(data.user_id); })
    .map(function(r)    { return String(r[TASK_ASSIGN_COL.TASK_ID - 1]); });

  if (myTaskIds.length === 0) {
    return { tasks: [], count: 0 };
  }

  // タスクシートから自分の task_id に一致するものをフィルタする
  var taskRows = getAllRows(taskSheet).filter(function(r) {
    if (String(r[TASK_COL.DELETED - 1]) === 'true') return false;
    if (!data.include_done && String(r[TASK_COL.STATUS - 1]) === TASK_STATUS_V2.COMPLETED) return false;
    return myTaskIds.indexOf(String(r[TASK_COL.ID - 1])) !== -1;
  });

  // 全担当者マップを構築する（task_id → TaskAssignment[]）
  var assignMap = _buildAssignMap(assignRows);

  // タスクオブジェクトに変換し、担当者を付与する
  var tasks = taskRows.map(function(r) {
    var task      = rowToTask(r);
    task.assignees = assignMap[task.id] || [];
    return task;
  });

  // 期限昇順でソートする（期限なしは末尾）
  tasks.sort(function(a, b) {
    var da = a.due_date || '9999-99-99';
    var db = b.due_date || '9999-99-99';
    return da.localeCompare(db);
  });

  Logger.log('[getMyTasks] user_id=%s, count=%d', data.user_id, tasks.length);
  return { tasks: tasks, count: tasks.length };
}

/**
 * 案件配下のタスクを階層ツリーで取得する。
 *
 * staff.html のタスク管理画面に使用する。
 * 返却形式は「階層ツリー」とし、フロントが再構築不要にする。
 *
 * 入力:
 *   data.project_id       - 案件ID（必須）
 *   data.operator_id      - 操作者ID（権限チェック用）
 *   data.include_done     - true の場合「完了」も含める（省略時: false）
 *
 * 出力:
 *   { tasks: TaskTree[], count: number }
 *   TaskTree: Task & { subtasks: Task[] }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getTasksByProject(ss, data) {
  if (!data.project_id)  throw new Error('project_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var operator = _getOperatorTask(empSheet, data.operator_id);
  // 職員以上（Lv2）のみアクセス可能
  _requirePermTask(operator, 2, 'get_tasks_by_project');

  var taskSheet   = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);

  // 指定案件のタスクをすべて取得する（論理削除を除外）
  var allRows = getAllRows(taskSheet).filter(function(r) {
    if (String(r[TASK_COL.DELETED     - 1]) === 'true')                   return false;
    if (String(r[TASK_COL.PROJECT_ID  - 1]) !== String(data.project_id))  return false;
    if (!data.include_done && String(r[TASK_COL.STATUS - 1]) === TASK_STATUS_V2.COMPLETED) return false;
    return true;
  });

  // 担当者マップを構築する
  var assignRows = getAllRows(assignSheet);
  var assignMap  = _buildAssignMap(assignRows);

  // タスクオブジェクトに変換する
  var tasks = allRows.map(function(r) {
    var task      = rowToTask(r);
    task.assignees = assignMap[task.id] || [];
    return task;
  });

  // 階層ツリーを構築する
  var tree = _buildTaskTree(tasks);

  Logger.log('[getTasksByProject] project_id=%s, rootTasks=%d', data.project_id, tree.length);
  return { tasks: tree, count: tree.length };
}

/**
 * 全タスクを取得する（管理者用）。
 *
 * admin.html のタスク一覧画面に使用する。
 * フィルタ条件をすべて受け付ける。
 *
 * 入力:
 *   data.operator_id     - 操作者ID（管理者のみ）
 *   data.project_id      - 案件IDフィルタ（省略時: 全案件）
 *   data.status          - ステータスフィルタ（省略時: 全ステータス）
 *   data.assignee_id     - 担当者IDフィルタ（省略時: 全担当者）
 *   data.include_done    - true の場合「完了」も含める（省略時: false）
 *   data.review_only     - true の場合「レビュー待ち」のみ（省略時: false）
 *
 * 出力:
 *   { tasks: Task[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getAllTasksAdmin(ss, data) {
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var operator = _getOperatorTask(empSheet, data.operator_id);
  // 管理者（Lv3）のみアクセス可能
  _requirePermTask(operator, 3, 'get_all_tasks');

  var taskSheet   = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);

  var assignRows = getAllRows(assignSheet);
  var assignMap  = _buildAssignMap(assignRows);

  // 担当者フィルタ用のインデックス（user_id → task_id[]）
  var userToTaskIds = {};
  assignRows.forEach(function(r) {
    var uid = String(r[TASK_ASSIGN_COL.USER_ID - 1]);
    var tid = String(r[TASK_ASSIGN_COL.TASK_ID - 1]);
    if (!userToTaskIds[uid]) userToTaskIds[uid] = [];
    userToTaskIds[uid].push(tid);
  });

  var rows = getAllRows(taskSheet).filter(function(r) {
    // 論理削除を常に除外する
    if (String(r[TASK_COL.DELETED - 1]) === 'true') return false;

    // 完了タスクの除外（include_done=true なら含める）
    if (!data.include_done && String(r[TASK_COL.STATUS - 1]) === TASK_STATUS_V2.COMPLETED) return false;

    // レビュー待ちのみフィルタ
    if (data.review_only && String(r[TASK_COL.STATUS - 1]) !== TASK_STATUS_V2.REVIEW) return false;

    // 案件フィルタ
    if (data.project_id && String(r[TASK_COL.PROJECT_ID - 1]) !== String(data.project_id)) return false;

    // ステータスフィルタ
    if (data.status && String(r[TASK_COL.STATUS - 1]) !== data.status) return false;

    // 担当者フィルタ（担当者テーブル経由）
    if (data.assignee_id) {
      var assignedTaskIds = userToTaskIds[data.assignee_id] || [];
      if (assignedTaskIds.indexOf(String(r[TASK_COL.ID - 1])) === -1) return false;
    }

    return true;
  });

  var tasks = rows.map(function(r) {
    var task      = rowToTask(r);
    task.assignees = assignMap[task.id] || [];
    return task;
  });

  // 期限昇順でソートする
  tasks.sort(function(a, b) {
    var da = a.due_date || '9999-99-99';
    var db = b.due_date || '9999-99-99';
    return da.localeCompare(db);
  });

  Logger.log('[getAllTasksAdmin] count=%d', tasks.length);
  return { tasks: tasks, count: tasks.length };
}

/**
 * タスク詳細を1件取得する（担当者・履歴つき）。
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須）
 *
 * 出力:
 *   { task: Task & { assignees, history } }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getTaskDetail(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var taskSheet    = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet  = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  var histSheet    = getOrCreateSheet(ss, SHEET_V2.TASK_HISTORIES);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);
  initTaskHistorySheet(histSheet);

  // タスク本体を取得する
  var taskRow = _findTaskRowById(getAllRows(taskSheet), data.task_id);
  if (!taskRow) throw new Error('タスクが見つかりません: ' + data.task_id);

  var task = rowToTask(taskRow);
  if (task.deleted) throw new Error('削除済みのタスクです: ' + data.task_id);

  // 担当者を付与する
  var assignRows = getAllRows(assignSheet).filter(function(r) {
    return String(r[TASK_ASSIGN_COL.TASK_ID - 1]) === data.task_id;
  });
  task.assignees = assignRows.map(rowToTaskAssignment);

  // 変更履歴を付与する（新しい順）
  var histRows = getAllRows(histSheet)
    .filter(function(r) { return String(r[TASK_HISTORY_COL.TASK_ID - 1]) === data.task_id; })
    .map(rowToTaskHistory)
    .sort(function(a, b) { return b.created_at.localeCompare(a.created_at); });
  task.history = histRows;

  return { task: task };
}


// ============================================================
// タスク作成・更新（upsert）
// ============================================================

/**
 * タスクを作成または更新する。
 *
 * 新規作成時:
 *   - parent_task_id が指定されている場合: level=2（サブタスク）
 *   - parent_task_id が空の場合:           level=1（案件直下タスク）
 *   - status は '未着手' で固定（フロントからの status 指定は無視）
 *   - 担当者（assignees）が指定された場合は task_assignments に登録する
 *   - 担当者に通知を生成する（既存通知機能と連携）
 *
 * 更新時:
 *   - status・completed_at は変更不可（update_task_status を使うこと）
 *   - 担当者変更は assign_task_user / unassign_task_user を使うこと
 *   - 更新内容を task_histories に記録する
 *
 * 入力:
 *   data.task_id           - 更新時に指定（省略時: 新規作成）
 *   data.operator_id       - 操作者ID（必須・Lv2以上）
 *   data.project_id        - 案件ID（任意）
 *   data.parent_task_id    - 親タスクID（任意・省略時は最上位タスク）
 *   data.title             - タスク名（必須）
 *   data.description       - 作業内容（任意）
 *   data.review_required   - レビュー必須（true | false、省略時: false）
 *   data.priority          - 優先度（'高'|'中'|'低'、省略時: '中'）
 *   data.due_date          - 期限（YYYY-MM-DD、任意）
 *   data.start_date        - 開始日（YYYY-MM-DD、任意）
 *   data.scheduled_hours   - 予定工数（数値・時間、任意）
 *   data.completion_cond   - 完了条件（任意）
 *   data.assignees         - 担当者リスト [{ user_id, role }]（新規時のみ有効）
 *
 * 出力:
 *   { id: string, saved: true, is_new: boolean }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function upsertTaskV2(ss, data) {
  // ── バリデーション ──────────────────────────────────────
  if (!data.operator_id) throw new Error('operator_id は必須です。');
  if (!data.title)       throw new Error('タスク名は必須です。');

  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var operator = _getOperatorTask(empSheet, data.operator_id);
  _requirePermTask(operator, 2, 'タスク作成・更新');

  // 優先度バリデーション
  var priority = data.priority || '中';
  if (TASK_PRIORITIES_V2.indexOf(priority) === -1) {
    throw new Error('無効な優先度です: ' + priority);
  }

  var taskSheet   = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  var histSheet   = getOrCreateSheet(ss, SHEET_V2.TASK_HISTORIES);
  initTaskSheet(taskSheet);
  initTaskAssignSheet(assignSheet);
  initTaskHistorySheet(histSheet);

  var now       = new Date().toISOString();
  var dueDate   = _toSlashDate(data.due_date   || '');
  var startDate = _toSlashDate(data.start_date || '');
  var isNew     = !data.task_id;
  var taskId    = data.task_id || generateId();

  if (isNew) {
    // ── 新規作成 ────────────────────────────────────────────
    // parent_task_id が指定されている場合は level=2（サブタスク）
    // そうでなければ level=1（案件直下タスク）
    var level = (data.parent_task_id && String(data.parent_task_id).trim() !== '') ? 2 : 1;

    // 親タスクが存在するか確認する（存在しない親は指定できない）
    if (level === 2) {
      var parentRow = _findTaskRowById(getAllRows(taskSheet), data.parent_task_id);
      if (!parentRow) throw new Error('親タスクが見つかりません: ' + data.parent_task_id);
      if (String(parentRow[TASK_COL.DELETED - 1]) === 'true') {
        throw new Error('削除済みのタスクは親タスクに指定できません: ' + data.parent_task_id);
      }
    }

    var newRow = taskSheet.getLastRow() + 1;

    // 日付列はテキスト形式で書き込む（GAS の自動日付変換を防ぐ）
    taskSheet.getRange(newRow, TASK_COL.DUE_DATE  ).setNumberFormat('@');
    taskSheet.getRange(newRow, TASK_COL.START_DATE).setNumberFormat('@');

    taskSheet.getRange(newRow, 1, 1, TASK_NUM_COLS).setValues([[
      taskId,                                          // A: id
      data.project_id      || '',                      // B: project_id
      data.parent_task_id  || '',                      // C: parent_task_id
      level,                                           // D: level
      data.title,                                      // E: title
      data.description     || '',                      // F: description
      TASK_STATUS_V2.NOT_STARTED,                      // G: status（新規は必ず '未着手'）
      data.review_required === true ? 'true' : '',     // H: review_required
      priority,                                        // I: priority
      dueDate,                                         // J: due_date
      startDate,                                       // K: start_date
      data.scheduled_hours || '',                      // L: scheduled_hours
      data.completion_cond || '',                      // M: completion_cond
      data.operator_id,                                // N: created_by
      '',                                              // O: completed_at（未完了）
      now,                                             // P: created_at
      now,                                             // Q: updated_at
      '',                                              // R: deleted
    ]]);

    SpreadsheetApp.flush();

    // 担当者を task_assignments に登録する
    if (data.assignees && Array.isArray(data.assignees) && data.assignees.length > 0) {
      data.assignees.forEach(function(a) {
        if (!a.user_id) return; // user_id が空のエントリはスキップ
        var role = (TASK_ASSIGN_ROLES.indexOf(a.role) !== -1) ? a.role : '主担当';
        _appendTaskAssignment(assignSheet, taskId, a.user_id, role, now);
      });
      SpreadsheetApp.flush();
    }

    // 作成履歴を記録する
    _appendTaskHistory(histSheet, {
      task_id     : taskId,
      changed_by  : data.operator_id,
      change_type : TASK_CHANGE_TYPE.STATUS_CHANGE,
      from_status : '',
      to_status   : TASK_STATUS_V2.NOT_STARTED,
      reason      : '新規作成',
    }, now);
    SpreadsheetApp.flush();

    Logger.log('[upsertTaskV2] 新規作成: id=%s, title=%s', taskId, data.title);

  } else {
    // ── 更新 ────────────────────────────────────────────────
    var rows   = getAllRows(taskSheet);
    var idx    = _findTaskIndexById(rows, taskId);
    if (idx === -1) throw new Error('タスクが見つかりません: ' + taskId);
    if (String(rows[idx][TASK_COL.DELETED - 1]) === 'true') {
      throw new Error('削除済みタスクは更新できません: ' + taskId);
    }

    var existing = rows[idx];
    var rowNum   = idx + 2; // ヘッダー行(1) + 0始まりインデックス補正(1)

    // status と completed_at は update_task_status で変更するため、ここでは既存値を保持する
    var currentStatus      = String(existing[TASK_COL.STATUS       - 1] || TASK_STATUS_V2.NOT_STARTED);
    var currentCompletedAt = String(existing[TASK_COL.COMPLETED_AT - 1] || '');

    taskSheet.getRange(rowNum, TASK_COL.DUE_DATE  ).setNumberFormat('@');
    taskSheet.getRange(rowNum, TASK_COL.START_DATE).setNumberFormat('@');

    taskSheet.getRange(rowNum, 1, 1, TASK_NUM_COLS).setValues([[
      taskId,
      // project_id / parent_task_id / level は変更不可（構造の変更は delete → recreate）
      String(existing[TASK_COL.PROJECT_ID     - 1] || ''),
      String(existing[TASK_COL.PARENT_TASK_ID - 1] || ''),
      Number(existing[TASK_COL.LEVEL          - 1]) || 1,
      data.title,
      data.description     !== undefined ? data.description     : String(existing[TASK_COL.DESCRIPTION     - 1] || ''),
      currentStatus,                                             // status は変更しない
      data.review_required !== undefined
        ? (data.review_required === true ? 'true' : '')
        : String(existing[TASK_COL.REVIEW_REQUIRED - 1] || ''),
      data.priority || String(existing[TASK_COL.PRIORITY - 1] || '中'),
      dueDate   || String(existing[TASK_COL.DUE_DATE   - 1] || ''),
      startDate || String(existing[TASK_COL.START_DATE - 1] || ''),
      data.scheduled_hours !== undefined ? (data.scheduled_hours || '') : (existing[TASK_COL.SCHEDULED_HOURS - 1] || ''),
      data.completion_cond !== undefined ? data.completion_cond  : String(existing[TASK_COL.COMPLETION_COND  - 1] || ''),
      String(existing[TASK_COL.CREATED_BY   - 1] || ''),       // created_by は変更しない
      currentCompletedAt,                                        // completed_at は変更しない
      String(existing[TASK_COL.CREATED_AT   - 1] || ''),       // created_at は変更しない
      now,                                                       // updated_at を更新
      '',                                                        // deleted は変更しない
    ]]);

    SpreadsheetApp.flush();

    // 編集履歴を記録する
    _appendTaskHistory(histSheet, {
      task_id     : taskId,
      changed_by  : data.operator_id,
      change_type : TASK_CHANGE_TYPE.EDIT,
      from_status : currentStatus,
      to_status   : currentStatus,
      reason      : 'タスク内容を更新',
    }, now);
    SpreadsheetApp.flush();

    Logger.log('[upsertTaskV2] 更新: id=%s, title=%s', taskId, data.title);
  }

  return { id: taskId, saved: true, is_new: isNew };
}


// ============================================================
// ステータス更新（レビューフロー制御）
// ============================================================

/**
 * タスクのステータスを更新する。
 *
 * 利用者の遷移権限:
 *   review_required = false:
 *     未着手 → 進行中 → 完了（update_task_status で直接完了できる）
 *   review_required = true:
 *     未着手 → 進行中 → レビュー待ち（完了には review_approve が必要）
 *
 * 職員・管理者は任意のステータスへ遷移可能。
 * ただし「承認（レビュー待ち → 完了）」は review_approve を使うこと。
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須）
 *   data.status      - 変更後ステータス（必須）
 *   data.reason      - 変更理由（任意）
 *
 * 出力:
 *   { task_id: string, status: string, updated: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function updateTaskStatusV2(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');
  if (!data.status)      throw new Error('status は必須です。');

  // ステータス値バリデーション
  if (TASK_STATUS_LIST_V2.indexOf(data.status) === -1) {
    throw new Error('無効なステータスです: ' + data.status);
  }

  var empSheet  = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var taskSheet = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var histSheet = getOrCreateSheet(ss, SHEET_V2.TASK_HISTORIES);
  initTaskSheet(taskSheet);
  initTaskHistorySheet(histSheet);

  var operator = _getOperatorTask(empSheet, data.operator_id);
  var permLevel = _getPermLevelTask(operator);

  // タスクを取得する
  var rows = getAllRows(taskSheet);
  var idx  = _findTaskIndexById(rows, data.task_id);
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);
  var existing = rows[idx];
  if (String(existing[TASK_COL.DELETED - 1]) === 'true') {
    throw new Error('削除済みタスクのステータスは変更できません。');
  }

  var currentStatus   = String(existing[TASK_COL.STATUS          - 1] || TASK_STATUS_V2.NOT_STARTED);
  var reviewRequired  = String(existing[TASK_COL.REVIEW_REQUIRED - 1]) === 'true';
  var newStatus       = data.status;

  // ── 利用者（Lv1）の遷移制御 ──────────────────────────────
  if (permLevel < 2) {
    // 利用者が遷移できるステータスを review_required によって切り替える
    var allowedForUser = reviewRequired ? TASK_STATUS_FOR_USER_REVIEW : TASK_STATUS_FOR_USER;

    if (allowedForUser.indexOf(newStatus) === -1) {
      throw new Error(
        'このタスクでは「' + newStatus + '」への変更は' +
        (reviewRequired ? '「レビュー待ち」まで' : '「完了」まで') + 'しか変更できません。'
      );
    }

    // review_required=true のタスクで利用者が「完了」にしようとした場合のガード
    if (reviewRequired && newStatus === TASK_STATUS_V2.COMPLETED) {
      throw new Error(
        'このタスクはレビューが必要です。「レビュー待ち」に変更してください。' +
        '完了にするには職員の承認が必要です。'
      );
    }
  }

  // ── 完了処理 ────────────────────────────────────────────
  var now          = new Date().toISOString();
  var completedAt  = (newStatus === TASK_STATUS_V2.COMPLETED)
    ? now
    : String(existing[TASK_COL.COMPLETED_AT - 1] || ''); // 完了解除時はそのまま保持

  // ステータスを更新する（updated_at と completed_at のみ変更）
  var rowNum = idx + 2;
  taskSheet.getRange(rowNum, TASK_COL.STATUS      ).setValue(newStatus);
  taskSheet.getRange(rowNum, TASK_COL.COMPLETED_AT).setValue(completedAt);
  taskSheet.getRange(rowNum, TASK_COL.UPDATED_AT  ).setValue(now);

  SpreadsheetApp.flush();

  // 変更履歴を記録する
  _appendTaskHistory(histSheet, {
    task_id     : data.task_id,
    changed_by  : data.operator_id,
    change_type : TASK_CHANGE_TYPE.STATUS_CHANGE,
    from_status : currentStatus,
    to_status   : newStatus,
    reason      : data.reason || '',
  }, now);
  SpreadsheetApp.flush();

  // ── レビュー待ちになった場合は職員全員へ通知する ──────────
  // 「誰がレビューするか」を限定しない設計のため、職員全員に通知する。
  // 通知の失敗はタスク更新自体の成功には影響させない。
  if (newStatus === TASK_STATUS_V2.REVIEW && currentStatus !== TASK_STATUS_V2.REVIEW) {
    var taskTitle = String(existing[TASK_COL.TITLE      - 1] || '');
    var projectId = String(existing[TASK_COL.PROJECT_ID - 1] || '');
    _notifyTaskEvent(ss, _getAllStaffIds(ss), {
      type       : NOTIF_TYPE_V2.REVIEW_REQUEST,
      title      : 'レビュー依頼があります',
      body       : taskTitle,
      task_id    : data.task_id,
      project_id : projectId,
    });
  }

  Logger.log('[updateTaskStatusV2] id=%s, %s→%s', data.task_id, currentStatus, newStatus);
  return { task_id: data.task_id, status: newStatus, updated: true };
}


// ============================================================
// レビュー操作（承認・差戻）
// ============================================================

/**
 * レビューを承認する（レビュー待ち → 完了）。
 *
 * 実行条件:
 *   - 操作者が Lv2以上（職員・管理者）であること
 *   - タスクのステータスが「レビュー待ち」であること
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *   data.comment     - 承認コメント（任意）
 *
 * 出力:
 *   { task_id: string, status: '完了', approved: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function reviewApprove(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var empSheet  = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var taskSheet = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var histSheet = getOrCreateSheet(ss, SHEET_V2.TASK_HISTORIES);
  initTaskSheet(taskSheet);
  initTaskHistorySheet(histSheet);

  var operator = _getOperatorTask(empSheet, data.operator_id);
  _requirePermTask(operator, 2, 'レビュー承認');

  // タスクを取得する
  var rows = getAllRows(taskSheet);
  var idx  = _findTaskIndexById(rows, data.task_id);
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);
  var existing = rows[idx];
  if (String(existing[TASK_COL.DELETED - 1]) === 'true') {
    throw new Error('削除済みタスクは承認できません。');
  }

  var currentStatus = String(existing[TASK_COL.STATUS - 1] || '');
  if (currentStatus !== TASK_STATUS_V2.REVIEW) {
    throw new Error(
      'ステータスが「レビュー待ち」のタスクのみ承認できます（現在: ' + currentStatus + '）。'
    );
  }

  var now    = new Date().toISOString();
  var rowNum = idx + 2;

  // ステータスを「完了」に更新する
  taskSheet.getRange(rowNum, TASK_COL.STATUS      ).setValue(TASK_STATUS_V2.COMPLETED);
  taskSheet.getRange(rowNum, TASK_COL.COMPLETED_AT).setValue(now);
  taskSheet.getRange(rowNum, TASK_COL.UPDATED_AT  ).setValue(now);
  SpreadsheetApp.flush();

  // 承認履歴を記録する
  _appendTaskHistory(histSheet, {
    task_id     : data.task_id,
    changed_by  : data.operator_id,
    change_type : TASK_CHANGE_TYPE.APPROVAL,
    from_status : TASK_STATUS_V2.REVIEW,
    to_status   : TASK_STATUS_V2.COMPLETED,
    reason      : data.comment || '承認',
  }, now);
  SpreadsheetApp.flush();

  // 監査ログに記録する（承認操作は追跡対象）
  writeAuditLog(ss, {
    action    : 'review_approve',
    admin_id  : data.operator_id,
    target_id : data.task_id,
    reason    : data.comment || '承認',
    before    : TASK_STATUS_V2.REVIEW,
    after     : TASK_STATUS_V2.COMPLETED,
  });

  // ── 担当者全員へ承認通知を送る ────────────────────────────
  var taskTitleApproved = String(existing[TASK_COL.TITLE      - 1] || '');
  var projectIdApproved = String(existing[TASK_COL.PROJECT_ID - 1] || '');
  _notifyTaskEvent(ss, _getTaskAssigneeIds(ss, data.task_id), {
    type       : NOTIF_TYPE_V2.REVIEW_APPROVED,
    title      : 'タスクが承認されました',
    body       : taskTitleApproved,
    task_id    : data.task_id,
    project_id : projectIdApproved,
  });

  Logger.log('[reviewApprove] id=%s, approvedBy=%s', data.task_id, data.operator_id);
  return { task_id: data.task_id, status: TASK_STATUS_V2.COMPLETED, approved: true };
}

/**
 * レビューを差戻す（レビュー待ち → 差戻）。
 *
 * 差戻後のフロー:
 *   担当者は「差戻」→「進行中」に手動で戻してから再作業を行う。
 *   （差戻のまま放置されないよう、利用者には通知を送る）
 *
 * 実行条件:
 *   - 操作者が Lv2以上（職員・管理者）であること
 *   - タスクのステータスが「レビュー待ち」であること
 *   - reason（差戻理由）が必須（空文字は拒否）
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *   data.reason      - 差戻理由（必須・空文字不可）
 *
 * 出力:
 *   { task_id: string, status: '差戻', rejected: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function reviewReject(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');
  // 差戻理由は必須。空文字・空白のみは拒否する。
  if (!data.reason || !String(data.reason).trim()) {
    throw new Error('差戻理由を入力してください（必須）。');
  }

  var empSheet  = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var taskSheet = getOrCreateSheet(ss, SHEET_V2.TASKS);
  var histSheet = getOrCreateSheet(ss, SHEET_V2.TASK_HISTORIES);
  initTaskSheet(taskSheet);
  initTaskHistorySheet(histSheet);

  var operator = _getOperatorTask(empSheet, data.operator_id);
  _requirePermTask(operator, 2, 'レビュー差戻');

  // タスクを取得する
  var rows = getAllRows(taskSheet);
  var idx  = _findTaskIndexById(rows, data.task_id);
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);
  var existing = rows[idx];
  if (String(existing[TASK_COL.DELETED - 1]) === 'true') {
    throw new Error('削除済みタスクは差戻できません。');
  }

  var currentStatus = String(existing[TASK_COL.STATUS - 1] || '');
  if (currentStatus !== TASK_STATUS_V2.REVIEW) {
    throw new Error(
      'ステータスが「レビュー待ち」のタスクのみ差戻できます（現在: ' + currentStatus + '）。'
    );
  }

  var now    = new Date().toISOString();
  var rowNum = idx + 2;

  // ステータスを「差戻」に更新する
  taskSheet.getRange(rowNum, TASK_COL.STATUS    ).setValue(TASK_STATUS_V2.REJECTED);
  taskSheet.getRange(rowNum, TASK_COL.UPDATED_AT).setValue(now);
  SpreadsheetApp.flush();

  // 差戻履歴を記録する（reason を必ず保存する）
  _appendTaskHistory(histSheet, {
    task_id     : data.task_id,
    changed_by  : data.operator_id,
    change_type : TASK_CHANGE_TYPE.REJECTION,
    from_status : TASK_STATUS_V2.REVIEW,
    to_status   : TASK_STATUS_V2.REJECTED,
    reason      : data.reason,
  }, now);
  SpreadsheetApp.flush();

  // 監査ログに記録する
  writeAuditLog(ss, {
    action    : 'review_reject',
    admin_id  : data.operator_id,
    target_id : data.task_id,
    reason    : data.reason,
    before    : TASK_STATUS_V2.REVIEW,
    after     : TASK_STATUS_V2.REJECTED,
  });

  // ── 担当者全員へ差戻通知を送る（理由を本文に含める）────────
  var taskTitleRejected = String(existing[TASK_COL.TITLE      - 1] || '');
  var projectIdRejected = String(existing[TASK_COL.PROJECT_ID - 1] || '');
  _notifyTaskEvent(ss, _getTaskAssigneeIds(ss, data.task_id), {
    type       : NOTIF_TYPE_V2.REVISION,
    title      : 'タスクが差戻されました',
    body       : taskTitleRejected + '：' + data.reason,
    task_id    : data.task_id,
    project_id : projectIdRejected,
  });

  Logger.log('[reviewReject] id=%s, reason=%s', data.task_id, data.reason);
  return { task_id: data.task_id, status: TASK_STATUS_V2.REJECTED, rejected: true };
}


// ============================================================
// タスク削除
// ============================================================

/**
 * タスクを論理削除する。
 *
 * 子タスク（サブタスク）が存在する場合は削除不可。
 * サブタスクを先にすべて削除してから親タスクを削除すること。
 *
 * 実行条件:
 *   - 操作者が Lv2以上（職員・管理者）であること
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *
 * 出力:
 *   { task_id: string, deleted: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function deleteTaskV2(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var empSheet  = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var taskSheet = getOrCreateSheet(ss, SHEET_V2.TASKS);
  initTaskSheet(taskSheet);

  var operator = _getOperatorTask(empSheet, data.operator_id);
  _requirePermTask(operator, 2, 'タスク削除');

  var rows = getAllRows(taskSheet);
  var idx  = _findTaskIndexById(rows, data.task_id);
  if (idx === -1) throw new Error('タスクが見つかりません: ' + data.task_id);
  var existing = rows[idx];
  if (String(existing[TASK_COL.DELETED - 1]) === 'true') {
    throw new Error('すでに削除済みのタスクです: ' + data.task_id);
  }

  // 子タスクが存在するか確認する（削除ブロック）
  var hasChildren = rows.some(function(r) {
    return String(r[TASK_COL.PARENT_TASK_ID - 1]) === data.task_id &&
           String(r[TASK_COL.DELETED        - 1]) !== 'true';
  });
  if (hasChildren) {
    throw new Error(
      'サブタスクが存在するため削除できません。先にサブタスクをすべて削除してください。'
    );
  }

  var now    = new Date().toISOString();
  var rowNum = idx + 2;

  taskSheet.getRange(rowNum, TASK_COL.DELETED   ).setValue('true');
  taskSheet.getRange(rowNum, TASK_COL.UPDATED_AT).setValue(now);
  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action    : 'delete_task_v2',
    admin_id  : data.operator_id,
    target_id : data.task_id,
    reason    : '論理削除',
  });

  Logger.log('[deleteTaskV2] id=%s, deletedBy=%s', data.task_id, data.operator_id);
  return { task_id: data.task_id, deleted: true };
}


// ============================================================
// 変更履歴取得
// ============================================================

/**
 * タスクの変更履歴を取得する（新しい順）。
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.operator_id - 操作者ID（必須）
 *
 * 出力:
 *   { history: TaskHistory[], count: number }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getTaskHistory(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var histSheet = getOrCreateSheet(ss, SHEET_V2.TASK_HISTORIES);
  initTaskHistorySheet(histSheet);

  var history = getAllRows(histSheet)
    .filter(function(r) { return String(r[TASK_HISTORY_COL.TASK_ID - 1]) === data.task_id; })
    .map(rowToTaskHistory)
    .sort(function(a, b) { return b.created_at.localeCompare(a.created_at); }); // 新しい順

  Logger.log('[getTaskHistory] task_id=%s, count=%d', data.task_id, history.length);
  return { history: history, count: history.length };
}


// ============================================================
// 担当者管理
// ============================================================

/**
 * タスクに担当者を追加する。
 *
 * 同一 task_id × user_id の重複は登録しない（冪等）。
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.user_id     - 追加する担当者のユーザーID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *   data.role        - '主担当' | '副担当'（省略時: '主担当'）
 *
 * 出力:
 *   { task_id: string, user_id: string, added: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function assignTaskUser(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.user_id)     throw new Error('user_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var empSheet    = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskAssignSheet(assignSheet);

  var operator = _getOperatorTask(empSheet, data.operator_id);
  _requirePermTask(operator, 2, '担当者追加');

  var role = (TASK_ASSIGN_ROLES.indexOf(data.role) !== -1) ? data.role : '主担当';

  // 重複チェック（同一 task_id × user_id が既に存在する場合はスキップ）
  var assignRows = getAllRows(assignSheet);
  var duplicate  = assignRows.find(function(r) {
    return String(r[TASK_ASSIGN_COL.TASK_ID - 1]) === String(data.task_id) &&
           String(r[TASK_ASSIGN_COL.USER_ID - 1]) === String(data.user_id);
  });
  if (duplicate) {
    Logger.log('[assignTaskUser] 重複スキップ: task_id=%s, user_id=%s', data.task_id, data.user_id);
    return { task_id: data.task_id, user_id: data.user_id, added: false, reason: '既に担当者として登録されています。' };
  }

  var now = new Date().toISOString();
  _appendTaskAssignment(assignSheet, data.task_id, data.user_id, role, now);
  SpreadsheetApp.flush();

  Logger.log('[assignTaskUser] task_id=%s, user_id=%s, role=%s', data.task_id, data.user_id, role);
  return { task_id: data.task_id, user_id: data.user_id, added: true };
}

/**
 * タスクから担当者を削除する（物理削除）。
 *
 * 削除後に担当者が0人になっても許容する。
 * （タスク自体は残し、担当者未設定の状態にする）
 *
 * 入力:
 *   data.task_id     - タスクID（必須）
 *   data.user_id     - 削除する担当者のユーザーID（必須）
 *   data.operator_id - 操作者ID（必須・Lv2以上）
 *
 * 出力:
 *   { task_id: string, user_id: string, removed: true }
 *
 * @param {Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function unassignTaskUser(ss, data) {
  if (!data.task_id)     throw new Error('task_id は必須です。');
  if (!data.user_id)     throw new Error('user_id は必須です。');
  if (!data.operator_id) throw new Error('operator_id は必須です。');

  var empSheet    = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskAssignSheet(assignSheet);

  var operator = _getOperatorTask(empSheet, data.operator_id);
  _requirePermTask(operator, 2, '担当者削除');

  var assignRows = getAllRows(assignSheet);
  var idx = assignRows.findIndex(function(r) {
    return String(r[TASK_ASSIGN_COL.TASK_ID - 1]) === String(data.task_id) &&
           String(r[TASK_ASSIGN_COL.USER_ID - 1]) === String(data.user_id);
  });
  if (idx === -1) {
    throw new Error('指定した担当者は登録されていません: task_id=' + data.task_id + ', user_id=' + data.user_id);
  }

  // 後ろの行から削除する（行番号のズレを防ぐ）
  var rowNum = idx + 2;
  assignSheet.deleteRow(rowNum);
  SpreadsheetApp.flush();

  Logger.log('[unassignTaskUser] task_id=%s, user_id=%s', data.task_id, data.user_id);
  return { task_id: data.task_id, user_id: data.user_id, removed: true };
}


// ============================================================
// TaskService 内部ユーティリティ
//
// このファイル内でのみ使用するプライベート関数。
// ============================================================

/**
 * task_assignments から指定タスクの担当者ID一覧を取得する。
 *
 * @param {Spreadsheet} ss
 * @param {string} taskId
 * @returns {string[]} user_id の配列（重複なし）
 */
function _getTaskAssigneeIds(ss, taskId) {
  var assignSheet = getOrCreateSheet(ss, SHEET_V2.TASK_ASSIGNMENTS);
  initTaskAssignSheet(assignSheet);

  var ids = getAllRows(assignSheet)
    .filter(function(r) { return String(r[TASK_ASSIGN_COL.TASK_ID - 1]) === String(taskId); })
    .map(function(r) { return String(r[TASK_ASSIGN_COL.USER_ID - 1] || ''); })
    .filter(Boolean);

  // 重複を除去する
  return ids.filter(function(id, i) { return ids.indexOf(id) === i; });
}

/**
 * 人員マスタから職員・管理者（Lv2以上）の user_id 一覧を取得する。
 * レビュー依頼通知の送信先（職員全員）として使う。
 *
 * @param {Spreadsheet} ss
 * @returns {string[]} user_id の配列
 */
function _getAllStaffIds(ss) {
  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var rows     = getAllRows(empSheet);

  return rows
    .filter(function(r) {
      return String(r[EMPLOYEE_COL.DELETED - 1])         !== 'true' &&
             String(r[EMPLOYEE_COL.EMPLOYMENT_TYPE - 1]) === '職員';
    })
    .map(function(r) { return String(r[EMPLOYEE_COL.ID - 1] || ''); })
    .filter(Boolean);
}

/**
 * タスク関連の通知をまとめて生成する（内部用）。
 *
 * ProjectService.gs で定義済みの _createNotification（通知1件生成）を
 * 複数の受信者に対してループ実行するラッパー。
 * 通知生成の失敗はメイン処理に影響させない
 * （_createNotification 内で既に try/catch 済み）。
 *
 * @param {Spreadsheet} ss
 * @param {string[]} recipientIds - 送信先 user_id の配列
 * @param {Object}   entry        - { type, title, body, task_id, project_id }
 */
function _notifyTaskEvent(ss, recipientIds, entry) {
  if (!recipientIds || !recipientIds.length) return;

  var notifSheet = getOrCreateSheet(ss, SHEET.NOTIFICATIONS);
  initNotificationSheet(notifSheet);

  var now = new Date().toISOString();
  recipientIds.forEach(function(recipientId) {
    if (!recipientId) return;
    _createNotification(notifSheet, {
      recipient_id : recipientId,
      type         : entry.type,
      title        : entry.title,
      body         : entry.body,
      task_id      : entry.task_id    || '',
      project_id   : entry.project_id || '',
    }, now);
  });
}

/**
 * タスク行配列から ID で行を検索し、インデックスを返す。
 * 見つからない場合は -1 を返す。
 *
 * @param {Array[]} rows   - getAllRows の戻り値
 * @param {string}  taskId - 検索するタスクID
 * @returns {number} 0始まりインデックス、見つからない場合は -1
 */
function _findTaskIndexById(rows, taskId) {
  return rows.findIndex(function(r) {
    return String(r[TASK_COL.ID - 1]) === String(taskId);
  });
}

/**
 * タスク行配列から ID で行を検索し、行データを返す。
 * 見つからない場合は null を返す。
 *
 * @param {Array[]} rows   - getAllRows の戻り値
 * @param {string}  taskId - 検索するタスクID
 * @returns {Array|null}
 */
function _findTaskRowById(rows, taskId) {
  return rows.find(function(r) {
    return String(r[TASK_COL.ID - 1]) === String(taskId);
  }) || null;
}

/**
 * task_assignments の行配列から task_id → 担当者リスト のマップを構築する。
 *
 * { task_id: TaskAssignment[] } の形式で返す。
 * タスク一覧取得時にまとめてマップを作ることで、
 * タスクごとに個別シート読み込みをせずに済む（N+1問題の回避）。
 *
 * @param {Array[]} assignRows - task_assignments シートの全行
 * @returns {Object} { [task_id]: TaskAssignment[] }
 */
function _buildAssignMap(assignRows) {
  var map = {};
  assignRows.forEach(function(r) {
    var tid = String(r[TASK_ASSIGN_COL.TASK_ID - 1] || '');
    if (!tid) return;
    if (!map[tid]) map[tid] = [];
    map[tid].push(rowToTaskAssignment(r));
  });
  return map;
}

/**
 * タスクのフラットリストから親子構造のツリーを構築する。
 *
 * level=1 のタスクを roots として返し、
 * それぞれの subtasks 配列に level=2 の子タスクを格納する。
 *
 * 設計上の制約:
 *   最大2階層（level 1 と level 2）のみ対応する。
 *   level 3 以上は設計書で定義していないため無視する。
 *
 * @param {Object[]} tasks - rowToTask の戻り値の配列
 * @returns {Object[]} ルートタスクの配列（subtasks 付き）
 */
function _buildTaskTree(tasks) {
  var roots    = [];
  var childMap = {}; // { parent_task_id: Task[] }

  tasks.forEach(function(task) {
    if (!task.parent_task_id || task.parent_task_id === '') {
      roots.push(task);
    } else {
      if (!childMap[task.parent_task_id]) childMap[task.parent_task_id] = [];
      childMap[task.parent_task_id].push(task);
    }
  });

  // ルートタスクに subtasks を付与する
  roots.forEach(function(root) {
    root.subtasks = childMap[root.id] || [];
    // サブタスクも期限昇順でソートする
    root.subtasks.sort(function(a, b) {
      var da = a.due_date || '9999-99-99';
      var db = b.due_date || '9999-99-99';
      return da.localeCompare(db);
    });
  });

  // ルートタスクを期限昇順でソートする
  roots.sort(function(a, b) {
    var da = a.due_date || '9999-99-99';
    var db = b.due_date || '9999-99-99';
    return da.localeCompare(db);
  });

  return roots;
}

/**
 * task_assignments シートに1行追加する。
 * 呼び出し側で SpreadsheetApp.flush() を忘れずに呼ぶこと。
 *
 * @param {Sheet}  sheet
 * @param {string} taskId
 * @param {string} userId
 * @param {string} role
 * @param {string} now - ISO 8601
 */
function _appendTaskAssignment(sheet, taskId, userId, role, now) {
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, TASK_ASSIGN_NUM_COLS).setValues([[
    generateId(),
    taskId,
    userId,
    role,
    now,
  ]]);
}

/**
 * task_histories シートに1行追加する。
 * 呼び出し側で SpreadsheetApp.flush() を忘れずに呼ぶこと。
 *
 * @param {Sheet}  sheet
 * @param {Object} entry - { task_id, changed_by, change_type, from_status, to_status, reason }
 * @param {string} now   - ISO 8601
 */
function _appendTaskHistory(sheet, entry, now) {
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, TASK_HISTORY_NUM_COLS).setValues([[
    generateId(),                 // A: id
    entry.task_id     || '',      // B: task_id
    entry.changed_by  || '',      // C: changed_by
    entry.change_type || '',      // D: change_type
    entry.from_status || '',      // E: from_status
    entry.to_status   || '',      // F: to_status
    entry.reason      || '',      // G: reason
    now,                          // H: created_at
  ]]);
}
