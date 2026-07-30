/**
 * アプリのエントリポイント。設定・状態管理・GAS通信・セッション・初期化・
 * 認証・データ初期ロード・パネル切替・ライブ時計を担う。
 * 他の staff/*.js は state・api()・GAS_URL などここで定義したものを共有する。
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
// 設定（デプロイURL）
// ============================================================

/**
 * GAS デプロイ URL。
 * 変更が必要な場合はこの1行だけ書き換える。
 */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzr_U7LyysRif0HKFou1pc6x4wGcW2K395JAT0iJr7uFNnX3rRyP8RYawOST-Tjwm2Y8w/exec';

// ============================================================
// 状態管理
// ============================================================

/**
 * アプリの状態をここで一元管理する。
 * 状態が変わるたびに対応する render 関数を呼んで画面を同期する。
 */
const state = {
  // ── 認証 ──
  userId         : '',
  userName       : '',
  employeeType   : '', // '職員' | '利用者'
  adminRole      : '', // '管理者' | '一般職員' | ''
  scheduledEnd   : '',

  // ── 打刻 ──
  lunch          : null,  // true=要 / false=不要 / null=未選択
  checkedIn      : false,
  checkedOut     : false,
  checkinTime    : '',
  checkoutTime   : '',
  lunchValue     : '',    // '有' | '無'
  report         : '',
  handover       : '',
  breakMinutes   : null,

  // ── データ ──
  tasks          : [],    // 自分のタスク一覧
  consultations  : [],    // 相談一覧
  notifications  : [],    // 通知一覧
  staffList      : [],    // 送信先候補（職員・管理者）
  selectedRecipients: [], // 選択済み送信先

  // ── 現在のタスク（ドロワー用）──
  currentTask    : null,

  // ── データロード完了フラグ ──
  dataLoaded     : false,

  // ── 現在のパネル ──
  currentPanel   : 'clock',
};

// ============================================================
// GAS 通信（api.js の callGAS を使う / インライン版フォールバック）
// ============================================================

/**
 * GAS にリクエストを送る。
 * api.js が読み込まれていれば callGAS を使い、
 * なければインライン実装にフォールバックする。
 */
async function api(action, data = {}) {
  const payload = { app: 'attendance', action, data };
  try {
    const ctrl     = new AbortController();
    const timer    = setTimeout(() => ctrl.abort(), 15000);
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.success) return { success: false, error_message: json.error_message, error_detail: json.error_detail };
    return { success: true, data: json.data };
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error_message: 'タイムアウトしました。再度お試しください。' };
    return { success: false, error_message: err.message || '通信エラーが発生しました。' };
  }
}

// ============================================================
// セッション（localStorage）
// ============================================================

const SESSION_KEY = 'sumioka_user_session';

function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    userId       : state.userId,
    userName     : state.userName,
    employeeType : state.employeeType,
    adminRole    : state.adminRole,
    scheduledEnd : state.scheduledEnd,
  }));
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.userId ? s : null;
  } catch { return null; }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ============================================================
// 初期化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // ライブ時計を起動
  startLiveClock();

  // イベントを設定
  bindEvents();

  // 自動ログイン（保存済みセッション）
  const session = loadSession();
  if (session) {
    applySession(session);
    loadInitialData();
  }
});

function bindEvents() {
  // ログイン
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  ['input-pin', 'input-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') handleLogin();
    });
  });

  // ログアウト
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // 退勤フォーム（リアルタイムバリデーション）
  document.getElementById('input-report').addEventListener('input', e => {
    state.report = e.target.value.trim();
    updateCheckoutBtn();
  });
  document.getElementById('input-handover').addEventListener('input', e => {
    state.handover = e.target.value.trim();
  });
  document.getElementById('select-break').addEventListener('change', e => {
    const v = e.target.value;
    state.breakMinutes = v === '' ? null : Number(v);
    updateCheckoutBtn();
  });

  // 打刻
  document.getElementById('btn-checkin').addEventListener('click', handleCheckin);
  document.getElementById('btn-checkout').addEventListener('click', handleCheckout);

  // 相談送信
  document.getElementById('btn-send-consult').addEventListener('click', handleSendConsult);

  // 全既読
  document.getElementById('btn-read-all').addEventListener('click', handleReadAll);

  // タスクコメント保存
  document.getElementById('btn-comment-save').addEventListener('click', handleSaveComment);
}

