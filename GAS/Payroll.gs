/**
 * Payroll.gs - 給与計算エンジン
 *
 * 役割:
 *   - 月次給与計算（基本給・残業・社会保険・所得税・インセンティブ）
 *   - 給与設定の保存・読み込み（社保率・弁当代・割増率など）
 *   - インセンティブ（個人ボーナス）の登録・読み込み
 *
 * 設計方針:
 *   - Code.gs の SHEET 定数・getAllRows・rowToEmployee・
 *     generateId・saveBackup を使用する
 *   - 計算ロジックと入出力（シート操作）を分離する
 *     → calcPayrollForEmployee() は純粋関数（副作用なし）
 *   - 日本の社会保険・所得税の計算方法に準拠する（2024年度）
 *   - 将来の法改正に備え、税率・保険料率はすべて設定シートで管理する
 *
 * スプレッドシート構成（このファイルが使うシート）:
 *   - 給与設定     : 社保率・所得税率・弁当代・各種手当の設定値
 *   - インセンティブ : 個人別・月別のボーナス登録
 *   - 給与計算結果  : 月次計算結果の保存（参照・再計算用）
 *
 * @version 1.0.0
 */

// ============================================================
// 定数
// ============================================================

/**
 * 給与計算で使うシート名。
 * SHEET 定数（Code.gs）とは別に Payroll.gs 内で管理する。
 */
const PAYROLL_SHEET = {
  SETTINGS    : '給与設定',
  INCENTIVES  : 'インセンティブ',
  RESULTS     : '給与計算結果',
};

/**
 * デフォルトの給与設定値。
 * 設定シートが存在しない場合・項目が未設定の場合に使う。
 *
 * ─────────────────────────────────────────────────────
 * 社会保険料率（2025年度・令和7年度 確定値）
 * ─────────────────────────────────────────────────────
 *
 * 【健康保険】協会けんぽ 愛知県
 *   労使合計 10.03%（2025年3月分から改定・前年度 10.02%）
 *   本人負担 5.015% / 会社負担 5.015%（労使折半）
 *   ※ 都道府県ごとに異なる。愛知県以外は設定シートから変更すること。
 *   ※ 半田市・名古屋市の差異なし（協会けんぽは都道府県単位）。
 *
 * 【介護保険】全国一律
 *   労使合計 1.59%（2025年3月分から改定・前年度 1.60%）
 *   本人負担 0.795% / 会社負担 0.795%（労使折半）
 *   ※ 40歳以上のスタッフのみ。スタッフ個別の ins_care フラグで管理。
 *
 * 【厚生年金】全国一律
 *   労使合計 18.30%（変更なし）
 *   本人負担 9.15% / 会社負担 9.15%（労使折半）
 *
 * 【雇用保険】全国一律（一般事業）
 *   本人負担 0.55%（2025年4月から改定・前年度 0.60%）
 *   会社負担 0.90%（失業等給付 0.55% + 雇用保険二事業 0.35%）
 *   ※ 本人と会社で負担割合が異なる（会社は二事業分を追加負担）。
 *   ※ 農林水産・清酒製造・建設業は異なる料率が適用される。
 *   ※ 都道府県・市区町村による差異なし。
 *
 * ⚠️ 毎年3〜4月に改定されるため、法改正時は設定シートから上書きすること。
 */
const DEFAULT_PAYROLL_SETTINGS = {
  // ── 社会保険料率・本人負担分（%表記）────────────────
  health_insurance_rate         : 5.015, // 健康保険・本人（愛知県・2025年度）
  care_insurance_rate           : 0.795, // 介護保険・本人（全国一律・2025年度）
  pension_rate                  : 9.15,  // 厚生年金・本人（全国一律）
  employment_insurance_rate     : 0.55,  // 雇用保険・本人（一般事業・2025年度）

  // ── 社会保険料率・会社負担分（%表記）────────────────
  // 健康保険・介護保険・厚生年金は労使折半のため本人と同率。
  // 雇用保険のみ会社が「雇用保険二事業」分（0.35%）を追加負担するため異なる。
  health_insurance_rate_company    : 5.015, // 健康保険・会社（労使折半）
  care_insurance_rate_company      : 0.795, // 介護保険・会社（労使折半）
  pension_rate_company             : 9.15,  // 厚生年金・会社（労使折半）
  employment_insurance_rate_company: 0.90,  // 雇用保険・会社（0.55% + 二事業0.35%）

  // ── 残業・休日割増率（%）──────────────────────────
  overtime_rate            : 25,     // 時間外労働割増（法定: 25%）
  late_night_rate          : 50,     // 深夜割増（法定: 50%）
  holiday_rate             : 35,     // 休日出勤割増（法定: 35%）

  // ── その他控除・手当 ──────────────────────────────
  lunch_price              : 500,    // 弁当代（円/食）
  transport_fee_taxable    : false,  // 交通費を課税対象とするか

  // ── 所定労働設定 ──────────────────────────────────
  overtime_threshold_hours : 8,      // 1日の法定労働時間（時間）
};

