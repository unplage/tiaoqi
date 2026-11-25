// src/constants.js — 常量与枚举
'use strict';

const CardType = {
    SINGLE: 'single',
    PAIR: 'pair',
    TRIPLE: 'triple',
    TRIPLE_WITH_SINGLE: 'triple_single',
    TRIPLE_WITH_PAIR: 'triple_pair',
    STRAIGHT: 'straight',
    STRAIGHT_PAIR: 'straight_pair',
    FOUR_WITH_TWO_SINGLE: 'four_two_single',
    FOUR_WITH_TWO_PAIR: 'four_two_pair',
    BOMB: 'bomb',
    ROCKET: 'rocket',
    PLANE: 'plane',
    PLANE_WITH_SINGLE: 'plane_single',
    PLANE_WITH_PAIR: 'plane_pair'
};

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♣', '♦'];
const _SUIT_CODE = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };
const _RANK_CODE = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, 'J': 8, 'Q': 9, 'K': 10, 'A': 11, '2': 12 };

const ENDGAME_PASS = { __endgamePass: true };
const MCTS_PRIOR_VISITS = 8;

if (typeof module !== 'undefined') {
    module.exports = { CardType, RANKS, SUITS, _SUIT_CODE, _RANK_CODE, ENDGAME_PASS, MCTS_PRIOR_VISITS };
}