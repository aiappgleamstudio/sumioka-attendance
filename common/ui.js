/**
 * ui.js - 共通UI表示モジュール
 *
 * 役割:
 *   トースト通知・ローディング・エラーダイアログ・確認ダイアログ・
 *   タブ切り替え・数値入力変換を提供する。
 *
 * 依存:
 *   styles.css（.toast-ov / .loading-overlay / .error-overlay / .confirm-overlay など）
 *
 * グローバル公開:
 *   window.SumiokaUI.showToast / showLoading / hideLoading / showError /
 *                   confirm / handleApiResult / initTabs / initNumericInputs /
 *                   convertNumericInput / initAppMeta
 *   window.XXX（省略形）
 *
 * @version 1.0.0
 * @author  田中沙亜
 */

(function (global) {
  'use strict';

  // ============================================================
  // トースト通知
  // ============================================================

  /**
   * 画面下部にフワっとトースト通知を表示する。
   *
   * @param {string} message           - 表示するメッセージ
   * @param {'success'|'error'|'info'|'warning'} [type='info'] - 種類
   * @param {number} [duration=2000]   - 表示ミリ秒
   */
  function showToast(message, type = 'info', duration = 2000) {
    // 既存のトーストがあれば削除
    const existing = document.querySelector('.sumioka-toast-ov');
    if (existing) existing.remove();

    const ov  = document.createElement('div');
    ov.className = 'sumioka-toast-ov';

    const box = document.createElement('div');
    box.className = `sumioka-toast-box sumioka-toast-${type}`;
    box.textContent = message;

    ov.appendChild(box);
    document.body.appendChild(ov);

    // アニメーション付きで表示
    requestAnimationFrame(() => {
      box.classList.add('sumioka-toast-show');
    });

    // 指定時間後にフェードアウトして削除
    setTimeout(() => {
      box.classList.remove('sumioka-toast-show');
      box.classList.add('sumioka-toast-hide');
      setTimeout(() => ov.remove(), 300);
    }, duration);
  }

  // ============================================================
  // ローディング
  // ============================================================

  /**
   * 全画面ローディングオーバーレイを表示する。
   * callGAS の前後に必ずペアで使う。
   *
   * @param {string} [message='処理中...'] - ローディング中のテキスト
   */
  function showLoading(message = '処理中...') {
    hideLoading(); // 二重表示防止

    const ov = document.createElement('div');
    ov.className = 'sumioka-loading-overlay';
    ov.id = 'sumioka-loading';

    ov.innerHTML = `
      <div class="sumioka-loading-box">
        <div class="sumioka-loading-spinner"></div>
        <div class="sumioka-loading-text">${_escapeHtml(message)}</div>
      </div>
    `;

    document.body.appendChild(ov);
  }

  /**
   * ローディングオーバーレイを非表示にする。
   */
  function hideLoading() {
    const el = document.getElementById('sumioka-loading');
    if (el) el.remove();
  }

  // ============================================================
  // エラーダイアログ
  // ============================================================

  /**
   * エラーダイアログを表示する。
   *
   * @param {string}   errorMessage      - ユーザー向けメッセージ（日本語）
   * @param {string}   [errorDetail='']  - デバッグ用詳細（折りたたみで表示）
   * @param {Function} [onRetry]         - 「再試行」ボタンのコールバック（省略時はボタン非表示）
   */
  function showError(errorMessage, errorDetail = '', onRetry = null) {
    // 既存のエラーダイアログがあれば閉じる
    const existing = document.querySelector('.sumioka-error-overlay');
    if (existing) existing.remove();

    const ov  = document.createElement('div');
    ov.className = 'sumioka-error-overlay';

    const detailHtml = errorDetail
      ? `<details class="sumioka-error-detail">
           <summary>詳細</summary>
           <pre>${_escapeHtml(errorDetail)}</pre>
         </details>`
      : '';

    const retryHtml = onRetry
      ? `<button class="sumioka-btn sumioka-btn-primary" id="sumioka-error-retry">再試行</button>`
      : '';

    ov.innerHTML = `
      <div class="sumioka-error-box">
        <p class="sumioka-error-message">${_escapeHtml(errorMessage)}</p>
        ${detailHtml}
        <div class="sumioka-error-actions">
          ${retryHtml}
          <button class="sumioka-btn sumioka-btn-secondary" id="sumioka-error-close">閉じる</button>
        </div>
      </div>
    `;

    document.body.appendChild(ov);

    document.getElementById('sumioka-error-close').addEventListener('click', () => ov.remove());

    if (onRetry) {
      document.getElementById('sumioka-error-retry').addEventListener('click', () => {
        ov.remove();
        onRetry();
      });
    }
  }

  // ============================================================
  // API結果ハンドラ
  // ============================================================

  /**
   * callGAS の返り値を渡すだけで成功/失敗を自動表示する便利関数。
   * 成功 → showToast、失敗 → showError を自動で呼ぶ。
   *
   * @param {Object}   result          - callGAS の返り値
   * @param {string}   [successMessage='完了しました。'] - 成功時のトーストメッセージ
   * @param {Function} [onRetry]       - 失敗時の再試行コールバック
   * @returns {boolean} 成功したか
   */
  function handleApiResult(result, successMessage = '完了しました。', onRetry = null) {
    if (result.success) {
      showToast(successMessage, 'success');
      return true;
    } else {
      showError(result.error_message, result.error_detail, onRetry);
      return false;
    }
  }

  // ============================================================
  // 確認ダイアログ
  // ============================================================

  /**
   * 確認ダイアログを表示する。Promise<boolean> を返す。
   *
   * 使い方:
   *   const ok = await confirm('削除しますか？');
   *   if (ok) { ... }
   *
   * @param {string} [message='確認してください。']
   * @param {string} [confirmText='OK']
   * @param {string} [cancelText='キャンセル']
   * @returns {Promise<boolean>}
   */
  function confirm(message = '確認してください。', confirmText = 'OK', cancelText = 'キャンセル') {
    return new Promise(resolve => {
      const existing = document.querySelector('.sumioka-confirm-overlay');
      if (existing) existing.remove();

      const ov = document.createElement('div');
      ov.className = 'sumioka-confirm-overlay';

      ov.innerHTML = `
        <div class="sumioka-confirm-box">
          <p class="sumioka-confirm-message">${_escapeHtml(message)}</p>
          <div class="sumioka-confirm-actions">
            <button class="sumioka-btn sumioka-btn-primary"   id="sumioka-confirm-ok">${_escapeHtml(confirmText)}</button>
            <button class="sumioka-btn sumioka-btn-secondary" id="sumioka-confirm-cancel">${_escapeHtml(cancelText)}</button>
          </div>
        </div>
      `;

      document.body.appendChild(ov);

      document.getElementById('sumioka-confirm-ok').addEventListener('click', () => {
        ov.remove();
        resolve(true);
      });

      document.getElementById('sumioka-confirm-cancel').addEventListener('click', () => {
        ov.remove();
        resolve(false);
      });
    });
  }

  // ============================================================
  // タブ切り替え
  // ============================================================

  /**
   * タブナビゲーションを初期化する。
   *
   * HTML 条件:
   *   ボタンに class="sumioka-tab-btn" data-tab="タブ名"
   *   コンテンツに id="tab-タブ名"
   *
   * @param {Object}   [options={}]
   * @param {string}   [options.defaultTab]  - 初期表示タブ名（省略時は最初の .sumioka-tab-btn）
   * @param {Function} [options.onSwitch]    - タブ切り替え時コールバック (tabName) => {}
   */
  function initTabs(options = {}) {
    const buttons = Array.from(document.querySelectorAll('.sumioka-tab-btn'));
    if (buttons.length === 0) return;

    function switchTab(tabName) {
      buttons.forEach(btn => {
        const isActive = btn.dataset.tab === tabName;
        btn.classList.toggle('sumioka-tab-btn--active', isActive);
        btn.setAttribute('aria-selected', isActive);
      });

      document.querySelectorAll('.sumioka-tab-content').forEach(content => {
        content.hidden = content.id !== `tab-${tabName}`;
      });

      if (options.onSwitch) options.onSwitch(tabName);
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // 外部からタブを切り替えられるようにグローバルに公開
    global._sumiokaSwitch = switchTab;

    // 初期タブを表示
    const defaultTab = options.defaultTab || buttons[0].dataset.tab;
    switchTab(defaultTab);
  }

  // ============================================================
  // 数値ショートカット入力
  // ============================================================

  /**
   * data-convert 属性を持つ input を一括で数値ショートカット入力に設定する。
   * DOMContentLoaded 後に1回呼ぶだけでOK。
   *
   * data-convert の種類:
   *   "time"     : 830 → 8:30
   *   "duration" : 90  → 1:30
   *   "money"    : 9000 → 9,000
   */
  function initNumericInputs() {
    document.querySelectorAll('input[data-convert]').forEach(input => {
      convertNumericInput(input, input.dataset.convert);
    });
  }

  /**
   * 個別の input に数値ショートカットを設定する。
   *
   * @param {HTMLInputElement} inputEl
   * @param {'time'|'duration'|'money'} type
   */
  function convertNumericInput(inputEl, type) {
    inputEl.addEventListener('blur', () => {
      const raw = inputEl.value.replace(/[^0-9]/g, '');
      if (!raw) return;

      const num = parseInt(raw, 10);

      switch (type) {
        case 'time': {
          // 830 → 8:30 / 900 → 9:00
          const h = Math.floor(num / 100);
          const m = num % 100;
          if (m >= 60) return; // 不正な分は変換しない
          inputEl.value = `${h}:${String(m).padStart(2, '0')}`;
          break;
        }
        case 'duration': {
          // 90 → 1:30
          const h = Math.floor(num / 60);
          const m = num % 60;
          inputEl.value = `${h}:${String(m).padStart(2, '0')}`;
          break;
        }
        case 'money': {
          // 9000 → 9,000
          inputEl.value = num.toLocaleString('ja-JP');
          break;
        }
      }
    });
  }

  // ============================================================
  // アプリメタ情報
  // ============================================================

  /**
   * ヘッダーのバージョン表示と設定タブのバージョン履歴アコーディオンを生成する。
   *
   * HTML 条件:
   *   id="sumioka-app-version" : バージョン文字列を表示する要素
   *   id="sumioka-acc-versions": バージョン履歴アコーディオンを挿入する要素
   *
   * @param {Object}   options
   * @param {string}   options.version - 現在のバージョン（例: 'v1.0.0'）
   * @param {Array}    options.history - [{ v, date, note }] の配列（新しい順）
   */
  function initAppMeta({ version, history = [] }) {
    const versionEl = document.getElementById('sumioka-app-version');
    if (versionEl) versionEl.textContent = version;

    const accEl = document.getElementById('sumioka-acc-versions');
    if (accEl && history.length > 0) {
      accEl.innerHTML = history.map(h => `
        <details>
          <summary>${_escapeHtml(h.v)} <span class="sumioka-version-date">${_escapeHtml(h.date)}</span></summary>
          <p>${_escapeHtml(h.note)}</p>
        </details>
      `).join('');
    }
  }

  // ============================================================
  // 内部ユーティリティ
  // ============================================================

  /**
   * HTML エスケープ。XSS を防ぐため、ユーザー入力を DOM に埋め込む前に必ず使う。
   *
   * @param {string} str
   * @returns {string}
   */
  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#039;');
  }

  // ============================================================
  // グローバル公開
  // ============================================================

  const SumiokaUI = {
    showToast,
    showLoading,
    hideLoading,
    showError,
    handleApiResult,
    confirm,
    initTabs,
    initNumericInputs,
    convertNumericInput,
    initAppMeta,
  };

  global.SumiokaUI = SumiokaUI;

  // 省略形（直接呼べる）
  global.showToast       = showToast;
  global.showLoading     = showLoading;
  global.hideLoading     = hideLoading;
  global.showError       = showError;
  global.handleApiResult = handleApiResult;
  global.confirm         = confirm;
  global.initTabs        = initTabs;
  global.initNumericInputs   = initNumericInputs;
  global.convertNumericInput = convertNumericInput;
  global.initAppMeta     = initAppMeta;

})(window);
