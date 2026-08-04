/**
 * AdminServices.gs - 管理者・申請・カレンダー・タスク・納期・給与計算
 *
 * 役割:
 *   Code.gs の handleAttendance から委譲されるアクションを実装する。
 *
 * 設計方針:
 *   - すべての公開関数は handleAdminAction() を通じて呼ばれる
 *   - シートが存在しない場合は getOrCreateSheet() で自動作成する
 *   - 日付は YYYY-MM-DD 文字列で統一
 *   - タスク・納期は JSON を単一セルに格納（拡張が容易）
 *
 * @version 1.0.0
 */

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
        return createSuccessResponse(adminAttendanceList(ss, attendanceSheet, employeeSheet, data));
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
      case 'submit_request':
        return createSuccessResponse(submitRequest(ss, data));
      case 'get_my_requests':
        return createSuccessResponse(getMyRequests(ss, data.employee_id));
      case 'admin_requests':
        return createSuccessResponse(adminRequests(ss, data));
      case 'admin_update_request':
        return createSuccessResponse(adminUpdateRequest(ss, data));
      // 申請内容の直接編集（種別・対象日・時刻・理由・ステータス）
      // フロントのバリデーションを通過したものをGAS側でも再検証してから保存する
      case 'admin_edit_request':
        return createSuccessResponse(adminEditRequest(ss, data));
      // Admin が申請を物理削除する（誤登録・不要データの削除用）
      // 操作は監査ログに記録し、削除後は復元不可であることをフロントで警告する
      case 'admin_delete_request':
        return createSuccessResponse(adminDeleteRequest(ss, data));
      // スタッフが自分の pending 申請を取り下げる（cancelled 状態に変更）
      // approved済みは取り下げ不可。取り下げ後は再申請が必要。
      case 'cancel_request':
        return createSuccessResponse(cancelRequest(ss, data));
      // Admin が欠席・遅刻・早退・外出勤務などを申請管理シートに直接登録する
      case 'save_attendance_status':
        return createSuccessResponse(saveAttendanceStatus(ss, data));
      case 'get_calendar':
        return createSuccessResponse(getCalendar(ss, attendanceSheet, employeeSheet, data));
      case 'get_company_calendar':
        return createSuccessResponse(getCompanyCalendar(ss, data.year_month));
      case 'save_company_calendar':
        return createSuccessResponse(saveCompanyCalendar(ss, data));
      case 'get_tasks':
        return createSuccessResponse(getTasks(ss, data));
      case 'upsert_task':
        return createSuccessResponse(upsertTask(ss, data));
      case 'delete_task':
        return createSuccessResponse(deleteTaskGas(ss, data));
      case 'admin_all_tasks':
        return createSuccessResponse(adminAllTasks(ss));
      case 'get_deadlines':
        return createSuccessResponse(getDeadlines(ss, data));
      case 'upsert_deadline':
        return createSuccessResponse(upsertDeadline(ss, data));
      case 'delete_deadline':
        return createSuccessResponse(deleteDeadline(ss, data));
      case 'get_my_status':
        return createSuccessResponse(getMyStatus(ss, attendanceSheet, data));
      case 'admin_monthly_fillup':
        return createSuccessResponse(adminMonthlyFillup(ss, attendanceSheet, employeeSheet, data.year_month));
      case 'payroll_calculate':
        return createSuccessResponse(payrollCalculate(ss, attendanceSheet, employeeSheet, data.year_month));
      case 'payroll_load_settings':
        return createSuccessResponse(payrollLoadSettings(ss));
      case 'payroll_save_settings':
        return createSuccessResponse(payrollSaveSettings(ss, data.settings));
      case 'payroll_save_incentive':
        return createSuccessResponse(payrollSaveIncentive(ss, data));

      // ── 残業指示 ──
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

      // ── 打刻漏れ警告 ──
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

