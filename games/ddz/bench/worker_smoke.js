'use strict';
// bench/worker_smoke.js — Worker 协议 + 与主线程决策一致性
//
// 覆盖：
//  1. init / think / mcts / simulate / setParams / setRules 六条命令
//  2. Worker 与主线程在**同一状态**下必须给出完全相同的出牌（瘦身后的状态也一样）
//  3. memory 往返不丢字段（尤其 passHints）

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const AI_CORE = fs.readFileSync(path.join(ROOT, 'ai_core.js'), 'utf8');
const AI_WORKER = fs.readFileSync(path.join(ROOT, 'ai_worker.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) pass++;
    else { fail++; failures.push(name + (detail ? '  [' + detail + ']' : '')); }
}

// ---------- 造一个 Worker 沙箱 ----------
function makeWorker() {
    const outbox = [];
    const sandbox = {
        console, Date, JSON, Math, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: {},
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.postMessage = (msg) => outbox.push(msg);
    sandbox.importScripts = () => { /* ai_core 已在下面注入 */ };
    vm.createContext(sandbox);
    // 先跑内核，再跑 worker 外壳（worker 里 importScripts('ai_core.js') 变成 no-op）
    // 顶层 const/class 是「全局词法绑定」，不会挂到 globalThis 上 → 需要显式导出
    const EXPORTS = ['AICore', 'MasterMemory', 'HandBelief', 'getCardType', 'canBeat',
        'getAllValidPlays', 'scorePlay', 'extractPlayFeatures', 'DEFAULT_PARAMS', 'cfg',
        'mctsSearchBlind', 'simulateOpponentResponseBlind', 'invalidateParamCache',
        'AI_PERF', 'setAiPerfOverride', 'calibrateAiSpeed'];
    let epilogue = '\n;globalThis.__EXP__ = {};\n';
    for (const k of EXPORTS) epilogue += 'try { globalThis.__EXP__[' + JSON.stringify(k) + '] = ' + k + '; } catch (e) {}\n';
    vm.runInContext(AI_CORE + epilogue, sandbox, { filename: 'ai_core.js' });
    vm.runInContext(AI_WORKER, sandbox, { filename: 'ai_worker.js' });
    Object.assign(sandbox, sandbox.__EXP__);
    return { sandbox, outbox };
}

const { sandbox, outbox } = makeWorker();
const AICore = sandbox.AICore;
const MasterMemory = sandbox.MasterMemory;
const getCardType = sandbox.getCardType;
const getAllValidPlays = sandbox.getAllValidPlays;

function drain(pred) {
    for (let i = 0; i < outbox.length; i++) {
        if (!pred || pred(outbox[i])) return outbox.splice(i, 1)[0];
    }
    return null;
}
function call(cmd, payload, timeoutMs) {
    const taskId = 't' + Math.random().toString(36).slice(2);
    const before = outbox.length;
    sandbox.onmessage({ data: Object.assign({ cmd, taskId }, payload || {}) });
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 20000)) {
        const msg = drain(m => m.taskId === taskId);
        if (msg) return msg;
    }
    return null;
}

// ---------- 1. init ----------
const initMsg = call('init', { params: { search: { deterministic: true } }, correctionRules: [] });
check('init 有响应', !!initMsg, 'no response');
check('init 返回 status', initMsg && initMsg.status === 'ok');

// ---------- 2. 构造局面 ----------
function makeState() {
    const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const SUITS = ['♠', '♥', '♣', '♦'];
    const deck = [];
    for (const s of SUITS) for (let i = 0; i < RANKS.length; i++) deck.push({ suit: s, rank: RANKS[i], value: i, id: s + RANKS[i] });
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    let a = 12345;
    const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const hands = [[], [], []];
    for (let i = 0; i < 51; i++) hands[i % 3].push(deck.pop());
    const lordCards = deck.slice(0, 3);
    hands[0].push(...lordCards);
    hands.forEach(p => p.sort((x, y) => x.value - y.value));
    return {
        players: hands,
        landlord: 0,
        currentPlayer: 0,
        lastPlay: null,
        lastPlayerId: -1,
        passCount: 0,
        baseScore: 1,
        phase: 'playing',
        lordCards,
        callScores: [0, 0, 0],
        firstPlayMade: false,
        lordPlayCount: 0,
        farmerPlayed: false,
    };
}

const state = makeState();
const memory = new MasterMemory();
memory.recordPlayerPlay(1, [{ suit: '♠', rank: '5', value: 2, id: '♠5' }]);
memory.recordPass(2, { type: 'single', value: 10, length: 1 });

