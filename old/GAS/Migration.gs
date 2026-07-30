/**
 * Migration.gs - EMPLOYEESマスタ フラット化マイグレーション
 *
 * 役割:
 *   人員マスタシートの列構成を
 *   旧形式（id / name / data(JSON) / created_at / updated_at）から
 *   新形式（フラット12列）に変換する。
 *
 * 新しい列構成:
 *   A(1)  : ID             - UUID（自動生成・変更なし）
 *   B(2)  : 氏名           - 氏名
 *   C(3)  : PIN            - ログイン用4桁数字（data.pin から昇格）
 *   D(4)  : パスワード      - ログイン用パスワード（data.password から昇格）
 *   E(5)  : 雇用形態        - '常勤' | '非常勤' | '利用者'
 *   F(6)  : 所定労働時間    - 数値（時間）
 *   G(7)  : 所定終業時刻    - 'HH:MM' 形式
 *   H(8)  : 時給/月給       - 数値（円）
 *   I(9)  : 弁当デフォルト  - TRUE / FALSE
 *   J(10) : 勤務曜日        - カンマ区切り文字列（例: '月,火,水,木,金'）
 *   K(11) : 登録日時        - ISO 8601
 *   L(12) : 更新日時        - ISO 8601
 *
 * 実行手順:
 *   1. GAS エディタで flattenEmployeeSheet を選択して ▶ 実行
 *   2. 実行ログで「完了」を確認する
 *   3. スプレッドシートで人員マスタの列構成を目視確認する
 *   4. 問題があれば「人員マスタ_backup_YYYYMMDD」シートから復元する
 *
 * 注意:
 *   - 実行前にバックアップシートが自動作成される（復元可能）
 *   - pin / password が data 列に含まれていない行はその列が空になる
 *   - このスクリプトは1回だけ実行すること（2回目以降は整合性が崩れる）
 *
 * @version 1.0.0
 * @author  田中沙亜
 */

// ============================================================
// 人員マスタ フラット列定数
// ============================================================

/**
 * 人員マスタの日本語ヘッダー（EMPLOYEE_COL の定義順と必ず一致させること）。
 *
 * 列構成（Code.gs の EMPLOYEE_COL と完全一致）:
 *   A〜P : 基本情報（16列）
 *   Q(17): 拠点       ← v2.0.0 追加
 *   R(18): 職種       ← v2.0.0 追加
 *   S(19): 健康保険   ← v2.0.0 追加
 *   T(20): 介護保険   ← v2.0.0 追加
 *   U(21): 厚生年金   ← v2.0.0 追加
 *   V(22): 雇用保険   ← v2.0.0 追加
 *   W(23): 登録日時   ← v2.0.0 で末尾へ移動
 *   X(24): 更新日時   ← v2.0.0 で末尾へ移動
 *
 * ⚠️ 列を追加・変更した場合は Code.gs の EMPLOYEE_COL・EMPLOYEE_NUM_COLS も
 *    必ずセットで修正すること。
 */
const EMPLOYEE_HEADERS_JA = [
  'ID', '姓', '名', 'PIN', 'パスワード',
  '雇用形態', '所定始業時刻', '所定終業時刻',
  '給与形態', '時給(円)', '月給(円)', '弁当デフォルト', '勤務曜日',
  '管理権限',   // N(14)
  '拠点',       // O(15)
  '職種',       // P(16)
  '健康保険',   // Q(17): '加入' | '未加入'
  '介護保険',   // R(18): '加入' | '未加入'
  '厚生年金',   // S(19): '加入' | '未加入'
  '雇用保険',   // T(20): '加入' | '未加入'
  '登録日時',   // U(21)
  '更新日時',   // V(22)
  '論理削除',   // W(23): 'FALSE' | 'TRUE'
];

// ============================================================
// メイン処理
// ============================================================

/**
 * 人員マスタシートをフラット化する。
 *
 * 処理の流れ:
 *   Step 1. 現在のシートを丸ごとバックアップシートにコピーする
 *   Step 2. 全データ行を読み込み、data(JSON) をパースしてフラットな行に変換する
 *   Step 3. 人員マスタシートのヘッダーと全データを新形式で上書きする
 *
 * エラー発生時はバックアップシートが残るため、手動で復元できる。
 *
 * @returns {void}
 */
function flattenEmployeeSheet() {
  _printTestBanner('flattenEmployeeSheet', 'MIGRATION');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.EMPLOYEES);

  if (!sheet) {
    Logger.log('[flattenEmployeeSheet] エラー: 人員マスタシートが見つかりません。');
    return;
  }

  // ── Step 1: バックアップを作成する ──────────────────────────
  // 万が一のために実行前の状態をそのままコピーしておく。
  // バックアップ名に日付を入れることで複数回のバックアップを区別できる。
  const backupSheetName = _createEmployeeBackup(ss, sheet);
  Logger.log('[flattenEmployeeSheet] バックアップ作成完了: %s', backupSheetName);

  // ── Step 2: 既存データを読み込んでフラット行に変換する ──────
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    Logger.log('[flattenEmployeeSheet] データ行なし。ヘッダーのみ更新します。');
    _writeEmployeeHeaders(sheet);
    SpreadsheetApp.flush();
    Logger.log('[flattenEmployeeSheet] 完了（データなし）');
    return;
  }

  // ヘッダー行（1行目）を除いた全データ行を取得する。
  // 旧形式は5列（id / name / data / created_at / updated_at）なので5列で読む。
  const OLD_NUM_COLS = 5;
  const rawRows = sheet.getRange(2, 1, lastRow - 1, OLD_NUM_COLS).getValues();

  Logger.log('[flattenEmployeeSheet] 変換対象: %d行', rawRows.length);

  // 各行を新形式にマッピングする。
  // data(JSON) の中身は項目によって存在しない場合があるため、
  // 存在しない場合のデフォルト値を明示して安全に扱う。
  const flatRows = rawRows.map((row, index) => {
    const id        = row[0];
    const name      = row[1];
    const data      = safeJsonParse(row[2], {});
    const createdAt = row[3];
    const updatedAt = row[4];

    // 勤務曜日は配列の場合があるためカンマ区切り文字列に変換する。
    // スプレッドシートで直接確認・編集しやすくするため。
    const workDays = Array.isArray(data.work_days)
      ? data.work_days.join(',')
      : (data.work_days || '');

    Logger.log(
      '[flattenEmployeeSheet] 変換中 [%d/%d]: name=%s',
      index + 1, rawRows.length, name
    );

    // EMPLOYEE_COL の定義順と必ず一致させること（Code.gs の EMPLOYEE_COL 参照）。
    return [
      id,                                              // A(1) : ID
      name,                                            // B(2) : 氏名
      data.pin              || '',                     // C(3) : PIN
      data.password         || '',                     // D(4) : パスワード
      data.employment_type  || '',                     // E(5) : 雇用形態
      data.scheduled_hours  ?? '',                     // F(6) : 所定労働時間（0は有効値のため??）
      data.scheduled_start  || '',                     // G(7) : 所定始業時刻
      data.scheduled_end    || '',                     // H(8) : 所定終業時刻
      data.scheduled_break  ?? '',                     // I(9) : 所定休憩時間（0は有効値のため??）
      data.wage_type        || '',                     // J(10): 給与形態（時給 / 月給）
      data.hourly_wage      ?? '',                     // K(11): 時給（0は有効値のため??）
      data.monthly_wage     ?? '',                     // L(12): 月給（0は有効値のため??）
      data.default_lunch === true ? '有' : '無',       // M(13): 弁当デフォルト（有/無で保存）
      workDays,                                        // N(14): 勤務曜日
      data.is_admin === true ? '可' : '不可',          // O(15): 管理権限（可/不可）← 追加
      createdAt,                                       // P(16): 登録日時
      updatedAt,                                       // Q(17): 更新日時
    ];
  });

  // ── Step 3: シートを新形式で上書きする ──────────────────────
  // まず既存データ行をすべて削除してからヘッダー・データを書き直す。
  // 列数が旧5列→新12列に変わるため、上書きではなく削除→再書き込みとする。
  if (lastRow >= 2) {
    sheet.deleteRows(2, lastRow - 1);
  }

  // 日本語ヘッダーを書き込む。
  _writeEmployeeHeaders(sheet);

  // データ行を一括書き込みする（1行ずつより大幅に高速）。
  sheet.getRange(2, 1, flatRows.length, EMPLOYEE_NUM_COLS).setValues(flatRows);

  SpreadsheetApp.flush();

  Logger.log(
    '[flattenEmployeeSheet] 完了: %d行をフラット化しました。バックアップ: %s',
    flatRows.length, backupSheetName
  );
}

// ============================================================
// 内部ユーティリティ
// ============================================================

