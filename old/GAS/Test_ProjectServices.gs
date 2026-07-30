/**
 * 動作確認スクリプト（GASエディタ上で手動実行する）
 *
 * ▼ 使い方
 *   1. GASエディタでこのファイルを新規作成（ファイル名: Test_ProjectServices.gs）
 *   2. 各関数を選択してから「実行」ボタンを押す
 *   3. 「実行ログ」で OK / FAIL を確認する
 *   4. 全テスト通過後、このファイルは削除してよい
 *
 * ▼ 実行順序
 *   Step 1: test_01_シート作成確認
 *   Step 2: test_02_フェーズテンプレート
 *   Step 3: test_03_顧客
 *   Step 4: test_04_案件
 *   Step 5: test_05_タスク
 *   Step 6: test_06_作業メモ
 *   Step 7: test_07_相談スレッド
 *   Step 8: test_08_通知
 *   Step 9: test_09_ダッシュボード
 *   Step10: test_10_権限チェック
 *   Step11: test_99_クリーンアップ（最後に必ず実行）
 *
 * ▼ ログの見方
 *   [OK]  ... 正常
 *   [FAIL]... 異常（メッセージを確認して修正する）
 *   [ERR] ... 予期しないエラー（スタックトレースを確認する）
 */

// ============================================================
// テスト用ユーティリティ
// ============================================================

/**
 * テスト結果をログに出力する。
 * @param {string} label - テスト名
 * @param {boolean} cond - 期待値と一致すれば true
 * @param {string} [detail] - 補足情報
 */
function _assert(label, cond, detail) {
  if (cond) {
    Logger.log('[OK]  ' + label + (detail ? ' | ' + detail : ''));
  } else {
    Logger.log('[FAIL] ' + label + (detail ? ' | ' + detail : ''));
  }
}

/**
 * テスト共通: 職員ID（Lv2）と利用者ID（Lv1）を取得する。
 * 人員マスタの1件目を職員、それ以外の最初の利用者をスタッフとして使う。
 *
 * @returns {{ staffId: string, operatorId: string }}
 */
function _getTestIds() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('人員マスタ');
  if (!sheet || sheet.getLastRow() <= 1) {
    Logger.log('[WARN] 人員マスタにデータがありません。テストIDは空文字を使用します。');
    return { staffId: 'TEST_STAFF', operatorId: 'TEST_OPERATOR' };
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 23).getValues();

  // admin_role が '管理者' or '一般職員' or '給与計算担当' の最初の行を operator とする
  var operatorRow = rows.find(function(r) {
    var role = String(r[13] || ''); // N列: 管理権限
    return role === '管理者' || role === '一般職員' || role === '給与計算担当';
  });

  // admin_role が空（スタッフ）の最初の行を staff とする
  var staffRow = rows.find(function(r) {
    return String(r[13] || '') === '';
  });

  return {
    operatorId: operatorRow ? String(operatorRow[0]) : 'TEST_OPERATOR',
    staffId   : staffRow    ? String(staffRow[0])    : 'TEST_STAFF',
  };
}

// テスト間でIDを共有するためのグローバル変数
var _TEST = {
  customerId  : '',
  projectId   : '',
  taskId      : '',
  templateId  : '',
  memoId      : '',
  consultId   : '',
  notifId     : '',
};

// ============================================================
// Step 1: シート作成確認
// ============================================================

/**
 * 新シートが自動作成されていることを確認する。
 *
 * 確認内容:
 *   - 7つの新シートが存在する
 *   - 各シートにヘッダー行がある
 *
 * 期待結果: 全項目 [OK]
 */
function test_01_シート作成確認() {
  Logger.log('=== Step 1: シート作成確認 ===');

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // getOrCreateSheet を呼ぶことでシートが存在しなければ作成される
  var sheetDefs = [
    { key: 'CUSTOMERS',       name: '顧客マスタ',         cols: 9  },
    { key: 'PROJECTS',        name: '案件',               cols: 16 },
    { key: 'PROJECT_TASKS',   name: 'プロジェクトタスク', cols: 24 },
    { key: 'WORK_MEMOS',      name: '作業メモ',           cols: 11 },
    { key: 'CONSULTATIONS',   name: '相談スレッド',       cols: 7  },
    { key: 'NOTIFICATIONS',   name: '通知',               cols: 9  },
    { key: 'PHASE_TEMPLATES', name: 'フェーズテンプレート', cols: 5 },
  ];

  sheetDefs.forEach(function(def) {
    try {
      // getOrCreateSheet でシートを取得（なければ作成される）
      var sheet = getOrCreateSheet(ss, def.name);
      _assert(def.name + ' シートが存在する', !!sheet, 'シート名: ' + def.name);

      // ヘッダー行を確認する
      var lastCol = sheet.getLastColumn();
      _assert(
        def.name + ' ヘッダー列数が正しい',
        lastCol >= def.cols,
        '期待: ' + def.cols + '列以上, 実際: ' + lastCol + '列'
      );

    } catch (e) {
      Logger.log('[ERR] ' + def.name + ': ' + e.message);
    }
  });

  Logger.log('--- Step 1 完了 ---\n');
}