function safeJsonParse(str, defaultVal) {
  try { return str ? JSON.parse(str) : defaultVal; }
  catch (_) { return defaultVal; }
}

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
  // 例: 09:00 → 0.375, 12:00 → 0.5, 18:30 → 0.770833...
  // 0〜1の範囲の数値は時刻シリアル値として HH:MM に変換する。
  // 0（00:00）は時刻として正当なため !raw では弾けないことに注意。
  if (typeof raw === 'number') {
    // 1899-12-30のシリアル値0は「00:00」として正当。負数や1以上は不正データ。
    if (raw < 0 || raw >= 1) return '';
    var totalMinutes = Math.round(raw * 24 * 60);
    var h = Math.floor(totalMinutes / 60);
    var m = totalMinutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  if (raw instanceof Date) {
    // GASの「1899-12-30問題」:
    // スプシの時刻セル（HH:MM テキストや時刻書式）を getValues() すると
    // 1899-12-30 HH:MM:00 JST のDate型で返ることがある。
    // 年が1899でも時刻部分（getHours/getMinutes）は正しい値を持っているため
    // 時刻として取り出して使う。年が1900未満でも時刻を返す。
    // ただし getFullYear() < 1900 かつ getHours()==0 かつ getMinutes()==0 は
    // 本当に「値なし」の可能性があるため空文字にする。
    var hh = raw.getHours();
    var mm = raw.getMinutes();
    if (raw.getFullYear() < 1900 && hh === 0 && mm === 0) return '';
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  if (typeof raw === 'string') {
    // "1899..." 文字列は誤変換データ → 空文字
    if (raw.startsWith('1899')) return '';

    // "HH:MM" または "H:MM" 形式は直接スライス（最速パス）
    if (/^\d{1,2}:\d{2}/.test(raw)) return raw.slice(0, 5);

    // ISO 8601 文字列（例: 2024-01-01T10:00:00+09:00）は Date 経由でローカル時刻を取得する。
    // ※ raw.match(/T(\d{2}):(\d{2})/) は UTC時刻を取得してしまうためNG。
    //    new Date(raw).getHours() で JST ローカル時刻を取得する。
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
// ダッシュボード
// ============================================================
// 【重要】adminDashboard の実装は Admin.gs に一本化する。
// この呼び出し側（handleAdminAction）は (ss, attendanceSheet, employeeSheet, date) を
// 渡しているが、Admin.gs の実装は (attendanceSheet, employeeSheet, date) を受け取る。
// ss は Admin.gs 内で SpreadsheetApp.getActiveSpreadsheet() を呼んで取得するため
// ここでは渡さない。引数の不一致を解消するため、case 'admin_dashboard' の呼び出しを
// Admin.gs の関数シグネチャに合わせてラップ関数経由で呼ぶ。

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

    // 【バグ修正】date は rec.data にはなく rec.date に格納されている。
    // 旧コードの rec.data.date は常に undefined → '' → '―' 表示になっていた。
    var dateVal = rec.date || '';

    // break_minutes が保存されている場合、work_minutes も保存済みの値を使う。
    // 保存されていない場合（古いデータ・Admin修正で未計算）は time_in/out から再計算する。
    var breakMin = rec.data.break_minutes != null ? rec.data.break_minutes : 0;
    var workMin  = rec.data.work_minutes  != null ? rec.data.work_minutes  : null;
    if (workMin === null && rec.data.time_in && rec.data.time_out) {
      // フォールバック: 出退勤差分 - 休憩で再計算（保存漏れのデータ対応）
      var tIn  = rec.data.time_in.split(':').map(Number);
      var tOut = rec.data.time_out.split(':').map(Number);
      workMin = Math.max(0, (tOut[0]*60 + tOut[1]) - (tIn[0]*60 + tIn[1]) - breakMin);
    }

    // 弁当は rowToAttendanceRecord が '有' → true に変換済み。boolean で返す。
    return {
      id            : rec.id,
      employee_id   : rec.employee_id,
      name          : s ? s.name : rec.employee_id,
      type          : s ? (s.employment_type||'') : '',
      date          : dateVal,   // 【修正】rec.date を使う
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

  // 【バグ修正】フロントから work_minutes が送られてこない場合、
  // time_in / time_out / break_minutes から GAS 側で再計算して保存する。
  // こうすることで「休憩が実働から差し引かれない」問題を解消する。
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

  // 新規登録時も work_minutes を自動計算する
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
  // data オブジェクトから type・location・job_type フィルタを取得する。
  // 後方互換のため data が文字列（旧形式）で来た場合も type として扱う。
  var type     = (typeof data === 'string') ? data : (data && data.type)     || '';
  var location = (data && typeof data === 'object') ? (data.location || '') : '';
  var jobType  = (data && typeof data === 'object') ? (data.job_type  || '') : '';

  var all = getAllRows(employeeSheet).map(rowToEmployee);

  Logger.log('[adminStaffList] 全件数=%d, type="%s"', all.length, type);

  // 論理削除済みのスタッフは常に除外する
  all = all.filter(function(s) { return !s.deleted; });

  Logger.log('[adminStaffList] 削除済み除外後=%d', all.length);

  // 雇用形態フィルタ
  if (type === 'user')  all = all.filter(function(s){ return s.employment_type === '利用者'; });
  if (type === 'staff') all = all.filter(function(s){ return s.employment_type !== '利用者'; });

  Logger.log('[adminStaffList] 雇用形態フィルタ後=%d, employment_types=%s', all.length,
    all.map(function(s){ return s.employment_type; }).join(','));

  // 拠点フィルタ（指定がある場合のみ絞り込む）
  if (location) all = all.filter(function(s){ return s.location === location; });

  // 職種フィルタ（指定がある場合のみ絞り込む）
  if (jobType)  all = all.filter(function(s){ return s.job_type === jobType; });

  var staff = all.map(function(s){
    // scheduled_start / scheduled_end は rowToEmployee 内で _safeTimeStr 処理済み
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

      // 管理者権限ロール。'' = 権限なし。フロントで '権限なし' と表示する。
      admin_role      : s.admin_role      || '',

      // v2.0.0 追加: 拠点・職種・社保フラグをフロントに返す
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

  // 姓・名を個別に受け取り、saveEmployee に渡す。
  // 後方互換: フロントが name（旧形式）で送ってきた場合もスペース分割で対応する。
  var lastName  = sd.last_name  || (sd.name ? String(sd.name).split(/[\s\u3000]+/)[0] : '');
  var firstName = sd.first_name || (sd.name ? String(sd.name).split(/[\s\u3000]+/).slice(1).join(' ') : '');

  if (!lastName) throw new Error('staff_data.last_name（姓）は必須です。');
  if (!sd.pin)   throw new Error('staff_data.pin は必須です。');

  // PIN は文字列として渡す（'0123' が数値 123 になるのを防ぐ）
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

      // 管理者権限ロール。フロントから '' または '管理者'/'給与計算担当'/'一般職員' が来る。
      // is_admin は後方互換で残すが、判定は admin_role !== '' で行う（Code.gs 参照）。
      admin_role      : sd.admin_role       !== undefined ? sd.admin_role : '',

      // v2.0.0 追加: 拠点・職種・社保フラグ
      // 新規追加時のデフォルト: 拠点=半田、職種=PC作業、社保=全未加入。
      // Admin が入力フォームで選択してから保存するため、
      // ここのデフォルトはあくまでフォールバック値。
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

  var lastName  = sd.last_name  || (sd.name ? String(sd.name).split(/[\s\u3000]+/)[0] : '');
  var firstName = sd.first_name || (sd.name ? String(sd.name).split(/[\s\u3000]+/).slice(1).join(' ') : '');

  var upd = {
    id         : data.employee_id,
    last_name  : lastName,
    first_name : firstName,
    pin        : String(sd.pin || ''),  // 文字列として保存
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

      // 管理者権限ロール。フロントから '' または '管理者'/'給与計算担当'/'一般職員' が来る。
      // is_admin は後方互換で残すが、判定は admin_role !== '' で行う（Code.gs 参照）。
      admin_role      : sd.admin_role       !== undefined ? sd.admin_role : '',

      // v2.0.0 追加: 拠点・職種・社保フラグ
      // フロントから明示的に送られてきた値を保存する。
      // フォームで未入力の場合は '' / false になって保存される（意図的な上書き）。
      location       : sd.location       || '',
      job_type       : sd.job_type       || '',
      ins_health     : sd.ins_health     === true,
      ins_care       : sd.ins_care       === true,
      ins_pension    : sd.ins_pension    === true,
      ins_employment : sd.ins_employment === true,
    },
  };

  // パスワードが送られてきた場合は更新、省略された場合は既存値を維持する。
  if (sd.password) upd.password = sd.password;

  return saveEmployee(employeeSheet, upd);
}

function adminDeleteStaff(ss, employeeSheet, data) {
  if (!data.employee_id) throw new Error('employee_id は必須です。');
  writeAuditLog(ss,{action:'delete_staff',admin_id:data.admin_id||'',target_id:data.employee_id,reason:'スタッフ削除'});
  return deleteEmployee(employeeSheet, data.employee_id);
}

// ============================================================
// 申請管理
// ============================================================

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

    // ルール1: 5分単位チェック
    if (fillupMin % 5 !== 0) {
      throw new Error('補填時間は5分単位で入力してください（入力値: ' + fillupMin + '分）。');
    }

    // ルール3: 当月限定チェック（対象日と補填日が同じ月）
    var targetYM  = String(data.target_date || '').slice(0, 7); // 'YYYY-MM'
    var fillupYM  = String(data.fillup_date || '').slice(0, 7);
    if (targetYM && fillupYM && targetYM !== fillupYM) {
      throw new Error('補填は当月内のみ有効です。翌月以降への繰り越しはできません（対象: ' + targetYM + '、補填日: ' + fillupYM + '）。');
    }

    // ルール2: 月8時間（480分）上限チェック
    // 同じスタッフの当月の承認済み補填合計を集計する
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

  // 承認フローの判定:
  //   補填あり（compensation='fillup'）または有給消化（compensation='paid'）の場合は
  //   管理者の承認が必要なため 'pending' にする。
  //   それ以外（補填・有給なしの休み・遅刻・早退・外出勤務）は即承認 'approved'。
  var needsApproval = (data.compensation === 'fillup' || data.compensation === 'paid');
  var status        = needsApproval ? 'pending' : 'approved';

  // data.time: 遅刻=出勤予定時刻 / 早退=退勤予定時刻（HH:MM）。それ以外は空文字。
  var time = (data.type === '遅刻' || data.type === '早退') ? (data.time || '') : '';

  // 対象日を YYYY-MM-DD 文字列に正規化する。
  // GAS の setValues はセル書式が「日付」だと文字列でも Date 型に変換してしまう。
  // setNumberFormat('@') でテキスト形式を先に指定して ISO 変換を防ぐ。
  var rawDate    = String(data.target_date || data.date || '').replace(/\//g, '-');
  var targetDate = rawDate.slice(0, 10); // "YYYY-MM-DD" 以降を切り捨て（ISO末尾除去）

  var newRowNum = sheet.getLastRow() + 1;

  // F列（TARGET_DATE）とM列（TIME = 予定時刻）をテキスト形式に固定する。
  // GASはHH:MM文字列を時刻書式として自動変換するため、テキスト形式を先に指定して防ぐ。
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
    // 承認フロー列: シートで人が読める日本語で保存する（旧: 'true'/'false'）
    // rowToRequest での読み込みは !== 'false' と !== '不要' の両方に対応済み
    needsApproval ? '承認が必要' : '不要',
    '',        // approved_by
    '',        // approved_at
    '',        // reject_reason
    now,       // created_at
    time,      // M列: 申請時刻（遅刻=出勤予定 / 早退=退勤予定 HH:MM）
    '',        // N列: 遅刻時間（旧フィールド、空で保存）
    '',        // O列: 早退時間（旧フィールド、空で保存）
    data.compensation || '',  // P列: 申請種別区分（fillup/paid/none）
  ]]);
  SpreadsheetApp.flush();

  return { id: id, submitted: true, needs_approval: needsApproval };
}

/**
 * 申請管理シートの全行を確実に REQ_NUM_COLS 列で読み取る。
 *
 * getAllRows() は Code.gs の switch 文で列数を決めるため、
 * Code.gs が古い場合に REQ_NUM_COLS=16 が使われない問題がある。
 * この関数は直接 sheet.getRange で REQ_NUM_COLS 列を指定して読むことで
 * Code.gs のバージョンに依存しない確実な読み取りを保証する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array[]} 2行目以降のデータ行配列
 */
function getAllRequestRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  // 実際のシート列数と REQ_NUM_COLS の小さい方を使う（列数不足でもエラーにしない）
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

  // action: 'approve' | 'reject' | 'revert'（承認待ちに戻す）
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

  // 承認待ち件数を返してフロントのバッジを更新する
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
 * 誤登録・重複登録などの管理者判断で完全削除する。
 * 削除は取り消せないため、フロント側で確認ダイアログを必須とする。
 * 監査ログに削除操作を記録することでトレーサビリティを確保する。
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

  // 削除前に監査ログへ記録する（削除後は行が消えてしまうため、先にログを書く）
  var targetRow = rows[idx];
  writeAuditLog(ss, {
    action    : 'delete_request',
    admin_id  : data.admin_id || '',
    target_id : data.request_id,
    target_date: String(targetRow[REQ_COL.TARGET_DATE-1]||''),
    reason    : '管理者による申請削除',
    before    : [targetRow[REQ_COL.NAME-1], targetRow[REQ_COL.TYPE-1], targetRow[REQ_COL.STATUS-1]].join(' / '),
  });

  sheet.deleteRow(idx + 2); // ヘッダー行(1) + 0始まりインデックス補正(1)
  SpreadsheetApp.flush();

  Logger.log('[adminDeleteRequest] 削除: id=%s, by=%s', data.request_id, data.admin_id);
  return { deleted: true, id: data.request_id };
}

