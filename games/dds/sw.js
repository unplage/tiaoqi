// sw.js - 通用 Service Worker (适配 GitHub Pages 多项目)
// 动态确定当前应用的子目录，隔离缓存，确保离线访问正常

// ---------- 1. 动态路径与缓存名称 ----------
// 获取当前 sw.js 所在的目录路径（例如 '/pwa1/'）
const BASE_PATH = self.location.pathname.replace(/[^/]+$/, '');
// 由自身路径推导项目标识（'/pwa1/' -> 'pwa1'，根目录 -> 'root'）
const PROJECT = BASE_PATH.replace(/\//g, '') || 'root';
// 缓存命名：pwa-cache-<项目>--v<版本>，只用本项目前缀做清理
const VERSION = 'v5';
const OWN_CACHE_PREFIX = `pwa-cache-${PROJECT}--`;
const CACHE_NAME = `${OWN_CACHE_PREFIX}${VERSION}`;
// 旧版命名（本项目 v4 及以前）仅清理这一条，避免留下垃圾缓存
const LEGACY_CACHE_NAME = `pwa-cache${BASE_PATH.replace(/\//g, '-')}v4`;

// 预缓存资源列表（全部使用相对于当前 sw.js 的路径）
const PRECACHE_URLS = [
  BASE_PATH,                 // 例如 '/pwa1/'
  `${BASE_PATH}index.html`,
  `${BASE_PATH}styles.css`,
  `${BASE_PATH}app.js`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}favicon.ico`,
  `${BASE_PATH}icons/favicon.svg`,
  `${BASE_PATH}icons/icon-192.png`,
  `${BASE_PATH}icons/icon-512.png`,
  `${BASE_PATH}icons/icon-maskable-192.png`,
  `${BASE_PATH}icons/icon-maskable-512.png`,
  `${BASE_PATH}icons/apple-touch-icon.png`,
];

// 静态资源扩展名（用于判断是否缓存优先）
const STATIC_EXTENSIONS = ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'ico'];

// ---------- 2. 工具函数 ----------
function isStaticResource(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return STATIC_EXTENSIONS.includes(ext);
}

function isNavigateRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.destination === 'document');
}

// 只处理本项目作用域内的请求，避免把其它 PWA 的资源写进本项目缓存
function isInScope(url) {
  return url.pathname.startsWith(BASE_PATH);
}

// 缓存查找限定在本项目当前缓存内，避免误命中其它 PWA 的同名资源
function matchOwnCache(request, options) {
  return caches.open(CACHE_NAME).then(cache => cache.match(request, options));
}

// ---------- 3. 安装阶段 ----------
self.addEventListener('install', (event) => {
  console.log('[SW] 安装中，BASE_PATH =', BASE_PATH);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 预缓存资源:', PRECACHE_URLS);
        // 使用 allSettled 忽略单个资源失败
        return Promise.allSettled(
          PRECACHE_URLS.map(url => cache.add(url).catch(err => console.warn(`预缓存失败 ${url}:`, err)))
        );
      })
      .then(() => self.skipWaiting()) // 立即激活
  );
});

// ---------- 4. 激活阶段（只清理当前项目的旧缓存） ----------
self.addEventListener('activate', (event) => {
  console.log('[SW] 激活...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          // 只删除本项目前缀的旧版本缓存，绝不碰其它 PWA 的缓存
          const isOldOwnCache = cache.startsWith(OWN_CACHE_PREFIX) && cache !== CACHE_NAME;
          const isLegacyOwnCache = cache === LEGACY_CACHE_NAME && cache !== CACHE_NAME;
          if (isOldOwnCache || isLegacyOwnCache) {
            console.log('[SW] 删除本项目旧缓存:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim()) // 立即控制所有页面
  );
});

// ---------- 5. 请求拦截 ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源 GET 请求，且仅限本项目作用域
  if (url.origin !== location.origin || request.method !== 'GET' || !isInScope(url)) {
    return;
  }

  // ----- 5.1 导航请求（HTML）：网络优先，失败回退缓存 -----
  if (isNavigateRequest(request)) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(async () => {
          // 网络失败，尝试从缓存获取
          const cachedResponse = await matchOwnCache(request, { ignoreSearch: true });
          if (cachedResponse) {
            console.log('[SW] 离线模式，使用缓存页面:', url.pathname);
            return cachedResponse;
          }
          // 连缓存都没有，返回自定义离线页
          return new Response(
            '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>离线</title><style>body{margin:0;height:100vh;display:grid;place-items:center;' +
            'background:#0d2036;color:#fff;font-family:system-ui,sans-serif;text-align:center}' +
            'h1{font-size:3rem;margin:0 0 8px}</style></head>' +
            '<body><div><h1>📴</h1><p>当前离线，且尚未缓存该页面。<br>联网后再打开一次即可离线游玩。</p></div></body></html>',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // ----- 5.2 静态资源请求：缓存优先，未命中则网络请求并缓存 -----
  if (isStaticResource(url)) {
    event.respondWith(
      matchOwnCache(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          }
          return networkResponse;
        }).catch(() => {
          // 完全离线且无缓存，返回空响应
          return new Response('', { status: 408 });
        });
      })
    );
    return;
  }

  // ----- 5.3 其他请求（如 API）默认不缓存，直接走网络 -----
});

// ---------- 6. 与页面通信：提示有新版本 ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