/**
 * 人員マスタの現在の状態をバックアップシートにコピーする。
 *
 * バックアップシート名: 「人員マスタ_backup_YYYYMMDD_HHMMSS」
 * 同名シートが既に存在する場合は上書きせず、末尾に連番を付与する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sourceSheet - コピー元（人員マスタ）
 * @returns {string} 作成されたバックアップシート名
 */
function _createEmployeeBackup(ss, sourceSheet) {
  const now   = new Date();
  const stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  let   name  = '人員マスタ_backup_' + stamp;

  // 万が一同名シートが存在する場合は連番を付与して衝突を回避する。
  let suffix = 0;
  while (ss.getSheetByName(name)) {
    suffix++;
    name = '人員マスタ_backup_' + stamp + '_' + suffix;
  }

  // copyTo でシートごとコピーしてからリネームする。
  // GAS にはシートを末尾移動するAPIがないため、バックアップシートの位置はそのままにする。
  // 名前にタイムスタンプが入っているので一覧上で識別は可能。
  const backupSheet = sourceSheet.copyTo(ss);
  backupSheet.setName(name);

  Logger.log('[_createEmployeeBackup] バックアップ作成: %s', name);
  return name;
}

/**
 * 人員マスタシートの1行目に日本語ヘッダーを書き込む。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function _writeEmployeeHeaders(sheet) {
  sheet.getRange(1, 1, 1, EMPLOYEE_HEADERS_JA.length).setValues([EMPLOYEE_HEADERS_JA]);
  Logger.log('[_writeEmployeeHeaders] ヘッダー書き込み完了: %s', EMPLOYEE_HEADERS_JA.join(' | '));
}
// ============================================================
// テストデータ挿入
// ============================================================

/**
 * テストデータを人員マスタに挿入する。
 *
 * 処理の流れ:
 *   Step 1. 既存データ行をすべて削除する
 *   Step 2. ヘッダーを最新の16列で書き直す
 *   Step 3. テストデータ2行を挿入する
 *
 * 【実行タイミング】
 *   GAS エディタでこの関数を選択して ▶ 実行する。
 *   テスト環境でのみ使用すること。本番データには絶対に実行しない。
 *
 * テストデータ:
 *   テスト太郎 : 職員・月給制・10万円
 *   テスト花子 : 利用者・時給制・1150円
 *
 * @returns {void}
 */
function insertTestEmployees() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.EMPLOYEES);

  if (!sheet) {
    Logger.log('[insertTestEmployees] エラー: 人員マスタシートが見つかりません。');
    return;
  }

  // ── Step 1: 既存データ行を削除する ──────────────────────────
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.deleteRows(2, lastRow - 1);
    Logger.log('[insertTestEmployees] 既存データ %d行を削除しました。', lastRow - 1);
  }

  // ── Step 2: ヘッダーを24列で書き直す ────────────────────────
  _writeEmployeeHeaders(sheet);

  // ── Step 3: テストデータを挿入する ──────────────────────────
  const now = new Date().toISOString();

  // EMPLOYEE_COL の定義順と必ず一致させること（v2.0.0: 列順変更・24列）。
  // Q〜V列: 拠点・職種・社保フラグ / W〜X列: 登録日時・更新日時（末尾に移動）
  const testRows = [
    [
      Utilities.getUuid(),  // A(1) : ID
      'テスト',             // B(2) : 姓
      '太郎',               // C(3) : 名
      '1234',               // D(4) : PIN
      'pass_taro',          // E(5) : パスワード
      '職員',               // F(6) : 雇用形態
      5,                    // G(7) : 所定労働時間（時間）
      '10:00',              // H(8) : 所定始業時刻
      '15:00',              // I(9) : 所定終業時刻
      60,                   // J(10): 所定休憩時間（分）
      '月給',               // K(11): 給与形態
      '',                   // L(12): 時給（円）※月給制のため空
      100000,               // M(13): 月給（円）
      '有',                 // N(14): 弁当デフォルト
      '月,火,水,木,金',     // O(15): 勤務曜日
      '可',                 // P(16): 管理権限
      '半田',               // Q(17): 拠点
      'PC作業',             // R(18): 職種
      '加入',               // S(19): 健康保険
      '加入',               // T(20): 介護保険
      '加入',               // U(21): 厚生年金
      '加入',               // V(22): 雇用保険
      now,                  // W(23): 登録日時（末尾）
      now,                  // X(24): 更新日時（末尾）
    ],
    [
      Utilities.getUuid(),  // A(1) : ID
      'テスト',             // B(2) : 姓
      '花子',               // C(3) : 名
      '5678',               // D(4) : PIN
      'pass_hanako',        // E(5) : パスワード
      '利用者',             // F(6) : 雇用形態
      5,                    // G(7) : 所定労働時間（時間）
      '10:00',              // H(8) : 所定始業時刻
      '15:00',              // I(9) : 所定終業時刻
      60,                   // J(10): 所定休憩時間（分）
      '時給',               // K(11): 給与形態
      1150,                 // L(12): 時給（円）
      '',                   // M(13): 月給（円）※時給制のため空
      '無',                 // N(14): 弁当デフォルト
      '月,水,金',           // O(15): 勤務曜日
      '不可',               // P(16): 管理権限
      '半田',               // Q(17): 拠点
      'PC作業',             // R(18): 職種
      '未加入',             // S(19): 健康保険
      '未加入',             // T(20): 介護保険
      '未加入',             // U(21): 厚生年金
      '加入',               // V(22): 雇用保険（雇用保険のみ加入）
      now,                  // W(23): 登録日時（末尾）
      now,                  // X(24): 更新日時（末尾）
    ],
  ];

  sheet.getRange(2, 1, testRows.length, EMPLOYEE_NUM_COLS).setValues(testRows);
  SpreadsheetApp.flush();

  Logger.log('[insertTestEmployees] テストデータ %d件を挿入しました。', testRows.length);
  testRows.forEach((row, i) => {
    Logger.log('  [%d] %s（%s・%s）', i + 1, row[1], row[4], row[9]);
  });
}

// ============================================================
// IS_ADMIN 列追加マイグレーション
// ============================================================

/**
 * 既存の人員マスタシートに IS_ADMIN（管理権限）列を追加する。
 *
 * 【背景】
 *   Code.gs v1.1.0 で IS_ADMIN 列（O列）が追加されたが、
 *   既存スプレッドシートは旧16列（O=登録日時、P=更新日時）のままになっている。
 *   この関数は既存シートを新17列構成に安全に変換する。
 *
 * 【処理の流れ】
 *   Step 1. 現在のシートをバックアップする（失敗時の復元用）
 *   Step 2. O列（15列目）に空列を挿入して IS_ADMIN 列の場所を確保する
 *   Step 3. IS_ADMIN 列のヘッダーを「管理権限」に設定する
 *   Step 4. 全データ行の IS_ADMIN 列に「不可」を初期値として書き込む
 *   Step 5. 管理者に「可」を手動で設定するよう案内ログを出す
 *
 * 【実行手順】
 *   1. GAS エディタでこの関数（addIsAdminColumn）を選択して ▶ 実行
 *   2. 実行ログで「完了」を確認する
 *   3. スプレッドシートの O列（管理権限）を目視確認する
 *   4. 管理者にしたいスタッフの O列を「可」に手動変更する
 *
 * 【注意】
 *   - このスクリプトは1回だけ実行すること（2回目以降は列がズレる）
 *   - 実行前にバックアップシートが自動作成される
 *   - 既にO列が「管理権限」の場合は実行不要（二重実行防止チェックあり）
 *
 * @returns {void}
 */
