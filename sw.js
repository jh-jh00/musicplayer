const SW_VERSION = "self-host-1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.claim().then(() =>
      self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: "sw-updated", version: SW_VERSION });
        });
      })
    )
  );
});
