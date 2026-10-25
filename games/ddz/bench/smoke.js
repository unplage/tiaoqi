'use strict';
// Smoke test: exercise every difficulty's decision path (incl. MCTS/simulation/endgame) for runtime errors.
const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory', 'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore', 'decomposeHandDP', 'solveEndgame', 'minimaxEndgame', 'endgameValue', 'mctsSearch', 'heuristicPlayoutWithMode', 'AICore', 'DEFAULT_PARAMS', 'cfg'];

const fast = {
    mcts: { iterations: { legendary: 200, grandmaster: 200, hard: 200 }, timeLimit: 500 },
    simulation: { depth: { legendary: 1, grandmaster: 1, hard: 1 } },
    endgame: { timeBudgetMs: 200, nodeLimit: 30000 },
    blind: {
        worlds: {
            endgame: { easy: 1, medium: 1, hard: 2, grandmaster: 2, legendary: 2 },
            mcts: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
            sim: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
            call: { easy: 0, medium: 0, hard: 0, grandmaster: 0, legendary: 2 }
        },
        endgameTimeBudgetMs: { easy: 60, medium: 80, hard: 150, grandmaster: 150, legendary: 150 },
        mctsTimeBudgetMs: { easy: 0, medium: 0, hard: 150, grandmaster: 150, legendary: 150 },
        beatProbSamples: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
        beatProbCandidates: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
        callTrials: { legendary: 10 }
    },
};
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(7), fast);
const { AICore, MasterMemory, getAllValidPlays, getCardType } = mod;

const rng = makeRng(2024);
let fails = 0, decisions = 0;
for (const difficulty of ['easy', 'medium', 'hard', 'grandmaster', 'legendary']) {
    for (let g = 0; g < 6; g++) {
        const deal = makeDeal(rng);
        const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
        const players = deal.hands.map(p => p.map(c => ({ ...c })));
        players[L].push(...deal.lordCards);
        players[L].sort((a, b) => a.value - b.value);
        const memory = new MasterMemory();
        const state = { players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1, passCount: 0, baseScore: 1, bombCount: 0, phase: 'playing', lordCards: deal.lordCards, callScores: [0, 0, 0], firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false };
        for (let t = 0; t < 40; t++) {
            const cp = state.currentPlayer;
            if (state.players[cp].length === 0) break;
            if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
            const needBeat = state.lastPlay && state.lastPlayerId !== cp;
            let chosen;
            try {
                chosen = new AICore(cp, difficulty, memory).playDecision(state);
                decisions++;
            } catch (e) { console.error('THROW', difficulty, e.message); fails++; break; }
            const plays = needBeat ? getAllValidPlays(state.players[cp], state.lastPlay) : getAllValidPlays(state.players[cp], null);
            if (!Array.isArray(chosen)) { console.error('NON-ARRAY', difficulty); fails++; break; }
            if (chosen.length > 0) {
                const ids = new Set(chosen.map(c => c.id));
                if (!plays.find(p => p.length === chosen.length && p.every(c => ids.has(c.id)))) {
                    console.error('ILLEGAL', difficulty, getCardType(chosen)); fails++; break;
                }
                // memory consistency
                const before = state.players[cp].length;
                state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
                if (state.players[cp].length !== before - chosen.length) { console.error('HAND MISMATCH'); fails++; break; }
                state.lastPlay = getCardType(chosen); state.lastPlayerId = cp; state.passCount = 0;
                memory.recordPlayerPlay(cp, chosen);
            } else {
                if (!needBeat) { console.error('ILLEGAL PASS as lead', difficulty); fails++; break; }
                state.passCount++;
            }
            state.currentPlayer = (cp + 1) % 3;
        }
    }
}
console.log('decisions exercised:', decisions, 'fails:', fails);
process.exit(fails > 0 ? 1 : 0);