function addIsAdminColumn() {
  _printTestBanner('addIsAdminColumn', 'MIGRATION');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.EMPLOYEES);

  if (!sheet) {
    Logger.log('[addIsAdminColumn] エラー: 人員マスタシートが見つかりません。');
    return;
  }

  // ── 二重実行防止チェック ──────────────────────────────────────
  // O列（15列目）のヘッダーが既に「管理権限」なら適用済みと判断して終了する。
  const currentHeader = sheet.getRange(1, 15).getValue();
  if (currentHeader === '管理権限') {
    Logger.log(
      '[addIsAdminColumn] 中断: O列のヘッダーが既に「管理権限」です。このスクリプトは適用済みです。'
    );
    return;
  }

  Logger.log(
    '[addIsAdminColumn] 現在のO列ヘッダー: "%s" → 「管理権限」に変換します。',
    currentHeader
  );

  // ── Step 1: バックアップを作成する ──────────────────────────
  const backupName = _createEmployeeBackup(ss, sheet);
  Logger.log('[addIsAdminColumn] バックアップ作成完了: %s', backupName);

  // ── Step 2: O列（15列目）に空列を挿入する ───────────────────
  // insertColumnBefore(colIndex) は 1-based。
  // 現在のO列（登録日時）の前に空列を挿入することで:
  //   旧: A〜N, O(登録日時), P(更新日時)
  //   後: A〜N, O(空), P(登録日時), Q(更新日時)
  sheet.insertColumnBefore(15);
  Logger.log('[addIsAdminColumn] 15列目（O列）に空列を挿入しました。');

  // ── Step 3: IS_ADMIN 列のヘッダーを設定する ─────────────────
  sheet.getRange(1, 15).setValue('管理権限');
  Logger.log('[addIsAdminColumn] O列ヘッダーを「管理権限」に設定しました。');

  // ── Step 4: 全データ行の IS_ADMIN 列を雇用形態で自動判定する ──
  // 雇用形態が「職員」なら「可」、それ以外（利用者等）は「不可」に自動セットする。
  // これにより手動変更なしにログインできる状態になる。
  // ただし不要な管理者を後から「不可」に変更することは手動で行うこと。
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const dataRowCount = lastRow - 1;
    // E列（雇用形態=5列目）を読んで判定する。
    // insertColumnBefore(15) 実行後も E列は変わらない（5列目のまま）。
    const empTypeCol   = 5; // EMPLOYEE_COL.EMPLOYMENT_TYPE
    const isAdminCol   = 15; // EMPLOYEE_COL.IS_ADMIN（新規挿入したO列）
    const empTypeRange = sheet.getRange(2, empTypeCol, dataRowCount, 1).getValues();
    const isAdminValues = empTypeRange.map(([type]) => [type === '職員' ? '可' : '不可']);
    sheet.getRange(2, isAdminCol, dataRowCount, 1).setValues(isAdminValues);
    Logger.log(
      '[addIsAdminColumn] %d行の管理権限を雇用形態で自動判定しました（職員→可、それ以外→不可）。',
      dataRowCount
    );
  } else {
    Logger.log('[addIsAdminColumn] データ行なし。初期化をスキップします。');
  }

  // ── Step 5: 余分な「管理」列（旧P=16列目）を削除する ─────
  // addIsAdminColumn 実行前のシートには旧「管理」列が P(16) に残っている場合がある。
  // 挿入後の列構成: A〜N, O(管理権限/新), P(管理/旧・不要), Q(登録日時), R(更新日時)
  // この旧「管理」列を削除して正しい17列構成に戻す。
  const headerAfterInsert = sheet.getRange(1, 16).getValue();
  if (headerAfterInsert === '管理') {
    sheet.deleteColumn(16);
    Logger.log('[addIsAdminColumn] P列（旧「管理」列）を削除しました。');
  } else {
    Logger.log(
      '[addIsAdminColumn] P列のヘッダー: "%s" → 旧「管理」列なし。削除をスキップします。',
      headerAfterInsert
    );
  }

  SpreadsheetApp.flush();

  // ── Step 6: 完了案内 ────────────────────────────────────────
  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[addIsAdminColumn] ✅ 完了');
  Logger.log('  - O列（管理権限）を追加しました。');
  Logger.log('  - 職員 → 自動で「可」、それ以外 → 「不可」に設定しました。');
  Logger.log('  - 不要な管理者は O列を手動で「不可」に変更してください。');
  Logger.log('  - バックアップシート: %s', backupName);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}



// ============================================================
// v1.4.0 マイグレーション: 人員マスタ「姓・名」2列分割
// ============================================================

/**
 * 人員マスタの「氏名」列（旧B列）を「姓」「名」の2列に分割する。
 *
 * 【実行タイミング】
 *   このファイルを GAS にデプロイした後、GAS エディタ上で
 *   splitNameColumn を1回だけ手動実行する。それ以降は実行不要。
 *
 * 【何をするか】
 *   1. 「人員マスタ」シートをバックアップする
 *   2. B列（旧「氏名」）をスペースで「姓」「名」に分割する
 *   3. B列のヘッダーを「姓」に変更し、C列に「名」を新規挿入する
 *   4. 既存の氏名データをスペースで分割して書き込む
 *   5. 以降の列番号が+1ずれるため、EMPLOYEE_COL が正しいことを確認する
 *
 * 【注意】
 *   - 実行前にバックアップシートが自動作成される
 *   - 氏名が「姓のみ（スペースなし）」の場合、姓に全体が入り名は空になる
 *   - Code.gs の EMPLOYEE_NUM_COLS が 18 になっていることを確認してから実行する
 *   - このスクリプトは1回だけ実行すること
 *
 * @returns {void}
 */
function splitNameColumn() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('人員マスタ');

  if (!sheet) {
    Logger.log('[splitNameColumn] 人員マスタシートが見つかりません。');
    return;
  }

  Logger.log('[splitNameColumn] 開始');

  // ── Step 1: バックアップ ──────────────────────────────────
  const backupName = '人員マスタ_backup_v140_' +
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  sheet.copyTo(ss).setName(backupName);
  Logger.log('[splitNameColumn] バックアップ作成: %s', backupName);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[splitNameColumn] データ行なし。処理をスキップします。');
    return;
  }

  // ── Step 2: 既存の「氏名」データを姓・名に分割して保持 ──
  // B列（2列目）の全データ行を取得する
  const nameValues = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const splitNames = nameValues.map(function([fullName]) {
    const str   = String(fullName || '');
    // 半角スペース・全角スペースで分割する
    const parts = str.split(/[\s\u3000]+/);
    return [parts[0] || '', parts.slice(1).join(' ') || ''];
    // → [姓, 名]
  });

  // ── Step 3: C列に「名」の新しい列を挿入する ──────────────
  // insertColumnsBefore(列番号) は 1始まり。C列=3に挿入する。
  sheet.insertColumnsBefore(3, 1);
  Logger.log('[splitNameColumn] C列（名）を挿入しました。');

  // ── Step 4: ヘッダーを更新する ───────────────────────────
  // B列を「氏名」→「姓」に変更、C列に「名」を設定
  sheet.getRange(1, 2).setValue('姓');
  sheet.getRange(1, 3).setValue('名');
  Logger.log('[splitNameColumn] ヘッダーを「姓」「名」に変更しました。');

  // ── Step 5: 分割した姓・名を書き込む ──────────────────────
  const lastNames  = splitNames.map(function([l]) { return [l]; });
  const firstNames = splitNames.map(function([, f]) { return [f]; });

  // 書き込み前に PIN・PW・時刻列の書式をテキストに設定する（0消え防止）
  // 列挿入後の列番号: D=4(PIN), E=5(PW), H=8(始業), I=9(終業)
  const dataRows = lastRow - 1;
  sheet.getRange(2, 2, dataRows, 1).setValues(lastNames);   // B列: 姓
  sheet.getRange(2, 3, dataRows, 1).setValues(firstNames);  // C列: 名

  // PIN・パスワード列をテキスト形式に設定（数値変換による0消えを防ぐ）
  sheet.getRange(2, 4, dataRows, 1).setNumberFormat('@');  // D列: PIN
  sheet.getRange(2, 5, dataRows, 1).setNumberFormat('@');  // E列: PW
  // 所定始業・終業列をテキスト形式に設定（1899-12-30問題を防ぐ）
  sheet.getRange(2, 8, dataRows, 1).setNumberFormat('@');  // H列: 所定始業
  sheet.getRange(2, 9, dataRows, 1).setNumberFormat('@');  // I列: 所定終業

  SpreadsheetApp.flush();

  Logger.log('[splitNameColumn] %d行の氏名を分割しました。', dataRows);
  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[splitNameColumn] ✅ 完了');
  Logger.log('  - B列: 「姓」、C列（新規）: 「名」');
  Logger.log('  - 全18列構成になりました（EMPLOYEE_NUM_COLS=18）。');
  Logger.log('  - バックアップ: %s', backupName);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 人員マスタの PIN・パスワード・時刻列にテキスト書式を一括設定する。
 *
 * splitNameColumn 実行後や、既存シートの 0 消え問題が発生した場合に使う。
 * データを変更せずに書式だけ設定するため、既存データへの影響は最小限。
 *
 * @returns {void}
 */
function fixEmployeeColumnFormats() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('人員マスタ');

  if (!sheet) {
    Logger.log('[fixEmployeeColumnFormats] 人員マスタシートが見つかりません。');
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[fixEmployeeColumnFormats] データ行なし。');
    return;
  }

  const dataRows = lastRow - 1;

  // PIN(D=4), PW(E=5), 始業(H=8), 終業(I=9) をテキスト形式に設定する
  // 既存の値は変更しない（書式のみ変更）
  sheet.getRange(2, 4, dataRows, 1).setNumberFormat('@');  // D: PIN
  sheet.getRange(2, 5, dataRows, 1).setNumberFormat('@');  // E: PW
  sheet.getRange(2, 8, dataRows, 1).setNumberFormat('@');  // H: 所定始業
  sheet.getRange(2, 9, dataRows, 1).setNumberFormat('@');  // I: 所定終業

  SpreadsheetApp.flush();
  Logger.log('[fixEmployeeColumnFormats] ✅ 完了: %d行にテキスト書式を適用しました。', dataRows);
}

// ============================================================
// v2.0.0 マイグレーション: 拠点・職種・社会保険フラグ6列追加
// ============================================================

