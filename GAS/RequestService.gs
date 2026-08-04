/**
 * RequestService.gs - 申請管理
 *
 * 役割:
 *   休み・遅刻・早退・補填・欠席・在宅・外出等の申請登録・一覧・承認・
 *   却下・取り下げ・物理削除・直接編集を実装する。
 *
 * 設計方針:
 *   - AdminOpsService.gs の handleAdminAction() から委譲される
 *   - シートが存在しない場合は getOrCreateSheet() で自動作成する
 *   - 対象日は YYYY-MM-DD 文字列で統一
 *   - REQ_COL / REQ_NUM_COLS は申請管理シート（16列）の列定義
 *
 * 【2026-07-30 分割】旧 Adminservice.gs（2934行）から申請管理一式を分離。
 *
 * @version 1.0.0
 */

'use strict';

// 申請管理シートの列番号定数（1始まり）。
// ⚠️ 列を追加する場合は REQ_NUM_COLS・initRequestSheet・rowToRequest も必ず更新すること。
//
// v2.1.0マイグレーション（migrateRequestSheet）により実際のシートは16列構造:
//   A(1):ID  B(2):申請者ID  C(3):申請者名  D(4):ステータス  E(5):種別
//   F(6):対象日  G(7):理由  H(8):承認フロー  I(9):承認者ID  J(10):承認日時
//   K(11):却下理由  L(12):申請日時  M(13):申請時刻  N(14):遅刻時間
//   O(15):早退時間  P(16):申請種別区分
//
// TIME列（M列=13列目）: 遅刻の「出勤予定時刻」または早退の「退勤予定時刻」を保存する。
var REQ_COL = {
  ID             : 1,
  EMPLOYEE_ID    : 2,
  NAME           : 3,
  STATUS         : 4,
  TYPE           : 5,
  TARGET_DATE    : 6,
  REASON         : 7,
  NEEDS_APPROVAL : 8,
  APPROVED_BY    : 9,
  APPROVED_AT    : 10,
  REJECT_REASON  : 11,
  CREATED_AT     : 12,
  TIME           : 13,  // M列: 申請時刻（遅刻=出勤予定 / 早退=退勤予定）HH:MM
  LATE_TIME      : 14,  // N列: 遅刻時間（旧フィールド、互換用）
  EARLY_TIME     : 15,  // O列: 早退時間（旧フィールド、互換用）
  REQUEST_KIND   : 16,  // P列: 申請種別区分（fillup/paid/none）
};
var REQ_NUM_COLS = 16;

function initRequestSheet(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, REQ_NUM_COLS).setValues([[
      'ID','申請者ID','申請者名','ステータス','種別','対象日','理由',
      '承認フロー','承認者ID','承認日時','却下理由','申請日時',
      '予定時刻',      // M列: 出勤予定時刻（遅刻）/ 退勤予定時刻（早退）
      '遅刻時間(旧)',  // N列: 旧フィールド（互換用）
      '早退時間(旧)',  // O列: 旧フィールド（互換用）
      '申請種別区分'   // P列: fillup/paid/none
    ]]);
    // M列をテキスト形式に固定して時刻の自動変換を防ぐ
    sheet.getRange(1, 13, 1, 1).setNumberFormat('@');
  }
}

