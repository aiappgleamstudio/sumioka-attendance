/**
 * CalendarService.gs - カレンダー
 *
 * 役割:
 *   Kintai/Admin向けの月次カレンダーイベント取得（打刻由来の遅刻・早退・欠勤、
 *   申請由来の休み・補填・有給、会社カレンダー、案件納期の予定日）と、
 *   会社カレンダー（休日・行事）の取得・保存を実装する。
 *
 * 設計方針:
 *   - AdminOpsService.gs の handleAdminAction() から委譲される
 *   - DeadlineService.gs の DL_COL / initDeadlineSheet と RequestService.gs の
 *     REQ_COL / initRequestSheet / getAllRequestRows に依存する
 *     （GAS は同一プロジェクト内でグローバル参照が効くため import 不要）
 *
 * 【2026-07-30 分割】旧 Adminservice.gs（2934行）からカレンダー一式を分離。
 *
 * @version 1.0.0
 */

'use strict';

function getCalendar(ss, attendanceSheet, employeeSheet, data) {
  var yearMonth = data.year_month;
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) throw new Error('year_month は YYYY-MM 形式で指定してください。');
  var ym = yearMonth.split('-').map(Number);
  var lastDay  = new Date(ym[0],ym[1],0).getDate();
  var startKey = convertDateForDisplay(yearMonth+'-01');
  var endKey   = convertDateForDisplay(yearMonth+'-'+String(lastDay).padStart(2,'0'));

  var staffMap = {};
  getAllRows(employeeSheet).map(rowToEmployee).forEach(function(s){ if(s.id) staffMap[String(s.id)]=s; });

  // 打刻から遅刻・早退・欠勤を抽出
  var attEvents = getAllRows(attendanceSheet)
    .filter(function(r){ var d=r[ATTENDANCE_COL.DATE-1]; return d>=startKey && d<=endKey; })
    .filter(function(r){ return ['遅刻','早退','欠勤'].indexOf(r[ATTENDANCE_COL.STATUS-1])>=0; })
    .map(function(r){
      var rec=rowToAttendanceRecord(r); var s=staffMap[rec.employee_id];
      return { type:rec.data.status||'', target_date:String(rec.data.date||'').replace(/\//g,'-'),
        employee_id:rec.employee_id, name:s?s.name:rec.employee_id, status:'approved' };
    });

  // 申請シートから該当月の全申請を抽出する。
  var reqSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(reqSheet);
  var reqEvents = getAllRequestRows(reqSheet)
    .filter(function(r) {
      var reqStatus = String(r[REQ_COL.STATUS - 1] || '');
      if (reqStatus === 'rejected')  return false;
      if (reqStatus === 'cancelled') return false; // 取り下げ済みはカレンダーに表示しない
      var rawDate = String(r[REQ_COL.TARGET_DATE - 1] || '');
      var d = rawDate.length > 10 && rawDate.charAt(4) === '-'
              ? rawDate.slice(0, 10)
              : rawDate.replace(/\//g, '-').slice(0, 10);
      return d.startsWith(yearMonth)
        && ['補填予定','補填完了','休み','遅刻','早退','有給'].indexOf(r[REQ_COL.TYPE - 1]) >= 0;
    })
    .map(function(r) {
      var rawDate    = String(r[REQ_COL.TARGET_DATE - 1] || '');
      var targetDate = rawDate.length > 10 && rawDate.charAt(4) === '-'
                       ? rawDate.slice(0, 10)
                       : rawDate.replace(/\//g, '-').slice(0, 10);
      return {
        type        : r[REQ_COL.TYPE        - 1] || '',
        target_date : targetDate,
        employee_id : r[REQ_COL.EMPLOYEE_ID - 1] || '',
        name        : r[REQ_COL.NAME        - 1] || '',
        status      : r[REQ_COL.STATUS      - 1] || 'pending',
        reason      : r[REQ_COL.REASON      - 1] || '',
        time        : formatTimeDisplay_GAS(r[REQ_COL.TIME - 1]) || '',
      };
    });

  // 会社カレンダー（休日・行事）を取得する。
  var companyCalSheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var companyEvents = [];
  var includeCompanyCal = data.include_company_cal !== false; // デフォルト: true（Kintai向け）
  if (includeCompanyCal && companyCalSheet.getLastRow() > 1) {
    companyEvents = getAllRows(companyCalSheet)
      .filter(function(r){
        var d = String(r[0]||'').replace(/\//g,'-');
        return d.startsWith(yearMonth);
      })
      .map(function(r){
        return {
          type        : '会社休日',
          target_date : String(r[0]||'').replace(/\//g,'-'),
          employee_id : '',
          name        : r[1]||'会社休日',
          status      : 'approved',
          reason      : r[1]||''
        };
      });
  }

  // 自分の担当案件の各フェーズの「予定日」をカレンダーに表示する（Kintai側用）。
  var deadlineEvents = [];
  if (data.employee_id) {
    var dlSheet = getOrCreateSheet(ss, SHEET.DEADLINES);
    initDeadlineSheet(dlSheet);
    getAllRows(dlSheet)
      .filter(function(r) {
        var bVal = String(r[1] || '');
        var empIdCol = bVal.length > 30 ? r[1] : r[DL_COL.EMPLOYEE_ID - 1];
        return empIdCol === data.employee_id;
      })
      .forEach(function(r){
        var bVal = String(r[1] || '');
        var isOld = bVal.length > 30;
        var d = safeJsonParse(isOld ? r[3] : r[DL_COL.DATA-1], {});
        var phases = Array.isArray(d.phases) ? d.phases : [];
        phases.forEach(function(p){
          var showOnCal = p.show_on_calendar !== undefined
            ? !!p.show_on_calendar
            : (p.name || '').indexOf('納品') >= 0;
          if (p.planned_date && p.planned_date.startsWith(yearMonth) && showOnCal) {
            deadlineEvents.push({
              type        : '納期',
              target_date : p.planned_date,
              employee_id : data.employee_id,
              name        : (d.title || '') + '：' + (p.name || ''),
              status      : 'approved',
              reason      : p.done ? '完了済' : '予定',
            });
          }
        });
      });
  }

  return { events: attEvents.concat(reqEvents).concat(companyEvents).concat(deadlineEvents) };
}

function getCompanyCalendar(ss, yearMonth) {
  var sheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  if (sheet.getLastRow()<=1) return { dates:[] };
  var rows  = getAllRows(sheet);
  var dates = rows.filter(function(r){
    var d=String(r[0]||'').replace(/\//g,'-');
    return yearMonth ? d.startsWith(yearMonth) : true;
  }).map(function(r){ return { date:String(r[0]||'').replace(/\//g,'-'), title:r[1]||'' }; });
  return { dates:dates };
}

function saveCompanyCalendar(ss, data) {
  if (!data.dates||!data.dates.length) throw new Error('dates は必須です。');
  if (!data.title) data.title = '会社休日';
  var sheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  if (sheet.getLastRow()===0) sheet.getRange(1,1,1,2).setValues([['日付','名称']]);
  var existing = getAllRows(sheet);
  data.dates.forEach(function(d){
    var dk  = convertDateForDisplay(d);
    var idx = existing.findIndex(function(r){return r[0]===dk;});
    if (idx>=0) sheet.getRange(idx+2,1,1,2).setValues([[dk,data.title]]);
    else sheet.getRange(sheet.getLastRow()+1,1,1,2).setValues([[dk,data.title]]);
  });
  SpreadsheetApp.flush();
  writeAuditLog(ss,{action:'save_company_calendar',admin_id:data.admin_id||'',reason:'会社カレンダー: '+data.title});
  return { saved:true, count:data.dates.length };
}