/**
 * 既存の人員マスタに拠点・職種・社会保険フラグ6列（S〜X列）を追加する。
 *
 * 【背景】
 *   v2.0.0 で、半田PC作業スタッフ以外（半田軽作業・名古屋など）への
 *   対応と、スタッフ個別の社会保険設定が必要になった。
 *   これに伴い人員マスタを 18列 → 24列 に拡張する。
 *
 * 【追加列】
 *   S(19): 拠点        - '半田' | '名古屋' | その他
 *   T(20): 職種        - 'PC作業' | '軽作業' | その他
 *   U(21): 健康保険    - '加入' | '未加入'
 *   V(22): 介護保険    - '加入' | '未加入'
 *   W(23): 厚生年金    - '加入' | '未加入'
 *   X(24): 雇用保険    - '加入' | '未加入'
 *
 * 【既存スタッフのデフォルト値】
 *   - 拠点: '半田'（現状の運用拠点）
 *   - 職種: 'PC作業'（現状の主業務）
 *   - 健康保険・介護保険・厚生年金・雇用保険: すべて '加入'
 *   ※ テストデータのみの環境では全面リセット（insertTestEmployees）を推奨。
 *
 * 【実行手順】
 *   1. GAS エディタでこの関数（addLocationJobInsColumns）を選択して ▶ 実行
 *   2. 実行ログで「完了」を確認する
 *   3. スプレッドシートの S〜X列を目視確認する
 *   4. 拠点・職種・社保設定が正しくない行は Admin 画面から個別に修正する
 *
 * 【注意】
 *   - このスクリプトは1回だけ実行する（2回目以降は列が重複する）
 *   - 実行前にバックアップシートが自動作成される
 *   - 既に S列のヘッダーが「拠点」の場合は二重実行防止のためスキップする
 *
 * @returns {void}
 */
function addLocationJobInsColumns() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[addLocationJobInsColumns] 開始: 拠点・職種・社保フラグ6列追加');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.EMPLOYEES);

  if (!sheet) {
    Logger.log('[addLocationJobInsColumns] エラー: 人員マスタシートが見つかりません。処理を中断します。');
    return;
  }

  // ── 二重実行防止チェック ─────────────────────────────────────
  // S列（19列目）のヘッダーが既に「拠点」であれば適用済みと判断して終了する。
  const currentHeaderS = sheet.getRange(1, 19).getValue();
  if (currentHeaderS === '拠点') {
    Logger.log('[addLocationJobInsColumns] 中断: S列が既に「拠点」です。マイグレーション適用済みです。');
    return;
  }

  Logger.log('[addLocationJobInsColumns] 現在の列数: %d', sheet.getLastColumn());

  // ── Step 1: バックアップを作成する ───────────────────────────
  // 既存データを保護するため、処理の前にバックアップを取る。
  const backupName = _createEmployeeBackup(ss, sheet);
  Logger.log('[addLocationJobInsColumns] バックアップ作成完了: %s', backupName);

  // ── Step 2: S〜X列（19〜24列目）にヘッダーを書き込む ────────
  // 既存の18列はそのままに、末尾6列だけを追加する。
  // appendColumn がないため getRange で直接書き込む。
  const newHeaders = ['拠点', '職種', '健康保険', '介護保険', '厚生年金', '雇用保険'];
  sheet.getRange(1, 19, 1, 6).setValues([newHeaders]);
  Logger.log('[addLocationJobInsColumns] S〜X列ヘッダーを設定しました: %s', newHeaders.join(' | '));

  // ── Step 3: 既存スタッフにデフォルト値を設定する ─────────────
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[addLocationJobInsColumns] データ行なし。デフォルト値設定をスキップします。');
    SpreadsheetApp.flush();
    Logger.log('[addLocationJobInsColumns] ✅ 完了（データなし）');
    return;
  }

  const dataRows = lastRow - 1;

  // 既存スタッフのデフォルト値:
  //   拠点='半田' / 職種='PC作業' / 全保険='加入'
  // 個別に異なる設定が必要なスタッフは Admin 画面から後で編集してもらう。
  const defaultValues = Array.from({ length: dataRows }, function() {
    return ['半田', 'PC作業', '加入', '加入', '加入', '加入'];
  });

  sheet.getRange(2, 19, dataRows, 6).setValues(defaultValues);

  Logger.log(
    '[addLocationJobInsColumns] %d件の既存スタッフにデフォルト値を設定しました。',
    dataRows
  );
  Logger.log('  拠点: 半田 / 職種: PC作業 / 健康・介護・厚生・雇用保険: すべて加入');
  Logger.log('  ※ 実際の保険加入状況に合わせて Admin 画面から個別に修正してください。');

  SpreadsheetApp.flush();

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[addLocationJobInsColumns] ✅ 完了');
  Logger.log('  - 人員マスタを 18列 → 24列 に拡張しました。');
  Logger.log('  - 追加列: S(拠点), T(職種), U(健康保険), V(介護保険), W(厚生年金), X(雇用保険)');
  Logger.log('  - バックアップシート: %s', backupName);
  Logger.log('  - 次のステップ: Admin 画面でスタッフの拠点・職種・社保設定を確認・修正してください。');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ============================================================
// 納期シート マイグレーション（v3.0.0）
// ============================================================

/**
 * 納期シートの壊れた列構造を正しい7列フラット構造に修正する。
 *
 * 問題の経緯:
 *   旧コードは 5列構造 [id, employee_id, name, JSON(title含む), updated_at] で書き込んでいた。
 *   その後ヘッダーのみ 7列に変更されたため、列の中身がずれたまま保存された。
 *
 * 旧5列の実際の中身（スプシ上）:
 *   A: 案件UUID
 *   B: employee_id（UUID）          ← ヘッダー「案件名」と不一致
 *   C: 担当者名
 *   D: JSON文字列（title等を含む）   ← ヘッダー「employeeId」と不一致
 *   E: updated_at（ISO）             ← ヘッダー「納品日」と不一致
 *   F〜G: 空
 *
 * 修正後の7列構造:
 *   A: 案件UUID
 *   B: title（JSON内の title を昇格）
 *   C: 担当者名
 *   D: employee_id
 *   E: JSON（title を除いた残り: client/type/phases/memo/progress 等）
 *   F: created_at（旧 updated_at を流用）
 *   G: updated_at（同上）
 *
 * 実行手順:
 *   1. GAS エディタで migrateDeadlineSheet を選択して ▶ 実行
 *   2. ログで「✅ 完了」を確認する
 *   3. スプレッドシートで納期シートを目視確認する
 *   4. 問題があれば「納期_backup_YYYYMMDD」シートから復元する
 *
 * ⚠️ 1回だけ実行すること。2回目以降は正しい構造のデータを再変換してしまう。
 *    実行前にスプシを手動バックアップすることを推奨。
 */
