/**
 * AuthService.gs — 認証サービス
 *
 * 役割:
 *   PIN + パスワードによる認証処理を実装する。
 *   Code.gs から分離した3番目のサービスファイル。
 *
 * 設計方針:
 *   - admin.html 用（管理者・admin_role 必須）と
 *     user.html / staff.html 用（全ロール許可）を別アクションに分離する
 *   - 別アクションにすることで、フロントからの source フラグ偽装を防ぐ
 *     （「自分は管理者だ」と偽って admin_role チェックを回避できないようにする）
 *   - エラーメッセージは認証失敗の理由を問わず統一する（情報漏洩防止）
 *
 * エントリポイント:
 *   handleAuthAction(action, data, employeeSheet) — Code.gs の switch から委譲される
 *
 * 実装するアクション:
 *   authenticate        - 管理者・職員専用認証（admin_role が空でない場合のみ許可）
 *   kintai_authenticate - 全ロール共通認証（利用者・職員・管理者すべて許可）
 *
 * 依存ファイル:
 *   Code.gs           — getAllRows / createSuccessResponse / createErrorResponse / EMPLOYEE_COL
 *   EmployeeService.gs — rowToEmployee
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

/**
 * 認証系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'authenticate':
 *   case 'kintai_authenticate':
 *     return handleAuthAction(action, data, employeeSheet);
 *
 * @param {string} action
 * @param {Object} data
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @returns {ContentService.TextOutput}
 */
function handleAuthAction(action, data, employeeSheet) {
  try {
    switch (action) {

      case 'authenticate':
        // Admin用：admin_role が空でない職員のみ通す（admin.html から呼ばれる）
        return createSuccessResponse(
          authenticateEmployee(employeeSheet, data.pin, data.password)
        );

      case 'kintai_authenticate':
        // 全ユーザー用：PIN+PWが一致すれば全員通す（user.html / staff.html から呼ばれる）
        return createSuccessResponse(
          authenticateKintaiEmployee(employeeSheet, data.pin, data.password)
        );

      default:
        throw new Error('AuthService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleAuthAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 認証
// ============================================================

/**
 * PIN + パスワードで管理者・職員を認証する（admin.html 用）。
 *
 * 認証ルール:
 *   - employment_type === '職員' かつ admin_role が空でない場合のみ許可
 *   - 利用者・admin_role が空の職員はログイン不可
 *   - エラーメッセージは統一する（情報漏洩防止）
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} pin
 * @param {string} password
 * @returns {{ employee: Object }}
 */
function authenticateEmployee(sheet, pin, password) {
  if (!pin)      throw new Error('PIN は必須です。');
  if (!password) throw new Error('パスワードは必須です。');

  const rows    = getAllRows(sheet);
  const matched = rows.find(row =>
    String(row[EMPLOYEE_COL.PIN      - 1]) === String(pin) &&
    String(row[EMPLOYEE_COL.PASSWORD - 1]) === String(password)
  );

  if (!matched) throw new Error('PIN またはパスワードが正しくありません。');

  const employee = rowToEmployee(matched);
  const canLogin = employee.employment_type === '職員' && employee.admin_role !== '';

  if (!canLogin) {
    Logger.log('[authenticateEmployee] ログイン拒否: id=%s, type=%s, role=%s',
      employee.id, employee.employment_type, employee.admin_role);
    throw new Error('PIN またはパスワードが正しくありません。');
  }

  delete employee.password;
  Logger.log('[authenticateEmployee] 認証成功: id=%s, name=%s', employee.id, employee.name);
  return { employee };
}

/**
 * PIN + パスワードで全ユーザーを認証する（user.html / staff.html 用）。
 *
 * Admin用 authenticateEmployee との違い:
 *   - employment_type / admin_role のチェックを行わない
 *   - PIN + パスワードが一致すれば誰でもログイン可
 *   - 画面側でロールに応じた表示切替を行う
 *
 * 別アクションにすることで、フロントからの source フラグ偽装を防ぐ。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} pin
 * @param {string} password
 * @returns {{ employee: Object }}
 */
function authenticateKintaiEmployee(sheet, pin, password) {
  if (!pin)      throw new Error('PIN は必須です。');
  if (!password) throw new Error('パスワードは必須です。');

  const rows    = getAllRows(sheet);
  const matched = rows.find(row =>
    String(row[EMPLOYEE_COL.PIN      - 1]) === String(pin) &&
    String(row[EMPLOYEE_COL.PASSWORD - 1]) === String(password)
  );

  if (!matched) throw new Error('PIN またはパスワードが正しくありません。');

  const employee = rowToEmployee(matched);
  delete employee.password;

  Logger.log('[authenticateKintaiEmployee] 認証成功: id=%s, name=%s, type=%s',
    employee.id, employee.name, employee.employment_type);

  return { employee };
}
