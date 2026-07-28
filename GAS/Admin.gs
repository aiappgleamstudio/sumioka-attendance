/**
 * Admin.gs - 管理者専用アクション（一部関数のみ現役）
 *
 * ⚠️ 2026-07-28 状態確認・整理済み:
 *   このファイルはかつて AdminServices.gs 全体の旧バージョンでしたが、
 *   実際に精査した結果、以下の3関数は AdminServices.gs から
 *   現在も明示的に呼ばれている「現役の実装」であることが判明しました。
 *   これらは削除せず、このファイルに残します。
 *
 *     - adminDashboard        （AdminServices.gs の admin_dashboard アクションから呼ばれる）
 *     - countPendingRequests  （adminDashboard の内部で使用）
 *     - calcWorkMinutesGas    （実働時間計算のユーティリティ）
 *
 *   それ以外の重複関数（adminAddAttendance 等9個）は
 *   AdminServices.gs 側に同名の実装があり、GASの実行順序により
 *   そちらが有効になっていた（＝このファイル側はデッドコード）ため削除しました。
 *
 *   今後この3関数を修正する場合は、このファイルに対して行ってください。
 *   AdminServices.gs へ完全移管する場合は、admin_dashboard の呼び出し元
 *   （AdminServices.gs 27行目付近）の参照を書き換えた上で行うこと。
 *
 * @version 1.1.0
 */

// ============================================================
// ダッシュボード
// ============================================================

/**
 * ダッシュボード用の本日集計データを返す。
 *
 * 返り値の構造:
 *   {
 *     date             : 'YYYY-MM-DD',
 *     checked_in_count : number,   // 出勤済み（退勤前）
 *     checked_out_count: number,   // 退勤済み
 *     lunch_yes_count  : number,   // 弁当要
 *     lunch_no_count   : number,   // 弁当不要
 *     absent_count     : number,   // 未打刻
 *     pending_count    : number,   // 承認待ち申請数
 *     attendance       : Object[], // 本日の打刻一覧
 *     absent_staff     : Object[], // 未打刻スタッフ一覧
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {string} date - YYYY-MM-DD
 * @returns {Object}
 */
