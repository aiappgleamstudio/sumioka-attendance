/**
 * service-worker.js - 住岡勤怠管理 PWA Service Worker v2.1
 *
 * 設計方針:
 *   タイマー管理は kintai.html 側で行い、SWは通知送信専用にする。
 *   DELAYED_NOTIFICATION でタブを閉じても届く遅延通知が可能。
 *
 * @version 2.1.0
 */
'use strict';

const SW_VERSION = 'sumioka-v2.1.0';

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
 * kintai.html からのメッセージを処理する。
 *
 * SHOW_NOTIFICATION:
 *   即座にOS通知を表示する。定時5分前の通知に使用。
 *
 * DELAYED_NOTIFICATION:
 *   指定秒数後にOS通知を表示する。通知テストに使用。
 *   タブを閉じていても届く。
 *   event.waitUntil で SW がスリープしないよう保持する。
 */
self.addEventListener('message', event => {
  const data = event.data || {};
  console.log('[SW] メッセージ受信:', data.type);

  if (data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      showOsNotification(
        data.title || 'まもなく定時です',
        data.body  || '退勤打刻を忘れていませんか？'
      )
    );
  }

  if (data.type === 'DELAYED_NOTIFICATION') {
    const delay = (data.delaySeconds || 60) * 1000;
    const title = data.title || '🔔 通知テスト';
    const body  = data.body  || 'テスト通知です。';

    // event.waitUntil に Promise を渡して SW をスリープさせない
    // ※ Chromeは最大数分間 waitUntil を保持するので60秒は問題なし
    event.waitUntil(
      new Promise(resolve => {
        setTimeout(async () => {
          await showOsNotification(title, body);
          resolve();
        }, delay);
      })
    );
    console.log('[SW] 遅延通知を予約:', delay / 1000, '秒後');
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
    console.log('[SW] 通知送信完了:', title);
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
