/**
 * Admin.gs - 管理者専用アクション（旧バージョン）
 *
 * ⚠️ v1.4.0 以降: このファイルの関数は AdminServices.gs に移行済みです。
 *
 * GAS はプロジェクト内のすべての .gs ファイルを結合して実行するため、
 * 同名関数が Admin.gs と AdminServices.gs の両方に存在します。
 * GAS の実行順序（ファイル名のアルファベット順）により
 * AdminServices.gs の定義が後から読み込まれ、こちらを上書きします。
 *
 * 将来的に Admin.gs は削除する予定です。
 * 新しい修正は必ず AdminServices.gs に対して行ってください。
 *
 * @version 1.0.0 (deprecated)
 * @deprecated AdminServices.gs を使用してください
 */

// ============================================================
// スタッフ管理
// ============================================================

/**
 * スタッフ一覧を取得して返す（admin.html スタッフ管理タブ用）。
 *
 * フィルタ仕様:
 *   'all'   → 全員（利用者含む）
 *   'staff' → 職員のみ（employment_type !== '利用者'）
 *   'user'  → 利用者のみ（employment_type === '利用者'）
 *
 * セキュリティ: パスワードはレスポンスに含めない。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - 人員マスタシート
 * @param {string} [type='all'] - フィルタ区分
 * @returns {{ staff: Object[] }}
 */
function adminStaffList(sheet, type) {
  const filterType = type || 'all';
  const rows = getAllRows(sheet);

  const staff = rows
    .map(row => rowToEmployee(row))
    // ID が空の行（ヘッダー残骸など）を除外する
    .filter(emp => !!emp.id)
    // 区分フィルタを適用する
    .filter(emp => {
      if (filterType === 'staff') return emp.employment_type !== '利用者';
      if (filterType === 'user')  return emp.employment_type === '利用者';
      return true; // 'all'
    })
    // フロントに返す形式に整形する（パスワードは除外）
    .map(emp => ({
      id           : emp.id,
      name         : emp.name,
      pin          : emp.pin,
      type         : emp.employment_type,
      employment   : emp.employment_type,
      scheduled_end: emp.scheduled_end,
      wage_type    : emp.wage_type,
      hourly_wage  : emp.hourly_wage,
      monthly_wage : emp.monthly_wage,
      // フロント表示用に「時給 or 月給」の値を wage として統合する
      wage         : emp.wage_type === '月給' ? emp.monthly_wage : emp.hourly_wage,
      is_admin     : emp.is_admin,
      work_days    : emp.work_days,
      scheduled_hours : emp.scheduled_hours,
      scheduled_start : emp.scheduled_start,
      scheduled_break : emp.scheduled_break,
      // 交通費・社保フラグなど給与計算拡張フィールド（Payroll.gs 連携用）
      transport_fee    : emp.transport_fee    || 0,
      social_insurance : emp.social_insurance !== false, // 未設定は加入とみなす
    }));

  Logger.log('[adminStaffList] type=%s, count=%d', filterType, staff.length);

  return { staff };
}

/**
 * スタッフを新規追加する。
 *
 * フロントから受け取る data の構造:
 *   {
 *     admin_id   : string,   // 操作した管理者の ID（ログ用）
 *     staff_data : {
 *       name            : string,   // 必須
 *       pin             : string,   // 必須・4桁数字
 *       password        : string,   // 必須
 *       employment_type : string,
 *       scheduled_end   : string,   // HH:MM
 *       wage_type       : string,   // '時給' | '月給'
 *       hourly_wage     : number,
 *       monthly_wage    : number,
 *       is_admin        : boolean,
 *       work_days       : string[],
 *       transport_fee   : number,
 *       social_insurance: boolean,
 *     }
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @returns {{ id: string, saved: boolean }}
 */
