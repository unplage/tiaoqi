// src/rules.js — 纠错规则引擎
'use strict';

const { CardType } = require('./constants');
const { getCardType, getAllValidPlays, getPlayPower } = require('./card_types');
const { cfg } = require('./params');

const _MIN_CONFIDENCE = 0.5;
const _MAX_RULES = 50;

function _ruleMatches(rule, ctx) {
    for (let key in rule.context) {
        let val = rule.context[key];
        if (val === true && !ctx[key]) return false;
        if (val === false && ctx[key]) return false;
        if (typeof val === 'number' && typeof ctx[key] === 'number') {
            if (rule.comparators && rule.comparators[key] === 'lte') { if (ctx[key] > val) return false; }
            else if (rule.comparators && rule.comparators[key] === 'gte') { if (ctx[key] < val) return false; }
            else { if (ctx[key] !== val) return false; }
        }
        if (typeof val === 'string' && ctx[key] !== val) return false;
    }
    return true;
}

function _matchCorrectionRules(ctx) {
    let results = [];
    for (let rule of CorrectionRules._rules) {
        if (rule.confidence < _MIN_CONFIDENCE) continue;
        if (_ruleMatches(rule, ctx)) results.push(rule);
    }
    return results;
}

const CorrectionRules = {
    _rules: [],
    _MIN_CONFIDENCE: 0.5,
    init() {
        let saved = localStorage.getItem('landlord_correction_rules');
        if (saved) {
            try {
                let data = JSON.parse(saved);
                if (data && data.version === 1) {
                    this._rules = data.rules || [];
                    return;
                }
            } catch (e) {}
        }
        this._rules = [];
    },
    _persist() {
        try {
            localStorage.setItem('landlord_correction_rules', JSON.stringify({ version: 1, rules: this._rules }));
        } catch (e) {}
    },
    match(ctx) {
        return _matchCorrectionRules(ctx);
    },
    _learnFromAnalysis(mistakes) {
        // ... 简化版，完整逻辑在 ai_learner 中
    },
    _learnFromCorrections(corrections) {
        // ... 简化版
    },
    getStats() {
        return { total: this._rules.length, active: this._rules.filter(r => r.confidence >= this._MIN_CONFIDENCE).length };
    }
};

module.exports = { CorrectionRules };