function submitRequest(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);
  var id  = generateId();
  var now = new Date().toISOString();

  // ── 補填ルールのバリデーション ──────────────────────────
  //
  // 補填申請（compensation='fillup'）には以下のルールを適用する:
  //   1. 補填時間は5分単位でなければならない
  //   2. 月の補填合計は8時間（480分）以内
  //   3. 補填は当月内（対象日と補填日が同じ月）のみ有効
  //
  if (data.compensation === 'fillup' && data.fillup_minutes) {
    var fillupMin = Number(data.fillup_minutes) || 0;

    if (fillupMin % 5 !== 0) {
      throw new Error('補填時間は5分単位で入力してください（入力値: ' + fillupMin + '分）。');
    }

    var targetYM  = String(data.target_date || '').slice(0, 7); // 'YYYY-MM'
    var fillupYM  = String(data.fillup_date || '').slice(0, 7);
    if (targetYM && fillupYM && targetYM !== fillupYM) {
      throw new Error('補填は当月内のみ有効です。翌月以降への繰り越しはできません（対象: ' + targetYM + '、補填日: ' + fillupYM + '）。');
    }

    if (data.employee_id && targetYM) {
      var reqRows    = getAllRequestRows(sheet);
      var usedMin    = 0;
      reqRows.forEach(function(r) {
        var rowEmp    = String(r[REQ_COL.EMPLOYEE_ID - 1] || '');
        var rowStatus = String(r[REQ_COL.STATUS      - 1] || '');
        var rowDate   = String(r[REQ_COL.TARGET_DATE - 1] || '').slice(0, 7);
        var rowComp   = String(r[15] || ''); // P列: compensation
        var rowFillupMin = Number(r[16] || 0); // Q列: fillup_minutes（後述）
        if (rowEmp === data.employee_id &&
            rowDate === targetYM &&
            rowComp === 'fillup' &&
            (rowStatus === 'pending' || rowStatus === 'approved')) {
          usedMin += rowFillupMin;
        }
      });
      var MONTHLY_LIMIT_MIN = 480; // 8時間
      if (usedMin + fillupMin > MONTHLY_LIMIT_MIN) {
        var remainMin = Math.max(0, MONTHLY_LIMIT_MIN - usedMin);
        throw new Error(
          '月の補填上限（8時間/480分）を超えます。' +
          '今月の残り補填可能時間: ' + remainMin + '分。' +
          '申請しようとした補填時間: ' + fillupMin + '分。'
        );
      }
    }
  }

  var needsApproval = (data.compensation === 'fillup' || data.compensation === 'paid');
  var status        = needsApproval ? 'pending' : 'approved';

  var time = (data.type === '遅刻' || data.type === '早退') ? (data.time || '') : '';

  var rawDate    = String(data.target_date || data.date || '').replace(/\//g, '-');
  var targetDate = rawDate.slice(0, 10);

  var newRowNum = sheet.getLastRow() + 1;

  sheet.getRange(newRowNum, REQ_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, REQ_COL.TIME).setNumberFormat('@');

  sheet.getRange(newRowNum, 1, 1, REQ_NUM_COLS).setValues([[
    id,
    data.employee_id  || '',
    data.name         || '',
    status,
    data.type         || '',
    targetDate,
    data.reason       || '',
    needsApproval ? '承認が必要' : '不要',
    '',        // approved_by
    '',        // approved_at
    '',        // reject_reason
    now,       // created_at
    time,      // M列: 申請時刻
    '',        // N列: 遅刻時間（旧フィールド、空で保存）
    '',        // O列: 早退時間（旧フィールド、空で保存）
    data.compensation || '',  // P列: 申請種別区分
  ]]);
  SpreadsheetApp.flush();

  return { id: id, submitted: true, needs_approval: needsApproval };
}

/**
 * 申請管理シートの全行を確実に REQ_NUM_COLS 列で読み取る。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array[]} 2行目以降のデータ行配列
 */
function getAllRequestRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var actualCols = sheet.getLastColumn();
  if (actualCols === 0) return [];
  var readCols = Math.min(REQ_NUM_COLS, actualCols);

  return sheet.getRange(2, 1, lastRow - 1, readCols).getValues();
}

function getMyRequests(ss, employeeId) {
  if (!employeeId) throw new Error('employee_id は必須です。');
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);
  var requests = getAllRequestRows(sheet)
    .filter(function(r){ return r[REQ_COL.EMPLOYEE_ID-1]===employeeId; })
    .map(rowToRequest)
    .sort(function(a,b){ return (b.created_at||'').localeCompare(a.created_at||''); });
  return { requests:requests };
}

function adminRequests(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);
  var rows = getAllRequestRows(sheet);
  if (data.status && data.status!=='all') rows=rows.filter(function(r){return r[REQ_COL.STATUS-1]===data.status;});
  if (data.type) rows=rows.filter(function(r){return r[REQ_COL.TYPE-1]===data.type;});
  var requests = rows.map(rowToRequest).sort(function(a,b){return (b.created_at||'').localeCompare(a.created_at||'');});
  var pendingCount = getAllRequestRows(sheet).filter(function(r){return r[REQ_COL.STATUS-1]==='pending';}).length;
  return { requests:requests, pending_count:pendingCount };
}

function adminUpdateRequest(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  var rows  = getAllRequestRows(sheet);
  var idx   = rows.findIndex(function(r){return r[REQ_COL.ID-1]===data.request_id;});
  if (idx===-1) throw new Error('申請が見つかりません: ' + data.request_id);
  var rowNum = idx+2;
  var now    = new Date().toISOString();

  var newStatus = data.action === 'approve' ? 'approved'
                : data.action === 'revert'  ? 'pending'
                : 'rejected';

  sheet.getRange(rowNum,REQ_COL.STATUS).setValue(newStatus);
  sheet.getRange(rowNum,REQ_COL.APPROVED_BY).setValue(data.admin_id||'');
  sheet.getRange(rowNum,REQ_COL.APPROVED_AT).setValue(now);
  if (data.action==='reject' && data.reject_reason) {
    sheet.getRange(rowNum,REQ_COL.REJECT_REASON).setValue(data.reject_reason);
  }
  SpreadsheetApp.flush();

  var pendingCount = getAllRequestRows(sheet).filter(function(r){
    return r[REQ_COL.STATUS-1]==='pending';
  }).length;

  writeAuditLog(ss, {
    action    : 'update_request',
    admin_id  : data.admin_id || '',
    target_id : data.request_id,
    reason    : data.action + (data.reject_reason ? ': ' + data.reject_reason : ''),
  });

  return { updated:true, pending_count:pendingCount };
}

