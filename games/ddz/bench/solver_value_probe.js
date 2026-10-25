'use strict';
// Quantifies solver decision quality: exact god-view value of solver's pick vs heuristic's pick.
const { loadAI } = require('./loader');
const { makeRng } = require('./engine');

const SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory', 'evaluateHandStrength', 'AICore', 'MiniMasterAI', 'endgameValue', 'solveEndgame'];

const solverParams = { endgameThresholds: { legendary: 17, grandmaster: 17, hard: 17, medium: 17, easy: 17 } };
const heuristicOnly = { endgameThresholds: { legendary: 17, grandmaster: 17, hard: 17, medium: 17, easy: 17 }, endgame: { maxTotalCards: -1 } };

const S = loadAI('ai_core.js', SYMBOLS, makeRng(1), solverParams);
const H = loadAI('ai_core.js', SYMBOLS, makeRng(2), heuristicOnly);

function makeDeck(rng) {
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const deck = [];
    for (const suit of suits) for (let i = 0; i < ranks.length; i++) deck.push({ suit, rank: ranks[i], value: i, id: suit + ranks[i] });
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
}

function sampleState(rng) {
    const deck = makeDeck(rng);
    const total = 6 + Math.floor(rng() * 13); // 6..18
    const sizes = [1, 1, 1];
    let left = total - 3;
    while (left > 0) { sizes[Math.floor(rng() * 3)]++; left--; }
    const hands = [[], [], []];
    for (let i = 0; i < total; i++) hands[i % 3].push(deck.pop());
    // rebalance to sizes
    const pool = [];
    for (let i = 0; i < 3; i++) { while (hands[i].length > sizes[i]) pool.push(hands[i].pop()); }
    for (let i = 0; i < 3; i++) { while (hands[i].length < sizes[i]) hands[i].push(pool.pop()); }
    hands.forEach(h => h.sort((a, b) => a.value - b.value));

    const landlord = Math.floor(rng() * 3);
    const cp = Math.floor(rng() * 3);
    let lastPlay = null, lastPlayerId = -1, passCount = 0;
    if (rng() < 0.7) {
        // fabricate a single/pair lead from previous player
        const prev = (cp + 2) % 3;
        const val = Math.floor(rng() * 13);
        const pl = [{ suit: '♠', rank: 'x', value: val, id: 'x' + val }];
        if (rng() < 0.3) pl.push({ suit: '♥', rank: 'x', value: val, id: 'y' + val });
        lastPlay = S.getCardType(pl);
        lastPlayerId = prev;
        passCount = rng() < 0.3 ? 1 : 0;
    }
    return { players: hands, landlord, currentPlayer: cp, lastPlay, lastPlayerId, passCount, baseScore: 1, bombCount: 0, phase: 'playing' };
}

const rng = makeRng(4242);
let samples = 0, solverBetter = 0, heuristicBetter = 0, equal = 0, sumGap = 0, maxGap = 0;
const N = 400;
for (let i = 0; i < N; i++) {
    const st = sampleState(rng);
    const pid = st.currentPlayer;
    const needBeat = st.lastPlay && st.lastPlayerId !== pid;
    const legal = needBeat ? S.getAllValidPlays(st.players[pid], st.lastPlay) : S.getAllValidPlays(st.players[pid], null);
    if (legal.length < 2) continue;
    const hs = new H.AICore(pid, 'medium', new H.MasterMemory());
    const ss = new S.AICore(pid, 'medium', new S.MasterMemory());
    let pickH, pickS;
    try { pickH = hs.playDecision(st); } catch (e) { continue; }
    try { pickS = ss.playDecision(st); } catch (e) { continue; }
    const vH = S.endgameValue(st, pid, pickH, { timeBudgetMs: 1200 });
    const vS = S.endgameValue(st, pid, pickS, { timeBudgetMs: 1200 });
    samples++;
    const gap = vS - vH;
    if (gap > 0.001) { solverBetter++; sumGap += gap; if (gap > maxGap) maxGap = gap; }
    else if (gap < -0.001) heuristicBetter++;
    else equal++;
}
console.log(`samples=${samples} solverBetter=${solverBetter} heuristicBetter=${heuristicBetter} equal=${equal}`);
console.log(`avg gap when solver better: ${(sumGap / Math.max(1, solverBetter)).toFixed(1)} pts, max ${maxGap.toFixed(1)}`);
console.log(`improved share: ${(solverBetter / Math.max(1, samples) * 100).toFixed(1)}%`);
