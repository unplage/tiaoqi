// sw.js - Service Worker（GitHub Pages 多项目共存安全版）
//
// 设计要点（多 PWA 同域部署时尤其重要）：
//   1. 缓存按「项目」隔离：缓存名带项目标识，不同项目绝不会共用/互删。
//   2. 激活时只清理「本项目」的旧版本缓存，绝不删除其它 PWA 的缓存。
//   3. 只拦截本项目作用域内的请求，也不会把其它项目的资源写进本项目缓存。
//   4. 缓存查找限定在本项目缓存内，避免误命中其它 PWA 的同名资源。

// ---------- 1. 动态路径与缓存命名 ----------
// sw.js 所在目录，例如 '/pintu/'
const BASE_PATH = self.location.pathname.replace(/[^/]+$/, '');
// 项目标识：'/pintu/' -> 'pintu'，'/' -> 'root'
const PROJECT_KEY = (BASE_PATH.replace(/^\/+|\/+$/g, '') || 'root').replace(/[^a-zA-Z0-9_-]/g, '-') || 'root';
// 缓存版本：静态资源变更时 +1（会自动淘汰旧版本缓存）
const CACHE_VERSION = 6;
// 本项目当前缓存
const CACHE_NAME = `pwa-cache-${PROJECT_KEY}--v${CACHE_VERSION}`;
// 本项目缓存前缀（只清理同前缀的旧版本）
const CACHE_PREFIX = `pwa-cache-${PROJECT_KEY}--v`;
// 历史版本命名规则（v1/v2 使用 'pwa-cache-<项目>-v<数字>'），仅用于清理自己的旧缓存
const LEGACY_CACHE_RE = new RegExp(`^pwa-cache-${PROJECT_KEY.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}-v\\d+$`);

// 预缓存资源列表（全部使用相对于当前 sw.js 的路径）
const PRECACHE_URLS = [
  BASE_PATH,                    // 例如 '/pintu/'
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}icons/icon.svg`,
  `${BASE_PATH}icons/icon-192.png`,
  `${BASE_PATH}icons/icon-512.png`,
  `${BASE_PATH}icons/icon-maskable-192.png`,
  `${BASE_PATH}icons/icon-maskable-512.png`,
  `${BASE_PATH}icons/icon-180.png`,
  `${BASE_PATH}icons/favicon.ico`,
];

// 静态资源扩展名（用于判断是否缓存优先）
const STATIC_EXTENSIONS = ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'eot', 'map'];

// ---------- 2. 工具函数 ----------
function isStaticResource(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return STATIC_EXTENSIONS.includes(ext);
}

function isNavigateRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.destination === 'document');
}

// 是否属于本项目作用域（避免影响同域下的其它 PWA）
function inScope(url) {
  if (BASE_PATH === '/') return true;
  const root = BASE_PATH.slice(0, -1); // '/pintu'
  return url.pathname === root || url.pathname.startsWith(BASE_PATH);
}

// 只在本项目缓存中查找
function matchOwnCache(request) {
  return caches.open(CACHE_NAME).then(cache => cache.match(request));
}

// 写入本项目缓存（失败不抛出，避免未处理的 Promise 拒绝）
function putToOwnCache(request, response) {
  const clone = response.clone();
  return caches.open(CACHE_NAME)
    .then(cache => cache.put(request, clone))
    .catch(err => console.warn('[SW] 写入缓存失败:', err));
}

// ---------- 3. 安装阶段 ----------
self.addEventListener('install', (event) => {
  console.log('[SW] 安装中，BASE_PATH =', BASE_PATH, 'CACHE =', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(err => console.warn(`预缓存失败 ${url}:`, err)))
      ))
      .then(() => self.skipWaiting()) // 立即激活
  );
});

// ---------- 4. 激活阶段（只清理当前项目的旧缓存） ----------
self.addEventListener('activate', (event) => {
  console.log('[SW] 激活中，清理范围仅限:', CACHE_PREFIX);
  event.waitUntil(
    caches.keys().then(cacheNames => Promise.all(
      cacheNames.map(cache => {
        // 仅删除：本项目的新命名规则下的旧版本
        const isOwnOldVersion = cache.startsWith(CACHE_PREFIX) && cache !== CACHE_NAME;
        // 仅删除：本项目历史命名规则下的旧版本
        const isOwnLegacy = LEGACY_CACHE_RE.test(cache);
        if (isOwnOldVersion || isOwnLegacy) {
          console.log('[SW] 删除本项目旧缓存:', cache);
          return caches.delete(cache);
        }
        // 其它 PWA / 其它应用的缓存：原样保留
        return undefined;
      })
    )).then(() => self.clients.claim()) // 立即控制所有页面
  );
});

// ---------- 5. 请求拦截 ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源 GET 请求
  if (url.origin !== location.origin || request.method !== 'GET') {
    return;
  }

  // 只处理本项目作用域内的资源（同域其它 PWA 的资源一律放行，不缓存、不拦截）
  if (!inScope(url)) {
    return;
  }

  // ----- 5.1 导航请求（HTML）：网络优先，失败回退缓存 -----
  if (isNavigateRequest(request)) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            putToOwnCache(request, networkResponse);
          }
          return networkResponse;
        })
        .catch(async () => {
          // 网络失败，尝试从本项目缓存获取
          const cachedResponse = await matchOwnCache(request);
          if (cachedResponse) {
            console.log('[SW] 离线模式，使用缓存页面:', url.pathname);
            return cachedResponse;
          }
          return new Response(
            '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>离线</title></head><body style="background:#0e1820;color:#9fb3c8;' +
            'font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;' +
            'height:100vh;margin:0;text-align:center">' +
            '<div><h1 style="color:#ffd966">📴 离线状态</h1>' +
            '<p>请检查网络连接后刷新页面。</p></div></body></html>',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // ----- 5.2 manifest：网络优先，离线回退缓存（避免更新后仍读旧清单） -----
  if (url.pathname.endsWith('manifest.json') || url.pathname.endsWith('webmanifest')) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            putToOwnCache(request, networkResponse);
          }
          return networkResponse;
        })
        .catch(() => matchOwnCache(request).then(cached =>
          cached || new Response('{}', { status: 504, headers: { 'Content-Type': 'application/json' } })
        ))
    );
    return;
  }

  // ----- 5.3 静态资源请求：缓存优先，未命中则网络请求并缓存 -----
  if (isStaticResource(url)) {
    event.respondWith(
      matchOwnCache(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            putToOwnCache(request, networkResponse);
          }
          return networkResponse;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // ----- 5.4 其他请求（如 API）默认不缓存，直接走网络 -----
  // （业务数据存储在 localStorage 中，不受影响）
});

// ---------- 6. 支持页面主动触发更新 ----------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
