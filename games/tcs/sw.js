// sw.js - 通用 Service Worker (适配 GitHub Pages 多项目)
// 动态确定当前应用的子目录，隔离缓存，确保离线访问正常
// v7: 玩法大更新（AI 对手/冲刺斩蛇/道具/皮肤/每日挑战），缓存版本 +1

// ---------- 1. 动态路径与缓存名称 ----------
// 获取当前 sw.js 所在的目录路径（例如 '/tcs/'）
const BASE_PATH = self.location.pathname.replace(/[^/]+$/, '');
// 把作用域路径转成安全的标识片段（'/tcs/' -> '-tcs-'）
const SCOPE_SLUG = BASE_PATH.replace(/\//g, '-');
// 本应用缓存名的公共前缀（例如 'pwa-cache-tcs-'）
const CACHE_PREFIX = `pwa-cache${SCOPE_SLUG}`;
// 缓存版本号：内容或逻辑变化时 +1，旧版本会在激活阶段被清理
const CACHE_VERSION = 'v7';
// 当前使用的缓存名（例如 'pwa-cache-tcs-v6'）
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
// 只匹配「本应用自己」产生的缓存（如 pwa-cache-tcs-v1 / v2 ...）
// 注意：结尾锚定 v\\d+，避免误伤 pwa-cache-tcs-sub-v1 这类子路径项目的缓存
const OWN_CACHE_RE = new RegExp(`^pwa-cache${escapeRegExp(SCOPE_SLUG)}v\\d+$`);

// 预缓存资源列表（全部使用相对于当前 sw.js 的路径）
const PRECACHE_URLS = [
  BASE_PATH,                 // 例如 '/tcs/'
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}icon.svg`,
  `${BASE_PATH}icon-192.png`,
  `${BASE_PATH}icon-512.png`,
  `${BASE_PATH}icon-maskable-192.png`,
  `${BASE_PATH}icon-maskable-512.png`,
  `${BASE_PATH}apple-touch-icon.png`,
  `${BASE_PATH}favicon.ico`,
];

// 外部静态资源（离线时从缓存读取，保证图标字体不丢失）
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-regular-400.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-brands-400.woff2',
];

// 静态资源扩展名（用于判断是否缓存优先）
const STATIC_EXTENSIONS = ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'ico'];

// ---------- 2. 工具函数 ----------
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isStaticResource(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return STATIC_EXTENSIONS.includes(ext);
}

function isNavigateRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.destination === 'document');
}

// 判断某个缓存是否确实属于本应用：其内部资源的路径都位于 BASE_PATH 之下
async function isOwnCache(name) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    return keys.every(req => {
      try {
        return new URL(req.url).pathname.startsWith(BASE_PATH);
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return false;
  }
}

// ---------- 3. 安装阶段 ----------
self.addEventListener('install', (event) => {
  console.log('[SW] 安装中，BASE_PATH =', BASE_PATH);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 预缓存资源:', PRECACHE_URLS);
        const local = PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn(`预缓存失败 ${url}:`, err))
        );
        const external = EXTERNAL_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn(`外部资源预缓存失败 ${url}:`, err))
        );
        // 使用 allSettled 忽略单个资源失败
        return Promise.allSettled([...local, ...external]);
      })
      .then(() => self.skipWaiting()) // 立即激活
  );
});

// ---------- 4. 激活阶段（只清理本项目自己的旧缓存） ----------
self.addEventListener('activate', (event) => {
  console.log('[SW] 激活中...');
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      for (const cache of cacheNames) {
        if (cache === CACHE_NAME) continue;
        // 只处理本应用命名空间内的缓存，其它 PWA 的缓存一律不动
        if (!OWN_CACHE_RE.test(cache)) continue;
        // 二次校验：缓存内容必须全部属于本作用域
        if (!(await isOwnCache(cache))) continue;
        console.log('[SW] 删除旧缓存:', cache);
        await caches.delete(cache);
      }
    })().then(() => self.clients.claim()) // 立即控制所有页面
  );
});

// ---------- 5. 请求拦截 ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ----- 5.1 跨域资源：仅处理已知的外部静态资源，离线时回退缓存 -----
  if (url.origin !== location.origin) {
    if (request.method === 'GET' && EXTERNAL_ASSETS.includes(url.href)) {
      event.respondWith(
        caches.open(CACHE_NAME)
          .then(cache => cache.match(request))
          .then(cachedResponse => {
            if (cachedResponse) return cachedResponse;
            return fetch(request).then(networkResponse => {
              if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
              }
              return networkResponse;
            });
          })
      );
    }
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  // 只处理本应用作用域内的请求（同源下其它项目直接走网络）
  if (!url.pathname.startsWith(BASE_PATH)) {
    return;
  }

  // ----- 5.2 导航请求（HTML）：网络优先，失败回退缓存 -----
  if (isNavigateRequest(request)) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request.url, responseClone));
          }
          return networkResponse;
        })
        .catch(async () => {
          // 网络失败，尝试从缓存获取
          const cache = await caches.open(CACHE_NAME);
          const cachedResponse = await cache.match(request.url) || await cache.match(BASE_PATH);
          if (cachedResponse) {
            console.log('[SW] 离线模式，使用缓存页面:', url.pathname);
            return cachedResponse;
          }
          // 连缓存都没有，返回自定义离线页
          return new Response(
            '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>离线</title>' +
            '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0f1e;color:#fff;font-family:system-ui,sans-serif;text-align:center">' +
            '<div><h1 style="font-size:3rem;margin:0">📴</h1><p>离线状态，请检查网络连接后刷新页面。</p></div></body></html>',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // ----- 5.3 静态资源请求：缓存优先，未命中则网络请求并缓存 -----
  if (isStaticResource(url)) {
    event.respondWith(
      caches.open(CACHE_NAME)
        .then(cache => cache.match(request))
        .then(cachedResponse => {
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
            // 完全离线且无缓存，返回空响应（可自定义）
            return new Response('', { status: 408 });
          });
        })
    );
    return;
  }

  // ----- 5.4 其他请求（如 API）默认不缓存，直接走网络 -----
  // （业务数据存储在 localStorage 中，不受影响）
});