// ============================================================
// 給与計算メイン
// ============================================================

/**
 * 指定月の全スタッフ分の給与を計算して返す。
 *
 * 処理フロー:
 *   1. 指定月の勤怠レコードを取得する
 *   2. 人員マスタ・給与設定・インセンティブを取得する
 *   3. スタッフごとに calcPayrollForEmployee() で計算する
 *   4. 計算結果をシートに保存して返す
 *
 * 返り値の構造:
 *   {
 *     year_month  : 'YYYY-MM',
 *     generated_at: ISO 8601,
 *     payroll     : PayrollResult[],
 *   }
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet
 * @param {GoogleAppsScript.Spreadsheet.Sheet} employeeSheet
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} yearMonth - 'YYYY-MM'
 * @returns {Object}
 */
function calculatePayroll(attendanceSheet, employeeSheet, ss, yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error('year_month は YYYY-MM 形式で指定してください: ' + yearMonth);
  }

  Logger.log('[calculatePayroll] 開始: yearMonth=%s', yearMonth);

  // ── Step 1: データ取得 ──────────────────────────────
  const settings    = loadPayrollSettings(ss).settings;
  const incentives  = loadPayrollIncentives(ss, yearMonth, null).incentives;
  const empRows     = getAllRows(employeeSheet);
  const attRows     = getAllRows(attendanceSheet);

  // 指定月の勤怠レコードだけに絞る（YYYY/MM または YYYY-MM の両形式に対応）
  const monthPrefix = yearMonth.replace(/-/g, '/'); // 'YYYY/MM'
  const monthAttRows = attRows.filter(row => {
    const dateStr = String(row[ATTENDANCE_COL.DATE - 1] || '');
    return dateStr.startsWith(monthPrefix) || dateStr.startsWith(yearMonth);
  });

  // employee_id でグループ化する
  const attByEmployee = monthAttRows.reduce((groups, row) => {
    const rec = rowToAttendanceRecord(row);
    const id  = rec.employee_id;
    if (!groups[id]) groups[id] = [];
    groups[id].push(rec);
    return groups;
  }, {});

  // ── Step 2: 人員マップ生成 ──────────────────────────
  const empMap = empRows.reduce((map, row) => {
    const emp = rowToEmployee(row);
    // ID は文字列として統一する（attendance の employee_id も String 強制済のため）
    if (emp.id) map[String(emp.id)] = emp;
    return map;
  }, {});

  // ── Step 3: スタッフごとに給与計算する ─────────────
  // 利用者は給与計算対象外（employment_type === '利用者'）
  const payroll = Object.keys(empMap)
    .filter(id => empMap[id].employment_type !== '利用者')
    .map(id => {
      const emp     = empMap[id];
      const records = attByEmployee[id] || [];
      // このスタッフのインセンティブを絞り込む
      const empIncentives = incentives.filter(inc => inc.employee_id === id);

      return calcPayrollForEmployee(emp, records, settings, empIncentives, yearMonth);
    });

  // 氏名の五十音順でソート
  payroll.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  // ── Step 4: 計算結果をシートに保存する ─────────────
  savePayrollResults(ss, yearMonth, payroll);

  Logger.log('[calculatePayroll] 完了: %d名分', payroll.length);

  return {
    year_month   : yearMonth,
    generated_at : new Date().toISOString(),
    payroll,
  };
}

/**
 * 1人分の給与を計算する（純粋関数・副作用なし）。
 *
 * 計算ステップ:
 *   A. 勤怠集計（実働時間・残業時間・遅刻/早退控除時間など）
 *   B. 基本給計算（時給 or 月給）
 *   C. 残業手当計算
 *   D. 休日出勤手当計算
 *   E. 弁当代控除
 *   F. 交通費加算
 *   G. インセンティブ加算
 *   H. 課税対象額計算（B+C+D+F+G から非課税分を除く）
 *   I. 社会保険料計算（健康・介護・年金・雇用）
 *   J. 所得税計算（源泉徴収税額表 甲欄 簡易計算）
 *   K. 差引支給額 = 総支給 - 社会保険料合計 - 所得税 - 弁当代
 *
 * @param {Object}   emp         - rowToEmployee で変換した人員オブジェクト
 * @param {Object[]} records     - その月の勤怠レコード配列
 * @param {Object}   settings    - 給与設定
 * @param {Object[]} incentives  - このスタッフのインセンティブ配列
 * @param {string}   yearMonth   - 'YYYY-MM'（月次情報のログ用）
 * @returns {PayrollResult}
 */
