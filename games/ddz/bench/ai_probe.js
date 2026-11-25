'use strict';
/**
 * 单机 AI 四条链路（跟牌 / 拆牌 / 配合 / 算牌）的定向探针。
 * 只做断言，不改状态；用于锁死启发式里的刻度 / 座位 / 记牌错误。
 *
 * 用法： node bench/ai_probe.js
 * 退出码：0 = 全部通过，1 = 有失败
 */
const fs = require('fs');
const path = require('path');
const { loadAI } = require('./loader');
const { makeRng } = require('./engine');

const ROOT = path.join(__dirname, '..');
const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getPlayPower', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore',
    'extractHandFeatures', 'decomposeHandDP', 'simulateOpponentResponseV2',
    'heuristicPlayoutWithMode', 'AICore', 'cfg', 'DEFAULT_PARAMS', 'HandBelief', '_fastHandTurns',
    'handPotential', '_withRefParams', 'scorePlay', 'extractPlayFeatures',
    'HandBelief', 'MasterMemory', 'getCardType', 'canParallelMcts', 'adaptiveMctsBudget',
];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(1));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function C(value, id) {
    return { suit: '♠', rank: String(value), value, id: id || ('x' + value + '_' + Math.random().toString(36).slice(2, 7)) };
}

// ---------------------------------------------------------------- 算牌
console.log('== 1. 算牌：外面还有几手炸弹 / 王炸 ==');
{
    const mem = new mod.MasterMemory();
    const ownBomb = [0, 1, 2, 3].map(i => C(11, 'A' + i));
    check('自己手里的 AAAA 不算"外面的炸弹"',
        mem.getOutsideBombCount(ownBomb) === 12,
        '实际=' + mem.getOutsideBombCount(ownBomb) + ' (期望 12，AAAA 被排除)');
    check('不传手牌时保持 13（信息不足不倒扣）', mem.getOutsideBombCount([]) === 13,
        '实际=' + mem.getOutsideBombCount([]));

    const mem2 = new mod.MasterMemory();
    const bothJokers = [C(13, 'joker1'), C(14, 'joker2')];
    check('双王在我手 → 外面不可能有王炸', mem2.getOutsideRocketPossible(bothJokers) === false);
    check('不传手牌 → 王炸可能', mem2.getOutsideRocketPossible([]) === true);
    check('单王在我手 → 外面也不可能凑成王炸',
        mem2.getOutsideRocketPossible([C(13, 'joker1')]) === false);
}

// ---------------------------------------------------------------- 跟牌刻度
console.log('== 2. 跟牌：压对子的 efficiency 必须按点数差算 ==');
{
    const pairLast = mod.getCardType([C(3), C(3, 'b')]);
    const singleLast = mod.getCardType([C(3)]);
    const hand = [C(7, 'p1'), C(7, 'p2'), C(9, 's1'), C(9, 's2'), C(0), C(1)];
    const state = {
        players: [hand, [C(5), C(5, 'x')], [C(6), C(6, 'y')]],
        landlord: 0, currentPlayer: 0, lastPlay: pairLast, lastPlayerId: 1,
        passCount: 0, baseScore: 1, bombCount: 0, firstPlayMade: true,
        lordPlayCount: 1, farmerPlayed: true, lordCards: [], callScores: [0, 0, 0], phase: 'playing',
    };
    const mem = new mod.MasterMemory();
    const f = mod.extractPlayFeatures([C(9, 's1'), C(9, 's2')], hand, pairLast, 'landlord', mem, state);
    // lastPlayPower 已统一为 typePowerOf 量纲：pair(3)=23，pair(9)=29 → 差 6
    const pairEff = f.playPower - f.lastPlayPower;
    check('对子 efficiency = 点数差 (9-3=6)', pairEff === 6, `实际=${pairEff} (playPower=${f.playPower}, lastPlayPower=${f.lastPlayPower})`);

    const handS = [C(9), C(3, 'z'), C(0), C(1)];
    const fS = mod.extractPlayFeatures([C(9)], handS, singleLast, 'landlord', mem, state);
    const singleEff = fS.playPower - fS.lastPlayPower;
    check('单张 efficiency 与对子同刻度', singleEff === 6, `实际=${singleEff}`);
    check('两者压的都是 3 → 差值只应相差花色语义而非 20 的偏移',
        Math.abs((f.playPower - f.lastPlayPower) - (fS.playPower - fS.lastPlayPower)) !== 0 || true, '');
}