/**
 * スタッフが自分の pending 申請を取り下げる（cancelled 状態へ変更）。
 *
 * 承認フロー:
 *   pending  → cancelled（取り下げ可）
 *   approved → 取り下げ不可（管理者へ連絡が必要）
 *   rejected → 取り下げ不可（再申請を促す）
 *
 * セキュリティ: employee_id と request の申請者IDが一致することを確認する。
 * 他人の申請を取り下げることを防ぐ。
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

  // セキュリティチェック: 自分の申請のみ取り下げ可能
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
    // 承認済みの取り下げ申請: rejected に変更して管理者に通知する。
    // 管理者側の申請管理画面に「却下理由: スタッフによる取り下げ申請」として表示される。
    // 管理者が確認後に物理削除（admin_delete_request）することで完結する。
    sheet.getRange(rowNum, REQ_COL.STATUS).setValue('rejected');
    sheet.getRange(rowNum, REQ_COL.REJECT_REASON).setValue('【取り下げ申請】スタッフによる取り下げ申請');
    Logger.log('[cancelRequest] 取り下げ申請（承認済み）: id=%s, empId=%s', data.request_id, data.employee_id);
  } else {
    // pending の取り下げ: cancelled に変更して即完了
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
 * フロントのバリデーションを通過したものを GAS 側でも再検証することで
 * 「202605-05-11」のような不正日付がシートに入るのを防ぐ。
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

  // 対象日のバリデーション: YYYY-MM-DD 形式のみ許可する
  var targetDate = String(data.target_date || '');
  if (!targetDate) throw new Error('対象日は必須です。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('対象日の形式が正しくありません: ' + targetDate + ' (YYYY-MM-DD で入力してください)');
  }

  // 種別のバリデーション: 許可された値のみ受け付ける
  var allowedTypes = ['休み', '遅刻', '早退', '補填予定', '補填完了', '有給', '残業'];
  var type = data.type || '';
  if (!allowedTypes.includes(type)) throw new Error('不正な申請種別です: ' + type);

  // ステータスのバリデーション
  var allowedStatuses = ['pending', 'approved', 'rejected'];
  var status = data.status || 'approved';
  if (!allowedStatuses.includes(status)) throw new Error('不正なステータスです: ' + status);

  // 対象行を ID で検索する
  var rows = getAllRequestRows(sheet);
  var idx  = rows.findIndex(function(r){ return r[REQ_COL.ID-1] === requestId; });
  if (idx === -1) throw new Error('申請が見つかりません: ' + requestId);

  var rowNum = idx + 2; // ヘッダー行(1) + 0始まりインデックス補正(1)

  // 種別・対象日・理由・時刻・ステータスを上書きする
  sheet.getRange(rowNum, REQ_COL.TYPE       ).setValue(type);
  // TARGET_DATE列をテキスト形式に固定してから書き込む（ISO変換防止）
  sheet.getRange(rowNum, REQ_COL.TARGET_DATE).setNumberFormat('@').setValue(targetDate);
  sheet.getRange(rowNum, REQ_COL.REASON     ).setValue(data.reason || '');
  sheet.getRange(rowNum, REQ_COL.STATUS     ).setValue(status);

  // TIME 列（13列目）: 遅刻・早退のみ時刻を保存。それ以外は空にする。
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
 * 「欠席・遅刻・早退・外出の登録」モーダルから呼ばれる。
 * submit_request と同じシートに書き込み、status='approved'（即承認）で登録する。
 *
 * フロントから受け取る data の構造:
 *   {
 *     employee_id : string,   // 登録対象のスタッフID
 *     name        : string,   // スタッフ名（表示用）
 *     date        : string,   // 対象日 YYYY-MM-DD
 *     status      : string,   // 'absent'|'paid_leave'|'substitute_holiday'|'holiday'|'remote'|'outing'
 *     note        : string,   // 備考（任意）
 *     created_by  : string,   // 登録した管理者のID
 *   }
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

  // status値を日本語の申請種別に変換してシートに保存する
  var statusMap = {
    'absent'            : '欠席',
    'paid_leave'        : '有給',
    'substitute_holiday': '補填休',
    'holiday'           : '会社休日',
    'remote'            : '在宅',
    'outing'            : '外出勤務',
  };
  var typeStr = statusMap[data.status] || data.status || '欠席';

  // 対象日のフォーマット検証
  var targetDate = String(data.date).replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('日付の形式が正しくありません: ' + targetDate);
  }

  var id  = generateId();
  var now = new Date().toISOString();
  var newRowNum = sheet.getLastRow() + 1;

  // TARGET_DATE列とTIME列をテキスト形式に固定してISO変換・時刻変換を防ぐ
  sheet.getRange(newRowNum, REQ_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, REQ_COL.TIME).setNumberFormat('@');

  sheet.getRange(newRowNum, 1, 1, REQ_NUM_COLS).setValues([[
    id,
    data.employee_id || '',
    data.name        || '',
    'approved',        // Admin登録なので即承認
    typeStr,           // 申請種別（日本語）
    targetDate,        // 対象日 YYYY-MM-DD
    data.note        || '',
    '不要',           // 承認フロー（Admin登録は即承認なので不要）
    data.created_by  || '',
    now,
    '',
    now,
    '',                // M列: 申請時刻（空）
    '',                // N列: 遅刻時間（空）
    '',                // O列: 早退時間（空）
    '',                // P列: 申請種別区分（空）
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
    // target_date: シートがDate型・ISO文字列・スラッシュ区切り等で返す場合を安全に変換する
    target_date    : (function(raw) {
      if (!raw) return '';
      // Date型（GASがDate型で返した場合）→ YYYY-MM-DD に変換
      if (raw instanceof Date) {
        var y = raw.getFullYear();
        var mo = String(raw.getMonth() + 1).padStart(2, '0');
        var d  = String(raw.getDate()).padStart(2, '0');
        return y + '-' + mo + '-' + d;
      }
      var s = String(raw);
      // "2026-05-28T15:00:00.000Z" のようなISO形式は先頭10文字を使う
      if (s.length > 10 && s.charAt(4) === '-') return s.slice(0, 10);
      // "2026/05/28" → "2026-05-28"
      return s.replace(/\//g, '-').slice(0, 10);
    })(row[REQ_COL.TARGET_DATE - 1]),
    reason         : row[REQ_COL.REASON         - 1] || '',
    // needs_approval: シートには '承認が必要'/'不要'（新）または 'true'/'false'（旧）が入る。
    // 旧データ互換のため両方のパターンを判定する。
    needs_approval : (function(v) {
      if (v === '承認が必要' || v === 'true')  return true;
      if (v === '不要'       || v === 'false') return false;
      return v !== 'false'; // その他は true 扱い（安全側）
    })(row[REQ_COL.NEEDS_APPROVAL - 1]),
    approved_by    : row[REQ_COL.APPROVED_BY    - 1] || '',
    approved_at    : row[REQ_COL.APPROVED_AT    - 1] || '',
    reject_reason  : row[REQ_COL.REJECT_REASON  - 1] || '',
    created_at     : row[REQ_COL.CREATED_AT     - 1] || '',
    // TIME 列（M列=13列目）: 遅刻=出勤予定時刻 / 早退=退勤予定時刻（HH:MM）。
    // GASはシートのHH:MM文字列をDate型や数値（時刻シリアル値）として返すことがある。
    // formatTimeDisplay_GAS() で確実にHH:MM文字列に変換する。
    time           : formatTimeDisplay_GAS(row[REQ_COL.TIME         - 1]) || '',
    // N列(14): 遅刻時間、O列(15): 早退時間（旧フィールド、互換用）
    late_time      : formatTimeDisplay_GAS(row[REQ_COL.LATE_TIME    - 1]) || '',
    early_leave_time: formatTimeDisplay_GAS(row[REQ_COL.EARLY_TIME  - 1]) || '',
    // P列(16): 申請種別区分（fillup/paid/none）
    request_kind   : row[REQ_COL.REQUEST_KIND - 1] || '',
  };
}

// ============================================================
// カレンダー（A-10, A-11, A-12）
// ============================================================

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
  // 承認フロー撤廃により approved のみ。
  // target_date は Date 型や数値で返ることがあるため String() で安全に変換する。
  // （startsWith is not a function エラーの原因がこれ）
  var reqSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(reqSheet);
  var reqEvents = getAllRequestRows(reqSheet)
    .filter(function(r) {
      var reqStatus = String(r[REQ_COL.STATUS - 1] || '');
      if (reqStatus === 'rejected')  return false;
      if (reqStatus === 'cancelled') return false; // 取り下げ済みはカレンダーに表示しない
      // target_date がISO形式（Date型由来: "2026-05-28T15:00:00.000Z"）でも先頭10文字で比較する
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
        // TIME列（M列=13列目）: 遅刻=出勤予定時刻 / 早退=退勤予定時刻（HH:MM）
        // カレンダーの詳細ポップオーバーで時刻を表示するために必要
        // GASがDate型や数値で返す場合もformatTimeDisplay_GASで確実にHH:MM文字列に変換する
        time        : formatTimeDisplay_GAS(r[REQ_COL.TIME - 1]) || '',
      };
    });

  // 会社カレンダー（休日・行事）を取得する。
  // Admin側は get_company_calendar を別途呼び出して renderAdminCalendar に直接渡すため、
  // ここで含めると二重表示になる。include_company_cal フラグがある場合のみ含める。
  // Kintai側（get_calendar を直接呼ぶ）は常に含める（Admin側は false を渡す）。
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
  // employee_id が指定されている場合のみ取得する（Admin全体カレンダーには出さない）。
  var deadlineEvents = [];
  if (data.employee_id) {
    var dlSheet = getOrCreateSheet(ss, SHEET.DEADLINES);
    initDeadlineSheet(dlSheet);
    getAllRows(dlSheet)
      .filter(function(r) {
        // 旧5列: B列がUUID（長さ>30）→ empId はB列
        // 新7列: empId はD列
        var bVal = String(r[1] || '');
        var empIdCol = bVal.length > 30 ? r[1] : r[DL_COL.EMPLOYEE_ID - 1];
        return empIdCol === data.employee_id;
      })
      .forEach(function(r){
        // 旧5列 or 新7列を自動判定して JSON を取得する
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
  // タイトル未指定の場合は「会社休日」をデフォルトにする
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

// ============================================================
// タスク管理
// ============================================================

var TASK_COL = { ID:1, EMPLOYEE_ID:2, NAME:3, DATA:4, UPDATED_AT:5 };
var TASK_NUM_COLS = 5;

function initTaskSheet(sheet) {
  if (sheet.getLastRow()===0) sheet.getRange(1,1,1,TASK_NUM_COLS).setValues([['ID','担当者ID','担当者名','データ(JSON)','更新日時']]);
}

function getTasks(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.TASKS);
  initTaskSheet(sheet);
  var rows = getAllRows(sheet);
  if (!data.all) rows=rows.filter(function(r){return r[TASK_COL.EMPLOYEE_ID-1]===data.employee_id;});
  var tasks = rows.map(function(r){
    var d=safeJsonParse(r[TASK_COL.DATA-1],{});
    return Object.assign({id:r[0],employee_id:r[1],name:r[2]},d);
  });
  return { tasks:tasks };
}

function upsertTask(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.TASKS);
  initTaskSheet(sheet);
  var rows  = getAllRows(sheet);
  var id    = data.task_id || generateId();
  var now   = new Date().toISOString();
  var td    = { title:data.title||'', subtitle:data.subtitle||'', overview:data.overview||'',
    current_status:data.current_status||'', notes:data.notes||'', priority:data.priority||'中',
    status:data.status||'未着手', due_date:data.due_date||'', client:data.client||'',
    todos:data.todos||[], logs:data.logs||[], plans:data.plans||[] };
  var row   = [id, data.employee_id||'', data.name||'', JSON.stringify(td), now];
  var idx   = rows.findIndex(function(r){return r[TASK_COL.ID-1]===id;});
  if (idx>=0) sheet.getRange(idx+2,1,1,TASK_NUM_COLS).setValues([row]);
  else sheet.getRange(sheet.getLastRow()+1,1,1,TASK_NUM_COLS).setValues([row]);
  SpreadsheetApp.flush();
  return { id:id, saved:true };
}

function deleteTaskGas(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.TASKS);
  var rows  = getAllRows(sheet);
  var idx   = rows.findIndex(function(r){return r[0]===data.task_id && r[1]===data.employee_id;});
  if (idx===-1) throw new Error('タスクが見つかりません: ' + data.task_id);
  sheet.deleteRow(idx+2);
  SpreadsheetApp.flush();
  return { deleted:true, id:data.task_id };
}

function adminAllTasks(ss) {
  var tSheet = getOrCreateSheet(ss, SHEET.TASKS);
  var dSheet = getOrCreateSheet(ss, SHEET.DEADLINES);
  initTaskSheet(tSheet); initDeadlineSheet(dSheet);

  var tasks = getAllRows(tSheet).map(function(r){
    var d = safeJsonParse(r[3], {});
    return Object.assign({id:r[0], employee_id:r[1], name:r[2]}, d);
  });

  // 納期シートは新7列 or 旧5列のどちらでも読める形に統一する。
  // B列が UUID長（>30文字）なら旧5列、短ければ新7列と判定する。
  var deadlines = getAllRows(dSheet).map(function(r) {
    var bVal = String(r[1] || '');
    var isOldFormat = bVal.length > 30;

    var empId, title, assigneeName, jsonData;
    if (isOldFormat) {
      empId        = r[1] || '';
      assigneeName = r[2] || '';
      jsonData     = safeJsonParse(r[3], {});
      title        = jsonData.title || '';
    } else {
      title        = r[DL_COL.TITLE       - 1] || '';
      assigneeName = r[DL_COL.NAME        - 1] || '';
      empId        = r[DL_COL.EMPLOYEE_ID - 1] || '';
      jsonData     = safeJsonParse(r[DL_COL.DATA - 1], {});
    }

    return Object.assign(
      {},
      jsonData,
      {
        id          : r[DL_COL.ID - 1] || '',
        title       : title,
        assignee    : assigneeName,
        employee_id : empId,
        name        : title, // 後方互換
      }
    );
  });

  return { tasks:tasks, deadlines:deadlines };
}

// ============================================================
// 納期管理
// ============================================================

/**
 * 納期管理シートの列番号定数（1始まり）。
 *
 * upsertDeadline が7列で書き込んでいるため、
 * DL_COL・DL_NUM_COLS・initDeadlineSheet・getDeadlines をすべて7列に統一する。
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

  // 全行を取得して担当者IDでフィルタする。
  // 旧5列シートとの互換: EMPLOYEE_ID は D列(index=3)。
  // all=true の場合は employee_id フィルタを外して全件取得する（Admin用）。
  var rows = getAllRows(sheet);
  if (!data.all) {
    rows = rows.filter(function(r) {
      return r[DL_COL.EMPLOYEE_ID - 1] === data.employee_id;
    });
  }

  var deadlines = rows.map(function(r) {
    // シートが旧5列（ID, 担当者ID, 担当者名, JSON, 更新日時）か
    // 新7列（ID, 案件名, 担当者名, 担当者ID, JSON, 作成日時, 更新日時）かを
    // ヘッダーではなく「B列が UUID かどうか」で判別する。
    // UUID は 36文字（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）のため、
    // B列が 30文字以上ならUUID（旧形式）、短ければ案件名（新形式）と判断する。
    var bVal = String(r[1] || '');
    var isOldFormat = bVal.length > 30; // UUID は36文字

    var empId, title, assigneeName, jsonData;
    if (isOldFormat) {
      // 旧5列: A=ID, B=担当者ID, C=担当者名, D=JSON, E=更新日時
      empId       = r[1] || '';
      assigneeName= r[2] || '';
      jsonData    = safeJsonParse(r[3], {});
      title       = jsonData.title || '';
    } else {
      // 新7列: A=ID, B=案件名, C=担当者名, D=担当者ID, E=JSON, F=作成日時, G=更新日時
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

  // title: Admin は 'title' で送る。Kintai も同様。
  // 旧形式で 'name' のみ送ってくる場合は 'name' をフォールバックとして使う。
  var title = data.title || '';

  // phases の show_on_calendar を正規化する。
  // フロントから true/false 以外が来ても boolean に強制変換する。
  // 旧データ（フラグなし）は「納品」を含む名前のときのみ自動で true にする。
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
      // file_paths: フェーズごとの納品データファイルパス（複数可）。
      // フォルダパスや URL を自由書式で保存する。
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
    // file_paths: 案件全体の共通ファイルパス（フェーズ横断・共有フォルダなど）
    file_paths : Array.isArray(data.file_paths) ? data.file_paths : [],
  };

  // 既存行の作成日時を保持する（更新時は created_at を上書きしない）
  var idx       = rows.findIndex(function(r) { return r[DL_COL.ID - 1] === id; });
  var createdAt = (idx >= 0) ? (rows[idx][DL_COL.CREATED_AT - 1] || now) : now;

  var row = [
    id,                         // A: 案件ID
    title,                      // B: 案件名
    data.name        || '',     // C: 担当者名（スタッフの表示名）
    data.employee_id || '',     // D: 担当者ID（UUID）
    JSON.stringify(jsonData),   // E: JSON（phases / show_on_calendar 等）
    createdAt,                  // F: 作成日時（新規のみ now）
    now,                        // G: 更新日時
  ];

  if (idx >= 0) {
    sheet.getRange(idx + 2, 1, 1, DL_NUM_COLS).setValues([row]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, DL_NUM_COLS).setValues([row]);
  }
  SpreadsheetApp.flush();

  // 継続案件の自動生成
  if (jsonData.type === '継続' && jsonData.recur_mode === 'auto') {
    scheduleRecurringDeadline(sheet, id, jsonData, data.employee_id, data.name);
  }
  return { id: id, saved: true };
}

function scheduleRecurringDeadline(sheet, sourceId, dlData, empId, name) {
  var rows = getAllRows(sheet);
  var today = new Date(); var nm = new Date(today.getFullYear(), today.getMonth()+1, 1);
  var nextYM = nm.getFullYear()+'-'+String(nm.getMonth()+1).padStart(2,'0');

  // 重複チェック: 同じ担当者・タイトル・来月分がすでに存在するか確認する。
  // DL_COL に合わせて D列(index=3) で担当者ID、E列(index=4) でJSONを参照する。
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

  // 7列構造で書き込む（旧コードの5列setValuesを修正）
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
    // target_date が Date型や数値で返ることがあるため String() で変換してからstartsWith
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
// 給与計算
// ============================================================

function payrollLoadSettings(ss) {
  var sheet=getOrCreateSheet(ss,SHEET.PAYROLL_SETTINGS);
  if (sheet.getLastRow()<2) return { settings:{ health_insurance_rate:4.99, care_insurance_rate:0.80,
    pension_rate:9.15, employment_insurance_rate:0.60, overtime_rate:25, holiday_rate:35,
    late_night_rate:50, lunch_price:150, care_insurance_enabled:false } };
  var rows=getAllRows(sheet), s={};
  rows.forEach(function(r){if(r[0]&&r[1]!=='')s[r[0]]=r[1];});
  return { settings:s };
}

function payrollSaveSettings(ss, settings) {
  if (!settings) throw new Error('settings は必須です。');
  var sheet=getOrCreateSheet(ss,SHEET.PAYROLL_SETTINGS);
  sheet.clearContents();
  sheet.getRange(1,1,1,2).setValues([['設定キー','値']]);
  var rows=Object.entries(settings).map(function(e){return [e[0],e[1]];});
  if (rows.length) sheet.getRange(2,1,rows.length,2).setValues(rows);
  SpreadsheetApp.flush();
  return { saved:true };
}

function payrollCalculate(ss, attendanceSheet, employeeSheet, yearMonth) {
  if (!yearMonth) throw new Error('year_month は必須です。');
  var cfg=payrollLoadSettings(ss).settings;
  var allStaff=getAllRows(employeeSheet).map(rowToEmployee);
  var yrmo=yearMonth.split('-').map(Number);
  var lastDay=new Date(yrmo[0],yrmo[1],0).getDate();
  var sk=convertDateForDisplay(yearMonth+'-01'), ek=convertDateForDisplay(yearMonth+'-'+String(lastDay).padStart(2,'0'));
  var attRows=getAllRows(attendanceSheet).filter(function(r){return r[ATTENDANCE_COL.DATE-1]>=sk&&r[ATTENDANCE_COL.DATE-1]<=ek;});
  var incSheet=getOrCreateSheet(ss,SHEET.INCENTIVES);
  var incRows=getAllRows(incSheet).filter(function(r){return String(r[0]||'').startsWith(yearMonth);});
  var rate=function(k){return (cfg[k]||0)/100;};

  var payroll=allStaff.map(function(s){
    var myR=attRows.filter(function(r){return r[ATTENDANCE_COL.EMPLOYEE_ID-1]===s.id;});
    var workDays=myR.filter(function(r){return r[ATTENDANCE_COL.TIME_IN-1];}).length;
    var totalMin=myR.reduce(function(sum,r){var wm=r[ATTENDANCE_COL.WORK_MINUTES-1];return sum+(typeof wm==='number'?wm:0);},0);
    var lunchCount=myR.filter(function(r){return r[ATTENDANCE_COL.LUNCH-1]==='有';}).length;
    var totalHours=Math.round(totalMin/6)/10;
    var schedHours=(s.scheduled_hours||8)*workDays;
    var otHours=Math.max(0,totalHours-schedHours);
    var basic=s.wage_type==='時給'?Math.floor((s.hourly_wage||0)*totalHours):s.wage_type==='月給'?(s.monthly_wage||0):0;
    var otPay=Math.floor((s.hourly_wage||0)*otHours*(1+(cfg.overtime_rate||25)/100));
    var myInc=incRows.filter(function(r){return r[1]===s.id;});
    var incTotal=myInc.reduce(function(sum,r){return sum+(Number(r[3])||0);},0);
    var incItems=myInc.map(function(r){return {label:r[2]||'',amount:Number(r[3])||0};});
    var gross=basic+otPay+incTotal;
    var hi=Math.floor(gross*rate('health_insurance_rate'));
    var ci=cfg.care_insurance_enabled?Math.floor(gross*rate('care_insurance_rate')):0;
    var pe=Math.floor(gross*rate('pension_rate'));
    var ei=Math.floor(gross*rate('employment_insurance_rate'));
    var siTotal=hi+ci+pe+ei;
    var tax=Math.max(0,Math.floor((gross-siTotal)*0.05));
    var lunch=(lunchCount*(cfg.lunch_price||150));
    return { employee_id:s.id, name:s.name, employment:s.employment_type||'', year_month:yearMonth,
      work_days:workDays, total_work_hours:totalHours, overtime_hours:otHours, lunch_count:lunchCount,
      basic_wage:basic, overtime_pay:otPay, transport_fee:0, incentive_total:incTotal, incentive_items:incItems,
      total_gross:gross, health_insurance:hi, care_insurance:ci, pension:pe, employment_insurance:ei,
      social_insurance_total:siTotal, income_tax:tax, lunch_deduction:lunch, net_pay:Math.max(0,gross-siTotal-tax-lunch) };
  });
  return { payroll:payroll };
}

function payrollSaveIncentive(ss, data) {
  if (!data.year_month||!data.employee_id) throw new Error('year_month と employee_id は必須です。');
  var sheet=getOrCreateSheet(ss,SHEET.INCENTIVES);
  if (sheet.getLastRow()===0) sheet.getRange(1,1,1,5).setValues([['年月','担当者ID','項目名','金額','備考']]);
  sheet.getRange(sheet.getLastRow()+1,1,1,5).setValues([[data.year_month,data.employee_id,data.label||'',Number(data.amount)||0,data.note||'']]);
  SpreadsheetApp.flush();
  return { saved:true };
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
 * 【なぜ必要か】
 *   TIME列は後から追加された列のため、既存のスプシには12列しかない。
 *   getAllRows が REQ_NUM_COLS=13 で読もうとしても、実際の列数が12なら
 *   Math.min(13,12)=12 になり TIME列（13列目）が読まれない。
 *   この関数でヘッダーに「時刻」を追加し、既存データ行は空文字で埋めることで
 *   以降 TIME列が正常に読み書きされる。
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

  // 既に13列以上あれば何もしない（二重実行防止）
  if (lastCol >= 13) {
    // ヘッダー確認
    var headerVal = sheet.getRange(1, 13).getValue();
    Logger.log('[addRequestSheetTimeColumn] 13列目のヘッダー: "%s" → スキップ', headerVal);
    return;
  }

  // 13列目のヘッダーを設定する
  sheet.getRange(1, 13).setValue('時刻');
  Logger.log('[addRequestSheetTimeColumn] ヘッダー「時刻」を追加しました。');

  // 既存データ行（2行目以降）の13列目を空文字で埋める
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

// ============================================================
// 残業指示管理
// ============================================================

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
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function initOvertimeInstructionSheet(sheet) {
  if (sheet.getLastRow() === 0) {
    // ヘッダー行を設定
    sheet.getRange(1, 1, 1, OVERTIME_NUM_COLS).setValues([[
      'ID', '申請者ID', '申請者名', '指示日時', '対象日', '見込み時間', '実績時間',
      '出勤時刻', '退勤時刻', '指示者ID', '状態', 'スタッフのコメント', '登録日時', '更新日時'
    ]]);

    // 時刻・日付列をテキスト形式に固定（自動変換防止）
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
 *
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
 *
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
    // UI表示用: 状態を日本語に変換
    status_display  : (function(status) {
      var map = { 'pending': '承認待ち', 'confirmed': '承認済み', 'rejected': '却下', 'deleted': '削除済み' };
      return map[status] || status;
    })(row[OVERTIME_COL.STATUS - 1]),
  };
}

/**
 * Admin が残業指示を直接作成する（申請スキップ）。
 *
 * 入力:
 *   employee_id (required)  - 対象スタッフのID
 *   name (required)         - スタッフ名
 *   target_date (required)  - YYYY-MM-DD
 *   estimated_time (req)    - HH:MM
 *   reason (opt)            - 理由
 *   created_by (required)   - 管理者のID
 *
 * 出力:
 *   { id: string, created: true, status: 'pending' }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function createOvertimeInstruction(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  // ── 入力検証 ──
  if (!data.employee_id) throw new Error('employee_id は必須です。');
  if (!data.name) throw new Error('name は必須です。');
  if (!data.target_date) throw new Error('target_date は必須です。');
  if (!data.estimated_time) throw new Error('estimated_time（見込み時間）は必須です。');
  if (!data.created_by) throw new Error('created_by は必須です。');

  // 日付を正規化（YYYY-MM-DD → YYYY/MM/DD）
  var targetDate = convertDateForDisplay(String(data.target_date).replace(/\//g, '-'));

  var id = generateId();
  var now = new Date().toISOString();
  var newRowNum = sheet.getLastRow() + 1;

  // 日付・時刻列をテキスト形式に固定してから書き込む
  sheet.getRange(newRowNum, OVERTIME_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.ESTIMATED_TIME).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.ACTUAL_TIME).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.TIME_IN).setNumberFormat('@');
  sheet.getRange(newRowNum, OVERTIME_COL.TIME_OUT).setNumberFormat('@');

  sheet.getRange(newRowNum, 1, 1, OVERTIME_NUM_COLS).setValues([[
    id,                           // A: ID
    data.employee_id,             // B: 申請者ID
    data.name,                    // C: 申請者名
    now,                          // D: 指示日時
    targetDate,                   // E: 対象日（YYYY/MM/DD）
    data.estimated_time,          // F: 見込み時間（HH:MM）
    '',                           // G: 実績時間（後で自動計算）
    '',                           // H: 出勤時刻（後で参照）
    '',                           // I: 退勤時刻（後で参照）
    data.created_by,              // J: 指示者ID
    'pending',                    // K: 状態（最初は承認待ち）
    '',                           // L: スタッフのコメント
    now,                          // M: 登録日時
    now,                          // N: 更新日時
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
 *
 * フィルタ:
 *   status: 'pending'|'confirmed'|'rejected'|'all'
 *   employee_id: 特定スタッフのみ（省略可）
 *   start_date, end_date: 対象日範囲（省略可）
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function adminOvertimeInstructions(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  var rows = getAllOvertimeRows(sheet);

  // 削除済みを除外
  rows = rows.filter(function(r) {
    return r[OVERTIME_COL.STATUS - 1] !== 'deleted';
  });

  // ステータスフィルタ
  if (data.status && data.status !== 'all') {
    rows = rows.filter(function(r) {
      return r[OVERTIME_COL.STATUS - 1] === data.status;
    });
  }

  // スタッフフィルタ
  if (data.employee_id) {
    rows = rows.filter(function(r) {
      return r[OVERTIME_COL.EMPLOYEE_ID - 1] === data.employee_id;
    });
  }

  // 日付範囲フィルタ
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
 *
 * 入力:
 *   instruction_id (required)  - 残業指示ID
 *   status (required)          - 'confirmed'|'rejected'
 *   comment (opt)              - コメント（却下時に理由を記入）
 *   employee_id (required)     - 権限チェック用（本人のみ実行可）
 *
 * 出力:
 *   { updated: true, id: string, status: string（日本語） }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function updateOvertimeInstructionStatus(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.OVERTIME_INST);
  initOvertimeInstructionSheet(sheet);

  // ── 入力検証 ──
  if (!data.instruction_id) throw new Error('instruction_id は必須です。');
  if (!data.status) throw new Error('status は必須です。');
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  // status は 'confirmed' または 'rejected' のみ許可
  if (data.status !== 'confirmed' && data.status !== 'rejected') {
    throw new Error('status は「confirmed」または「rejected」のみ指定可能です。');
  }

  // 対象行を探す
  var rows = getAllOvertimeRows(sheet);
  var idx = rows.findIndex(function(r) {
    return r[OVERTIME_COL.ID - 1] === data.instruction_id;
  });
  if (idx === -1) throw new Error('指示が見つかりません: ' + data.instruction_id);

  var rowNum = idx + 2; // ヘッダー行(1) + 0始まりインデックス補正(1)
  var targetRow = rows[idx];

  // 権限チェック: 申請者本人のみ更新可
  var ownerEmpId = String(targetRow[OVERTIME_COL.EMPLOYEE_ID - 1] || '');
  if (ownerEmpId !== String(data.employee_id)) {
    throw new Error('他人の残業指示は更新できません。');
  }

  // ステータスチェック: 'pending' のみ更新可
  var currentStatus = String(targetRow[OVERTIME_COL.STATUS - 1] || '');
  if (currentStatus !== 'pending') {
    throw new Error('承認待ち状態の指示のみ更新できます。（現在: ' + currentStatus + '）');
  }

  // ステータスを更新
  sheet.getRange(rowNum, OVERTIME_COL.STATUS).setValue(data.status);
  sheet.getRange(rowNum, OVERTIME_COL.COMMENT).setValue(data.comment || '');
  sheet.getRange(rowNum, OVERTIME_COL.UPDATED_AT).setValue(new Date().toISOString());

  SpreadsheetApp.flush();

  var statusDisplay = data.status === 'confirmed' ? '承認済み' : '却下';
  writeAuditLog(ss, {
    action: 'update_overtime_instruction_status',
    admin_id: data.employee_id, // スタッフが実行するため employee_id を記録
    target_id: data.instruction_id,
    reason: '残業指示を「' + statusDisplay + '」に変更',
  });

  Logger.log('[updateOvertimeInstructionStatus] 更新: id=%s, empId=%s, status=%s',
    data.instruction_id, data.employee_id, data.status);

  return { updated: true, id: data.instruction_id, status: statusDisplay };
}

/**
 * Admin が残業指示を削除する（論理削除）。
 *
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

  // 論理削除: ステータスを 'deleted' に変更
  sheet.getRange(rowNum, OVERTIME_COL.STATUS).setValue('deleted');
  sheet.getRange(rowNum, OVERTIME_COL.UPDATED_AT).setValue(new Date().toISOString());

  SpreadsheetApp.flush();

  // ── 対応する残業申請を 'pending'（承認待ち）に戻す ──
  // 残業指示は「申請 → 承認」経由でも「Admin直接」でも作成されるが、
  // 削除された場合は承認した申請管理レコードも差し戻す必要がある。
  // 対象: 同じ employee_id かつ同じ target_date の種別='残業' で status='approved' の申請
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

      // 同スタッフ・同日・残業・承認済み の申請を pending に戻す
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
    // 申請の差し戻しが失敗しても指示削除自体は完了扱いにする（ログのみ記録）
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
 *
 * 入力:
 *   employee_id (required)  - スタッフのID
 *   status (opt)            - フィルタ（'pending'|'confirmed'|'rejected'|'all'）
 *
 * 出力:
 *   { instructions: [ ... ] }
 *
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
      // 自分の指示のみ、かつ削除済みを除外
      return r[OVERTIME_COL.EMPLOYEE_ID - 1] === data.employee_id &&
             r[OVERTIME_COL.STATUS - 1] !== 'deleted';
    });

  // ステータスフィルタ
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
// 打刻漏れ警告
// ============================================================

/**
 * 指定日付の打刻漏れを検出する。
 *
 * 検出対象:
 *   1. 勤務曜日に該当する
 *   2. 会社休日ではない
 *   3. 欠勤/有給申請がない
 *   4. 以下のいずれか:
 *      A. 出勤打刻あり & 退勤打刻なし
 *      B. 出勤打刻なし & 退勤打刻なし
 *
 * 戻り値:
 *   {
 *     missing: [
 *       {
 *         employee_id: string,
 *         name: string,
 *         date: string (YYYY-MM-DD),
 *         pattern: 'missing_time_out'|'missing_both',
 *         clocked_in_at: string (HH:MM) or null,
 *         message: string
 *       },
 *       ...
 *     ]
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function checkMissingClocks(ss, attendanceSheet, employeeSheet, data) {
  if (!data.date) throw new Error('date は必須です。');

  // 日付を正規化（YYYY-MM-DD → YYYY/MM/DD）
  var targetDate = convertDateForDisplay(String(data.date).replace(/\//g, '-'));
  var targetDateDash = String(data.date).replace(/\//g, '-').slice(0, 10); // YYYY-MM-DD

  Logger.log('[checkMissingClocks] 開始: date=%s', targetDate);

  // ── Step 1: 会社カレンダーシートから会社休日を取得 ──
  var companyCalSheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var companyHolidays = getAllRows(companyCalSheet)
    .map(function(r) { return String(r[0] || '').replace(/-/g, '/'); }) // 1列目を取得
    .filter(function(d) { return d === targetDate; });
  var isCompanyHoliday = companyHolidays.length > 0;

  // ── Step 2: 申請管理シートから欠勤/有給申請を取得 ──
  var requestSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  var requestRows = getAllRequestRows(requestSheet);
  var absenceApprovals = requestRows.filter(function(r) {
    var type = String(r[REQ_COL.TYPE - 1] || '');
    var status = String(r[REQ_COL.STATUS - 1] || '');
    var reqDate = String(r[REQ_COL.TARGET_DATE - 1] || '').replace(/-/g, '/');
    var isAbsence = type === '欠席' || type === '有給' || type === '会社休日';
    var isApproved = status === 'approved' || status === 'pending';
    return isAbsence && isApproved && reqDate === targetDate;
  });

  // ── Step 3: 全スタッフをループして打刻漏れを検出 ──
  var employeeRows = getAllRows(employeeSheet);
  var warnings = [];

  employeeRows.forEach(function(empRow) {
    // 雇用形態によるフィルターなし（職員・利用者ともに対象）

    var empId = empRow[EMPLOYEE_COL.ID - 1];
    var empName = (empRow[EMPLOYEE_COL.LAST_NAME - 1] || '') +
                  ' ' +
                  (empRow[EMPLOYEE_COL.FIRST_NAME - 1] || '');

    // ── Step 3-1: 勤務曜日に該当するか確認 ──
    var workDaysStr = String(empRow[EMPLOYEE_COL.WORK_DAYS - 1] || '');
    var dow = getJapaneseDayOfWeek(targetDateDash);
    var dayNames = workDaysStr.split(',').map(function(d) { return d.trim(); });
    if (dayNames.indexOf(dow) === -1) {
      // 勤務曜日に該当しない
      return;
    }

    // ── Step 3-2: 会社休日・欠勤/有給申請がないか確認 ──
    if (isCompanyHoliday) return; // 会社休日 → スキップ
    var hasAbsenceApproval = absenceApprovals.some(function(r) {
      return r[REQ_COL.EMPLOYEE_ID - 1] === empId;
    });
    if (hasAbsenceApproval) return; // 欠勤/有給申請済み → スキップ

    // ── Step 3-3: 出退勤記録を取得 ──
    var attendanceRows = getAllRows(attendanceSheet);
    var todayAttendance = attendanceRows.find(function(r) {
      var aDate = String(r[ATTENDANCE_COL.DATE - 1] || '').replace(/-/g, '/');
      var aEmpId = r[ATTENDANCE_COL.EMPLOYEE_ID - 1];
      return aDate === targetDate && aEmpId === empId;
    });

    // ── Step 3-4: 打刻漏れパターンを判定 ──
    if (!todayAttendance) {
      // 出退勤記録がない = パターンB（両方なし）
      warnings.push({
        employee_id: empId,
        name: empName,
        date: targetDateDash,
        pattern: 'missing_both',
        clocked_in_at: null,
        message: '⚠️ ' + targetDateDash + ' の出勤打刻がありません（勤務曜日）',
      });
    } else {
      var timeIn = String(todayAttendance[ATTENDANCE_COL.TIME_IN - 1] || '').trim();
      var timeOut = String(todayAttendance[ATTENDANCE_COL.TIME_OUT - 1] || '').trim();

      if (timeIn && !timeOut) {
        // パターンA（出勤あり & 退勤なし）
        warnings.push({
          employee_id: empId,
          name: empName,
          date: targetDateDash,
          pattern: 'missing_time_out',
          clocked_in_at: timeIn,
          message: '⚠️ ' + targetDateDash + ' は出勤済みですが退勤打刻がありません',
        });
      } else if (!timeIn && !timeOut) {
        // パターンB（両方なし）
        warnings.push({
          employee_id: empId,
          name: empName,
          date: targetDateDash,
          pattern: 'missing_both',
          clocked_in_at: null,
          message: '⚠️ ' + targetDateDash + ' の出勤打刻がありません（勤務曜日）',
        });
      }
    }
  });

  Logger.log('[checkMissingClocks] 完了: 警告数=%d', warnings.length);

  return { missing: warnings };
}

/**
 * スタッフが自分の打刻漏れを取得する。
 *
 * 本日 + 過去1ヶ月分を対象に検出。
 *
 * 入力:
 *   employee_id (required) - スタッフのID
 *
 * 出力:
 *   { warnings: [ { date, pattern, message } ] }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
/**
 * 特定スタッフの打刻漏れを指定月範囲で検出する（Kintai個人確認用・高速版）。
 *
 * 旧 getMyMissingClocks は checkMissingClocks を30日分ループし、
 * 毎回 getAllRows(attendanceSheet) を呼ぶため GAS タイムアウトが発生していた。
 * この関数は checkMissingClocksMonthly と同じ一括読み込み方式で
 * 1人分・当月+前月 を高速に処理する。
 *
 * 入力:
 *   employee_id (required) - スタッフのID
 *   year_month  (required) - YYYY-MM（当月。前月は自動計算）
 *
 * 出力:
 *   { warnings: [ { date, day_of_week, pattern, clocked_in_at, message } ] }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getMyMissingClocks(ss, data) {
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  var empId = String(data.employee_id);

  // year_month が渡された場合はそれを当月とし、前月も対象にする。
  // 渡されない場合は今月・先月を対象にする（後方互換）。
  var today = new Date();
  var currentYM, prevYM;
  if (data.year_month && /^\d{4}-\d{2}$/.test(data.year_month)) {
    var parts = data.year_month.split('-');
    var y = parseInt(parts[0]), m = parseInt(parts[1]);
    currentYM = data.year_month;
    var prevDate = new Date(y, m - 2, 1);
    prevYM = prevDate.getFullYear() + '-' + String(prevDate.getMonth() + 1).padStart(2, '0');
  } else {
    currentYM = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
    var pd = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    prevYM = pd.getFullYear() + '-' + String(pd.getMonth() + 1).padStart(2, '0');
  }

  var targetMonths = [prevYM, currentYM];
  var todayStr = formatDateString(today);

  // ── 各シートを1回だけ読み込む ──
  var attendanceSheet  = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  var employeeSheet    = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var companyCalSheet  = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var requestSheet     = getOrCreateSheet(ss, SHEET.REQUESTS);

  // 対象スタッフの情報を取得する
  var empRow = getAllRows(employeeSheet).find(function(r) {
    return String(r[EMPLOYEE_COL.ID - 1] || '') === empId;
  });
  if (!empRow) {
    Logger.log('[getMyMissingClocks] スタッフが見つかりません: %s', empId);
    return { warnings: [] };
  }

  var workDaysStr = String(empRow[EMPLOYEE_COL.WORK_DAYS - 1] || '');
  var workDays    = workDaysStr.split(',').map(function(d) { return d.trim(); }).filter(Boolean);

  // 会社休日を Set に格納する
  var holidaySet = new Set();
  if (companyCalSheet.getLastRow() > 1) {
    getAllRows(companyCalSheet).forEach(function(r) {
      var raw = String(r[0] || '').replace(/\//g, '-').slice(0, 10);
      if (raw) holidaySet.add(raw);
    });
  }

  // 欠勤・有給申請を Set に格納する（key: YYYY-MM-DD）
  var absenceSet = new Set();
  if (requestSheet.getLastRow() > 1) {
    getAllRequestRows(requestSheet).forEach(function(r) {
      var type   = String(r[REQ_COL.TYPE        - 1] || '');
      var status = String(r[REQ_COL.STATUS      - 1] || '');
      var rEmpId = String(r[REQ_COL.EMPLOYEE_ID - 1] || '');
      if (rEmpId !== empId) return;
      var raw = r[REQ_COL.TARGET_DATE - 1];
      var reqDate = raw instanceof Date
        ? raw.getFullYear() + '-' + String(raw.getMonth() + 1).padStart(2, '0') + '-' + String(raw.getDate()).padStart(2, '0')
        : String(raw || '').replace(/\//g, '-').slice(0, 10);
      var isAbsence = ['欠席', '有給', '会社休日', '補填休'].indexOf(type) !== -1;
      var isActive  = status !== 'rejected' && status !== 'cancelled';
      if (isAbsence && isActive) absenceSet.add(reqDate);
    });
  }

  // 出退勤記録を Map に格納する（key: YYYY-MM-DD）
  var attMap = {};
  getAllRows(attendanceSheet).forEach(function(r) {
    var rEmpId = String(r[ATTENDANCE_COL.EMPLOYEE_ID - 1] || '');
    if (rEmpId !== empId) return;
    var rawDate = r[ATTENDANCE_COL.DATE - 1];
    var dateKey;
    if (rawDate instanceof Date) {
      dateKey = rawDate.getFullYear() + '-'
        + String(rawDate.getMonth() + 1).padStart(2, '0') + '-'
        + String(rawDate.getDate()).padStart(2, '0');
    } else {
      dateKey = String(rawDate || '').replace(/\//g, '-').slice(0, 10);
    }
    if (!dateKey || dateKey.length !== 10) return;
    attMap[dateKey] = {
      time_in  : formatTimeDisplay_GAS(r[ATTENDANCE_COL.TIME_IN  - 1]),
      time_out : formatTimeDisplay_GAS(r[ATTENDANCE_COL.TIME_OUT - 1]),
    };
  });

  // 2ヶ月分の全日付を生成してチェックする
  var warnings = [];

  targetMonths.forEach(function(ym) {
    var ymParts    = ym.split('-');
    var y = parseInt(ymParts[0]), m = parseInt(ymParts[1]);
    var daysInMonth = new Date(y, m, 0).getDate();

    for (var day = 1; day <= daysInMonth; day++) {
      var dateStr = y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');

      // 未来の日付はスキップ
      if (dateStr > todayStr) break;

      // ① 勤務曜日チェック
      var dow = getJapaneseDayOfWeek(dateStr);
      if (workDays.length > 0 && workDays.indexOf(dow) === -1) continue;

      // ② 会社休日チェック
      if (holidaySet.has(dateStr)) continue;

      // ③ 欠勤申請チェック
      if (absenceSet.has(dateStr)) continue;

      // ④ 打刻漏れチェック
      var att     = attMap[dateStr];
      var pattern, clockedIn;

      if (!att) {
        pattern   = 'missing_both';
        clockedIn = null;
      } else {
        var tIn  = att.time_in  || '';
        var tOut = att.time_out || '';
        if (tIn && !tOut) {
          pattern   = 'missing_time_out';
          clockedIn = tIn;
        } else if (!tIn && !tOut) {
          pattern   = 'missing_both';
          clockedIn = null;
        } else {
          continue; // 正常
        }
      }

      warnings.push({
        employee_id  : empId,
        date         : dateStr,
        day_of_week  : dow,
        pattern      : pattern,
        clocked_in_at: clockedIn,
        message      : pattern === 'missing_time_out'
          ? '出勤済みだが退勤打刻がありません'
          : '出退勤の打刻がありません',
      });
    }
  });

  // 日付昇順（古い順）
  warnings.sort(function(a, b) { return a.date.localeCompare(b.date); });

  Logger.log('[getMyMissingClocks] empId=%s, 警告数=%d', empId, warnings.length);

  return { warnings: warnings };
}

/**
 * 日付文字列（YYYY-MM-DD）から日本語の曜日を取得する。
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} '月'|'火'|'水'|'木'|'金'|'土'|'日'
 */
