'use strict';
// Worker end-to-end smoke: emulate importScripts, init, then a think request.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const core = fs.readFileSync(path.join(__dirname, '..', 'ai_core.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'ai_worker.js'), 'utf8')
    .replace(/importScripts\([^)]*\);/, '');
const combined = core + '\n' + worker;

const outbox = [];
const sandbox = {
    self: { postMessage(m) { outbox.push(m); }, onmessage: null },
    console, Date, Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {},
};
sandbox.globalThis = sandbox;
sandbox.self.self = sandbox.self;
vm.createContext(sandbox);
vm.runInContext(combined, sandbox, { filename: 'combined_worker.js' });

sandbox.self.onmessage({ data: { cmd: 'init' } });
const ready = outbox.find(m => m.status === 'ready');
if (!ready) { console.error('no ready'); process.exit(1); }

const hands = [
    [{ suit: '♠', rank: '3', value: 0, id: 's3' }, { suit: '♥', rank: '3', value: 0, id: 'h3' }, { suit: '♠', rank: '4', value: 1, id: 's4' }],
    [{ suit: '♣', rank: '5', value: 2, id: 'c5' }, { suit: '♦', rank: '6', value: 3, id: 'd6' }],
    [{ suit: '♠', rank: 'K', value: 10, id: 'sK' }],
];
const state = { players: hands, landlord: 0, currentPlayer: 2, lastPlay: null, lastPlayerId: -1, passCount: 0, baseScore: 1, bombCount: 0, phase: 'playing', lordCards: [], callScores: [0, 0, 0], firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false };
outbox.length = 0;
sandbox.self.onmessage({ data: { cmd: 'think', taskId: 1, phase: 'play', state, playerId: 2, difficulty: 'hard', memory: null } });
const res = outbox.find(m => m.taskId === 1);
if (!res || res.error) { console.error('think failed', res); process.exit(1); }
console.log('worker think result:', JSON.stringify(res.result));
console.log('worker smoke OK');
