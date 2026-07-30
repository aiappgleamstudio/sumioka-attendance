/**
 * 相談（送信・履歴表示）を担う。
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
// 相談
// ============================================================

/**
 * 送信先候補（職員・管理者）を取得してリストに描画する。
 * load_employees から employment_type=職員 を取得する。
 */
async function loadStaffList() {
  const result = await api('load_employees', {});
  // API失敗時も早期returnせず、空配列として描画する
  // （returnすると recipient-list が初期コメントのまま空白になり、
  //  ユーザーが「壊れている」と誤解するバグを防ぐ）
  if (!result.success) {
    state.staffList = [];
    renderRecipientList();
    return;
  }

  state.staffList = (result.data.employees || []).filter(e =>
    e.employment_type === '職員' && !e.deleted && e.id !== state.userId
  );

  renderRecipientList();
}

function renderRecipientList() {
  const list = document.getElementById('recipient-list');
  if (!state.staffList.length) {
    list.innerHTML = '<div style="font-size:0.82rem;color:#9ca3af">送信先が見つかりません</div>';
    return;
  }

  list.innerHTML = state.staffList.map(s => `
    <div class="recipient-item" data-id="${esc(s.id)}" onclick="toggleRecipient('${esc(s.id)}')">
      <span class="recipient-check">○</span>
      <span>${esc(s.name)}</span>
      <span style="font-size:0.72rem;color:#9ca3af;margin-left:auto">${esc(s.admin_role || s.employment_type)}</span>
    </div>`).join('');
}

function toggleRecipient(userId) {
  const el  = document.querySelector(`.recipient-item[data-id="${userId}"]`);
  const idx = state.selectedRecipients.indexOf(userId);
  if (idx === -1) {
    state.selectedRecipients.push(userId);
    el.classList.add('selected');
    el.querySelector('.recipient-check').textContent = '✓';
  } else {
    state.selectedRecipients.splice(idx, 1);
    el.classList.remove('selected');
    el.querySelector('.recipient-check').textContent = '○';
  }
}

/**
 * 相談を送信する。
 * send_consultation を呼び、consultation_recipients に送信先を登録する。
 */
async function handleSendConsult() {
  const title   = document.getElementById('consult-title').value.trim();
  const message = document.getElementById('consult-message').value.trim();

  if (!title)   { showToast('件名を入力してください。', 'warning'); return; }
  if (!message) { showToast('本文を入力してください。', 'warning'); return; }
  if (!state.selectedRecipients.length) {
    showToast('送信先を1人以上選択してください。', 'warning');
    return;
  }

  showLoading('送信中...');
  const result = await api('send_consultation', {
    operator_id    : state.userId,
    title,
    message,
    recipient_ids  : state.selectedRecipients,
  });
  hideLoading();

  if (!result.success) {
    showToast(result.error_message || '送信に失敗しました。', 'error');
    return;
  }

  showToast('相談を送信しました', 'success');

  // フォームリセット
  document.getElementById('consult-title').value   = '';
  document.getElementById('consult-message').value = '';
  state.selectedRecipients = [];
  document.querySelectorAll('.recipient-item').forEach(el => {
    el.classList.remove('selected');
    el.querySelector('.recipient-check').textContent = '○';
  });

  // 送信済み一覧を再取得
  await loadConsultations();
}

async function loadConsultations() {
  const result = await api('get_consultations_v2', {
    operator_id : state.userId,
  });
  if (!result.success) return;

  state.consultations = result.data.consultations || [];
  if (state.currentPanel === 'consult') renderConsultList();
}

function renderConsultList() {
  const list = document.getElementById('consult-list');
  if (!state.consultations.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-text">送信済みの相談はありません</div>
      </div>`;
    return;
  }

  list.innerHTML = state.consultations.map(c => `
    <div class="consult-item">
      <div class="consult-item-title">${esc(c.title)}</div>
      <div class="consult-item-message">${esc(c.message.slice(0, 80))}${c.message.length > 80 ? '...' : ''}</div>
      <div class="consult-item-meta">
        <span>${esc(c.created_at.slice(0, 10))}</span>
        ${c.is_resolved ? '<span class="consult-resolved">✅ 解決済み</span>' : ''}
      </div>
    </div>`).join('');
}
