/**
 * 使い方ガイド（モーダルダイアログ）の開閉・FAQアコーディオンの開閉を担う。
 *
 * 依存:
 *   common/styles.css（.sumioka-modal / .sumioka-guide-* / .sumioka-accordion）
 *
 * 注意:
 *   type="module" ではない通常の <script> として読み込む前提。
 *   トップレベルの const/function は他の staff/*.js からも参照できる
 *   （ブラウザのクラシックスクリプトは同一グローバルスコープを共有する）。
 */
'use strict';

// ============================================================
// 使い方ガイド モーダル
// ============================================================

/**
 * 使い方ガイドモーダルを開く。
 */
function openGuideModal() {
  document.getElementById('guide-modal').classList.remove('sumioka-hidden');
}

/**
 * 使い方ガイドモーダルを閉じる。
 */
function closeGuideModal() {
  document.getElementById('guide-modal').classList.add('sumioka-hidden');
}

// Escキーでも閉じられるようにする（オーバーレイクリックでの閉じ方と揃える）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('guide-modal');
  if (modal && !modal.classList.contains('sumioka-hidden')) closeGuideModal();
});

// ============================================================
// FAQ アコーディオン
// ============================================================

// 外部ライブラリは使わず classList.toggle('is-open') のみで開閉する。
document.querySelectorAll('#guide-faq-accordion .sumioka-accordion-trigger').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('.sumioka-accordion-item').classList.toggle('is-open');
  });
});