function calcPayrollForEmployee(emp, records, settings, incentives, yearMonth) {

  // ── A. 勤怠集計 ─────────────────────────────────────
  let totalWorkMin    = 0; // 実働合計（分）
  let overtimeMin     = 0; // 時間外合計（分）
  let lateMin         = 0; // 遅刻控除合計（分）
  let earlyLeaveMin   = 0; // 早退控除合計（分）
  let workDays        = 0; // 出勤日数
  let absentDays      = 0; // 欠勤日数
  let holidayWorkDays = 0; // 休日出勤日数
  let lunchCount      = 0; // 弁当注文数

  // 1日の所定労働時間（分）を算出する。
  // scheduled_hours はシートに列がないため null になる場合がある。
  // その場合は scheduled_start / scheduled_end の差から計算し、
  // それも取れなければ設定のデフォルト（overtime_threshold_hours）を使う。
  let scheduledDailyMin;
  if (emp.scheduled_hours != null && emp.scheduled_hours !== '') {
    scheduledDailyMin = Number(emp.scheduled_hours) * 60;
  } else if (emp.scheduled_start && emp.scheduled_end) {
    const [sh, sm] = emp.scheduled_start.split(':').map(Number);
    const [eh, em] = emp.scheduled_end.split(':').map(Number);
    scheduledDailyMin = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
  } else {
    scheduledDailyMin = settings.overtime_threshold_hours * 60;
  }

  records.forEach(rec => {
    const d      = rec.data || {};
    const status = d.status || '';

    // ── 実働時間の計算（1分単位） ──────────────────────────
    //
    // 旧: 15分単位切り捨て → 新: 1分単位（切り捨てなし）
    //
    // 遅刻時の給与開始時刻ルール:
    //   出勤打刻時刻を 5分単位に切り上げ、その時刻から給与が発生する。
    //   例: 10:06打刻 → 10:10から給与発生（4分分を実働から差し引く）
    //   例: 10:00打刻 → そのまま 10:00から給与発生（切り上げなし）
    //   例: 10:05打刻 → そのまま 10:05から給与発生（5分の倍数はそのまま）
    //
    // この処理は time_in が記録されている場合のみ適用する。
    // time_in が空（欠勤・管理者代理入力ミスなど）は rawWorkMin をそのまま使う。
    const rawWorkMin = Number(d.work_minutes) || 0;
    let workMin = rawWorkMin; // デフォルトは丸めなし（1分単位）

    if (d.time_in && status !== '欠勤' && status !== '休日') {
      // time_in を分に変換する（'HH:MM' または ISO文字列に対応）
      const timeInStr = String(d.time_in || '');
      let timeInMin = null;

      if (/^\d{1,2}:\d{2}/.test(timeInStr)) {
        // 'HH:MM' 形式
        const parts = timeInStr.split(':');
        timeInMin = Number(parts[0]) * 60 + Number(parts[1]);
      } else if (timeInStr.includes('T')) {
        // ISO 8601 形式（GASのDate型がJSON化されたもの）
        const d2 = new Date(timeInStr);
        if (!isNaN(d2.getTime())) {
          timeInMin = d2.getHours() * 60 + d2.getMinutes();
        }
      }

      if (timeInMin !== null) {
        // 5分単位の切り上げ: 例 10:06 → 10:10（4分差し引き）
        const roundedUpMin = Math.ceil(timeInMin / 5) * 5;
        const lateDeductMin = roundedUpMin - timeInMin; // 0〜4分
        // 切り上げ分を実働から差し引く（マイナスにはしない）
        workMin = Math.max(0, rawWorkMin - lateDeductMin);
      }
    }

    totalWorkMin += workMin;
    if (d.lunch === true) lunchCount++;

    switch (status) {
      case '出勤':
        workDays++;
        // 残業時間は勤怠レコードから自動計算しない。
        // 残業指示または管理者承認がある場合のみ計上する（後述の approvedOvertimeMin）。
        // ここでは出勤日数のカウントのみ行う。
        break;
      case '遅刻':
        workDays++;
        // 遅刻は所定始業〜実際の出勤時刻の差分が控除対象。
        // 現状は勤怠データに「遅刻分数」が含まれていないため、
        // 実働時間が所定労働時間より少ない分を遅刻控除とみなす。
        if (workMin < scheduledDailyMin) {
          lateMin += scheduledDailyMin - workMin;
        }
        break;
      case '早退':
        workDays++;
        if (workMin < scheduledDailyMin) {
          earlyLeaveMin += scheduledDailyMin - workMin;
        }
        break;
      case '欠勤':
        absentDays++;
        break;
      case '休日':
        // 休日出勤扱い（打刻があれば）
        if (workMin > 0) {
          holidayWorkDays++;
          totalWorkMin += workMin;
        }
        break;
      default:
        Logger.log('[calcPayrollForEmployee] 未定義ステータス: %s', status);
    }
  });

  // ── 承認済み残業の集計 ─────────────────────────────────
  //
  // 残業時間は「残業指示」または「残業申請の管理者承認」がある分のみ給与計算に含める。
  // 勤怠レコードの実働時間が所定を超えていても、指示・承認がなければ残業代は発生しない。
  //
  // rec.data.approved_overtime_minutes: GAS の rowToAttendanceRecord が
  // 残業指示シートと突合して付与する値（分）。
  // 現状のシート構成ではこの値が存在しない場合は 0 として扱い、残業代は発生しない。
  let approvedOvertimeMin = 0;
  records.forEach(rec => {
    const d = rec.data || {};
    // approved_overtime_minutes が記録されている場合のみ加算する
    if (d.approved_overtime_minutes && Number(d.approved_overtime_minutes) > 0) {
      approvedOvertimeMin += Number(d.approved_overtime_minutes);
    }
  });
  // records.forEach 内で集計した overtimeMin は使わない（0のまま）
  // 以降は approvedOvertimeMin を残業時間として使う
  overtimeMin = approvedOvertimeMin;

  // 分→時間変換。浮動小数点誤差を排除するため小数点3桁で丸める。
  // 1分単位データなので任意の分数値になる。
  const totalWorkHours  = Math.round(totalWorkMin  / 60 * 1000) / 1000;
  const overtimeHours   = Math.round(overtimeMin   / 60 * 1000) / 1000;
  const lateHours       = Math.round(lateMin       / 60 * 1000) / 1000;
  const earlyLeaveHours = Math.round(earlyLeaveMin / 60 * 1000) / 1000;

  // ── B. 基本給計算 ────────────────────────────────────
  let basicWage = 0;

  if (emp.wage_type === '時給') {
    // 時給 × 実働時間
    const hourlyWage = Number(emp.hourly_wage) || 0;
    basicWage = Math.floor(hourlyWage * totalWorkHours);

  } else if (emp.wage_type === '月給') {
    // 月給の場合は欠勤・遅刻・早退を日割り控除する。
    // 日割り単価 = 月給 ÷ 月の所定労働日数
    const monthlyWage      = Number(emp.monthly_wage) || 0;
    const scheduledWorkDays = calcScheduledWorkDays(emp, yearMonth);
    const dailyWage        = scheduledWorkDays > 0
      ? monthlyWage / scheduledWorkDays
      : monthlyWage;
    const hourlyWageForDeduction = dailyWage / (scheduledDailyMin / 60);

    const absentDeduction   = Math.floor(dailyWage * absentDays);
    const lateDeduction     = Math.floor(hourlyWageForDeduction * lateHours);
    const earlyLeaveDeduction = Math.floor(hourlyWageForDeduction * earlyLeaveHours);

    basicWage = Math.max(0, monthlyWage - absentDeduction - lateDeduction - earlyLeaveDeduction);

  } else {
    // 給与形態未設定はスキップ（0円）
    Logger.log('[calcPayrollForEmployee] 給与形態未設定: id=%s', emp.id);
  }

  // ── C. 残業手当 ─────────────────────────────────────
  //
  // 所定労働時間が4時間のため、残業しても法定時間外労働（8時間超）には該当しない。
  // よって割り増しは発生せず、残業時間分は通常時給で計算する（割増率 0%）。
  // また、残業は指示または承認がある分のみ（approvedOvertimeMin）計上済み。
  const hourlyRate  = getHourlyRate(emp, yearMonth);
  const overtimePay = Math.floor(hourlyRate * overtimeHours); // 割り増しなし

  // ── D. 休日出勤手当 ──────────────────────────────────
  const holidayWorkHours = holidayWorkDays * (scheduledDailyMin / 60);
  const holidayPay       = Math.floor(
    hourlyRate * (1 + settings.holiday_rate / 100) * holidayWorkHours
  );

  // ── E. 弁当代控除 ────────────────────────────────────
  const lunchDeduction = (Number(settings.lunch_price) || 0) * lunchCount;

  // ── F. 交通費加算 ────────────────────────────────────
  // 交通費は非課税（月 15 万円まで）が原則のためここで分離する
  const transportFee = Number(emp.transport_fee) || 0;

  // ── G. インセンティブ加算 ─────────────────────────────
  const incentiveTotal = incentives.reduce((sum, inc) => sum + (Number(inc.amount) || 0), 0);
  const incentiveItems = incentives.map(inc => ({
    label  : inc.label  || 'インセンティブ',
    amount : Number(inc.amount) || 0,
    note   : inc.note   || '',
  }));

  // ── H. 総支給額（税引き前）──────────────────────────
  // 非課税の交通費は社会保険・所得税の計算対象外
  const taxableGross  = basicWage + overtimePay + holidayPay + incentiveTotal;
  const totalGross    = taxableGross + transportFee;

  // ── I. 社会保険料 ────────────────────────────────────
  // 標準報酬月額は taxableGross を使う（交通費は含めない）。
  // 標準報酬月額は実際には等級テーブルで決まるが、
  // ここでは簡易的に taxableGross を直接使う。
  //
  // スタッフ個別の保険フラグ（ins_health / ins_care / ins_pension / ins_employment）で
  // 加入・未加入を切り替える。フラグが false の場合は本人・会社ともに 0 円。

  // ── 本人負担 ──
  const healthInsurance = emp.ins_health
    ? calcInsurance(taxableGross, settings.health_insurance_rate)
    : 0;
  const careInsurance = emp.ins_care
    ? calcInsurance(taxableGross, settings.care_insurance_rate)
    : 0;
  const pension = emp.ins_pension
    ? calcInsurance(taxableGross, settings.pension_rate)
    : 0;
  const empInsurance = emp.ins_employment
    ? calcInsurance(taxableGross, settings.employment_insurance_rate)
    : 0;
  const socialInsuranceTotal = healthInsurance + careInsurance + pension + empInsurance;

  // ── 会社負担 ──
  // 健康保険・介護保険・厚生年金は労使折半のため本人と同率。
  // 雇用保険は会社が「雇用保険二事業」分を追加負担するため本人と異なる。
  // 本人と同じ加入フラグで on/off する（加入していない保険は会社負担も 0 円）。
  const healthInsuranceCompany = emp.ins_health
    ? calcInsurance(taxableGross, settings.health_insurance_rate_company ?? settings.health_insurance_rate)
    : 0;
  const careInsuranceCompany = emp.ins_care
    ? calcInsurance(taxableGross, settings.care_insurance_rate_company ?? settings.care_insurance_rate)
    : 0;
  const pensionCompany = emp.ins_pension
    ? calcInsurance(taxableGross, settings.pension_rate_company ?? settings.pension_rate)
    : 0;
  // 雇用保険の会社負担率が未設定の場合は本人負担率 + 0.35%（二事業分）でフォールバック
  const empInsuranceCompanyRate = settings.employment_insurance_rate_company
    ?? (settings.employment_insurance_rate + 0.35);
  const empInsuranceCompany = emp.ins_employment
    ? calcInsurance(taxableGross, empInsuranceCompanyRate)
    : 0;
  const socialInsuranceTotalCompany =
    healthInsuranceCompany + careInsuranceCompany + pensionCompany + empInsuranceCompany;

  // ── J. 所得税（源泉徴収・簡易計算）──────────────────
  // 正確には国税庁の税額表（甲欄）を参照するが、
  // ここでは「課税対象額 - 社会保険料」に対して簡易的な累進税率を適用する。
  // ※ 年末調整で精算される前提。
  const taxableIncome = Math.max(0, taxableGross - socialInsuranceTotal);
  const incomeTax     = calcIncomeTax(taxableIncome);

  // ── K. 差引支給額 ────────────────────────────────────
  const netPay = Math.max(
    0,
    totalGross - socialInsuranceTotal - incomeTax - lunchDeduction
  );

  return {
    employee_id : emp.id,
    name        : emp.name,
    employment  : emp.employment_type || '',
    wage_type   : emp.wage_type       || '',
    year_month  : yearMonth,

    // 勤怠サマリー
    work_days        : workDays,
    absent_days      : absentDays,
    holiday_work_days: holidayWorkDays,
    // 時間表示は小数点3桁（15分単位なら 0.25 刻みなので実質 .00/.25/.50/.75 のみ）
    total_work_hours : Math.round(totalWorkHours  * 1000) / 1000,
    overtime_hours   : Math.round(overtimeHours   * 1000) / 1000,
    late_hours       : Math.round(lateHours       * 1000) / 1000,
    early_leave_hours: Math.round(earlyLeaveHours * 1000) / 1000,
    lunch_count      : lunchCount,

    // 支給内訳
    basic_wage       : basicWage,
    overtime_pay     : overtimePay,
    holiday_pay      : holidayPay,
    transport_fee    : transportFee,
    incentive_total  : incentiveTotal,
    incentive_items  : incentiveItems,
    taxable_gross    : taxableGross,
    total_gross      : totalGross,

    // 控除内訳（本人負担）
    health_insurance      : healthInsurance,
    care_insurance        : careInsurance,
    pension               : pension,
    employment_insurance  : empInsurance,
    social_insurance_total: socialInsuranceTotal,
    income_tax            : incomeTax,
    lunch_deduction       : lunchDeduction,

    // 会社負担内訳
    // 給与明細・シートの両方で本人・会社を並べて確認できるようにする。
    health_insurance_company      : healthInsuranceCompany,
    care_insurance_company        : careInsuranceCompany,
    pension_company               : pensionCompany,
    employment_insurance_company  : empInsuranceCompany,
    social_insurance_total_company: socialInsuranceTotalCompany,

    // 差引支給額
    net_pay : netPay,
  };
}

