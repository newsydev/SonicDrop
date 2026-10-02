/**
 * SonicDrop Service Worker
 * Handles offline caching and native OS Web Share Target (POST /share-target)
 */

const CACHE_NAME = "sonicdrop-v2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/sender",
  "/sender.html",
  "/utils.js",
  "/ggwave.js",
  "/simplewebauthn-browser.min.js",
  "/manifest.json",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// ── Install: Pre-cache App Shell ─────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Pre-caching offline app shell");
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: Clean up old caches ────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// ── IndexedDB Helper for Web Share Target ────────────────────────────────────
function openShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("sonicdrop_share_db", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("shared_store")) {
        db.createObjectStore("shared_store", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSharedPayload(payload) {
  const db = await openShareDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("shared_store", "readwrite");
    const store = tx.objectStore("shared_store");
    const req = store.put({ id: "latest_share", ...payload });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Fetch: Handle Web Share Target POST & Static Caching ─────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 1. Web Share Target API: Native OS share sheet POST handler
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const files = formData.getAll("files") || [];
        const text = formData.get("text") || "";
        const title = formData.get("title") || "";
        const sharedUrl = formData.get("url") || "";

        // Combine text/title/url
        const combinedText = [title, text, sharedUrl].filter(Boolean).join("\n");

        await saveSharedPayload({
          files,
          text: combinedText,
          timestamp: Date.now()
        });

        // 303 Redirect to sender page
        return Response.redirect("/sender?shared=1", 303);
      } catch (err) {
        console.error("[SW] Error processing share target:", err);
        return Response.redirect("/sender", 303);
      }
    })());
    return;
  }

  // Skip WebSocket connections and dynamic authentication API requests
  if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/api/")) return;

  // 2. Cache-first with Network Fallback for GET requests
  if (event.request.method === "GET") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
              const toCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
            }
            return networkResponse;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});