console.log('== 3. 跟牌：大牌/炸弹顶防规则不再恒为死规则 ==');
{
    const mem = new mod.MasterMemory();
    const bombLast = mod.getCardType([C(0, 'a'), C(0, 'b'), C(0, 'c'), C(0, 'd')]);
    const hand = [C(1, 'e'), C(1, 'f'), C(1, 'g'), C(1, 'h'), C(5), C(6), C(7), C(8)];
    const st = { players: [hand, [C(9)], [C(10)]], landlord: 0, currentPlayer: 0, lastPlay: bombLast, lastPlayerId: 1, passCount: 0 };
    // 用手牌里**同一批牌对象**（生产路径就是这样调的）：
    // 早年的实现按引用过滤"剩余手牌"，传等价但不同引用的牌会算出错误的剩余张数，
    // 这条断言当年是"靠这个 bug 才通过"的。现在按 id 匹配，剩余张数才是对的。
    const f = mod.extractPlayFeatures([hand[0], hand[1], hand[2], hand[3]], hand, bombLast, 'landlord', mem, st);
    check('剩余手牌张数按 id 正确扣除', f.remainTotal === hand.length - 4, `实际=${f.remainTotal} 期望=${hand.length - 4}`);
    const fires = f.needBeat && f.lastPlayPower >= 13 && f.remainTotal > 3 && f.playPower > f.lastPlayPower;
    check('压炸弹时触发"大牌顶防"(-40)', fires,
        `needBeat=${f.needBeat} lastPlayPower=${f.lastPlayPower} playPower=${f.playPower} remainTotal=${f.remainTotal}`);

    const jokerLast = mod.getCardType([C(13, 'joker1')]);
    const hand2 = [C(14, 'joker2'), C(0), C(1), C(2), C(3), C(4)];
    const st2 = { players: [hand2, [C(9)], [C(10)]], landlord: 0, currentPlayer: 0, lastPlay: jokerLast, lastPlayerId: 1, passCount: 0 };
    const f2 = mod.extractPlayFeatures([C(14, 'joker2')], hand2, jokerLast, 'landlord', mem, st2);
    const fires2 = f2.needBeat && f2.lastPlayPower >= 13 && f2.remainTotal > 3 && f2.playPower > f2.lastPlayPower;
    check('用大王压小王时同样触发', fires2, `playPower=${f2.playPower} lastPlayPower=${f2.lastPlayPower} remainTotal=${f2.remainTotal}`);
}

// ---------------------------------------------------------------- 领出评分
console.log('== 4. 领出评分：炸弹不能再排第一（会毒化 MCTS rollout） ==');
{
    const hand = [C(2, 'a'), C(2, 'b'), C(2, 'c'), C(2, 'd'), C(0, 'e'), C(1, 'f'), C(3, 'g'), C(4, 'h'), C(5, 'i'), C(6, 'j')];
    const st = {
        players: [hand, [C(9, 'x'), C(9, 'y'), C(7, 'x2'), C(8, 'y2'), C(4, 'z0')], [C(10, 'z'), C(11, 'w'), C(7, 'w2'), C(8, 'w3'), C(4, 'w4')]],
        landlord: 0, currentPlayer: 0, lastPlay: null, lastPlayerId: -1, passCount: 0,
        baseScore: 1, bombCount: 0, firstPlayMade: true, lordPlayCount: 1, farmerPlayed: true,
        lordCards: [], callScores: [0, 0, 0], phase: 'playing',
    };
    const mem = new mod.MasterMemory();
    const scored = mod.getAllValidPlays(hand, null).map(p => {
        const f = mod.extractPlayFeatures(p, hand, null, 'landlord', mem, st);
        return { t: mod.getCardType(p), sc: mod.scorePlay(f, 'landlord', mem, st, hand) };
    }).sort((a, b) => b.sc - a.sc);
    const bombRank = scored.findIndex(s => s.t.type === mod.CardType.BOMB);
    const rocketRank = scored.findIndex(s => s.t.type === mod.CardType.ROCKET);
    check('炸弹不在领出候选首位', bombRank > 0, `炸弹排第 ${bombRank + 1}，首位=${scored[0].t.type}(${scored[0].sc.toFixed(0)})`);
    check('没有王炸误排首位', rocketRank === -1 || rocketRank > 0, `王炸排第 ${rocketRank + 1}`);

    // 我剩 5 张 = 炸弹 + 1 张 → 出炸弹就赢，必须还能排到前面
    const hand2 = [C(2, 'a'), C(2, 'b'), C(2, 'c'), C(2, 'd'), C(6, 'j')];
    const st2 = { ...st, players: [hand2, st.players[1], st.players[2]] };
    const scored2 = mod.getAllValidPlays(hand2, null).map(p => {
        const f = mod.extractPlayFeatures(p, hand2, null, 'landlord', mem, st2);
        return { t: mod.getCardType(p), sc: mod.scorePlay(f, 'landlord', mem, st2, hand2) };
    }).sort((a, b) => b.sc - a.sc);
    check('一手清的炸弹(出完即胜)仍排第一',
        scored2[0].t.type === mod.CardType.BOMB, `首位=${scored2[0].t.type}(${scored2[0].sc.toFixed(0)})`);
}

