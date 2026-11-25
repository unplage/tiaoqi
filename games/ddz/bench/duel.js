'use strict';
// bench/duel.js — 位置级 A/B 对决基准（强度评测的主力工具）
//
// 为什么不用「整局对弈」比强度？
//   整局是极低效的测量单元：
//     · 一局里有 30~45 次决策，彼此高度相关 → 有效样本数远小于局数
//     · 局的结果被"谁先出完牌"主导，对具体着法的质量不敏感
//     · 地主多 3 张牌反而变成劣势（要出更多张），角色偏置掩盖真实差异
//   实测：750 局（22 分钟）只能把 95%CI 压到 ±3.5pt。
//
// 位置级对决把测量单元换成「一个具体的决策点」：
//   · 同一个局面，A 和 B 各选一手 → 用**同一组随机 rollout**（CRN）评估两手的价值
//   · 局面是近似独立样本 → 有效样本数 ≈ 位置数
//   · 每个样本只要 2 次决策 + 2R 次 rollout，比整局便宜一个数量级
// 实测：400 个位置 ≈ 15 秒，方差比整局小得多。
//
// 用法：
//   node bench/duel.js --a hard --b hard --positions 400 --rollouts 12
//   node bench/duel.js --fileA ai_core.js --fileB /tmp/old.js --a hard --b hard
//   node bench/duel.js --a hard --b medium --positions 2000 --rollouts 16 --jobs 8
//
// 选项：
//   --positions N   位置数（默认 400）
//   --rollouts R    每个走法的评估 rollout 次数（默认 12）
//   --jobs J        并行分片数（默认 = CPU 核数的一半）
//   --seed S        随机种子（默认 20260101）
//   --fileA/--fileB 对比的两个 ai_core.js
//   --a/--b         两个难度

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function parseArgs(argv) {
    const o = {
        fileA: 'ai_core.js', fileB: 'ai_core.js', a: 'hard', b: 'hard',
        positions: 400, rollouts: 12, seed: 20260101,
        jobs: Math.max(1, Math.min(8, Math.floor((os.cpus() || { length: 4 }).length / 2))),
        shard: -1, shards: 1, json: false, quiet: false,
        policyA: 'ai', policyB: 'ai',
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--fileA') o.fileA = argv[++i];
        else if (k === '--fileB') o.fileB = argv[++i];
        else if (k === '--a') o.a = argv[++i];
        else if (k === '--b') o.b = argv[++i];
        else if (k === '--positions') o.positions = parseInt(argv[++i], 10);
        else if (k === '--rollouts') o.rollouts = parseInt(argv[++i], 10);
        else if (k === '--seed') o.seed = parseInt(argv[++i], 10);
        else if (k === '--jobs') o.jobs = parseInt(argv[++i], 10);
        else if (k === '--shard') o.shard = parseInt(argv[++i], 10);
        else if (k === '--shards') o.shards = parseInt(argv[++i], 10);
        else if (k === '--json') o.json = true;
        else if (k === '--quiet') o.quiet = true;
        else if (k === '--policyA') o.policyA = argv[++i];
        else if (k === '--policyB') o.policyB = argv[++i];
    }
    return o;
}

