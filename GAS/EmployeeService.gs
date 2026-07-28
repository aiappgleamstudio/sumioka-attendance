/**
 * EmployeeService.gs — 人員マスタサービス
 *
 * 役割:
 *   職員・利用者マスタ（人員マスタ）の CRUD を実装する。
 *   Code.gs から分離した2番目のサービスファイル。
 *
 * 設計方針:
 *   - data.id の有無で新規作成/更新を切り替える upsert パターン
 *   - PIN・パスワード・所定始業/終業はテキスト形式を強制する
 *     （先頭ゼロ消失・1899-12-30問題を防ぐため）
 *   - rowToEmployee は人員マスタの行をAPIレスポンス形式に変換する中心関数。
 *     TaskService.gs / ProjectService.gs / AuthService.gs など多数のファイルから
 *     参照される（GASは同一プロジェクト内でグローバル共有のため問題なし）
 *
 * エントリポイント:
 *   handleEmployeeAction(action, data, employeeSheet) — Code.gs の switch から委譲される
 *
 * 実装するアクション:
 *   save_employee   - 職員・利用者の登録・更新（upsert）
 *   load_employees  - 全職員・利用者を取得
 *   delete_employee - 職員・利用者を削除（物理削除）
 *
 * 依存ファイル:
 *   Code.gs — generateId / getAllRows / createSuccessResponse /
 *             createErrorResponse / _safeTimeStr / EMPLOYEE_COL / EMPLOYEE_NUM_COLS
 *
 * 注意:
 *   _safeTimeStr は AttendanceService.gs の rowToAttendanceRecord からも
 *   使われる共通関数のため、本ファイルへは移動せず Code.gs に残している。
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

/**
 * 人員マスタ系アクションのハンドラ。
 *
 * Code.gs の handleAttendance() switch 文から以下のように委譲される:
 *   case 'save_employee':
 *   case 'load_employees':
 *   case 'delete_employee':
 *     return handleEmployeeAction(action, data, employeeSheet);
 *
 * @param {string} action
 * @param {Object} data
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @returns {ContentService.TextOutput}
 */
