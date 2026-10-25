'use strict';
const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory', 'evaluateHandStrength', 'AICore', 'MiniMasterAI'];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(11));
const Core = mod.AICore;

const rng = makeRng(321);
const deal = makeDeal(rng);
const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
const players = deal.hands.map(p => p.map(c => ({ ...c })));
players[L].push(...deal.lordCards);
players[L].sort((a, b) => a.value - b.value);

// mid-game: simulate a few plies so hands are ~10-14
const memory = new mod.MasterMemory();
const state = { players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1, passCount: 0, baseScore: 1, bombCount: 0, phase: 'playing', lordCards: deal.lordCards, callScores: [0, 0, 0], firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false };

for (const diff of ['hard', 'grandmaster', 'legendary']) {
    for (let round = 0; round < 2; round++) {
        const s = JSON.parse(JSON.stringify(state));
        // build a plausible mid-game by making random legal plays until hand size ~13
        let guard = 0;
        while (s.players[s.currentPlayer].length > 13 && guard < 60) {
            const cp = s.currentPlayer;
            const needBeat = s.lastPlay && s.lastPlayerId !== cp;
            const plays = needBeat ? mod.getAllValidPlays(s.players[cp], s.lastPlay) : mod.getAllValidPlays(s.players[cp], null);
            if (plays.length === 0) { s.passCount++; s.currentPlayer = (cp + 1) % 3; guard++; continue; }
            const p = plays[Math.floor(rng() * plays.length)];
            const ids = new Set(p.map(c => c.id));
            s.players[cp] = s.players[cp].filter(c => !ids.has(c.id));
            s.lastPlay = mod.getCardType(p); s.lastPlayerId = cp; s.passCount = 0;
            s.currentPlayer = (cp + 1) % 3; guard++;
        }
        const cp = s.currentPlayer;
        const t0 = Date.now();
        const pick = new Core(cp, diff, new mod.MasterMemory()).playDecision(s);
        const dt = Date.now() - t0;
        const hand = s.players[cp].length;
        console.log(`${diff} hand=${hand} total=${s.players.reduce((a,p)=>a+p.length,0)} -> ${dt}ms, pick=${Array.isArray(pick) ? pick.length : '?'}`);
    }
}