// ======================== 单分片执行 ========================
function runShard(o) {
    const { loadEngine, makeDeal, makeRng } = require('./engine');
    const { loadAI } = require('./loader');

    const EVAL_SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
        'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore', 'AICore', 'cfg',
        'minBeatPower', 'typePowerOf'];
    const ref = loadAI(o.fileA, EVAL_SYMBOLS, makeRng(o.seed ^ 0x5bf03635));
    const { getAllValidPlays, getCardType, MasterMemory, AICore } = ref;

    // 确定性小预算：同参数可复现，且每次决策只要几毫秒（仍然会走 MCTS 路径）
    // 注意：**不要**把 randomFactors 清零 —— 随机因子是难度定义的一部分
    // （easy 有 50% 概率出次优手）。清零会让所有难度塌缩成同一个策略，
    // 测出来"legendary ≈ easy"，那是评测的假象不是真实结论。
    // 随机性是确定性的（seeded），不影响可复现性。
    const duelParams = {
        search: { deterministic: true, nodeBudget: 1200, mctsIterations: 40, mctsWorlds: 1 },
        blind: { worlds: { sim: { easy: 1, medium: 1, hard: 1, grandmaster: 1, legendary: 1 } } },
    };
    const engA = loadEngine({ file: o.fileA, seed: o.seed, params: duelParams });
    const engB = loadEngine({ file: o.fileB, seed: o.seed, params: duelParams });

    // 生成一个局面：随机发牌 + 随机合法出牌，直到某家的手牌进入目标区间
    function samplePosition(rng) {
        const deal = makeDeal(rng);
        const L = Math.floor(rng() * 3);
        const players = deal.hands.map(p => p.map(c => ({ ...c })));
        players[L].push(...deal.lordCards);
        players[L].sort((a, b) => a.value - b.value);
        const st = {
            players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1,
            passCount: 0, baseScore: 1, bombCount: 0, phase: 'playing', lordCards: deal.lordCards,
            callScores: [0, 0, 0], firstPlayMade: true, lordPlayCount: 1, farmerPlayed: true,
        };
        // 随机走到一个"有信息量"的局面：当前玩家手牌落在目标区间，且已经发生过出牌
        const target = 7 + Math.floor(rng() * 9);   // 7~15 张
        for (let g = 0; g < 160; g++) {
            const cp = st.currentPlayer;
            const needBeat = st.lastPlay && st.lastPlayerId !== cp;
            const plays = needBeat ? getAllValidPlays(st.players[cp], st.lastPlay) : getAllValidPlays(st.players[cp], null);
            const handLen = st.players[cp].length;
            // 停下来的条件：手牌在目标区间、已经发生过出牌、而且当前玩家有牌可出
            // （不能出牌的局面两个策略都只能过牌 → 毫无区分度）
            if (handLen >= 5 && handLen <= target && st.lastPlayerId !== -1 && plays.length > 0) break;
            if (st.passCount >= 2) { st.lastPlay = null; st.lastPlayerId = -1; st.passCount = 0; }
            if (!plays.length) { st.passCount++; st.currentPlayer = (cp + 1) % 3; continue; }
            const pick = plays[Math.floor(rng() * plays.length)];
            const ids = new Set(pick.map(c => c.id));
            st.players[cp] = st.players[cp].filter(c => !ids.has(c.id));
            st.lastPlay = getCardType(pick); st.lastPlayerId = cp; st.passCount = 0;
            st.currentPlayer = (cp + 1) % 3;
        }
        return st;
    }

    // 参考策略（裁判）：贪心 scorePlay + 与 rollout 序号绑定的固定扰动
    // 关键：同一个 rollout 序号，A 的走法和 B 的走法用**完全相同**的扰动
    // → 公共随机数（CRN），差值方差大幅下降。
    function rollout(state, startPlayer, pickerId, rolloutSeed) {
        const s = JSON.parse(JSON.stringify(state));
        let cp = startPlayer;
        const mySide = (pickerId === s.landlord) ? [pickerId] : [0, 1, 2].filter(i => i !== s.landlord);
        const mem = new MasterMemory();
        for (let step = 0; step < 45; step++) {
            for (let i = 0; i < 3; i++) if (s.players[i].length === 0) return mySide.includes(i) ? 1 : 0;
            if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
            const hand = s.players[cp];
            if (!hand || hand.length === 0) { cp = (cp + 1) % 3; continue; }
            const needBeat = s.lastPlay && s.lastPlayerId !== cp;
            const plays = needBeat ? getAllValidPlays(hand, s.lastPlay) : getAllValidPlays(hand, null);
            if (!plays.length) { s.passCount++; cp = (cp + 1) % 3; continue; }
            // 参考策略（裁判）：结构分排序 + **随机取前 K**。
            //
            // 为什么必须随机：如果裁判完全贪心，同一局面下"好棋"和"烂棋"常常导向
            // 同一个终局（后面由裁判自己把局面收拾好），两手的价值完全相同
            // —— 实测 87% 的位置是平局，legendary vs easy 只差 1.3pt，毫无区分度。
            // 随机取前 K 让后续轨迹真正依赖"这一步选了什么"，
            // 同时用 (rollout, step) 的固定哈希保证 A/B 两支用同一组随机数（CRN）。
            const minP = needBeat ? ref.minBeatPower(s.lastPlay.type, s.lastPlay.value, s.lastPlay.length) : 0;
            const scored = [];
            for (let pi = 0; pi < plays.length; pi++) {
                const p = plays[pi];
                const t = ref.getCardType(p);
                if (!t) continue;
                const pw = ref.typePowerOf(t.type, t.value, t.length);
                let sc = p.length * 4 - pw * 0.25;
                if (needBeat) { const over = pw - minP; if (over > 0) sc -= over * 0.6; }
                if (t.type === 'bomb' || t.type === 'rocket') sc -= 60;
                scored.push({ play: p, sc });
            }
            if (!scored.length) { s.passCount++; cp = (cp + 1) % 3; continue; }
            scored.sort((x, y) => y.sc - x.sc);
            const K = Math.min(3, scored.length);
            // 固定哈希：同样的 (rolloutSeed, step) 在两个分支里给出同样的下标
            let h = (rolloutSeed ^ (step * 0x9e3779b1)) >>> 0;
            h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
            h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
            h = (h ^ (h >>> 16)) >>> 0;
            // 50% / 30% / 20% 的权重（用取模实现，保证跨分支一致）
            const bucket = h % 10;
            const idx = bucket < 5 ? 0 : (bucket < 8 ? 1 : 2);
            const best = scored[Math.min(idx, K - 1)].play;
            const ids = new Set(best.map(c => c.id));
            s.players[cp] = s.players[cp].filter(c => !ids.has(c.id));
            s.lastPlay = getCardType(best); s.lastPlayerId = cp; s.passCount = 0;
            cp = (cp + 1) % 3;
        }
        // 步数耗尽 → 比我方剩余张数少才算赢
        const mySide2 = (pickerId === state.landlord) ? [pickerId] : [0, 1, 2].filter(i => i !== state.landlord);
        let myLen = 0, oppLen = 0;
        for (let i = 0; i < 3; i++) {
            const len = (s.players[i] || []).length;
            if (mySide2.includes(i)) myLen += len; else oppLen += len;
        }
        return myLen < oppLen ? 1 : 0;
    }

    // 一手棋的价值：把手牌/局面推进到该手之后，用 R 次 rollout 评估
    function valueOf(state, pid, pick, rollouts) {
        const s = JSON.parse(JSON.stringify(state));
        if (Array.isArray(pick) && pick.length > 0) {
            const ids = new Set(pick.map(c => c.id));
            s.players[pid] = s.players[pid].filter(c => !ids.has(c.id));
            s.lastPlay = getCardType(pick); s.lastPlayerId = pid; s.passCount = 0;
        } else {
            if (!(state.lastPlay && state.lastPlayerId !== pid)) return null;
            s.passCount = (state.passCount || 0) + 1;
        }
        if (s.players[pid].length === 0) return 1;
        let wins = 0;
        for (let r = 0; r < rollouts; r++) wins += rollout(s, (pid + 1) % 3, pid, r * 2654435761 + 12345);
        return wins / rollouts;
    }

    // 分片：本分片负责 [lo, hi) 个位置
    const total = o.positions;
    const lo = Math.floor(total * o.shard / o.shards);
    const hi = Math.floor(total * (o.shard + 1) / o.shards);
    const rng = makeRng((o.seed ^ (o.shard * 0x9e3779b9)) >>> 0);

    let n = 0, skipped = 0;
    let aBetter = 0, bBetter = 0, tie = 0;
    let sumA = 0, sumB = 0;
    const deltas = [];
    let illegalA = 0, illegalB = 0;

    for (let k = lo; k < hi; k++) {
        const st = samplePosition(rng);
        const pid = st.currentPlayer;
        if (!st.players[pid] || st.players[pid].length < 5) { skipped++; continue; }
        const legal = st.lastPlay && st.lastPlayerId !== pid
            ? getAllValidPlays(st.players[pid], st.lastPlay)
            : getAllValidPlays(st.players[pid], null);
        if (!legal.length) { skipped++; continue; }

        let pickA, pickB;
        // 参考策略（用于自检）：'first' = 随便出一手（最烂），'ai' = 真 AI
        const pickBy = (eng, diff, policy) => {
            if (policy === 'first') return legal[0];
            if (policy === 'last') return legal[legal.length - 1];
            return new eng.Core(pid, diff, new MasterMemory()).playDecision(st);
        };
        try { pickA = pickBy(engA, o.a, o.policyA); }
        catch (e) { illegalA++; continue; }
        try { pickB = pickBy(engB, o.b, o.policyB); }
        catch (e) { illegalB++; continue; }
        // 合法性检查：AI 不能出非法牌
        const isLegal = (p) => {
            if (!Array.isArray(p)) return false;
            if (p.length === 0) return !!(st.lastPlay && st.lastPlayerId !== pid);
            const ids = new Set(p.map(c => c.id));
            return !!legal.find(q => q.length === p.length && q.every(c => ids.has(c.id)));
        };
        if (!isLegal(pickA)) { illegalA++; continue; }
        if (!isLegal(pickB)) { illegalB++; continue; }

        const vA = valueOf(st, pid, pickA, o.rollouts);
        const vB = valueOf(st, pid, pickB, o.rollouts);
        if (vA === null || vB === null) { skipped++; continue; }
        n++;
        sumA += vA; sumB += vB;
        deltas.push(vA - vB);
        if (vA > vB + 1e-9) aBetter++;
        else if (vB > vA + 1e-9) bBetter++;
        else tie++;
    }

    return { n, skipped, aBetter, bBetter, tie, sumA, sumB, deltas, illegalA, illegalB };
}

