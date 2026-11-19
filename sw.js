/* 离线缓存：第一次打开时把整个应用存到本机，之后断网也能用。
 * 联网时浏览器会自动比对这个文件；构建时版本号变化 → 后台下载新版本 → 页面提示「立即更新」，
 * 用户点了才切换，不会在处理文件时突然刷新。用户的文件和记录从不经过这里。
 * PDF / 图片识别组件（vendor/pdfjs-*、onnxruntime-web-*、ppocr-*）很大，不在这里，由页面另存到
 * redaction-lib-* 缓存（components.js），程序更新时保留；这里只负责从那份缓存里取。
 */
const VERSION = "2026.11.18.1949";
const CACHE = `redaction-${VERSION}`;
const ASSETS = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "store.js",
  "engine/rules.js",
  "engine/word.js",
  "engine/layout.js",
  "engine/ocr.js",
  "engine/ocr-worker.js",
  "engine/pdf.js",
  "components.js",
  "components.json",
  "vendor/fflate-0.8.2.min.js",
  "manifest.webmanifest",
  "design/styles.css",
  "design/compact.css",
  "design/mobile.css",
  "design/brand-dossier.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((path) => new Request(path, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("redaction-") && !key.startsWith("redaction-lib-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const component = await caches.match(request, { ignoreSearch: true });
      if (component) return component;
      if (request.mode === "navigate") {
        const page = await cache.match("index.html");
        if (page) return page;
      }
      return fetch(request);
    }),
  );
});
