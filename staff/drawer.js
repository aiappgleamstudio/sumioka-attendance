/**
 * タスク詳細ドロワー（開閉・ステータス変更・コメント）を担う。
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
// タスクドロワー
// ============================================================

/**
 * タスク詳細ドロワーを開く。
 * @param {Object} task
 */
async function openTaskDrawer(task) {
  state.currentTask = task;

  // タイトル・詳細
  document.getElementById('drawer-task-title').textContent = task.title;
  document.getElementById('drawer-task-status').textContent = task.status;

  const descSec = document.getElementById('drawer-desc-section');
  const descEl  = document.getElementById('drawer-task-desc');
  if (task.description) {
    descSec.style.display = '';
    descEl.textContent    = task.description;
  } else {
    descSec.style.display = 'none';
  }

  const condSec = document.getElementById('drawer-cond-section');
  if (task.completion_cond) {
    condSec.style.display = '';
    document.getElementById('drawer-task-cond').textContent = task.completion_cond;
  } else {
    condSec.style.display = 'none';
  }

  const dueSec = document.getElementById('drawer-due-section');
  if (task.due_date) {
    dueSec.style.display = '';
    document.getElementById('drawer-task-due').textContent = task.due_date;
  } else {
    dueSec.style.display = 'none';
  }

  // 差戻理由（最新の rejection を表示）
  const rejectBox = document.getElementById('reject-reason-box');
  rejectBox.style.display = 'none';
  if (task.status === '差戻') {
    // task_histories から差戻理由を取得
    const histResult = await api('get_task_history', {
      task_id     : task.id,
      operator_id : state.userId,
    });
    if (histResult.success) {
      const rejections = histResult.data.history.filter(h => h.change_type === 'rejection');
      if (rejections.length > 0) {
        rejectBox.style.display = '';
        rejectBox.textContent = `⚠️ 差戻理由: ${rejections[0].reason}`;
      }
    }
  }

  // ステータス変更ボタン
  renderStatusButtons(task);

  // コメント履歴
  const commentsResult = await api('get_task_comments', {
    task_id     : task.id,
    operator_id : state.userId,
  });
  if (commentsResult.success && commentsResult.data.comments.length > 0) {
    const cs = commentsResult.data.comments;
    document.getElementById('drawer-comments-section').style.display = '';
    document.getElementById('drawer-comment-list').innerHTML = cs.map(c => `
      <div class="comment-item">
        <div class="comment-item-meta">${esc(c.work_date)} ${esc(c.created_at.slice(0,16).replace('T',' '))}</div>
        <div>${esc(c.content)}</div>
      </div>`).join('');
  } else {
    document.getElementById('drawer-comments-section').style.display = 'none';
  }

  // コメント入力欄クリア
  document.getElementById('drawer-comment').value = '';

  // ドロワーを開く
  document.getElementById('task-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('active');
}

function closeTaskDrawer() {
  document.getElementById('task-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('active');
  state.currentTask = null;
}

/**
 * ステータス変更ボタンを描画する。
 *
 * レビューフロー:
 *   review_required = false → 進行中 / 完了
 *   review_required = true  → 進行中 / レビュー待ち（完了は職員の承認が必要）
 *
 * @param {Object} task
 */
function renderStatusButtons(task) {
  const row    = document.getElementById('status-change-row');
  const status = task.status;
  const rev    = task.review_required;

  let buttons = [];

  if (status !== '進行中' && status !== 'レビュー待ち') {
    buttons.push({ label: '進行中にする', cls: 'btn-inprogress', newStatus: '進行中' });
  }

  if (rev && status !== 'レビュー待ち') {
    buttons.push({ label: 'レビュー申請', cls: 'btn-review', newStatus: 'レビュー待ち' });
  }

  if (!rev && status !== '完了') {
    buttons.push({ label: '完了にする', cls: 'btn-done', newStatus: '完了' });
  }

  if (status === '差戻') {
    buttons.push({ label: '進行中に戻す', cls: 'btn-inprogress', newStatus: '進行中' });
  }

  if (!buttons.length) {
    row.innerHTML = '<span style="font-size:0.8rem;color:#9ca3af">変更できるステータスはありません</span>';
    return;
  }

  row.innerHTML = buttons.map(b => `
    <button class="status-btn ${b.cls}"
      data-status="${esc(b.newStatus)}">
      ${esc(b.label)}
    </button>`).join('');

  row.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', () => handleStatusChange(btn.dataset.status));
  });
}

/**
 * タスクのステータスを変更する。
 * @param {string} newStatus
 */
async function handleStatusChange(newStatus) {
  if (!state.currentTask) return;

  showLoading('更新中...');
  const result = await api('update_task_status', {
    task_id     : state.currentTask.id,
    operator_id : state.userId,
    status      : newStatus,
  });
  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '更新に失敗しました。', 'error');
    return;
  }

  showToast(`「${newStatus}」に変更しました`, 'success');

  // state を更新してUI再描画
  const idx = state.tasks.findIndex(t => t.id === state.currentTask.id);
  if (idx !== -1) {
    state.tasks[idx] = { ...state.tasks[idx], status: newStatus };
    state.currentTask = state.tasks[idx];
  }

  closeTaskDrawer();
  renderTaskList();
}

/**
 * タスクコメントを保存する。
 */
async function handleSaveComment() {
  const content = document.getElementById('drawer-comment').value.trim();
  if (!content) {
    showToast('コメント内容を入力してください。', 'warning');
    return;
  }
  if (!state.currentTask) return;

  showLoading('保存中...');
  const result = await api('add_task_comment', {
    task_id     : state.currentTask.id,
    operator_id : state.userId,
    content,
    work_date   : todayString(),
  });
  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '保存に失敗しました。', 'error');
    return;
  }

  showToast('コメントを保存しました', 'success');
  document.getElementById('drawer-comment').value = '';
}
