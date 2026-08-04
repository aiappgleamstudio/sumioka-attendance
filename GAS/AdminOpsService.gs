/**
 * AdminOpsService.gs - Admin ルーター・勤怠編集・スタッフ管理・月次補填・共通ユーティリティ
 *
 * 役割:
 *   Code.gs の handleAttendance から委譲される Admin 系アクションの
 *   ルーティング（handleAdminAction）と、勤怠編集・スタッフ管理・
 *   月次補填・監査ログ・日時フォーマット等の共通ユーティリティを実装する。
 *
 *   申請管理・カレンダー・納期管理・残業指示・打刻漏れ警告は
 *   それぞれ RequestService.gs / CalendarService.gs / DeadlineService.gs /
 *   OvertimeService.gs / AttendanceAlertService.gs に分割済み。
 *   給与計算は Payroll.gs の精密計算版に一本化済み（本ファイルはその呼び出しのみ）。
 *
 * 設計方針:
 *   - すべての公開関数は handleAdminAction() を通じて呼ばれる
 *   - シートが存在しない場合は getOrCreateSheet() で自動作成する
 *   - 日付は YYYY-MM-DD 文字列で統一
 *   - GAS は同一プロジェクト内でグローバル参照が効くため、
 *     他ファイルに分割された関数もそのまま呼び出せる
 *
 * 【2026-07-30 分割】
 *   旧 Adminservice.gs（2934行）を用途別に7ファイルへ分割した際、
 *   本ファイルにはルーター・勤怠編集・スタッフ管理・月次補填・
 *   共通ユーティリティ・申請シートマイグレーションを残した。
 *   以下は分割・統合に伴い削除した重複・旧実装:
 *     - safeJsonParse            → Code.gs に一本化（重複削除）
 *     - initTaskSheet 他タスク管理一式 → 新タスク管理v2（TaskService.gs）に全廃・一本化
 *     - payrollLoadSettings/payrollSaveSettings/payrollCalculate/payrollSaveIncentive
 *       → Payroll.gs の精密計算版（loadPayrollSettings/savePayrollSettings/
 *         calculatePayroll/savePayrollIncentive）に一本化。アクション名は維持し
 *         実装先だけ差し替えた。
 *   また adminAttendanceList の呼び出しが実引数4個・仮引数3個で不一致になっており
 *   （ss が誤って attendanceSheet に渡り、本来の data が渡らず ss.getLastRow is not
 *   a function で必ず例外になる不具合）、正しい引数で呼ぶよう修正した。
 *
 * @version 2.0.0
 */

'use strict';

// ============================================================
// エントリポイント
// ============================================================

