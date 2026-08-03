// sw.js — Service Worker。プリキャッシュ ＋ キャッシュ優先。
//
// **ファイルを変えたら CACHE を必ずインクリメントする**（MAINTENANCE.md §6.1）。
// 上げ忘れると端末は古いキャッシュを返し続け、修正が永久に届かない。
//
// **ファイルを追加したら ASSETS に足す**（同 §6.2）。
// 追加を忘れるとオンラインでは動くがオフラインで壊れる。開発中は常にオンラインなので
// 気づけない。`bash tools/check-sw-assets` で機械的に検出する。
//
// 自動リロードは実装しない（同 §6.5）。新しい SW は waiting に留め、
// ユーザーが更新バーを押したときだけ skipWaiting する。現場で計算中に画面が飛ぶのが最悪の体験。

const CACHE = 'expo-v2';

// すべて相対パス。GitHub Pages のプロジェクトサイトは /<repo>/ 配下なので絶対パスは 404 になる。
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/compute.js',
  './js/state.js',
  './js/ui.js',
  './js/wheel.js',
  './js/storage.js',
  './js/stops.js',
  './js/exposure.js',
  './js/flash.js',
  './js/filters.js',
  './js/advisor.js',
  './js/scenes.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  './icons/apple-touch-icon.png',
];

// ---- ASSETS に入れないもの（意図的な除外。将来「なぜ無いのか」を追えるように明記する）----
//   tools/       開発用のスクリプト。アプリの実行に不要
//   docs/        仕様書とマニュアルの原稿。アプリが読むのは index.html 内の写しだけ
//   tests.html   開発用の検証ページ。オフラインで動かす必要がない
//
// テスト #33 は docs/exposure-app-manual.md を fetch するため、
// **SW 登録後にオフラインで tests.html を開くと #33 が失敗する。これは想定どおりの挙動。**
// テストはオンライン（ローカルサーバー）で実行する。

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // **HTTP キャッシュをバイパスする（cache: 'reload'）。** これを外すと、変更したファイルが
    // ブラウザの HTTP キャッシュに残っている間に install が走り、古い中身をプリキャッシュする。
    // GitHub Pages は max-age=600 を返すので10分間そのリスクがある。
    // CACHE を上げても中身が古い、という検出困難な事故になる（MAINTENANCE.md §6.3）。
    // addAll は1件でも失敗すると reject する。部分的なキャッシュを残さないためこれを使う
    await cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
  })());
  // ここで skipWaiting しない。waiting に留めてユーザーの操作を待つ
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // 画面遷移（アドレス直打ち・リロード）はアプリ本体を返す。SPA ではないが
  // start_url 以外で開かれてもアプリが立ち上がるようにする
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('./index.html')) || fetch(request);
    })());
    return;
  }

  // キャッシュ優先（オフライン前提）。外部ドメインへのリクエストは設計上発生しないので
  // クロスオリジンの分岐は持たない
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (e) {
      // オフラインでキャッシュにも無い（docs や tests.html など除外したもの）
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});

// 更新バーの［更新］が押されたときだけ待機を解除する
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
