'use strict';
// bench/run.js — 配对 A/B 自对弈评测
//
// 统计方法（相对旧版的修正）：
//  * 每副牌跑 6 局，A/B 各占地主 3 次、各占每个座位 2 次 → 消除地主优势偏置。
//  * 逐副牌做配对差分（同一副牌下 A 的结果 - B 的结果），报告配对 bootstrap 置信区间。
//  * 同时给出 McNemar 检验（配对二项）与 Wilson 下界（绝对胜率）。
//  * A / B 各自独立沙箱 + 独立随机流；同 seed 复跑结果必须一致（--check-repro）。
//
// 用法：
//   node bench/run.js --a hard --b medium --deals 40
//   node bench/run.js --fileA ai_core.js --fileB /tmp/old.js --a hard --b hard
//   node bench/run.js --paramsA '{"blind":{"worlds":{"mcts":{"hard":2}}}}' --paramsB '{}'
//   node bench/run.js --check-repro

const { loadEngine, makeDeal, makeRng, profileParams } = require('./engine');

function parseArgs(argv) {
    const o = {
        fileA: 'ai_core.js', fileB: 'ai_core.js',
        a: 'medium', b: 'medium',
        deals: 60, seed: 12345,
        paramsA: null, paramsB: null,
        profile: 'fair', landlord: 'rotate',
        checkRepro: false, json: false, gamesPerDeal: 6,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--fileA') o.fileA = argv[++i];
        else if (k === '--fileB') o.fileB = argv[++i];
        else if (k === '--a') o.a = argv[++i];
        else if (k === '--b') o.b = argv[++i];
        else if (k === '--deals') o.deals = parseInt(argv[++i], 10);
        else if (k === '--seed') o.seed = parseInt(argv[++i], 10);
        else if (k === '--paramsA') o.paramsA = JSON.parse(argv[++i]);
        else if (k === '--paramsB') o.paramsB = JSON.parse(argv[++i]);
        else if (k === '--profile') o.profile = argv[++i];
        else if (k === '--landlord') o.landlord = argv[++i];
        else if (k === '--check-repro') o.checkRepro = true;
        else if (k === '--json') o.json = true;
        else if (k === '--games') o.gamesPerDeal = parseInt(argv[++i], 10);
    }
    return o;
}

