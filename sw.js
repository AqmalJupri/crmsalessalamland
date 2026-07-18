const CRM_URL = "/?preview=desktop&section=leads";
const CRM_ICON = "/assets/salam-land-logo-2026.jpeg";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "Lead baru masuk CRM";
  const options = {
    body: data.body || "Buka CRM untuk tengok lead yang auto assign kepada team sales device ini.",
    icon: data.icon || CRM_ICON,
    badge: data.badge || CRM_ICON,
    tag: data.tag || `crm-salam-lead-${Date.now()}`,
    renotify: true,
    requireInteraction: false,
    data: {
      url: data.url || CRM_URL
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || CRM_URL, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => client.url.startsWith(self.location.origin));
      if (existing) {
        if ("navigate" in existing) existing.navigate(targetUrl);
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
