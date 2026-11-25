// src/hand_belief.js — 信念模型（对手手牌采样）
'use strict';

const { CardType } = require('./constants');
const { comb, makeRng, _cardIdx, allCards } = require('./utils');
const { getCardType, getAllValidPlays } = require('./card_types');

class HandBelief {
    constructor(playerId, state, memory) {
        this.playerId = playerId;
        this.landlord = (state.landlord === undefined || state.landlord === null || state.landlord < 0) ? -1 : state.landlord;
        this.phase = state.phase || 'playing';
        const rawPlayers = state.players || [];
        const ownRaw = Array.isArray(rawPlayers[playerId]) ? rawPlayers[playerId] : [];
        this.ownHand = ownRaw.map(c => ({ ...c }));
        this.counts = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const p = rawPlayers[i];
            if (Array.isArray(p)) this.counts[i] = p.length;
            else if (typeof p === 'number') this.counts[i] = p;
            else if (p && typeof p.length === 'number') this.counts[i] = p.length;
            else this.counts[i] = 0;
        }
        const ownIds = new Set(this.ownHand.map(c => c.id));
        const ownKeys = new Set(this.ownHand.map(c => (c.suit || '') + '|' + (c.rank !== undefined ? c.rank : c.value)));
        const lordCards = state.lordCards || [];
        const lordHasBottom = this.landlord >= 0 && (this.phase === 'playing' || this.counts[this.landlord] >= 20);
        this.knownByPlayer = [[], [], []];
        if (lordHasBottom) for (const c of lordCards) if (!ownIds.has(c.id)) this.knownByPlayer[this.landlord].push({ ...c });
        const knownIds = new Set();
        for (const list of this.knownByPlayer) for (const c of list) knownIds.add(c.id);
        const playedSet = new Set();
        if (memory && memory.seen) for (const id of memory.seen) if (!ownIds.has(id) && !knownIds.has(id)) playedSet.add(id);
        let oppNeed = 0;
        for (let i = 0; i < 3; i++) if (i !== playerId) oppNeed += this.counts[i];
        const maxPlayed = Math.max(0, 54 - this.ownHand.length - oppNeed);
        if (playedSet.size > maxPlayed) {
            const arr = [...playedSet];
            while (arr.length > maxPlayed) playedSet.delete(arr.pop());
        }
        const pool = [];
        for (const c of allCards()) {
            if (ownIds.has(c.id) || playedSet.has(c.id) || new Set(this.knownByPlayer.flat().map(c => c.id)).has(c.id)) continue;
            if (ownKeys.has((c.suit || '') + '|' + (c.rank !== undefined ? c.rank : c.value))) continue;
            pool.push(c);
        }
        if (pool.length < oppNeed) {
            const arr = [...playedSet];
            while (pool.length < oppNeed && arr.length > 0) {
                const id = arr.pop();
                playedSet.delete(id);
                const card = allCards().find(c => c.id === id);
                if (card) pool.push(card);
            }
        }
        this.playedIds = playedSet;
        this.pool = pool;
        this.poolCounts = new Array(15).fill(0);
        for (const c of pool) this.poolCounts[c.value]++;
        this.passHints = memory && memory.passHints ? memory.passHints : [[], [], []];
        this.memory = memory;
    }

    sampleWorld() {
        const pool = this.pool.slice();
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const players = [[], [], []];
        players[this.playerId] = this.ownHand.map(c => ({ ...c }));
        let ptr = 0;
        for (let i = 0; i < 3; i++) {
            if (i === this.playerId) continue;
            const hand = this.knownByPlayer[i].map(c => ({ ...c }));
            const need = this.counts[i] - hand.length;
            for (let k = 0; k < need && ptr < pool.length; k++) hand.push(pool[ptr++]);
            hand.sort((a, b) => a.value - b.value);
            players[i] = hand;
        }
        return players;
    }

    sampleWorlds(n) {
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.sampleWorld());
        return out;
    }

    bombRiskFor(oppId) {
        const n = this.counts[oppId] || 0;
        const known = this.knownByPlayer[oppId] || [];
        const knownCounts = new Array(15).fill(0);
        for (const c of known) knownCounts[c.value]++;
        const unknownSlots = n - known.length;
        const poolSize = this.pool.length;
        if (unknownSlots <= 0 || poolSize <= 0) {
            for (let v = 0; v <= 12; v++) if (knownCounts[v] >= 4) return 1;
            return 0;
        }
        let risk = 0;
        for (let v = 0; v <= 12; v++) {
            const need = Math.max(0, 4 - knownCounts[v]);
            if (need <= 0) return 1;
            const available = this.poolCounts[v] || 0;
            if (available < need) continue;
            let hit = 0;
            const maxTake = Math.min(available, unknownSlots);
            for (let take = need; take <= maxTake; take++) {
                hit += comb(available, take) * comb(poolSize - available, unknownSlots - take);
            }
            const denom = comb(poolSize, unknownSlots);
            if (denom) risk += hit / denom;
        }
        let passDiscount = 1.0;
        for (let v = 0; v <= 12; v++) {
            const hints = this.memory ? this.memory.passHintsNear(oppId, v, 2) : 0;
            if (hints > 0) passDiscount -= hints * 0.08;
        }
        passDiscount = Math.max(0.3, passDiscount);
        return Math.min(1, risk * passDiscount);
    }

    rocketRiskFor(oppId) {
        const n = this.counts[oppId] || 0;
        const known = this.knownByPlayer[oppId] || [];
        let knownSmall = 0, knownBig = 0;
        for (const c of known) {
            if (c.value === 13) knownSmall++;
            if (c.value === 14) knownBig++;
        }
        if (knownSmall >= 1 && knownBig >= 1) return 1;
        const unknownSlots = n - known.length;
        const poolSize = this.pool.length;
        if (unknownSlots <= 0 || poolSize <= 0) return 0;
        const needSmall = knownSmall >= 1 ? 0 : 1;
        const needBig = knownBig >= 1 ? 0 : 1;
        const need = needSmall + needBig;
        if (need === 0) return 1;
        if (need === 1) {
            const value = needSmall ? 13 : 14;
            if ((this.poolCounts[value] || 0) < 1) return 0;
            return Math.min(1, comb(poolSize - 1, unknownSlots - 1) / comb(poolSize, unknownSlots));
        }
        if ((this.poolCounts[13] || 0) < 1 || (this.poolCounts[14] || 0) < 1) return 0;
        return Math.min(1, comb(poolSize - 2, unknownSlots - 2) / comb(poolSize, unknownSlots));
    }

    beatProbability(play, oppId, samples) {
        const type = getCardType(play);
        if (!type) return 0;
        let hit = 0, total = 0;
        for (let s = 0; s < samples; s++) {
            const players = this.sampleWorld();
            const hand = players[oppId];
            total++;
            if (!hand || hand.length === 0) continue;
            let can = false;
            try { can = getAllValidPlays(hand, type).length > 0; } catch (e) { can = false; }
            if (can) hit++;
        }
        let base = total > 0 ? hit / total : 0;
        let hintPenalty = 0;
        const hints = this.passHints[oppId] || [];
        const pv = type.value;
        for (const h of hints) {
            if (type.type === CardType.SINGLE && h.type === 'single' && h.value >= pv) hintPenalty += 0.12;
            if ((h.type === 'bomb' || h.type === 'rocket') && type.type !== CardType.ROCKET) hintPenalty += 0.08;
        }
        return Math.max(0, Math.min(1, base - Math.min(0.5, hintPenalty)));
    }
}

module.exports = { HandBelief };