// ============================================================
// 給与計算サブ関数（純粋関数）
// ============================================================

/**
 * 時給換算単価を返す。
 * - 時給スタッフ → hourly_wage をそのまま返す
 * - 月給スタッフ → 月給 ÷ 月の所定労働時間で算出する
 *
 * @param {Object} emp
 * @param {string} yearMonth
 * @returns {number} 円/時
 */
function getHourlyRate(emp, yearMonth) {
  if (emp.wage_type === '時給') {
    return Number(emp.hourly_wage) || 0;
  }
  if (emp.wage_type === '月給') {
    const scheduledWorkDays = calcScheduledWorkDays(emp, yearMonth);
    const dailyHours        = (emp.scheduled_hours || 8);
    const monthlyHours      = scheduledWorkDays * dailyHours;
    return monthlyHours > 0 ? (Number(emp.monthly_wage) || 0) / monthlyHours : 0;
  }
  return 0;
}

/**
 * 指定月の所定労働日数を計算する。
 * emp.work_days（勤務曜日）が設定されている場合はその曜日だけを数える。
 * 未設定の場合は平日（月〜金）を所定労働日とみなす。
 *
 * @param {Object} emp
 * @param {string} yearMonth - 'YYYY-MM'
 * @returns {number}
 */
function calcScheduledWorkDays(emp, yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const daysInMonth   = new Date(year, month, 0).getDate();

  // 曜日名 → getDay() の戻り値（0=日, 1=月, ...）
  const DOW_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

  // 勤務曜日が設定されている場合はそれを使い、未設定なら月〜金とする
  const workDowNums = emp.work_days && emp.work_days.length > 0
    ? emp.work_days.map(d => DOW_MAP[d]).filter(n => n !== undefined)
    : [1, 2, 3, 4, 5]; // 月〜金

  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (workDowNums.includes(dow)) count++;
  }
  return count;
}

