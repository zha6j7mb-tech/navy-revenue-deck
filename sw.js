/* =========================================================================
 * NAVY_BLUE Revenue Deck — Service Worker
 * PWA オフライン対応・アセットキャッシュ
 * ========================================================================= */

const CACHE_NAME = "navy-revenue-v20260609";

// キャッシュするアセット（アプリの骨格）
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
];

// ─── インストール：アセットを事前キャッシュ ───────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  // 古い SW を待たずすぐ有効化
  self.skipWaiting();
});

// ─── アクティベート：古いキャッシュを削除 ────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  // すべてのクライアントを即座にこの SW で制御
  self.clients.claim();
});

// ─── フェッチ：キャッシュ優先 / Supabase はネットワーク直通 ─────────────
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Supabase API / CDN は必ずネットワークへ（オフライン時はそのままエラー）
  if (
    url.includes("supabase.co") ||
    url.includes("cdn.jsdelivr.net")
  ) {
    return; // SW を素通り → ブラウザのデフォルト挙動
  }

  // それ以外：キャッシュ優先、なければネットワーク取得してキャッシュ
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // エラーレスポンスはキャッシュしない
        if (!response || response.status !== 200 || response.type === "error") {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) =>
          cache.put(event.request, cloned)
        );
        return response;
      });
    })
  );
});