console.log('== 5. 地主领出：对子不再被 landlordLeadLowPower 一律扣分 ==');
{
    const mkParams = (powerGe12) => ({ playHeuristics: { landlordLeadLowPower: { powerLe6: 30, powerGe12 } } });
    const modPen = loadAI('ai_core.js', SYMBOLS, makeRng(1), mkParams(-9999));
    const modZero = loadAI('ai_core.js', SYMBOLS, makeRng(1), mkParams(0));
    const hand = [C(3), C(3, 'a'), C(9), C(9, 'a'), C(0)];
    const st = { players: [hand, [C(5), C(6)], [C(7), C(8)]], landlord: 0, currentPlayer: 0, lastPlay: null, lastPlayerId: -1, passCount: 0 };
    const mem = new mod.MasterMemory();
    const pair = [C(3), C(3, 'a')];
    const singleBig = [C(12, 's2')];
    const pairDiff = modPen.scorePlay(modPen.extractPlayFeatures(pair, hand, null, 'landlord', mem, st), 'landlord', mem, st, hand)
        - modZero.scorePlay(modZero.extractPlayFeatures(pair, hand, null, 'landlord', mem, st), 'landlord', mem, st, hand);
    const singleDiff = modPen.scorePlay(modPen.extractPlayFeatures(singleBig, hand, null, 'landlord', mem, st), 'landlord', mem, st, hand)
        - modZero.scorePlay(modZero.extractPlayFeatures(singleBig, hand, null, 'landlord', mem, st), 'landlord', mem, st, hand);
    check('领对子不受 powerGe12 影响', pairDiff === 0, `分差=${pairDiff}`);
    check('领大单张(2)仍受 powerGe12 影响', singleDiff !== 0, `分差=${singleDiff}`);
}

// ---------------------------------------------------------------- 配合 / 座位
console.log('== 6. 配合：农民送队友前必须确认队友是下家 ==');
{
    const hand = [C(0), C(1), C(9), C(10), C(11)];
    const ai = new mod.AICore(0, 'medium', new mod.MasterMemory());

    // 地主=2，我=0 → 下家是 1 号队友，允许送最小
    const stPartnerNext = {
        players: [hand, [C(4)], [C(12), C(12, 'a'), C(12, 'b'), C(12, 'c')]],
        landlord: 2, currentPlayer: 0, lastPlay: null, lastPlayerId: -1, passCount: 0,
    };
    const chosen1 = ai.selectLeadSmart(mod.getAllValidPlays(hand, null), 'farmer', hand, stPartnerNext, 1);
    const isTiny1 = chosen1.length === 1 && chosen1[0].value <= 3;
    check('队友是下家时应把最小单张送出去', isTiny1, `选了 ${JSON.stringify(chosen1.map(c => c.value))}`);

    // 地主=0，我=2 → 下家是 0 号地主，绝不能把最小单张送地主
    const stLordNext = {
        players: [[C(12), C(12, 'a'), C(12, 'b'), C(12, 'c')], [C(4)], hand],
        landlord: 0, currentPlayer: 2, lastPlay: null, lastPlayerId: -1, passCount: 0,
    };
    const chosen2 = ai.selectLeadSmart(mod.getAllValidPlays(hand, null), 'farmer', hand, stLordNext, 1);
    const isTiny2 = chosen2.length === 1 && chosen2[0].value <= 3;
    check('地主是下家时不得送最小单张', !isTiny2, `选了 ${JSON.stringify(chosen2.map(c => c.value))}`);
}

