/**
 * test.gs - テスト関数群
 *
 * 役割:
 *   - GAS エディタ上で手動実行する単体テスト
 *   - シートを汚さない設計（テストデータは自動削除）
 *
 * 実行方法:
 *   GAS エディタ上部「関数を選択」→ 実行したい関数名を選択 → 「▶ 実行」
 *   結果はエディタ下部「実行ログ」パネルに出力される
 *
 * テスト設計の原則:
 *   - テスト用 ID は 'test_' プレフィックスで本番データと区別する
 *   - 各テストは必ずテストデータを削除してシートをクリーンに保つ
 *   - シートが存在しない場合は自動作成して進む
 *   - ASSERT ヘルパーで期待値を明示し、失敗時はログに詳細を出力する
 *   - テスト開始・終了は _printTestBanner で視覚的に明示する
 *
 * @version 1.1.0
 * @author  田中沙亜
 */

// ============================================================
// テスト用定数
// ============================================================

/** テスト用の固定 employee_id（本番データと区別するためプレフィックス付き） */
const TEST_EMPLOYEE_ID = 'test_employee_001';

/** テスト用の固定 employee 名 */
const TEST_EMPLOYEE_NAME = 'テスト 太郎';

/** テスト用の固定日付 */
const TEST_DATE   = '2026-04-01';
const TEST_DATE_2 = '2026-04-02';
const TEST_DATE_3 = '2026-04-15';

/** テスト用の勤怠データ */
const TEST_ATTENDANCE_DATA = {
  status        : '出勤',
  time_in       : '09:00',
  time_out      : '18:00',
  break_minutes : 60,
  work_minutes  : 480,
  lunch         : true,
  reason        : '',
  memo          : 'テストデータ',
};

// ============================================================
// 全テスト一括実行
// ============================================================

/**
 * すべてのテストを順番に実行する。
 * 個別テストが失敗しても次のテストを継続する。
 */

/**
 * テスト開始バナーをログに出力する。
 *
 * @param {string} testName
 * @param {string} [label='TEST']
 */
function _printTestBanner(testName, label) {
  const tag  = label || 'TEST';
  const line = '═'.repeat(50);
  Logger.log('');
  Logger.log('╔' + line + '╗');
  Logger.log('║  🧪 %s: %s', tag, testName);
  Logger.log('╚' + line + '╝');
}

function testAll() {
  _printTestBanner('testAll', 'SUITE');
  Logger.log('全テストを順番に実行します。');

  const tests = [
    testSaveEmployee,
    testSaveAttendanceRecord,
    testLoadAttendanceRange,
    testLoadDailyAttendance,
    testGenerateMonthlyReport,
  ];

  let passed = 0;
  let failed = 0;

  tests.forEach(testFn => {
    try {
      testFn();
      passed++;
    } catch (err) {
      Logger.log('[testAll] FAILED: %s → %s', testFn.name, err.message);
      failed++;
    }
  });

  Logger.log('');
  Logger.log('╔══════════════════════════════════════════╗');
  Logger.log('║  テスト結果: %d passed / %d failed          ║', passed, failed);
  Logger.log('╚══════════════════════════════════════════╝');
}

// ============================================================
// 個別テスト
// ============================================================

/**
 * 人員の新規登録・更新・削除をテストする。
 * テスト終了後、職員の固定テストデータを1件だけマスタに残す。
 * （打刻テストや月次集計テストで職員データが必要なため）
 */
function testSaveEmployee() {
  _printTestBanner('testSaveEmployee');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);

  // ── 1. 新規登録 ──────────────────────────────────────────
  const saveResult = saveEmployee(sheet, {
    name          : TEST_EMPLOYEE_NAME,
    pin           : '9999',
    password      : 'test_pass',
    employee_data : {
      employment_type : '職員',      // 利用者/職員 の区分に合わせる
      scheduled_hours : 8,
      scheduled_start : '09:00',
      scheduled_end   : '17:00',
      scheduled_break : 60,
      wage_type       : '時給',
      hourly_wage     : 1200,
      default_lunch   : true,
      work_days       : ['月', '火', '水', '木', '金'],
      is_admin        : true,        // 職員はデフォルトで管理者
    },
  });

  ASSERT(saveResult.saved === true,         'saveEmployee: saved が true であること');
  ASSERT(typeof saveResult.id === 'string', 'saveEmployee: id が文字列であること');
  Logger.log('新規登録 OK: id=%s', saveResult.id);

  // ── 2. 更新 ───────────────────────────────────────────────
  const updateResult = saveEmployee(sheet, {
    id            : saveResult.id,
    name          : TEST_EMPLOYEE_NAME + '（更新）',
    pin           : '9999',
    password      : 'test_pass',
    employee_data : { employment_type: '職員' },
  });

  ASSERT(updateResult.saved === true,       'saveEmployee update: saved が true であること');
  ASSERT(updateResult.id === saveResult.id, 'saveEmployee update: id が変わらないこと');
  Logger.log('更新 OK: id=%s', updateResult.id);

  // ── 3. 削除してASSERT ────────────────────────────────────
  deleteEmployee(sheet, saveResult.id);

  const { employees } = loadEmployees(sheet);
  const stillExists   = employees.some(e => e.id === saveResult.id);
  ASSERT(!stillExists, '削除後: 人員が存在しないこと');

