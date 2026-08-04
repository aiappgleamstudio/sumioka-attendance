/**
 * DeadlineService.gs - 納期管理
 *
 * 役割:
 *   案件ごとの納期・フェーズ（予定日・完了状態・ファイルパス等）の
 *   登録・取得・削除、継続案件の翌月分自動生成を実装する。
 *
 * 設計方針:
 *   - AdminOpsService.gs の handleAdminAction() から委譲される
 *   - DL_COL / DL_NUM_COLS は納期管理シート（7列）の列定義
 *   - 旧5列シート（担当者ID/担当者名/JSON/更新日時のみ）との後方互換を
 *     B列の値がUUID長（36文字）かどうかで自動判定する
 *
 * 【2026-07-30 分割】旧 Adminservice.gs（2934行）から納期管理一式を分離。
 *
 * @version 1.0.0
 */

'use strict';

/**
 * 納期管理シートの列番号定数（1始まり）。
 *
 * 列構成:
 *   A(1): ID          - 案件識別子（UUID）
 *   B(2): TITLE       - 案件名
 *   C(3): NAME        - 担当者名
 *   D(4): EMPLOYEE_ID - 担当者ID
 *   E(5): DATA        - JSON（phases / client / type 等）
 *   F(6): CREATED_AT  - 作成日時（ISO 8601）
 *   G(7): UPDATED_AT  - 更新日時（ISO 8601）
 *
 * ⚠️ 旧シート（5列）は getDeadlines 読み込み時に EMPLOYEE_ID と DATA の位置が
 *    ずれるため、既存シートがある場合は列A〜Gを確認してから使用すること。
 */
var DL_COL = {
  ID          : 1,  // A: UUID
  TITLE       : 2,  // B: 案件名
  NAME        : 3,  // C: 担当者名
  EMPLOYEE_ID : 4,  // D: 担当者ID
  DATA        : 5,  // E: JSON
  CREATED_AT  : 6,  // F: 作成日時
  UPDATED_AT  : 7,  // G: 更新日時
};
var DL_NUM_COLS = 7;

function initDeadlineSheet(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DL_NUM_COLS).setValues([[
      'ID', '案件名', '担当者名', '担当者ID', 'データ(JSON)', '作成日時', '更新日時'
    ]]);
  }
}

function getDeadlines(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.DEADLINES);
  initDeadlineSheet(sheet);

  var rows = getAllRows(sheet);
  if (!data.all) {
    rows = rows.filter(function(r) {
      return r[DL_COL.EMPLOYEE_ID - 1] === data.employee_id;
    });
  }

  var deadlines = rows.map(function(r) {
    var bVal = String(r[1] || '');
    var isOldFormat = bVal.length > 30; // UUID は36文字

    var empId, title, assigneeName, jsonData;
    if (isOldFormat) {
      empId       = r[1] || '';
      assigneeName= r[2] || '';
      jsonData    = safeJsonParse(r[3], {});
      title       = jsonData.title || '';
    } else {
      title       = r[DL_COL.TITLE       - 1] || '';
      assigneeName= r[DL_COL.NAME        - 1] || '';
      empId       = r[DL_COL.EMPLOYEE_ID - 1] || '';
      jsonData    = safeJsonParse(r[DL_COL.DATA - 1], {});
    }

    return Object.assign(
      {},
      jsonData,
      {
        id          : r[DL_COL.ID - 1] || '',
        title       : title,
        name        : title,            // 後方互換
        employee_id : empId,
        assignee    : assigneeName,
      }
    );
  });

  return { deadlines: deadlines };
}