function migrateDeadlineSheet() {
  var FUNC = 'migrateDeadlineSheet';
  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[%s] 開始', FUNC);
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  var ss         = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName  = SHEET.DEADLINES; // '納期' または定数値
  var sheet      = ss.getSheetByName(sheetName);

  if (!sheet) {
    Logger.log('[%s] ❌ シート "%s" が見つかりません。処理を中断します。', FUNC, sheetName);
    return;
  }

  var lastRow = sheet.getLastRow();
  Logger.log('[%s] 対象シート: "%s"  総行数（ヘッダー含む）: %d', FUNC, sheetName, lastRow);

  if (lastRow <= 1) {
    Logger.log('[%s] データ行なし。マイグレーション不要です。', FUNC);
    return;
  }

  // ── Step 1: バックアップシートを作成する ─────────────────────
  // 既存データを丸ごとコピーして復元可能な状態にしてから変換を開始する。
  var today      = new Date();
  var dateStr    = today.getFullYear()
    + String(today.getMonth() + 1).padStart(2, '0')
    + String(today.getDate()).padStart(2, '0');
  var backupName = sheetName + '_backup_' + dateStr;

  // 同名バックアップが既にある場合は上書きしない（安全のため）
  if (ss.getSheetByName(backupName)) {
    Logger.log('[%s] バックアップ "%s" は既に存在します。スキップします。', FUNC, backupName);
  } else {
    sheet.copyTo(ss).setName(backupName);
    Logger.log('[%s] バックアップを作成しました: "%s"', FUNC, backupName);
  }

  // ── Step 2: 全データ行を読み込む ─────────────────────────────
  // ヘッダー行（1行目）を除いた全データを取得する。
  // 列数は sheet.getLastColumn() で動的に取得する（旧5列・新7列どちらでも対応）。
  var numCols = sheet.getLastColumn();
  var values  = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  Logger.log('[%s] 読み込み完了: %d 行', FUNC, values.length);

  // ── Step 3: 各行を判定して変換する ───────────────────────────
  //
  // 判定ロジック:
  //   B列（index 1）が UUID 形式（8-4-4-4-12 の英数字）の場合 → 旧構造（要変換）
  //   B列が UUID でない（人間が読める案件名）の場合 → 新構造（変換済み・スキップ）
  //
  // UUID パターン: 8文字-4文字-4文字-4文字-12文字（英数字のみ）
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var converted = 0;
  var skipped   = 0;
  var errors    = 0;

  var newValues = values.map(function(row, i) {
    var rowNum = i + 2; // 実際のシート行番号（ヘッダー=1行目のため +2）

    var colA = String(row[0] || ''); // 案件ID（UUID）
    var colB = String(row[1] || ''); // 旧: employee_id / 新: title
    var colC = String(row[2] || ''); // 担当者名
    var colD = String(row[3] || ''); // 旧: JSON / 新: employee_id
    var colE = String(row[4] || ''); // 旧: updated_at / 新: JSON
    var colF = String(row[5] || ''); // 旧: 空 / 新: created_at
    var colG = String(row[6] || ''); // 旧: 空 / 新: updated_at

    // ── 旧構造の判定 ──
    // B列が UUID 形式 → employee_id が入っている → 旧構造と判断する
    var isOldFormat = UUID_RE.test(colB);

    if (!isOldFormat) {
      // 新構造（変換済み）はそのまま返す
      Logger.log('[%s] 行%d: 新構造のためスキップ（案件名: %s）', FUNC, rowNum, colB);
      skipped++;
      // 7列に満たない場合は空文字で埋めて返す
      return [colA, colB, colC, colD, colE, colF || colE, colG || colE];
    }

    // ── 旧構造の変換 ──
    try {
      var employeeId = colB;           // B列: employee_id（UUID）
      var name       = colC;           // C列: 担当者名（正しい）
      var jsonStr    = colD;           // D列: JSON文字列
      var updatedAt  = colE;           // E列: updated_at

      // JSON をパースして title と残りのフィールドを分離する
      var parsed = {};
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        Logger.log('[%s] 行%d: JSON パース失敗（%s）。空オブジェクトで続行します。', FUNC, rowNum, e.message);
      }

      var title = parsed.title || '';  // JSON 内の title を B列に昇格させる

      // title を除いた残りのフィールドを新しい DATA JSON として保存する。
      // title は B列（フラット列）に昇格するため JSON には不要。
      var newData = {
        client     : parsed.client     || '',
        type       : parsed.type       || '単発',
        recur_mode : parsed.recur_mode || 'manual',
        phases     : parsed.phases     || [],
        memo       : parsed.memo       || '',
        progress   : parsed.progress   || 0,
      };
      // recur_source がある場合は引き継ぐ（継続案件の自動生成フラグ）
      if (parsed.recur_source) newData.recur_source = parsed.recur_source;

      var newRow = [
        colA,                       // A: 案件UUID（変更なし）
        title,                      // B: 案件名（JSON から昇格）
        name,                       // C: 担当者名（変更なし）
        employeeId,                 // D: 担当者ID（旧B列から移動）
        JSON.stringify(newData),    // E: JSON（title 除外済み）
        updatedAt,                  // F: 作成日時（旧 updated_at を流用）
        updatedAt,                  // G: 更新日時
      ];

      Logger.log(
        '[%s] 行%d: 変換完了 → 案件名="%s" 担当者名="%s" employee_id="%s"',
        FUNC, rowNum, title, name, employeeId
      );
      converted++;
      return newRow;

    } catch (err) {
      Logger.log('[%s] 行%d: ❌ エラー（%s）。元の行を維持します。', FUNC, rowNum, err.message);
      errors++;
      // エラー行は元データのまま7列で返す（データロストを防ぐ）
      return [colA, colB, colC, colD, colE, colF, colG];
    }
  });

  // ── Step 4: ヘッダー行を正しい7列に更新する ─────────────────
  var correctHeader = [
    '案件ID', '案件名', '担当者名', 'employeeId', 'データ(JSON)', '作成日時', '更新日時'
  ];
  sheet.getRange(1, 1, 1, 7).setValues([correctHeader]);
  Logger.log('[%s] ヘッダー行を7列構造に更新しました。', FUNC);

  // ── Step 5: 変換済みデータを書き戻す ─────────────────────────
  // 既存のデータ列数が7列未満の場合に備え、先に7列分をクリアしてから書き込む。
  sheet.getRange(2, 1, newValues.length, 7).clearContent();
  sheet.getRange(2, 1, newValues.length, 7).setValues(newValues);
  SpreadsheetApp.flush();

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[%s] ✅ 完了', FUNC);
  Logger.log('  - 変換: %d 行', converted);
  Logger.log('  - スキップ（新構造）: %d 行', skipped);
  Logger.log('  - エラー: %d 行', errors);
  Logger.log('  - バックアップ: "%s"', backupName);
  if (errors > 0) {
    Logger.log('  ⚠️ エラー行があります。スプレッドシートとログを確認してください。');
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ============================================================
// v2.1.0 マイグレーション: is_deleted 列追加 + テストアカウント作成
// ============================================================

/**
 * 人員マスタに is_deleted 列（Y列=25列目）を追加する。
 *
 * 【実行タイミング】
 *   AdminServices.gs v2.1.0 デプロイ後に1回だけ手動実行する。
 *
 * 【何をするか】
 *   1. 人員マスタをバックアップする
 *   2. Y列ヘッダーを「論理削除」に設定する
 *   3. 全データ行の Y列に 'FALSE' を設定する（全員ログイン可）
 *
 * 【注意】
 *   - 2回目以降の実行は二重実行防止チェックで中断する
 *
 * @returns {void}
 */
function addIsDeletedColumn() {
  _printTestBanner('addIsDeletedColumn', 'MIGRATION v2.1.0');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.EMPLOYEES);
  if (!sheet) {
    Logger.log('[addIsDeletedColumn] エラー: 人員マスタが見つかりません。');
    return;
  }

  // 二重実行防止: Y列（25列目）ヘッダーが既に「論理削除」なら中断
  var lastCol    = sheet.getLastColumn();
  var currentY   = lastCol >= 25 ? sheet.getRange(1, 25).getValue() : '';
  if (currentY === '論理削除') {
    Logger.log('[addIsDeletedColumn] 中断: Y列が既に「論理削除」です。適用済みです。');
    return;
  }

  // Step 1: バックアップ
  var backupName = _createEmployeeBackup(ss, sheet);
  Logger.log('[addIsDeletedColumn] バックアップ作成完了: %s', backupName);

  // Step 2: Y列（25列目）ヘッダーを設定する
  sheet.getRange(1, 25).setValue('論理削除');
  Logger.log('[addIsDeletedColumn] Y列ヘッダーを「論理削除」に設定しました。');

  // Step 3: 全データ行の Y列に 'FALSE' を設定する（全員ログイン可の初期値）
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var count = lastRow - 1;
    var values = [];
    for (var i = 0; i < count; i++) { values.push(['FALSE']); }
    sheet.getRange(2, 25, count, 1).setValues(values);
    Logger.log('[addIsDeletedColumn] %d 行に "FALSE" を設定しました。', count);
  }

  SpreadsheetApp.flush();
  Logger.log('[addIsDeletedColumn] ✅ 完了。Y列（論理削除）を追加しました。');
}

/**
 * テストアカウントを一括作成する。
 *
 * 作成するアカウント（#1対応）:
 *   - 管理者（社長ロール）× 2
 *   - 給与担当 × 1
 *   - 一般職員 × 4
 *
 * 全員に初回ログイン可能な PIN + パスワードを設定する。
 * 重複 PIN チェックを行い、衝突時は再生成する。
 *
 * @returns {void}
 */
