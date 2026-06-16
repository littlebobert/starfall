self.addEventListener("push", (event) => {
  const fallback = {
    title: "Starfall Commander",
    body: "Your game needs attention.",
    tag: "starfall",
    url: "/"
  };
  const data = event.data ? event.data.json() : fallback;
  const targetUrl = data.url || fallback.url;
  const roomCode = new URL(targetUrl, self.location.origin).searchParams.get("room");

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const hasVisibleGameClient = clients.some((client) => {
        if (client.visibilityState !== "visible") {
          return false;
        }

        if (!roomCode) {
          return true;
        }

        try {
          return new URL(client.url).searchParams.get("room")?.toUpperCase() === roomCode.toUpperCase();
        } catch {
          return false;
        }
      });

      if (hasVisibleGameClient) {
        return;
      }

      return self.registration.showNotification(data.title || fallback.title, {
        body: data.body || fallback.body,
        tag: data.tag || fallback.tag,
        data: {
          url: targetUrl
        }
      });
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