Logger.log('削除 OK: id=%s', saveResult.id);

  // ── 4. 職員の固定テストデータを1件だけ残す ────────────────
  // 打刻テスト・月次集計テストで職員データが必要なため、
  // 同名がいない場合のみ登録する（重複防止）。
  const alreadyExists = employees.some(e => e.name === TEST_EMPLOYEE_NAME);
  if (!alreadyExists) {
    saveEmployee(sheet, {
      name          : TEST_EMPLOYEE_NAME,
      pin           : '9999',
      password      : 'test_pass',
      employee_data : {
        employment_type : '職員',
        scheduled_hours : 8,
        scheduled_start : '09:00',
        scheduled_end   : '17:00',
        scheduled_break : 60,
        wage_type       : '時給',
        hourly_wage     : 1200,
        default_lunch   : true,
        work_days       : ['月', '火', '水', '木', '金'],
        is_admin        : true,        // 職員はデフォルトで管理者
      },
    });
    Logger.log('[testSaveEmployee] 職員テストデータを登録しました: name=%s', TEST_EMPLOYEE_NAME);
  } else {
    Logger.log('[testSaveEmployee] 職員テストデータは既に存在します。スキップ: name=%s', TEST_EMPLOYEE_NAME);
  }

  _printTestEnd('testSaveEmployee');
}

/**
 * 出退勤記録の新規保存・上書き・1件取得・削除をテストする。
 */
function testSaveAttendanceRecord() {
  _printTestBanner('testSaveAttendanceRecord');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);

  // 1. 新規保存
  const saveResult = saveAttendanceRecord(sheet, {
    employee_id     : TEST_EMPLOYEE_ID,
    date            : TEST_DATE,
    attendance_data : TEST_ATTENDANCE_DATA,
  });

  ASSERT(saveResult.saved === true,         'saveAttendanceRecord: saved が true であること');
  ASSERT(typeof saveResult.id === 'string', 'saveAttendanceRecord: id が文字列であること');
  Logger.log('新規保存 OK: id=%s', saveResult.id);

  // 2. 同じ employee_id + date で上書き
  const updateResult = saveAttendanceRecord(sheet, {
    employee_id     : TEST_EMPLOYEE_ID,
    date            : TEST_DATE,
    attendance_data : { ...TEST_ATTENDANCE_DATA, status: '遅刻', memo: '上書きテスト' },
  });

  ASSERT(updateResult.id === saveResult.id, 'upsert: id が変わらないこと');
  Logger.log('上書き OK: id=%s', updateResult.id);

  // 3. 取得して内容を確認
  const loadResult = loadAttendanceRecord(sheet, TEST_EMPLOYEE_ID, TEST_DATE);
  ASSERT(loadResult.record !== null,                     'loadAttendanceRecord: record が null でないこと');
  ASSERT(loadResult.record.data.status === '遅刻',      'loadAttendanceRecord: status が反映されていること');
  ASSERT(loadResult.record.data.memo === '上書きテスト', 'loadAttendanceRecord: memo が反映されていること');
  Logger.log('取得 OK: status=%s', loadResult.record.data.status);

  // 4. テストデータ削除
  deleteAttendanceRecord(sheet, saveResult.id);

  const afterDelete = loadAttendanceRecord(sheet, TEST_EMPLOYEE_ID, TEST_DATE);
  ASSERT(afterDelete.record === null, '削除後: record が null であること');
  Logger.log('削除 OK: id=%s', saveResult.id);

  _printTestEnd('testSaveAttendanceRecord');
}

/**
 * 日付範囲指定での取得をテストする。
 */