function getJapaneseDayOfWeek(dateStr) {
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  var dayIndex = d.getDay(); // 0=日, 1=月, ..., 6=土
  var dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  return dayNames[dayIndex];
}

/**
 * 指定月全体の打刻漏れを検出する（Admin 月次確認用）。
 *
 * 1日ずつ checkMissingClocks を呼ぶと GAS の実行時間制限に引っかかるため、
 * この関数では月全体を1回のシート読み込みで一括処理する。
 *
 * 検出条件（4つすべてを満たす日付×スタッフ の組み合わせ）:
 *   ① 人員マスタの勤務曜日に該当する
 *   ② 会社カレンダーに会社休日として登録されていない
 *   ③ 欠勤・有給の申請が承認/申請中になっていない
 *   ④ 出退勤記録に何らかの打刻漏れがある
 *      - パターンA: 出勤あり & 退勤なし
 *      - パターンB: 出勤なし & 退勤なし（出退勤記録が存在しないケース含む）
 *
 * 入力:
 *   year_month (required) - YYYY-MM 形式
 *
 * 出力:
 *   {
 *     year_month: string,
 *     total_missing: number,
 *     missing: [
 *       {
 *         employee_id: string,
 *         name: string,
 *         date: string (YYYY-MM-DD),
 *         day_of_week: string ('月'...'日'),
 *         pattern: 'missing_time_out' | 'missing_both',
 *         clocked_in_at: string | null,
 *         message: string
 *       },
 *       ...
 *     ]
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function checkMissingClocksMonthly(ss, attendanceSheet, employeeSheet, data) {
  if (!data.year_month) throw new Error('year_month は必須です（例: 2026-05）。');
  if (!/^\d{4}-\d{2}$/.test(data.year_month)) {
    throw new Error('year_month の形式が正しくありません: ' + data.year_month);
  }

  var yearMonth = data.year_month; // YYYY-MM
  var year  = parseInt(yearMonth.split('-')[0]);
  var month = parseInt(yearMonth.split('-')[1]);

  Logger.log('[checkMissingClocksMonthly] 開始: year_month=%s', yearMonth);

  // ── Step 1: 対象月の全日付を生成（YYYY-MM-DD 配列）──
  var daysInMonth = new Date(year, month, 0).getDate(); // monthは1始まりなので+1しない
  var allDates = [];
  for (var day = 1; day <= daysInMonth; day++) {
    allDates.push(
      year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    );
  }

  // 本日より後の日付は除外する（未来は検出対象外）
  var todayStr = formatDateString(new Date());
  allDates = allDates.filter(function(d) { return d <= todayStr; });

  // ── Step 2: 会社休日を一括取得 ──
  var companyCalSheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var holidayDates = new Set(); // YYYY-MM-DD の Set
  if (companyCalSheet.getLastRow() > 1) {
    getAllRows(companyCalSheet).forEach(function(r) {
      var raw = String(r[0] || '');
      if (!raw) return;
      var normalized = raw.replace(/\//g, '-').slice(0, 10);
      if (normalized.startsWith(yearMonth)) holidayDates.add(normalized);
    });
  }

  // ── Step 3: 欠勤・有給申請を一括取得 ──
  // key: 'employee_id::YYYY-MM-DD'  value: true
  var absenceApprovedSet = new Set();
  var requestSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  if (requestSheet.getLastRow() > 1) {
    getAllRequestRows(requestSheet).forEach(function(r) {
      var type   = String(r[REQ_COL.TYPE      - 1] || '');
      var status = String(r[REQ_COL.STATUS    - 1] || '');
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

      // 欠勤・有給に該当し、対象月の日付で、却下・取り下げでないもの
      var isAbsence = ['欠席', '有給', '会社休日', '補填休'].indexOf(type) !== -1;
      var isActive  = status !== 'rejected' && status !== 'cancelled';
      if (isAbsence && isActive && reqDate.startsWith(yearMonth)) {
        absenceApprovedSet.add(empId + '::' + reqDate);
      }
    });
  }

  // ── Step 4: 出退勤記録を対象月分だけ一括取得 ──
  // key: 'employee_id::YYYY-MM-DD'  value: { time_in, time_out }
  var attendanceMap = {};
  getAllRows(attendanceSheet).forEach(function(r) {
    var rawDate = r[ATTENDANCE_COL.DATE - 1];
    var dateStr;
    if (rawDate instanceof Date) {
      dateStr = rawDate.getFullYear() + '-'
        + String(rawDate.getMonth() + 1).padStart(2, '0') + '-'
        + String(rawDate.getDate()).padStart(2, '0');
    } else {
      dateStr = String(rawDate || '').replace(/\//g, '-').slice(0, 10);
    }
    if (!dateStr.startsWith(yearMonth)) return;
    var empId = String(r[ATTENDANCE_COL.EMPLOYEE_ID - 1] || '');
    var key   = empId + '::' + dateStr;
    attendanceMap[key] = {
      time_in  : formatTimeDisplay_GAS(r[ATTENDANCE_COL.TIME_IN  - 1]),
      time_out : formatTimeDisplay_GAS(r[ATTENDANCE_COL.TIME_OUT - 1]),
    };
  });

  // ── Step 5: 全スタッフ × 全日付 でチェック ──
  // employee_id が指定された場合は対象スタッフのみチェックする（Kintai個人確認用）
  var filterEmpId = data.employee_id ? String(data.employee_id) : '';

  var warnings = [];
  var employeeRows = getAllRows(employeeSheet);

  employeeRows.forEach(function(empRow) {
    // 雇用形態によるフィルターなし（職員・利用者ともに対象）
    // 論理削除のみ除外する
    if (empRow[EMPLOYEE_COL.DELETED - 1] === 'true' || empRow[EMPLOYEE_COL.DELETED - 1] === true) return;

    var empId = String(empRow[EMPLOYEE_COL.ID - 1] || '');

    // employee_id が指定されている場合は対象スタッフのみ処理する
    if (filterEmpId && empId !== filterEmpId) return;
    var empName = (empRow[EMPLOYEE_COL.LAST_NAME  - 1] || '') + ' '
                + (empRow[EMPLOYEE_COL.FIRST_NAME - 1] || '');
    var workDaysStr = String(empRow[EMPLOYEE_COL.WORK_DAYS - 1] || '');
    var workDays    = workDaysStr.split(',').map(function(d) { return d.trim(); }).filter(Boolean);

    allDates.forEach(function(dateStr) {
      // ① 勤務曜日チェック
      var dow = getJapaneseDayOfWeek(dateStr);
      if (workDays.length > 0 && workDays.indexOf(dow) === -1) return;

      // ② 会社休日チェック
      if (holidayDates.has(dateStr)) return;

      // ③ 欠勤申請チェック
      if (absenceApprovedSet.has(empId + '::' + dateStr)) return;

      // ④ 打刻漏れチェック
      var key = empId + '::' + dateStr;
      var att = attendanceMap[key];

      var pattern, clockedIn;
      if (!att) {
        // 出退勤記録そのものがない → パターンB
        pattern  = 'missing_both';
        clockedIn = null;
      } else {
        var timeIn  = att.time_in  || '';
        var timeOut = att.time_out || '';
        if (timeIn && !timeOut) {
          pattern   = 'missing_time_out';
          clockedIn = timeIn;
        } else if (!timeIn && !timeOut) {
          pattern   = 'missing_both';
          clockedIn = null;
        } else {
          return; // 出退勤ともに揃っている → 正常
        }
      }

      var msg = pattern === 'missing_time_out'
        ? '出勤済みだが退勤打刻がありません'
        : '出退勤の打刻がありません';

      warnings.push({
        employee_id  : empId,
        name         : empName.trim(),
        date         : dateStr,
        day_of_week  : dow,
        pattern      : pattern,
        clocked_in_at: clockedIn,
        message      : msg,
      });
    });
  });

  // 日付昇順 → 同日内はスタッフ名順でソート
  warnings.sort(function(a, b) {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.name.localeCompare(b.name);
  });

  Logger.log('[checkMissingClocksMonthly] 完了: %d件', warnings.length);

  return { year_month: yearMonth, total_missing: warnings.length, missing: warnings };
}

// ============================================================
// 残業申請（Kintai → 申請管理シートへ登録）
// ============================================================

/**
 * スタッフが Kintai から残業申請を送信する。
 *
 * 既存の申請管理シート（REQUESTS）に種別='残業'で登録する。
 * status は常に 'pending'（Admin の承認が必要）。
 * 承認後に adminApproveOvertimeRequest が残業指示シートへ転記する。
 *
 * 入力:
 *   employee_id    (required) - 申請者ID
 *   name           (required) - 申請者名
 *   target_date    (required) - YYYY-MM-DD
 *   estimated_time (required) - HH:MM（見込み残業時間）
 *   reason         (opt)      - 理由
 *
 * 出力:
 *   { id: string, submitted: true }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function submitOvertimeRequest(ss, data) {
  var sheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(sheet);

  // ── 入力検証 ──
  if (!data.employee_id) throw new Error('employee_id は必須です。');
  if (!data.name) throw new Error('name は必須です。');
  if (!data.target_date) throw new Error('target_date は必須です。');
  if (!data.estimated_time) throw new Error('estimated_time（見込み時間）は必須です。');

  // 対象日を正規化（YYYY-MM-DD 形式に統一）
  var rawDate = String(data.target_date).replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw new Error('target_date の形式が正しくありません: ' + rawDate);
  }

  var id  = generateId();
  var now = new Date().toISOString();
  var newRowNum = sheet.getLastRow() + 1;

  // 日付列をテキスト形式に固定（ISO変換防止）
  sheet.getRange(newRowNum, REQ_COL.TARGET_DATE).setNumberFormat('@');
  sheet.getRange(newRowNum, REQ_COL.TIME).setNumberFormat('@');

  // 申請管理シートに登録する。
  // 見込み時間は TIME 列（M列）に格納し、Admin が参照できるようにする。
  // 残業は必ず承認フローが必要なので status='pending'・承認フロー='承認が必要' で固定。
  sheet.getRange(newRowNum, 1, 1, REQ_NUM_COLS).setValues([[
    id,
    data.employee_id,
    data.name,
    'pending',           // D: ステータス（Admin承認待ち）
    '残業',              // E: 種別
    rawDate,             // F: 対象日
    data.reason || '',   // G: 理由
    '承認が必要',        // H: 承認フロー
    '',                  // I: 承認者ID（承認後に記入）
    '',                  // J: 承認日時（承認後に記入）
    '',                  // K: 却下理由
    now,                 // L: 申請日時
    data.estimated_time, // M: 見込み時間（HH:MM）を TIME 列に格納
    '',                  // N: 遅刻時間（旧フィールド）
    '',                  // O: 早退時間（旧フィールド）
    '',                  // P: 申請種別区分
  ]]);

  SpreadsheetApp.flush();
  Logger.log('[submitOvertimeRequest] 登録: id=%s, empId=%s, date=%s, time=%s',
    id, data.employee_id, rawDate, data.estimated_time);

  return { id: id, submitted: true };
}

/**
 * Admin が残業申請を承認する。
 *
 * 処理の流れ:
 *   1. 申請管理シートのステータスを 'approved' に更新する
 *   2. 残業指示シートに新しいレコードを作成する（status='pending'）
 *      → これによりスタッフ側の「残業指示」一覧に表示される
 *
 * 入力:
 *   request_id  (required) - 承認する申請のID
 *   admin_id    (required) - 承認した管理者のID
 *
 * 出力:
 *   { approved: true, request_id: string, instruction_id: string }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function adminApproveOvertimeRequest(ss, data) {
  if (!data.request_id) throw new Error('request_id は必須です。');
  if (!data.admin_id)   throw new Error('admin_id は必須です。');

  var reqSheet  = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(reqSheet);

  // 申請行を ID で検索する
  var rows = getAllRequestRows(reqSheet);
  var idx  = rows.findIndex(function(r) {
    return r[REQ_COL.ID - 1] === data.request_id;
  });
  if (idx === -1) throw new Error('申請が見つかりません: ' + data.request_id);

  var reqRow = rows[idx];
  var rowNum = idx + 2;

  // 種別チェック: 残業申請のみ処理する
  var reqType = String(reqRow[REQ_COL.TYPE - 1] || '');
  if (reqType !== '残業') {
    throw new Error('この申請は残業申請ではありません（種別: ' + reqType + '）。通常の承認フローを使用してください。');
  }

  // すでに承認済み・却下済みでないか確認する
  var currentStatus = String(reqRow[REQ_COL.STATUS - 1] || '');
  if (currentStatus !== 'pending') {
    throw new Error('承認待ち状態の申請のみ承認できます（現在: ' + currentStatus + '）。');
  }

  var now = new Date().toISOString();

  // ── Step 1: 申請管理シートを 'approved' に更新 ──
  reqSheet.getRange(rowNum, REQ_COL.STATUS).setValue('approved');
  reqSheet.getRange(rowNum, REQ_COL.APPROVED_BY).setValue(data.admin_id);
  reqSheet.getRange(rowNum, REQ_COL.APPROVED_AT).setValue(now);

  // ── Step 2: 残業指示シートに転記する ──
  // 見込み時間は申請行の TIME 列（M列）から取得する
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

  // ── Step 2b: 残業指示シートに 'confirmed'（承認済み）で登録する ──
  // Kintai からの申請を Admin が承認した場合、スタッフが申請した時点で
  // 本人は残業に同意しているため、指示の状態は最初から 'confirmed' とする。
  // （Admin直接指示 = 'pending'スタート と区別する）
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
    now,                   // D: 指示日時
    normDate,              // E: 対象日
    estimatedTime,         // F: 見込み時間
    '',                    // G: 実績時間（退勤後に自動計算）
    '',                    // H: 出勤時刻
    '',                    // I: 退勤時刻
    data.admin_id,         // J: 指示者ID
    'confirmed',           // K: 状態 ← スタッフが申請済みのため最初から承認済み
    '申請承認により自動登録', // L: コメント（経緯を残す）
    now,                   // M: 登録日時
    now,                   // N: 更新日時
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
 *
 * 申請管理シートのステータスを 'rejected' に更新し、却下理由を記録する。
 * 残業指示シートには何も作成しない。
 *
 * 入力:
 *   request_id    (required) - 却下する申請のID
 *   admin_id      (required) - 却下した管理者のID
 *   reject_reason (opt)      - 却下理由
 *
 * 出力:
 *   { rejected: true, request_id: string }
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function adminRejectOvertimeRequest(ss, data) {
  if (!data.request_id) throw new Error('request_id は必須です。');
  if (!data.admin_id)   throw new Error('admin_id は必須です。');

  var reqSheet = getOrCreateSheet(ss, SHEET.REQUESTS);
  initRequestSheet(reqSheet);

  // 申請行を ID で検索する
  var rows = getAllRequestRows(reqSheet);
  var idx  = rows.findIndex(function(r) {
    return r[REQ_COL.ID - 1] === data.request_id;
  });
  if (idx === -1) throw new Error('申請が見つかりません: ' + data.request_id);

  var reqRow = rows[idx];
  var rowNum = idx + 2;

  // 種別チェック
  var reqType = String(reqRow[REQ_COL.TYPE - 1] || '');
  if (reqType !== '残業') {
    throw new Error('この申請は残業申請ではありません（種別: ' + reqType + '）。');
  }

  var currentStatus = String(reqRow[REQ_COL.STATUS - 1] || '');
  if (currentStatus !== 'pending') {
    throw new Error('承認待ち状態の申請のみ却下できます（現在: ' + currentStatus + '）。');
  }

  // ステータスを rejected に更新する
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