function handleEmployeeAction(action, data, employeeSheet) {
  try {
    switch (action) {

      case 'save_employee':
        return createSuccessResponse(saveEmployee(employeeSheet, data));

      case 'load_employees':
        return createSuccessResponse(loadEmployees(employeeSheet));

      case 'delete_employee':
        return createSuccessResponse(deleteEmployee(employeeSheet, data.id));

      default:
        throw new Error('EmployeeService: 未定義のアクションです: ' + action);
    }

  } catch (err) {
    Logger.log('[handleEmployeeAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}


// ============================================================
// 人員マスタ CRUD
// ============================================================

/**
 * 人員マスタの指定行に対し、文字列として扱うべき列の書式を設定する。
 * setValues より必ず前に呼ぶこと（順序が逆だと効果がない）。
 *
 * 設定対象:
 *   D列（PIN）       : 先頭0が消えるのを防ぐ
 *   E列（パスワード）: 同上
 *   G列（所定始業）  : 1899-12-30 問題を防ぐ
 *   H列（所定終業）  : 同上
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowNum - 1始まりの行番号
 */
function _setEmployeeTextFormat(sheet, rowNum) {
  sheet.getRange(rowNum, EMPLOYEE_COL.PIN            ).setNumberFormat('@');
  sheet.getRange(rowNum, EMPLOYEE_COL.PASSWORD       ).setNumberFormat('@');
  sheet.getRange(rowNum, EMPLOYEE_COL.SCHEDULED_START).setNumberFormat('@');
  sheet.getRange(rowNum, EMPLOYEE_COL.SCHEDULED_END  ).setNumberFormat('@');
}

/**
 * 職員・利用者を登録または更新する（upsert）。
 * data.id があれば上書き、なければ新規登録。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @returns {{ id: string, saved: boolean }}
 */
function saveEmployee(sheet, data) {
  // 後方互換: name（旧フォーマット）が渡された場合は姓・名に分割する
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

  const now      = new Date().toISOString();
  const ed       = data.employee_data || {};
  const workDays = Array.isArray(ed.work_days) ? ed.work_days.join(',') : (ed.work_days || '');
  const pinStr   = String(data.pin      ?? '');
  const pwStr    = String(data.password ?? '');

  // EMPLOYEE_COL の定義順と必ず一致させること（23列）
  const buildRow = (id, createdAt) => [
    id,
    lastName,
    firstName,
    pinStr,
    pwStr,
    ed.employment_type    || '',
    ed.scheduled_start    || '',
    ed.scheduled_end      || '',
    ed.wage_type          || '',
    ed.hourly_wage        ?? '',
    ed.monthly_wage       ?? '',
    ed.default_lunch === true ? '有' : '無',
    workDays,
    ed.admin_role         || '',
    ed.location           || '',
    ed.job_type           || '',
    ed.ins_health     === true ? '加入' : '未加入',
    ed.ins_care       === true ? '加入' : '未加入',
    ed.ins_pension    === true ? '加入' : '未加入',
    ed.ins_employment === true ? '加入' : '未加入',
    createdAt,
    now,
    '',
  ];

  const rows = getAllRows(sheet);

  if (data.id) {
    const rowIndex = rows.findIndex(r => r[EMPLOYEE_COL.ID - 1] === data.id);
    if (rowIndex === -1) throw new Error('指定された id の職員が見つかりません: ' + data.id);

    const sheetRowNum = rowIndex + 2;
    const createdAt   = rows[rowIndex][EMPLOYEE_COL.CREATED_AT - 1];
    _setEmployeeTextFormat(sheet, sheetRowNum);
    sheet.getRange(sheetRowNum, 1, 1, EMPLOYEE_NUM_COLS).setValues([buildRow(data.id, createdAt)]);

    Logger.log('[saveEmployee] Updated: id=%s', data.id);
    return { id: data.id, saved: true };

  } else {
    const newId     = generateId();
    const newRowNum = sheet.getLastRow() + 1;
    _setEmployeeTextFormat(sheet, newRowNum);
    sheet.getRange(newRowNum, 1, 1, EMPLOYEE_NUM_COLS).setValues([buildRow(newId, now)]);

    Logger.log('[saveEmployee] Created: id=%s', newId);
    return { id: newId, saved: true };
  }
}

/**
 * 全職員・利用者を取得する。
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
 * 職員・利用者を削除する（物理削除）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} id
 * @returns {{ deleted: boolean, id: string }}
 */
function deleteEmployee(sheet, id) {
  if (!id) throw new Error('id は必須です。');

  const rows     = getAllRows(sheet);
  const rowIndex = rows.findIndex(r => r[EMPLOYEE_COL.ID - 1] === id);

  if (rowIndex === -1) throw new Error('指定された id の職員が見つかりません: ' + id);

  sheet.deleteRow(rowIndex + 2);
  Logger.log('[deleteEmployee] Deleted: id=%s', id);
  return { deleted: true, id };
}


// ============================================================
// 行→オブジェクト変換
// ============================================================

/**
 * 人員マスタの1行データを職員オブジェクトに変換する。
 * EMPLOYEE_COL の定義と必ず一致させること。
 *
 * 多数のファイル（TaskService.gs / ProjectService.gs / AuthService.gs等）
 * から参照される中心関数。変更時は影響範囲を必ず確認すること。
 *
 * @param {Array} row
 * @returns {Object}
 */
function rowToEmployee(row) {
  const workDaysRaw = row[EMPLOYEE_COL.WORK_DAYS - 1] || '';
  const workDays    = workDaysRaw
    ? String(workDaysRaw).split(',').map(d => d.trim()).filter(Boolean)
    : [];

  const lastName  = String(row[EMPLOYEE_COL.LAST_NAME  - 1] || '');
  const firstName = String(row[EMPLOYEE_COL.FIRST_NAME - 1] || '');

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
    // scheduled_hours: シートに列がないため start/end から算出する
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
    scheduled_break : null,  // シートに列なし
    wage_type       : row[EMPLOYEE_COL.WAGE_TYPE    - 1] || '',
    hourly_wage     : row[EMPLOYEE_COL.HOURLY_WAGE  - 1] === '' ? '' : Number(row[EMPLOYEE_COL.HOURLY_WAGE  - 1]),
    monthly_wage    : row[EMPLOYEE_COL.MONTHLY_WAGE - 1] === '' ? '' : Number(row[EMPLOYEE_COL.MONTHLY_WAGE - 1]),
    default_lunch   : row[EMPLOYEE_COL.DEFAULT_LUNCH - 1] === '有',
    work_days       : workDays,
    // admin_role: 旧フォーマット後方互換付き
    admin_role      : (() => {
      const raw = String(row[EMPLOYEE_COL.ADMIN_ROLE - 1] || '');
      if (raw === '可')   return '管理者';
      if (raw === '不可') return '';
      if (raw === '社長') return '管理者';
      return ['管理者', '給与計算担当', '一般職員'].includes(raw) ? raw : '';
    })(),
    // 後方互換: is_admin フラグ
    is_admin        : (() => {
      const raw = String(row[EMPLOYEE_COL.ADMIN_ROLE - 1] || '');
      return raw === '可' || raw === '社長' || ['管理者', '給与計算担当', '一般職員'].includes(raw);
    })(),
    location       : String(row[EMPLOYEE_COL.LOCATION       - 1] || ''),
    job_type       : String(row[EMPLOYEE_COL.JOB_TYPE       - 1] || ''),
    ins_health     : row[EMPLOYEE_COL.INS_HEALTH     - 1] === '加入',
    ins_care       : row[EMPLOYEE_COL.INS_CARE       - 1] === '加入',
    ins_pension    : row[EMPLOYEE_COL.INS_PENSION    - 1] === '加入',
    ins_employment : row[EMPLOYEE_COL.INS_EMPLOYMENT - 1] === '加入',
    created_at     : row[EMPLOYEE_COL.CREATED_AT     - 1],
    updated_at     : row[EMPLOYEE_COL.UPDATED_AT     - 1],
    deleted        : String(row[EMPLOYEE_COL.DELETED - 1] || '') === 'true',
  };
}