function testLoadAttendanceRange() {
  _printTestBanner('testLoadAttendanceRange');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);

  // 1. テストデータを3件保存
  const r1 = saveAttendanceRecord(sheet, {
    employee_id     : TEST_EMPLOYEE_ID,
    date            : TEST_DATE,
    attendance_data : { ...TEST_ATTENDANCE_DATA, status: '出勤' },
  });
  const r2 = saveAttendanceRecord(sheet, {
    employee_id     : TEST_EMPLOYEE_ID,
    date            : TEST_DATE_2,
    attendance_data : { ...TEST_ATTENDANCE_DATA, status: '遅刻' },
  });
  const r3 = saveAttendanceRecord(sheet, {
    employee_id     : TEST_EMPLOYEE_ID,
    date            : TEST_DATE_3,
    attendance_data : { ...TEST_ATTENDANCE_DATA, status: '欠勤' },
  });

  Logger.log('テストデータ3件保存 OK');

  // 2. TEST_DATE 〜 TEST_DATE_2 の範囲で取得（2件のみ返るはず）
  const rangeResult = loadAttendanceRange(sheet, TEST_EMPLOYEE_ID, TEST_DATE, TEST_DATE_2);

  ASSERT(rangeResult.count === 2,          'loadAttendanceRange: 2件返ること');
  ASSERT(rangeResult.records.length === 2, 'loadAttendanceRange: records.length が 2 であること');

  const hasOutOfRange = rangeResult.records.some(r => r.date === TEST_DATE_3);
  ASSERT(!hasOutOfRange, 'loadAttendanceRange: 範囲外の日付が含まれないこと');
  Logger.log('範囲取得 OK: count=%d', rangeResult.count);

  // 3. 後ろから順に削除（物理削除時のインデックスずれを回避）
  deleteAttendanceRecord(sheet, r3.id);
  deleteAttendanceRecord(sheet, r2.id);
  deleteAttendanceRecord(sheet, r1.id);
  Logger.log('削除 OK');

  _printTestEnd('testLoadAttendanceRange');
}

/**
 * 特定日の全人員分取得をテストする。
 */
function testLoadDailyAttendance() {
  _printTestBanner('testLoadDailyAttendance');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);

  // 1. 同じ日付で2人分のデータを保存
  const r1 = saveAttendanceRecord(sheet, {
    employee_id     : TEST_EMPLOYEE_ID,
    date            : TEST_DATE,
    attendance_data : { ...TEST_ATTENDANCE_DATA, status: '出勤' },
  });
  const r2 = saveAttendanceRecord(sheet, {
    employee_id     : 'test_employee_002',
    date            : TEST_DATE,
    attendance_data : { ...TEST_ATTENDANCE_DATA, status: '遅刻' },
  });

  Logger.log('テストデータ2件保存 OK');

  // 2. 特定日で全件取得
  const dailyResult = loadDailyAttendance(sheet, TEST_DATE);
  const testRecords = dailyResult.records.filter(
    r => r.employee_id === TEST_EMPLOYEE_ID || r.employee_id === 'test_employee_002'
  );
  ASSERT(testRecords.length === 2, 'loadDailyAttendance: 2件のテストレコードが返ること');
  Logger.log('全人員取得 OK: 総件数=%d', dailyResult.records.length);

  // 3. テストデータを削除
  deleteAttendanceRecord(sheet, r2.id);
  deleteAttendanceRecord(sheet, r1.id);
  Logger.log('削除 OK');

  _printTestEnd('testLoadDailyAttendance');
}

/**
 * 月次集計レポート生成をテストする。
 */
function testGenerateMonthlyReport() {
  _printTestBanner('testGenerateMonthlyReport');

  const ss              = SpreadsheetApp.getActiveSpreadsheet();
  const attendanceSheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  const employeeSheet   = getOrCreateSheet(ss, SHEET.EMPLOYEES);

  // 1. 人員マスタにテスト人員を登録
  const empResult = saveEmployee(employeeSheet, {
    name          : TEST_EMPLOYEE_NAME,
    pin           : '9998',
    password      : 'report_test',
    employee_data : {
  employment_type : '職員',
  scheduled_hours : 8,
  scheduled_start : '09:00',
  scheduled_end   : '18:00',
  break_minutes   : 60,
  hourly_wage     : 0,
  default_lunch   : false,
  work_days       : ['月', '火', '水', '木', '金'],
},
  });
  const testEmpId = empResult.id;

  // 2. 2026-04 のテストデータを4件保存
  const records = [
    { date: '2026-04-01', status: '出勤', work_minutes: 480, lunch: true  },
    { date: '2026-04-02', status: '遅刻', work_minutes: 420, lunch: true  },
    { date: '2026-04-03', status: '欠勤', work_minutes: 0,   lunch: false },
    { date: '2026-04-04', status: '出勤', work_minutes: 480, lunch: true  },
  ];

  const savedIds = records.map(r =>
    saveAttendanceRecord(attendanceSheet, {
      employee_id     : testEmpId,
      date            : r.date,
      attendance_data : {
        status        : r.status,
        time_in       : '09:00',
        time_out      : '18:00',
        break_minutes : 60,
        work_minutes  : r.work_minutes,
        lunch         : r.lunch,
        memo          : 'テスト',
      },
    }).id
  );

  Logger.log('テストデータ4件保存 OK');

  // 3. 月次集計を実行
  const reportResult = generateMonthlyReport(attendanceSheet, employeeSheet, '2026-04');

  ASSERT(reportResult.year_month === '2026-04', 'generateMonthlyReport: year_month が正しいこと');
  ASSERT(Array.isArray(reportResult.report),    'generateMonthlyReport: report が配列であること');

  const summary = reportResult.report.find(r => r.employee_id === testEmpId);
  ASSERT(summary !== undefined,               'generateMonthlyReport: テスト人員のサマリーが存在すること');
  ASSERT(summary.work_days === 3,             'generateMonthlyReport: work_days が 3 であること');
  ASSERT(summary.absent_days === 1,           'generateMonthlyReport: absent_days が 1 であること');
  ASSERT(summary.late_days === 1,             'generateMonthlyReport: late_days が 1 であること');
  ASSERT(summary.lunch_count === 3,           'generateMonthlyReport: lunch_count が 3 であること');
  ASSERT(summary.total_work_minutes === 1380, 'generateMonthlyReport: total が 1380 であること');

  Logger.log(
    '集計 OK: work_days=%d, absent=%d, late=%d, lunch=%d, total_min=%d',
    summary.work_days, summary.absent_days, summary.late_days,
    summary.lunch_count, summary.total_work_minutes
  );

  // 4. テストデータを削除
  savedIds.reverse().forEach(id => deleteAttendanceRecord(attendanceSheet, id));
  deleteEmployee(employeeSheet, testEmpId);
  Logger.log('削除 OK');

  _printTestEnd('testGenerateMonthlyReport');
}

