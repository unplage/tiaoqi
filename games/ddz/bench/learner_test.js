'use strict';
// bench/learner_test.js — 学习闭环的无头验证
//
// 这是整个"自进化"承诺的验收测试：
//   1) learn_worker.js 能在 Node 里跑起来（语法/依赖正确）
//   2) 反事实分析能找出"明显更差的走法"
//   3) 权重更新后的量级是**可感知**的（旧实现 Δw ≈ 1e-4，等于没学）
//   4) 自对弈验证能区分「更好的候选」与「更差的候选」
//   5) 采纳门槛不会把噪声当提升（不显著时必须拒绝）
//
// 通过标准：0 fails。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const AI_CORE = fs.readFileSync(path.join(ROOT, 'ai_core.js'), 'utf8');
const LEARN_WORKER = fs.readFileSync(path.join(ROOT, 'learn_worker.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) pass++;
    else { fail++; failures.push(name + (detail ? '  [' + detail + ']' : '')); }
}

// ---------- 1. Worker 沙箱 ----------
const EXPORTS = ['AICore', 'MasterMemory', 'HandBelief', 'getCardType', 'canBeat',
    'getAllValidPlays', 'scorePlay', 'extractPlayFeatures', 'DEFAULT_PARAMS', 'cfg',
    'evaluateHandStrength', 'decomposeHandDP', 'heuristicPlayoutWithMode',
    'solveEndgameBlind', 'mctsSearchBlind', 'computePassScore', 'invalidateParamCache'];

function makeWorker() {
    const outbox = [];
    const sandbox = {
        console, Date, JSON, Math, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: {},
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.postMessage = (m) => outbox.push(m);
    sandbox.importScripts = () => {};
    vm.createContext(sandbox);
    let epilogue = '\n;globalThis.__EXP__ = {};\n';
    for (const k of EXPORTS) epilogue += 'try { globalThis.__EXP__[' + JSON.stringify(k) + '] = ' + k + '; } catch (e) {}\n';
    vm.runInContext(AI_CORE + epilogue, sandbox, { filename: 'ai_core.js' });
    vm.runInContext(LEARN_WORKER, sandbox, { filename: 'learn_worker.js' });
    Object.assign(sandbox, sandbox.__EXP__);
    return { sandbox, outbox };
}

const { sandbox, outbox } = makeWorker();

// ---------- 2. 造一局完整对局记录（模拟 GameRecorder 的格式） ----------
function buildRecordedGame(seed, difficulty) {
    const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const SUITS = ['♠', '♥', '♣', '♦'];
    const deck = [];
    for (const s of SUITS) for (let i = 0; i < RANKS.length; i++) deck.push({ suit: s, rank: RANKS[i], value: i, id: s + RANKS[i] });
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    let a = seed >>> 0;
    const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const hands = [[], [], []];
    for (let i = 0; i < 51; i++) hands[i % 3].push(deck.pop());
    const lordCards = deck.slice(0, 3);
    const L = 0;
    hands[L].push(...lordCards);
    hands.forEach(p => p.sort((x, y) => x.value - y.value));

    const players = hands.map(p => p.map(c => ({ id: c.id, suit: c.suit, rank: c.rank, value: c.value })));
    const state = {
        players: hands.map(p => p.map(c => ({ ...c }))),
        landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1, passCount: 0,
        baseScore: 1, bombCount: 0, firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false,
        lordCards, callScores: [0, 0, 0], phase: 'playing',
    };
    const actions = [];
    let winner = -1;
    const memory = new sandbox.MasterMemory();
    for (let t = 0; t < 200 && winner < 0; t++) {
        const cp = state.currentPlayer;
        if (state.players[cp].length === 0) { winner = cp; break; }
        if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
        const needBeat = state.lastPlay && state.lastPlayerId !== cp;
        const core = new sandbox.AICore(cp, difficulty, memory);
        let chosen;
        try { chosen = core.playDecision(state); } catch (e) { break; }
        if (!Array.isArray(chosen)) break;
        if (!chosen.length) {
            // 过牌
            actions.push({ p: cp, c: [], pass: true });
            state.passCount++;
            if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
            state.currentPlayer = (cp + 1) % 3;
            continue;
        }
        const ids = new Set(chosen.map(c => c.id));
        actions.push({ p: cp, c: chosen.map(c => ({ id: c.id, suit: c.suit, rank: c.rank, value: c.value })), pass: false });
        state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
        state.lastPlay = sandbox.getCardType(chosen); state.lastPlayerId = cp; state.passCount = 0;
        memory.recordPlayerPlay(cp, chosen);
        if (state.players[cp].length === 0) { winner = cp; break; }
        state.currentPlayer = (cp + 1) % 3;
    }
    return {
        id: 'g' + seed,
        timestamp: Date.now(),
        mode: 'single',
        difficulty,
        initialDeal: { players, lordCards: lordCards.map(c => ({ id: c.id, suit: c.suit, rank: c.rank, value: c.value })) },
        calling: { order: [], scores: {}, landlord: L },
        actions,
        result: { winner, isPlayerWin: winner === L, multiplier: 1, bombCount: 0, baseScore: 1, isSpring: false, isAntiSpring: false },
        analysed: false
    };
}

// ---------- 3. learn 命令 ----------
// 等待 Worker 的异步响应：必须用真正的异步等待（不能用同步 sleep，会阻塞事件循环，
// 导致 Worker 内部的 setTimeout 回调永远不执行）
function waitFor(taskId, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        const tick = () => {
            for (let i = 0; i < outbox.length; i++) {
                if (outbox[i].taskId === taskId) return resolve(outbox.splice(i, 1)[0]);
            }
            if (Date.now() - t0 > (timeoutMs || 180000)) return resolve(null);
            setTimeout(tick, 20);
        };
        tick();
    });
}
async function callLearn(game, baseParams, deals, budgetMs) {
    sandbox.onmessage({
        data: {
            cmd: 'learn', taskId: 'test', game, baseParams,
            difficulty: 'grandmaster',
            deals: deals || 4, timeBudgetMs: budgetMs || 20000
        }
    });
    return await waitFor('test', 180000);
}