function upsertDeadline(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.DEADLINES);
  initDeadlineSheet(sheet);
  var rows  = getAllRows(sheet);
  var id    = data.deadline_id || generateId();
  var now   = new Date().toISOString();

  var title = data.title || '';

  var phases = (data.phases || []).map(function(p) {
    return {
      name             : p.name         || '',
      planned_date     : p.planned_date || '',
      note             : p.note         || '',
      show_on_calendar : p.show_on_calendar !== undefined
        ? !!p.show_on_calendar
        : (p.name || '').indexOf('納品') >= 0,
      show_personal_calendar : p.show_personal_calendar !== undefined
        ? !!p.show_personal_calendar : p.show_on_calendar !== undefined
        ? !!p.show_on_calendar : (p.name || '').indexOf('納品') >= 0,
      show_admin_calendar : p.show_admin_calendar !== undefined
        ? !!p.show_admin_calendar : p.show_on_calendar !== undefined
        ? !!p.show_on_calendar : (p.name || '').indexOf('納品') >= 0,
      done             : !!p.done,
      done_date        : p.done_date    || '',
      status           : p.status       || '未着手',
      file_paths       : Array.isArray(p.file_paths) ? p.file_paths : [],
    };
  });

  var jsonData = {
    client     : data.client     || '',
    type       : data.type       || '単発',
    recur_mode : data.recur_mode || 'manual',
    phases     : phases,
    memo       : data.memo       || '',
    progress   : data.progress   || 0,
    file_paths : Array.isArray(data.file_paths) ? data.file_paths : [],
  };

  var idx       = rows.findIndex(function(r) { return r[DL_COL.ID - 1] === id; });
  var createdAt = (idx >= 0) ? (rows[idx][DL_COL.CREATED_AT - 1] || now) : now;

  var row = [
    id,                         // A: 案件ID
    title,                      // B: 案件名
    data.name        || '',     // C: 担当者名
    data.employee_id || '',     // D: 担当者ID
    JSON.stringify(jsonData),   // E: JSON
    createdAt,                  // F: 作成日時（新規のみ now）
    now,                        // G: 更新日時
  ];

  if (idx >= 0) {
    sheet.getRange(idx + 2, 1, 1, DL_NUM_COLS).setValues([row]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, DL_NUM_COLS).setValues([row]);
  }
  SpreadsheetApp.flush();

  if (jsonData.type === '継続' && jsonData.recur_mode === 'auto') {
    scheduleRecurringDeadline(sheet, id, jsonData, data.employee_id, data.name);
  }
  return { id: id, saved: true };
}

function scheduleRecurringDeadline(sheet, sourceId, dlData, empId, name) {
  var rows = getAllRows(sheet);
  var today = new Date(); var nm = new Date(today.getFullYear(), today.getMonth()+1, 1);
  var nextYM = nm.getFullYear()+'-'+String(nm.getMonth()+1).padStart(2,'0');

  var exists = rows.some(function(r){
    if (r[DL_COL.EMPLOYEE_ID - 1] !== empId) return false;
    var d = safeJsonParse(r[DL_COL.DATA - 1], {});
    return d.title === dlData.title && d.recur_source === sourceId
      && (d.phases||[]).some(function(p){ return (p.planned_date||'').startsWith(nextYM); });
  });
  if (exists) return;

  var newPhases = (dlData.phases||[]).map(function(p){
    var nd = '';
    if (p.planned_date) {
      var dd = new Date(p.planned_date);
      dd.setMonth(dd.getMonth()+1);
      nd = formatDateString(dd);
    }
    return Object.assign({}, p, { planned_date: nd, done: false, done_date: '' });
  });

  var newId  = generateId();
  var now2   = new Date().toISOString();
  var newJson = JSON.stringify(Object.assign({}, dlData, { phases: newPhases, recur_source: sourceId }));

  sheet.getRange(sheet.getLastRow()+1, 1, 1, DL_NUM_COLS).setValues([[
    newId,    // A: ID
    dlData.title || '',  // B: 案件名
    name,     // C: 担当者名
    empId,    // D: 担当者ID
    newJson,  // E: JSON
    now2,     // F: 作成日時
    now2,     // G: 更新日時
  ]]);
  SpreadsheetApp.flush();
}

function deleteDeadline(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.DEADLINES);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r){return r[0]===data.deadline_id;});
  if (idx===-1) throw new Error('案件が見つかりません: '+data.deadline_id);
  sheet.deleteRow(idx+2); SpreadsheetApp.flush();
  return { deleted:true, id:data.deadline_id };
}
