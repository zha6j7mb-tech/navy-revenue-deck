/* =========================================================================
 * NAVY_BLUE Revenue Deck — Service Worker
 * PWA オフライン対応・アセットキャッシュ
 *
 * 方針:
 *   - HTML（ナビゲーション）は「ネットワーク優先」→ 新しいデプロイを必ず拾う
 *     （オフライン時のみキャッシュにフォールバック）
 *   - JS / CSS / アイコン等のアセットは「stale-while-revalidate」
 *     （キャッシュを即返しつつ裏で最新を取得して次回に備える）
 *   - Supabase API / CDN は必ずネットワーク直通（同期・ライブラリは常に最新）
 * ========================================================================= */

const CACHE_NAME = "navy-revenue-v20260609d";

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
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ─── フェッチ ─────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = req.url;

  // GET 以外は素通り
  if (req.method !== "GET") return;

  // Supabase API / CDN は必ずネットワークへ（オフライン時はそのままエラー）
  if (url.includes("supabase.co") || url.includes("cdn.jsdelivr.net")) {
    return; // SW を素通り → ブラウザのデフォルト挙動
  }

  // HTML（ページ遷移）は「ネットワーク優先」→ 最新デプロイを必ず取得
  const isNavigation =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", cloned));
          return response;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/index.html"))
        )
    );
    return;
  }

  // それ以外のアセット：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((response) => {
          if (response && response.status === 200 && response.type !== "error") {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, cloned));
          }
          return response;
        })
        .catch(() => cached);
      // キャッシュがあれば即返し、裏で更新。なければネットワークを待つ。
      return cached || network;
    })
  );
});
