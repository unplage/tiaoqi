// src/card_types.js — 牌型识别
'use strict';

const { CardType } = require("./constants");
const { countValues, isStraight, getCombinations } = require("./utils");


// 为了避免循环依赖，这里重新声明或引用
// 实际的常量在 constants.js 中定义，这里假设已通过 require 获取

const _CARD_TYPE_CACHE_LOCAL = new Map();
const _CARD_TYPE_CACHE_MAX_LOCAL = 6000;

function _cardTypeSignatureLocal(cards) {
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

function _cacheCardTypeLocal(sig, type, value, length, cards) {
    // 使用全局缓存
    return require('./utils')._cacheCardType(sig, type, value, length, cards);
}

function getCardType(cards) {
    if (!cards || cards.length === 0) return null;
    const sig = _cardTypeSignatureLocal(cards);
    const hit = require('./utils')._CARD_TYPE_CACHE.get(sig);
    if (hit) {
        return { type: hit.type, value: hit.value, length: hit.length, cards: hit.cards ? [...hit.cards] : undefined };
    }
    const sorted = [...cards].sort((a, b) => a.value - b.value);
    const values = sorted.map(c => c.value);
    const uniq = [...new Set(values)];

    const { CardType } = require('./constants');

    if (cards.length === 2 && cards.some(c => c.id === 'joker1') && cards.some(c => c.id === 'joker2'))
        return _cacheCardTypeLocal(sig, CardType.ROCKET, 100, undefined, sorted);
    if (cards.length === 1) return _cacheCardTypeLocal(sig, CardType.SINGLE, values[0], undefined, sorted);
    if (cards.length === 2 && uniq.length === 1) return _cacheCardTypeLocal(sig, CardType.PAIR, values[0], undefined, sorted);
    if (cards.length === 3 && uniq.length === 1) return _cacheCardTypeLocal(sig, CardType.TRIPLE, values[0], undefined, sorted);
    if (cards.length === 4 && uniq.length === 1) return _cacheCardTypeLocal(sig, CardType.BOMB, values[0] + 50, undefined, sorted);
    if (cards.length === 4 && uniq.length === 2) {
        let cnt = require('./utils').countValues(values);
        if (Object.values(cnt).includes(3))
            return _cacheCardTypeLocal(sig, CardType.TRIPLE_WITH_SINGLE, parseInt(Object.keys(cnt).find(k => cnt[k] === 3)), undefined, sorted);
    }
    if (cards.length === 5 && uniq.length === 2) {
        let cnt = require('./utils').countValues(values);
        if (Object.values(cnt).includes(3) && Object.values(cnt).includes(2))
            return _cacheCardTypeLocal(sig, CardType.TRIPLE_WITH_PAIR, parseInt(Object.keys(cnt).find(k => cnt[k] === 3)), undefined, sorted);
    }
    if (cards.length === 6) {
        let cnt = require('./utils').countValues(values);
        let four = Object.keys(cnt).find(k => cnt[k] === 4);
        if (four) {
            const fv = parseInt(four);
            const wingKeys = Object.keys(cnt).filter(k => parseInt(k) !== fv);
            const wingCards = wingKeys.reduce((sum, k) => sum + cnt[k], 0);
            if (wingCards === 2 && wingKeys.every(k => cnt[k] <= 2))
                return _cacheCardTypeLocal(sig, require('./constants').CardType.FOUR_WITH_TWO_SINGLE, fv, undefined, sorted);
        }
    }
    if (cards.length === 8) {
        let cnt = require('./utils').countValues(values);
        let four = Object.keys(cnt).find(k => cnt[k] === 4);
        if (four && Object.values(cnt).filter(v => v === 2).length === 2)
            return _cacheCardTypeLocal(sig, require('./constants').CardType.FOUR_WITH_TWO_PAIR, parseInt(four), undefined, sorted);
    }
    if (cards.length >= 5 && uniq.length === cards.length && isStraight(values) && values[cards.length - 1] <= 11 && !values.includes(12))
        return _cacheCardTypeLocal(sig, require('./constants').CardType.STRAIGHT, values[0], cards.length, sorted);
    if (cards.length >= 6 && cards.length % 2 === 0) {
        let cnt = require('./utils').countValues(values);
        let pairs = Object.keys(cnt).filter(k => cnt[k] === 2).map(Number).sort((a, b) => a - b);
        if (pairs.length === cards.length / 2 && isStraight(pairs) && pairs[pairs.length - 1] <= 11)
            return _cacheCardTypeLocal(sig, require('./constants').CardType.STRAIGHT_PAIR, pairs[0], pairs.length, sorted);
    }
    if (cards.length >= 6 && cards.length % 3 === 0) {
        let cnt = require('./utils').countValues(values);
        let tripVals = Object.keys(cnt).filter(k => cnt[k] === 3).map(Number).sort((a, b) => a - b);
        let groupLen = cards.length / 3;
        if (tripVals.length === groupLen && groupLen >= 2 && isStraight(tripVals) && tripVals[groupLen - 1] <= 11)
            return _cacheCardTypeLocal(sig, require('./constants').CardType.PLANE, tripVals[0], groupLen, sorted);
    }
    if (cards.length >= 8 && cards.length % 4 === 0) {
        let cnt = require('./utils').countValues(values);
        let groupLen = cards.length / 4;
        let tripVals = Object.keys(cnt).filter(k => cnt[k] === 3).map(Number).sort((a, b) => a - b);
        for (let i = 0; i + groupLen <= tripVals.length; i++) {
            let seq = tripVals.slice(i, i + groupLen);
            if (!isStraight(seq) || seq[groupLen - 1] > 11) continue;
            let used = new Set(seq);
            let wingKeys = Object.keys(cnt).filter(k => !used.has(parseInt(k)));
            let wingCards = wingKeys.reduce((sum, k) => sum + cnt[k], 0);
            if (wingCards !== groupLen) continue;
            if (wingKeys.some(k => cnt[k] > 2)) continue;
            return _cacheCardTypeLocal(sig, require('./constants').CardType.PLANE_WITH_SINGLE, seq[0], groupLen, sorted);
        }
    }
    if (cards.length >= 10 && cards.length % 5 === 0) {
        let cnt = require('./utils').countValues(values);
        let groupLen = cards.length / 5;
        let tripVals = Object.keys(cnt).filter(k => cnt[k] === 3).map(Number).sort((a, b) => a - b);
        for (let i = 0; i + groupLen <= tripVals.length; i++) {
            let seq = tripVals.slice(i, i + groupLen);
            if (!isStraight(seq) || seq[groupLen - 1] > 11) continue;
            let used = new Set(seq);
            let remain = Object.keys(cnt).filter(k => !used.has(parseInt(k)) && cnt[k] === 2);
            if (remain.length === groupLen)
                return _cacheCardTypeLocal(sig, require('./constants').CardType.PLANE_WITH_PAIR, seq[0], groupLen, sorted);
        }
    }
    return null;
}

function canBeat(current, last) {
    const { CardType } = require('./constants');
    if (!last) return true;
    if (current.type === CardType.ROCKET) return true;
    if (last.type === CardType.ROCKET) return false;
    if (current.type === CardType.BOMB && last.type !== CardType.BOMB) return true;
    if (last.type === CardType.BOMB && current.type !== CardType.BOMB) return false;
    if (current.type !== last.type) return false;
    if (current.length && current.length !== last.length) return false;
    return current.value > last.value;
}

function typePowerOf(typeStr, value, length) {
    const { CardType } = require('./constants');
    switch (typeStr) {
        case 'rocket': return 1000;
        case 'bomb': return 500 + value;
        case 'single': return value;
        case 'pair': return value + 20;
        case 'triple': return value + 40;
        case 'triple_single': return value + 60;
        case 'triple_pair': return value + 70;
        case 'straight': return value + 80 + (length || 5);
        case 'straight_pair': return value + 90 + (length || 3);
        case 'plane': return value + 100 + (length || 2) * 3;
        case 'plane_single': return value + 110 + (length || 2) * 3;
        case 'plane_pair': return value + 120 + (length || 2) * 3;
        case 'four_two_single': return value + 110;
        case 'four_two_pair': return value + 120;
        default: return value || 0;
    }
}

function minBeatPower(typeStr, value, length) {
    const { CardType } = require('./constants');
    if (!typeStr || typeStr === 'rocket') return 0;
    if (typeStr === 'bomb') return 500 + value + 1;
    return typePowerOf(typeStr, value + 1, length);
}

function getPlayPower(play) {
    if (!play) return 0;
    let type = getCardType(play);
    if (!type) return 0;
    return typePowerOf(type.type, type.value, type.length);
}

function _canContend(lastPlay, type) {
    const { CardType } = require('./constants');
    if (!lastPlay) return true;
    if (type === 'rocket') return true;
    if (type === 'bomb') return lastPlay.type !== 'rocket';
    return type === lastPlay.type;
}

function _playKey(cards) {
    if (!cards || !cards.length) return '';
    const utils = require('./utils');
    const n = cards.length;
    if (n === 0) return '';
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = utils._cardIdx(cards[i]);
    a.sort((x, y) => x - y);
    return String.fromCharCode.apply(null, a);
}

function playTypeOf(play) {
    if (!play || !play.length) return null;
    const key = _playKey(play);
    const utils = require('./utils');
    const hit = utils._PLAY_TYPE_CACHE.get(key);
    if (hit) return hit;
    const t = getCardType(play);
    if (t) {
        if (utils._PLAY_TYPE_CACHE.size > 4000) utils._PLAY_TYPE_CACHE.clear();
        utils._PLAY_TYPE_CACHE.set(key, t);
    }
    return t;
}

function getAllValidPlays(hand, lastPlay = null, opts) {
    const utils = require('./utils');
    if (!hand || hand.length === 0) return [];
    if (lastPlay && lastPlay.type === require('./constants').CardType.ROCKET) return [];

    const comboCap = (opts && opts.maxComboPerGroup) || 0;
    const cacheKey = utils._validPlaysKey(hand, lastPlay) + (comboCap ? ('#' + comboCap) : '');
    const cached = utils._VALID_PLAYS_CACHE.get(cacheKey);
    if (cached !== undefined) {
        return cached.map(p => p.slice());
    }

    // 等价牌必须稳定表示：否则同一副牌因数组顺序不同会返回“不同的那张 K”，
    // 上层链路可能在另一条 canonical 列表里选中另一张同名牌，被误判为非法牌。
    const hand2 = _canonicalHand(hand);
    let cands = [];
    const byValue = {};
    hand2.forEach(c => { if (!byValue[c.value]) byValue[c.value] = []; byValue[c.value].push(c); });
    const push = (cards, type) => cands.push({ cards, type });

    Object.values(byValue).forEach(arr => { if (arr.length >= 1) push([arr[0]], { type: require('./constants').CardType.SINGLE, value: arr[0].value }); });
    Object.values(byValue).forEach(arr => { if (arr.length >= 2) push([arr[0], arr[1]], { type: require('./constants').CardType.PAIR, value: arr[0].value }); });
    Object.values(byValue).forEach(arr => { if (arr.length >= 3) push([arr[0], arr[1], arr[2]], { type: require('./constants').CardType.TRIPLE, value: arr[0].value }); });
    Object.values(byValue).forEach(arr => { if (arr.length === 4) push(arr, { type: require('./constants').CardType.BOMB, value: arr[0].value + 50 }); });
    if (byValue[13] && byValue[14]) push([byValue[13][0], byValue[14][0]], { type: require('./constants').CardType.ROCKET, value: 100 });

    const { CardType } = require('./constants');
    const { _canContend } = require('./utils');

    if (_canContend(lastPlay, CardType.TRIPLE_WITH_SINGLE)) {
        for (let triple of Object.values(byValue).filter(arr => arr.length >= 3)) {
            let n = 0;
            for (let single of hand2.filter(c => c.value !== triple[0].value)) {
                if (comboCap && n >= comboCap) break;
                push([...triple.slice(0, 3), single], { type: CardType.TRIPLE_WITH_SINGLE, value: triple[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.TRIPLE_WITH_PAIR)) {
        for (let triple of Object.values(byValue).filter(arr => arr.length >= 3)) {
            let n = 0;
            for (let pair of Object.values(byValue).filter(arr => arr.length >= 2 && arr[0].value !== triple[0].value)) {
                if (comboCap && n >= Math.max(1, comboCap >> 1)) break;
                push([...triple.slice(0, 3), ...pair.slice(0, 2)], { type: CardType.TRIPLE_WITH_PAIR, value: triple[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.FOUR_WITH_TWO_SINGLE)) {
        for (let quad of Object.values(byValue).filter(arr => arr.length === 4)) {
            let singles = hand2.filter(c => c.value !== quad[0].value);
            let n = 0;
            for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) {
                if (comboCap && n >= comboCap) break;
                n++;
                push([...quad, singles[i], singles[j]], { type: CardType.FOUR_WITH_TWO_SINGLE, value: quad[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.FOUR_WITH_TWO_PAIR)) {
        for (let quad of Object.values(byValue).filter(arr => arr.length === 4)) {
            let pairs = Object.values(byValue).filter(arr => arr.length >= 2 && arr[0].value !== quad[0].value);
            let n = 0;
            for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
                if (comboCap && n >= Math.max(1, comboCap >> 1)) break;
                n++;
                push([...quad, ...pairs[i].slice(0, 2), ...pairs[j].slice(0, 2)], { type: CardType.FOUR_WITH_TWO_PAIR, value: quad[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.STRAIGHT)) {
        let uniqueValues = [...new Set(hand2.map(c => c.value).filter(v => v < 12))].sort((a, b) => a - b);
        for (let len = 5; len <= 12; len++) {
            for (let i = 0; i + len <= uniqueValues.length; i++) {
                let seq = uniqueValues.slice(i, i + len);
                if (isStraight(seq)) {
                    let cards = [], ok = true;
                    for (let v of seq) { if (!byValue[v]) { ok = false; break; } cards.push(byValue[v][0]); }
                    if (ok) push(cards, { type: CardType.STRAIGHT, value: seq[0], length: len });
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.STRAIGHT_PAIR)) {
        let pairValues = Object.keys(byValue).filter(v => byValue[v].length >= 2 && v < 12).map(Number).sort((a, b) => a - b);
        for (let len = 3; len <= 6; len++) {
            for (let i = 0; i + len <= pairValues.length; i++) {
                let seq = pairValues.slice(i, i + len);
                if (isStraight(seq)) {
                    let cards = [], ok = true;
                    for (let v of seq) { if (!byValue[v] || byValue[v].length < 2) { ok = false; break; } cards.push(byValue[v][0], byValue[v][1]); }
                    if (ok) push(cards, { type: CardType.STRAIGHT_PAIR, value: seq[0], length: len });
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v < 12).map(Number).sort((a, b) => a - b);
        for (let len = 2; len <= tripleValues.length; len++) {
            for (let i = 0; i + len <= tripleValues.length; i++) {
                let seq = tripleValues.slice(i, i + len);
                if (isStraight(seq)) {
                    let cards = [], ok = true;
                    for (let v of seq) { if (!byValue[v] || byValue[v].length < 3) { ok = false; break; } cards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                    if (ok) push(cards, { type: CardType.PLANE, value: seq[0], length: len });
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE_WITH_SINGLE)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v < 12).map(Number).sort((a, b) => a - b);
        for (let len = 2; len <= tripleValues.length; len++) {
            for (let i = 0; i + len <= tripleValues.length; i++) {
                let seq = tripleValues.slice(i, i + len);
                if (!isStraight(seq)) continue;
                let tripleCards = [], ok = true;
                for (let v of seq) { if (!byValue[v] || byValue[v].length < 3) { ok = false; break; } tripleCards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                if (!ok) continue;
                let usedIds = new Set(tripleCards.map(c => c.id));
                let kickers = hand2.filter(c => !usedIds.has(c.id));
                let n = 0;
                for (let combo of getCombinations(kickers, len)) {
                    if (comboCap && n >= comboCap) break;
                    n++;
                    const cards = [...tripleCards, ...combo];
                    const vt = getCardType(cards);
                    if (vt && vt.type === require('./constants').CardType.PLANE_WITH_SINGLE) push(cards, vt);
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE_WITH_PAIR)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v < 12).map(Number).sort((a, b) => a - b);
        let pairValues = Object.keys(byValue).filter(v => byValue[v].length >= 2 && v < 12).map(Number).sort((a, b) => a - b);
        for (let len = 2; len <= Math.min(tripleValues.length, 6); len++) {
            for (let i = 0; i + len <= tripleValues.length; i++) {
                let seq = tripleValues.slice(i, i + len);
                if (!isStraight(seq)) continue;
                let tripleCards = [], ok = true;
                for (let v of seq) { if (!byValue[v] || byValue[v].length < 3) { ok = false; break; } tripleCards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                if (!ok) continue;
                let usedVals = new Set(seq);
                let availPairs = pairValues.filter(v => !usedVals.has(v));
                let n = 0;
                for (let combo of getCombinations(availPairs, len)) {
                    if (comboCap && n >= Math.max(1, comboCap >> 1)) break;
                    n++;
                    let cards = [...tripleCards];
                    let ok2 = true;
                    for (let v of combo) { if (!byValue[v] || byValue[v].length < 2) { ok2 = false; break; } cards.push(byValue[v][0], byValue[v][1]); }
                    if (!ok2) continue;
                    const vt = getCardType(cards);
                    if (vt && vt.type === CardType.PLANE_WITH_PAIR) push(cards, vt);
                }
            }
        }
    }

    let unique = new Map();
    cands.forEach(entry => {
        const key = entry.cards.map(c => c.id).sort().join(',');
        if (!unique.has(key)) unique.set(key, entry);
    });
    let out = [];
    for (const entry of unique.values()) {
        let type = entry.type;
        if (!type || !type.cards) {
            type = getCardType(entry.cards);
            if (!type) continue;
        }
        if (lastPlay && !canBeat(type, lastPlay)) continue;
        type.cards = entry.cards;
        out.push({ cards: entry.cards, type });
    }
    out.sort((a, b) => typePowerOf(a.type.type, a.type.value, a.type.length) - typePowerOf(b.type.type, b.type.value, b.type.length));

    if (cands.length > utils._VALID_PLAYS_CACHE_MAX) utils._VALID_PLAYS_CACHE.clear();
    utils._VALID_PLAYS_CACHE.set(require('./utils')._validPlaysKey(hand, lastPlay), out.map(e => e.cards));
    return out.map(e => e.cards);
}

module.exports = {
    getCardType,
    canBeat,
    typePowerOf,
    minBeatPower,
    getPlayPower,
    getAllValidPlays
};