function adminAddStaff(sheet, data) {
  const { admin_id, staff_data: sd } = data;

  if (!sd)          throw new Error('staff_data は必須です。');
  if (!sd.name)     throw new Error('氏名は必須です。');
  if (!sd.pin)      throw new Error('PIN は必須です。');
  if (!sd.password) throw new Error('パスワードは必須です。');

  if (!/^\d{4}$/.test(sd.pin)) {
    throw new Error('PIN は4桁の数字で指定してください。');
  }

  // 同じ PIN が既に存在しないかチェックする。
  // PIN はログイン識別子なので重複を許可しない。
  const rows = getAllRows(sheet);
  const duplicate = rows.find(row =>
    String(row[EMPLOYEE_COL.PIN - 1]) === String(sd.pin)
  );
  if (duplicate) {
    throw new Error('この PIN は既に使用されています。別の PIN を設定してください。');
  }

  Logger.log('[adminAddStaff] 追加: name=%s, admin=%s', sd.name, admin_id);

  // saveEmployee（Code.gs）に処理を委譲する。
  // id を渡さないことで新規登録として扱われる。
  return saveEmployee(sheet, {
    // id を含めない → 新規として saveEmployee が generateId() する
    name     : sd.name,
    pin      : sd.pin,
    password : sd.password,
    employee_data: {
      employment_type  : sd.employment_type  || '',
      scheduled_hours  : sd.scheduled_hours  || '',
      scheduled_start  : sd.scheduled_start  || '',
      scheduled_end    : sd.scheduled_end    || '',
      scheduled_break  : sd.scheduled_break  ?? '',
      wage_type        : sd.wage_type        || '',
      hourly_wage      : sd.hourly_wage      ?? '',
      monthly_wage     : sd.monthly_wage     ?? '',
      default_lunch    : sd.default_lunch    || false,
      work_days        : sd.work_days        || [],
      is_admin         : sd.is_admin         || false,
    },
  });
}

/**
 * 既存スタッフの情報を更新する。
 *
 * フロントから受け取る data の構造:
 *   {
 *     admin_id    : string,
 *     employee_id : string,   // 更新対象のID（必須）
 *     staff_data  : { ... }   // adminAddStaff と同じ構造（password は省略可）
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @returns {{ id: string, saved: boolean }}
 */
function adminUpdateStaff(sheet, data) {
  const { admin_id, employee_id, staff_data: sd } = data;

  if (!employee_id) throw new Error('employee_id は必須です。');
  if (!sd)          throw new Error('staff_data は必須です。');
  if (!sd.name)     throw new Error('氏名は必須です。');
  if (!sd.pin)      throw new Error('PIN は必須です。');

  if (!/^\d{4}$/.test(sd.pin)) {
    throw new Error('PIN は4桁の数字で指定してください。');
  }

  // PIN 重複チェック（自分自身は除外する）
  const rows = getAllRows(sheet);
  const duplicate = rows.find(row =>
    String(row[EMPLOYEE_COL.PIN - 1]) === String(sd.pin) &&
    String(row[EMPLOYEE_COL.ID  - 1]) !== String(employee_id)
  );
  if (duplicate) {
    throw new Error('この PIN は既に他のスタッフが使用しています。');
  }

  // 既存行からパスワードを引き継ぐ（未変更の場合）
  const existing = rows.find(row => String(row[EMPLOYEE_COL.ID - 1]) === String(employee_id));
  if (!existing) {
    throw new Error('指定されたスタッフが見つかりません: ' + employee_id);
  }
  const currentPassword = String(existing[EMPLOYEE_COL.PASSWORD - 1] || '');

  Logger.log('[adminUpdateStaff] 更新: id=%s, admin=%s', employee_id, admin_id);

  return saveEmployee(sheet, {
    id       : employee_id,
    name     : sd.name,
    pin      : sd.pin,
    // パスワードが送られてきた場合は更新、空欄なら既存値を保持する
    password : sd.password || currentPassword,
    employee_data: {
      employment_type  : sd.employment_type  || '',
      scheduled_hours  : sd.scheduled_hours  || '',
      scheduled_start  : sd.scheduled_start  || '',
      scheduled_end    : sd.scheduled_end    || '',
      scheduled_break  : sd.scheduled_break  ?? '',
      wage_type        : sd.wage_type        || '',
      hourly_wage      : sd.hourly_wage      ?? '',
      monthly_wage     : sd.monthly_wage     ?? '',
      default_lunch    : sd.default_lunch    || false,
      work_days        : sd.work_days        || [],
      is_admin         : sd.is_admin         || false,
    },
  });
}

/**
 * スタッフを削除する（物理削除）。
 *
 * 削除前にバックアップを取る。
 * 関連する勤怠記録・給与データは削除しない（参照整合性はアプリ側で管理）。
 *
 * フロントから受け取る data の構造:
 *   {
 *     admin_id    : string,
 *     employee_id : string,   // 削除対象のID（必須）
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @returns {{ deleted: boolean, id: string }}
 */