// ======================== 统计 ========================
function pairedBootstrap(diffs, iters, seed) {
    const n = diffs.length;
    if (!n) return { mean: 0, lo: 0, hi: 0 };
    let a = seed >>> 0;
    const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const means = [];
    for (let it = 0; it < iters; it++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)];
        means.push(s / n);
    }
    means.sort((x, y) => x - y);
    return {
        mean: diffs.reduce((x, y) => x + y, 0) / n,
        lo: means[Math.floor(0.025 * means.length)],
        hi: means[Math.min(means.length - 1, Math.floor(0.975 * means.length))]
    };
}

function wilson(wins, n, z) {
    if (!n) return { lo: 0, hi: 0 };
    z = z || 1.96;
    const p = wins / n, z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ======================== 驱动 ========================
function main() {
    const o = parseArgs(process.argv.slice(2));

    // 分片模式：作为子进程运行
    if (o.shard >= 0) {
        const r = runShard(o);
        process.stdout.write(JSON.stringify(r));
        return;
    }

    const t0 = Date.now();
    const jobs = Math.max(1, Math.min(o.jobs, o.positions));
    const self = path.join(__dirname, 'duel.js');
    const children = [];

    for (let i = 0; i < jobs; i++) {
        const args = [self, '--fileA', o.fileA, '--fileB', o.fileB, '--a', o.a, '--b', o.b,
            '--positions', String(o.positions), '--rollouts', String(o.rollouts),
            '--seed', String(o.seed), '--shard', String(i), '--shards', String(jobs),
            '--policyA', o.policyA, '--policyB', o.policyB];
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        children.push(child);
    }

    let pending = children.length;
    const agg = { n: 0, skipped: 0, aBetter: 0, bBetter: 0, tie: 0, sumA: 0, sumB: 0, deltas: [], illegalA: 0, illegalB: 0 };
    for (const child of children) {
        let buf = '';
        child.stdout.on('data', (d) => { buf += d; });
        child.on('close', () => {
            try {
                const r = JSON.parse(buf);
                agg.n += r.n; agg.skipped += r.skipped;
                agg.aBetter += r.aBetter; agg.bBetter += r.bBetter; agg.tie += r.tie;
                agg.sumA += r.sumA; agg.sumB += r.sumB;
                agg.deltas = agg.deltas.concat(r.deltas);
                agg.illegalA += r.illegalA; agg.illegalB += r.illegalB;
            } catch (e) { console.error('分片解析失败:', e.message); }
            if (--pending === 0) finish();
        });
    }

    function finish() {
        const dt = (Date.now() - t0) / 1000;
        const boot = pairedBootstrap(agg.deltas, 2000, o.seed ^ 0x1234);
        const ci = wilson(agg.aBetter + agg.tie / 2, agg.n);
        const result = {
            a: o.a, b: o.b, fileA: o.fileA, fileB: o.fileB,
            positions: agg.n, skipped: agg.skipped, rollouts: o.rollouts,
            aBetter: agg.aBetter, bBetter: agg.bBetter, tie: agg.tie,
            avgA: agg.n ? agg.sumA / agg.n : 0, avgB: agg.n ? agg.sumB / agg.n : 0,
            delta: boot.mean, deltaLo: boot.lo, deltaHi: boot.hi,
            significant: boot.lo > 0 || boot.hi < 0,
            illegalA: agg.illegalA, illegalB: agg.illegalB,
            seconds: dt,
        };
        if (o.json) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
        console.log(`位置级对决：A=${o.a}${o.fileA !== o.fileB ? '(' + o.fileA + ')' : ''} vs B=${o.b}${o.fileB !== o.fileA ? '(' + o.fileB + ')' : ''}`);
        console.log(`  位置数 ${agg.n}（跳过 ${agg.skipped}）· 每手 ${o.rollouts} 次 rollout · ${jobs} 分片`);
        console.log(`  A 更优 ${agg.aBetter} · B 更优 ${agg.bBetter} · 平局 ${agg.tie}`);
        console.log(`  平均价值 A=${(result.avgA * 100).toFixed(1)}%  B=${(result.avgB * 100).toFixed(1)}%  差 ${(boot.mean * 100).toFixed(2)}pt`);
        console.log(`  配对 bootstrap 95%CI: [${(boot.lo * 100).toFixed(2)}%, ${(boot.hi * 100).toFixed(2)}%]  ${result.significant ? '✔ 显著' : '✘ 不显著'}`);
        if (agg.illegalA || agg.illegalB) console.log(`  ⚠ 非法出牌: A=${agg.illegalA} B=${agg.illegalB}`);
        console.log(`  用时 ${dt.toFixed(1)}s  (${(agg.n / dt).toFixed(0)} 位置/秒)`);
        process.exit(result.illegalA || result.illegalB ? 1 : 0);
    }
}

if (require.main === module) main();
module.exports = { parseArgs, runShard, pairedBootstrap };
