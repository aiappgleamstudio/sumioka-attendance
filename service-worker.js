/**
 * service-worker.js - 住岡勤怠管理 PWA Service Worker
 *
 * 役割:
 *   - #16: kintai.html のタブを閉じた状態でも定時5分前通知を送る
 *   - #13: PWA として動作するための Service Worker 基盤
 *
 * 動作の仕組み:
 *   1. kintai.html が Service Worker を登録する
 *   2. kintai.html は SET_SCHEDULE メッセージで scheduledEnd（定時）と employeeId を伝える
 *   3. Service Worker は1分ごとに現在時刻をチェックする
 *   4. 定時5分前かつ「まだ通知していない」場合に Notification を送る
 *
 * 制約:
 *   - ブラウザが完全終了した場合は Service Worker も停止するため通知不可
 *   - HTTPS 環境でのみ動作する（GitHub Pages は対象内）
 *   - 通知許可が必要（Notification.permission === 'granted'）
 *
 * 将来拡張:
 *   - Discord / LINE 通知への拡張は notificationService.js 等に分離する設計とする
 *   - PUSH API 対応でブラウザ完全終了時でも通知できるようになる（要サーバー側実装）
 *
 * @version 1.0.0
 */

'use strict';

// ============================================================
// 定数
// ============================================================

/** Service Worker のバージョン（キャッシュキーに使用） */
const SW_VERSION = 'sumioka-v1.0.0';

/** 定時何分前に通知するか（kintai.html の OVERTIME_NOTICE_MINUTES と合わせる） */
const NOTICE_BEFORE_MINUTES = 5;

/** 通知チェックのインターバル（ミリ秒）。Service Worker は1分ごとにチェックする */
const CHECK_INTERVAL_MS = 60 * 1000;

// ============================================================
// 状態管理
// ============================================================

/**
 * Service Worker が管理するスケジュール情報。
 * kintai.html から postMessage で SET_SCHEDULE を受け取って更新する。
 */
let schedule = {
  scheduledEnd : '',  // 'HH:MM' 形式の定時（例: '15:00'）
  employeeId   : '',  // 現在のログインユーザーID
  notifiedDate : '',  // 最後に通知した日付（YYYY-MM-DD）。同日の重複通知を防ぐ
};

// ============================================================
// インストール・アクティベーション
// ============================================================

/**
 * Service Worker インストール時の処理。
 * 静的アセットはキャッシュしない（動的GASデータのためキャッシュ不適）。
 * skipWaiting() で即座にアクティブにする。
 */
self.addEventListener('install', event => {
  console.log('[SW] インストール: バージョン', SW_VERSION);
  self.skipWaiting();
});

/**
 * Service Worker アクティベーション時の処理。
 * 古いキャッシュを削除し、clients.claim() で即座に制御を取得する。
 */
self.addEventListener('activate', event => {
  console.log('[SW] アクティベーション');
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== SW_VERSION).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// ============================================================
// メッセージ受信（kintai.html からのスケジュール設定）
// ============================================================

/**
 * kintai.html から postMessage で受け取るメッセージを処理する。
 *
 * メッセージの種類:
 *   SET_SCHEDULE : 定時（scheduledEnd）とユーザーIDを更新する
 *   CLEAR_SCHEDULE: ログアウト時にスケジュールをクリアする
 */
self.addEventListener('message', event => {
  const { type, scheduledEnd, employeeId } = event.data || {};

  if (type === 'SET_SCHEDULE') {
    // 定時とユーザー情報を受け取って状態を更新する
    schedule.scheduledEnd = scheduledEnd || '';
    schedule.employeeId   = employeeId   || '';
    console.log('[SW] スケジュール設定: scheduledEnd=%s, employeeId=%s',
      scheduledEnd, employeeId);

    // スケジュール設定後すぐにチェックを開始する
    startNotificationCheck();
  }

  if (type === 'CLEAR_SCHEDULE') {
    // ログアウト時にスケジュールをクリアして通知チェックを止める
    schedule = { scheduledEnd: '', employeeId: '', notifiedDate: '' };
    stopNotificationCheck();
    console.log('[SW] スケジュールをクリアしました。');
  }
});

// ============================================================
// 定時前通知チェック
// ============================================================

/** 通知チェックのタイマーID（clearInterval で停止するために保持する） */
let checkTimer = null;

/**
 * 定時前通知チェックを開始する。
 * 既にタイマーが動いている場合は再起動しない（二重実行防止）。
 */
function startNotificationCheck() {
  if (checkTimer !== null) return; // 既に動作中
  checkTimer = setInterval(checkAndNotify, CHECK_INTERVAL_MS);
  // 即時チェック（開始直後にも確認する）
  checkAndNotify();
  console.log('[SW] 通知チェック開始');
}

/**
 * 定時前通知チェックを停止する。
 */
function stopNotificationCheck() {
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
    console.log('[SW] 通知チェック停止');
  }
}

