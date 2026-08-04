/**
 * dashboard.js — Notion埋め込み用ダッシュボードのロジック。
 *
 * 認証・セッション管理は staff.js（staff/staff.js）の実装パターンを
 * そのまま踏襲する。kintai_authenticate で全ロール共通に認証し、
 * セッションは localStorage に保存する。新しい認証方式は作らない。
 * GAS通信は common/api.js の setGasUrl/callGAS を使う。
 *
 * 【要検証】localStorage のセッション共有について:
 *   セッションキーは staff.js と同じ 'sumioka_user_session' を使っている。
 *   同一オリジン（GitHub Pages）の通常タブでこのページを開いた場合、
 *   staff.html で先にログイン済みならそのままログイン状態を引き継げる。
 *   一方、Notionページの埋め込みブロック（iframe）内では、ブラウザによっては
 *   サードパーティコンテキストとして localStorage が分離され、
 *   セッションが共有されないことがある（ブラウザのストレージ分離仕様に依存し、
 *   本実装時点では未確定）。共有されない場合は単に Notion 内で毎回ログインが
 *   必要になるだけで、ダッシュボード自体の機能には問題はない。
 *
 * @version 1.0.0
 */
'use strict';

// ============================================================
// 設定
// ============================================================

/** GAS デプロイ URL（staff.js / user.html / portal.html と同一のバックエンド） */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzr_U7LyysRif0HKFou1pc6x4wGcW2K395JAT0iJr7uFNnX3rRyP8RYawOST-Tjwm2Y8w/exec';
setGasUrl(GAS_URL);

/** 自動再取得の間隔（5分）。Notionページを開きっぱなしでも情報が古くならないようにする。 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;

/** セッションキー。staff.js と同一のキーにして localStorage 共有の可能性を活かす。 */
const SESSION_KEY = 'sumioka_user_session';

let currentUserId = '';
let refreshTimer  = null;

// ============================================================
// セッション（staff.js と同じ実装パターン）
// ============================================================

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.userId ? s : null;
  } catch { return null; }
}

// ============================================================
// 初期化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  ['input-pin', 'input-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') handleLogin();
    });
  });

  // 自動ログイン（保存済みセッション。staff.html 側で既にログイン済みの場合など）
  const session = loadSession();
  if (session) applySession(session);
});

// ============================================================
// 認証
// ============================================================

async function handleLogin() {
  const pin      = document.getElementById('input-pin').value.trim();
  const password = document.getElementById('input-password').value.trim();

  if (!pin || !password) {
    showToast('PIN とパスワードを入力してください。', 'warning');
    return;
  }

  showLoading('認証中...');
  const result = await callGAS('kintai_authenticate', { pin, password });
  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '認証に失敗しました。', 'error');
    return;
  }

  const { employee } = result.data;
  const session = { userId: employee.id, userName: employee.name || '' };

  saveSession(session);
  applySession(session);
}

/**
 * セッションを適用してメイン画面を表示し、ダッシュボードの取得を開始する。
 */
function applySession(session) {
  currentUserId = session.userId;

  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-main').classList.add('active');

  loadDashboard();

  // 二重起動防止のため既存タイマーを必ずクリアしてから再設定する
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadDashboard, AUTO_REFRESH_MS);
}

// ============================================================
// ダッシュボードデータ取得・描画
// ============================================================

/**
 * get_dashboard_summary を取得して画面に反映する。
 * 失敗時は技術的なエラー内容を画面に出さず、穏当なフォールバック表示にする。
 */
async function loadDashboard() {
  const result = await callGAS('get_dashboard_summary', { operator_id: currentUserId });

  if (!result.success) {
    _logFailure(result.error_message, result.error_detail);
    showFallback();
    return;
  }

  renderDashboard(result.data);
}

function showFallback() {
  document.getElementById('dash-content').style.display  = 'none';
  document.getElementById('dash-fallback').style.display = 'block';
}

function renderDashboard(data) {
  document.getElementById('dash-content').style.display  = '';
  document.getElementById('dash-fallback').style.display = 'none';

  const now = new Date();
  document.getElementById('dash-updated').textContent =
    '最終更新: ' + now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  _renderAttendance(data.attendance);
  _renderTasks(data.tasks);
  document.getElementById('stat-pending-requests').textContent = data.requests.pending_count;
}

function _renderAttendance(att) {
  document.getElementById('stat-present').textContent = att.present_count;
  document.getElementById('stat-total').textContent   = att.total_staff_count;
  document.getElementById('stat-missing').textContent = att.missing_clock_count;

  const absentListEl = document.getElementById('absent-list');
  absentListEl.innerHTML = att.absent_staff.length
    ? att.absent_staff.map(s => `<span class="name-chip">${esc(s.name)}</span>`).join('')
    : '<span class="empty-note">未出勤者はいません</span>';
}

const TASK_STATUS_ORDER = ['未着手', '進行中', 'レビュー待ち', '差戻'];

function _renderTasks(tasks) {
  const badgesEl = document.getElementById('task-status-badges');
  badgesEl.innerHTML = TASK_STATUS_ORDER
    .map(s => `<span class="badge">${esc(s)} ${tasks.status_count[s] ?? 0}</span>`)
    .join('');

  document.getElementById('stat-overdue').textContent = tasks.overdue_count;

  const tableWrap = document.getElementById('staff-task-table-wrap');
  if (!tasks.by_staff.length) {
    tableWrap.innerHTML = '<div class="empty-note">タスクを保有している担当者はいません。</div>';
    return;
  }

  const rows = tasks.by_staff.map(s => `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${s.task_count}</td>
      <td>${TASK_STATUS_ORDER.map(st => `${st}:${s.status_breakdown[st] ?? 0}`).join(' / ')}</td>
      <td>${s.overdue_count > 0 ? `<span class="badge badge-warn">${s.overdue_count}件</span>` : '-'}</td>
    </tr>
  `).join('');

  tableWrap.innerHTML = `
    <table class="staff-table">
      <thead><tr><th>担当者</th><th>保有タスク</th><th>内訳</th><th>期限超過</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ============================================================
// ユーティリティ
// ============================================================

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** 失敗理由は開発者向けにコンソールへ残すだけで、画面には出さない。 */
function _logFailure(message, detail) {
  console.warn('[dashboard] get_dashboard_summary failed:', message, detail);
}