// ============================================================
// テストヘルパー
// ============================================================

/**
 * アサーションヘルパー。
 *
 * @param {boolean} condition
 * @param {string}  message
 */
function ASSERT(condition, message) {
  if (!condition) {
    const errorMsg = '[ASSERT FAILED] ' + message;
    Logger.log(errorMsg);
    throw new Error(errorMsg);
  }
  Logger.log('[ASSERT OK] ' + message);
}


/**
 * テスト正常終了バナーをログに出力する。
 *
 * @param {string} testName
 */
function _printTestEnd(testName) {
  Logger.log('✅ %s 完了', testName);
  Logger.log('');
}

// ============================================================
// 人員セットアップ（本番データ登録用）
// ============================================================

/**
 * 人員マスタに人員を新規登録する。
 *
 * 使い方:
 *   1. 下記の各値を実際の値に変更する
 *   2. GASエディタで setupEmployee を選択して ▶ 実行
 *   3. 人員マスタシートに行が追加されたことを確認する
 */
function setupEmployee() {
  _printTestBanner('setupEmployee', 'SETUP');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);

  // ── ここを変更する ──────────────────────────
  const name           = '山田 太郎';
  const pin            = '1234';
  const password       = 'yamada';
  const employmentType = '職員';    // '職員' | '利用者'（'常勤'は無効値）
  const isAdmin        = true;      // 職員はデフォルトで管理者（不要なら false に）
  const scheduledHours = 8;
  const scheduledStart = '09:00';
  const scheduledEnd   = '17:00';
  const scheduledBreak = 60;
  const wageType       = '時給';   // '時給' | '月給'
  const hourlyWage     = 0;
  const defaultLunch   = true;
  const workDays       = ['月', '火', '水', '木', '金'];
  // ────────────────────────────────────────────

  const result = saveEmployee(sheet, {
    name,
    pin,
    password,
    employee_data: {
      employment_type : employmentType,
      is_admin        : isAdmin,
      scheduled_hours : scheduledHours,
      scheduled_start : scheduledStart,
      scheduled_end   : scheduledEnd,
      scheduled_break : scheduledBreak,
      wage_type       : wageType,
      hourly_wage     : hourlyWage,
      default_lunch   : defaultLunch,
      work_days       : workDays,
    },
  });

  Logger.log('人員登録完了: id=%s, name=%s', result.id, name);
  Logger.log('PIN: %s / パスワード: %s でログインできます', pin, password);

  _printTestEnd('setupEmployee');
}

/**
 * テスト人員データを初期化・上書きする。
 *
 * 目的:
 *   テストデータであることを名前・PIN・パスワードで明示し、
 *   欠損していたフィールドを埋める。
 *
 * 実行方法:
 *   GASエディタで resetTestEmployee を選択して ▶ 実行
 */
/**
 * 人員マスタのテストデータをリセット・作成する
 */
/**
 * 人員マスタのテストデータをリセット・作成する
 */
