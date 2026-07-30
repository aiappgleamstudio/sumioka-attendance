/**
 * 通知一覧の取得・描画・既読処理を担う。
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
// 通知
// ============================================================

async function loadNotifications() {
  const result = await api('get_notifications', {
    recipient_id : state.userId,
    limit        : 30,
  });
  if (!result.success) return;

  state.notifications = result.data.notifications || [];
  const unread = result.data.unread_count || 0;

  // バッジ更新
  const badge = document.getElementById('notif-badge');
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }

  if (state.currentPanel === 'notifications') renderNotifList();
}

function renderNotifList() {
  const list = document.getElementById('notif-list');
  if (!state.notifications.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔔</div>
        <div class="empty-text">通知はありません</div>
      </div>`;
    return;
  }

  const ICONS = {
    new_task       : '📋',
    instruction    : '📌',
    review_request : '🔍',
    revision       : '↩️',
    review_approved: '✅',
    consultation   : '💬',
    overdue        : '⚠️',
    project_status : '📁',
  };

  list.innerHTML = state.notifications.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}">
      <div class="notif-icon">${ICONS[n.type] || '🔔'}</div>
      <div class="notif-body">
        <div class="notif-title">${esc(n.title)}</div>
        <div class="notif-text">${esc(n.body)}</div>
        <div class="notif-time">${esc(n.created_at.slice(0, 16).replace('T', ' '))}</div>
      </div>
    </div>`).join('');
}

async function handleReadAll() {
  showLoading('処理中...');
  const result = await api('mark_all_notifications_read', {
    recipient_id: state.userId,
  });
  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '処理に失敗しました。', 'error');
    return;
  }

  state.notifications = state.notifications.map(n => ({ ...n, is_read: true }));
  document.getElementById('notif-badge').classList.remove('show');
  renderNotifList();
  showToast('すべて既読にしました', 'success');
}