function createTestAccounts() {
  _printTestBanner('createTestAccounts', 'MIGRATION v2.2.0');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.EMPLOYEES);
  if (!sheet) {
    Logger.log('[createTestAccounts] エラー: 人員マスタが見つかりません。');
    return;
  }

  // ── 重複チェック ──────────────────────────────────────────────
  // 「姓がテスト用の値（管理者/給与/職員/利用者）かつ名が『テスト』」の行を
  // ロールごとに個別に検索し、存在しないロールのみ追加する。
  //
  // この方式により:
  //   - runAllMigrationsV22 を何度実行しても重複しない
  //   - 一部だけ削除して再実行した場合も欠けた分だけ補完される
  //
  // 検索対象列: B列（姓=2列目）, C列（名=3列目）
  // ※ 管理権限列(旧P→新N=14列目)は列削除前後で変わるため、
  //    姓+名の組み合わせで判定する（より安全）
  var lastRow = sheet.getLastRow();
  var existingNames = {}; // { '管理者_テスト': true, ... }
  if (lastRow >= 2) {
    var nameRange = sheet.getRange(2, 2, lastRow - 1, 2).getValues(); // B列・C列
    nameRange.forEach(function(r) {
      var key = String(r[0]) + '_' + String(r[1]);
      existingNames[key] = true;
    });
  }

  // テストアカウント定義（管理者1・給与担当1・一般職員1・利用者1 の計4件）
  // 各アカウントのキー（姓_名）で既存チェックをする
  var ACCOUNTS_DEF = [
    { lastName:'管理者', firstName:'テスト', adminRole:'管理者',        empType:'職員',  note:'管理者テストアカウント' },
    { lastName:'給与',   firstName:'テスト', adminRole:'給与計算担当', empType:'職員',  note:'給与担当テストアカウント' },
    { lastName:'職員',   firstName:'テスト', adminRole:'一般職員',    empType:'職員',  note:'一般職員テストアカウント' },
    { lastName:'利用者', firstName:'テスト', adminRole:'',            empType:'利用者', note:'利用者テストアカウント' },
  ];

  // 既に存在するアカウントを除外して追加対象だけに絞る。
  // キーは「姓_名」の完全一致（例: '管理者_テスト'）。
  // 「テスト1」「テスト2」など名に番号が付いた行は別キーになるため
  // スキップされない（= 別物として扱う）。
  // 不要な番号付きアカウントはスプレッドシートで手動削除すること。
  var toCreate = ACCOUNTS_DEF.filter(function(acc) {
    var key = acc.lastName + '_' + acc.firstName;
    if (existingNames[key]) {
      Logger.log('[createTestAccounts] スキップ（既存）: %s %s (key=%s)', acc.lastName, acc.firstName, key);
      return false;
    }
    Logger.log('[createTestAccounts] 追加対象: %s %s (key=%s)', acc.lastName, acc.firstName, key);
    return true;
  });

  if (toCreate.length === 0) {
    Logger.log('[createTestAccounts] 全テストアカウントが既に存在します。追加不要です。');
    return;
  }

  Logger.log('[createTestAccounts] 追加対象: %d 件', toCreate.length);

  // 既存 PIN のセットを作成（重複防止）
  var existingRows = sheet.getLastRow() >= 2
    ? sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues().map(function(r){ return String(r[0]); })
    : [];
  var usedPins = {};
  existingRows.forEach(function(p){ usedPins[p] = true; });

  /**
   * 重複しない4桁 PIN を生成する。
   * @returns {string}
   */
  function generatePin() {
    var pin;
    var tries = 0;
    do {
      pin = String(Math.floor(1000 + Math.random() * 9000)); // 1000〜9999
      tries++;
    } while (usedPins[pin] && tries < 100);
    usedPins[pin] = true;
    return pin;
  }

  /**
   * ランダムなパスワード（8文字英数字）を生成する。
   * @returns {string}
   */
  function generatePassword() {
    var chars = 'abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    var pw = '';
    for (var i = 0; i < 8; i++) {
      pw += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pw;
  }

  var now = new Date().toISOString();

  // テストアカウント定義（#1: 管理者1・給与担当1・一般職員1・利用者1 の計4件）
  var results = [];
  var rowNum = sheet.getLastRow() + 1;

  toCreate.forEach(function(acc) {
    var id  = Utilities.getUuid();
    var pin = generatePin();
    var pw  = generatePassword();

    // EMPLOYEE_NUM_COLS=25 に合わせた25列で書き込む
    // v2.2.0: 所定労働時間(旧G)・所定休憩時間(旧J)を削除して23列
    var row = [
      id,                      // A(1) : ID
      acc.lastName,            // B(2) : 姓
      acc.firstName,           // C(3) : 名
      pin,                     // D(4) : PIN
      pw,                      // E(5) : パスワード
      acc.empType || '職員',   // F(6) : 雇用形態
      '10:00',                 // G(7) : 所定始業時刻
      '15:00',                 // H(8) : 所定終業時刻
      '時給',                  // I(9) : 給与形態
      1000,                    // J(10): 時給（テスト値）
      '',                      // K(11): 月給
      '無',                    // L(12): 弁当デフォルト
      '月,火,水,木,金',        // M(13): 勤務曜日
      acc.adminRole,           // N(14): 管理権限ロール
      '半田',                  // O(15): 拠点（デフォルト）
      'PC作業',                // P(16): 職種（デフォルト）
      '未加入',                // Q(17): 健康保険
      '未加入',                // R(18): 介護保険
      '未加入',                // S(19): 厚生年金
      '未加入',                // T(20): 雇用保険
      now,                     // U(21): 登録日時
      now,                     // V(22): 更新日時
      'FALSE',                 // W(23): 論理削除
    ];
    // PIN・PW・時刻列をテキスト形式に固定してから書き込む
    sheet.getRange(rowNum, 4).setNumberFormat('@'); // PIN
    sheet.getRange(rowNum, 5).setNumberFormat('@'); // PW
    sheet.getRange(rowNum, 7).setNumberFormat('@'); // 所定始業
    sheet.getRange(rowNum, 8).setNumberFormat('@'); // 所定終業
    sheet.getRange(rowNum, 1, 1, 23).setValues([row]);

    results.push({ name: acc.lastName + ' ' + acc.firstName, role: acc.adminRole, pin: pin, password: pw, note: acc.note });
    rowNum++;
  });

  SpreadsheetApp.flush();

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('[createTestAccounts] ✅ テストアカウント %d 件を追加しました（既存スキップ含む場合あり）', results.length);
  results.forEach(function(r) {
    Logger.log('  %-20s %-12s PIN: %s  PW: %s', r.name, r.role, r.pin, r.password);
  });
  Logger.log('');
  Logger.log('  ⚠️ 上記のPIN/パスワードをメモしてください。再表示できません。');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 申請管理シートを v2.1.0 形式（16列）に拡張するマイグレーション。
 *
 * 既存の12列データに列を追加する（既存データへの影響なし）。
 * 新列（M〜P）は空白で初期化する。
 *
 * @returns {void}
 */
function migrateRequestSheet() {
  _printTestBanner('migrateRequestSheet', 'MIGRATION v2.1.0');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.REQUESTS);
  if (!sheet || sheet.getLastRow() === 0) {
    Logger.log('[migrateRequestSheet] 申請管理シートが空または存在しないため、スキップします。');
    return;
  }

  // 二重実行防止: M列（13列目）ヘッダーが既に「申請時刻」なら中断
  var currentM = sheet.getLastColumn() >= 13 ? sheet.getRange(1, 13).getValue() : '';
  if (currentM === '申請時刻') {
    Logger.log('[migrateRequestSheet] 中断: 既に v2.1.0 形式です。');
    return;
  }

  // ヘッダー行を16列に更新する
  sheet.getRange(1, 1, 1, 16).setValues([[
    'ID', '申請者ID', '申請者名', 'ステータス', '種別', '対象日', '理由',
    '承認フロー', '承認者ID', '承認日時', '却下理由', '申請日時',
    '申請時刻', '遅刻時間', '早退時間', '申請種別区分'
  ]]);

  // 既存データ行の M〜P列を空文字で初期化する（既存データを壊さない）
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var dataRows = lastRow - 1;
    // 4列（M〜P）を空文字で埋める
    var emptyValues = [];
    for (var i = 0; i < dataRows; i++) { emptyValues.push(['', '', '', '']); }
    sheet.getRange(2, 13, dataRows, 4).setValues(emptyValues);
    Logger.log('[migrateRequestSheet] %d 行の M〜P列を空で初期化しました。', dataRows);
  }

  SpreadsheetApp.flush();
  Logger.log('[migrateRequestSheet] ✅ 完了。申請管理シートを16列に拡張しました。');
}

/**
 * 納期管理シートを v2.1.0 形式（7列）に修正するマイグレーション。
 *
 * #10 対応: 旧5列シートを正しい7列構造に変換する。
 * migrateDeadlineSheet()（既存の関数）に統合する形で追加する。
 *
 * @returns {void}
 */
function migrateDeadlineSheetV21() {
  _printTestBanner('migrateDeadlineSheetV21', 'MIGRATION v2.1.0');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.DEADLINES);
  if (!sheet || sheet.getLastRow() === 0) {
    Logger.log('[migrateDeadlineSheetV21] 納期管理シートが空または存在しないため、スキップします。');
    return;
  }

  // 二重実行防止: ヘッダー行の A列が「ID」かつ G列が「更新日時」なら適用済み
  var headerA = sheet.getRange(1, 1).getValue();
  var headerG = sheet.getLastColumn() >= 7 ? sheet.getRange(1, 7).getValue() : '';
  if (headerA === 'ID' && headerG === '更新日時') {
    Logger.log('[migrateDeadlineSheetV21] 中断: 既に7列形式です。');
    return;
  }

  // migrateDeadlineSheet() が既に存在する場合はそちらを呼ぶ
  // （Migration.gs 内の既存マイグレーション関数と同等の処理）
  Logger.log('[migrateDeadlineSheetV21] 既存の migrateDeadlineSheet() を呼び出します。');
  try {
    migrateDeadlineSheet();
  } catch(e) {
    Logger.log('[migrateDeadlineSheetV21] migrateDeadlineSheet() の呼び出しに失敗しました: %s', e.message);
    Logger.log('[migrateDeadlineSheetV21] GASエディタから migrateDeadlineSheet() を直接実行してください。');
  }
}