/**
 * 社会保険料を計算する（円未満切り捨て）。
 *
 * @param {number} gross - 標準報酬月額（円）
 * @param {number} rate  - 本人負担率（%表記）
 * @returns {number}
 */
function calcInsurance(gross, rate) {
  return Math.floor(gross * (rate / 100));
}

/**
 * 月次源泉徴収税額を簡易計算する（甲欄・扶養なし）。
 *
 * 国税庁の税額表に完全準拠するには月額の等級テーブルが必要だが、
 * ここでは年収換算 → 年税額 → 1/12 の簡易方式を採用する。
 * ※ 年末調整で精算される前提。
 *
 * 簡易税率表（2024年度 速算表 課税所得額基準）:
 *   195万以下       → 5%
 *   195万〜330万    → 10%（控除 97,500）
 *   330万〜695万    → 20%（控除 427,500）
 *   695万〜900万    → 23%（控除 636,000）
 *   900万〜1,800万  → 33%（控除 1,536,000）
 *   1,800万〜4,000万→ 40%（控除 2,796,000）
 *   4,000万超       → 45%（控除 4,796,000）
 *
 * @param {number} monthlyTaxableIncome - 課税月収（社保控除後）
 * @returns {number} 月次源泉徴収税額（円）
 */
function calcIncomeTax(monthlyTaxableIncome) {
  // 年収換算（簡易）
  const annualIncome = monthlyTaxableIncome * 12;

  let annualTax = 0;
  if      (annualIncome <= 1950000)  annualTax = annualIncome * 0.05;
  else if (annualIncome <= 3300000)  annualTax = annualIncome * 0.10 - 97500;
  else if (annualIncome <= 6950000)  annualTax = annualIncome * 0.20 - 427500;
  else if (annualIncome <= 9000000)  annualTax = annualIncome * 0.23 - 636000;
  else if (annualIncome <= 18000000) annualTax = annualIncome * 0.33 - 1536000;
  else if (annualIncome <= 40000000) annualTax = annualIncome * 0.40 - 2796000;
  else                               annualTax = annualIncome * 0.45 - 4796000;

  // 復興特別所得税 2.1% を加算（2037年まで）
  annualTax = annualTax * 1.021;

  // 月次 → 円未満切り捨て（源泉徴収は切り捨てが原則）
  return Math.max(0, Math.floor(annualTax / 12));
}

