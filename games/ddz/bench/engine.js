'use strict';
// Headless Doudizhu game driver for AI benchmarking.
// Deterministic when given a seeded rng; supports reuse of the same deal for paired A/B tests.

function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function makeDeal(rng) {
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const deck = [];
    for (const suit of suits) for (let i = 0; i < ranks.length; i++) {
        deck.push({ suit, rank: ranks[i], value: i, id: suit + ranks[i] });
    }
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    shuffle(deck, rng);
    const hands = [[], [], []];
    for (let i = 0; i < 51; i++) hands[i % 3].push(deck.pop());
    const lordCards = deck.slice(0, 3);
    hands.forEach(p => p.sort((a, b) => a.value - b.value));
    return { hands, lordCards };
}

function bestLandlord(hands, rng, evaluateHandStrength) {
    let best = -1e9, idx = 0;
    for (let i = 0; i < 3; i++) {
        const s = evaluateHandStrength(hands[i], null, false, i) + rng() * 6;
        if (s > best) { best = s; idx = i; }
    }
    return idx;
}

// diffs = [difficultyPerSeat]; agents created via AI.makeAgent(id, landlord, memory)
function playDeal(AI, deal, landlord, diffs, rng) {
    const { getAllValidPlays, canBeat, getCardType, MasterMemory } = AI;
    const players = deal.hands.map(p => p.map(c => ({ ...c })));
    players[landlord].push(...deal.lordCards);
    players[landlord].sort((a, b) => a.value - b.value);

    const memory = new MasterMemory();
    const agents = [0, 1, 2].map(i => AI.makeAgent(i, landlord, memory, diffs[i]));

    const state = {
        players,
        landlord,
        currentPlayer: landlord,
        lastPlay: null,
        lastPlayerId: -1,
        passCount: 0,
        baseScore: 1,
        bombCount: 0,
        firstPlayMade: false,
        lordPlayCount: 0,
        farmerPlayed: false,
        lordCards: deal.lordCards,
        callScores: [0, 0, 0],
        phase: 'playing',
    };

    let winner = -1;
    let steps = 0;
    for (let guard = 0; guard < 500; guard++) {
        for (let i = 0; i < 3; i++) if (state.players[i].length === 0) { winner = i; break; }
        if (winner >= 0) break;

        if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
        const cp = state.currentPlayer;
        const hand = state.players[cp];
        const needBeat = state.lastPlay && state.lastPlayerId !== cp;
        const plays = needBeat ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);

        let chosen = null;
        if (plays.length === 0) {
            chosen = [];
        } else {
            try { chosen = agents[cp].playDecision(state); } catch (e) { chosen = null; }
            if (!Array.isArray(chosen)) chosen = null;
            if (chosen && chosen.length > 0) {
                const ids = new Set(chosen.map(c => c.id));
                if (!plays.find(p => p.length === chosen.length && p.every(c => ids.has(c.id)))) chosen = null;
            } else if (chosen && chosen.length === 0 && !needBeat) {
                chosen = null;
            }
            if (chosen === null) chosen = plays[0];
        }

        if (!chosen || chosen.length === 0) {
            state.passCount++;
        } else {
            const ids = new Set(chosen.map(c => c.id));
            state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
            state.lastPlay = getCardType(chosen);
            state.lastPlayerId = cp;
            state.passCount = 0;
            if (cp === landlord) state.lordPlayCount++; else state.farmerPlayed = true;
            if (!state.firstPlayMade) state.firstPlayMade = true;
            memory.recordPlayerPlay(cp, chosen);
            if (state.players[cp].length === 0) { winner = cp; break; }
        }
        state.currentPlayer = (cp + 1) % 3;
        steps++;
    }

    if (winner < 0) {
        let best = 0, bestLen = 99;
        for (let i = 0; i < 3; i++) if (state.players[i].length < bestLen) { bestLen = state.players[i].length; best = i; }
        winner = best;
    }
    return { winner, landlord, landlordWon: winner === landlord, steps };
}

module.exports = { playDeal, makeDeal, bestLandlord, makeRng, shuffle };