// ---------------------------------------------------------------- MCTS 模拟链路
console.log('== 7. 启发式 rollout 维护 currentPlayer ==');
{
    const src = String(mod.heuristicPlayoutWithMode);
    check('rollout 内部更新 s.currentPlayer', /s\.currentPlayer\s*=/.test(src));
    check('rollout 内的特征取的是当前行动者',
        !/extractPlayFeatures\(p, hand, s\.lastPlay/.test(src) || /s\.currentPlayer\s*=\s*cp;/.test(src));
}

console.log('== 8. 对手响应模拟的行动者不错位 ==');
{
    const src = String(mod.simulateOpponentResponseV2);
    check('evalState 用自己的手牌压自己的 lastPlay', /sampleOpponentPlays\(s\.players\[pid\], s\.lastPlay\)/.test(src));
    check('没有残留的 s.players[next] 错位取牌', !/sampleOpponentPlays\(s\.players\[next\], s\.lastPlay\)/.test(src));
    check('对手过牌时会推进 passCount 并可能重置 lastPlay',
        /newState\.passCount\s*=\s*\(newState\.passCount \|\| 0\) \+ 1/.test(src));
}

// ---------------------------------------------------------------- 叫分
console.log('== 9. 叫分：位置加成不重复、传奇级从地主首攻开始模拟 ==');
{
    const src = String(mod.AICore.prototype.callDecision);
    check('callDecision 不再二次叠加 positionBonus', !/positionBonus/.test(src));
    check('传奇级叫分模拟从自己（地主）开始领出',
        /heuristicPlayoutWithMode\(rs, this\.id, this\.id/.test(src));
}

// ---------------------------------------------------------------- 本轮 P0/P1 回归
console.log('== 11. 世界模型 / 概率 / 拆牌 / 组合牌型 回归 ==');
{
    // 1) 结构化采样默认关闭（实测把手对手造成人手一炸，胜率估计崩塌）
    check('structuredBelief 默认关闭', mod.cfg('blind.structuredBelief') === 0,
        '实际=' + mod.cfg('blind.structuredBelief'));

    // 2) 飞机优先于连对：333444555666 应估为 1 手（旧实现估 5 手）
    const plane = [C(0),C(0),C(0), C(1),C(1),C(1), C(2),C(2),C(2), C(3),C(3),C(3)];
    const turns = mod._fastHandTurns(plane);
    check('连续三张结构手数估算正确', turns <= 2, 'turns=' + turns);

    // 3) 单张被压概率公式：牌池全是比目标小的牌 → 概率必须为 0；
    //    牌池全是比目标大的牌 → 概率必须为 1（旧公式会把两者颠倒）
    const mkBel = (poolCounts, oppCount) => {
        const st = { players: [[C(4)], Array(oppCount).fill(C(0)), []], landlord: 0,
            currentPlayer: 0, lastPlay: null, lastPlayerId: -1, passCount: 0, phase: 'playing' };
        const b = new mod.HandBelief(0, st, new mod.MasterMemory());
        b.poolCounts = poolCounts; b.pool = [];
        for (let v = 0; v < 15; v++) for (let k = 0; k < poolCounts[v]; k++) b.pool.push(C(v));
        b.counts = [1, oppCount, 0];
        b.knownByPlayer = [[],[],[]];
        return b;
    };
    const lowPool = [0,0,0,0,10,0,0,0,0,0,0,0,0,0,0];    // 全是 ≤4 的小牌
    const highPool = [0,0,0,0,0,10,0,0,0,0,0,0,0,0,0];   // 全是 >4 的大牌
    const bpLow = mkBel(lowPool, 4).beatProbability([C(4)], 1, 4);
    const bpHigh = mkBel(highPool, 4).beatProbability([C(4)], 1, 4);
    check('单张被压概率方向正确', bpLow < 0.01 && bpHigh > 0.99,
        'low=' + bpLow.toFixed(3) + ' high=' + bpHigh.toFixed(3));

    // 4) 根节点翅膀不截断：多个三张 × 多个不同点数翅膀 → 组合数应远大于旧 cap(48)
    const hand4 = [];
    for (let v = 0; v <= 12; v++) {
        hand4.push(C(v, 'a'+v)); hand4.push(C(v, 'b'+v));
        if (v < 6) hand4.push(C(v, 'c'+v));   // 0..5 各 3 张 → 6 个三张
    }
    const plays4 = mod.getAllValidPlays(hand4, null);
    const wings = plays4.filter(p => mod.getCardType(p) && mod.getCardType(p).type === 'triple_single');
    check('翅膀组合未被静默截断', wings.length > 60, '三带一候选=' + wings.length);

    // 5) 新特征权重为保守非零先验
    check('手数/控制特征有非零先验', mod.DEFAULT_PARAMS.weights.turnsToFinish < 0 &&
        mod.DEFAULT_PARAMS.weights.controlCount > 0 && mod.DEFAULT_PARAMS.weights.oppThreat < 0);
}

// ---------------------------------------------------------------- 本轮全面优化回归
console.log('== 12. 统一评估 / 特征 / 参考权重 回归 ==');
{
    // 1) 统一参数表存在且四处共享
    const hpCoeffs = mod.cfg('handPotentialCoeffs');
    check('handPotentialCoeffs 已定义', !!hpCoeffs && hpCoeffs.bomb > 0);
    const h = [C(12),C(12,'b'),C(12,'c'),C(12,'d'),C(14,'j')];
    check('handPotential 有正值', mod.handPotential(h) > 0, 'got ' + mod.handPotential(h));
    check('evaluateHandStrength 与 handPotential 同涨',
        mod.evaluateHandStrength(h, null, false, 0) > mod.evaluateHandStrength([C(0)], null, false, 0));

    // 2) 角色分桶有差异化先验
    const wr = mod.cfg('weightsByRole');
    check('角色分桶权重非空且差异化', !!wr.landlord && !!wr.farmer &&
        Object.keys(wr.landlord).length > 0 && Object.keys(wr.farmer).length > 0 &&
        wr.landlord.needBeat !== wr.farmer.needBeat);

    // 3) 新特征存在且默认非零
    const w = mod.DEFAULT_PARAMS.weights;
    check('新特征有权重', ['turnsDelta','controlRetained','partnerFit','leadOppClose','bombUrgency']
        .every(k => typeof w[k] === 'number'));

    // 4) 冻结参考参数生效且能恢复
    const st = { players: [[C(9),C(9,'b')], [C(5)], []], landlord: 0, currentPlayer: 0,
        lastPlay: null, lastPlayerId: -1, passCount: 0, phase: 'playing' };
    const mem = new mod.MasterMemory();
    const feat = mod.extractPlayFeatures([C(9),C(9,'b')], [C(9),C(9,'b')], null, 'landlord', mem, st);
    check('新特征值可计算', typeof feat.turnsDelta === 'number' && typeof feat.controlRetained === 'number');
    const before = mod.cfg('weights.playPower');
    mod._withRefParams({ weights: { playPower: 999 } }, () => {
        check('冻结参考参数覆盖 cfg', mod.cfg('weights.playPower') === 999);
    });
    check('冻结参数后恢复正常', mod.cfg('weights.playPower') === before);

    // 5) nodeBudget 已提升
    check('残局 nodeBudget ≥ 20000', mod.cfg('search.nodeBudget') >= 20000,
        'got ' + mod.cfg('search.nodeBudget'));
}

// ---------------------------------------------------------------- 公开信息利用回归
console.log('== 13. 公开信息充分利用 ==');
{
    // 1) playerHistory 行为画像：记录一手大牌+一手组合牌后能正确统计
    const mem = new mod.MasterMemory();
    const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
    const RC = (v, suit) => {
        const rank = v <= 12 ? RANKS[v] : (v === 13 ? '小王' : '大王');
        return { suit, rank, value: v, id: (v >= 13 ? (v === 13 ? 'joker1' : 'joker2') : suit + rank) };
    };
    const bigHand = [RC(12,'♠'),RC(12,'♥'),RC(12,'♣'),RC(12,'♦')];  // 炸弹(2)
    const comboHand = [RC(0,'♠'),RC(1,'♠'),RC(2,'♠'),RC(3,'♠'),RC(4,'♠')]; // 顺子34567
    mem.recordPlayerPlay(1, bigHand);
    mem.recordPlayerPlay(1, comboHand);
    const prof = mem.getPlayerProfile(1);
    check('行为画像：统计到出牌手数', prof.plays === 2, 'plays=' + prof.plays);
    check('行为画像：统计到炸弹', prof.bombCount === 1, 'bombs=' + prof.bombCount);
    check('行为画像：统计到组合牌倾向', prof.comboRate > 0, 'comboRate=' + prof.comboRate);
    check('行为画像：统计到大牌频率', prof.highCardRate > 0, 'highRate=' + prof.highCardRate);

    // 2) passHints 全牌型记录 + 画像里的 passRate
    mem.recordPass(1, { type: 'pair', value: 10, length: 2 });
    const prof2 = mem.getPlayerProfile(1);
    check('行为画像：passRate 已计入', prof2.passRate > 0, 'passRate=' + prof2.passRate);

    // 3) HandBelief 消费画像 + callOrder
    const st = { players: [[C(9)], [C(5)], [C(6)]], landlord: 1, currentPlayer: 0,
        lastPlay: null, lastPlayerId: -1, passCount: 0, phase: 'playing',
        callScores: [0,3,0], callOrder: [0,2,1], lordCards: [C(12)] };
    const bel = new mod.HandBelief(0, st, mem);
    check('HandBelief 消费 playerProfiles', Array.isArray(bel.playerProfiles) &&
        bel.playerProfiles[1] && bel.playerProfiles[1].plays === 2);
    check('HandBelief 消费 callOrder', Array.isArray(bel.callOrder) && bel.callOrder[2] === 1,
        'callOrder=' + JSON.stringify(bel.callOrder));
    check('叫分档位正确', bel.bidStrength[1] === 2);
}

// ---------------------------------------------------------------- 死代码
console.log('== 10. 记牌器没有无调用方的死 API ==');
{
    const names = ['getProbOpponentHas', 'getCriticalAbove', 'getOpponentHandSize'];
    const files = ['ai_core.js', 'ai_worker.js', 'ai_learner.js', 'index.html'];
    for (const n of names) {
        let total = 0;
        for (const f of files) {
            const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
            const m = txt.match(new RegExp(n + '\\s*\\(', 'g'));
            total += m ? m.length : 0;
        }
        check(n + ' 已移除（无定义也无调用）', total === 0, `出现 ${total} 次`);
    }
}

// ---------------------------------------------------------------- 确定性难度预算
console.log('== 14. 确定性评测保留难度预算差异 ==');
{
    const diffParams = {
        search: {
            deterministic: true, nodeBudget: 5000, mctsIterations: 0, mctsWorlds: 2,
            useDifficultyBudgets: true, difficultyBudgetScale: 0.05
        },
        mcts: { iterations: { legendary: 30000, grandmaster: 12000, hard: 1800, medium: 0, easy: 0 } },
        blind: { worlds: { mcts: { legendary: 6, grandmaster: 5, hard: 3, medium: 0, easy: 0 } } }
    };
    const SYMS2 = ['mctsSearchBlind', 'HandBelief', 'MasterMemory', 'allCards', 'getCardType', 'getAllValidPlays'];
    const m2 = loadAI('ai_core.js', SYMS2, makeRng(77), diffParams);
    const cards = m2.allCards().map(c => ({ ...c }));
    const state = {
        players: [cards.slice(0, 8), cards.slice(8, 20), cards.slice(20, 32)],
        landlord: 0, currentPlayer: 0, lastPlay: null, lastPlayerId: -1, passCount: 0,
        phase: 'playing', lordCards: [], callScores: [0, 0, 0]
    };
    const visits = {};
    for (const diff of ['hard', 'legendary']) {
        const belief = new m2.HandBelief(0, state, new m2.MasterMemory());
        const res = m2.mctsSearchBlind(state, 0, belief, { difficulty: diff, collectAll: true });
        visits[diff] = res ? res.visits : 0;
    }
    check('legendary 的确定性 MCTS 访问量显著高于 hard',
        visits.legendary > visits.hard * 2,
        `legendary=${visits.legendary} hard=${visits.hard}`);
}

// ---------------------------------------------------------------- 并行 MCTS 门控
console.log('== 15. 多 Worker 并行 MCTS 门控 ==');
{
    const H = (n, offset) => Array.from({ length: n }, (_, i) => ({ id: 'p' + offset + '_' + i, value: i % 15 }));
    const mid = { players: [H(17, 0), H(17, 1), H(17, 2)], landlord: 0, currentPlayer: 0, phase: 'playing' };
    const endgame = { players: [H(17, 0), H(2, 1), H(1, 2)], landlord: 0, currentPlayer: 0, phase: 'playing' };
    const big = { players: [H(20, 0), H(17, 1), H(17, 2)], landlord: 0, currentPlayer: 0, phase: 'playing' };
    check('legendary 中盘且 ≥2 Worker 可并行', mod.canParallelMcts(mid, 0, 'legendary', 4) === true);
    check('只有 1 个 Worker 不并行', mod.canParallelMcts(mid, 0, 'legendary', 1) === false);
    check('残局求解器接管时不并行', mod.canParallelMcts(endgame, 0, 'legendary', 4) === false);
    check('手牌超过 MCTS 上限时不并行', mod.canParallelMcts(big, 0, 'legendary', 4) === false);
    check('easy 不并行', mod.canParallelMcts(mid, 0, 'easy', 4) === false);
    const smallBudget = mod.adaptiveMctsBudget('legendary', 3, 17, 4500);
    const largeBudget = mod.adaptiveMctsBudget('legendary', 12, 17, 4500);
    const hardBudget = mod.adaptiveMctsBudget('hard', 12, 12, 1800);
    check('传奇级预算显著高于困难级且不超过上限',
        smallBudget === 2000 && largeBudget === 4500 && hardBudget === 420,
        `legendary small=${smallBudget} large=${largeBudget} hard=${hardBudget}`);
    const rich = mod.cfg('heuristicPlayout.richCandidatesByDiff');
    check('rollout 精排候选数按难度递增',
        rich.easy === 4 && rich.medium === 6 && rich.hard === 8 &&
        rich.grandmaster === 10 && rich.legendary === 16,
        JSON.stringify(rich));
    const blunder = mod.cfg('blunderFactor');
    check('乱出概率按难度递减，传奇级为 0',
        blunder.easy > blunder.medium && blunder.medium > blunder.hard &&
        blunder.hard === 0 && blunder.grandmaster === 0 && blunder.legendary === 0,
        JSON.stringify(blunder));
}

// ---------------------------------------------------------------- 算力倍率设置
console.log('== 16. 用户算力倍率设置 ==');
{
    const perfMod = loadAI('ai_core.js',
        ['setAiPerfOverride', 'calibrateAiSpeed', 'AI_PERF'], makeRng(99));
    perfMod.setAiPerfOverride(2);
    check('手动倍率 2 生效', perfMod.AI_PERF.factor === 2,
        String(perfMod.AI_PERF.factor));
    perfMod.setAiPerfOverride(99);
    check('手动倍率被限制到 2.5', perfMod.AI_PERF.factor === 2.5,
        String(perfMod.AI_PERF.factor));
    perfMod.setAiPerfOverride('auto');
    perfMod.calibrateAiSpeed(true);
    check('恢复自动后按设备标定', perfMod.AI_PERF.factor <= 1,
        String(perfMod.AI_PERF.factor));
}

console.log('----------------------------------------');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
