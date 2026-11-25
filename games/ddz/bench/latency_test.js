'use strict';
// bench/latency_test.js — 决策耗时分布（p50/p95/p99）与超时预算核对
//
// 关键指标：
//  · 每个难度在真实局面下的单次决策耗时分位数
//  · 超过 aiTiming.thinkingSeconds 的比例（看门狗会把这些决策当超时丢弃）
//  · 与 Worker 并行时的一致性由 worker_smoke.js 覆盖

const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'AICore', 'cfg', 'DEFAULT_PARAMS',
];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(5), null);
const { AICore, MasterMemory, DEFAULT_PARAMS } = mod;

const DIFFS = ['easy', 'medium', 'hard', 'grandmaster', 'legendary'];
const SAMPLES = Number(process.env.SAMPLES || 40);

function pct(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.floor(p * s.length));
    return s[i];
}

const rng = makeRng(31337);
const rows = [];
let overBudgetTotal = 0, totalSamples = 0;

for (const diff of DIFFS) {
    const samples = [];
    for (let g = 0; g < SAMPLES; g++) {
        const deal = makeDeal(rng);
        const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
        const players = deal.hands.map(p => p.map(c => ({ ...c })));
        players[L].push(...deal.lordCards);
        players[L].sort((a, b) => a.value - b.value);
        const memory = new MasterMemory();
        const state = {
            players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1,
            passCount: 0, baseScore: 1, phase: 'playing', lordCards: deal.lordCards,
            callScores: [0, 0, 0], firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false,
        };
        // 先走几步，让局面处于中盘（更接近真实）
        for (let t = 0; t < 4; t++) {
            const cp = state.currentPlayer;
            if (state.players[cp].length === 0) break;
            const core = new AICore(cp, diff, memory);
            let chosen;
            try { chosen = core.playDecision(state); } catch (e) { continue; }
            if (!Array.isArray(chosen) || !chosen.length) break;
            const ids = new Set(chosen.map(c => c.id));
            state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
            state.lastPlay = mod.getCardType(chosen); state.lastPlayerId = cp; state.passCount = 0;
            memory.recordPlayerPlay(cp, chosen);
            state.currentPlayer = (cp + 1) % 3;
        }
        const cp = state.currentPlayer;
        if (state.players[cp].length === 0) continue;
        const core = new AICore(cp, diff, memory);
        const t0 = process.hrtime.bigint();
        try { core.playDecision(state); } catch (e) { continue; }
        const dt = Number(process.hrtime.bigint() - t0) / 1e6;
        samples.push(dt);
    }
    const budget = ((DEFAULT_PARAMS.aiTiming.thinkingSeconds[diff] || 3) * 1000);
    const over = samples.filter(x => x > budget).length;
    overBudgetTotal += over; totalSamples += samples.length;
    rows.push({
        diff, n: samples.length,
        p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99),
        max: Math.max(...samples, 0), budgetMs: budget, over
    });
}

console.log('决策耗时（桌面 CPU，单线程，未开 Worker）：');
console.log('难度'.padEnd(14) + '样本'.padStart(6) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'max'.padStart(9) + '预算'.padStart(9) + '超时率'.padStart(9));
for (const r of rows) {
    console.log(
        r.diff.padEnd(14) + String(r.n).padStart(6) +
        r.p50.toFixed(0).padStart(9) + r.p95.toFixed(0).padStart(9) +
        r.p99.toFixed(0).padStart(9) + r.max.toFixed(0).padStart(9) +
        String(r.budgetMs).padStart(9) +
        (r.n ? (r.over / r.n * 100).toFixed(1) + '%' : '-').padStart(9)
    );
}
const rate = totalSamples ? overBudgetTotal / totalSamples : 0;
console.log(`\n整体超时率: ${(rate * 100).toFixed(2)}%  (${overBudgetTotal}/${totalSamples})`);
console.log(rate < 0.05 ? '✔ 超时率可接受（<5%）' : '✘ 超时率过高（>=5%）：看门狗会丢弃这些决策');
process.exit(rate < 0.05 ? 0 : 1);
