/**
 * service-worker.js - 住岡勤怠管理 PWA Service Worker v2.0
 *
 * 設計方針:
 *   タイマー管理は kintai.html 側で行い、SWは通知送信専用にする。
 *   Chrome は SW をアイドル時にスリープさせるため SW 内の setInterval は使えない。
 *   kintai.html のタブが開いている限り setInterval が確実に動く。
 *
 * 動作フロー:
 *   1. kintai.html が毎分時刻チェックして定時5分前を検知する
 *   2. kintai.html が SW に SHOW_NOTIFICATION メッセージを送る
 *   3. SW がすぐに OS 通知を表示する
 *
 * @version 2.0.0
 */
'use strict';

const SW_VERSION = 'sumioka-v2.0.0';

self.addEventListener('install', event => {
  console.log('[SW] インストール:', SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('[SW] アクティベーション');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SW_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/**
 * kintai.html から SHOW_NOTIFICATION を受け取ったら即座に OS 通知を表示する。
 */
self.addEventListener('message', async event => {
  const data = event.data || {};
  console.log('[SW] メッセージ受信:', data.type);
  if (data.type === 'SHOW_NOTIFICATION') {
    await showOsNotification(
      data.title || 'まもなく定時です',
      data.body  || '退勤打刻を忘れていませんか？'
    );
  }
});

async function showOsNotification(title, body) {
  try {
    await self.registration.showNotification(title, {
      body,
      tag              : 'sumioka-overtime',
      requireInteraction: false,
      renotify         : true,
    });
    console.log('[SW] 通知送信完了');
  } catch (err) {
    console.warn('[SW] 通知送信失敗:', err.message);
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const kintai = clients.find(c => c.url.includes('kintai.html'));
        if (kintai && 'focus' in kintai) return kintai.focus();
        return self.clients.openWindow('./kintai.html');
      })
  );
});