/**
 * v2.1.0 の全マイグレーションを一括実行する。
 *
 * 【実行手順】
 *   1. GASエディタで runAllMigrationsV21 を選択して ▶ 実行
 *   2. 実行ログを確認する
 *   3. 各シートを目視確認する
 *
 * 【順序が重要】
 *   - addIsDeletedColumn: 人員マスタに列追加
 *   - migrateRequestSheet: 申請シートを16列に拡張
 *   - createTestAccounts: テストアカウントを7名追加
 *
 * @returns {void}
 */
function runAllMigrationsV21() {
  Logger.log('╔══════════════════════════════════════════════╗');
  Logger.log('║   v2.1.0 全マイグレーション 一括実行         ║');
  Logger.log('╚══════════════════════════════════════════════╝');

  Logger.log('\n▶ Step 1: 人員マスタに論理削除列を追加...');
  addIsDeletedColumn();

  Logger.log('\n▶ Step 2: 申請管理シートを16列に拡張...');
  migrateRequestSheet();

  Logger.log('\n▶ Step 3: テストアカウントを作成...');
  createTestAccounts();

  Logger.log('\n✅ v2.1.0 全マイグレーション完了');
  Logger.log('   スプレッドシートで各シートを確認してください。');
}

/**
 * v2.2.0 マイグレーション: 人員マスタから「所定労働時間」「所定休憩時間」列を削除する。
 *
 * 【実行前に必ずやること】
 *   1. スプレッドシートをバックアップ（「ファイル→コピーを作成」）
 *   2. GASを v2.2.0 にデプロイ済みであること
 *
 * 【何をするか】
 *   - 旧G列（所定労働時間）を削除する
 *   - 削除後に旧J列（所定休憩時間）がI列に移動するので、そのI列を削除する
 *   - 結果: 25列 → 23列になる
 *
 * 【二重実行防止】
 *   G列ヘッダーが「所定労働時間」でない場合は中断する（適用済み判定）
 *
 * @returns {void}
 */
function migrateRemoveUnusedColumns() {
  _printTestBanner('migrateRemoveUnusedColumns', 'MIGRATION v2.2.0');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.EMPLOYEES);
  if (!sheet) {
    Logger.log('[migrateRemoveUnusedColumns] エラー: 人員マスタが見つかりません。');
    return;
  }

  // 二重実行防止: G列（7列目）のヘッダーが「所定労働時間」でなければ適用済みと判断
  var headerG = sheet.getRange(1, 7).getValue();
  if (headerG !== '所定労働時間') {
    Logger.log('[migrateRemoveUnusedColumns] 中断: G列が「所定労働時間」ではありません（現在: %s）。', headerG);
    Logger.log('[migrateRemoveUnusedColumns] 既に適用済みか、列構成が異なります。スプレッドシートを確認してください。');
    return;
  }

  // バックアップ作成
  var backupName = _createEmployeeBackup(ss, sheet);
  Logger.log('[migrateRemoveUnusedColumns] バックアップ作成完了: %s', backupName);

  // Step 1: G列（所定労働時間 = 7列目）を削除する
  sheet.deleteColumn(7);
  Logger.log('[migrateRemoveUnusedColumns] G列（所定労働時間）を削除しました。');
  SpreadsheetApp.flush();

  // Step 2: 削除後、旧J列（所定休憩時間）は現在I列（9列目）になっている
  //   削除前: G=所定労働時間, H=所定始業, I=所定終業, J=所定休憩
  //   G削除後: G=所定始業,    H=所定終業, I=所定休憩
  // → I列（9列目）を削除する
  var headerI = sheet.getRange(1, 9).getValue();
  Logger.log('[migrateRemoveUnusedColumns] 現在のI列ヘッダー: %s', headerI);
  if (headerI === '所定休憩時間(分)') {
    sheet.deleteColumn(9);
    Logger.log('[migrateRemoveUnusedColumns] I列（所定休憩時間）を削除しました。');
    SpreadsheetApp.flush();
  } else {
    Logger.log('[migrateRemoveUnusedColumns] ⚠️ I列が「所定休憩時間(分)」ではありません（現在: %s）。手動確認が必要です。', headerI);
  }

  // 最終ヘッダー確認
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  Logger.log('[migrateRemoveUnusedColumns] ✅ 完了。現在の列数: %d', lastCol);
  Logger.log('[migrateRemoveUnusedColumns] ヘッダー: %s', headers.join(', '));
}

/**
 * v2.2.0 全マイグレーションを一括実行する。
 *
 * 【実行手順】
 *   1. GASを v2.2.0 にデプロイする
 *   2. スプレッドシートをバックアップする（ファイル→コピーを作成）
 *   3. GASエディタで runAllMigrationsV22 を選択して▶実行
 *   4. 実行ログでテストアカウントのPIN/PWをメモする
 *
 * @returns {void}
 */
function runAllMigrationsV22() {
  Logger.log('╔══════════════════════════════════════════════╗');
  Logger.log('║   v2.2.0 全マイグレーション 一括実行         ║');
  Logger.log('╚══════════════════════════════════════════════╝');

  Logger.log('\n▶ Step 1: 所定労働時間・所定休憩時間 列を削除...');
  migrateRemoveUnusedColumns();

  Logger.log('\n▶ Step 2: 申請管理シートを16列に拡張（未実行の場合）...');
  migrateRequestSheet();

  Logger.log('\n▶ Step 3: テストアカウントを作成（未作成の場合）...');
  createTestAccounts();

  Logger.log('\n✅ v2.2.0 全マイグレーション完了');
  Logger.log('   スプレッドシートで人員マスタが23列になっているか確認してください。');
}



/**
 * v2.3.0 マイグレーション: 人員マスタの「社長」を「管理者」に一括変換する。
 *
 * 【実行タイミング】
 *   GAS を v2.3.0 にデプロイした直後に1回だけ実行する。
 *   2回目以降は「社長」が存在しないため何もしない（冪等）。
 *
 * @returns {void}
 */
function migrateRoleShachoToKanrisha() {
  _printTestBanner('migrateRoleShachoToKanrisha', 'MIGRATION v2.3.0');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.EMPLOYEES);
  if (!sheet) {
    Logger.log('[migrateRoleShachoToKanrisha] エラー: 人員マスタが見つかりません。');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[migrateRoleShachoToKanrisha] データが存在しません。');
    return;
  }

  // 管理権限列（N列=14列目）を全行読み込む
  var roleRange  = sheet.getRange(2, EMPLOYEE_COL.ADMIN_ROLE, lastRow - 1, 1);
  var roleValues = roleRange.getValues();
  var count = 0;

  roleValues.forEach(function(row, i) {
    if (String(row[0]).trim() === '社長') {
      roleValues[i][0] = '管理者';
      count++;
    }
  });

  if (count === 0) {
    Logger.log('[migrateRoleShachoToKanrisha] 「社長」のレコードが見つかりません。適用済みかもしれません。');
    return;
  }

  roleRange.setValues(roleValues);
  SpreadsheetApp.flush();
  Logger.log('[migrateRoleShachoToKanrisha] ✅ 完了。%d 件を「社長」→「管理者」に変換しました。', count);
}

/**
 * v2.3.0 全マイグレーションを一括実行する。
 *
 * @returns {void}
 */
function runAllMigrationsV23() {
  Logger.log('╔══════════════════════════════════════════════╗');
  Logger.log('║   v2.3.0 全マイグレーション 一括実行         ║');
  Logger.log('╚══════════════════════════════════════════════╝');

  Logger.log('\n▶ 人員マスタの「社長」→「管理者」に変換...');
  migrateRoleShachoToKanrisha();

  Logger.log('\n✅ v2.3.0 完了。人員マスタを確認してください。');
}

// ============================================================
// 本番環境セットアップ
// ============================================================

/**
 * 新規スプレッドシートに必要な全シートをヘッダー付きで自動作成する。
 *
 * 【用途】
 *   テスト環境から本番環境へ移行する際に、新しい空のスプレッドシートで
 *   この関数を1回実行するだけで運用開始できる状態になる。
 *
 * 【実行手順】
 *   1. 新しいGoogleスプレッドシートを作成する
 *   2. 拡張機能 → Apps Script でこのプロジェクトのコードを貼り付ける
 *   3. GASのデプロイURL（GAS_URL）をフロントの admin.html / kintai.html に設定する
 *   4. GASエディタで「setupNewSpreadsheet」を選択して ▶ 実行
 *   5. 実行ログで「✅ セットアップ完了」を確認する
 *   6. スプレッドシートで全シートが作成されているか目視確認する
 *   7. スタッフ管理タブから管理者アカウントを登録する
 *
 * 【作成されるシート一覧】
 *   - 出退勤記録（12列）
 *   - 人員マスタ（22列）
 *   - 申請管理（16列）
 *   - 会社カレンダー（3列）
 *   - 給与設定（2列）
 *   - インセンティブ（8列）
 *   - 操作ログ（7列）
 *   - 残業指示（9列）
 *   - 納期管理（7列）
 *   - タスク管理（7列）
 *
 * 【冪等性】
 *   既に同名シートが存在する場合はスキップする（上書きしない）。
 *   2回実行しても安全。
 *
 * @returns {void}
 */