function handleAdminAction(action, data, attendanceSheet, employeeSheet) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    switch (action) {
      case 'admin_dashboard':
        // Admin.gs の adminDashboard(attendanceSheet, employeeSheet, date) を呼ぶ。
        // ss は Admin.gs 内部で取得するため渡さない。
        return createSuccessResponse(adminDashboard(attendanceSheet, employeeSheet, data.date));
      case 'admin_attendance_list':
        // 【修正】adminAttendanceList は (attendanceSheet, employeeSheet, data) の3引数。
        // 旧コードは (ss, attendanceSheet, employeeSheet, data) の4引数で呼んでおり、
        // ss が Sheet でないため関数内の getAllRows(attendanceSheet) が必ず例外になっていた。
        return createSuccessResponse(adminAttendanceList(attendanceSheet, employeeSheet, data));
      case 'admin_edit_attendance':
        return createSuccessResponse(adminEditAttendance(ss, attendanceSheet, data));
      case 'admin_add_attendance':
        return createSuccessResponse(adminAddAttendance(ss, attendanceSheet, data));
      case 'admin_staff_list':
        // data オブジェクトごと渡す（type・location・job_type フィルタを含む）
        return createSuccessResponse(adminStaffList(employeeSheet, data));
      case 'admin_add_staff':
        return createSuccessResponse(adminAddStaff(employeeSheet, data));
      case 'admin_update_staff':
        return createSuccessResponse(adminUpdateStaff(employeeSheet, data));
      case 'admin_delete_staff':
        return createSuccessResponse(adminDeleteStaff(ss, employeeSheet, data));

      // ── 申請管理（RequestService.gs）──
      case 'submit_request':
        return createSuccessResponse(submitRequest(ss, data));
      case 'get_my_requests':
        return createSuccessResponse(getMyRequests(ss, data.employee_id));
      case 'admin_requests':
        return createSuccessResponse(adminRequests(ss, data));
      case 'admin_update_request':
        return createSuccessResponse(adminUpdateRequest(ss, data));
      case 'admin_edit_request':
        return createSuccessResponse(adminEditRequest(ss, data));
      // Admin が申請を物理削除する（誤登録・不要データの削除用）
      case 'admin_delete_request':
        return createSuccessResponse(adminDeleteRequest(ss, data));
      // スタッフが自分の pending 申請を取り下げる（cancelled 状態に変更）
      case 'cancel_request':
        return createSuccessResponse(cancelRequest(ss, data));
      case 'save_attendance_status':
        return createSuccessResponse(saveAttendanceStatus(ss, data));

      // ── カレンダー（CalendarService.gs）──
      case 'get_calendar':
        return createSuccessResponse(getCalendar(ss, attendanceSheet, employeeSheet, data));
      case 'get_company_calendar':
        return createSuccessResponse(getCompanyCalendar(ss, data.year_month));
      case 'save_company_calendar':
        return createSuccessResponse(saveCompanyCalendar(ss, data));

      // ── 納期管理（DeadlineService.gs）──
      case 'get_deadlines':
        return createSuccessResponse(getDeadlines(ss, data));
      case 'upsert_deadline':
        return createSuccessResponse(upsertDeadline(ss, data));
      case 'delete_deadline':
        return createSuccessResponse(deleteDeadline(ss, data));

      // ── 月次・補填 ──
      case 'get_my_status':
        return createSuccessResponse(getMyStatus(ss, attendanceSheet, data));
      case 'admin_monthly_fillup':
        return createSuccessResponse(adminMonthlyFillup(ss, attendanceSheet, employeeSheet, data.year_month));

      // ── 給与計算（Payroll.gs の精密計算版に一本化）──
      // アクション名はフロント無改修のため維持し、実装先だけ Payroll.gs に差し替える。
      // calculatePayroll は (attendanceSheet, employeeSheet, ss, yearMonth) の引数順で
      // 旧 payrollCalculate(ss, attendanceSheet, employeeSheet, yearMonth) とは順序が異なる。
      case 'payroll_calculate':
        return createSuccessResponse(calculatePayroll(attendanceSheet, employeeSheet, ss, data.year_month));
      case 'payroll_load_settings':
        return createSuccessResponse(loadPayrollSettings(ss));
      case 'payroll_save_settings':
        return createSuccessResponse(savePayrollSettings(ss, data.settings));
      case 'payroll_save_incentive':
        return createSuccessResponse(savePayrollIncentive(ss, data));

      // ── 残業指示（OvertimeService.gs）──
      case 'create_overtime_instruction':
        return createSuccessResponse(createOvertimeInstruction(ss, data));
      case 'admin_overtime_instructions':
        return createSuccessResponse(adminOvertimeInstructions(ss, data));
      case 'update_overtime_instruction_status':
        return createSuccessResponse(updateOvertimeInstructionStatus(ss, data));
      case 'delete_overtime_instruction':
        return createSuccessResponse(deleteOvertimeInstruction(ss, data));
      case 'submit_overtime_request':
        return createSuccessResponse(submitOvertimeRequest(ss, data));
      case 'admin_approve_overtime_request':
        return createSuccessResponse(adminApproveOvertimeRequest(ss, data));
      case 'admin_reject_overtime_request':
        return createSuccessResponse(adminRejectOvertimeRequest(ss, data));
      case 'get_overtime_instructions':
        return createSuccessResponse(getOvertimeInstructions(ss, data));

      // ── 打刻漏れ警告（AttendanceAlertService.gs）──
      case 'check_missing_clocks':
        return createSuccessResponse(checkMissingClocks(ss, attendanceSheet, employeeSheet, data));
      case 'check_missing_clocks_monthly':
        return createSuccessResponse(checkMissingClocksMonthly(ss, attendanceSheet, employeeSheet, data));
      case 'get_my_missing_clocks':
        return createSuccessResponse(getMyMissingClocks(ss, data));

      default:
        throw new Error('Unhandled admin action: ' + action);
    }
  } catch (err) {
    Logger.log('[handleAdminAction] action=%s, error=%s', action, err.message);
    return createErrorResponse('処理中にエラーが発生しました。', err.message);
  }
}