// ============================================================
// 認証
// ============================================================

/**
 * ログイン処理。
 * kintai_authenticate を使い、全ロール（利用者・職員・管理者）を許可。
 * ログイン後はロールに応じてヘッダーの「管理画面」リンクを表示/非表示。
 */
async function handleLogin() {
  const pin      = document.getElementById('input-pin').value.trim();
  const password = document.getElementById('input-password').value.trim();

  if (!pin || !password) {
    showToast('PIN とパスワードを入力してください。', 'warning');
    return;
  }

  showLoading('認証中...');
  const result = await api('kintai_authenticate', { pin, password });
  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '認証に失敗しました。', 'error');
    return;
  }

  const { employee } = result.data;
  const session = {
    userId       : employee.id,
    userName     : employee.name,
    employeeType : employee.employment_type || '',
    adminRole    : employee.admin_role      || '',
    scheduledEnd : employee.scheduled_end   || '',
  };

  saveSession(session);
  applySession(session);
  await loadInitialData();
}

/**
 * セッション情報を state に適用し、メイン画面を表示する。
 *
 * ロールによる表示切替:
 *   管理者・一般職員 → ヘッダーに「管理画面」リンクを表示
 *   利用者           → リンクを非表示
 */
function applySession(session) {
  state.userId       = session.userId;
  state.userName     = session.userName;
  state.employeeType = session.employeeType || '';
  state.adminRole    = session.adminRole    || '';
  state.scheduledEnd = session.scheduledEnd || '';

  // ヘッダー表示
  document.getElementById('header-username').textContent = state.userName;

  // 職員・管理者のみ管理画面リンクを表示
  const adminLink = document.getElementById('admin-link');
  const isStaff   = state.employeeType === '職員' && state.adminRole !== '';
  adminLink.classList.toggle('show', isStaff);

  // 画面切替
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-main').classList.add('active');
}

function handleLogout() {
  clearSession();
  location.reload();
}

// ============================================================
// データ初期ロード
// ============================================================

/**
 * ログイン後に必要なデータをまとめて取得する。
 * 直列ではなく並列で取得してUXを向上させる。
 */
async function loadInitialData() {
  state.dataLoaded = false;

  // 並列取得
  await Promise.all([
    loadTodayRecord(),
    loadMyTasks(),
    loadNotifications(),
    loadStaffList(),
  ]);

  state.dataLoaded = true;
}

// ============================================================
// パネル切替
// ============================================================

/**
 * ボトムナビのパネルを切り替える。
 * 初回表示時はデータをロードする。
 * @param {string} name - 'clock' | 'tasks' | 'consult' | 'notifications'
 */
function switchPanel(name) {
  // パネルの表示切替
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const panel   = document.getElementById(`panel-${name}`);
  const navBtn  = document.getElementById(`nav-${name}`);
  if (panel)  panel.classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  state.currentPanel = name;

  // 初回またはパネル切替時にデータ更新
  if (name === 'tasks')         { loadMyTasks();       }
  if (name === 'consult')       { loadConsultations();  }
  if (name === 'notifications') { loadNotifications(); }
}

// ============================================================
// ライブ時計
// ============================================================

function startLiveClock() {
  const tick = () => {
    const now = new Date();
    const hh  = String(now.getHours()).padStart(2, '0');
    const mm  = String(now.getMinutes()).padStart(2, '0');
    const ss  = String(now.getSeconds()).padStart(2, '0');
    const el  = document.getElementById('live-clock');
    if (el) el.textContent = `${hh}:${mm}:${ss}`;

    const dateEl = document.getElementById('live-date');
    if (dateEl && !dateEl.textContent) {
      const DAYS = ['日','月','火','水','木','金','土'];
      dateEl.textContent = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日（${DAYS[now.getDay()]}）`;
    }
  };
  tick();
  setInterval(tick, 1000);
}

// showLoading / hideLoading / showToast は ui.js のグローバル関数に統一した
// （2026-07-29）。同名関数のためこのファイル内の呼び出し箇所の変更は不要。
// このファイルに同名関数を再定義しないこと（ui.js 側が上書きされてしまう）。