/**
 * Admin が申請を物理削除する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data - { request_id, admin_id }
 * @returns {{ deleted: boolean, id: string }}
 */
function adminDeleteRequest(ss, data) {
  if (!data.request_id) throw new Error('request_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  var rows  = getAllRequestRows(sheet);
  var idx   = rows.findIndex(function(r){ return r[REQ_COL.ID-1] === data.request_id; });
  if (idx === -1) throw new Error('申請が見つかりません: ' + data.request_id);

  var targetRow = rows[idx];
  writeAuditLog(ss, {
    action    : 'delete_request',
    admin_id  : data.admin_id || '',
    target_id : data.request_id,
    target_date: String(targetRow[REQ_COL.TARGET_DATE-1]||''),
    reason    : '管理者による申請削除',
    before    : [targetRow[REQ_COL.NAME-1], targetRow[REQ_COL.TYPE-1], targetRow[REQ_COL.STATUS-1]].join(' / '),
  });

  sheet.deleteRow(idx + 2);
  SpreadsheetApp.flush();

  Logger.log('[adminDeleteRequest] 削除: id=%s, by=%s', data.request_id, data.admin_id);
  return { deleted: true, id: data.request_id };
}

/**
 * スタッフが自分の pending 申請を取り下げる（cancelled 状態へ変更）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data - { request_id, employee_id }
 * @returns {{ cancelled: boolean, id: string }}
 */
function cancelRequest(ss, data) {
  if (!data.request_id)  throw new Error('request_id は必須です。');
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  var rows  = getAllRequestRows(sheet);
  var idx   = rows.findIndex(function(r){ return r[REQ_COL.ID-1] === data.request_id; });
  if (idx === -1) throw new Error('申請が見つかりません: ' + data.request_id);

  var targetRow = rows[idx];

  var ownerEmpId = String(targetRow[REQ_COL.EMPLOYEE_ID-1] || '');
  if (ownerEmpId !== String(data.employee_id)) {
    throw new Error('他人の申請は取り下げできません。');
  }

  var currentStatus = String(targetRow[REQ_COL.STATUS-1] || '');
  var rowNum = idx + 2;

  if (currentStatus === 'cancelled') {
    throw new Error('すでに取り下げ済みです。');
  }

  if (currentStatus === 'approved' || data.is_approved) {
    sheet.getRange(rowNum, REQ_COL.STATUS).setValue('rejected');
    sheet.getRange(rowNum, REQ_COL.REJECT_REASON).setValue('【取り下げ申請】スタッフによる取り下げ申請');
    Logger.log('[cancelRequest] 取り下げ申請（承認済み）: id=%s, empId=%s', data.request_id, data.employee_id);
  } else {
    sheet.getRange(rowNum, REQ_COL.STATUS).setValue('cancelled');
    sheet.getRange(rowNum, REQ_COL.REJECT_REASON).setValue('スタッフによる取り下げ');
    Logger.log('[cancelRequest] 取り下げ: id=%s, empId=%s', data.request_id, data.employee_id);
  }

  SpreadsheetApp.flush();
  return { cancelled: true, id: data.request_id };
}

/**
 * 申請内容を管理者が直接編集する。
 *
 * 編集可能項目:
 *   - type        : 申請種別（休み / 遅刻 / 早退 / 補填予定 / 補填完了 / 有給）
 *   - target_date : 対象日（YYYY-MM-DD 形式を強制）
 *   - time        : 遅刻=出勤予定時刻 / 早退=退勤予定時刻（HH:MM）
 *   - reason      : 理由
 *   - status      : ステータス（pending / approved / rejected）
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {{ updated: boolean, id: string }}
 */
function adminEditRequest(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);

  var requestId = data.request_id;
  if (!requestId) throw new Error('request_id は必須です。');

  var targetDate = String(data.target_date || '');
  if (!targetDate) throw new Error('対象日は必須です。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('対象日の形式が正しくありません: ' + targetDate + ' (YYYY-MM-DD で入力してください)');
  }

  var allowedTypes = ['休み', '遅刻', '早退', '補填予定', '補填完了', '有給', '残業'];
  var type = data.type || '';
  if (!allowedTypes.includes(type)) throw new Error('不正な申請種別です: ' + type);

  var allowedStatuses = ['pending', 'approved', 'rejected'];
  var status = data.status || 'approved';
  if (!allowedStatuses.includes(status)) throw new Error('不正なステータスです: ' + status);

  var rows = getAllRequestRows(sheet);
  var idx  = rows.findIndex(function(r){ return r[REQ_COL.ID-1] === requestId; });
  if (idx === -1) throw new Error('申請が見つかりません: ' + requestId);

  var rowNum = idx + 2;

  sheet.getRange(rowNum, REQ_COL.TYPE       ).setValue(type);
  sheet.getRange(rowNum, REQ_COL.TARGET_DATE).setNumberFormat('@').setValue(targetDate);
  sheet.getRange(rowNum, REQ_COL.REASON     ).setValue(data.reason || '');
  sheet.getRange(rowNum, REQ_COL.STATUS     ).setValue(status);

  var timeVal = (type === '遅刻' || type === '早退') ? (data.time || '') : '';
  if (sheet.getLastColumn() >= REQ_COL.TIME) {
    sheet.getRange(rowNum, REQ_COL.TIME).setValue(timeVal);
  }

  SpreadsheetApp.flush();
  Logger.log('[adminEditRequest] 更新: id=%s, type=%s, date=%s, status=%s', requestId, type, targetDate, status);
  return { updated: true, id: requestId };
}

