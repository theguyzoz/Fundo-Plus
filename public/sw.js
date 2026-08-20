// sw.js — Fundo Plus Service Worker (Web Push)
self.addEventListener('push', function (event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}

  const title   = data.title   || 'Fundo Plus';
  const options = {
    body:  data.body  || '',
    icon:  data.icon  || '/images/logo.png',
    badge: data.badge || '/images/logo.png',
    image: data.image || undefined,       // big banner image (Android/desktop)
    data:  { url: data.url || '/~/notifications' },
    tag:   data.tag,                       // unique tag → always re-shows
    renotify: !!data.renotify,
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/~/notifications';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const client of list) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
