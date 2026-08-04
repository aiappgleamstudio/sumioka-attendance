/**
 * OvertimeService.gs - 残業指示・残業申請承認フロー
 *
 * 役割:
 *   Admin による残業指示の直接作成・一覧・削除、スタッフによる承認/却下、
 *   Kintai からの残業申請（申請管理シート経由）とその承認/却下・
 *   残業指示シートへの転記を実装する。
 *
 * 設計方針:
 *   - AdminOpsService.gs の handleAdminAction() から委譲される
 *   - RequestService.gs の REQ_COL / initRequestSheet / getAllRequestRows に依存する
 *   - OVERTIME_COL / OVERTIME_NUM_COLS は残業指示シート（14列）の列定義
 *
 * 【2026-07-30 分割】旧 Adminservice.gs（2934行）から残業指示・
 * 残業申請承認フロー一式を分離。
 *
 * @version 1.0.0
 */

'use strict';

/**
 * 残業指示シートの列番号定数（1始まり）。
 *
 * 列構成（14列）:
 *   A(1)  : ID              - UUID
 *   B(2)  : 申請者ID        - employee_id
 *   C(3)  : 申請者名        - スタッフ名
 *   D(4)  : 指示日時        - ISO 8601 形式
 *   E(5)  : 対象日          - YYYY/MM/DD（テキスト形式）
 *   F(6)  : 見込み時間      - HH:MM（テキスト形式）
 *   G(7)  : 実績時間        - HH:MM（テキスト形式、自動計算）
 *   H(8)  : 出勤時刻        - HH:MM（出退勤記録から参照）
 *   I(9)  : 退勤時刻        - HH:MM（出退勤記録から参照）
 *   J(10) : 指示者ID        - 管理者のemployee_id
 *   K(11) : 状態            - 'pending'|'confirmed'|'rejected'|'deleted'
 *   L(12) : スタッフのコメント - スタッフが却下時に理由を入力
 *   M(13) : 登録日時        - ISO 8601
 *   N(14) : 更新日時        - ISO 8601
 */
var OVERTIME_COL = {
  ID              : 1,
  EMPLOYEE_ID     : 2,
  NAME            : 3,
  ISSUED_AT       : 4,
  TARGET_DATE     : 5,
  ESTIMATED_TIME  : 6,
  ACTUAL_TIME     : 7,
  TIME_IN         : 8,
  TIME_OUT        : 9,
  ISSUED_BY       : 10,
  STATUS          : 11,
  COMMENT         : 12,
  CREATED_AT      : 13,
  UPDATED_AT      : 14,
};
var OVERTIME_NUM_COLS = 14;

/**
 * 残業指示シートを初期化する（ヘッダー行がなければ作成）。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initOvertimeInstructionSheet(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, OVERTIME_NUM_COLS).setValues([[
      'ID', '申請者ID', '申請者名', '指示日時', '対象日', '見込み時間', '実績時間',
      '出勤時刻', '退勤時刻', '指示者ID', '状態', 'スタッフのコメント', '登録日時', '更新日時'
    ]]);

    sheet.getRange(1, OVERTIME_COL.TARGET_DATE).setNumberFormat('@');
    sheet.getRange(1, OVERTIME_COL.ESTIMATED_TIME).setNumberFormat('@');
    sheet.getRange(1, OVERTIME_COL.ACTUAL_TIME).setNumberFormat('@');
    sheet.getRange(1, OVERTIME_COL.TIME_IN).setNumberFormat('@');
    sheet.getRange(1, OVERTIME_COL.TIME_OUT).setNumberFormat('@');

    Logger.log('[initOvertimeInstructionSheet] 残業指示シートを初期化しました。');
  }
}

/**
 * 全ての残業指示行を取得する（ヘッダー除外）。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array[]}
 */
function getAllOvertimeRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var actualCols = sheet.getLastColumn();
  if (actualCols === 0) return [];
  var readCols = Math.min(OVERTIME_NUM_COLS, actualCols);

  return sheet.getRange(2, 1, lastRow - 1, readCols).getValues();
}

/**
 * 残業指示の行データをオブジェクトに変換する。
 * @param {Array} row
 * @returns {Object}
 */
