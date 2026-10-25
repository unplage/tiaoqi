// sw.js - 通用 Service Worker (适配 GitHub Pages 多项目)
// 动态确定当前应用的子目录，隔离缓存，确保离线访问正常

// ---------- 1. 动态路径与缓存名称 ----------
// 获取当前 sw.js 所在的目录路径（例如 '/pwa1/'）
const BASE_PATH = self.location.pathname.replace(/[^/]+$/, '');
// 项目级缓存前缀：必须包含自身路径，否则会误删同源下其它 PWA 的缓存
// 例如 '/elsfk/' -> 'pwa-cache-elsfk-'
const PROJECT_PREFIX = `pwa-cache${BASE_PATH.replace(/\//g, '-')}`;
const CACHE_VERSION = 'v12';
const CACHE_NAME = `${PROJECT_PREFIX}${CACHE_VERSION}`;

// 预缓存资源列表（全部使用相对于当前 sw.js 的路径）
const PRECACHE_URLS = [
  BASE_PATH,                 // 例如 '/pwa1/'
  `${BASE_PATH}index.html`,
  `${BASE_PATH}offline.html`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}icons/icon-192.png`,
  `${BASE_PATH}icons/icon-512.png`,
  `${BASE_PATH}icons/maskable-192.png`,
  `${BASE_PATH}icons/maskable-512.png`,
  `${BASE_PATH}icons/apple-touch-icon.png`,
  `${BASE_PATH}icons/favicon.svg`,
  `${BASE_PATH}icons/favicon.ico`,
  `${BASE_PATH}icons/favicon-32.png`,
];

// 静态资源扩展名（用于判断是否缓存优先）
const STATIC_EXTENSIONS = ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'ico', 'json', 'webmanifest'];

// ---------- 2. 工具函数 ----------
function isStaticResource(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return STATIC_EXTENSIONS.includes(ext);
}

function isNavigateRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.destination === 'document');
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
  console.log('[SW] 激活中...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          // 只删除「本项目自己的历史版本」缓存。
          // 注意：CacheStorage 是按源（origin）共享的，若用通用前缀如 'pwa-cache-'
          // 过滤，会把同源下其它 PWA（/calculator/、/tcs/…）的缓存一并删掉，
          // 导致那些应用在离线时无法打开。
          if (cache.startsWith(PROJECT_PREFIX) && cache !== CACHE_NAME) {
            console.log('[SW] 删除旧缓存:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim()) // 立即控制所有页面
  );
});

// 允许页面主动触发新版本接管
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ---------- 5. 请求拦截 ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源 GET 请求
  if (url.origin !== location.origin || request.method !== 'GET') {
    return;
  }

  // ----- 5.1 导航请求（HTML）：缓存优先 + 后台更新（离线秒开） -----
  if (isNavigateRequest(request)) {
    const cachePromise = caches.open(CACHE_NAME);
    // 后台静默更新：先发起网络请求，用 waitUntil 保住 SW 生命周期
    const networkPromise = fetch(request)
      .then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          cachePromise.then(cache => cache.put(request, networkResponse.clone()));
        }
        return networkResponse;
      })
      .catch(() => null);
    // 必须在事件派发期间同步调用 waitUntil，否则会抛 InvalidStateError
    event.waitUntil(networkPromise);

    event.respondWith((async () => {
      const cache = await cachePromise;
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const networkResponse = await networkPromise;
      if (networkResponse) return networkResponse;
      // 彻底离线且无缓存 -> 返回离线页
      const offline = await cache.match(`${BASE_PATH}offline.html`);
      if (offline) return offline;
      return new Response(
        '<h1>📴 离线状态</h1><p>请检查网络连接后刷新页面。</p>',
        { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })());
    return;
  }

  // ----- 5.2 静态资源请求：缓存优先，未命中则网络请求并缓存 -----
  if (isStaticResource(url)) {
    event.respondWith((async () => {
      // 只查本项目自己的缓存，避免读到同源其它 PWA 写入的条目
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) return cachedResponse;
      const networkResponse = await fetch(request);
      if (networkResponse && networkResponse.status === 200) {
        // 放在 respondWith 的 Promise 链内，SW 生命周期会被自动保活
        await cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })().catch(() => {
      // 完全离线且无缓存，返回空响应（可自定义）
      return new Response('', { status: 408 });
    }));
    return;
  }

  // ----- 5.3 其他请求（如 API）默认不缓存，直接走网络 -----
  // （业务数据通常存储在 IndexedDB 中，不受影响）
});