// ============================================================
// 給与設定の保存・読み込み
// ============================================================

/**
 * 給与設定をシートに保存する。
 *
 * 設定シートの構造:
 *   A列: 設定キー（英字）
 *   B列: 設定値
 *   C列: 更新日時
 *
 * キーが存在すれば上書き、なければ末尾に追加する（upsert）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} settings - キー/値のオブジェクト
 * @returns {{ saved: boolean }}
 */
function savePayrollSettings(ss, settings) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('settings は Object で指定してください。');
  }

  const sheet = getOrCreatePayrollSheet(ss, PAYROLL_SHEET.SETTINGS, ['key', 'value', 'updated_at']);
  const rows  = sheet.getDataRange().getValues();
  const now   = new Date().toISOString();

  Object.entries(settings).forEach(([key, value]) => {
    // 既存行を探す（ヘッダーを除く 2行目以降）
    const rowIndex = rows.findIndex((row, i) => i > 0 && String(row[0]) === key);

    if (rowIndex !== -1) {
      // 上書き
      sheet.getRange(rowIndex + 1, 2, 1, 2).setValues([[value, now]]);
    } else {
      // 新規追加
      sheet.appendRow([key, value, now]);
      rows.push([key, value, now]); // ループ内の検索用にメモリ上も更新する
    }
  });

  SpreadsheetApp.flush();
  Logger.log('[savePayrollSettings] %d件保存', Object.keys(settings).length);

  return { saved: true };
}

