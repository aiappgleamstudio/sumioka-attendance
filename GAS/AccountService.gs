/**
 * AccountService.gs — アカウント管理サービス
 *
 * 役割:
 *   portal.html の管理ゾーン「アカウント管理」タブ（管理者のみ）向けに、
 *   ログインアカウント情報の CRUD を実装する。
 *
 * 設計方針:
 *   - 「人員マスタ」とは別シート「アカウント管理」に保存する
 *     （人員マスタは勤怠・給与計算のための人員台帳、アカウント管理は
 *      システムログイン権限の台帳としてデータの粒度が異なるため統合しない）
 *   - 権限チェックは admin_role === '管理者' のみ許可する
 *     （_getPermLevelAccount / _requirePermAccount。ProjectService.gs の
 *      _getPermLevelProj と同一パターン。Lv3=管理者のみ許可、それ未満は拒否）
 *   - 論理削除方式（物理削除しない）
 *   - PIN・パスワードはテキスト形式で保存する（先頭0消失防止）
 *
 * エントリポイント:
 *   handleAccountAction(action, data) — Code.gs の switch から委譲される
 *
 * 実装するアクション:
 *   get_accounts    - アカウント一覧取得（管理者のみ）
 *   save_account    - アカウント登録・更新（管理者のみ）
 *   delete_account  - アカウント論理削除（管理者のみ）
 *
 * 依存ファイル:
 *   Code.gs — generateId / getAllRows / getOrCreateSheet /
 *             createSuccessResponse / createErrorResponse / SHEET / EMPLOYEE_COL
 *   EmployeeService.gs — rowToEmployee（操作者の権限確認に使用）
 *
 * 注意:
 *   portal.html の「アカウント管理」タブは本実装時点ではプレースホルダーのみで
 *   まだ配線されていない（次フェーズで実装予定）。本ファイルはバックエンドの
 *   受け口のみを用意するもので、アカウントのフィールド構成は今後タブを実装する
 *   際に必要に応じて見直すこと。
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// 定数
// ============================================================

/**
 * アカウント管理シートの列番号定数（1始まり）。
 *
 * 列構成（9列）:
 *   A(1): ID          - UUID
 *   B(2): 氏名        - アカウント表示名
 *   C(3): ユーザー名   - ログインID（任意運用、未使用なら空でよい）
 *   D(4): PIN         - ログイン用PIN（文字列として保存）
 *   E(5): パスワード   - 文字列として保存
 *   F(6): 権限        - '管理者' | '給与計算担当' | '一般職員'
 *   G(7): 登録日時     - ISO 8601
 *   H(8): 更新日時     - ISO 8601
 *   I(9): 論理削除     - 'true' | ''
 */
var ACCOUNT_COL = {
  ID         : 1,
  NAME       : 2,
  USERNAME   : 3,
  PIN        : 4,
  PASSWORD   : 5,
  ROLE       : 6,
  CREATED_AT : 7,
  UPDATED_AT : 8,
  DELETED    : 9,
};
var ACCOUNT_NUM_COLS = 9;

/**
 * アカウント管理シートを初期化する（冪等）。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initAccountSheet(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, ACCOUNT_NUM_COLS).setValues([[
      'ID', '氏名', 'ユーザー名', 'PIN', 'パスワード', '権限', '登録日時', '更新日時', '論理削除'
    ]]);
    sheet.getRange(1, ACCOUNT_COL.PIN).setNumberFormat('@');
    sheet.getRange(1, ACCOUNT_COL.PASSWORD).setNumberFormat('@');
  }
}

/**
 * アカウント管理シートの行データをオブジェクトに変換する。
 * @param {Array} row
 * @returns {Object}
 */
function rowToAccount(row) {
  return {
    id         : String(row[ACCOUNT_COL.ID         - 1] || ''),
    name       : String(row[ACCOUNT_COL.NAME       - 1] || ''),
    username   : String(row[ACCOUNT_COL.USERNAME   - 1] || ''),
    pin        : String(row[ACCOUNT_COL.PIN        - 1] || ''),
    role       : String(row[ACCOUNT_COL.ROLE       - 1] || ''),
    created_at : String(row[ACCOUNT_COL.CREATED_AT - 1] || ''),
    updated_at : String(row[ACCOUNT_COL.UPDATED_AT - 1] || ''),
    deleted    : String(row[ACCOUNT_COL.DELETED    - 1] || '') === 'true',
  };
}

// ============================================================
// 権限チェック（他 Service の _getPermLevelXxx / _requirePermXxx と同一パターン）
// ============================================================

/**
 * operator_id から操作者の職員情報を取得する。
 * @param {string} operatorId
 * @returns {Object}
 */
function _getOperatorAccount(operatorId) {
  if (!operatorId) throw new Error('operator_id は必須です。');
  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var empSheet = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var rows     = getAllRows(empSheet);
  var row      = rows.find(function(r) {
    return String(r[EMPLOYEE_COL.ID      - 1]) === String(operatorId) &&
           String(r[EMPLOYEE_COL.DELETED - 1]) !== 'true';
  });
  if (!row) throw new Error('操作者が見つかりません: ' + operatorId);
  return rowToEmployee(row);
}

/**
 * 権限レベルを返す（AccountService 内部用）。
 * @param {Object} employee
 * @returns {number} 3=管理者, 0=それ以外
 */
function _getPermLevelAccount(employee) {
  if (!employee) return 0;
  if (employee.admin_role === '管理者') return 3;
  return 0;
}

/**
 * 権限レベルチェック。不足していれば例外を投げる。
 * @param {Object} employee
 * @param {number} required
 * @param {string} [context]
 */
