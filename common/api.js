/**
 * api.js - GAS通信モジュール
 *
 * 役割:
 *   フロントエンドと GAS（Google Apps Script）の通信を担う。
 *   タイムアウト・エラー処理・ボタン無効化を自動で行う。
 *
 * 使い方:
 *   1. アプリ起動時に setGasUrl(url) を1回呼ぶ
 *   2. 以降は callGAS(action, data, options) だけ使えばOK
 *
 * グローバル公開:
 *   window.SumiokaAPI.callGAS / gasPost / setGasUrl
 *   window.callGAS / gasPost / setGasUrl（省略形）
 *
 * @version 1.0.0
 * @author  田中沙亜
 */

(function (global) {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================

  /** デフォルトのタイムアウト秒数 */
  const DEFAULT_TIMEOUT_SEC = 10;

  /** GAS の app 識別子（全リクエストで固定） */
  const APP_ID = 'attendance';

  // ============================================================
  // 内部状態
  // ============================================================

  /** GAS デプロイ URL（setGasUrl で設定する） */
  let _gasUrl = '';

  // ============================================================
  // 公開関数
  // ============================================================

  /**
   * GAS デプロイ URL をセットする。
   * アプリ起動時に1回だけ呼ぶ。
   * window.SUMIOKA_GAS_URL にも同時に書き込む。
   *
   * @param {string} url - GAS ウェブアプリのデプロイ URL
   */
  function setGasUrl(url) {
    _gasUrl = url;
    global.SUMIOKA_GAS_URL = url;
  }

  /**
   * GAS にリクエストを送る主要関数。
   * 全アプリからこれだけ使えばOK。
   *
   * @param {string} action           - 操作名（例: 'save', 'load'）
   * @param {Object} [data={}]        - 送信データ
   * @param {Object} [options={}]     - オプション
   * @param {HTMLElement} [options.button]  - 通信中に無効化するボタン要素
   * @param {number}  [options.timeout]     - タイムアウト秒（省略時は10秒）
   * @param {number}  [options.retry=0]     - リトライ回数
   * @returns {Promise<{success: boolean, data?: Object, error_message?: string, error_detail?: string, error_code?: string}>}
   */
  async function callGAS(action, data = {}, options = {}) {
    const payload = { app: APP_ID, action, data };
    return gasPost(payload, options);
  }

  /**
   * 任意ペイロードを直接 POST する低レベル API。
   * 通常は callGAS を使う。GAS のルーティングを独自にしたい場合のみ使用。
   *
   * エラーコード一覧:
   *   GAS_URL_UNSET : URL 未設定
   *   TIMEOUT       : タイムアウト
   *   NETWORK       : ネットワーク接続不可
   *   HTTP_5XX      : GAS サーバーエラー
   *   GAS_ERROR     : GAS 側でエラーが返った
   *   UNKNOWN       : その他
   *
   * @param {Object} payload          - 送信ペイロード
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.button]
   * @param {number}  [options.timeout]
   * @param {number}  [options.retry=0]
   * @returns {Promise<Object>}
   */
  async function gasPost(payload, options = {}) {
    // URL 未設定チェック
    if (!_gasUrl) {
      return _errorResult('GAS URL が設定されていません。', '', 'GAS_URL_UNSET');
    }

    const timeoutSec = options.timeout ?? DEFAULT_TIMEOUT_SEC;
    const retryCount = options.retry   ?? 0;
    const button     = options.button  ?? null;

    // ボタンを無効化
    if (button) _disableButton(button, true);

    let lastError;

    // リトライループ（retryCount=0 なら1回だけ実行）
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const result = await _fetchWithTimeout(_gasUrl, payload, timeoutSec);
        if (button) _disableButton(button, false);
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < retryCount) {
          // リトライ前に少し待つ（指数バックオフ）
          await _sleep(500 * Math.pow(2, attempt));
        }
      }
    }

    // 全リトライ失敗
    if (button) _disableButton(button, false);
    return _parseError(lastError);
  }

  // ============================================================
  // 内部ユーティリティ
  // ============================================================

  /**
   * タイムアウト付きで GAS に POST する。
   *
   * GAS は CORS 制約があるため Content-Type を text/plain にする。
   * （application/json にすると preflight が走り GAS 側でエラーになる）
   *
   * @param {string} url
   * @param {Object} payload
   * @param {number} timeoutSec
   * @returns {Promise<Object>}
   */
  async function _fetchWithTimeout(url, payload, timeoutSec) {
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), timeoutSec * 1000);

    try {
      const response = await fetch(url, {
        method  : 'POST',
        // GAS の CORS 制約を通すため text/plain を使う
        headers : { 'Content-Type': 'text/plain' },
        body    : JSON.stringify(payload),
        signal  : controller.signal,
        // GAS はリダイレクトするため follow を指定
        redirect: 'follow',
      });

      clearTimeout(timerId);

      if (!response.ok) {
        const err  = new Error('HTTP error');
        err.code   = 'HTTP_5XX';
        err.detail = `status: ${response.status}`;
        throw err;
      }

      const json = await response.json();

      // GAS 側が { success: false } を返した場合
      if (!json.success) {
        const err    = new Error(json.error_message || 'GAS エラー');
        err.code     = 'GAS_ERROR';
        err.detail   = json.error_detail || '';
        err.gasError = json;
        throw err;
      }

      return { success: true, data: json.data };

    } catch (err) {
      clearTimeout(timerId);

      // AbortController によるタイムアウト
      if (err.name === 'AbortError') {
        const e  = new Error('タイムアウト');
        e.code   = 'TIMEOUT';
        e.detail = `${timeoutSec}秒以内に応答がありませんでした。`;
        throw e;
      }

      // fetch 自体が失敗（ネットワーク不可）
      if (err instanceof TypeError) {
        const e  = new Error('ネットワークエラー');
        e.code   = 'NETWORK';
        e.detail = err.message;
        throw e;
      }

      throw err;
    }
  }

  /**
   * エラーオブジェクトからエラーレスポンスを生成する。
   *
   * @param {Error} err
   * @returns {Object}
   */
  function _parseError(err) {
    return _errorResult(
      err.message   || '通信エラーが発生しました。',
      err.detail    || '',
      err.code      || 'UNKNOWN'
    );
  }

  /**
   * エラーレスポンスオブジェクトを生成する。
   *
   * @param {string} message
   * @param {string} detail
   * @param {string} code
   * @returns {Object}
   */
  function _errorResult(message, detail, code) {
    return {
      success       : false,
      error_message : message,
      error_detail  : detail,
      error_code    : code,
    };
  }

  /**
   * ボタンの有効・無効を切り替える。
   *
   * @param {HTMLElement} button
   * @param {boolean} disabled
   */
  function _disableButton(button, disabled) {
    if (button && button instanceof HTMLElement) {
      button.disabled = disabled;
    }
  }

  /**
   * 指定ミリ秒待つ。
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  // グローバル公開
  // ============================================================

  const SumiokaAPI = { callGAS, gasPost, setGasUrl };

  global.SumiokaAPI = SumiokaAPI;

  // 省略形（直接呼べる）
  global.callGAS  = callGAS;
  global.gasPost  = gasPost;
  global.setGasUrl = setGasUrl;

})(window);
