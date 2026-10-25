// sw.js - 通用 Service Worker (适配 GitHub Pages 多项目)
// 动态确定当前应用的子目录，隔离缓存，确保离线访问正常

// ---------- 1. 动态路径与缓存名称 ----------
// 获取当前 sw.js 所在的目录路径（例如 '/pwa1/'）
const BASE_PATH = self.location.pathname.replace(/[^/]+$/, '');
// 构建带项目标识的缓存名称，避免多项目冲突
// 例如 '/ddz/' -> 'pwa-cache-ddz-v1'
const PROJECT_PREFIX = `pwa-cache${BASE_PATH.replace(/\//g, '-').replace(/--/g, '-').replace(/(^-|-$)/g, '')}`;
const CACHE_VERSION = 'v74';
const CACHE_NAME = `${PROJECT_PREFIX}${CACHE_VERSION}`;
// 允许离线使用的跨域依赖（CDN）与主机白名单
const OFFLINE_ASSET_URLS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap'
];
const CDN_HOSTS = ['cdn.tailwindcss.com','unpkg.com','fonts.googleapis.com','fonts.gstatic.com'];
// 用于 activate 阶段的精确清理：只删本项目自己的缓存（根路径下 'pwa-cache' 是其它子项目的前缀，不能用 startsWith）
const OWN_CACHE_RE = new RegExp('^' + PROJECT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'v\\d+$');

// 预缓存资源列表（全部使用相对于当前 sw.js 的路径）
const PRECACHE_URLS = [
  BASE_PATH,                 // 例如 '/pwa1/'
  `${BASE_PATH}index.html`,
  `${BASE_PATH}ai_core.js`,
  `${BASE_PATH}ai_learner.js`,
  `${BASE_PATH}ai_worker.js`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}icons/favicon.png`,
  `${BASE_PATH}icons/apple-touch-icon.png`,
  `${BASE_PATH}icons/icon-64.png`,
  `${BASE_PATH}icons/icon-128.png`,
  `${BASE_PATH}icons/icon-192.png`,
  `${BASE_PATH}icons/icon-512.png`,
  `${BASE_PATH}icons/icon-512-maskable.png`,
  ...OFFLINE_ASSET_URLS
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
          // 只删除以 'pwa-cache-' 开头且不属于当前项目的缓存
          if (cache !== CACHE_NAME && OWN_CACHE_RE.test(cache)) {
            console.log('[SW] 删除旧缓存:', cache);
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

  // 只处理 GET 请求（同源 + 必要的 CDN 资源）
  if (request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  const cdnHost = CDN_HOSTS.indexOf(url.hostname) >= 0;
  const isPrecachedExternal = OFFLINE_ASSET_URLS.indexOf(request.url) >= 0;
  if (!sameOrigin && !cdnHost) return;
  if (!sameOrigin && !isStaticResource(url) && !isPrecachedExternal) return;

  // ----- 5.1 导航请求（HTML）：网络优先，失败回退缓存 -----
  if (isNavigateRequest(request)) {
    event.respondWith(
      // 弱网/切网时 fetch 可能挂数十秒才失败；4s 内立刻回退缓存，避免联机切网瞬间长时间白屏
      Promise.race([
        fetch(request),
        new Promise((_, reject) => setTimeout(() => reject(new Error('nav-timeout')), 4000)),
      ])
        .then(networkResponse => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(async () => {
          // 网络失败，尝试从缓存获取
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            console.log('[SW] 离线模式，使用缓存页面:', url.pathname);
            return cachedResponse;
          }
          // 连缓存都没有，返回自定义离线页（可预置 offline.html）
          // 如果希望更美观，可以预缓存一个 offline.html 并在这里返回它
          return new Response(
            '<h1>📴 离线状态</h1><p>请检查网络连接后刷新页面。</p>',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // ----- 5.2 静态资源/CDN 请求：缓存优先，未命中则网络请求并缓存 -----
  if (isStaticResource(url) || isPrecachedExternal) {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then(networkResponse => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone)).catch(() => {});
          }
          return networkResponse;
        }).catch(() => {
          // 完全离线且无缓存，返回空响应（可自定义）
          return new Response('', { status: 408 });
        });
      })
    );
    return;
  }

  // ----- 5.3 其他请求（如 API）默认不缓存，直接走网络 -----
  // （业务数据通常存储在 IndexedDB 中，不受影响）
});

// ---------- 6. 消息处理（跳过等待） ----------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
