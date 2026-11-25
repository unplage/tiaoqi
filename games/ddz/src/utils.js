// src/utils.js — 通用工具函数
'use strict';

function countValues(values) {
    let cnt = {};
    values.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
    return cnt;
}

function isStraight(values) {
    for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1] + 1) return false;
    return true;
}

function getCombinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    let result = [];
    for (let i = 0; i <= arr.length - k; i++) {
        for (let sub of getCombinations(arr.slice(i + 1), k - 1))
            result.push([arr[i], ...sub]);
    }
    return result;
}

function comb(n, k) {
    if (k < 0 || k > n || n < 0) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
}

function allCards() {
    const SUITS = ['♠', '♥', '♣', '♦'];
    const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const deck = [];
    for (const suit of SUITS) for (let i = 0; i < RANKS.length; i++) {
        deck.push({ suit, rank: RANKS[i], value: i, id: suit + RANKS[i] });
    }
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    return deck;
}

function _cardIdx(card) {
    if (card.__ci !== undefined) return card.__ci;
    const id = card.id;
    if (id === 'joker1') return 52;
    if (id === 'joker2') return 53;
    const suit = id[0];
    const rank = id.slice(1);
    const SUIT_CODE = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };
    const RANK_CODE = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, 'J': 8, 'Q': 9, 'K': 10, 'A': 11, '2': 12 };
    const idx = SUIT_CODE[suit] * 13 + RANK_CODE[rank];
    Object.defineProperty(card, '__ci', { value: idx, enumerable: false, configurable: true });
    return idx;
}

function _playKey(cards) {
    const n = cards.length;
    if (n === 0) return '';
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = _cardIdx(cards[i]);
    a.sort((x, y) => x - y);
    return String.fromCharCode.apply(null, a);
}

function _playValueKey(cards) {
    const n = cards.length;
    if (n === 0) return '';
    const v = new Array(n);
    for (let i = 0; i < n; i++) v[i] = cards[i].value;
    v.sort((a, b) => a - b);
    return v.join(',');
}

function _validPlaysKey(hand, lastPlay) {
    const n = hand.length;
    const ord = new Array(n);
    for (let i = 0; i < n; i++) ord[i] = i;
    ord.sort((a, b) => (hand[a].value - hand[b].value) || (hand[a].id < hand[b].id ? -1 : (hand[a].id > hand[b].id ? 1 : 0)));
    let key = '';
    for (let i = 0; i < n; i++) key += String.fromCharCode(_cardIdx(hand[ord[i]]));
    let lp = '-';
    if (lastPlay && lastPlay.type) {
        lp = lastPlay.type + ':' + lastPlay.value + ':' + (lastPlay.length || 0);
    }
    return key + '|' + lp;
}

function _cardTypeSignature(cards) {
    let cnt = new Array(15).fill(0);
    let j1 = 0, j2 = 0;
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (c && c.value >= 0 && c.value <= 14) cnt[c.value]++;
        if (c && c.id === 'joker1') j1++;
        else if (c && c.id === 'joker2') j2++;
    }
    let k = cards.length + '|';
    for (let v = 0; v < 15; v++) if (cnt[v]) k += v + 'x' + cnt[v] + ',';
    if (j1) k += 'J1';
    if (j2) k += 'J2';
    return k;
}

function _cacheCardType(sig, type, value, length, cards) {
    if (_CARD_TYPE_CACHE.size >= _CARD_TYPE_CACHE_MAX) _CARD_TYPE_CACHE.clear();
    _CARD_TYPE_CACHE.set(sig, { type, value, length, cards });
    return { type, value, length, cards };
}

function _outsideBombCountMemo(memory, hand) {
    if (!memory || typeof memory.getOutsideBombCount !== 'function') return 0;
    let memState = 0;
    if (memory.seen && typeof memory.seen.size === 'number') memState = memory.seen.size;
    const key = _cardTypeSignature(hand) + '#' + memState;
    if (_outsideMemoKey === key) return _outsideMemoVal;
    _outsideMemoKey = key;
    _outsideMemoVal = memory.getOutsideBombCount(hand);
    return _outsideMemoVal;
}

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

function _canonicalHand(hand) {
    return hand.slice().sort((a, b) => (a.value - b.value) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
}

if (typeof module !== 'undefined') {
    module.exports = {
        countValues, isStraight, getCombinations, comb, allCards, _cardIdx,
        _playKey, _playValueKey, _validPlaysKey, _cardTypeSignature,
        _cacheCardType, _outsideBombCountMemo, makeRng, shuffle, _canonicalHand
    };
}