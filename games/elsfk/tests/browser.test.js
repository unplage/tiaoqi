// 浏览器端回归测试（需要 puppeteer；未安装时自动跳过）
//
// 覆盖 issue：本地存储不可用时整个应用会卡死
//   - indexedDB.open() 挂起（既不 success 也不 error）
//   - indexedDB.open() 触发 onblocked（被其它标签页占用版本）
//   - indexedDB.open() 直接抛异常
//   - 正常情况（对照组）
//
// 断言：无论存储是否可用，启动界面都能出现、棋盘有尺寸、
//       「开始游戏」可点、左右移动按钮可点。
const path = require('path');
const fs = require('fs');

let puppeteer;
try {
    puppeteer = require('puppeteer');
} catch (e1) {
    // 允许通过 PUPPETEER_PATH 指定外部安装位置
    const extra = process.env.PUPPETEER_PATH || '/tmp';
    try { puppeteer = require(path.join(extra, 'node_modules', 'puppeteer')); } catch (e2) { }
}
if (!puppeteer) {
    console.log('\n[跳过] 未安装 puppeteer，无法运行浏览器端测试');
    console.log('       安装：npm i -D puppeteer');
    process.exit(0);
}

const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');

const scenarios = [
    { name: 'IDB 挂起（open 永不回调）', fn: () => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => ({
            open(){ return {}; }, deleteDatabase(){ return {}; } }) });
    }},
    { name: 'IDB 抛异常', fn: () => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => ({
            open(){ throw new Error('SecurityError'); } }) });
    }},
    { name: 'IDB 触发 onblocked', fn: () => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => ({
            open(){ const r={}; setTimeout(()=>{ if(r.onblocked) r.onblocked(); },50); return r; } }) });
    }},
    { name: '正常（对照）', fn: () => {} },
];

let pass = 0, fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}
const read = (page, expr) => page.evaluate((e) => { try { return eval(e); } catch (err) { return '<err>'; } }, expr);

(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'] });
    console.log('\n【浏览器】本地存储异常时应用仍可正常使用');
    for (const sc of scenarios) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.evaluateOnNewDocument(sc.fn);
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.goto(PAGE + '?nc=' + Date.now(), { waitUntil: 'load', timeout: 40000 });
        await new Promise(r => setTimeout(r, 2500));

        const board = await page.evaluate(() => document.getElementById('canvas').style.width);
        const startVisible = await page.evaluate(() => getComputedStyle(document.getElementById('startScreen')).display !== 'none');
        console.log(`  ── ${sc.name}`);

        check(`${sc.name}｜棋盘已设定尺寸`, !!board && board !== '0px', `width=${board}`);
        check(`${sc.name}｜启动界面出现`, startVisible);

        const b = await page.evaluate(() => { const q = document.getElementById('btnStart').getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
        await page.touchscreen.tap(b.x, b.y);
        await new Promise(r => setTimeout(r, 800));
        const started = await read(page, 'gameStarted');
        const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('startScreen')).display === 'none');
        check(`${sc.name}｜点「开始游戏」生效`, started === true && hidden, `started=${started} 隐藏=${hidden}`);

        const lb = await page.evaluate(() => { const q = document.getElementById('btnLeft').getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
        const x0 = await read(page, 'currentX');
        await page.touchscreen.tap(lb.x, lb.y);
        await new Promise(r => setTimeout(r, 250));
        const x1 = await read(page, 'currentX');
        check(`${sc.name}｜左移按钮生效`, x0 !== x1, `x ${x0} -> ${x1}`);

        const uncaught = errors.filter(e => !/IndexedDB|无痕|本地存储/i.test(e));
        check(`${sc.name}｜无未捕获异常`, uncaught.length === 0, uncaught.slice(0, 2).join(' ;; '));
        await page.close();
    }
    await browser.close();
    console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
    process.exit(fail ? 1 : 0);
})();
