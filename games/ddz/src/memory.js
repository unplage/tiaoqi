// src/memory.js — 记牌器
'use strict';

const { allCards, makeRng } = require('./utils');
const { getCardType, getAllValidPlays } = require('./card_types');

class MasterMemory {
    constructor() {
        this.remain = new Array(15).fill(4);
        this.remain[13] = 1; this.remain[14] = 1;
        this.seen = new Set();
        this.history = [];
        this.playerHistory = [[], [], []];
        this.totalCardsPlayed = [0, 0, 0];
        this.passHints = [[], [], []];
    }
    record(cards) {
        cards.forEach(c => {
            if (!this.seen.has(c.id)) {
                this.seen.add(c.id);
                if (c.value >= 0 && c.value <= 14) this.remain[c.value]--;
            }
        });
        this.history.push(cards.map(c => c.id));
    }
    recordPlayerPlay(playerId, cards) {
        if (this.playerHistory[playerId]) {
            this.playerHistory[playerId].push(cards.map(c => c.id));
            this.totalCardsPlayed[playerId] += cards.length;
            this.record(cards);
        }
    }
    getRemain(v) { return this.remain[v] || 0; }
    getMaxOutside(myHand) {
        for (let v = 14; v >= 0; v--) {
            if (this.getRemain(v) > myHand.filter(c => c.value === v).length) return v;
        }
        return 0;
    }
    isBombPossible() {
        for (let v = 0; v <= 12; v++) if (this.getRemain(v) >= 4) return true;
        return false;
    }
    getRemainingCounts() { return [...this.remain]; }
    _outsideCount(value, myHand) {
        let mine = 0;
        if (myHand) for (let c of myHand) if (c.value === value) mine++;
        return this.getRemain(value) - mine;
    }
    getOutsideBombCount(myHand) {
        let cnt = 0;
        for (let v = 0; v <= 12; v++) if (this._outsideCount(v, myHand) >= 4) cnt++;
        return cnt;
    }
    getOutsideRocketPossible(myHand) {
        return this._outsideCount(13, myHand) >= 1 && this._outsideCount(14, myHand) >= 1;
    }
    recordPass(playerId, ctx) {
        if (playerId < 0 || playerId > 2 || !ctx) return;
        this.passHints[playerId].push({ type: ctx.type, value: ctx.value, length: ctx.length || 0, ts: Date.now() });
        if (this.passHints[playerId].length > 60) this.passHints[playerId].shift();
    }
    passHintsNear(oppId, value, within = 2) {
        if (!this.passHints[oppId]) return 0;
        let n = 0;
        for (const h of this.passHints[oppId]) {
            if (Math.abs(h.value - value) <= within) n++;
        }
        return n;
    }
}

module.exports = { MasterMemory };