function adminDeleteStaff(sheet, data) {
  const { admin_id, employee_id } = data;

  if (!employee_id) throw new Error('employee_id は必須です。');

  const rows     = getAllRows(sheet);
  const rowIndex = rows.findIndex(row =>
    String(row[EMPLOYEE_COL.ID - 1]) === String(employee_id)
  );

  if (rowIndex === -1) {
    throw new Error('指定されたスタッフが見つかりません: ' + employee_id);
  }

  // 削除前にバックアップを保存する（復元の手がかりにする）
  saveBackup(SHEET.EMPLOYEES, employee_id, rows[rowIndex]);

  // シートの行番号は 1 始まり + ヘッダー行分 = rowIndex + 2
  sheet.deleteRow(rowIndex + 2);

  Logger.log('[adminDeleteStaff] 削除: id=%s, admin=%s', employee_id, admin_id);

  return { deleted: true, id: employee_id };
}

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
// 申請管理
// ============================================================

/**
 * 申請を承認または却下する。
 *
 * フロントから受け取る data の構造:
 *   {
 *     request_id : string,
 *     action     : 'approve' | 'reject',
 *     admin_id   : string,
 *   }
 *
 * 申請管理シートが存在しない場合はエラーを返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {{ updated: boolean, pending_count: number }}
 */
function adminUpdateRequest(ss, data) {
  const { request_id, action, admin_id } = data;

  if (!request_id) throw new Error('request_id は必須です。');
  if (!action)     throw new Error('action は必須です。');
  if (action !== 'approve' && action !== 'reject') {
    throw new Error('action は approve または reject を指定してください。');
  }

  const sheet = ss.getSheetByName('申請管理');
  if (!sheet) {
    throw new Error('申請管理シートが存在しません。');
  }

  const rows     = getAllRows(sheet);
  const rowIndex = rows.findIndex(row => String(row[0] || '') === String(request_id));

  if (rowIndex === -1) {
    throw new Error('指定された申請が見つかりません: ' + request_id);
  }

  // バックアップを取ってからステータスを更新する
  saveBackup('申請管理', request_id, rows[rowIndex]);

  const newStatus  = action === 'approve' ? '承認済み' : '却下済み';
  const now        = new Date().toISOString();
  const sheetRow   = rowIndex + 2;

  // status 列（4列目）とタイムスタンプ列（5列目）を更新する
  // ※ 申請管理シートの列構成に合わせて要調整
  sheet.getRange(sheetRow, 4).setValue(newStatus);
  sheet.getRange(sheetRow, 5).setValue(now);
  sheet.getRange(sheetRow, 6).setValue(admin_id); // 承認者ID

  SpreadsheetApp.flush();

  const pendingCount = countPendingRequests();

  Logger.log(
    '[adminUpdateRequest] id=%s, action=%s, admin=%s',
    request_id, action, admin_id
  );

  return { updated: true, pending_count: pendingCount };
}

// ============================================================
// 打刻管理（管理者専用：修正・新規登録）
// ============================================================

/**
 * 勤怠一覧を取得する（管理者用）。
 *
 * 絞り込み条件（data のフィールド）:
 *   date        : 'YYYY-MM-DD' → その日の全スタッフ分
 *   employee_id : ID           → そのスタッフの直近30日分
 *   両方指定    → date × employee_id で絞り込む
 *
 * 返り値にはスタッフ名・区分を付与してフロントで使いやすい形にする。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {Object} data - { date?, employee_id? }
 * @returns {{ records: Object[] }}
 */
