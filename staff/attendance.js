/**
 * 打刻（出勤・退勤）パネルの表示とイベント処理を担う。
 *
 * 依存:
 *   common/api.js, common/ui.js（showLoading/hideLoading/showToast）
 *   staff/staff.js（state, api(), GAS_URL などのグローバル）
 *   staff/utils.js（todayString, nowHHMM, esc）
 *
 * 注意:
 *   type="module" ではない通常の <script> として読み込む前提。
 *   トップレベルの const/function は他の staff/*.js からも参照できる
 *   （ブラウザのクラシックスクリプトは同一グローバルスコープを共有する）。
 */
'use strict';

// ============================================================
// 打刻
// ============================================================

/**
 * 今日の打刻レコードを取得して state と UI に反映する。
 */
async function loadTodayRecord() {
  const today  = todayString();
  const result = await api('load', { employee_id: state.userId, date: today });
  if (!result.success || !result.data.record) return;

  const rec = result.data.record;
  const d   = rec.data || {};

  state.checkedIn    = !!d.time_in;
  state.checkedOut   = !!d.time_out;
  state.checkinTime  = d.time_in  || '';
  state.checkoutTime = d.time_out || '';
  state.lunchValue   = d.lunch ? '有' : '無';
  if (d.lunch !== undefined) state.lunch = d.lunch;

  renderClockPanel();
}

/**
 * 弁当を選択する。
 * @param {boolean} value
 */
function selectLunch(value) {
  state.lunch = value;
  document.getElementById('lunch-yes').classList.toggle('selected',  value === true);
  document.getElementById('lunch-no' ).classList.toggle('selected',  value === false);
  // :has() 未対応ブラウザのフォールバック: 選択完了したら明示的にpulseを止める
  document.querySelector('.lunch-row').classList.add('has-selection');
  updateCheckinBtn();
}

/** 出勤ボタンを有効/無効を更新 */
function updateCheckinBtn() {
  document.getElementById('btn-checkin').disabled = (state.lunch === null);
}

/** 退勤ボタンの有効/無効を更新 */
function updateCheckoutBtn() {
  const ready = state.report.trim() !== '' && state.breakMinutes !== null;
  document.getElementById('btn-checkout').disabled = !ready;
}

/**
 * 出勤打刻処理。
 * 弁当選択が済んでいなければ打てない（ボタン disabled で制御済み）。
 */
async function handleCheckin() {
  if (state.lunch === null) {
    showToast('弁当の選択をしてください。', 'warning');
    return;
  }

  const btn  = document.getElementById('btn-checkin');
  btn.disabled = true;
  showLoading('出勤打刻中...');

  const now    = nowHHMM();
  const result = await api('save', {
    employee_id     : state.userId,
    date            : todayString(),
    attendance_data : {
      status  : '出勤',
      time_in : now,
      lunch   : state.lunch,
    },
  });

  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '打刻に失敗しました。', 'error');
    btn.disabled = false;
    return;
  }

  state.checkedIn   = true;
  state.checkinTime = now;
  state.lunchValue  = state.lunch ? '有' : '無';

  // 日報が新規プラットフォームに移行後は save_daily_report を呼ぶ予定
  // 現フェーズでは save（出退勤記録）のみ

  showToast('出勤しました！', 'success');
  renderClockPanel();
}

/**
 * 退勤打刻処理。
 * 日報と休憩時間が必須（ボタン disabled で制御済み）。
 */
async function handleCheckout() {
  if (!state.report.trim()) {
    showToast('日報を入力してください。', 'warning');
    return;
  }
  if (state.breakMinutes === null) {
    showToast('休憩時間を選択してください。', 'warning');
    return;
  }

  const btn = document.getElementById('btn-checkout');
  btn.disabled = true;
  showLoading('退勤打刻中...');

  const now  = nowHHMM();

  // 出退勤記録を保存
  const result = await api('save', {
    employee_id     : state.userId,
    date            : todayString(),
    attendance_data : {
      status       : '出勤',
      time_in      : state.checkinTime,
      time_out     : now,
      lunch        : state.lunchValue === '有',
      break_minutes: state.breakMinutes,
      memo         : state.report,
    },
  });

  if (!result.success) {
    hideLoading();
    showToast(result.error_message || '退勤打刻に失敗しました。', 'error');
    btn.disabled = false;
    return;
  }

  // 日報を daily_reports に保存（save_daily_report）
  await api('save_daily_report', {
    user_id  : state.userId,
    comment  : state.report,
    handover : state.handover,
  });

  hideLoading();

  state.checkedOut   = true;
  state.checkoutTime = now;

  showToast('退勤しました。お疲れさまでした！', 'success');
  renderClockPanel();
}

/**
 * 打刻パネルを state に合わせて描画する。
 */
function renderClockPanel() {
  const blockBefore = document.getElementById('block-before-checkin');
  const blockAfter  = document.getElementById('block-after-checkin');
  const blockDone   = document.getElementById('block-done');

  // チップ更新
  const chipIn  = document.getElementById('chip-checkin');
  const chipOut = document.getElementById('chip-checkout');
  const chipLun = document.getElementById('chip-lunch');

  document.getElementById('chip-checkin-val').textContent  = state.checkinTime  || '-';
  document.getElementById('chip-checkout-val').textContent = state.checkoutTime || '-';
  document.getElementById('chip-lunch-val').textContent    = state.lunchValue   || '-';

  chipIn.className  = 'status-chip' + (state.checkedIn  ? ' done' : '');
  chipOut.className = 'status-chip' + (state.checkedOut ? ' done' : '');
  chipLun.className = 'status-chip' + (state.lunchValue ? ' done' : '');

  if (state.checkedOut) {
    // 退勤済み
    blockBefore.style.display = 'none';
    blockAfter .style.display = 'none';
    blockDone  .style.display = 'block';
    document.getElementById('done-times').textContent =
      `出勤 ${state.checkinTime} → 退勤 ${state.checkoutTime}`;

  } else if (state.checkedIn) {
    // 出勤済み・退勤前
    blockBefore.style.display = 'none';
    blockAfter .style.display = 'block';
    blockDone  .style.display = 'none';
    // 弁当が確定済みなら既存値を反映
    if (state.lunchValue) {
      document.getElementById('lunch-yes').classList.toggle('selected', state.lunchValue === '有');
      document.getElementById('lunch-no' ).classList.toggle('selected', state.lunchValue === '無');
    }

  } else {
    // 未出勤
    blockBefore.style.display = 'block';
    blockAfter .style.display = 'none';
    blockDone  .style.display = 'none';
    updateCheckinBtn();
  }
}
