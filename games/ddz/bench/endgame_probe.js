'use strict';
const { loadAI } = require('./loader');
const { playDeal, makeDeal, bestLandlord, makeRng } = require('./engine');

const SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory', 'evaluateHandStrength', 'AICore', 'MiniMasterAI', 'endgameStats'];

const mod = loadAI('ai_core.js', SYMBOLS, makeRng(12345), { endgameThresholds: { legendary: 17, grandmaster: 17, hard: 17, medium: 17, easy: 17 } });
const Core = mod.AICore;
const deals = 40;
const rng = makeRng(999);
let t0 = Date.now();
for (let d = 0; d < deals; d++) {
    const deal = makeDeal(rng);
    const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
    for (const cfg of [
        { landlord: L, aSeat: L },
        { landlord: L, aSeat: (L + 1) % 3 },
    ]) {
        const diffs = [0, 0, 0].map(() => 'medium');
        diffs[cfg.aSeat] = 'medium';
        const AI = {
            CardType: mod.CardType, getCardType: mod.getCardType, canBeat: mod.canBeat,
            getAllValidPlays: mod.getAllValidPlays, MasterMemory: mod.MasterMemory,
            evaluateHandStrength: mod.evaluateHandStrength,
            makeAgent: (id, landlord, memory) => new Core(id, 'medium', memory),
        };
        playDeal(AI, deal, cfg.landlord, diffs, rng);
    }
}
console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('endgameStats', JSON.stringify(mod.endgameStats()));
