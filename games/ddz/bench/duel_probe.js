'use strict';
// Duel probe: compare decision quality of two difficulties on identical mid-game positions.
// Value of a pick = win rate of picker's side when the rest of the game is played by a fixed reference policy.
const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory', 'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore', 'AICore'];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(5));
const { AICore, MasterMemory, getAllValidPlays, getCardType } = mod;

const refDifficulty = 'medium';

function rollout(startState, startPlayer, pickerId, maxSteps) {
    const s = JSON.parse(JSON.stringify(startState));
    let cp = startPlayer;
    const mySide = (pickerId === s.landlord) ? [pickerId] : [0, 1, 2].filter(i => i !== s.landlord);
    for (let step = 0; step < maxSteps; step++) {
        for (let i = 0; i < 3; i++) if (s.players[i].length === 0) return mySide.includes(i) ? 1 : 0;
        if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
        const hand = s.players[cp];
        const needBeat = s.lastPlay && s.lastPlayerId !== cp;
        const plays = needBeat ? getAllValidPlays(hand, s.lastPlay) : getAllValidPlays(hand, null);
        if (plays.length === 0) { s.passCount++; cp = (cp + 1) % 3; continue; }
        // reference policy: greedy one-ply heuristic with the shared scoring (medium, but deterministic)
        const mem = new MasterMemory();
        const role = cp === s.landlord ? 'landlord' : 'farmer';
        let best = plays[0], bestScore = -Infinity;
        for (const p of plays) {
            let sc;
            try {
                const f = mod.extractPlayFeatures(p, hand, s.lastPlay, role, mem, s);
                sc = mod.scorePlay(f, role, mem, s, hand);
            } catch (e) { sc = 0; }
            if (sc > bestScore) { bestScore = sc; best = p; }
        }
        const ids = new Set(best.map(c => c.id));
        s.players[cp] = s.players[cp].filter(c => !ids.has(c.id));
        s.lastPlay = getCardType(best); s.lastPlayerId = cp; s.passCount = 0;
        cp = (cp + 1) % 3;
    }
    return 0;
}

function valueOf(state, pid, pick, rollouts) {
    if (!Array.isArray(pick)) return null;
    const s = JSON.parse(JSON.stringify(state));
    if (pick.length > 0) {
        const ids = new Set(pick.map(c => c.id));
        s.players[pid] = s.players[pid].filter(c => !ids.has(c.id));
        s.lastPlay = getCardType(pick); s.lastPlayerId = pid; s.passCount = 0;
    } else {
        if (!(state.lastPlay && state.lastPlayerId !== pid)) return null; // illegal pass
        s.passCount = (s.passCount || 0) + 1;
    }
    if (s.players[pid].length === 0) return 1;
    let wins = 0;
    for (let r = 0; r < rollouts; r++) wins += rollout(s, (pid + 1) % 3, pid, 80);
    return wins / rollouts;
}

// sample positions by playing random-legal games until a target hand size
const rng = makeRng(987654);
function samplePosition(targetHand) {
    const deal = makeDeal(rng);
    const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
    const players = deal.hands.map(p => p.map(c => ({ ...c })));
    players[L].push(...deal.lordCards);
    players[L].sort((a, b) => a.value - b.value);
    const s = { players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1, passCount: 0, baseScore: 1, bombCount: 0, phase: 'playing', lordCards: deal.lordCards, callScores: [0, 0, 0], firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false };
    for (let g = 0; g < 80; g++) {
        if (s.players[s.currentPlayer].length <= targetHand && s.players.reduce((a, p) => a + p.length, 0) > 24) break;
        const cp = s.currentPlayer;
        const needBeat = s.lastPlay && s.lastPlayerId !== cp;
        const plays = needBeat ? getAllValidPlays(s.players[cp], s.lastPlay) : getAllValidPlays(s.players[cp], null);
        if (plays.length === 0) { s.passCount++; s.currentPlayer = (cp + 1) % 3; continue; }
        const p = plays[Math.floor(rng() * plays.length)];
        const ids = new Set(p.map(c => c.id));
        s.players[cp] = s.players[cp].filter(c => !ids.has(c.id));
        s.lastPlay = getCardType(p); s.lastPlayerId = cp; s.passCount = 0;
        s.currentPlayer = (cp + 1) % 3;
    }
    return s;
}

const K = parseInt(process.argv[2] || '24', 10);
const R = parseInt(process.argv[3] || '24', 10);
let legendBetter = 0, hardBetter = 0, tie = 0, skipped = 0;
let sumL = 0, sumH = 0, n = 0;
const t0 = Date.now();
for (let k = 0; k < K; k++) {
    const targetHand = 8 + Math.floor(rng() * 9); // 8..16
    const st = samplePosition(targetHand);
    const pid = st.currentPlayer;
    if (st.players[pid].length < 6 || st.players[pid].length > 17) { skipped++; continue; }
    const pickH = new AICore(pid, 'hard', new MasterMemory()).playDecision(st);
    const pickL = new AICore(pid, 'legendary', new MasterMemory()).playDecision(st);
    const vH = valueOf(st, pid, pickH, R);
    const vL = valueOf(st, pid, pickL, R);
    if (vH === null || vL === null) { skipped++; continue; }
    n++;
    sumH += vH; sumL += vL;
    if (vL > vH + 0.02) legendBetter++;
    else if (vH > vL + 0.02) hardBetter++;
    else tie++;
    if ((k + 1) % 5 === 0) console.log(`  ...${k + 1}/${K} (elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`positions=${n} skipped=${skipped}`);
console.log(`legendary better: ${legendBetter}  hard better: ${hardBetter}  tie(±2%): ${tie}`);
console.log(`avg pick value  legendary=${(sumL / n * 100).toFixed(1)}%  hard=${(sumH / n * 100).toFixed(1)}%  delta=${((sumL - sumH) / n * 100).toFixed(1)} pts`);
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
