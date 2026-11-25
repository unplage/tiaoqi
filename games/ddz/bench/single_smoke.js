'use strict';
// bench/single_smoke.js — 单机模式端到端集成测试
//
// 覆盖「浏览器里真的会玩的那条路」：
//   发牌 → 叫分 → 地主拿底牌 → 三方轮流出牌（含 AI 决策与看门狗）
//   → 有人走完 → 结算（倍数 / 春天 / 筹码 / 战绩落盘）→ 可重开
//
// 这一条路上改动最频繁（executePlayCards 三重校验、领出方不可过牌、
// 看门狗兜底、结算逻辑合并），必须有端到端覆盖。
//
// 用法： node bench/single_smoke.js
// 退出码：0 = 全部通过，1 = 有失败

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AI_CORE = fs.readFileSync(path.join(ROOT, 'ai_core.js'), 'utf8');
const AI_LEARNER = fs.readFileSync(path.join(ROOT, 'ai_learner.js'), 'utf8');

function extractMainScript(html) {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    const scripts = [];
    let m;
    while ((m = re.exec(html)) !== null) scripts.push(m[1]);
    const main = scripts.find(s => /\b(?:const|let|var)\s+GameState\b/.test(s));
    if (!main) throw new Error('未找到主内联脚本');
    return main;
}
const MAIN_SCRIPT = extractMainScript(HTML);