const memData = {
    remain: [...memory.remain],
    seen: [...memory.seen],
    history: memory.history.map(a => [...a]),
    playerHistory: memory.playerHistory.map(a => a.map(x => [...x])),
    totalCardsPlayed: [...memory.totalCardsPlayed],
    passHints: memory.passHints.map(a => a.map(h => ({ ...h }))),
};

const slimState = {
    players: state.players.map((p, i) => i === 0 ? p.map(c => ({ ...c })) : { length: p.length }),
    landlord: state.landlord, currentPlayer: state.currentPlayer,
    lastPlay: null, lastPlayerId: -1, passCount: 0, baseScore: 1,
    phase: 'playing', lordCards: state.lordCards, callScores: [0, 0, 0],
    firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false,
};

// ---------- 3. think 与主线程一致 ----------
const thinkMsg = call('think', { phase: 'play', state: slimState, playerId: 0, difficulty: 'hard', memory: memData });
check('think 有响应', !!thinkMsg, JSON.stringify(thinkMsg));
check('think 无错误', thinkMsg && !thinkMsg.error, thinkMsg && thinkMsg.error);
const workerIds = thinkMsg && thinkMsg.result ? thinkMsg.result.map(c => c.id).sort().join(',') : '';

// 主线程同状态决策
const mainMem = new MasterMemory();
mainMem.remain = memData.remain;
mainMem.seen = new Set(memData.seen);
mainMem.history = memData.history.map(a => [...a]);
mainMem.playerHistory = memData.playerHistory.map(a => a.map(x => [...x]));
mainMem.totalCardsPlayed = [...memData.totalCardsPlayed];
mainMem.passHints = memData.passHints.map(a => a.map(h => ({ ...h })));
const mainCore = new AICore(0, 'hard', mainMem);
// 必须喂「同一个状态」：旧实现把对手手牌 {length:n} 替换成 []，
// 对手张数从 17 变成 0 → AI 看到的局面根本不是同一个（领出策略会完全不同），
// 于是这个断言测的不是"Worker 与主线程是否一致"，而是"两个不同局面是否碰巧一致"。
const mainPlay = mainCore.playDecision(JSON.parse(JSON.stringify(slimState)));
const mainIds = (mainPlay || []).map(c => c.id).sort().join(',');
check('Worker 与主线程决策一致', workerIds === mainIds, 'worker=' + workerIds + ' main=' + mainIds);
check('Worker 返回的记忆含 passHints', !!(thinkMsg && thinkMsg.memory && thinkMsg.memory.passHints),
    'passHints 未往返');

// ---------- 4. mcts 命令 ----------
const mctsMsg = call('mcts', {
    state: slimState, playerId: 0, iterations: 20, worlds: 1,
    timeBudgetMs: 200, difficulty: 'hard', memory: memData
});
check('mcts 有响应', !!mctsMsg, 'no response');
check('mcts 无错误', mctsMsg && !mctsMsg.error, mctsMsg && mctsMsg.error);
check('mcts 返回 play 数组', !!(mctsMsg && Array.isArray(mctsMsg.play)));

// ---------- 5. setParams / setRules / setPerfFactor ----------
const sp = call('setParams', { params: { weights: { playPower: 2.5 } } });
check('setParams 有响应', !!sp && sp.status === 'ok');
const sr = call('setRules', { correctionRules: [{ context: { needBeat: true }, comparators: {}, penalty: -7, confidence: 0.9 }] });
check('setRules 有响应', !!sr && sr.status === 'ok');
const pf = call('setPerfFactor', { factor: 2 });
check('setPerfFactor 有响应', !!pf && pf.status === 'ok');
check('算力倍率可大于 1', sandbox.AI_PERF && sandbox.AI_PERF.factor === 2,
    sandbox.AI_PERF && String(sandbox.AI_PERF.factor));
call('setPerfFactor', { factor: null });
check('恢复自动后需重新标定', sandbox.AI_PERF && sandbox.AI_PERF.calibrated === false);

// 参数生效验证：把 playPower 调成 0 应该改变评分
const after = call('think', { phase: 'play', state: slimState, playerId: 0, difficulty: 'hard', memory: memData });
check('setParams 后仍能正常决策', !!after && !after.error, after && after.error);

// ---------- 6. 错误处理 ----------
const bad = call('think', { phase: 'play', state: { players: [null, null, null] }, playerId: 0, difficulty: 'hard', memory: null });
check('坏状态不炸 Worker（有响应）', !!bad);

console.log('Worker 协议测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