function adminDashboard(attendanceSheet, employeeSheet, date) {
  if (!date) throw new Error('date は必須です。');

  const dateKey    = date.replace(/-/g, '/');
  const allAttRows = getAllRows(attendanceSheet);
  const allEmpRows = getAllRows(employeeSheet);

  // 今日の出退勤レコードを取得する
  const todayRecords = allAttRows
    .filter(row => String(row[ATTENDANCE_COL.DATE - 1]).startsWith(dateKey))
    .map(row => rowToAttendanceRecord(row));

  // 人員マップ（id→employee）: IDは文字列で統一する
  const empMap = allEmpRows.reduce((map, row) => {
    const emp = rowToEmployee(row);
    if (emp.id) map[String(emp.id)] = emp;
    return map;
  }, {});

  // ── STEP1: 申請を先に取得して分類する ────────────────────
  // 申請の種別で「欠勤扱い」と「バッジのみ」に分ける。
  // 欠勤扱い: 打刻なし → 打刻一覧に「欠勤」ステータスで表示 + 欠勤一覧に掲載
  // バッジのみ: 出勤するが時間がずれる（遅刻・早退）→ 打刻一覧にバッジだけ表示
  const ABSENT_TYPES = ['欠席','有給','補填休','会社休日','在宅','外出勤務','休み'];
  const BADGE_ONLY   = ['遅刻','早退'];

  const todayReqMap = {};  // { employee_id(String): type }

  try {
    const ss       = SpreadsheetApp.getActiveSpreadsheet();
    const reqSheet = ss.getSheetByName(SHEET.REQUESTS);
    if (reqSheet && reqSheet.getLastRow() > 1) {
      getAllRows(reqSheet).forEach(function(r) {
        // target_date はシートがDate型を返すとISO形式（"2026-05-19T15:00:00.000Z"）になる。
        // slice(0,10) で先頭10文字（YYYY-MM-DD）だけ取り出して比較する。
        var rawDate    = String(r[REQ_COL.TARGET_DATE - 1] || '');
        var targetDate = rawDate.length > 10 && rawDate.charAt(4) === '-'
                         ? rawDate.slice(0, 10)
                         : rawDate.replace(/\//g, '-').slice(0, 10);
        const type       = String(r[REQ_COL.TYPE        - 1] || '');
        const empId      = String(r[REQ_COL.EMPLOYEE_ID - 1] || '');
        const reqStatus  = String(r[REQ_COL.STATUS      - 1] || '');
        if (targetDate !== date)       return;
        if (reqStatus === 'rejected')  return;
        if (reqStatus === 'cancelled') return; // 取り下げ済みは除外
        // 同じ人に複数申請がある場合は欠勤系を優先
        if (!todayReqMap[empId] || ABSENT_TYPES.includes(type)) {
          todayReqMap[empId] = type;
        }
      });
    }
  } catch(e) { Logger.log('[adminDashboard] 申請取得エラー: ' + e.message); }

  // 欠勤申請のある employee_id セット（未打刻一覧から除外するため先に作る）
  const absentReqIds = new Set(
    Object.keys(todayReqMap).filter(id => ABSENT_TYPES.includes(todayReqMap[id]))
  );

  // ── STEP2: 打刻済み employee_id セット ────────────────────
  const punchedIds = new Set(todayRecords.map(r => String(r.employee_id)));

  // ── STEP3: 打刻一覧を生成する ────────────────────────────
  let checkedInCount  = 0;
  let checkedOutCount = 0;
  let lunchYesCount   = 0;
  let lunchNoCount    = 0;

  const attendanceList = todayRecords.map(rec => {
    const emp    = empMap[String(rec.employee_id)] || {};
    const d      = rec.data || {};
    const hasIn  = !!d.time_in;
    const hasOut = !!d.time_out;

    if (hasIn  && !hasOut) checkedInCount++;
    if (hasOut)            checkedOutCount++;
    if (d.lunch === true)  lunchYesCount++;
    else                   lunchNoCount++;

    return {
      employee_id  : rec.employee_id,
      name         : emp.name || '（不明）',
      type         : emp.employment_type || '―',
      time_in      : d.time_in  || '',
      time_out     : d.time_out || '',
      lunch        : d.lunch,
      status       : d.status || '',
      request_type : todayReqMap[String(rec.employee_id)] || '',
    };
  });

  // 打刻なし・申請あるスタッフを打刻一覧に追加する
  Object.keys(todayReqMap).forEach(function(empId) {
    if (punchedIds.has(empId)) return; // 打刻済みはスキップ
    const emp     = empMap[empId] || {};
    const reqType = todayReqMap[empId];
    attendanceList.push({
      employee_id  : empId,
      name         : emp.name || '（不明）',
      type         : emp.employment_type || '―',
      time_in      : '',
      time_out     : '',
      lunch        : null,
      // 欠勤系申請はステータスを「欠勤」に、遅刻・早退はバッジのみ
      status       : ABSENT_TYPES.includes(reqType) ? '欠勤' : '',
      request_type : reqType,
    });
  });

  // ── STEP4: 未打刻スタッフ一覧 ────────────────────────────
  // 欠勤申請のある人・打刻済みの人・勤務外曜日の人は除外する
  const todayDow = ['日','月','火','水','木','金','土'][new Date().getDay()];

  const absentStaff = allEmpRows
    .map(row => rowToEmployee(row))
    .filter(emp => {
      if (!emp.id)                                        return false;
      if (emp.deleted === true || emp.deleted === 'true') return false;
      if (punchedIds.has(String(emp.id)))                 return false;
      // 欠勤申請済みは未打刻ではなく欠勤一覧へ
      if (absentReqIds.has(String(emp.id)))               return false;
      if (emp.work_days && emp.work_days.length > 0) {
        return emp.work_days.includes(todayDow);
      }
      return true;
    })
    .map(emp => ({
      name           : emp.name,
      type           : emp.employment_type,
      scheduled_start: emp.scheduled_start || '―',
      scheduled_end  : emp.scheduled_end   || '―',
    }));

  // ── STEP5: 欠勤申請スタッフ一覧 ─────────────────────────
  const absentRequestStaff = [...absentReqIds].map(function(empId) {
    const emp = empMap[empId] || {};
    return {
      name           : emp.name || '（不明）',
      type           : emp.employment_type || '―',
      absence_type   : todayReqMap[empId],
      scheduled_start: emp.scheduled_start || '―',
      scheduled_end  : emp.scheduled_end   || '―',
    };
  });

  const pendingCount = countPendingRequests();

  Logger.log(
    '[adminDashboard] date=%s, punchedIn=%d, punchedOut=%d, absent=%d, absentReq=%d, pending=%d',
    date, checkedInCount, checkedOutCount, absentStaff.length, absentRequestStaff.length, pendingCount
  );

  return {
    date                 : date,
    checked_in_count     : checkedInCount,
    checked_out_count    : checkedOutCount,
    lunch_yes_count      : lunchYesCount,
    lunch_no_count       : lunchNoCount,
    absent_count         : absentStaff.length,
    pending_count        : pendingCount,
    attendance           : attendanceList,
    absent_staff         : absentStaff,
    absent_request_staff : absentRequestStaff,
  };
}

/**
 * 承認待ち申請数を返す。
 * 申請管理シートが存在しない場合は 0 を返す（エラーにしない）。
 *
 * @returns {number}
 */
function countPendingRequests() {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('申請管理');
    if (!sheet) return 0;

    const rows = getAllRows(sheet);
    // status 列（仮に列4）が '承認待ち' の行を数える
    return rows.filter(row => String(row[3] || '') === '承認待ち').length;
  } catch (err) {
    Logger.log('[countPendingRequests] 取得失敗（非致命的）: %s', err.message);
    return 0;
  }
}

// ============================================================
// 打刻管理ユーティリティ
// ============================================================

/**
 * 出勤・退勤・休憩から実働時間（分）を計算する（GAS側）。
 * どちらかが未入力の場合は null を返す。
 *
 * @param {string} timeIn        - 'HH:MM'
 * @param {string} timeOut       - 'HH:MM'
 * @param {number} [breakMinutes] - 休憩時間（分）
 * @returns {number|null}
 */
function calcWorkMinutesGas(timeIn, timeOut, breakMinutes) {
  if (!timeIn || !timeOut) return null;

  const [ih, im] = timeIn.split(':').map(Number);
  const [oh, om] = timeOut.split(':').map(Number);
  const total    = (oh * 60 + om) - (ih * 60 + im);
  const breakMin = Number(breakMinutes) || 0;

  return Math.max(0, total - breakMin);
}
