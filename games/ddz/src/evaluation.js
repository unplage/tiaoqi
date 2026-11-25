// src/evaluation.js — 评分与特征提取
'use strict';

const { CardType } = require('./constants');
const { getCardType, canBeat, getAllValidPlays, getPlayPower, typePowerOf, minBeatPower } = require('./card_types');
const { extractHandFeatures } = require('./features');
const { _outsideBombCountMemo } = require('./utils');
const { matchRules } = require('./rules');

function extractPlayFeatures(play, hand, lastPlay, role, memory, state) {
    let playType = getCardType(play);
    let newHand = hand.filter(c => !play.includes(c));
    let handFeatures = extractHandFeatures(newHand);
    let playPower = getPlayPower(play);
    let isBomb = [CardType.BOMB, CardType.ROCKET].includes(playType.type);
    let needBeat = (lastPlay && state.lastPlayerId !== state.currentPlayer);
    let partnerId = -1;
    if (role === 'farmer') {
        for (let i = 0; i < 3; i++) {
            if (i !== state.currentPlayer && i !== state.landlord) { partnerId = i; break; }
        }
    }
    let kickerValue = 0;
    if (playType.type === CardType.TRIPLE_WITH_SINGLE || playType.type === CardType.TRIPLE_WITH_PAIR) {
        let cnt = require('./utils').countValues(play.map(c => c.value));
        let target = playType.type === CardType.TRIPLE_WITH_SINGLE ? 1 : 2;
        let kv = Object.keys(cnt).find(k => cnt[k] === target && parseInt(k) !== playType.value);
        if (kv !== undefined) kickerValue = parseInt(kv);
    }
    if (playType.type === CardType.PLANE_WITH_SINGLE || playType.type === CardType.PLANE_WITH_PAIR) {
        let cnt = require('./utils').countValues(play.map(c => c.value));
        let target = playType.type === CardType.PLANE_WITH_SINGLE ? 1 : 2;
        let kickerVals = Object.keys(cnt).filter(k => cnt[k] === target).map(Number);
        kickerValue = kickerVals.length > 0 ? Math.max(...kickerVals) : 0;
    }
    let nextPlayerId = (state.currentPlayer + 1) % 3;
    return {
        playLength: play.length, playPower, isBomb: isBomb ? 1 : 0, isRocket: (playType.type === CardType.ROCKET) ? 1 : 0,
        remainTotal: newHand.length, remainSingle: handFeatures.single, remainPair: handFeatures.pair,
        remainTriple: handFeatures.triple, remainBomb: handFeatures.bomb, remainMaxStraight: handFeatures.maxStraightLen,
        remainBigCards: handFeatures.bigCards, hasRocket: handFeatures.hasRocket,
        isLandlord: (role === 'landlord') ? 1 : 0, isFarmer: (role === 'farmer') ? 1 : 0,
        opponentHandCount: state.lastPlayerId !== -1 ? state.players[state.lastPlayerId].length : 0,
        nextPlayerHandCount: state.players[nextPlayerId] ? state.players[nextPlayerId].length : 17,
        partnerHandCount: (role === 'farmer' && partnerId !== -1) ? (state.players[partnerId]?.length || 0) : 0,
        outsideBombCount: _outsideBombCountMemo(memory, hand), isCritical: (newHand.length <= 3) ? 1 : 0,
        needBeat: needBeat ? 1 : 0, lastPlayType: lastPlay ? lastPlay.type : 'none', lastPlayPower: lastPlay ? lastPlay.value : 0,
        lastPlayLength: lastPlay ? (lastPlay.length || 0) : 0,
        playType: playType.type, kickerValue, mainValue: playType.value
    };
}

function computePassScore(role, state) {
    let score = 0;
    let ps = require('./params').cfg('passScores');
    let lordCards = state.players[state.landlord] ? state.players[state.landlord].length : 17;

    if (role === 'farmer' && state.lastPlayerId !== -1 && state.lastPlayerId !== state.currentPlayer && state.lastPlayerId !== state.landlord) {
        if (state.players[state.lastPlayerId].length <= 3) score += require('./params').cfg('playHeuristics.partnerPlay.handLe3');
        if (state.players[state.lastPlayerId].length <= 2) score += require('./params').cfg('playHeuristics.partnerPlay.handLe2');
        if (lastPlayPower >= 40) score += require('./params').cfg('playHeuristics.partnerPlay.lastPowerGe40');
        if (lastPlayPower <= 20) score += require('./params').cfg('playHeuristics.partnerPlay.lastPowerLe20');
    }
    // ... 其他 pass 分数逻辑保持不变，简化版
    return score;
}

// 简化版：核心 scorePlay 逻辑（完整版在 ai_core 中）
function scorePlay(features, role, memory, state, playerHand) {
    let score = 0;
    let W = require('./params').cfg('weights');
    for (let key in W) if (features[key] !== undefined) score += features[key] * W[key];
    // ... 其余启发式规则保持不变
    return score;
}

module.exports = { extractPlayFeatures, computePassScore, scorePlay };