/**
 * 給与設定を読み込む。
 * 未設定の項目は DEFAULT_PAYROLL_SETTINGS で補完する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {{ settings: Object }}
 */
function loadPayrollSettings(ss) {
  const sheet = ss.getSheetByName(PAYROLL_SHEET.SETTINGS);

  // シートが存在しない場合はデフォルト値をそのまま返す
  if (!sheet || sheet.getLastRow() <= 1) {
    Logger.log('[loadPayrollSettings] 設定シートなし。デフォルト値を使用。');
    return { settings: { ...DEFAULT_PAYROLL_SETTINGS } };
  }

  const rows = sheet.getDataRange().getValues();

  // シートの値でデフォルトを上書きする
  const settings = { ...DEFAULT_PAYROLL_SETTINGS };
  rows.slice(1).forEach(row => { // ヘッダーをスキップ
    const key   = String(row[0] || '').trim();
    const value = row[1];
    if (key && key in settings) {
      // 数値型の設定は数値に変換する
      settings[key] = typeof settings[key] === 'number' ? Number(value) : value;
    }
  });

  Logger.log('[loadPayrollSettings] 設定読み込み完了');
  return { settings };
}

// ============================================================
// インセンティブの保存・読み込み
// ============================================================

/**
 * インセンティブ（個人ボーナス）を登録する。
 *
 * フロントから受け取る data の構造:
 *   {
 *     year_month  : 'YYYY-MM',
 *     employee_id : string,
 *     label       : string,   // インセンティブ名（例: '販売奨励金'）
 *     amount      : number,   // 金額（円）
 *     note        : string,   // 備考
 *   }
 *
 * インセンティブシートの列構成:
 *   A: id, B: year_month, C: employee_id, D: label, E: amount, F: note, G: created_at
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} data
 * @returns {{ id: string, saved: boolean }}
 */
function savePayrollIncentive(ss, data) {
  const { year_month, employee_id, label, amount, note } = data;

  if (!year_month)  throw new Error('year_month は必須です。');
  if (!employee_id) throw new Error('employee_id は必須です。');
  if (!label)       throw new Error('label は必須です。');
  if (amount == null || isNaN(Number(amount))) {
    throw new Error('amount は数値で指定してください。');
  }

  const sheet = getOrCreatePayrollSheet(ss, PAYROLL_SHEET.INCENTIVES, [
    'id', 'year_month', 'employee_id', 'label', 'amount', 'note', 'created_at'
  ]);

  const id  = generateId();
  const now = new Date().toISOString();

  sheet.appendRow([id, year_month, employee_id, label, Number(amount), note || '', now]);
  SpreadsheetApp.flush();

  Logger.log('[savePayrollIncentive] id=%s, emp=%s, amount=%d', id, employee_id, amount);

  return { id, saved: true };
}

/**
 * インセンティブ一覧を読み込む。
 * year_month・employee_id の両方またはいずれかで絞り込める。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string|null} yearMonth   - 'YYYY-MM'（null なら全件）
 * @param {string|null} employeeId  - ID（null なら全件）
 * @returns {{ incentives: Object[] }}
 */
