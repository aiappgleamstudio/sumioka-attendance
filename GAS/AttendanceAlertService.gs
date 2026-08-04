/**
 * AttendanceAlertService.gs - 打刻漏れ警告
 *
 * 役割:
 *   勤務曜日・会社休日・欠勤/有給申請を考慮した打刻漏れ（出勤あり退勤なし／
 *   出退勤とも記録なし）の検出を、指定日・指定月・個人単位で実装する。
 *
 * 設計方針:
 *   - AdminOpsService.gs の handleAdminAction() から委譲される
 *   - RequestService.gs の REQ_COL / getAllRequestRows に依存する
 *   - 月次・個人向けは1回のシート読み込みで一括処理し、GASの実行時間制限を回避する
 *
 * 【2026-07-30 分割】旧 Adminservice.gs（2934行）から打刻漏れ警告一式を分離。
 *
 * @version 1.0.0
 */

'use strict';

/**
 * 指定日付の打刻漏れを検出する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data
 * @returns {Object}
 */
function checkMissingClocks(ss, attendanceSheet, employeeSheet, data) {
  if (!data.date) throw new Error('date は必須です。');

  var targetDate = convertDateForDisplay(String(data.date).replace(/\//g, '-'));
  var targetDateDash = String(data.date).replace(/\//g, '-').slice(0, 10); // YYYY-MM-DD

  Logger.log('[checkMissingClocks] 開始: date=%s', targetDate);

  var companyCalSheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var companyHolidays = getAllRows(companyCalSheet)
    .map(function(r) { return String(r[0] || '').replace(/-/g, '/'); })
    .filter(function(d) { return d === targetDate; });
  var isCompanyHoliday = companyHolidays.length > 0;

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

  var employeeRows = getAllRows(employeeSheet);
  var warnings = [];

  employeeRows.forEach(function(empRow) {
    var empId = empRow[EMPLOYEE_COL.ID - 1];
    var empName = (empRow[EMPLOYEE_COL.LAST_NAME - 1] || '') +
                  ' ' +
                  (empRow[EMPLOYEE_COL.FIRST_NAME - 1] || '');

    var workDaysStr = String(empRow[EMPLOYEE_COL.WORK_DAYS - 1] || '');
    var dow = getJapaneseDayOfWeek(targetDateDash);
    var dayNames = workDaysStr.split(',').map(function(d) { return d.trim(); });
    if (dayNames.indexOf(dow) === -1) {
      return;
    }

    if (isCompanyHoliday) return;
    var hasAbsenceApproval = absenceApprovals.some(function(r) {
      return r[REQ_COL.EMPLOYEE_ID - 1] === empId;
    });
    if (hasAbsenceApproval) return;

    var attendanceRows = getAllRows(attendanceSheet);
    var todayAttendance = attendanceRows.find(function(r) {
      var aDate = String(r[ATTENDANCE_COL.DATE - 1] || '').replace(/-/g, '/');
      var aEmpId = r[ATTENDANCE_COL.EMPLOYEE_ID - 1];
      return aDate === targetDate && aEmpId === empId;
    });

    if (!todayAttendance) {
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
        warnings.push({
          employee_id: empId,
          name: empName,
          date: targetDateDash,
          pattern: 'missing_time_out',
          clocked_in_at: timeIn,
          message: '⚠️ ' + targetDateDash + ' は出勤済みですが退勤打刻がありません',
        });
      } else if (!timeIn && !timeOut) {
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
 * 特定スタッフの打刻漏れを指定月範囲で検出する（Kintai個人確認用・高速版）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {Object}
 */
function getMyMissingClocks(ss, data) {
  if (!data.employee_id) throw new Error('employee_id は必須です。');

  var empId = String(data.employee_id);

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

  var attendanceSheet  = getOrCreateSheet(ss, SHEET.ATTENDANCE);
  var employeeSheet    = getOrCreateSheet(ss, SHEET.EMPLOYEES);
  var companyCalSheet  = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var requestSheet     = getOrCreateSheet(ss, SHEET.REQUESTS);

  var empRow = getAllRows(employeeSheet).find(function(r) {
    return String(r[EMPLOYEE_COL.ID - 1] || '') === empId;
  });
  if (!empRow) {
    Logger.log('[getMyMissingClocks] スタッフが見つかりません: %s', empId);
    return { warnings: [] };
  }

  var workDaysStr = String(empRow[EMPLOYEE_COL.WORK_DAYS - 1] || '');
  var workDays    = workDaysStr.split(',').map(function(d) { return d.trim(); }).filter(Boolean);

  var holidaySet = new Set();
  if (companyCalSheet.getLastRow() > 1) {
    getAllRows(companyCalSheet).forEach(function(r) {
      var raw = String(r[0] || '').replace(/\//g, '-').slice(0, 10);
      if (raw) holidaySet.add(raw);
    });
  }

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

  var warnings = [];

  targetMonths.forEach(function(ym) {
    var ymParts    = ym.split('-');
    var y = parseInt(ymParts[0]), m = parseInt(ymParts[1]);
    var daysInMonth = new Date(y, m, 0).getDate();

    for (var day = 1; day <= daysInMonth; day++) {
      var dateStr = y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');

      if (dateStr > todayStr) break;

      var dow = getJapaneseDayOfWeek(dateStr);
      if (workDays.length > 0 && workDays.indexOf(dow) === -1) continue;

      if (holidaySet.has(dateStr)) continue;

      if (absenceSet.has(dateStr)) continue;

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
          continue;
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

  warnings.sort(function(a, b) { return a.date.localeCompare(b.date); });

  Logger.log('[getMyMissingClocks] empId=%s, 警告数=%d', empId, warnings.length);

  return { warnings: warnings };
}

/**
 * 日付文字列（YYYY-MM-DD）から日本語の曜日を取得する。
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} '月'|'火'|'水'|'木'|'金'|'土'|'日'
 */
function getJapaneseDayOfWeek(dateStr) {
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  var dayIndex = d.getDay();
  var dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  return dayNames[dayIndex];
}

/**
 * 指定月全体の打刻漏れを検出する（Admin 月次確認用）。
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

  var yearMonth = data.year_month;
  var year  = parseInt(yearMonth.split('-')[0]);
  var month = parseInt(yearMonth.split('-')[1]);

  Logger.log('[checkMissingClocksMonthly] 開始: year_month=%s', yearMonth);

  var daysInMonth = new Date(year, month, 0).getDate();
  var allDates = [];
  for (var day = 1; day <= daysInMonth; day++) {
    allDates.push(
      year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    );
  }

  var todayStr = formatDateString(new Date());
  allDates = allDates.filter(function(d) { return d <= todayStr; });

  var companyCalSheet = getOrCreateSheet(ss, SHEET.COMPANY_CAL);
  var holidayDates = new Set();
  if (companyCalSheet.getLastRow() > 1) {
    getAllRows(companyCalSheet).forEach(function(r) {
      var raw = String(r[0] || '');
      if (!raw) return;
      var normalized = raw.replace(/\//g, '-').slice(0, 10);
      if (normalized.startsWith(yearMonth)) holidayDates.add(normalized);
    });
  }

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

      var isAbsence = ['欠席', '有給', '会社休日', '補填休'].indexOf(type) !== -1;
      var isActive  = status !== 'rejected' && status !== 'cancelled';
      if (isAbsence && isActive && reqDate.startsWith(yearMonth)) {
        absenceApprovedSet.add(empId + '::' + reqDate);
      }
    });
  }

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

  var filterEmpId = data.employee_id ? String(data.employee_id) : '';

  var warnings = [];
  var employeeRows = getAllRows(employeeSheet);

  employeeRows.forEach(function(empRow) {
    if (empRow[EMPLOYEE_COL.DELETED - 1] === 'true' || empRow[EMPLOYEE_COL.DELETED - 1] === true) return;

    var empId = String(empRow[EMPLOYEE_COL.ID - 1] || '');

    if (filterEmpId && empId !== filterEmpId) return;
    var empName = (empRow[EMPLOYEE_COL.LAST_NAME  - 1] || '') + ' '
                + (empRow[EMPLOYEE_COL.FIRST_NAME - 1] || '');
    var workDaysStr = String(empRow[EMPLOYEE_COL.WORK_DAYS - 1] || '');
    var workDays    = workDaysStr.split(',').map(function(d) { return d.trim(); }).filter(Boolean);

    allDates.forEach(function(dateStr) {
      var dow = getJapaneseDayOfWeek(dateStr);
      if (workDays.length > 0 && workDays.indexOf(dow) === -1) return;

      if (holidayDates.has(dateStr)) return;

      if (absenceApprovedSet.has(empId + '::' + dateStr)) return;

      var key = empId + '::' + dateStr;
      var att = attendanceMap[key];

      var pattern, clockedIn;
      if (!att) {
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
          return;
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

  warnings.sort(function(a, b) {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.name.localeCompare(b.name);
  });

  Logger.log('[checkMissingClocksMonthly] 完了: %d件', warnings.length);

  return { year_month: yearMonth, total_missing: warnings.length, missing: warnings };
}
