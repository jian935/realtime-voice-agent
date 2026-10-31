// 极简 Service Worker：离线缓存静态资源，保证演示页可装到桌面并弱网可用。
// 采用「网络优先」策略：优先取服务器最新文件，断网时才回退到缓存 —— 避免开发期改了代码却一直显示旧版。
const CACHE = 'va-cache-v2'; // 升版本号：清掉旧的 va-cache-v1（其中缓存了改版前的旧 app.js）
const ASSETS = [
  './',
  './landing.html',
  './demo.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  self.skipWaiting(); // 立即激活新 SW，不等旧页面关闭
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 仅处理同源 GET 静态资源；API 请求一律走网络
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      // 网络成功：返回最新内容，并顺手更新缓存（断网时可用）
      if (res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./landing.html')))
  );
});