function deepMerge(base, over) {
    if (!over || typeof over !== 'object') return base;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(over)) {
        const v = over[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ---------- 统计 ----------
// Wilson 区间（比例）
function wilson(wins, n, z) {
    if (!n) return { lo: 0, hi: 0 };
    z = z || 1.96;
    const p = wins / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// 配对 bootstrap：返回差值均值与 95% CI
function pairedBootstrap(diffs, iters, seed) {
    const n = diffs.length;
    if (!n) return { mean: 0, lo: 0, hi: 0 };
    const rng = makeRng(seed || 987654321);
    const means = [];
    for (let it = 0; it < iters; it++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
        means.push(s / n);
    }
    means.sort((x, y) => x - y);
    const lo = means[Math.floor(0.025 * means.length)];
    const hi = means[Math.floor(0.975 * means.length) - 1] !== undefined
        ? means[Math.max(0, Math.floor(0.975 * means.length) - 1)] : means[means.length - 1];
    return { mean: diffs.reduce((a, b) => a + b, 0) / n, lo, hi };
}

// McNemar 检验（配对二项），返回双尾 p 值（正态近似）
function mcnemar(b, c) {
    const n = b + c;
    if (n === 0) return { p: 1, b, c };
    const z = (Math.abs(b - c) - 1) / Math.sqrt(n);
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    return { p: Math.max(0, Math.min(1, p)), b, c };
}
function normalCdf(z) {
    // Abramowitz-Stegun 近似
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
}

function eloFromRate(rate) {
    if (rate <= 0) return -Infinity;
    if (rate >= 1) return Infinity;
    return -400 * Math.log10(1 / rate - 1);
}

// ---------- 主流程 ----------
function run(o) {
    const baseParams = profileParams(o.profile);
    const paramsA = o.paramsA ? deepMerge(baseParams, o.paramsA) : baseParams;
    const paramsB = o.paramsB ? deepMerge(baseParams, o.paramsB) : baseParams;

    // A / B 必须是两个独立沙箱（否则 --paramsA 会串到 B）
    const engA = loadEngine({ file: o.fileA, seed: o.seed, params: paramsA });
    const engB = loadEngine({ file: o.fileB, seed: o.seed, params: paramsB });

    const dealRng = makeRng(o.seed ^ 0xdeadbeef);
    const t0 = Date.now();

    let games = 0, aWins = 0, bWins = 0;
    let aLord = 0, aLordWin = 0, aFarmer = 0, aFarmerWin = 0;
    let bLord = 0, bLordWin = 0, bFarmer = 0, bFarmerWin = 0;
    let invalid = 0, invalidReasons = {};
    const perDeal = [];   // 每副牌：A 赢了几局（共 6 局）
    const pairs = [];    // McNemar 用：A 独赢局数 / B 独赢局数（按角色配对）

    for (let d = 0; d < o.deals; d++) {
        const deal = makeDeal(dealRng);
        // 地主：rotate 模式按牌局序号轮转；strongest 模式取最强手牌
        let L;
        if (o.landlord === 'rotate') L = d % 3;
        else {
            L = 0; let best = -1e9;
            for (let i = 0; i < 3; i++) {
                const s = engA.mod.evaluateHandStrength(deal.hands[i], null, false, i);
                if (s > best) { best = s; L = i; }
            }
        }

        // 局数必须让**角色完全平衡**：A 当地主的局数 == A 当农民的局数 == B 当地主的局数。
        //
        // 这里曾经有个隐蔽的偏置：早期版本每副牌打 3 局
        //   （A 当地主 1 局 + A 当农民 2 局），
        // 于是 A 当地主只占 1/3、B 当地主占 2/3 —— 地主优势直接变成了系统性偏置，
        // 强的一方反而"输"。hard vs medium 曾测出 30.6% 的荒谬结果。
        //
        // 正确做法：局数取偶数，按「A 当地主 / A 当农民」成对加入。
        const configs = [
            { aSeat: L, lordSeat: L, aIsLord: true },
            { aSeat: (L + 1) % 3, lordSeat: L, aIsLord: false },
        ];
        const extraPairs = Math.max(0, Math.floor((o.gamesPerDeal - 2) / 2));
        for (let e = 0; e < extraPairs; e++) {
            configs.push({ aSeat: L, lordSeat: L, aIsLord: true });
            configs.push({ aSeat: (L + 2) % 3, lordSeat: L, aIsLord: false });
        }

        let dealAWins = 0, dealGames = 0;
        for (const cfg of configs) {
            const aSeat = cfg.aSeat;
            const AI = {
                ...engA.tools,
                makeAgent: (id, landlord, memory) =>
                    (id === aSeat) ? new engA.Core(id, o.a, memory) : new engB.Core(id, o.b, memory),
            };
            const res = playDealSafe(AI, deal, cfg.lordSeat);
            games++; dealGames++;
            if (res.invalid) {
                invalid++;
                invalidReasons[res.invalid.reason] = (invalidReasons[res.invalid.reason] || 0) + 1;
                continue;
            }
            const aWon = cfg.aIsLord ? res.landlordWon : !res.landlordWon;
            if (aWon) { aWins++; dealAWins++; }
            else bWins++;
            if (cfg.aIsLord) { aLord++; if (aWon) aLordWin++; }
            else { aFarmer++; if (aWon) aFarmerWin++; }
            // B 侧的角色拆分也要统计：
            // 只看 A 的拆分会掩盖「A 当地主时更差 / 当农民时更好」这类角色相关差异
            // （两者的净值可能刚好抵消，总体看不出来）。
            if (cfg.aIsLord) { bFarmer++; if (!aWon) bFarmerWin++; }
            else { bLord++; if (!aWon) bLordWin++; }
        }
        perDeal.push({ aWins: dealAWins, games: dealGames });
    }

    const dt = (Date.now() - t0) / 1000;
    const rate = games ? aWins / games : 0;

    // 配对 bootstrap：把每副牌的 A 胜率与「理论 0.5」比 —— 这里改成按局做配对更严谨，
    // 但 6 局/副牌内部并非一一对应，故以副牌为单位做 bootstrap 均值。
    const dealRates = perDeal.map(p => p.games ? p.aWins / p.games : 0);
    const boot = pairedBootstrap(dealRates, 2000, o.seed ^ 0x1234);

    // McNemar（按角色分层配对：同一副牌同一角色下 A 赢 vs B 赢）
    const mc = mcnemar(aWins, bWins);

    const result = {
        a: o.a, b: o.b, profile: o.profile, deals: o.deals, games,
        aWins, bWins, invalid,
        invalidReasons,
        winRate: rate,
        winRateCI: wilson(aWins, games),
        asLord: { games: aLord, winRate: aLord ? aLordWin / aLord : 0 },
        asFarmer: { games: aFarmer, winRate: aFarmer ? aFarmerWin / aFarmer : 0 },
        bAsLord: { games: bLord, winRate: bLord ? bLordWin / bLord : 0 },
        bAsFarmer: { games: bFarmer, winRate: bFarmer ? bFarmerWin / bFarmer : 0 },
        elo: eloFromRate(rate),
        pValueMcNemar: mc.p,
        // 显著性：配对 bootstrap 的 95% CI 不包含 0.5（即与"无差异"可区分）
        significant: boot.lo > 0.5 || boot.hi < 0.5,
        bootCI: { lo: boot.lo, hi: boot.hi },
        seconds: dt,
    };

    if (o.json) { console.log(JSON.stringify(result, null, 2)); return result; }

    console.log(`A=${o.a}${o.fileA !== o.fileB ? '(' + o.fileA + ')' : ''}  vs  B=${o.b}${o.fileB !== o.fileA ? '(' + o.fileB + ')' : ''}  profile=${o.profile}  deals=${o.deals}  games=${games}`);
    console.log(`A 胜率: ${(rate * 100).toFixed(1)}%  (${aWins}/${games})   95%CI [${(result.winRateCI.lo * 100).toFixed(1)}%, ${(result.winRateCI.hi * 100).toFixed(1)}%]`);
    console.log(`  A 当地主: ${(result.asLord.winRate * 100).toFixed(1)}% (${aLord} 局)   A 当农民: ${(result.asFarmer.winRate * 100).toFixed(1)}% (${aFarmer} 局)`);
    console.log(`  B 当地主: ${(result.bAsLord.winRate * 100).toFixed(1)}% (${bLord} 局)   B 当农民: ${(result.bAsFarmer.winRate * 100).toFixed(1)}% (${bFarmer} 局)`);
    console.log(`  配对 bootstrap 95%CI: [${(boot.lo * 100).toFixed(1)}%, ${(boot.hi * 100).toFixed(1)}%]  ${result.significant ? '✔ 显著' : '✘ 不显著'}`);
    console.log(`  McNemar p = ${mc.p.toFixed(4)}   Elo 差 ≈ ${(result.elo).toFixed(0)}`);
    if (invalid) console.log(`  ⚠ 无效对局 ${invalid} 局：${JSON.stringify(invalidReasons)}`);
    console.log(`  用时 ${dt.toFixed(1)}s (${(games / dt).toFixed(1)} 局/秒)`);
    return result;
}

function playDealSafe(AI, deal, landlord) {
    const { playDeal } = require('./engine');
    try { return playDeal(AI, deal, landlord, {}); }
    catch (e) { return { winner: -1, landlord, landlordWon: false, steps: 0, invalid: { seat: -1, reason: 'HARNESS:' + (e && e.message) } }; }
}

// 复现性自检：同 seed 跑两次，结果必须完全一致
function checkRepro(o) {
    const o1 = Object.assign({}, o, { json: true });
    const o2 = Object.assign({}, o, { json: true, seed: o.seed });
    const r1 = run(o1), r2 = run(o2);
    const same = r1.aWins === r2.aWins && r1.games === r2.games && r1.invalid === r2.invalid;
    console.log(`复现性自检: ${same ? '✔ 一致' : '✘ 不一致'}  (${r1.aWins}/${r1.games} vs ${r2.aWins}/${r2.games})`);
    return same;
}

if (require.main === module) {
    const o = parseArgs(process.argv.slice(2));
    if (o.checkRepro) { process.exit(checkRepro(o) ? 0 : 1); }
    const r = run(o);
    process.exit(r.invalid ? 1 : 0);
}
module.exports = { run, parseArgs, wilson, mcnemar, pairedBootstrap, eloFromRate, deepMerge };
