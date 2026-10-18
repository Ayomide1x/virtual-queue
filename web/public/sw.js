/* Virtual Queue service worker: shows push alerts and opens the right page when one is tapped. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Virtual Queue', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Virtual Queue';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: !!data.urgent,
      lang: data.lang || 'en',
      vibrate: [300, 120, 300, 120, 600],
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse an open tab on the same page if there is one.
      for (const client of windows) {
        const url = new URL(client.url);
        if (url.origin === target.origin && url.pathname === target.pathname && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
