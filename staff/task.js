/**
 * タスク一覧の取得と描画を担う。
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
// タスク
// ============================================================

/**
 * 自分の担当タスクを取得して描画する。
 * get_my_tasks を使い、tasks シートから取得する。
 */
async function loadMyTasks() {
  const result = await api('get_my_tasks', {
    user_id      : state.userId,
    include_done : false,
  });

  if (!result.success) {
    state.tasks = [];
  } else {
    state.tasks = result.data.tasks || [];
  }

  // タスクパネルが表示中なら即描画
  if (state.currentPanel === 'tasks') renderTaskList();

  // ボトムナビのタスク件数バッジは常に更新
  const activeCount = state.tasks.filter(t =>
    t.status !== '完了'
  ).length;
  const navBtn = document.getElementById('nav-tasks');
  if (navBtn && activeCount > 0) {
    navBtn.querySelector('.nav-icon').textContent = `📋`;
  }
}

/**
 * タスク一覧を描画する。
 */
function renderTaskList() {
  const wrap = document.getElementById('task-list-wrap');
  if (!state.tasks.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-text">担当タスクはありません</div>
      </div>`;
    return;
  }

  // ステータス優先順: 差戻 > レビュー待ち > 進行中 > 未着手 > 完了
  const ORDER = { '差戻': 0, 'レビュー待ち': 1, '進行中': 2, '未着手': 3, '完了': 4 };
  const sorted = [...state.tasks].sort((a, b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)
  );

  wrap.innerHTML = `<div class="task-list">${sorted.map(task => taskItemHTML(task)).join('')}</div>`;

  // クリックイベント
  wrap.querySelectorAll('.task-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const task = state.tasks.find(t => t.id === id);
      if (task) openTaskDrawer(task);
    });
  });
}

/**
 * タスクカードのHTML文字列を返す。
 * @param {Object} task
 * @returns {string}
 */
function taskItemHTML(task) {
  const statusClass = {
    '未着手'     : 'status-notstarted',
    '進行中'     : 'status-inprogress',
    'レビュー待ち': 'status-review',
    '完了'       : 'status-done',
    '差戻'       : 'status-rejected',
  }[task.status] || 'status-notstarted';

  const badgeClass = {
    '未着手'     : 'badge-notstarted',
    '進行中'     : 'badge-inprogress',
    'レビュー待ち': 'badge-review',
    '完了'       : 'badge-done',
    '差戻'       : 'badge-rejected',
  }[task.status] || 'badge-notstarted';

  const today    = todayString();
  const isOverdue = task.due_date && task.due_date < today && task.status !== '完了';
  const dueText  = task.due_date
    ? `<span class="task-due ${isOverdue ? 'overdue' : ''}">
        期限: ${task.due_date}${isOverdue ? ' ⚠️' : ''}
       </span>`
    : '';

  const reviewIcon = task.review_required
    ? `<span class="task-review-icon">🔍要レビュー</span>`
    : '';

  return `
    <div class="task-item ${statusClass}" data-id="${esc(task.id)}">
      <div class="task-item-body">
        <div class="task-item-title">${esc(task.title)}</div>
        <div class="task-item-meta">
          <span class="task-status-badge ${badgeClass}">${esc(task.status)}</span>
          ${dueText}
          ${reviewIcon}
        </div>
      </div>
      <div class="task-item-arrow">›</div>
    </div>`;
}