function resetTestEmployee() {
  _printTestBanner('resetTestEmployee', 'PREPARE');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);

  // 既存データを全削除（ヘッダー行は残す）
  if (sheet.getLastRow() >= 2) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }

  const testEmployees = [
    {
      name     : 'テスト 花子',
      pin      : '1234',
      password : 'hanako',
      employee_data: {
        employment_type : '利用者',
        scheduled_hours : 4,
        scheduled_start : '10:00',
        scheduled_end   : '15:00',
        scheduled_break : 60,
        wage_type       : '時給',
        hourly_wage     : 1150,
        default_lunch   : true,
        work_days       : ['月', '火', '水', '木', '金'],
        is_admin        : false,  // 利用者は管理不可
      },
    },
    {
      name     : 'テスト 太郎',
      pin      : '2345',
      password : 'tarou',
      employee_data: {
        employment_type : '職員',
        scheduled_hours : 4,
        scheduled_start : '10:00',
        scheduled_end   : '15:00',
        scheduled_break : 60,
        wage_type       : '時給',
        hourly_wage     : 1150,
        default_lunch   : false,
        work_days       : ['月', '火', '水', '木', '金'],
        is_admin        : true,   // 職員・管理者
      },
    },
  ];

  testEmployees.forEach(emp => saveEmployee(sheet, emp));

  Logger.log('テストデータ2件を登録しました');
  _printTestEnd('resetTestEmployee');
}

/**
 * 人員マスタの全データをログに出力して確認する（デバッグ用）。
 */
function checkEmployeeData() {
  _printTestBanner('checkEmployeeData', 'DEBUG');

  const ss            = SpreadsheetApp.getActiveSpreadsheet();
  const sheet         = ss.getSheetByName(SHEET.EMPLOYEES);
  const { employees } = loadEmployees(sheet);

  Logger.log('人員マスタ: %d件', employees.length);

  employees.forEach((emp, i) => {
    Logger.log(
      '[%d] id=%s | name=%s | pin=%s | type=%s | is_admin=%s | hours=%s | wage=%s | lunch=%s | days=%s',
      i + 1,
      emp.id,
      emp.name,
      emp.pin,
      emp.employment_type,
      emp.is_admin,          // 管理権限を確認できるようにする
      emp.scheduled_hours,
      emp.hourly_wage,
      emp.default_lunch,
      (emp.work_days || []).join(',')
    );
  });

  _printTestEnd('checkEmployeeData');
}

/**
 * 認証テスト。
 * GASエディタから直接実行して Logger でレスポンスを確認する。
 * PIN・パスワードはスプレッドシートの実際の値に合わせて変更すること。
 */
function testAuthenticate() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, '人員マスタ');

  // ✅ 正常系：管理者（太郎）でログインできるか
  try {
    const result = authenticateEmployee(sheet, '2345', 'tarou');
    Logger.log('[testAuthenticate] 成功: %s', JSON.stringify(result));
  } catch (e) {
    Logger.log('[testAuthenticate] 失敗（想定外）: %s', e.message);
  }

  // ❌ 異常系：管理権限「不可」の利用者（花子）はログイン拒否されるか
  try {
    const result = authenticateEmployee(sheet, '1234', 'hanako');
    Logger.log('[testAuthenticate] 失敗（拒否されるべき）: %s', JSON.stringify(result));
  } catch (e) {
    Logger.log('[testAuthenticate] 正常拒否: %s', e.message);
  }
}

function debugAuthenticate() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, '人員マスタ');
  const rows  = getAllRows(sheet);

  // 全行の生データをそのまま出力する
  rows.forEach((row, i) => {
    Logger.log('行%s: %s', i + 1, JSON.stringify(row));
  });

  // 太郎の行をrowToEmployeeで変換した結果を出力する
  const tarou = rows.find(row => String(row[2]) === '2345');
  if (tarou) {
    Logger.log('太郎の生データ: %s', JSON.stringify(tarou));
    Logger.log('太郎のemployee: %s', JSON.stringify(rowToEmployee(tarou)));
  } else {
    Logger.log('太郎が見つかりません');
  }
}

function debugActions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attendanceSheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  const employeeSheet   = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  
  try {
    const result = getAdminDashboard(attendanceSheet, employeeSheet, '2026-04-21');
    Logger.log('getAdminDashboard OK: %s', JSON.stringify(result));
  } catch(e) {
    Logger.log('getAdminDashboard ERROR: %s', e.message);
  }
  
  try {
    const result = getAdminStaffList(employeeSheet, 'all');
    Logger.log('getAdminStaffList OK: %s', JSON.stringify(result));
  } catch(e) {
    Logger.log('getAdminStaffList ERROR: %s', e.message);
  }
}
// ============================================================
// テストデータ管理（リセット・一括登録）
// ============================================================

/**
 * テストデータを一括削除する。
 *
 * 削除対象シート:
 *   - 出退勤記録（全データ行を削除してヘッダーのみ残す）
 *   - 申請管理（同上）
 *   - タスク管理（同上）
 *   - 納期管理（同上）
 *   - _バックアップ（同上）
 *
 * 削除しないシート:
 *   - 人員マスタ（スタッフ情報は残す）
 *   - 会社カレンダー（会社休日設定は残す）
 *   - 給与設定（レート設定は残す）
 *   - インセンティブ（月次データは残す）
 *   - 操作ログ（監査ログは残す）
 *
 * フロントの「テストデータを一括削除」ボタンから
 * resetTestData アクション経由で呼ばれる。
 *
 * @returns {{ reset: boolean, cleared: string[] }}
 */