function rowToOvertimeInstruction(row) {
  return {
    id              : row[OVERTIME_COL.ID - 1] || '',
    employee_id     : row[OVERTIME_COL.EMPLOYEE_ID - 1] || '',
    name            : row[OVERTIME_COL.NAME - 1] || '',
    issued_at       : row[OVERTIME_COL.ISSUED_AT - 1] || '',
    target_date     : formatDateToString(row[OVERTIME_COL.TARGET_DATE - 1]) || '',
    estimated_time  : row[OVERTIME_COL.ESTIMATED_TIME - 1] || '',
    actual_time     : row[OVERTIME_COL.ACTUAL_TIME - 1] || '',
    time_in         : row[OVERTIME_COL.TIME_IN - 1] || '',
    time_out        : row[OVERTIME_COL.TIME_OUT - 1] || '',
    issued_by       : row[OVERTIME_COL.ISSUED_BY - 1] || '',
    status          : row[OVERTIME_COL.STATUS - 1] || 'pending',
    comment         : row[OVERTIME_COL.COMMENT - 1] || '',
    created_at      : row[OVERTIME_COL.CREATED_AT - 1] || '',
    updated_at      : row[OVERTIME_COL.UPDATED_AT - 1] || '',
    status_display  : (function(status) {
      var map = { 'pending': '承認待ち', 'confirmed': '承認済み', 'rejected': '却下', 'deleted': '削除済み' };
      return map[status] || status;
    })(row[OVERTIME_COL.STATUS - 1]),
  };
}