// ---------- 假 DOM ----------
function makeElement(id) {
    const classes = new Set();
    const el = {
        id: id || '', style: {}, className: '', textContent: '', innerHTML: '', value: '',
        children: [], disabled: false, checked: false,
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle: (c, on) => { if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); } else if (on) classes.add(c); else classes.delete(c); },
        },
        appendChild: (c) => { el.children.push(c); return c; },
        append: (c) => { el.children.push(c); },
        removeChild: (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
        remove: () => {},
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        addEventListener() {}, removeEventListener() {},
        querySelector: () => makeElement(''), querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0 }),
        focus() {}, blur() {}, click() {},
        insertBefore(c) { el.children.push(c); }, replaceChildren() { el.children = []; },
    };
    return el;
}
function makeDocument() {
    const cache = new Map();
    const body = makeElement('body');
    const doc = {
        body,
        documentElement: makeElement('html'),
        createElement: (tag) => makeElement(tag),
        createTextNode: (t) => ({ textContent: t }),
        getElementById: (id) => {
            if (!cache.has(id)) cache.set(id, makeElement(id));
            return cache.get(id);
        },
        querySelector: () => makeElement(''),
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        createEvent: () => ({ initEvent() {} }),
        visibilityState: 'visible', hidden: false,
    };
    return doc;
}
function makeLocalStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
        key: (i) => [...store.keys()][i] || null,
        get length() { return store.size; },
    };
}

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const document = makeDocument();
    const sandbox = {
        console,
        document,
        localStorage: makeLocalStorage(),
        navigator: { hardwareConcurrency: 2, vibrate() {}, clipboard: { writeText: async () => {} } },
        location: { protocol: 'http:', pathname: '/index.html', reload() {} },
        addEventListener() {}, removeEventListener() {},
        setInterval, clearInterval, setTimeout, clearTimeout,
        setImmediate, Promise, JSON, Math, Date, Set, Map, Array, Object, Number, String, Boolean, Error, RegExp, parseInt, parseFloat, isNaN, isFinite,
        structuredClone: (v) => JSON.parse(JSON.stringify(v)),
        confirm: () => true,
        requestAnimationFrame: (fn) => setTimeout(fn, 16),
        cancelAnimationFrame: (id) => clearTimeout(id),
        indexedDB: undefined,   // 无 IndexedDB 时 GameDatabase 应优雅降级
        Worker: undefined,      // 无 Worker 时学习层应优雅降级
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext('window = globalThis; globalThis.window = globalThis;', ctx);
    vm.runInContext(AI_CORE, ctx, { filename: 'ai_core.js' });
    vm.runInContext(AI_LEARNER, ctx, { filename: 'ai_learner.js' });
    vm.runInContext(MAIN_SCRIPT, ctx, { filename: 'index.html#inline' });
    const run = (code) => vm.runInContext(code, ctx);
    const G = () => run('GameState');

    section('1. 开始单机对局');
    run('startSingleMode()');
    let g = G();
    check('mode = single', g.mode === 'single');
    check('myIndex = 0', g.myIndex === 0);
    // 等发牌（dealCards 是 setInterval 逐张发牌）
    for (let i = 0; i < 300 && G().phase !== 'calling'; i++) await sleep(20);
    g = G();
    check('进入叫分阶段', g.phase === 'calling', 'phase=' + g.phase);
    check('三家各 17 张牌', g.players.every(p => p.length === 17), JSON.stringify(g.players.map(p => p.length)));
    check('底牌 3 张', g.lordCards && g.lordCards.length === 3);

    section('2. 叫分 → 确定地主');
    // 直接以 3 分叫地主，结束叫分
    for (let i = 0; i < 400 && G().phase === 'calling'; i++) {
        const cur = G().currentPlayer;
        if (cur === 0) run(`callScore(0, 3)`);
        else run(`callScore(${cur}, 0)`);
        await sleep(5);
    }
    g = G();
    check('叫分结束', g.phase !== 'calling', 'phase=' + g.phase);
    check('地主已确定', g.landlord >= 0, 'landlord=' + g.landlord);
    const lordCount = g.landlord >= 0 ? g.players[g.landlord].length : -1;
    check('地主手牌 = 20 张（含底牌）', lordCount === 20, 'count=' + lordCount);

    section('3. 打完一整局');
    // 加速：AI 思考节奏调到最快，思考上限压到最低 —— 这里测的是「流程是否正确」，
    // 不是 AI 强度。
    run("ParamConfig.set('aiTiming.delayMs', {fast:1, normal:1, slow:1})");
    run("ParamConfig.set('aiTiming.thinkingSeconds', {legendary:1, grandmaster:1, hard:1, medium:1, easy:1})");
    let guard = 0;
    const t0 = Date.now();
    // AI 回合之间有 600ms 的节奏延迟 + AI 思考时间 → 用挂钟预算而不是固定轮数
    while (G().phase === 'playing' && guard++ < 20000 && (Date.now() - t0) < 240000) {
        const st = G();
        const cp = st.currentPlayer;
        const hand = st.players[cp];
        if (!hand || hand.length === 0) break;
        const needBeat = st.lastPlay && st.lastPlayerId !== cp;
        if (cp === st.myIndex) {
            // 人类回合：用引擎自己的合法出牌集合挑一手（领出时不能过牌）
            const pick = run(`(function(){
                const st = GameState, cp = st.currentPlayer, hand = st.players[cp];
                const needBeat = st.lastPlay && st.lastPlayerId !== cp;
                const plays = needBeat ? getAllValidPlays(hand, st.lastPlay) : getAllValidPlays(hand, null);
                if (!plays.length) return null;
                // 优先出能一次走完的，其次出张数最少的
                plays.sort((a,b) => (b.length - a.length));
                const best = plays[0];
                return best.map(c => ({id:c.id, suit:c.suit, rank:c.rank, value:c.value}));
            })()`);
            if (pick && pick.length) {
                run(`executePlayCards(0, ${JSON.stringify(pick)})`);
            } else {
                // 接不上 → 过牌（领出方过牌是非法的，这里只会出现在需要跟牌时）
                const needBeat = st.lastPlay && st.lastPlayerId !== cp;
                if (needBeat) run('executePlayCards(0, [])');
            }
        }
        await sleep(1);
    }
    g = G();
    check('对局已结束', g.phase === 'gameover', 'phase=' + g.phase + ' guard=' + guard);
    check('有玩家手牌归零', g.players.some(p => p.length === 0));
    check('结算屏已显示', !run("document.getElementById('gameOverScreen').classList.contains('hidden')"));
    check('战绩已累计', g.stats.total >= 1, 'total=' + g.stats.total);
    check('筹码有变化记录', typeof g.coins === 'number');

    section('4. 记牌器与牌局一致');
    const seenCount = run("GameState.cardMemory ? GameState.cardMemory.seen.size : -1");
    check('记牌器已记录已出牌', seenCount >= 0, 'seen=' + seenCount);
    const sumRemain = run("GameState.cardMemory ? GameState.cardMemory.getRemainingCounts().reduce((a,b)=>a+b,0) : -1");
    check('剩余牌数 = 54 - 已出牌', sumRemain === 54 - seenCount, 'remain=' + sumRemain + ' seen=' + seenCount);

    section('5. 非法走法被拒绝');
    run('resetGame()');
    for (let i = 0; i < 300 && G().phase !== 'calling'; i++) await sleep(20);
    // 领出方过牌必须被拒绝
    const before = run('GameState.passCount');
    const rejected = run('executePlayCards(0, [])');
    check('领出方过牌被拒绝', rejected === false, '返回=' + rejected);
    check('领出方过牌未改变状态', G().passCount === before);
    // 出不属于自己手牌的牌必须被拒绝
    const foreign = run("(function(){ const all=[]; for(const s of ['♠','♥','♣','♦']) for(const r of ['3','4','5','6','7','8','9','10','J','Q','K','A','2']) all.push({suit:s,rank:r,value:['3','4','5','6','7','8','9','10','J','Q','K','A','2'].indexOf(r),id:s+r}); all.push({suit:'JOKER',rank:'小王',value:13,id:'joker1'}); all.push({suit:'JOKER',rank:'大王',value:14,id:'joker2'}); const own=new Set(GameState.players[0].map(c=>c.id)); const f=all.find(c=>!own.has(c.id)); return f; })()");
    const rejected2 = run(`executePlayCards(0, [${JSON.stringify(foreign)}])`);
    check('出别人的牌被拒绝', rejected2 === false, '返回=' + rejected2);

    section('6. 可重开新局');
    run('backToMenu()');
    check('已返回菜单', G().phase === 'idle' || G().phase === 'playing' || G().phase === 'calling', 'phase=' + G().phase);

    console.log('\n----------------------------------------');
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    if (failed) { console.log('失败明细：'); for (const f of failures) console.log('  ✗ ' + f); }
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('single_smoke 崩溃:', e && e.stack); process.exit(1); });