// ============================================================
// Step 2: フェーズテンプレート
// ============================================================

/**
 * フェーズテンプレートの作成・取得・更新を確認する。
 *
 * 確認内容:
 *   - テンプレートを作成できる
 *   - 作成したテンプレートを取得できる
 *   - テンプレートを更新できる
 *
 * 期待結果: 全項目 [OK]
 */
function test_02_フェーズテンプレート() {
  Logger.log('=== Step 2: フェーズテンプレート ===');
  var ids = _getTestIds();

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 作成
    var createResult = upsertPhaseTemplate(ss, ss.getSheetByName('人員マスタ'), {
      operator_id: ids.operatorId,
      name       : '[TEST] 動画編集',
      phases     : ['素材確認', 'カット編集', '字幕', 'BGM', 'サムネイル', '書き出し', '納品'],
    });
    _assert('テンプレート作成', createResult.saved === true, 'id=' + createResult.id);
    _TEST.templateId = createResult.id;

    // 取得して確認
    var getResult = getPhaseTemplates(ss);
    var found = getResult.templates.find(function(t) { return t.id === _TEST.templateId; });
    _assert('テンプレート取得', !!found, 'name=' + (found ? found.name : '見つからない'));
    _assert('フェーズ配列が正しい', Array.isArray(found && found.phases) && found.phases.length === 7,
      '件数=' + (found ? found.phases.length : 0));

    // 更新
    var updateResult = upsertPhaseTemplate(ss, ss.getSheetByName('人員マスタ'), {
      operator_id : ids.operatorId,
      template_id : _TEST.templateId,
      name        : '[TEST] 動画編集（更新済み）',
      phases      : ['素材確認', 'カット編集', '字幕', 'BGM', 'SE', 'サムネイル', '書き出し', '納品'],
    });
    _assert('テンプレート更新', updateResult.saved === true);

    var getResult2 = getPhaseTemplates(ss);
    var updated = getResult2.templates.find(function(t) { return t.id === _TEST.templateId; });
    _assert('更新後フェーズ数が正しい', updated && updated.phases.length === 8,
      '件数=' + (updated ? updated.phases.length : 0));

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 2 完了 ---\n');
}

// ============================================================
// Step 3: 顧客マスタ
// ============================================================

/**
 * 顧客の作成・取得・更新を確認する。
 *
 * 確認内容:
 *   - 顧客を作成するとC001形式のIDが返る
 *   - 顧客名でキーワード検索できる
 *   - 顧客情報を更新できる
 *
 * 期待結果: 全項目 [OK]
 */