/**
 * Admin が残業指示を直接作成する（申請スキップ）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function createOvertimeInstruction(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  if (!data.employee_id) throw new Error('employee_id は必須です。');
  if (!data.name) throw new Error('name は必須です。');
  if (!data.target_date) throw new Error('target_date は必須です。');
  if (!data.estimated_time) throw new Error('estimated_time（見込み時間）は必須です。');
  if (!data.created_by) throw new Error('created_by は必須です。');

  var targetDate = convertDateForDisplay(String(data.target_date).replace(/\//g, '-'));

  var id = generateId();
  var now = new Date().toISOString();
  var newRowNum = sheet.getLastRow() + 1;

  sheet.getRange(newRowNum, OVERTIME_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.ESTIMATED_TIME).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.ACTUAL_TIME).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.TIME_IN).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.TIME_OUT).setNumberFormat('@');

  sheet.getRange(newRowNum, 1, 1, OVERTIME_NUM_COLS).setValues([[
    id,
    data.employee_id,
    data.name,
    now,
    targetDate,
    data.estimated_time,
    '',
    '',
    '',
    data.created_by,
    'pending',
    '',
    now,
    now,
  ]]);

  SpreadsheetApp.flush();
  writeAuditLog(ss, {
    action: 'create_overtime_instruction',
    admin_id: data.created_by,
    target_id: data.employee_id,
    target_date: targetDate,
    reason: '残業指示直接登録',
  });

  Logger.log('[createOvertimeInstruction] 作成: id=%s, empId=%s, date=%s, time=%s',
    id, data.employee_id, targetDate, data.estimated_time);

  return { id: id, created: true, status: 'pending' };
}

/**
 * Admin が残業指示一覧を取得する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function adminOvertimeInstructions(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  var rows = getAllOvertimeRows(sheet);

  rows = rows.filter(function(r) {
    return r[OVERTIME_COL.STATUS - 1] !== 'deleted';
  });

  if (data.status && data.status !== 'all') {
    rows = rows.filter(function(r) {
      return r[OVERTIME_COL.STATUS - 1] === data.status;
    });
  }

  if (data.employee_id) {
    rows = rows.filter(function(r) {
      return r[OVERTIME_COL.EMPLOYEE_ID - 1] === data.employee_id;
    });
  }

  if (data.start_date || data.end_date) {
    var start = data.start_date ? String(data.start_date).replace(/-/g, '/') : '0000/00/00';
    var end = data.end_date ? String(data.end_date).replace(/-/g, '/') : '9999/12/31';
    rows = rows.filter(function(r) {
      var d = String(r[OVERTIME_COL.TARGET_DATE - 1] || '');
      return d >= start && d <= end;
    });
  }

  var instructions = rows.map(rowToOvertimeInstruction)
    .sort(function(a, b) {
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

  var pendingCount = rows.filter(function(r) {
    return r[OVERTIME_COL.STATUS - 1] === 'pending';
  }).length;

  Logger.log('[adminOvertimeInstructions] 取得: %d件（pending: %d件）', instructions.length, pendingCount);

  return { instructions: instructions, pending_count: pendingCount };
}

/**
 * スタッフが残業指示を承認/却下する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function updateOvertimeInstructionStatus(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  if (!data.instruction_id) throw new Error('instruction_id は必須です。');
  if (!data.status) throw new Error('status は必須です。');
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  if (data.status !== 'confirmed' && data.status !== 'rejected') {
    throw new Error('status は「confirmed」または「rejected」のみ指定可能です。');
  }

  var rows = getAllOvertimeRows(sheet);
  var idx = rows.findIndex(function(r) {
    return r[OVERTIME_COL.ID - 1] === data.instruction_id;
  });
  if (idx === -1) throw new Error('指示が見つかりません: ' + data.instruction_id);

  var rowNum = idx + 2;
  var targetRow = rows[idx];

  var ownerEmpId = String(targetRow[OVERTIME_COL.EMPLOYEE_ID - 1] || '');
  if (ownerEmpId !== String(data.employee_id)) {
    throw new Error('他人の残業指示は更新できません。');
  }

  var currentStatus = String(targetRow[OVERTIME_COL.STATUS - 1] || '');
  if (currentStatus !== 'pending') {
    throw new Error('承認待ち状態の指示のみ更新できます。（現在: ' + currentStatus + '）');
  }

  sheet.getRange(rowNum, OVERTIME_COL.STATUS).setValue(data.status);
  sheet.getRange(rowNum, OVERTIME_COL.COMMENT).setValue(data.comment || '');
  sheet.getRange(rowNum, OVERTIME_COL.UPDATED_AT).setValue(new Date().toISOString());

  SpreadsheetApp.flush();

  var statusDisplay = data.status === 'confirmed' ? '承認済み' : '却下';
  writeAuditLog(ss, {
    action: 'update_overtime_instruction_status',
    admin_id: data.employee_id,
    target_id: data.instruction_id,
    reason: '残業指示を「' + statusDisplay + '」に変更',
  });

  Logger.log('[updateOvertimeInstructionStatus] 更新: id=%s, empId=%s, status=%s',
    data.instruction_id, data.employee_id, data.status);

  return { updated: true, id: data.instruction_id, status: statusDisplay };
}

/**
 * Admin が残業指示を削除する（論理削除）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function deleteOvertimeInstruction(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  if (!data.instruction_id) throw new Error('instruction_id は必須です。');
  if (!data.admin_id) throw new Error('admin_id は必須です。');

  var rows = getAllOvertimeRows(sheet);
  var idx = rows.findIndex(function(r) {
    return r[OVERTIME_COL.ID - 1] === data.instruction_id;
  });
  if (idx === -1) throw new Error('指示が見つかりません: ' + data.instruction_id);

  var rowNum  = idx + 2;
  var instRow = rows[idx];

  sheet.getRange(rowNum, OVERTIME_COL.STATUS).setValue('deleted');
  sheet.getRange(rowNum, OVERTIME_COL.UPDATED_AT).setValue(new Date().toISOString());

  SpreadsheetApp.flush();

  // ── 対応する残業申請を 'pending'（承認待ち）に戻す ──
  var reverted = false;
  try {
    var reqSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
    var reqRows  = getAllRequestRows(reqSheet);

    var instEmpId = String(instRow[OVERTIME_COL.EMPLOYEE_ID - 1] || '');
    var instDate  = String(instRow[OVERTIME_COL.TARGET_DATE  - 1] || '').replace(/\//g, '-').slice(0, 10);

    reqRows.forEach(function(r, i) {
      var type   = String(r[REQ_COL.TYPE        - 1] || '');
      var status = String(r[REQ_COL.STATUS      - 1] || '');
      var empId  = String(r[REQ_COL.EMPLOYEE_ID - 1] || '');
      var raw    = r[REQ_COL.TARGET_DATE - 1];
      var reqDate;
      if (raw instanceof Date) {
        reqDate = raw.getFullYear() + '-'
          + String(raw.getMonth() + 1).padStart(2, '0') + '-'
          + String(raw.getDate()).padStart(2, '0');
      } else {
        reqDate = String(raw || '').replace(/\//g, '-').slice(0, 10);
      }

      if (type === '残業' && status === 'approved' && empId === instEmpId && reqDate === instDate) {
        var reqRowNum = i + 2;
        reqSheet.getRange(reqRowNum, REQ_COL.STATUS).setValue('pending');
        reqSheet.getRange(reqRowNum, REQ_COL.APPROVED_BY).setValue('');
        reqSheet.getRange(reqRowNum, REQ_COL.APPROVED_AT).setValue('');
        reverted = true;
        Logger.log('[deleteOvertimeInstruction] 申請を pending に戻した: empId=%s, date=%s', empId, reqDate);
      }
    });

    if (reverted) SpreadsheetApp.flush();
  } catch (err) {
    Logger.log('[deleteOvertimeInstruction] 申請差し戻し失敗（非致命的）: %s', err.message);
  }

  writeAuditLog(ss, {
    action: 'delete_overtime_instruction',
    admin_id: data.admin_id,
    target_id: data.instruction_id,
    reason: '残業指示を削除（論理削除）' + (reverted ? '・申請をpendingに差し戻し' : ''),
  });

  Logger.log('[deleteOvertimeInstruction] 削除: id=%s, reverted=%s', data.instruction_id, reverted);

  return { deleted: true, id: data.instruction_id, request_reverted: reverted };
}

/**
 * スタッフが自分の残業指示を取得する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getOvertimeInstructions(ss, data) {
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  var rows = getAllOvertimeRows(sheet)
    .filter(function(r) {
      return r[OVERTIME_COL.EMPLOYEE_ID - 1] === data.employee_id &&
             r[OVERTIME_COL.STATUS - 1] !== 'deleted';
    });

  if (data.status && data.status !== 'all') {
    rows = rows.filter(function(r) {
      return r[OVERTIME_COL.STATUS - 1] === data.status;
    });
  }

  var instructions = rows.map(rowToOvertimeInstruction)
    .sort(function(a, b) {
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

  Logger.log('[getOvertimeInstructions] 取得: empId=%s, %d件', data.employee_id, instructions.length);

  return { instructions: instructions };
}

// ============================================================
// 残業申請（Kintai → 申請管理シートへ登録）
// ============================================================

/**
 * スタッフが Kintai から残業申請を送信する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function submitOvertimeRequest(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);

  if (!data.employee_id) throw new Error('employee_id は必須です。');
  if (!data.name) throw new Error('name は必須です。');
  if (!data.target_date) throw new Error('target_date は必須です。');
  if (!data.estimated_time) throw new Error('estimated_time（見込み時間）は必須です。');

  var rawDate = String(data.target_date).replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw new Error('target_date の形式が正しくありません: ' + rawDate);
  }

  var id  = generateId();
  var now = new Date().toISOString();
  var newRowNum = sheet.getLastRow() + 1;

  sheet.getRange(newRowNum, REQ_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, REQ_COL.TIME).setNumberFormat('@');

  sheet.getRange(newRowNum, 1, 1, REQ_NUM_COLS).setValues([[
    id,
    data.employee_id,
    data.name,
    'pending',
    '残業',
    rawDate,
    data.reason || '',
    '承認が必要',
    '',
    '',
    '',
    now,
    data.estimated_time,
    '',
    '',
    '',
  ]]);

  SpreadsheetApp.flush();
  Logger.log('[submitOvertimeRequest] 登録: id=%s, empId=%s, date=%s, time=%s',
    id, data.employee_id, rawDate, data.estimated_time);

  return { id: id, submitted: true };
}

/**
 * Admin が残業申請を承認する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function adminApproveOvertimeRequest(ss, data) {
  if (!data.request_id) throw new Error('request_id は必須です。');
  if (!data.admin_id)   throw new Error('admin_id は必須です。');

  var reqSheet  = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(reqSheet);

  var rows = getAllRequestRows(reqSheet);
  var idx  = rows.findIndex(function(r) {
    return r[REQ_COL.ID - 1] === data.request_id;
  });
  if (idx === -1) throw new Error('申請が見つかりません: ' + data.request_id);

  var reqRow = rows[idx];
  var rowNum = idx + 2;

  var reqType = String(reqRow[REQ_COL.TYPE - 1] || '');
  if (reqType !== '残業') {
    throw new Error('この申請は残業申請ではありません（種別: ' + reqType + '）。通常の承認フローを使用してください。');
  }

  var currentStatus = String(reqRow[REQ_COL.STATUS - 1] || '');
  if (currentStatus !== 'pending') {
    throw new Error('承認待ち状態の申請のみ承認できます（現在: ' + currentStatus + '）。');
  }

  var now = new Date().toISOString();

  reqSheet.getRange(rowNum, REQ_COL.STATUS).setValue('approved');
  reqSheet.getRange(rowNum, REQ_COL.APPROVED_BY).setValue(data.admin_id);
  reqSheet.getRange(rowNum, REQ_COL.APPROVED_AT).setValue(now);

  var estimatedTime = String(reqRow[REQ_COL.TIME - 1] || '');
  var targetDate    = (function(raw) {
    if (!raw) return '';
    if (raw instanceof Date) {
      return raw.getFullYear() + '-'
        + String(raw.getMonth() + 1).padStart(2, '0') + '-'
        + String(raw.getDate()).padStart(2, '0');
    }
    return String(raw).replace(/\//g, '-').slice(0, 10);
  })(reqRow[REQ_COL.TARGET_DATE - 1]);

  var instructionData = {
    employee_id    : String(reqRow[REQ_COL.EMPLOYEE_ID - 1] || ''),
    name           : String(reqRow[REQ_COL.NAME - 1] || ''),
    target_date    : targetDate,
    estimated_time : estimatedTime,
    created_by     : data.admin_id,
  };

  // ── Kintai からの申請を Admin が承認した場合、指示の状態は最初から 'confirmed' とする ──
  var instSheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(instSheet);

  var instId     = generateId();
  var normDate   = convertDateForDisplay(String(targetDate).replace(/\//g, '-'));
  var newInstRow = instSheet.getLastRow() + 1;

  instSheet.getRange(newInstRow, OVERTIME_COL.TARGET_DATE).setNumberFormat('@');
  instSheet.getRange(newInstRow, OVERTIME_COL.ESTIMATED_TIME).setNumberFormat('@');
  instSheet.getRange(newInstRow, OVERTIME_COL.ACTUAL_TIME).setNumberFormat('@');
  instSheet.getRange(newInstRow, OVERTIME_COL.TIME_IN).setNumberFormat('@');
  instSheet.getRange(newInstRow, OVERTIME_COL.TIME_OUT).setNumberFormat('@');

  instSheet.getRange(newInstRow, 1, 1, OVERTIME_NUM_COLS).setValues([[
    instId,
    instructionData.employee_id,
    instructionData.name,
    now,
    normDate,
    estimatedTime,
    '',
    '',
    '',
    data.admin_id,
    'confirmed',
    '申請承認により自動登録',
    now,
    now,
  ]]);

  var instResult = { id: instId };

  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action     : 'admin_approve_overtime_request',
    admin_id   : data.admin_id,
    target_id  : data.request_id,
    target_date: targetDate,
    reason     : '残業申請を承認し、残業指示を登録',
    after      : 'instruction_id=' + instResult.id,
  });

  Logger.log('[adminApproveOvertimeRequest] 承認: reqId=%s, instId=%s', data.request_id, instResult.id);

  return {
    approved       : true,
    request_id     : data.request_id,
    instruction_id : instResult.id,
  };
}

/**
 * Admin が残業申請を却下する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function adminRejectOvertimeRequest(ss, data) {
  if (!data.request_id) throw new Error('request_id は必須です。');
  if (!data.admin_id)   throw new Error('admin_id は必須です。');

  var reqSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(reqSheet);

  var rows = getAllRequestRows(reqSheet);
  var idx  = rows.findIndex(function(r) {
    return r[REQ_COL.ID - 1] === data.request_id;
  });
  if (idx === -1) throw new Error('申請が見つかりません: ' + data.request_id);

  var reqRow = rows[idx];
  var rowNum = idx + 2;

  var reqType = String(reqRow[REQ_COL.TYPE - 1] || '');
  if (reqType !== '残業') {
    throw new Error('この申請は残業申請ではありません（種別: ' + reqType + '）。');
  }

  var currentStatus = String(reqRow[REQ_COL.STATUS - 1] || '');
  if (currentStatus !== 'pending') {
    throw new Error('承認待ち状態の申請のみ却下できます（現在: ' + currentStatus + '）。');
  }

  reqSheet.getRange(rowNum, REQ_COL.STATUS).setValue('rejected');
  reqSheet.getRange(rowNum, REQ_COL.REJECT_REASON).setValue(data.reject_reason || '');

  SpreadsheetApp.flush();

  writeAuditLog(ss, {
    action     : 'admin_reject_overtime_request',
    admin_id   : data.admin_id,
    target_id  : data.request_id,
    reason     : data.reject_reason || '理由なし',
    after      : 'rejected',
  });

  Logger.log('[adminRejectOvertimeRequest] 却下: reqId=%s, reason=%s',
    data.request_id, data.reject_reason || '');

  return { rejected: true, request_id: data.request_id };
}