// ============================================================
// 共通ユーティリティ
// ============================================================
// safeJsonParse は Code.gs に一本化済み（重複削除、2026-07-30）。

function formatDateString(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth()+1).padStart(2,'0') + '-'
    + String(d.getDate()).padStart(2,'0');
}

/**
 * GAS の Date 型または ISO 文字列を HH:MM 形式に変換する。
 *
 * 修正内容:
 *   - 1899-12-30 問題: GAS が時刻文字列（HH:MM）をシリアル値0として保存した場合、
 *     Date型に変換すると年が1899になる。年<1900は空文字を返す。
 *   - タイムゾーンズレ: ISO文字列（例: 2024-01-01T10:00:00Z）の T以降をスライスすると
 *     UTC時刻になり、JST(UTC+9)では「10:00 → 01:00」のズレが発生する。
 *     Date オブジェクト経由で getHours() を呼ぶことで必ずローカル時刻を取得する。
 *   - "HH:MM" 文字列はそのまま先頭5文字を返す（最速パス）。
 */
function formatTimeDisplay_GAS(raw) {
  if (raw === null || raw === undefined || raw === '') return '';

  // ── number型: GASがスプシの時刻セルを「シリアル値（0〜1の小数）」で返した場合 ──
  if (typeof raw === 'number') {
    if (raw < 0 || raw >= 1) return '';
    var totalMinutes = Math.round(raw * 24 * 60);
    var h = Math.floor(totalMinutes / 60);
    var m = totalMinutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  if (raw instanceof Date) {
    var hh = raw.getHours();
    var mm = raw.getMinutes();
    if (raw.getFullYear() < 1900 && hh === 0 && mm === 0) return '';
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  if (typeof raw === 'string') {
    if (raw.startsWith('1899')) return '';
    if (/^\d{1,2}:\d{2}/.test(raw)) return raw.slice(0, 5);
    if (raw.includes('T')) {
      var d = new Date(raw);
      if (!isNaN(d.getTime())) {
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    }
  }

  return '';
}

function writeAuditLog(ss, entry) {
  try {
    var sheet = getOrCreateSheet(ss, SHEET.AUDIT_LOG);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1,1,1,7).setValues([['日時','操作','管理者ID','対象ID','対象日','理由','変更内容']]);
    }
    sheet.getRange(sheet.getLastRow()+1,1,1,7).setValues([[
      new Date().toISOString(), entry.action||'', entry.admin_id||'',
      entry.target_id||'', entry.target_date||'', entry.reason||'',
      (entry.before||'') + ' -> ' + (entry.after||'')
    ]]);
    SpreadsheetApp.flush();
  } catch(e) { Logger.log('[writeAuditLog] ' + e.message); }
}

// ============================================================
// 勤怠管理（Admin）
// ============================================================

function adminAttendanceList(attendanceSheet, employeeSheet, data) {
  var staffMap = {};
  getAllRows(employeeSheet).map(rowToEmployee).forEach(function(s){ if(s.id) staffMap[String(s.id)]=s; });
  var rows = getAllRows(attendanceSheet);
  if (data.date) { var dk=convertDateForDisplay(data.date); rows=rows.filter(function(r){return r[ATTENDANCE_COL.DATE-1]===dk;}); }
  if (data.employee_id) { rows=rows.filter(function(r){return r[ATTENDANCE_COL.EMPLOYEE_ID-1]===data.employee_id;}); }
  var records = rows.map(function(r) {
    var rec=rowToAttendanceRecord(r); var s=staffMap[rec.employee_id];

    var dateVal = rec.date || '';

    var breakMin = rec.data.break_minutes != null ? rec.data.break_minutes : 0;
    var workMin  = rec.data.work_minutes  != null ? rec.data.work_minutes  : null;
    if (workMin === null && rec.data.time_in && rec.data.time_out) {
      var tIn  = rec.data.time_in.split(':').map(Number);
      var tOut = rec.data.time_out.split(':').map(Number);
      workMin = Math.max(0, (tOut[0]*60 + tOut[1]) - (tIn[0]*60 + tIn[1]) - breakMin);
    }

    return {
      id            : rec.id,
      employee_id   : rec.employee_id,
      name          : s ? s.name : rec.employee_id,
      type          : s ? (s.employment_type||'') : '',
      date          : dateVal,
      status        : rec.data.status||'',
      time_in       : formatTimeDisplay_GAS(rec.data.time_in),
      time_out      : formatTimeDisplay_GAS(rec.data.time_out),
      break_minutes : rec.data.break_minutes != null ? rec.data.break_minutes : '',
      work_minutes  : workMin != null ? workMin : '',
      lunch         : rec.data.lunch,
      memo          : rec.data.memo||'',
    };
  });
  return { records:records, count:records.length };
}

function adminEditAttendance(ss, attendanceSheet, data) {
  writeAuditLog(ss,{action:'edit_attendance',admin_id:data.admin_id||'',target_id:data.employee_id,target_date:data.date,reason:data.reason||''});

  var ad = data.attendance_data || {};
  if (ad.time_in && ad.time_out && ad.work_minutes == null) {
    var tIn  = String(ad.time_in).split(':').map(Number);
    var tOut = String(ad.time_out).split(':').map(Number);
    var rawMin   = (tOut[0]*60 + tOut[1]) - (tIn[0]*60 + tIn[1]);
    var breakMin = (ad.break_minutes != null && ad.break_minutes !== '') ? Number(ad.break_minutes) : 0;
    ad.work_minutes = Math.max(0, rawMin - breakMin);
    Logger.log('[adminEditAttendance] work_minutes 自動計算: %d分 (rawMin=%d, break=%d)', ad.work_minutes, rawMin, breakMin);
  }

  return saveAttendanceRecord(attendanceSheet, {employee_id:data.employee_id,date:data.date,attendance_data:ad});
}

function adminAddAttendance(ss, attendanceSheet, data) {
  writeAuditLog(ss,{action:'add_attendance',admin_id:data.admin_id||'',target_id:data.employee_id,target_date:data.date,reason:data.reason||'管理者による代理登録'});

  var ad = data.attendance_data || {};
  if (ad.time_in && ad.time_out && ad.work_minutes == null) {
    var tIn  = String(ad.time_in).split(':').map(Number);
    var tOut = String(ad.time_out).split(':').map(Number);
    var rawMin   = (tOut[0]*60 + tOut[1]) - (tIn[0]*60 + tIn[1]);
    var breakMin = (ad.break_minutes != null && ad.break_minutes !== '') ? Number(ad.break_minutes) : 0;
    ad.work_minutes = Math.max(0, rawMin - breakMin);
    Logger.log('[adminAddAttendance] work_minutes 自動計算: %d分', ad.work_minutes);
  }

  return saveAttendanceRecord(attendanceSheet, {employee_id:data.employee_id,date:data.date,attendance_data:ad});
}

// ============================================================
// スタッフ管理（Admin）
// ============================================================

function adminStaffList(employeeSheet, data) {
  var type     = (typeof data === 'string') ? data : (data && data.type)     || '';
  var location = (data && typeof data === 'object') ? (data.location || '') : '';
  var jobType  = (data && typeof data === 'object') ? (data.job_type  || '') : '';

  var all = getAllRows(employeeSheet).map(rowToEmployee);

  Logger.log('[adminStaffList] 全件数=%d, type="%s"', all.length, type);

  all = all.filter(function(s) { return !s.deleted; });

  Logger.log('[adminStaffList] 削除済み除外後=%d', all.length);

  if (type === 'user')  all = all.filter(function(s){ return s.employment_type === '利用者'; });
  if (type === 'staff') all = all.filter(function(s){ return s.employment_type !== '利用者'; });

  Logger.log('[adminStaffList] 雇用形態フィルタ後=%d, employment_types=%s', all.length,
    all.map(function(s){ return s.employment_type; }).join(','));

  if (location) all = all.filter(function(s){ return s.location === location; });
  if (jobType)  all = all.filter(function(s){ return s.job_type === jobType; });

  var staff = all.map(function(s){
    return {
      id              : s.id,
      name            : s.name,
      last_name       : s.last_name,
      first_name      : s.first_name,
      pin             : s.pin,
      type            : s.employment_type || '',
      employment      : s.employment_type || '',
      scheduled_start : s.scheduled_start || '',
      scheduled_end   : s.scheduled_end   || '',
      scheduled_hours : s.scheduled_hours || '',
      scheduled_break : s.scheduled_break || '',
      wage_type       : s.wage_type       || '',
      hourly_wage     : s.hourly_wage     || '',
      monthly_wage    : s.monthly_wage    || '',
      work_days       : s.work_days       || [],
      transport_fee   : 0,
      is_admin        : !!s.is_admin,
      admin_role      : s.admin_role      || '',
      location        : s.location    || '',
      job_type        : s.job_type    || '',
      ins_health      : !!s.ins_health,
      ins_care        : !!s.ins_care,
      ins_pension     : !!s.ins_pension,
      ins_employment  : !!s.ins_employment,
    };
  });
  return { staff: staff };
}

function adminAddStaff(employeeSheet, data) {
  var sd = data.staff_data || {};

  var lastName  = sd.last_name  || (sd.name ? String(sd.name).split(/[\s　]+/)[0] : '');
  var firstName = sd.first_name || (sd.name ? String(sd.name).split(/[\s　]+/).slice(1).join(' ') : '');

  if (!lastName) throw new Error('staff_data.last_name（姓）は必須です。');
  if (!sd.pin)   throw new Error('staff_data.pin は必須です。');

  return saveEmployee(employeeSheet, {
    last_name  : lastName,
    first_name : firstName,
    pin        : String(sd.pin),
    password   : sd.password || '',
    employee_data: {
      employment_type : sd.employment_type  || '職員',
      scheduled_hours : sd.scheduled_hours  || '',
      scheduled_start : sd.scheduled_start  || '',
      scheduled_end   : sd.scheduled_end    || '',
      scheduled_break : sd.scheduled_break  != null ? sd.scheduled_break : '',
      wage_type       : sd.wage_type        || '',
      hourly_wage     : sd.hourly_wage      != null ? sd.hourly_wage : '',
      monthly_wage    : sd.monthly_wage     != null ? sd.monthly_wage : '',
      default_lunch   : sd.default_lunch    || false,
      work_days       : sd.work_days        || [],
      is_admin        : sd.is_admin         || false,
      admin_role      : sd.admin_role       !== undefined ? sd.admin_role : '',
      location       : sd.location       || '',
      job_type       : sd.job_type       || '',
      ins_health     : sd.ins_health     === true,
      ins_care       : sd.ins_care       === true,
      ins_pension    : sd.ins_pension    === true,
      ins_employment : sd.ins_employment === true,
    },
  });
}

function adminUpdateStaff(employeeSheet, data) {
  var sd = data.staff_data || {};
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  var lastName  = sd.last_name  || (sd.name ? String(sd.name).split(/[\s　]+/)[0] : '');
  var firstName = sd.first_name || (sd.name ? String(sd.name).split(/[\s　]+/).slice(1).join(' ') : '');

  var upd = {
    id         : data.employee_id,
    last_name  : lastName,
    first_name : firstName,
    pin        : String(sd.pin || ''),
    employee_data: {
      employment_type : sd.employment_type  || '職員',
      scheduled_hours : sd.scheduled_hours  || '',
      scheduled_start : sd.scheduled_start  || '',
      scheduled_end   : sd.scheduled_end    || '',
      scheduled_break : sd.scheduled_break  != null ? sd.scheduled_break : '',
      wage_type       : sd.wage_type        || '',
      hourly_wage     : sd.hourly_wage      != null ? sd.hourly_wage : '',
      monthly_wage    : sd.monthly_wage     != null ? sd.monthly_wage : '',
      default_lunch   : sd.default_lunch    || false,
      work_days       : sd.work_days        || [],
      is_admin        : sd.is_admin         || false,
      admin_role      : sd.admin_role       !== undefined ? sd.admin_role : '',
      location       : sd.location       || '',
      job_type       : sd.job_type       || '',
      ins_health     : sd.ins_health     === true,
      ins_care       : sd.ins_care       === true,
      ins_pension    : sd.ins_pension    === true,
      ins_employment : sd.ins_employment === true,
    },
  };

  if (sd.password) upd.password = sd.password;

  return saveEmployee(employeeSheet, upd);
}

function adminDeleteStaff(ss, employeeSheet, data) {
  if (!data.employee_id) throw new Error('employee_id は必須です。');
  writeAuditLog(ss,{action:'delete_staff',admin_id:data.admin_id||'',target_id:data.employee_id,reason:'スタッフ削除'});
  return deleteEmployee(employeeSheet, data.employee_id);
}

// ============================================================
// 月次・補填・出勤状況
// ============================================================

function getMyStatus(ss, attendanceSheet, data) {
  var empId=data.employee_id, ym=data.year_month;
  if (!empId||!ym) throw new Error('employee_id と year_month は必須です。');
  var yrmo=ym.split('-').map(Number);
  var lastDay=new Date(yrmo[0],yrmo[1],0).getDate();
  var sk=convertDateForDisplay(ym+'-01'), ek=convertDateForDisplay(ym+'-'+String(lastDay).padStart(2,'0'));
  var attRows=getAllRows(attendanceSheet).filter(function(r){
    return r[ATTENDANCE_COL.EMPLOYEE_ID-1]===empId && r[ATTENDANCE_COL.DATE-1]>=sk && r[ATTENDANCE_COL.DATE-1]<=ek;
  });
  var workDays=attRows.filter(function(r){return r[ATTENDANCE_COL.TIME_IN-1];}).length;
  var totalMin=attRows.reduce(function(s,r){var wm=r[ATTENDANCE_COL.WORK_MINUTES-1];return s+(typeof wm==='number'?wm:0);},0);
  var reqSheet=getOrCreateSheet(ss,SHEET.REQUESTS); initRequestSheet(reqSheet);
  var requests=getAllRequestRows(reqSheet).filter(function(r){return r[REQ_COL.EMPLOYEE_ID-1]===empId;}).map(rowToRequest)
    .filter(function(r){return String(r.target_date||'').replace(/\//g,'-').startsWith(ym);});
  return { attendance:{work_days:workDays,total_work_minutes:totalMin}, requests:requests, fillup:null };
}

function adminMonthlyFillup(ss, attendanceSheet, employeeSheet, yearMonth) {
  var allStaff=getAllRows(employeeSheet).map(rowToEmployee);
  var reqSheet=getOrCreateSheet(ss,SHEET.REQUESTS); initRequestSheet(reqSheet);
  var allReqs=getAllRequestRows(reqSheet).map(rowToRequest).filter(function(r){return (r.target_date||'').startsWith(yearMonth);});
  var fillup=allStaff.map(function(s){
    var myR=allReqs.filter(function(r){return r.employee_id===s.id;});
    var doneMin=myR.filter(function(r){return r.type==='補填完了'&&r.status==='approved';}).length*60;
    return { name:s.name, employee_id:s.id, short_minutes:0, filled_minutes:doneMin, remain_minutes:0 };
  });
  return { fillup:fillup };
}

// ============================================================
// マイグレーション: 申請管理シートにTIME列を追加
// ============================================================

/**
 * 申請管理シートにTIME列（13列目）を追加するマイグレーション。
 *
 * 【実行方法】
 *   GASエディタでこの関数（addRequestSheetTimeColumn）を選択して▶実行する。
 *   一度だけ実行すればOK。既に13列あれば何もしない。
 *
 * @returns {void}
 */
function addRequestSheetTimeColumn() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.REQUESTS);

  if (!sheet) {
    Logger.log('[addRequestSheetTimeColumn] 申請管理シートが存在しません。スキップします。');
    return;
  }

  var lastCol = sheet.getLastColumn();
  Logger.log('[addRequestSheetTimeColumn] 現在の列数: %d', lastCol);

  if (lastCol >= 13) {
    var headerVal = sheet.getRange(1, 13).getValue();
    Logger.log('[addRequestSheetTimeColumn] 13列目のヘッダー: "%s" → スキップ', headerVal);
    return;
  }

  sheet.getRange(1, 13).setValue('時刻');
  Logger.log('[addRequestSheetTimeColumn] ヘッダー「時刻」を追加しました。');

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var emptyCol = [];
    for (var i = 0; i < lastRow - 1; i++) emptyCol.push(['']);
    sheet.getRange(2, 13, lastRow - 1, 1).setValues(emptyCol);
    Logger.log('[addRequestSheetTimeColumn] %d 行のTIME列を空で初期化しました。', lastRow - 1);
  }

  SpreadsheetApp.flush();
  Logger.log('[addRequestSheetTimeColumn] ✅ 完了。申請管理シートが13列になりました。');
}
