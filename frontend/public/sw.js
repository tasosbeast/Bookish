self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Bookish', body: event.data.text() };
  }

  const title = payload.title || 'Bookish';
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    data: {
      url: payload.url || '/friends?tab=requests',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const rawUrl = event.notification.data?.url || '/friends?tab=requests';
  let targetUrl;
  try {
    targetUrl = new URL(rawUrl, self.location.origin);
  } catch {
    targetUrl = new URL('/friends?tab=requests', self.location.origin);
  }

  // Only navigate within the Bookish origin.
  if (targetUrl.origin !== self.location.origin) {
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        const clientUrl = new URL(client.url, self.location.origin);
        if (clientUrl.origin === self.location.origin) {
          if ('navigate' in client) {
            await client.navigate(targetUrl.href);
          }
          if ('focus' in client) {
            return client.focus();
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
    })
  );
});