function adminAttendanceList(ss, attendanceSheet, employeeSheet, data) {
  const { date, employee_id } = data;

  if (!date && !employee_id) {
    throw new Error('date または employee_id のどちらかは必須です。');
  }

  // 人員マップを生成する（id → employee）
  const empRows = getAllRows(employeeSheet);
  const empMap  = empRows.reduce((map, row) => {
    const emp = rowToEmployee(row);
    if (emp.id) map[emp.id] = emp;
    return map;
  }, {});

  const allRows = getAllRows(attendanceSheet);

  // フィルタ条件を構築する
  // スプシ内の date は YYYY/MM/DD 形式で保存されているため変換して比較する
  const dateKey = date ? date.replace(/-/g, '/') : null;

  const records = allRows
    .filter(row => {
      const rowDate = String(row[ATTENDANCE_COL.DATE        - 1] || '');
      const rowEmp  = String(row[ATTENDANCE_COL.EMPLOYEE_ID - 1] || '');
      const matchDate = !dateKey     || rowDate.startsWith(dateKey);
      const matchEmp  = !employee_id || rowEmp === employee_id;
      return matchDate && matchEmp;
    })
    .map(row => {
      const rec = rowToAttendanceRecord(row);
      const emp = empMap[rec.employee_id] || {};
      return {
        id          : rec.id,
        employee_id : rec.employee_id,
        name        : emp.name            || '（不明）',
        type        : emp.employment_type || '―',
        date        : rec.date,
        time_in     : rec.data.time_in    || '',
        time_out    : rec.data.time_out   || '',
        status      : rec.data.status     || '',
        lunch       : rec.data.lunch,
        memo        : rec.data.memo       || '',
        is_absent   : false,  // 打刻あり
      };
    });

  // 日付指定かつスタッフ絞り込みなしの場合のみ、未打刻スタッフを追加する。
  // 理由: 特定スタッフ検索では「未打刻の日」は意味をなさないが、
  //        「任意の日の全員分」ではいない人を明示することが運用上重要なため。
  let absentRecords = [];
  if (date && !employee_id) {

    // ── ① 検索日の曜日を正確に取得する ──────────────────────────
    // 従来は new Date().getDay()（今日の曜日）を使っていたため、
    // 過去・未来の日付で検索すると曜日判定がずれていた。
    // date（YYYY-MM-DD）から正確な曜日を計算する。
    const searchDate  = new Date(date + 'T00:00:00');
    const searchDow   = ['日', '月', '火', '水', '木', '金', '土'][searchDate.getDay()];
    const searchDateNorm = date.replace(/-/g, '/'); // YYYY/MM/DD 形式（シート比較用）

    // ── ② 会社休日チェック ──────────────────────────────────────
    // 会社カレンダーシートから検索日が会社休日かを確認する。
    // 会社休日であれば全スタッフを未打刻扱いから除外する。
    const compCalSheet    = ss.getSheetByName(SHEET.COMPANY_CAL);
    const isCompanyHoliday = compCalSheet ? (() => {
      const compRows = getAllRows(compCalSheet);
      return compRows.some(r => {
        const d = String(r[0] || '').replace(/-/g, '/').slice(0, 10);
        return d === searchDateNorm.slice(0, 10);
      });
    })() : false;

    // 会社休日なら未打刻スタッフ一覧は空にして終了
    if (isCompanyHoliday) {
      // absentRecords は空のまま
    } else {
      // ── ③ 欠勤・申請済みスタッフのセットを作る ─────────────────
      // 申請管理シートで当日・承認済みの欠勤系申請があるスタッフは
      // 未打刻扱いから除外する（正当な欠勤・有給・補填休など）。
      const ABSENT_REQ_TYPES = ['欠席', '有給', '補填休', '会社休日', '在宅', '外出勤務', '休み'];
      const reqSheet = ss.getSheetByName(SHEET.REQUESTS);
      const absenceApprovedSet = new Set();
      if (reqSheet) {
        const reqRows = getAllRows(reqSheet);
        reqRows.forEach(r => {
          const reqEmpId  = String(r[REQ_COL.EMPLOYEE_ID  - 1] || '');
          const reqStatus = String(r[REQ_COL.STATUS       - 1] || '');
          const reqType   = String(r[REQ_COL.TYPE         - 1] || '');
          const reqDate   = String(r[REQ_COL.TARGET_DATE  - 1] || '').replace(/-/g, '/').slice(0, 10);
          if (reqDate === searchDateNorm.slice(0, 10) &&
              (reqStatus === 'approved') &&
              ABSENT_REQ_TYPES.includes(reqType)) {
            absenceApprovedSet.add(reqEmpId);
          }
        });
      }

      // ── ④ 出退勤記録に status='欠勤' で登録済みのスタッフも除外 ──
      // 打刻修正モーダルから欠勤登録した場合、申請管理シートには書かれないため
      // 出退勤記録シートの status='欠勤' を直接チェックする。
      const attendanceAbsentSet = new Set(
        records
          .filter(r => r.status === '欠勤')
          .map(r => r.employee_id)
      );

      const punchedIds = new Set(records.map(r => r.employee_id));

      absentRecords = Object.values(empMap)
        .filter(emp => {
          if (!emp.id)                          return false;
          if (punchedIds.has(emp.id))           return false; // 打刻済みは除外
          if (absenceApprovedSet.has(emp.id))   return false; // 申請承認済みは除外
          if (attendanceAbsentSet.has(emp.id))  return false; // 打刻修正欠勤は除外
          // 検索日の曜日が勤務曜日に含まれるかチェック（正確な曜日で判定）
          if (emp.work_days && emp.work_days.length > 0) {
            return emp.work_days.includes(searchDow);
          }
          return true; // work_days 未設定は毎日勤務扱い
        })
        .map(emp => ({
          id            : '',
          employee_id   : emp.id,
          name          : emp.name            || '（不明）',
          type          : emp.employment_type || '―',
          date          : date,
          time_in       : '',
          time_out      : '',
          status        : '未打刻',
          lunch         : null,
          memo          : '',
          is_absent     : true,  // 未打刻フラグ（フロントで行の強調表示に使う）
          scheduled_end : emp.scheduled_end || '',
        }));
    }
  }

  // 日付昇順 → 未打刻を末尾 → 氏名昇順でソート
  const allRecords = [...records, ...absentRecords];
  allRecords.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    // 未打刻は最後にまとめる（運用しやすさのため）
    if (a.is_absent !== b.is_absent) return a.is_absent ? 1 : -1;
    return a.name.localeCompare(b.name, 'ja');
  });

  Logger.log('[adminAttendanceList] records=%d, absent=%d', records.length, absentRecords.length);
  return { records: allRecords };
}

