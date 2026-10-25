// ai_worker.js — Web Worker: 复用共享 AI 内核 ai_core.js（无 DOM / window / localStorage）
// 内核通过 importScripts 引入；本文件仅保留 Worker 专属的参数/纠错规则注入与消息处理。
importScripts('ai_core.js');

// ======================== 参数注入（供 ai_core 的 cfg() 读取） ========================
let _params = null;
function paramGet(path) {
    let parts = path.split('.');
    let val = _params;
    if (val) {
        for (let p of parts) { if (val && typeof val === 'object') val = val[p]; else { val = undefined; break; } }
        if (val !== undefined) return val;
    }
    val = DEFAULT_PARAMS;
    for (let p of parts) { val = val[p]; if (val === undefined) break; }
    return val;
}
globalThis.__aiParamGet = paramGet;

// ======================== 纠错规则 (无 localStorage) ========================
let _correctionRules = [];
const _MIN_CONFIDENCE = 0.5;
function _ruleMatches(rule, ctx) {
    for (let key in rule.context) {
        let val = rule.context[key];
        if (val === true && !ctx[key]) return false;
        if (val === false && ctx[key]) return false;
        if (typeof val === 'number' && typeof ctx[key] === 'number') {
            if (rule.comparators && rule.comparators[key] === 'lte') { if (ctx[key] > val) return false; }
            else if (rule.comparators && rule.comparators[key] === 'gte') { if (ctx[key] < val) return false; }
            else { if (ctx[key] !== val) return false; }
        }
        if (typeof val === 'string' && ctx[key] !== val) return false;
    }
    return true;
}
function _matchCorrectionRules(ctx) {
    let results = [];
    for (let rule of _correctionRules) {
        if (rule.confidence < _MIN_CONFIDENCE) continue;
        if (_ruleMatches(rule, ctx)) results.push(rule);
    }
    return results;
}
globalThis.__aiMatchRules = _matchCorrectionRules;

// ======================== Worker 消息处理 ========================
function rebuildMemory(data) {
    let m = new MasterMemory();
    if (!data) return m;
    m.remain = data.remain;
    m.seen = new Set(data.seen);
    m.history = data.history.map(arr => [...arr]);
    m.playerHistory = data.playerHistory.map(arr => arr.map(a => [...a]));
    m.totalCardsPlayed = [...data.totalCardsPlayed];
    return m;
}

function reconstructPlays(playsData) {
    if (!playsData) return [];
    return playsData.map(p => p.map(c => ({ ...c })));
}

self.onmessage = function (e) {
    const msg = e.data;
    try {
        switch (msg.cmd) {
            case 'init': {
                if (msg.params) _params = msg.params;
                if (msg.correctionRules) _correctionRules = msg.correctionRules;
                self.postMessage({ status: 'ready' });
                break;
            }
            case 'think': {
                // Worker 内也标定一次设备速度（移动端自动缩小时间预算）
                try { if (typeof calibrateAiSpeed === 'function') calibrateAiSpeed(); } catch (e) {}
                let state = msg.state;
                let memory = rebuildMemory(msg.memory);
                let ai = new AICore(msg.playerId, msg.difficulty, memory);
                let result;
                if (msg.phase === 'mcts') {
                    // 盲 MCTS：对手手牌不可见，跨可能世界聚合
                    let belief = new HandBelief(msg.playerId, state, memory);
                    let mctsResult = mctsSearchBlind(state, msg.playerId, belief, {
                        iterations: msg.iterations,
                        worlds: 3,
                        timeBudgetMs: 1000,
                        memory
                    });
                    result = mctsResult ? { play: mctsResult.play, visits: mctsResult.visits, wins: mctsResult.wins } : { play: [], visits: 0, wins: 0 };
                } else {
                    result = ai.think(msg.phase, state);
                }
                self.postMessage({
                    taskId: msg.taskId,
                    result: result,
                    memory: {
                        remain: memory.remain,
                        seen: [...memory.seen],
                        history: memory.history.map(arr => [...arr]),
                        playerHistory: memory.playerHistory.map(arr => arr.map(a => [...a])),
                        totalCardsPlayed: [...memory.totalCardsPlayed]
                    }
                });
                break;
            }
            case 'mcts': {
                let state = msg.state;
                let memory = rebuildMemory(msg.memory);
                let belief = new HandBelief(msg.playerId, state, memory);
                let mctsResult = mctsSearchBlind(state, msg.playerId, belief, {
                    iterations: msg.iterations,
                    worlds: 3,
                    timeBudgetMs: 1000,
                    memory
                });
                self.postMessage({
                    taskId: msg.taskId,
                    play: mctsResult ? mctsResult.play : [],
                    visits: mctsResult ? mctsResult.visits : 0,
                    wins: mctsResult ? mctsResult.wins : 0
                });
                break;
            }
            case 'simulate': {
                let memory = rebuildMemory(msg.memory);
                let state = msg.state;
                // 盲模拟：对手手牌不可见 → 在可能世界里推演应对
                let belief = new HandBelief(msg.playerId, state, memory);
                let worlds = belief.sampleWorlds(Math.max(1, msg.worlds || 2));
                let scores = msg.plays.map(play => {
                    let cards = play.map(c => ({ ...c }));
                    let features = extractPlayFeatures(cards, msg.hand, state.lastPlay, msg.role, memory, state);
                    let baseScore = scorePlay(features, msg.role, memory, state, msg.hand);
                    let simScore = 0;
                    if (msg.depth > 0) {
                        simScore = simulateOpponentResponseBlind(cards, msg.hand, state, msg.role, memory, belief, msg.depth, worlds);
                    }
                    return baseScore + simScore * 0.4;
                });
                self.postMessage({ taskId: msg.taskId, scores });
                break;
            }
        }
    } catch (err) {
        self.postMessage({ taskId: msg.taskId, error: err.message });
    }
};
self.postMessage({ status: 'ready' });