/**
 * 現在時刻が定時5分前かチェックし、条件を満たせば通知を送る。
 *
 * 通知条件:
 *   1. scheduledEnd が設定されている
 *   2. 現在時刻が（定時 - NOTICE_BEFORE_MINUTES）と一致する（±1分の許容）
 *   3. 今日すでに通知していない
 */
async function checkAndNotify() {
  if (!schedule.scheduledEnd) return; // スケジュール未設定なら何もしない

  const now       = new Date();
  const todayStr  = toDateString(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // 定時（HH:MM）を分に変換する
  const [endH, endM] = schedule.scheduledEnd.split(':').map(Number);
  if (isNaN(endH) || isNaN(endM)) return;
  const endMinutes   = endH * 60 + endM;
  const targetMinutes = endMinutes - NOTICE_BEFORE_MINUTES;

  // 現在時刻が通知タイミングか確認する（±0分で完全一致。Service Worker は1分ごとに起動）
  const shouldNotify = nowMinutes === targetMinutes;

  // 同日の重複通知を防ぐ
  const alreadyNotified = schedule.notifiedDate === todayStr;

  if (shouldNotify && !alreadyNotified) {
    await sendNotification();
    schedule.notifiedDate = todayStr; // 今日は通知済みフラグを立てる
    console.log('[SW] 通知送信: 日付=%s', todayStr);
  }
}

/**
 * #16: 定時5分前通知を送る。
 *
 * クリック時に kintai.html を前面に出す。
 * Notification API が利用できない場合はコンソールに出力するだけにする。
 */
async function sendNotification() {
  // 通知許可の確認（Service Worker 内では Notification.permission は参照できないため
  // showNotification が失敗することを許容する）
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 既に開いているタブがあればそちらにフォーカスして通知しない（タブ上のバナーで十分）
    const focusableClient = clients.find(c =>
      c.url.includes('kintai.html') && 'focus' in c
    );
    if (focusableClient) {
      // タブが開いている場合: タブ内のバナー通知で対応済みのため SW 通知は不要
      console.log('[SW] タブが開いているため SW 通知をスキップ');
      return;
    }

    // タブが閉じている場合: Notification API で OS 通知を送る
    const reg = await self.registration;
    await reg.showNotification('まもなく定時です', {
      body   : '退勤打刻を忘れていませんか？',
      icon   : './icons/icon-192.png',
      badge  : './icons/icon-192.png',
      tag    : 'sumioka-overtime', // 同タグの重複通知を防ぐ
      requireInteraction: false,   // 自動的に消える
    });
  } catch (err) {
    console.warn('[SW] 通知送信に失敗:', err.message);
  }
}

/**
 * Date オブジェクトを 'YYYY-MM-DD' 文字列に変換するユーティリティ。
 *
 * @param {Date} d
 * @returns {string}
 */
function toDateString(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

// ============================================================
// 通知クリック時の動作
// ============================================================

/**
 * 通知がクリックされたとき、kintai.html を前面に出すか新規タブで開く。
 */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // 既に kintai.html が開いていればそちらにフォーカスする
        const kintaiClient = clients.find(c => c.url.includes('kintai.html'));
        if (kintaiClient && 'focus' in kintaiClient) {
          return kintaiClient.focus();
        }
        // 開いていなければ新規タブで開く
        return self.clients.openWindow('./kintai.html');
      })
  );
});