function test_03_顧客() {
  Logger.log('=== Step 3: 顧客マスタ ===');
  var ids = _getTestIds();

  try {
    var ss         = SpreadsheetApp.getActiveSpreadsheet();
    var empSheet   = ss.getSheetByName('人員マスタ');

    // 作成
    var createResult = upsertCustomer(ss, empSheet, {
      operator_id: ids.operatorId,
      name       : '[TEST] テスト株式会社',
      contact    : '田中 太郎',
      phone      : '0120-000-000',
      email      : 'test@example.com',
      notes      : 'テスト用顧客データ',
    });
    _assert('顧客作成', createResult.saved === true, 'id=' + createResult.id);
    _assert('IDがC形式', /^C\d{3}$/.test(createResult.id), createResult.id);
    _TEST.customerId = createResult.id;

    // 取得
    var getResult = getCustomers(ss, {});
    var found = getResult.customers.find(function(c) { return c.id === _TEST.customerId; });
    _assert('顧客取得（全件）', !!found, 'id=' + _TEST.customerId);

    // キーワード検索
    var searchResult = getCustomers(ss, { keyword: 'テスト' });
    var foundByKw = searchResult.customers.find(function(c) { return c.id === _TEST.customerId; });
    _assert('顧客キーワード検索', !!foundByKw);

    // 更新
    var updateResult = upsertCustomer(ss, empSheet, {
      operator_id : ids.operatorId,
      customer_id : _TEST.customerId,
      name        : '[TEST] テスト株式会社（更新済み）',
      contact     : '佐藤 花子',
    });
    _assert('顧客更新', updateResult.saved === true);

    var getResult2 = getCustomers(ss, {});
    var updated = getResult2.customers.find(function(c) { return c.id === _TEST.customerId; });
    _assert('更新後の名前が正しい', updated && updated.name === '[TEST] テスト株式会社（更新済み）',
      updated ? updated.name : '見つからない');

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 3 完了 ---\n');
}

// ============================================================
// Step 4: 案件
// ============================================================

/**
 * 案件の作成・ステータス変更・フィルタを確認する。
 *
 * 確認内容:
 *   - 社外案件を作成するとP001形式のIDが返る
 *   - デフォルトステータスが「引合い」になる
 *   - ステータスを「見積中」に変更できる
 *   - 社内案件のステータスに「引合い」は無効
 *
 * 期待結果: 全項目 [OK]
 */
function test_04_案件() {
  Logger.log('=== Step 4: 案件 ===');
  var ids = _getTestIds();

  try {
    var ss       = SpreadsheetApp.getActiveSpreadsheet();
    var empSheet = ss.getSheetByName('人員マスタ');

    // 社外案件を作成する
    var createResult = upsertProject(ss, empSheet, {
      operator_id : ids.operatorId,
      customer_id : _TEST.customerId,
      legacy_code : 'T999',
      name        : '[TEST] テスト案件（社外）',
      division    : '社外',
      category    : '動画',
      due_date    : '2026-12-31',
      notes       : 'テスト用案件データ',
    });
    _assert('案件作成（社外）', createResult.saved === true, 'id=' + createResult.id);
    _assert('IDがP形式', /^P\d{3}$/.test(createResult.id), createResult.id);
    _TEST.projectId = createResult.id;

    // 取得してデフォルトステータスを確認する
    var getResult = getProjects(ss, {});
    var found = getResult.projects.find(function(p) { return p.id === _TEST.projectId; });
    _assert('案件取得', !!found);
    _assert('デフォルトステータスが「引合い」', found && found.status === '引合い',
      found ? found.status : '見つからない');

    // ステータスを「見積中」に変更する
    var updateResult = updateProjectStatus(ss, empSheet, {
      operator_id: ids.operatorId,
      project_id : _TEST.projectId,
      status     : '見積中',
    });
    _assert('案件ステータス変更（引合い→見積中）', updateResult.updated === true);

    var getResult2 = getProjects(ss, {});
    var updated = getResult2.projects.find(function(p) { return p.id === _TEST.projectId; });
    _assert('ステータスが「見積中」になった', updated && updated.status === '見積中',
      updated ? updated.status : '見つからない');

    // 社内案件に「引合い」は無効（エラーになることを確認）
    var createInternalResult = upsertProject(ss, empSheet, {
      operator_id: ids.operatorId,
      name       : '[TEST] テスト案件（社内）',
      division   : '社内',
      category   : 'HP',
    });
    var internalId = createInternalResult.id;
    var caught = false;
    try {
      updateProjectStatus(ss, empSheet, {
        operator_id: ids.operatorId,
        project_id : internalId,
        status     : '引合い', // 社内案件に無効なステータス
      });
    } catch (e) {
      caught = true;
    }
    _assert('社内案件に「引合い」はエラー', caught);

    // 社内案件のIDは後で使わないので削除しておく
    deleteProject(ss, empSheet, { operator_id: ids.operatorId, project_id: internalId });

    // 案件区分フィルタ
    var filtered = getProjects(ss, { division: '社外' });
    var onlySocial = filtered.projects.every(function(p) { return p.division === '社外'; });
    _assert('案件区分フィルタ（社外）', onlySocial);

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 4 完了 ---\n');
}

// ============================================================
// Step 5: タスク
// ============================================================

/**
 * タスクの作成・ステータス変更・フェーズ更新を確認する。
 *
 * 確認内容:
 *   - タスクを作成するとP00101形式のIDが返る
 *   - デフォルトステータスが「未着手」
 *   - 担当者への「new_task」通知が生成される
 *   - ステータスを「作業中」→「確認待ち」に変更できる
 *   - 「確認待ち」時に依頼者へ通知が生成される
 *   - フェーズを更新すると作業メモに自動ログが残る
 *
 * 期待結果: 全項目 [OK]
 */
function test_05_タスク() {
  Logger.log('=== Step 5: タスク ===');
  var ids = _getTestIds();

  try {
    var ss       = SpreadsheetApp.getActiveSpreadsheet();
    var empSheet = ss.getSheetByName('人員マスタ');

    // タスク作成
    var createResult = upsertProjectTask(ss, empSheet, {
      operator_id      : ids.operatorId,
      project_id       : _TEST.projectId,
      legacy_task_code : 'T99901',
      title            : '[TEST] テストタスク',
      work_content     : 'カット編集・字幕入れ',
      assignee_id      : ids.staffId,
      assignee_name    : 'テストスタッフ',
      requester_id     : ids.operatorId,
      priority         : '高',
      due_date         : '2026-12-20',
      scheduled_hours  : 3,
      instruction      : 'カット編集を完了させてください',
    });
    _assert('タスク作成', createResult.saved === true, 'id=' + createResult.id);
    _assert('IDがP形式タスクコード', createResult.id.startsWith('P'), createResult.id);
    _TEST.taskId = createResult.id;

    // 取得してデフォルトステータスを確認する
    var getResult = getProjectTasks(ss, { project_id: _TEST.projectId });
    var found = getResult.tasks.find(function(t) { return t.id === _TEST.taskId; });
    _assert('タスク取得', !!found);
    _assert('デフォルトステータスが「未着手」', found && found.status === '未着手',
      found ? found.status : '見つからない');

    // タスク割り当て通知が生成されたか確認する
    var notifResult = getNotifications(ss, { recipient_id: ids.staffId });
    var newTaskNotif = notifResult.notifications.find(function(n) {
      return n.type === 'new_task' && n.task_id === _TEST.taskId;
    });
    _assert('new_task 通知が生成された', !!newTaskNotif);

    // ステータス: 未着手 → 作業中
    updateTaskStatus(ss, empSheet, {
      operator_id: ids.operatorId,
      task_id    : _TEST.taskId,
      status     : '作業中',
    });
    var get2 = getProjectTasks(ss, { project_id: _TEST.projectId });
    var t2   = get2.tasks.find(function(t) { return t.id === _TEST.taskId; });
    _assert('ステータス「作業中」に変更', t2 && t2.status === '作業中', t2 ? t2.status : '?');

    // ステータス: 作業中 → 確認待ち
    updateTaskStatus(ss, empSheet, {
      operator_id: ids.operatorId,
      task_id    : _TEST.taskId,
      status     : '確認待ち',
    });

    // 確認待ち通知（依頼者宛）が生成されたか確認する
    var notif2 = getNotifications(ss, { recipient_id: ids.operatorId });
    var reviewNotif = notif2.notifications.find(function(n) {
      return n.type === 'review_request' && n.task_id === _TEST.taskId;
    });
    _assert('review_request 通知が生成された', !!reviewNotif);

    // フェーズ更新
    updateTaskPhase(ss, empSheet, {
      operator_id  : ids.operatorId,
      task_id      : _TEST.taskId,
      current_phase: '字幕',
    });
    var get3 = getProjectTasks(ss, { project_id: _TEST.projectId, include_done: true });
    var t3   = get3.tasks.find(function(t) { return t.id === _TEST.taskId; });
    _assert('フェーズが「字幕」に更新された', t3 && t3.current_phase === '字幕',
      t3 ? t3.current_phase : '?');

    // フェーズ変更の自動メモが作業メモシートに追記されたか確認する
    var memoResult = getWorkMemos(ss, { task_id: _TEST.taskId });
    var autoLog = memoResult.memos.find(function(m) {
      return m.content.indexOf('[自動] フェーズ変更') !== -1;
    });
    _assert('フェーズ変更の自動ログが作業メモに残った', !!autoLog,
      autoLog ? autoLog.content : '見つからない');

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 5 完了 ---\n');
}

// ============================================================
// Step 6: 作業メモ
// ============================================================

/**
 * 作業メモの手動投稿・取得を確認する。
 *
 * 確認内容:
 *   - 作業メモを投稿できる
 *   - タスクIDで絞り込み取得できる
 *   - 実績工数が数値として保存される
 *
 * 期待結果: 全項目 [OK]
 */
function test_06_作業メモ() {
  Logger.log('=== Step 6: 作業メモ ===');
  var ids = _getTestIds();

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 作業メモを投稿する
    var addResult = addWorkMemo(ss, {
      task_id     : _TEST.taskId,
      author_id   : ids.staffId,
      author_name : 'テストスタッフ',
      work_date   : '2026-06-15',
      phase       : '字幕',
      content     : '字幕作業 3:24〜3:40 の演出確認中',
      progress    : '70%完了',
      actual_hours: 1.5,
      memo        : '次はBGM作業',
    });
    _assert('作業メモ投稿', addResult.saved === true, 'id=' + addResult.id);
    _TEST.memoId = addResult.id;

    // 取得して確認する
    var getResult = getWorkMemos(ss, { task_id: _TEST.taskId });
    var found = getResult.memos.find(function(m) { return m.id === _TEST.memoId; });
    _assert('作業メモ取得', !!found);
    _assert('実績工数が正しい', found && found.actual_hours === 1.5,
      found ? found.actual_hours : '?');
    _assert('作業内容が正しい', found && found.content === '字幕作業 3:24〜3:40 の演出確認中');

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 6 完了 ---\n');
}

// ============================================================
// Step 7: 相談スレッド
// ============================================================

/**
 * 相談スレッドの投稿・取得・返信を確認する。
 *
 * 【修正】各 Step を個別実行すると _TEST.taskId がリセットされる。
 * そのため Step 7 は task_id を手動で指定して実行できるよう修正した。
 *
 * 実行方法:
 *   A) Step 5 と同じ実行セッションで連続実行する場合 → taskId 引数不要
 *   B) 個別実行する場合 → 下記 TASK_ID_FOR_STEP7 に Step 5 で返った ID を貼る
 *
 * 確認内容:
 *   - 相談を投稿できる
 *   - 相談投稿時に依頼者へ通知が生成される
 *   - 返信投稿（parent_id 指定）ができる
 *
 * 期待結果: 全項目 [OK]
 */
function test_07_相談スレッド() {
  Logger.log('=== Step 7: 相談スレッド ===');

  // ▼▼▼ Step 5 を個別実行した場合はここに task_id を貼り付ける ▼▼▼
  var TASK_ID_FOR_STEP7 = '5c077c1c-f578-4a5a-99f3-7a4a6d3018d0';
  // ▲▲▲ 次回テスト時は Step 5 のログから最新の task_id に更新する ▲▲▲

  // _TEST.taskId が引き継がれていれば優先、なければ上記の固定値を使う
  var taskId = _TEST.taskId || TASK_ID_FOR_STEP7;

  if (!taskId) {
    Logger.log('[SKIP] task_id が未設定です。TASK_ID_FOR_STEP7 に Step5 の task_id を設定してください。');
    Logger.log('--- Step 7 スキップ ---\n');
    return;
  }

  Logger.log('[INFO] 使用する task_id: ' + taskId);
  var ids = _getTestIds();

  try {
    var ss       = SpreadsheetApp.getActiveSpreadsheet();
    var empSheet = ss.getSheetByName('人員マスタ');

    // 最初の相談を投稿する
    var postResult = postConsultation(ss, empSheet, {
      task_id    : taskId,
      author_id  : ids.staffId,
      author_name: 'テストスタッフ',
      content    : '3:24〜3:40 の演出はどうすればよいですか？',
    });
    _assert('相談投稿', postResult.saved === true, 'id=' + postResult.id);
    _TEST.consultId = postResult.id;

    // 取得して確認する
    var getResult = getConsultations(ss, { task_id: taskId });
    var found = getResult.consultations.find(function(c) { return c.id === _TEST.consultId; });
    _assert('相談取得', !!found);
    _assert('投稿内容が正しい', found && found.content.indexOf('3:24') !== -1);

    // 相談への通知（依頼者宛）が生成されたか確認する
    var notifResult = getNotifications(ss, { recipient_id: ids.operatorId });
    var consultNotif = notifResult.notifications.find(function(n) {
      return n.type === 'consultation' && n.task_id === taskId;
    });
    _assert('consultation 通知が生成された', !!consultNotif);

    // 返信を投稿する（parent_id を指定）
    var replyResult = postConsultation(ss, empSheet, {
      task_id    : taskId,
      parent_id  : _TEST.consultId,
      author_id  : ids.operatorId,
      author_name: 'テスト職員',
      content    : 'フェードアウトで対応してください。',
    });
    _assert('返信投稿', replyResult.saved === true);

    // スレッドの件数確認（起点1 + 返信1 = 2件以上）
    var getResult2 = getConsultations(ss, { task_id: taskId });
    _assert('スレッド件数が2件以上', getResult2.count >= 2, '件数=' + getResult2.count);

    // 返信の parent_id が正しく設定されているか確認する
    var reply = getResult2.consultations.find(function(c) { return c.id === replyResult.id; });
    _assert('返信の parent_id が正しい', reply && reply.parent_id === _TEST.consultId,
      reply ? reply.parent_id : '?');

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 7 完了 ---\n');
}

// ============================================================
// Step 8: 通知
// ============================================================

/**
 * 通知の既読処理を確認する。
 *
 * 【修正】前回実行で全通知が既読済みになるため、
 * テスト冒頭で通知を3件自前生成してから検証する。
 * これにより他のStepの実行順序・状態に依存しない独立したテストになる。
 *
 * 確認内容:
 *   - テスト用通知3件を生成できる
 *   - 未読通知の件数が正しく取得できる（3件以上）
 *   - 1件を個別既読にすると未読数が1減る
 *   - 全件一括既読にすると未読数が0になる
 *
 * 期待結果: 全項目 [OK]
 */
function test_08_通知() {
  Logger.log('=== Step 8: 通知 ===');
  var ids = _getTestIds();

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── 前提: テスト用通知を3件生成する ────────────────────────
    // 他のStepの実行状態に依存せず、このStep単体で完結させるために
    // 必要な通知データをここで作る。
    Logger.log('[INFO] テスト用通知を3件生成します');
    createNotification(ss, {
      recipient_id: ids.staffId,
      type        : NOTIF_TYPE.NEW_TASK,
      title       : '[TEST] 通知テスト1',
      body        : 'テスト用通知1件目',
      task_id     : '',
      project_id  : '',
    });
    createNotification(ss, {
      recipient_id: ids.staffId,
      type        : NOTIF_TYPE.INSTRUCTION,
      title       : '[TEST] 通知テスト2',
      body        : 'テスト用通知2件目',
      task_id     : '',
      project_id  : '',
    });
    createNotification(ss, {
      recipient_id: ids.staffId,
      type        : NOTIF_TYPE.REVIEW_REQUEST,
      title       : '[TEST] 通知テスト3',
      body        : 'テスト用通知3件目',
      task_id     : '',
      project_id  : '',
    });

    // ── 1. 未読通知の件数を確認する ─────────────────────────────
    var unread = getNotifications(ss, { recipient_id: ids.staffId, unread_only: true });
    _assert('未読通知が3件以上ある', unread.unread_count >= 3, '未読数=' + unread.unread_count);

    var beforeCount = unread.unread_count;

    // ── 2. 1件を個別既読にする ───────────────────────────────────
    // 未読通知が存在する場合のみ実行する（前ステップで0件の場合のガード）
    if (unread.notifications.length > 0) {
      var targetId = unread.notifications[0].id;

      var markResult = markNotificationRead(ss, {
        notification_id: targetId,
        recipient_id   : ids.staffId,
      });
      _assert('個別既読: 成功', markResult.updated === true, 'id=' + targetId);

      var afterMark = getNotifications(ss, { recipient_id: ids.staffId, unread_only: true });
      _assert(
        '個別既読後: 未読数が1減った',
        afterMark.unread_count === beforeCount - 1,
        '前=' + beforeCount + ' 後=' + afterMark.unread_count
      );
    } else {
      Logger.log('[SKIP] 未読通知がないため個別既読テストをスキップ');
    }

    // ── 3. 全件一括既読にする ────────────────────────────────────
    var allRead = markAllNotificationsRead(ss, { recipient_id: ids.staffId });
    _assert('全件一括既読: 更新件数が1以上', allRead.updated >= 1, '更新件数=' + allRead.updated);

    var afterAllRead = getNotifications(ss, { recipient_id: ids.staffId, unread_only: true });
    _assert(
      '全件一括既読後: 未読数が0',
      afterAllRead.unread_count === 0,
      '未読数=' + afterAllRead.unread_count
    );

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 8 完了 ---\n');
}

// ============================================================
// Step 9: ダッシュボード
// ============================================================

/**
 * ダッシュボードデータの取得を確認する。
 *
 * 確認内容:
 *   - summary が正しい構造で返る
 *   - staff_status が配列で返る
 *   - project_alerts が正しい構造で返る
 *
 * 期待結果: 全項目 [OK]
 */
function test_09_ダッシュボード() {
  Logger.log('=== Step 9: ダッシュボード ===');
  var ids = _getTestIds();

  try {
    var ss            = SpreadsheetApp.getActiveSpreadsheet();
    var empSheet      = ss.getSheetByName('人員マスタ');
    var attendSheet   = ss.getSheetByName('出退勤記録');

    var result = getProjectDashboard(ss, attendSheet, empSheet, {
      operator_id: ids.operatorId,
      date       : '2026-06-15',
    });

    // summary の構造を確認する
    _assert('summary が存在する', !!result.summary);
    _assert('today_attendance が数値', typeof result.summary.today_attendance === 'number',
      '値=' + result.summary.today_attendance);
    _assert('task_in_progress が数値', typeof result.summary.task_in_progress === 'number',
      '値=' + result.summary.task_in_progress);
    _assert('task_review_waiting が数値', typeof result.summary.task_review_waiting === 'number',
      '値=' + result.summary.task_review_waiting);

    // staff_status の構造を確認する
    _assert('staff_status が配列', Array.isArray(result.staff_status));
    if (result.staff_status.length > 0) {
      var s = result.staff_status[0];
      _assert('スタッフに id がある', !!s.id);
      _assert('スタッフに name がある', !!s.name);
      _assert('current_tasks が配列', Array.isArray(s.current_tasks));
    }

    // project_alerts の構造を確認する
    _assert('project_alerts が存在する', !!result.project_alerts);
    _assert('overdue が配列', Array.isArray(result.project_alerts.overdue));
    _assert('due_soon が配列', Array.isArray(result.project_alerts.due_soon));
    _assert('review_waiting が配列', Array.isArray(result.project_alerts.review_waiting));

    // 作業中タスクが確認待ちになっているので task_review_waiting >= 1 のはず
    _assert('確認待ちタスクが1件以上', result.summary.task_review_waiting >= 1,
      '件数=' + result.summary.task_review_waiting);

  } catch (e) {
    Logger.log('[ERR] ' + e.message + '\n' + e.stack);
  }

  Logger.log('--- Step 9 完了 ---\n');
}

// ============================================================
// Step 10: 権限チェック
// ============================================================

/**
 * 権限不足時にエラーが発生することを確認する。
 *
 * 確認内容:
 *   - Lv1（スタッフ）は案件を作成できない
 *   - Lv1は他人のタスクのステータスを変更できない
 *   - Lv1は「修正依頼」ステータスを設定できない
 *   - 無効な案件ステータス値はエラーになる
 *   - 無効なタスクステータス値はエラーになる
 *
 * 期待結果: 全項目 [OK]
 */
function test_10_権限チェック() {
  Logger.log('=== Step 10: 権限チェック ===');
  var ids = _getTestIds();

  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var empSheet = ss.getSheetByName('人員マスタ');

  // ① Lv1はプロジェクト作成不可
  var caught1 = false;
  try {
    upsertProject(ss, empSheet, {
      operator_id: ids.staffId, // Lv1
      name       : '不正テスト',
      division   : '社内',
    });
  } catch (e) { caught1 = true; }
  _assert('Lv1 は案件を作成できない', caught1);

  // ② Lv1は他人のタスクのステータス変更不可
  var caught2 = false;
  try {
    // staffId と別の operatorId が担当のタスクを staffId が変更しようとする
    // （テスト用タスクの担当者は staffId なので operatorId が変更しようとする場合）
    // ここでは「他の人のタスク」として operatorId を担当にしたタスクを
    // staffId が変更しようとするシナリオを再現する
    var dummyTaskResult = upsertProjectTask(ss, empSheet, {
      operator_id : ids.operatorId,
      project_id  : _TEST.projectId,
      title       : '[TEST] 権限テスト用タスク',
      assignee_id : ids.operatorId,  // 担当者は operatorId
      requester_id: ids.operatorId,
    });
    updateTaskStatus(ss, empSheet, {
      operator_id: ids.staffId,     // Lv1スタッフが
      task_id    : dummyTaskResult.id,
      status     : '作業中',        // 他人担当タスクを変更しようとする
    });
    // 後始末
    deleteProjectTask(ss, empSheet, { operator_id: ids.operatorId, task_id: dummyTaskResult.id });
  } catch (e) {
    caught2 = true;
    // 後始末（エラー時も削除を試みる）
    try {
      var tmpSheet = getOrCreateSheet(ss, SHEET.PROJECT_TASKS);
      var tmpRows  = getAllRows(tmpSheet);
      var tmpIdx   = tmpRows.findIndex(function(r) {
        return r[PTASK_COL.TITLE - 1] === '[TEST] 権限テスト用タスク';
      });
      if (tmpIdx !== -1) tmpSheet.getRange(tmpIdx + 2, PTASK_COL.DELETED).setValue('true');
    } catch (_) {}
  }
  _assert('Lv1 は他人のタスクを変更できない', caught2);

  // ③ Lv1は「修正依頼」を設定できない（自分担当タスクでも）
  var caught3 = false;
  try {
    updateTaskStatus(ss, empSheet, {
      operator_id: ids.staffId,
      task_id    : _TEST.taskId,   // 自分担当のタスク
      status     : '修正依頼',     // Lv1には設定不可
    });
  } catch (e) { caught3 = true; }
  _assert('Lv1 は「修正依頼」を設定できない', caught3);

  // ④ 無効な案件ステータスはエラー
  var caught4 = false;
  try {
    updateProjectStatus(ss, empSheet, {
      operator_id: ids.operatorId,
      project_id : _TEST.projectId,
      status     : '作業中', // タスクステータスの値を案件に使おうとしている
    });
  } catch (e) { caught4 = true; }
  _assert('タスクステータス値を案件に使うとエラー', caught4);

  // ⑤ 無効なタスクステータスはエラー
  var caught5 = false;
  try {
    updateTaskStatus(ss, empSheet, {
      operator_id: ids.operatorId,
      task_id    : _TEST.taskId,
      status     : '制作中', // 案件ステータスの値をタスクに使おうとしている
    });
  } catch (e) { caught5 = true; }
  _assert('案件ステータス値をタスクに使うとエラー', caught5);

  Logger.log('--- Step 10 完了 ---\n');
}

// ============================================================
// Step 99: クリーンアップ（最後に必ず実行）
// ============================================================

/**
 * テストで作成したデータをすべて削除する。
 *
 * 実行タイミング: 全テスト完了後に必ず実行すること。
 * 本番データへの影響を防ぐため、テスト中に作成したレコードを
 * 論理削除または物理削除する。
 *
 * 削除対象:
 *   - フェーズテンプレート（[TEST]で始まる名前）
 *   - 顧客（[TEST]で始まる名前）
 *   - 案件（[TEST]で始まる名前）
 *   - タスク（[TEST]で始まるタイトル）
 *   - 作業メモ・相談スレッド・通知（上記タスクIDに紐づくもの）
 */
function test_99_クリーンアップ() {
  Logger.log('=== Step 99: クリーンアップ ===');

  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var empSheet = ss.getSheetByName('人員マスタ');
  var ids      = _getTestIds();

  try {
    // フェーズテンプレートを削除する
    if (_TEST.templateId) {
      deletePhaseTemplate(ss, empSheet, {
        operator_id: ids.operatorId,
        template_id: _TEST.templateId,
      });
      Logger.log('[OK] フェーズテンプレートを削除: ' + _TEST.templateId);
    }

    // タスクを論理削除する
    if (_TEST.taskId) {
      deleteProjectTask(ss, empSheet, {
        operator_id: ids.operatorId,
        task_id    : _TEST.taskId,
      });
      Logger.log('[OK] タスクを削除: ' + _TEST.taskId);
    }

    // 案件を論理削除する
    if (_TEST.projectId) {
      deleteProject(ss, empSheet, {
        operator_id: ids.operatorId,
        project_id : _TEST.projectId,
      });
      Logger.log('[OK] 案件を削除: ' + _TEST.projectId);
    }

    // 顧客を論理削除する
    if (_TEST.customerId) {
      deleteCustomer(ss, empSheet, {
        operator_id : ids.operatorId,
        customer_id : _TEST.customerId,
      });
      Logger.log('[OK] 顧客を削除: ' + _TEST.customerId);
    }

    // [TEST] 名がついたフェーズテンプレートを一括削除する（複数残っている場合）
    var tplSheet = getOrCreateSheet(ss, SHEET.PHASE_TEMPLATES);
    var tplRows  = getAllRows(tplSheet);
    tplRows.forEach(function(r, i) {
      if (String(r[PHASE_TPL_COL.NAME - 1]).indexOf('[TEST]') !== -1) {
        tplSheet.deleteRow(i + 2);
        Logger.log('[OK] 残存テンプレートを削除: ' + r[PHASE_TPL_COL.NAME - 1]);
      }
    });

    Logger.log('[OK] クリーンアップ完了');
  } catch (e) {
    Logger.log('[ERR] クリーンアップ中にエラー: ' + e.message);
  }

  Logger.log('--- Step 99 完了 ---\n');
  Logger.log('==============================');
  Logger.log('全テスト完了。ログを確認してください。');
  Logger.log('[OK] が全項目に表示されれば正常です。');
  Logger.log('[FAIL] または [ERR] があれば要確認です。');
  Logger.log('==============================');
}