function _requirePermAccount(employee, required, context) {
  if (_getPermLevelAccount(employee) < required) {
    throw new Error((context || 'アカウント管理') + ' を行う権限がありません。管理者のみ操作できます。');
  }
}

// ============================================================
// エントリポイント
// ============================================================

/**
 * アカウント管理系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'get_accounts':
 *   case 'save_account':
 *   case 'delete_account':
 *     return handleAccountAction(action, data);
 *
 * @param {string} action
 * @param {Object} data
 * @returns {ContentService.TextOutput}
 */
function handleAccountAction(action, data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (action) {
      case 'get_accounts':
        return createSuccessResponse(getAccounts(ss, data));

      case 'save_account':
        return createSuccessResponse(saveAccount(ss, data));

      case 'delete_account':
        return createSuccessResponse(deleteAccount(ss, data));

      default:
        throw new Error('AccountService: 未定義のアクションです: ' + action);
    }
  } catch (err) {
    Logger.log('[handleAccountAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}

// ============================================================
// アカウント CRUD
// ============================================================

/**
 * アカウント一覧を取得する（管理者のみ）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data - { operator_id }
 * @returns {{ accounts: Object[] }}
 */
function getAccounts(ss, data) {
  var operator = _getOperatorAccount(data.operator_id);
  _requirePermAccount(operator, 3, 'アカウント一覧の取得');

  var sheet = getOrCreateSheet(ss, SHEET.ACCOUNTS);
  initAccountSheet(sheet);

  var accounts = getAllRows(sheet)
    .map(rowToAccount)
    .filter(function(a) { return !a.deleted; });

  return { accounts: accounts };
}

/**
 * アカウントを登録・更新する（管理者のみ）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data - { operator_id, id?, name, username?, pin, password, role }
 * @returns {{ id: string, saved: boolean }}
 */
function saveAccount(ss, data) {
  var operator = _getOperatorAccount(data.operator_id);
  _requirePermAccount(operator, 3, 'アカウントの登録・更新');

  if (!data.name) throw new Error('name は必須です。');
  if (!['管理者', '給与計算担当', '一般職員'].includes(data.role)) {
    throw new Error('role は 管理者・給与計算担当・一般職員 のいずれかを指定してください。');
  }

  var sheet = getOrCreateSheet(ss, SHEET.ACCOUNTS);
  initAccountSheet(sheet);

  var now  = new Date().toISOString();
  var rows = getAllRows(sheet);

  var pinStr      = String(data.pin      ?? '');
  var passwordStr = String(data.password ?? '');

  if (data.id) {
    var rowIndex = rows.findIndex(function(r) { return r[ACCOUNT_COL.ID - 1] === data.id; });
    if (rowIndex === -1) throw new Error('指定された id のアカウントが見つかりません: ' + data.id);

    var sheetRowNum = rowIndex + 2;
    var createdAt   = rows[rowIndex][ACCOUNT_COL.CREATED_AT - 1];

    sheet.getRange(sheetRowNum, ACCOUNT_COL.PIN).setNumberFormat('@');
    sheet.getRange(sheetRowNum, ACCOUNT_COL.PASSWORD).setNumberFormat('@');

    sheet.getRange(sheetRowNum, 1, 1, ACCOUNT_NUM_COLS).setValues([[
      data.id,
      data.name,
      data.username || '',
      pinStr,
      // パスワードが空で送られてきた場合は既存値を維持する（更新のたびに消えないように）
      passwordStr || String(rows[rowIndex][ACCOUNT_COL.PASSWORD - 1] || ''),
      data.role,
      createdAt,
      now,
      '',
    ]]);

    Logger.log('[saveAccount] Updated: id=%s, name=%s', data.id, data.name);
    return { id: data.id, saved: true };

  } else {
    var newId     = generateId();
    var newRowNum = sheet.getLastRow() + 1;

    sheet.getRange(newRowNum, ACCOUNT_COL.PIN).setNumberFormat('@');
    sheet.getRange(newRowNum, ACCOUNT_COL.PASSWORD).setNumberFormat('@');

    sheet.getRange(newRowNum, 1, 1, ACCOUNT_NUM_COLS).setValues([[
      newId,
      data.name,
      data.username || '',
      pinStr,
      passwordStr,
      data.role,
      now,
      now,
      '',
    ]]);

    Logger.log('[saveAccount] Created: id=%s, name=%s', newId, data.name);
    return { id: newId, saved: true };
  }
}

/**
 * アカウントを論理削除する（管理者のみ）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data - { operator_id, id }
 * @returns {{ deleted: boolean, id: string }}
 */
function deleteAccount(ss, data) {
  var operator = _getOperatorAccount(data.operator_id);
  _requirePermAccount(operator, 3, 'アカウントの削除');

  if (!data.id) throw new Error('id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.ACCOUNTS);
  initAccountSheet(sheet);

  var rows     = getAllRows(sheet);
  var rowIndex = rows.findIndex(function(r) { return r[ACCOUNT_COL.ID - 1] === data.id; });
  if (rowIndex === -1) throw new Error('指定された id のアカウントが見つかりません: ' + data.id);

  var rowNum = rowIndex + 2;
  sheet.getRange(rowNum, ACCOUNT_COL.DELETED).setValue('true');
  sheet.getRange(rowNum, ACCOUNT_COL.UPDATED_AT).setValue(new Date().toISOString());
  SpreadsheetApp.flush();

  Logger.log('[deleteAccount] Deleted: id=%s', data.id);
  return { deleted: true, id: data.id };
}