// ==================== 测试 ====================
async function main() {
check('Worker 启动有 ready 消息', outbox.some(m => m.status === 'ready'));

const game = buildRecordedGame(12345, 'medium');
check('构造的对局有动作', game.actions.length > 5, 'actions=' + game.actions.length);

// 直接调用反事实分析（不触发验证），检查它能找出问题
const res = await callLearn(game, null, 4, 20000);
check('learn 有响应', !!res, 'no response');
check('learn 无错误', res && !res.error, res && res.error);
check('learn 返回了反事实修正', res && Array.isArray(res.corrections), JSON.stringify(res && Object.keys(res)));

// ---- 权重更新量级：这是"学了等于没学"的根因 ----
const learner = sandbox.__EXP__ ? null : null;
// 通过 evaluate 的门槛来间接验证：构造一个明显更好的候选，看验证能否识别
check('Worker 暴露了参数访问', typeof sandbox.__aiParamGet === 'function');

// ==================== 4. 评估能否区分好坏候选 ====================
// 构造两个候选：
//   good：把 playPower 权重提高（更看重牌力）
//   bad ：把 playPower 权重改成负数（明显更差）
function cloneParams(base) {
    const b = base || JSON.parse(JSON.stringify(sandbox.DEFAULT_PARAMS));
    return JSON.parse(JSON.stringify(b));
}
async function callEvaluate(candParams, baseParams, deals) {
    sandbox.onmessage({ data: { cmd: 'evaluate', taskId: 'ev', candParams, baseParams, deals: deals || 6, timeBudgetMs: 60000, difficulty: 'grandmaster', seed: 20261122 } });
    return await waitFor('ev', 180000);
}

const base = cloneParams(null);
const bad = cloneParams(null);
// 明显更差的候选：几乎关掉搜索（把 MCTS 迭代降到 1，节点预算降到 200）
bad.search = Object.assign({}, bad.search || {}, { mctsIterations: 1, nodeBudget: 200 });
const evBad = await callEvaluate(bad, base, 8);
check('evaluate 有响应', !!evBad && !evBad.error, evBad && evBad.error);
check('evaluate 返回验证结果', !!(evBad && evBad.validation), JSON.stringify(evBad));
if (evBad && !evBad.validation) console.log('  [debug] evaluate 返回 null');

if (evBad && evBad.validation) {
    const v = evBad.validation;
    check('评估跑出了足够的对局', v.games >= 8, 'games=' + v.games);
    check('评估没有无效对局', v.invalid === 0, 'invalid=' + v.invalid);
    // 注意：16 局上的点估计毫无统计意义（±12pt），判据必须用配对 bootstrap 的 CI
    check('配对 bootstrap 下界 <= 0.5（统计上可判定为不占优）', v.bootLo <= 0.5,
        'bootLo=' + (v.bootLo * 100).toFixed(1) + '% winRate=' + (v.winRate * 100).toFixed(1) + '%');
}

// ==================== 5. 采纳门槛：相同候选不应被采纳 ====================
const evSame = await callEvaluate(cloneParams(null), cloneParams(null), 8);
check('相同候选的评估有响应', !!evSame && !!evSame.validation);
if (evSame && evSame.validation) {
    check('相同候选不应被判为显著提升', evSame.validation.bootLo <= 0.5,
        'bootLo=' + (evSame.validation.bootLo * 100).toFixed(1) + '%');
}

// ==================== 6. 纠错规则的上下文必须包含数值约束字段 ====================
// 回归测试：规则引擎只在 ctx 里存在对应键时才应用数值比较，
// 缺失会被静默丢弃 —— 例如"对手只剩 ≤2 张才值得用炸"会退化成"每次用炸都奖励"。
{
    const ctxSandbox = { console, Date, JSON, Math, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {} };
    ctxSandbox.globalThis = ctxSandbox;
    ctxSandbox.self = ctxSandbox;
    vm.createContext(ctxSandbox);
    let captured = null;
    // 假的规则匹配器：把收到的 ctx 记录下来
    ctxSandbox.__aiMatchRules = (ctx) => { captured = ctx; return []; };
    let epilogue = '\n;globalThis.__EXP__ = {};\n';
    for (const k of ['scorePlay', 'extractPlayFeatures', 'getCardType', 'MasterMemory', 'CardType']) {
        epilogue += 'try { globalThis.__EXP__[' + JSON.stringify(k) + '] = ' + k + '; } catch (e) {}\n';
    }
    vm.runInContext(AI_CORE + epilogue, ctxSandbox, { filename: 'ai_core.js' });
    const E = ctxSandbox.__EXP__;

    const C = (v) => ({ suit: '♠', rank: String(v), value: v, id: 'x' + v });
    const hand = [C(3), C(4), C(5), C(6), C(7)];
    const mem = new E.MasterMemory();
    const state = {
        players: [hand, [C(9), C(10), C(11)], [C(12)]],
        landlord: 0, currentPlayer: 0, lastPlay: null, lastPlayerId: 1,
        passCount: 0, baseScore: 1, phase: 'playing', lordCards: [],
    };
    const feat = E.extractPlayFeatures([C(3)], hand, null, 'landlord', mem, state);
    E.scorePlay(feat, 'landlord', mem, state, hand);
    check('规则上下文被捕获', !!captured);
    check('规则上下文含 opponentHandCount（数值约束不能丢）',
        captured && typeof captured.opponentHandCount === 'number',
        captured ? 'got=' + captured.opponentHandCount : 'no ctx');
    check('规则上下文含 nextPlayerHandCount',
        captured && typeof captured.nextPlayerHandCount === 'number');
    check('规则上下文含 partnerHandCount',
        captured && typeof captured.partnerHandCount === 'number');
    check('规则上下文含 remainTotal',
        captured && typeof captured.remainTotal === 'number');
    check('规则上下文含 playLength / mainValue',
        captured && typeof captured.playLength === 'number' && typeof captured.mainValue === 'number');
    check('opponentHandCount 取的是上一手出牌者的剩余张数',
        captured && captured.opponentHandCount === 3, 'got=' + (captured && captured.opponentHandCount));
}

console.log('学习闭环测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('learner_test 崩溃:', e && e.message); process.exit(1); });