function loadPayrollIncentives(ss, yearMonth, employeeId) {
  const sheet = ss.getSheetByName(PAYROLL_SHEET.INCENTIVES);
  if (!sheet || sheet.getLastRow() <= 1) {
    return { incentives: [] };
  }

  const rows = sheet.getDataRange().getValues();
  const incentives = rows
    .slice(1) // ヘッダーをスキップ
    .filter(row => {
      const rowYm  = String(row[1] || '');
      const rowEmp = String(row[2] || '');
      const matchYm  = !yearMonth  || rowYm  === yearMonth;
      const matchEmp = !employeeId || rowEmp === employeeId;
      return matchYm && matchEmp;
    })
    .map(row => ({
      id          : String(row[0]),
      year_month  : String(row[1]),
      employee_id : String(row[2]),
      label       : String(row[3]),
      amount      : Number(row[4]) || 0,
      note        : String(row[5] || ''),
      created_at  : String(row[6] || ''),
    }));

  Logger.log('[loadPayrollIncentives] count=%d', incentives.length);
  return { incentives };
}

// ============================================================
// 給与計算結果の保存
// ============================================================

/**
 * 月次給与計算結果をシートに保存する（上書き）。
 *
 * 給与計算結果シートの列構成:
 *   A: year_month, B: employee_id, C: 氏名, D: 雇用形態,
 *   E: 出勤日数, F: 実働時間, G: 残業時間,
 *   H: 基本給, I: 残業手当, J: 休日手当,
 *   K: 交通費, L: インセンティブ, M: 総支給額,
 *   ── 本人控除 ──
 *   N: 健康保険(本人), O: 介護保険(本人), P: 厚生年金(本人), Q: 雇用保険(本人),
 *   R: 社会保険料計(本人), S: 所得税, T: 弁当代控除,
 *   ── 会社負担 ──
 *   U: 健康保険(会社), V: 介護保険(会社), W: 厚生年金(会社), X: 雇用保険(会社),
 *   Y: 社会保険料計(会社),
 *   ── 集計 ──
 *   Z: 差引支給額, AA: 計算日時
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string}   yearMonth
 * @param {Object[]} payroll
 */
function savePayrollResults(ss, yearMonth, payroll) {
  const headers = [
    'year_month', 'employee_id', '氏名', '雇用形態',
    '出勤日数', '実働時間', '残業時間',
    '基本給', '残業手当', '休日手当',
    '交通費', 'インセンティブ', '総支給額',
    // 本人控除
    '健康保険(本人)', '介護保険(本人)', '厚生年金(本人)', '雇用保険(本人)',
    '社会保険料計(本人)', '所得税', '弁当代控除',
    // 会社負担
    '健康保険(会社)', '介護保険(会社)', '厚生年金(会社)', '雇用保険(会社)',
    '社会保険料計(会社)',
    // 集計
    '差引支給額', '計算日時',
  ];

  const sheet = getOrCreatePayrollSheet(ss, PAYROLL_SHEET.RESULTS, headers);
  const now   = new Date().toISOString();

  // 同じ年月のデータをいったん削除してから書き直す（べき等性を保つ）
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const existingData = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = existingData.length - 1; i >= 0; i--) {
      if (String(existingData[i][0]) === yearMonth) {
        sheet.deleteRow(i + 2);
      }
    }
  }

  if (payroll.length === 0) return;

  const rows = payroll.map(p => [
    yearMonth,
    p.employee_id,
    p.name,
    p.employment,
    p.work_days,
    p.total_work_hours,
    p.overtime_hours,
    p.basic_wage,
    p.overtime_pay,
    p.holiday_pay,
    p.transport_fee,
    p.incentive_total,
    p.total_gross,
    // 本人控除
    p.health_insurance,
    p.care_insurance,
    p.pension,
    p.employment_insurance,
    p.social_insurance_total,
    p.income_tax,
    p.lunch_deduction,
    // 会社負担（未加入保険は 0 円）
    p.health_insurance_company,
    p.care_insurance_company,
    p.pension_company,
    p.employment_insurance_company,
    p.social_insurance_total_company,
    // 集計
    p.net_pay,
    now,
  ]);

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();

  Logger.log('[savePayrollResults] yearMonth=%s, %d行保存', yearMonth, rows.length);
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * 給与計算用シートを取得する（存在しない場合は作成してヘッダーを書く）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string}   sheetName
 * @param {string[]} headers
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreatePayrollSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    // ヘッダー行を固定して見やすくする
    sheet.setFrozenRows(1);
    Logger.log('[getOrCreatePayrollSheet] 新規作成: %s', sheetName);
  }
  return sheet;
}