function setupNewSpreadsheet() {
  Logger.log('╔══════════════════════════════════════════════════╗');
  Logger.log('║   新規スプレッドシート セットアップ              ║');
  Logger.log('╚══════════════════════════════════════════════════╝');

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── 作成するシートの定義 ─────────────────────────────────────
  // name  : シート名（SHEET 定数と一致させること）
  // headers: 1行目に書き込む日本語ヘッダー（列順は各 _COL 定数と一致）
  var SHEET_DEFS = [

    // ① 出退勤記録（ATTENDANCE_COL 準拠・12列）
    {
      name: SHEET.ATTENDANCE,
      headers: [
        'ID',             // A(1)
        '従業員ID',       // B(2)
        '日付',           // C(3)
        'ステータス',     // D(4)
        '出勤時刻',       // E(5)
        '退勤時刻',       // F(6)
        '休憩時間(分)',   // G(7)
        '実働時間(分)',   // H(8)
        '弁当',           // I(9)  '有' | '無'
        '業務報告',       // J(10)
        '修正理由',       // K(11)
        '更新日時',       // L(12)
      ],
    },

    // ② 人員マスタ（EMPLOYEE_HEADERS_JA 準拠・22列）
    // EMPLOYEE_HEADERS_JA は Migration.gs の先頭で定義済みなのでそのまま使う
    {
      name: SHEET.EMPLOYEES,
      headers: EMPLOYEE_HEADERS_JA,
    },

    // ③ 申請管理（REQ_COL 準拠・16列）
    {
      name: SHEET.REQUESTS,
      headers: [
        'ID',             // A(1)
        '申請者ID',       // B(2)
        '申請者名',       // C(3)
        'ステータス',     // D(4)  'pending'|'approved'|'rejected'|'cancelled'
        '種別',           // E(5)  '休み'|'遅刻'|'早退'|'早出'|'外出勤務'|'残業'
        '対象日',         // F(6)  YYYY-MM-DD
        '理由',           // G(7)
        '承認フロー',     // H(8)
        '承認者ID',       // I(9)
        '承認日時',       // J(10)
        '却下理由',       // K(11)
        '申請日時',       // L(12)
        '申請時刻',       // M(13) 遅刻・早退・早出の予定時刻
        '遅刻時間',       // N(14)
        '早退時間',       // O(15)
        '申請種別区分',   // P(16) 'fillup'|'paid'|'none'
      ],
    },

    // ④ 会社カレンダー（3列）
    {
      name: SHEET.COMPANY_CAL,
      headers: [
        '日付',           // A(1) YYYY-MM-DD
        'タイトル',       // B(2) 会社休日・行事名
        '登録日時',       // C(3)
      ],
    },

    // ⑤ 給与設定（2列）
    {
      name: SHEET.PAYROLL_SETTINGS,
      headers: [
        '設定キー',       // A(1)
        '設定値',         // B(2)
      ],
      // 給与設定はヘッダーだけでなくデフォルト値も書き込む
      defaultRows: [
        ['health_insurance_rate',              5.015],
        ['care_insurance_rate',                0.795],
        ['pension_rate',                       9.15],
        ['employment_insurance_rate',          0.55],
        ['health_insurance_rate_company',      5.015],
        ['care_insurance_rate_company',        0.795],
        ['pension_rate_company',               9.15],
        ['employment_insurance_rate_company',  0.90],
        ['overtime_rate',                      0],    // 割り増しなし
        ['holiday_rate',                       35],
        ['late_night_rate',                    50],
        ['lunch_price',                        150],
      ],
    },

    // ⑥ インセンティブ（8列）
    {
      name: SHEET.INCENTIVES,
      headers: [
        'ID',             // A(1)
        '対象年月',       // B(2) YYYY-MM
        '従業員ID',       // C(3)
        '従業員名',       // D(4)
        '項目名',         // E(5)
        '金額(円)',       // F(6)
        '備考',           // G(7)
        '登録日時',       // H(8)
      ],
    },

    // ⑦ 操作ログ（7列）
    {
      name: SHEET.AUDIT_LOG,
      headers: [
        '日時',           // A(1)
        '操作者ID',       // B(2)
        '操作者名',       // C(3)
        '対象',           // D(4)
        '操作種別',       // E(5)
        '詳細',           // F(6)
        '理由',           // G(7)
      ],
    },

    // ⑧ 残業指示（9列）
    {
      name: SHEET.OVERTIME_INST,
      headers: [
        'ID',             // A(1)
        '従業員ID',       // B(2)
        '従業員名',       // C(3)
        '対象日',         // D(4) YYYY-MM-DD
        '見込み時間',     // E(5) HH:MM
        '実績時間',       // F(6) HH:MM
        'ステータス',     // G(7) 'pending'|'confirmed'|'rejected'
        'コメント',       // H(8)
        '登録日時',       // I(9)
      ],
    },

    // ⑨ 納期管理（7列）
    {
      name: SHEET.DEADLINES,
      headers: [
        'ID',             // A(1)
        '従業員ID',       // B(2)
        '担当者名',       // C(3)
        '案件名',         // D(4)
        'DATA',           // E(5) JSON（phases / client / memo / file_paths 等）
        '登録日時',       // F(6)
        '更新日時',       // G(7)
      ],
    },

    // ⑩ タスク管理（7列）
    {
      name: SHEET.TASKS,
      headers: [
        'ID',             // A(1)
        '従業員ID',       // B(2)
        'タイトル',       // C(3)
        '詳細',           // D(4)
        'ステータス',     // E(5)
        '期限',           // F(6)
        '更新日時',       // G(7)
      ],
    },
  ];

  // ── シートを順番に作成する ────────────────────────────────────
  var created = [];
  var skipped = [];

  SHEET_DEFS.forEach(function(def) {
    var existing = ss.getSheetByName(def.name);

    if (existing) {
      // 既に存在する場合はスキップ（上書きしない・冪等性を保証）
      Logger.log('[setupNewSpreadsheet] スキップ（既存）: %s', def.name);
      skipped.push(def.name);
      return;
    }

    // 新規シートを作成してヘッダーを書き込む
    var sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);

    // ヘッダー行を装飾する（視認性向上）
    var headerRange = sheet.getRange(1, 1, 1, def.headers.length);
    headerRange.setBackground('#4a5568');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1); // 1行目を固定

    // デフォルト値がある場合は書き込む（給与設定など）
    if (def.defaultRows && def.defaultRows.length > 0) {
      sheet.getRange(2, 1, def.defaultRows.length, def.defaultRows[0].length)
           .setValues(def.defaultRows);
      Logger.log('[setupNewSpreadsheet] デフォルト値書き込み: %s (%d行)', def.name, def.defaultRows.length);
    }

    SpreadsheetApp.flush();
    Logger.log('[setupNewSpreadsheet] 作成完了: %s (%d列)', def.name, def.headers.length);
    created.push(def.name);
  });

  // 最初から存在する「シート1」（デフォルトシート）を末尾に移動して非表示にする。
  // 運用上は使わないが、GASの仕様上削除できない場合があるため非表示で対応する。
  var defaultSheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && created.length > 0) {
    try {
      defaultSheet.hideSheet();
      Logger.log('[setupNewSpreadsheet] デフォルトシートを非表示にしました。');
    } catch(e) {
      Logger.log('[setupNewSpreadsheet] デフォルトシートの非表示化をスキップ: %s', e.message);
    }
  }

  // ── 完了レポート ───────────────────────────────────────────────
  Logger.log('');
  Logger.log('╔══════════════════════════════════════════════════╗');
  Logger.log('║   ✅ セットアップ完了                            ║');
  Logger.log('╚══════════════════════════════════════════════════╝');
  Logger.log('作成したシート（%d件）: %s', created.length, created.join(', '));
  Logger.log('スキップしたシート（%d件）: %s', skipped.length, skipped.join(', ') || 'なし');
  Logger.log('');
  Logger.log('【次のステップ】');
  Logger.log('1. スプレッドシートで全シートが正しく作成されているか確認する');
  Logger.log('2. GASをウェブアプリとしてデプロイする');
  Logger.log('3. デプロイURLを admin.html / kintai.html の GAS_URL に設定する');
  Logger.log('4. admin.html からログインし、スタッフ管理で管理者アカウントを登録する');
  Logger.log('5. 設定タブで会社カレンダー（休日）を登録する');
}