/**
 * テストデータを削除する。
 *
 * 削除方針:
 *   - 出退勤記録: メモに "[DUMMY]" が含まれる行のみ削除する。
 *     実際に運用しているスタッフの本番データは残す。
 *   - 申請管理・タスク管理・納期管理・バックアップ: 全データ行を削除する。
 *
 * 人員マスタ・会社カレンダー・給与設定は削除しない。
 *
 * 【タイムアウト対策】
 *   旧実装は deleteRow() を1行ずつループしていたため、
 *   数百行のダミーデータがある場合にGASの6分制限でタイムアウトしていた。
 *
 *   新実装は「残すべき行を抽出 → 全消去 → 一括書き戻し」の3ステップにする。
 *   スプレッドシートへのAPI呼び出しが O(n) → O(1) になるため
 *   行数によらず数秒で完了する。
 *
 * @returns {{ reset: boolean, cleared: string[], attendance_deleted: number }}
 */
function resetTestData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cleared = [];
  let attendanceDeleted = 0;

  // ── 出退勤記録: [DUMMY] 行のみ削除（一括書き戻し方式）──────
  //
  // 【なぜこの方式か】
  //   deleteRow() を行数分ループすると API 呼び出しが O(n) になる。
  //   代わりに「本番データ行だけを配列に残し、シートを全消去してから
  //   一括 setValues する」ことで API 呼び出しを3回に抑える。
  //
  //   ステップ:
  //     1. 全行を読み込み、[DUMMY] でない行だけ残す
  //     2. ヘッダー以外の全データ行を deleteRows で一括削除
  //     3. 残った本番データを setValues で一括書き戻し
  try {
    const attSheet = ss.getSheetByName(SHEET.ATTENDANCE);
    if (attSheet && attSheet.getLastRow() >= 2) {
      const lastRow  = attSheet.getLastRow();
      const dataRows = lastRow - 1; // ヘッダー除く行数

      // Step 1: 全行読み込みと仕分け（API 1回）
      const allRows = attSheet
        .getRange(2, 1, dataRows, ATTENDANCE_NUM_COLS)
        .getValues();

      const keepRows  = []; // 本番データ（残す行）
      const memoColIdx = ATTENDANCE_COL.MEMO - 1; // 0始まりインデックス

      allRows.forEach(function(row) {
        const memo = String(row[memoColIdx] || '');
        if (memo.startsWith('[DUMMY]')) {
          attendanceDeleted++;
        } else {
          keepRows.push(row);
        }
      });

      // Step 2: ヘッダー以外を全消去（API 1回）
      attSheet.deleteRows(2, dataRows);

      // Step 3: 本番データを一括書き戻し（API 1回・本番データがある場合のみ）
      if (keepRows.length > 0) {
        attSheet.getRange(2, 1, keepRows.length, ATTENDANCE_NUM_COLS).setValues(keepRows);
      }

      SpreadsheetApp.flush();

      Logger.log(
        '[resetTestData] 出退勤記録: ダミー %d行を削除、本番 %d行を保持しました。',
        attendanceDeleted, keepRows.length
      );
      cleared.push(SHEET.ATTENDANCE + '(ダミー' + attendanceDeleted + '行削除)');
    }
  } catch (err) {
    Logger.log('[resetTestData] 出退勤記録エラー: %s', err.message);
  }

  // ── その他シート: 全データ行を一括削除 ───────────────────────
  // deleteRows(startRow, numRows) は1回のAPI呼び出しで完結するため高速。
  const otherSheets = [
    SHEET.REQUESTS,   // 申請管理
    SHEET.TASKS,      // タスク管理
    SHEET.DEADLINES,  // 納期管理
    SHEET.BACKUP,     // バックアップ
  ];

  otherSheets.forEach(function(sheetName) {
    try {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return;

      const lastRow = sheet.getLastRow();
      // lastRow <= 1 はヘッダーのみ or 空シートなので削除不要
      if (lastRow >= 2) {
        sheet.deleteRows(2, lastRow - 1);
        Logger.log('[resetTestData] %s: %d行削除', sheetName, lastRow - 1);
      }
      cleared.push(sheetName);
    } catch (err) {
      Logger.log('[resetTestData] エラー(%s): %s', sheetName, err.message);
    }
  });

  SpreadsheetApp.flush();
  Logger.log('[resetTestData] 完了: %s', cleared.join(', '));

  return { reset: true, cleared: cleared, attendance_deleted: attendanceDeleted };
}

