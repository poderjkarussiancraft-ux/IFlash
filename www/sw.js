// ============================================================
// sw.js — Service Worker для Push-уведомлений IFlash
// ============================================================

const CACHE_NAME = 'iflash-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---- Обработка push-сообщений ----
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'IFlash', body: event.data ? event.data.text() : 'Новое сообщение' };
  }

  const title = data.title || 'IFlash';
  const options = {
    body: data.body || 'Новое сообщение',
    icon: data.icon || '/avat.png',
    badge: '/avat.png',
    tag: data.tag || 'iflash-msg',
    data: {
      url: data.url || '/',
      senderId: data.senderId || null,
    },
    vibrate: [200, 100, 200],
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ---- Уведомление из клиента через postMessage (работает без push-сервера) ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, tag, senderId } = event.data;
    self.registration.showNotification(title || 'IFlash', {
      body: body || 'Новое сообщение',
      icon: icon || '/avat.png',
      badge: '/avat.png',
      tag: tag || 'iflash-msg',
      renotify: true,
      vibrate: [150, 50, 150],
      data: { senderId: senderId || null, url: '/' },
    });
  }
});

// ---- Клик по уведомлению ----
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Если уже открыта вкладка — фокусируемся на ней
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          // Сообщаем странице открыть нужный чат
          if (event.notification.data?.senderId) {
            client.postMessage({
              type: 'OPEN_CHAT',
              senderId: event.notification.data.senderId,
            });
          }
          return;
        }
      }
      // Иначе открываем новую вкладку
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
