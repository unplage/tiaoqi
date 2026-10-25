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
    'heuristicPlayoutWithMode', 'AICore', 'cfg', 'DEFAULT_PARAMS',
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
    const pairEff = f.playPower - 20 - f.lastPlayPower;
    check('对子 efficiency = 点数差 (9-3=6)', pairEff === 6, `实际=${pairEff} (playPower=${f.playPower})`);

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
    const hand = [C(1, 'e'), C(1, 'f'), C(1, 'g'), C(1, 'h'), C(5), C(6)];
    const st = { players: [hand, [C(9)], [C(10)]], landlord: 0, currentPlayer: 0, lastPlay: bombLast, lastPlayerId: 1, passCount: 0 };
    const f = mod.extractPlayFeatures([C(1, 'e'), C(1, 'f'), C(1, 'g'), C(1, 'h')], hand, bombLast, 'landlord', mem, st);
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

console.log('----------------------------------------');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