/**
 * 全スタッフ分のダミー勤怠データを一括登録する。
 *
 * 用途:
 *   - 本番導入前の動作確認・UI確認のためのダミーデータ投入
 *   - GASエディタまたはフロントの「一括ダミー登録」ボタンから実行する
 *
 * 登録内容:
 *   - 指定月（yearMonth: 'YYYY-MM'）の平日（月〜金）のみ
 *   - 各スタッフの所定始業・終業時刻をベースにランダムブレをつける
 *   - 弁当は交互（月・水・金→要、火・木→不要）で登録
 *   - 業務報告はダミー文言を挿入
 *   - 会社カレンダーの休日は除外する
 *
 * 【タイムアウト対策】
 *   旧実装は saveAttendanceRecord() を1行ずつ呼んでいたため、
 *   1呼び出しごとに getValues・setValues・flush が走り O(n) のAPI呼び出しになっていた。
 *
 *   新実装は全行を配列に積み上げてから setValues で一括書き込みする。
 *   API呼び出しが O(1) になるため行数によらず数秒で完了する。
 *
 *   upsert（重複チェック）は一括処理に向かないため、
 *   「対象月の既存ダミー行を事前に書き戻し方式で除去 → 一括追加」とする。
 *
 * @param {string} [yearMonth] - 'YYYY-MM'（省略時は今月）
 * @returns {{ inserted: number, skipped: number }}
 */
