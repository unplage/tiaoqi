'use strict';
const { loadAI } = require('./loader');
const { playDeal, makeDeal, bestLandlord, makeRng } = require('./engine');

const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore',
    'decomposeHandDP', 'solveEndgame', 'minimaxEndgame', 'mctsSearch',
    'MiniMasterAI', 'AICore', 'DEFAULT_PARAMS', 'heuristicPlayoutWithMode', 'cfg',
];

function parseArgs() {
    const a = process.argv.slice(2);
    const o = {
        fileA: 'ai_core.js', fileB: 'ai_core.js',
        a: 'medium', b: 'medium',
        deals: 60, seed: 12345, verbose: false,
        paramsA: null, paramsB: null,
    };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--fileA') o.fileA = a[++i];
        else if (a[i] === '--fileB') o.fileB = a[++i];
        else if (a[i] === '--a') o.a = a[++i];
        else if (a[i] === '--b') o.b = a[++i];
        else if (a[i] === '--deals') o.deals = parseInt(a[++i], 10);
        else if (a[i] === '--seed') o.seed = parseInt(a[++i], 10);
        else if (a[i] === '--verbose') o.verbose = true;
        else if (a[i] === '--paramsA') o.paramsA = JSON.parse(a[++i]);
        else if (a[i] === '--paramsB') o.paramsB = JSON.parse(a[++i]);
    }
    return o;
}

function run(o) {
    const modA = loadAI(o.fileA, SYMBOLS, makeRng(o.seed), o.paramsA);
    const modB = (o.fileA === o.fileB && !o.paramsB) ? modA : loadAI(o.fileB, SYMBOLS, makeRng(o.seed ^ 0x9e3779b9), o.paramsB);
    const CoreA = modA.AICore || modA.MiniMasterAI;
    const CoreB = modB.AICore || modB.MiniMasterAI;
    if (!CoreA || !CoreB) throw new Error('missing AICore/MiniMasterAI');

    const dealRng = makeRng(o.seed ^ 0xdeadbeef);
    const engineUtils = {
        CardType: modA.CardType,
        getCardType: modA.getCardType,
        canBeat: modA.canBeat,
        getAllValidPlays: modA.getAllValidPlays,
        MasterMemory: modA.MasterMemory,
        evaluateHandStrength: modA.evaluateHandStrength,
    };

    let games = 0, aWins = 0;
    let lordGames = 0, lordWins = 0;
    let farmGames = 0, farmWins = 0;
    const t0 = Date.now();

    for (let d = 0; d < o.deals; d++) {
        const deal = makeDeal(dealRng);
        const L = bestLandlord(deal.hands, dealRng, modA.evaluateHandStrength);

        // Two paired games over the same deal:
        //   game 0: A landlord, B farmers
        //   game 1: B landlord, A one farmer + B other farmer
        const configs = [
            { aRole: 'landlord', landlord: L, aSeat: L },
            { aRole: 'farmer', landlord: L, aSeat: (L + 1) % 3 },
        ];
        for (const cfg of configs) {
            const diffs = [o.b, o.b, o.b];
            diffs[cfg.aSeat] = o.a;
            // landlord seat difficulty: A if A is landlord else B
            diffs[cfg.landlord] = (cfg.aSeat === cfg.landlord) ? o.a : o.b;

            const AI = {
                ...engineUtils,
                makeAgent: (id, landlord, memory) =>
                    (id === cfg.aSeat) ? new CoreA(id, o.a, memory) : new CoreB(id, o.b, memory),
            };
            const res = playDeal(AI, deal, cfg.landlord, diffs, dealRng);
            games++;
            const aWon = (cfg.aRole === 'landlord') ? res.landlordWon : !res.landlordWon;
            if (aWon) aWins++;
            if (cfg.aRole === 'landlord') { lordGames++; if (aWon) lordWins++; }
            else { farmGames++; if (aWon) farmWins++; }
        }
    }

    const dt = (Date.now() - t0) / 1000;
    const rate = aWins / games;
    console.log(`A=${o.a}(${o.fileA})  vs  B=${o.b}(${o.fileB})  deals=${o.deals} games=${games}`);
    console.log(`A-side winrate: ${(rate * 100).toFixed(1)}%  (${aWins}/${games})`);
    console.log(`  as lord:   ${(lordWins / lordGames * 100).toFixed(1)}% (${lordWins}/${lordGames})`);
    console.log(`  as farmer: ${(farmWins / farmGames * 100).toFixed(1)}% (${farmWins}/${farmGames})`);
    console.log(`  time: ${dt.toFixed(1)}s  (${(games / dt).toFixed(1)} games/s)`);
    return rate;
}

if (require.main === module) run(parseArgs());
module.exports = { run };