/**
 * 既存の打刻レコードを修正する（監査ログ付き）。
 *
 * 「打刻修正」は改ざんリスクがあるため、
 * 修正前のデータを _バックアップ シートに記録し、
 * さらに監査ログシートに「誰が・いつ・何を・なぜ」を残す。
 *
 * フロントから受け取る data の構造:
 *   {
 *     employee_id     : string,
 *     date            : 'YYYY-MM-DD',
 *     attendance_data : { time_in, time_out, status, lunch, memo },
 *     admin_id        : string,
 *     reason          : string,   // 必須（監査ログ用）
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {{ saved: boolean }}
 */
function adminEditAttendance(attendanceSheet, ss, data) {
  const { employee_id, date, attendance_data, admin_id, reason } = data;

  if (!employee_id)     throw new Error('employee_id は必須です。');
  if (!date)            throw new Error('date は必須です。');
  if (!attendance_data) throw new Error('attendance_data は必須です。');
  if (!reason)          throw new Error('修正理由（reason）は必須です。');

  const dateKey = date.replace(/-/g, '/');
  const rows    = getAllRows(attendanceSheet);

  // 対象レコードを employee_id + date で検索する
  const rowIndex = rows.findIndex(row =>
    String(row[ATTENDANCE_COL.EMPLOYEE_ID - 1]) === employee_id &&
    String(row[ATTENDANCE_COL.DATE        - 1]) === dateKey
  );

  if (rowIndex === -1) {
    throw new Error(
      `対象のレコードが見つかりません。スタッフID: ${employee_id}, 日付: ${date}`
    );
  }

  // 修正前データをバックアップに保存する（復元の手がかり）
  const existingRow = rows[rowIndex];
  saveBackup(SHEET.ATTENDANCE, existingRow[ATTENDANCE_COL.ID - 1], existingRow);

  // 実働時間を再計算する（time_in / time_out から算出）
  const ad         = attendance_data;
  const workMin    = calcWorkMinutesGas(ad.time_in, ad.time_out, ad.break_minutes);
  const now        = new Date().toISOString();
  const sheetRow   = rowIndex + 2; // +2 = ヘッダー行 + 0始まり補正

  // 修正内容を書き込む（id と employee_id と date は変えない）
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.STATUS,       1, 1).setValues([[ad.status       || '']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.TIME_IN,      1, 1).setValues([[ad.time_in      || '']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.TIME_OUT,     1, 1).setValues([[ad.time_out     || '']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.BREAK_MINUTES,1, 1).setValues([[ad.break_minutes ?? '']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.WORK_MINUTES, 1, 1).setValues([[workMin         ?? '']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.LUNCH,        1, 1).setValues([[ad.lunch === true ? '有' : '無']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.MEMO,         1, 1).setValues([[ad.memo         || '']]);
  attendanceSheet.getRange(sheetRow, ATTENDANCE_COL.UPDATED_AT,   1, 1).setValues([[now]]);

  SpreadsheetApp.flush();

  // 監査ログに記録する（打刻修正の透明性を確保する）
  writeAuditLog(ss, {
    action      : '打刻修正',
    admin_id,
    target_id   : employee_id,
    target_date : date,
    reason,
    before      : JSON.stringify({
      status  : existingRow[ATTENDANCE_COL.STATUS   - 1],
      time_in : existingRow[ATTENDANCE_COL.TIME_IN  - 1],
      time_out: existingRow[ATTENDANCE_COL.TIME_OUT - 1],
    }),
    after       : JSON.stringify({
      status  : ad.status,
      time_in : ad.time_in,
      time_out: ad.time_out,
    }),
    timestamp   : now,
  });

  Logger.log(
    '[adminEditAttendance] 修正完了: emp=%s, date=%s, admin=%s',
    employee_id, date, admin_id
  );

  return { saved: true };
}

/**
 * 打刻忘れ等で存在しない日付のレコードを新規登録する（監査ログ付き）。
 *
 * saveAttendanceRecord（Code.gs）に委譲してupsertするが、
 * 管理者操作として監査ログを別途記録する点が異なる。
 *
 * フロントから受け取る data の構造:
 *   {
 *     employee_id     : string,
 *     date            : 'YYYY-MM-DD',
 *     attendance_data : { time_in, time_out, status, lunch, memo },
 *     admin_id        : string,
 *     reason          : string,   // 必須（監査ログ用）
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {{ saved: boolean, id: string }}
 */
function adminAddAttendance(attendanceSheet, ss, data) {
  const { employee_id, date, attendance_data, admin_id, reason } = data;

  if (!employee_id)     throw new Error('employee_id は必須です。');
  if (!date)            throw new Error('date は必須です。');
  if (!attendance_data) throw new Error('attendance_data は必須です。');
  if (!reason)          throw new Error('修正理由（reason）は必須です。');

  // saveAttendanceRecord は upsert なので、既存レコードがあれば上書きになる。
  // 管理者の新規登録もこれで統一する（二重登録を防ぐため）。
  const ad      = attendance_data;
  const workMin = calcWorkMinutesGas(ad.time_in, ad.time_out, ad.break_minutes);
  const now     = new Date().toISOString();

  const result = saveAttendanceRecord(attendanceSheet, {
    employee_id,
    date,
    attendance_data: {
      status       : ad.status       || '出勤',
      time_in      : ad.time_in      || '',
      time_out     : ad.time_out     || '',
      break_minutes: ad.break_minutes ?? null,
      work_minutes : workMin,
      lunch        : ad.lunch        === true,
      memo         : ad.memo         || '',
    },
  });

  // 監査ログに記録する
  writeAuditLog(ss, {
    action      : '打刻新規登録（管理者）',
    admin_id,
    target_id   : employee_id,
    target_date : date,
    reason,
    before      : '（レコードなし）',
    after       : JSON.stringify({
      status  : ad.status,
      time_in : ad.time_in,
      time_out: ad.time_out,
    }),
    timestamp   : now,
  });

  Logger.log(
    '[adminAddAttendance] 新規登録完了: emp=%s, date=%s, admin=%s',
    employee_id, date, admin_id
  );

  return { saved: true, id: result.id };
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

/**
 * 監査ログシートに打刻修正・新規登録の記録を書き込む。
 * ログシートが存在しない場合は自動作成する。
 * 書き込み失敗はメイン処理に影響させない（try/catch で握り潰す）。
 *
 * 監査ログシートの列構成:
 *   A: timestamp, B: action, C: admin_id, D: target_id,
 *   E: target_date, F: reason, G: before, H: after
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} log
 */
function writeAuditLog(ss, log) {
  try {
    const AUDIT_SHEET = '監査ログ';
    let sheet = ss.getSheetByName(AUDIT_SHEET);

    if (!sheet) {
      sheet = ss.insertSheet(AUDIT_SHEET);
      sheet.getRange(1, 1, 1, 8).setValues([[
        'timestamp', '操作', '管理者ID', '対象スタッフID',
        '対象日', '理由', '修正前', '修正後',
      ]]);
      sheet.setFrozenRows(1);
    }

    sheet.appendRow([
      log.timestamp,
      log.action,
      log.admin_id,
      log.target_id,
      log.target_date,
      log.reason,
      log.before,
      log.after,
    ]);

    Logger.log('[writeAuditLog] 記録完了: action=%s', log.action);

  } catch (err) {
    // 監査ログの失敗はメイン処理を止めない
    Logger.log('[writeAuditLog] 記録失敗（非致命的）: %s', err.message);
  }
}