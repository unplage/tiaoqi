// Service Worker 多 PWA 同源共存隔离性测试
//
// 背景：GitHub Pages 的所有项目站都部署在同一个源 https://unplage.github.io 下，
// 而 CacheStorage 是「按源」而非「按 SW」隔离的，因此每个 SW 的 activate 清理逻辑
// 必须只匹配自己的缓存，否则会删掉兄弟应用的缓存，导致它们离线失效。
//
// 本测试在 Node 中模拟 CacheStorage，然后加载各应用的 sw.js 执行其 activate 事件，
// 验证「A 应用更新 SW 时，B 应用的缓存是否被删」。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ---------------- 极简 CacheStorage 模拟 ----------------
function makeCacheStorage(seed = {}) {
    const store = new Map();
    for (const [name, urls] of Object.entries(seed)) store.set(name, new Set(urls));
    const api = {
        async open(name) {
            if (!store.has(name)) store.set(name, new Set());
            const entries = store.get(name);
            return {
                async add(url) { entries.add(String(url)); },
                async put(req) { entries.add(String(req.url || req)); },
                async match(req) {
                    const u = String(req.url || req);
                    return entries.has(u) ? { url: u, cached: true } : undefined;
                }
            };
        },
        async keys() { return [...store.keys()]; },
        async delete(name) { return store.delete(name); },
        async match(req) {
            const u = String(req.url || req);
            for (const entries of store.values()) if (entries.has(u)) return { url: u };
            return undefined;
        },
        _dump() {
            return Object.fromEntries([...store.entries()].map(([k, v]) => [k, [...v].length]));
        }
    };
    return api;
}

// ---------------- 加载并驱动一个 sw.js ----------------
async function runActivate(swSource, swPath, caches) {
    const listeners = {};
    const self = {
        location: { pathname: swPath, href: 'https://unplage.github.io' + swPath },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        skipWaiting: async () => {},
        clients: { claim: async () => {} }
    };
    const ctx = vm.createContext({
        self, location: self.location, caches, console,
        fetch: async () => ({ ok: true, status: 200, clone: () => ({}) }),
        Response: class { constructor(b, o) { this.body = b; Object.assign(this, o); } },
        Promise, URL, setTimeout, clearTimeout
    });
    vm.runInContext(swSource, ctx, { filename: swPath });
    const waiters = [];
    for (const fn of (listeners.install || [])) {
        const ev = { waitUntil: (p) => waiters.push(p) };
        fn(ev);
    }
    await Promise.all(waiters);
    waiters.length = 0;
    for (const fn of (listeners.activate || [])) {
        const ev = { waitUntil: (p) => waiters.push(p) };
        fn(ev);
    }
    await Promise.all(waiters);
    await new Promise(r => setTimeout(r, 0));
    return caches._dump();
}

// ---------------- 用例 ----------------
let pass = 0, fail = 0;
function t(name, ok, detail) {
    if (ok) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

const elsfkSw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

// 模拟同源下已存在多个 PWA 的缓存（真实部署的缓存名格式）
const SEED = {
    'pwa-cache-calculator-v5': ['/calculator/', '/calculator/index.html'],
    'pwa-cache-cfu_count-v3': ['/cfu_count/', '/cfu_count/index.html'],
    'pwa-cache-localnote1-v13': ['/localnote1/', '/localnote1/index.html'],
    'pwa-cache-tcs-v5': ['/tcs/', '/tcs/index.html'],
    'pwa-cache-dds-v3': ['/dds/', '/dds/index.html'],
    'pwa-cache-pintu-v2': ['/pintu/', '/pintu/index.html'],
    'invest-cache-invest-v3': ['/invest/', '/invest/index.html'],
    'pwa-cache-elsfk-v11': ['/elsfk/', '/elsfk/index.html']   // elsfk 自己的旧版本
};

(async () => {
    console.log('\n【隔离性】elsfk 的 SW 激活时不得删除同源其它 PWA 的缓存');
    const caches = makeCacheStorage(JSON.parse(JSON.stringify(SEED)));
    const after = await runActivate(elsfkSw, '/elsfk/sw.js', caches);

    for (const name of Object.keys(SEED)) {
        if (name === 'pwa-cache-elsfk-v11') continue;   // 自己的旧版本应该被清掉
        t(`保留 ${name}`, name in after, '被误删');
    }
    t('清理自己的旧版本 pwa-cache-elsfk-v11', !('pwa-cache-elsfk-v11' in after));
    t('新建当前版本缓存 pwa-cache-elsfk-v12', 'pwa-cache-elsfk-v12' in after);

    console.log('\n【对照】若使用通用前缀 pwa-cache- 会发生什么（模拟旧写法）');
    const bad = makeCacheStorage(JSON.parse(JSON.stringify(SEED)));
    const badSw = elsfkSw
        .replace(/const PROJECT_PREFIX = `pwa-cache\$\{BASE_PATH\.replace\(\/\\\/g, '-'\)\}`;/,
                 "const PROJECT_PREFIX = 'pwa-cache-';")
        .replace(/if \(cache\.startsWith\(PROJECT_PREFIX\)/, 'if (cache.startsWith("pwa-cache-")');
    const afterBad = await runActivate(badSw, '/elsfk/sw.js', bad);
    const wiped = Object.keys(SEED).filter(n => n.startsWith('pwa-cache-') && !(n in afterBad));
    t('通用前缀会误删兄弟应用缓存', wiped.length >= 5, `实际误删 ${wiped.length} 个: ${wiped.join(', ')}`);

    console.log('\n【隔离性】elsfk 的静态资源缓存只读自己的 cache，不跨应用命中');
    const caches2 = makeCacheStorage({
        'pwa-cache-calculator-v5': ['/shared/lib.js'],
        'pwa-cache-elsfk-v12': []
    });
    const listeners = {};
    const self = {
        location: { pathname: '/elsfk/sw.js' },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        skipWaiting: async () => {}, clients: { claim: async () => {} }
    };
    const ctx = vm.createContext({
        self, location: self.location, caches: caches2, console,
        fetch: async () => ({ ok: true, status: 200, clone: () => ({}) }),
        Response: class { constructor() {} }, Promise, URL, setTimeout
    });
    vm.runInContext(elsfkSw, ctx, { filename: '/elsfk/sw.js' });
    const res = await (async () => {
        let out = null;
        for (const fn of (listeners.fetch || [])) {
            const req = { url: 'https://unplage.github.io/shared/lib.js', method: 'GET', mode: 'no-cors', destination: 'script' };
            const ev = { request: req, respondWith: (p) => { out = p; }, waitUntil: () => {} };
            fn(ev);
        }
        return out;
    })();
    const result = res ? await res : null;
    t('不会命中其它应用的缓存条目', !result || !result.cached, '跨应用命中');

    console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
    process.exit(fail ? 1 : 0);
})();