/**
 * Admin が欠席・遅刻・早退・外出勤務などのステータスを申請管理シートに直接登録する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {{ registered: boolean, id: string }}
 */
function saveAttendanceStatus(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);

  if (!data.employee_id) throw new Error('employee_id は必須です。');
  if (!data.date)        throw new Error('date は必須です。');

  var statusMap = {
    'absent'            : '欠席',
    'paid_leave'        : '有給',
    'substitute_holiday': '補填休',
    'holiday'           : '会社休日',
    'remote'            : '在宅',
    'outing'            : '外出勤務',
  };
  var typeStr = statusMap[data.status] || data.status || '欠席';

  var targetDate = String(data.date).replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('日付の形式が正しくありません: ' + targetDate);
  }

  var id  = generateId();
  var now = new Date().toISOString();
  var newRowNum = sheet.getLastRow() + 1;

  sheet.getRange(newRowNum, REQ_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, REQ_COL.TIME).setNumberFormat('@');

  sheet.getRange(newRowNum, 1, 1, REQ_NUM_COLS).setValues([[
    id,
    data.employee_id || '',
    data.name        || '',
    'approved',
    typeStr,
    targetDate,
    data.note        || '',
    '不要',
    data.created_by  || '',
    now,
    '',
    now,
    '',
    '',
    '',
    '',
  ]]);
  SpreadsheetApp.flush();

  Logger.log('[saveAttendanceStatus] 登録: id=%s, empId=%s, type=%s, date=%s',
    id, data.employee_id, typeStr, targetDate);

  return { registered: true, id: id };
}

function rowToRequest(row) {
  return {
    id             : row[REQ_COL.ID             - 1] || '',
    employee_id    : row[REQ_COL.EMPLOYEE_ID    - 1] || '',
    name           : row[REQ_COL.NAME           - 1] || '',
    status         : row[REQ_COL.STATUS         - 1] || 'pending',
    type           : row[REQ_COL.TYPE           - 1] || '',
    target_date    : (function(raw) {
      if (!raw) return '';
      if (raw instanceof Date) {
        var y = raw.getFullYear();
        var mo = String(raw.getMonth() + 1).padStart(2, '0');
        var d  = String(raw.getDate()).padStart(2, '0');
        return y + '-' + mo + '-' + d;
      }
      var s = String(raw);
      if (s.length > 10 && s.charAt(4) === '-') return s.slice(0, 10);
      return s.replace(/\//g, '-').slice(0, 10);
    })(row[REQ_COL.TARGET_DATE - 1]),
    reason         : row[REQ_COL.REASON         - 1] || '',
    needs_approval : (function(v) {
      if (v === '承認が必要' || v === 'true')  return true;
      if (v === '不要'       || v === 'false') return false;
      return v !== 'false';
    })(row[REQ_COL.NEEDS_APPROVAL - 1]),
    approved_by    : row[REQ_COL.APPROVED_BY    - 1] || '',
    approved_at    : row[REQ_COL.APPROVED_AT    - 1] || '',
    reject_reason  : row[REQ_COL.REJECT_REASON  - 1] || '',
    created_at     : row[REQ_COL.CREATED_AT     - 1] || '',
    time           : formatTimeDisplay_GAS(row[REQ_COL.TIME         - 1]) || '',
    late_time      : formatTimeDisplay_GAS(row[REQ_COL.LATE_TIME    - 1]) || '',
    early_leave_time: formatTimeDisplay_GAS(row[REQ_COL.EARLY_TIME  - 1]) || '',
    request_kind   : row[REQ_COL.REQUEST_KIND - 1] || '',
  };
}