function bulkInsertDummyAttendance(yearMonth) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!yearMonth) {
    const d = new Date();
    yearMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  Logger.log('[bulkInsert] 開始: %s', yearMonth);

  const attendanceSheet = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  const employeeSheet   = getOrCreateSheet(ss, SHEET.EMPLOYEES);

  // ── Step 1: 対象月の既存ダミー行を除去（一括書き戻し方式）────
  // 重複登録を防ぐため、同じ月のダミーデータが既にあれば事前に削除する。
  // resetTestData と同じ「読み込み → 全削除 → 本番データのみ書き戻し」で高速処理。
  const monthPrefix = yearMonth.replace(/-/g, '/'); // シート内は YYYY/MM/DD 形式
  const dateColIdx  = ATTENDANCE_COL.DATE - 1;
  const memoColIdx  = ATTENDANCE_COL.MEMO - 1;

  if (attendanceSheet.getLastRow() >= 2) {
    const existingRows = attendanceSheet
      .getRange(2, 1, attendanceSheet.getLastRow() - 1, ATTENDANCE_NUM_COLS)
      .getValues();

    // 「対象月かつ[DUMMY]」以外の行だけを残す
    const keepRows = existingRows.filter(function(row) {
      const dateStr = String(row[dateColIdx] || '');
      const memo    = String(row[memoColIdx] || '');
      return !(dateStr.startsWith(monthPrefix) && memo.startsWith('[DUMMY]'));
    });

    const removedCount = existingRows.length - keepRows.length;
    if (removedCount > 0) {
      attendanceSheet.deleteRows(2, existingRows.length);
      if (keepRows.length > 0) {
        attendanceSheet
          .getRange(2, 1, keepRows.length, ATTENDANCE_NUM_COLS)
          .setValues(keepRows);
      }
      SpreadsheetApp.flush();
      Logger.log('[bulkInsert] 既存ダミー %d行を除去しました。', removedCount);
    }
  }

  // ── Step 2: 対象月の平日リストを生成 ───────────────────────
  const companyCalSheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  const holidayDates    = new Set();
  if (companyCalSheet.getLastRow() > 1) {
    getAllRows(companyCalSheet).forEach(function(r) {
      const d = String(r[0] || '').replace(/\//g, '-');
      if (d) holidayDates.add(d);
    });
  }

  const ym      = yearMonth.split('-').map(Number);
  const lastDay = new Date(ym[0], ym[1], 0).getDate();
  const weekdays = [];
  for (let d = 1; d <= lastDay; d++) {
    const dateStr  = yearMonth + '-' + String(d).padStart(2, '0');
    const dayOfWeek = new Date(ym[0], ym[1] - 1, d).getDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5 && !holidayDates.has(dateStr)) {
      weekdays.push({ date: dateStr, dow: dayOfWeek });
    }
  }

  Logger.log('[bulkInsert] 対象平日: %d日', weekdays.length);

  // ── Step 3: 全スタッフ × 全平日の行データを配列に積み上げる ──
  // saveAttendanceRecord を呼ばずに直接行データを組み立てる。
  // これにより内部の getValues/setValues/flush を完全に排除できる。
  const allStaff = getAllRows(employeeSheet)
    .map(rowToEmployee)
    .filter(function(s) { return s.id && s.employment_type !== ''; });

  const dummyMemos = [
    '通常業務。特記事項なし。',
    '資料作成・メール対応。',
    '社内ミーティング参加後、資料整理。',
    '顧客対応・スケジュール調整。',
    '制作業務・進捗確認。',
    'データ整理・報告書作成。',
  ];

  const IN_BLUR_OPTIONS    = [-5, 0, 0, 5, 5, 10];
  const OUT_BLUR_NORMAL    = [-5, 0, 0, 0, 5, 10, 15];
  const OUT_BLUR_OVERTIME  = [25, 30, 35];

  const newRows = []; // 一括書き込み用バッファ
  const now     = new Date().toISOString();
  let skipped   = 0;

  allStaff.forEach(function(staff) {
    const defaultIn  = staff.scheduled_start || '09:00';
    const defaultOut = staff.scheduled_end   || '18:00';
    const breakMin   = (staff.scheduled_break != null && staff.scheduled_break !== '')
      ? Number(staff.scheduled_break)
      : 60;

    weekdays.forEach(function(wd) {
      try {
        const dow = wd.dow;

        // 出勤・退勤時刻ブレ
        const inBlur     = IN_BLUR_OPTIONS[Math.floor(Math.random() * IN_BLUR_OPTIONS.length)];
        const isOvertime = Math.random() < 0.30;
        const outBlurOpts = isOvertime ? OUT_BLUR_OVERTIME : OUT_BLUR_NORMAL;
        const outBlur    = outBlurOpts[Math.floor(Math.random() * outBlurOpts.length)];

        const timeIn  = _addMinutes(defaultIn,  inBlur);
        const timeOut = _addMinutes(defaultOut, outBlur);
        const lunch   = (dow === 1 || dow === 3 || dow === 5);
        const rawWork = _calcWorkMin(timeIn, timeOut) - breakMin;
        const workMin = Math.floor(Math.max(0, rawWork) / 15) * 15;
        const memo    = '[DUMMY] ' + dummyMemos[Math.floor(Math.random() * dummyMemos.length)];

        // ATTENDANCE_COL の列定義順に合わせて行データを組み立てる。
        // date 列は YYYY/MM/DD 形式（スプシ保存形式）に変換して格納する。
        const dateForSheet = convertDateForDisplay(wd.date); // YYYY-MM-DD → YYYY/MM/DD
        newRows.push([
          generateId(),          // A: id
          staff.id,              // B: employee_id
          dateForSheet,          // C: date（YYYY/MM/DD）
          '出勤',                // D: status
          timeIn,                // E: time_in
          timeOut,               // F: time_out
          breakMin,              // G: break_minutes
          workMin,               // H: work_minutes（15分単位）
          lunch ? '有' : '無',   // I: lunch
          memo,                  // J: memo
          now,                   // K: updated_at
        ]);
      } catch (err) {
        Logger.log('[bulkInsert] スキップ: staff=%s, date=%s, err=%s',
          staff.name, wd.date, err.message);
        skipped++;
      }
    });
  });

  // ── Step 4: 一括書き込み（setValues 1回）──────────────────
  // 全行を一度に書き込むことで API 呼び出しを O(1) に抑える。
  if (newRows.length > 0) {
    // date・time_in・time_out 列をテキスト形式に固定してから書き込む。
    // setNumberFormat より前に呼ぶ必要はなく、setValues 後でも有効。
    // ただし念のため先に書式を設定する。
    const startRow = attendanceSheet.getLastRow() + 1;
    const numRows  = newRows.length;

    // 書き込み範囲全体の date/time 列をテキスト形式に設定（日付・時刻の自動変換を防ぐ）
    attendanceSheet.getRange(startRow, ATTENDANCE_COL.DATE,     numRows, 1).setNumberFormat('@');
    attendanceSheet.getRange(startRow, ATTENDANCE_COL.TIME_IN,  numRows, 1).setNumberFormat('@');
    attendanceSheet.getRange(startRow, ATTENDANCE_COL.TIME_OUT, numRows, 1).setNumberFormat('@');

    attendanceSheet
      .getRange(startRow, 1, numRows, ATTENDANCE_NUM_COLS)
      .setValues(newRows);

    SpreadsheetApp.flush();
  }

  const inserted = newRows.length;
  Logger.log('[bulkInsert] 完了: inserted=%d, skipped=%d', inserted, skipped);
  return { inserted: inserted, skipped: skipped };
}

/**
 * 'HH:MM' 文字列に指定分数を加算した時刻を返す。
 * @param {string} timeStr - 'HH:MM'
 * @param {number} minutes - 加算する分数
 * @returns {string} 'HH:MM'
 */
function _addMinutes(timeStr, minutes) {
  const parts = (timeStr || '00:00').split(':').map(Number);
  const total = parts[0] * 60 + (parts[1] || 0) + minutes;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * 2つの 'HH:MM' 文字列の差分（分）を返す。
 * @param {string} timeIn
 * @param {string} timeOut
 * @returns {number}
 */
function _calcWorkMin(timeIn, timeOut) {
  if (!timeIn || !timeOut) return 0;
  const [ih, im] = timeIn.split(':').map(Number);
  const [oh, om] = timeOut.split(':').map(Number);
  return Math.max(0, (oh * 60 + om) - (ih * 60 + im));
}
