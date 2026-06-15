self.addEventListener("push", (event) => {
  const fallback = {
    title: "Starfall Commander",
    body: "Your game needs attention.",
    tag: "starfall",
    url: "/"
  };
  const data = event.data ? event.data.json() : fallback;

  event.waitUntil(
    self.registration.showNotification(data.title || fallback.title, {
      body: data.body || fallback.body,
      tag: data.tag || fallback.tag,
      data: {
        url: data.url || fallback.url
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const roomCode = new URL(targetUrl).searchParams.get("room");

      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({
            type: "starfall-open-room",
            roomCode,
            url: targetUrl
          });
          return client.focus();
        }
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
