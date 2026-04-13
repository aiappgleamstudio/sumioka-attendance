/**
 * storage.js - localStorage 管理モジュール
 *
 * 役割:
 *   localStorage への保存・読込を一元管理する。
 *   キーに sumioka_ プレフィックスを自動付与し、他アプリとの衝突を防ぐ。
 *   データにはバージョン情報を付与する（将来のマイグレーション対応）。
 *
 * キー命名規則:
 *   保存時: sumioka_ + 引数のキー名
 *   例: save('gas_url', ...) → localStorage の 'sumioka_gas_url' に保存
 *   呼び出し側は sumioka_ なしで渡せばOK
 *
 * グローバル公開:
 *   window.SumiokaStorage.save / load / remove / clear / exists / keys / getUsage
 *   window.XXX（省略形）
 *
 * @version 1.0.0
 * @author  田中沙亜
 */

(function (global) {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================

  /** localStorage キーのプレフィックス */
  const PREFIX = 'sumioka_';

  /** データに付与するスキーマバージョン */
  const SCHEMA_VERSION = 1;

  // ============================================================
  // 公開関数
  // ============================================================

  /**
   * データを保存する。
   *
   * @param {string}  key                      - キー名（プレフィックスなしで渡す）
   * @param {*}       value                    - 保存する値（JSON シリアライズ可能なもの）
   * @param {Object}  [options={}]
   * @param {boolean} [options.withVersion=true] - バージョン情報を付与するか
   * @returns {boolean} 成功したか
   */
  function save(key, value, options = {}) {
    const withVersion = options.withVersion ?? true;

    try {
      const payload = withVersion
        ? { _v: SCHEMA_VERSION, value }
        : value;

      localStorage.setItem(_prefixed(key), JSON.stringify(payload));
      return true;

    } catch (err) {
      // 容量超過（QuotaExceededError）の場合もコンソールに警告を出して false を返す
      if (err.name === 'QuotaExceededError') {
        console.warn('[SumiokaStorage] localStorage 容量超過:', key);
      } else {
        console.error('[SumiokaStorage] save エラー:', key, err);
      }
      return false;
    }
  }

  /**
   * データを読み込む。
   * キーが存在しない場合は defaultValue を返す。
   * バージョン情報が付与されたデータは自動的に展開して value だけ返す。
   *
   * @param {string} key          - キー名（プレフィックスなしで渡す）
   * @param {*}      [defaultValue=null] - キーが存在しない場合の返り値
   * @returns {*}
   */
  function load(key, defaultValue = null) {
    try {
      const raw = localStorage.getItem(_prefixed(key));
      if (raw === null) return defaultValue;

      const parsed = JSON.parse(raw);

      // バージョン情報が付与されている場合は value を取り出す
      if (parsed && typeof parsed === 'object' && '_v' in parsed) {
        return parsed.value;
      }

      return parsed;

    } catch (err) {
      console.error('[SumiokaStorage] load エラー:', key, err);
      return defaultValue;
    }
  }

  /**
   * 指定キーのデータを削除する。
   *
   * @param {string} key
   * @returns {boolean} 成功したか
   */
  function remove(key) {
    try {
      localStorage.removeItem(_prefixed(key));
      return true;
    } catch (err) {
      console.error('[SumiokaStorage] remove エラー:', key, err);
      return false;
    }
  }

  /**
   * sumioka_ プレフィックスのキーをすべて削除する。
   * 他アプリのデータには触れない。
   *
   * @param {boolean} confirmed - true を渡さないと実行されない（誤操作防止）
   * @returns {boolean} 実行されたか
   */
  function clear(confirmed) {
    if (confirmed !== true) {
      console.warn('[SumiokaStorage] clear() は clear(true) として呼んでください。');
      return false;
    }

    try {
      keys().forEach(key => localStorage.removeItem(_prefixed(key)));
      return true;
    } catch (err) {
      console.error('[SumiokaStorage] clear エラー:', err);
      return false;
    }
  }

  /**
   * キーが存在するか確認する。
   *
   * @param {string} key
   * @returns {boolean}
   */
  function exists(key) {
    return localStorage.getItem(_prefixed(key)) !== null;
  }

  /**
   * 現在保存されている全キー一覧を返す（プレフィックスなし）。
   *
   * @returns {string[]}
   */
  function keys() {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        result.push(k.slice(PREFIX.length));
      }
    }
    return result;
  }

  /**
   * sumioka_ プレフィックスのキーが使用している容量の概算を返す。
   *
   * @returns {{ used: number, usedKB: string }}
   */
  function getUsage() {
    let used = 0;
    keys().forEach(key => {
      const raw = localStorage.getItem(_prefixed(key));
      if (raw) used += raw.length * 2; // 文字 × 2バイト（UTF-16）
    });
    return {
      used,
      usedKB: (used / 1024).toFixed(2),
    };
  }

  // ============================================================
  // 内部ユーティリティ
  // ============================================================

  /**
   * キーにプレフィックスを付与する。
   *
   * @param {string} key
   * @returns {string}
   */
  function _prefixed(key) {
    return PREFIX + key;
  }

  // ============================================================
  // グローバル公開
  // ============================================================

  const SumiokaStorage = { save, load, remove, clear, exists, keys, getUsage };

  global.SumiokaStorage = SumiokaStorage;

  // 省略形（直接呼べる）
  global.storeSave   = save;
  global.storeLoad   = load;
  global.storeRemove = remove;
  global.storeClear  = clear;
  global.storeExists = exists;
  global.storeKeys   = keys;

})(window);
