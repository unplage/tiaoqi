// src/search.js — 残局求解 + MCTS
'use strict';

const { CardType, ENDGAME_PASS } = require('./constants');
const { getCardType, getAllValidPlays, canBeat, getPlayPower, typePowerOf, minBeatPower, extractPlayFeatures, scorePlay, computePassScore } = require('./evaluation');
const { MasterMemory } = require('./memory');
const { HandBelief } = require('./hand_belief');
const { getCardType: getCardTypeUtil } = require('./card_types');
const { _applyPlay, _undoPlay, _orderPlayScore, _endgameKeyFast, _cloneStateShallow, _staticEvalHands, _endgameStaticEval, _memoryFromState, endgameMinimax, minimaxEndgame, solveEndgame, solveEndgameBlind, endgameValue, heuristicPlayoutWithMode, _handTurnsEstimate, _sideTurnsEstimate, _playoutTerminalEval, MCTS_PRIOR_VISITS, MCTSNode, mctsSearch, selectPlayFromMctsAgg, _collectRootStats, _buildRootPriors, mctsSearchBlind } = require('./utils'); // 简化：实际需要从 utils 导出

// 由于模块分割复杂，这里提供核心搜索函数的框架
// 完整实现保留在 ai_core.js，按需迁移

module.exports = {
    // 残局求解
    solveEndgameBlind,
    solveEndgame,
    endgameValue,
    minimaxEndgame,
    endgameMinimax,
    // MCTS
    mctsSearch,
    mctsSearchBlind,
    // 启发式模拟
    heuristicPlayoutWithMode,
    // 工具
    _applyPlay,
    _undoPlay,
    _orderPlayScore,
    _endgameKeyFast,
    _cloneStateShallow,
    _staticEvalHands,
    _endgameStaticEval,
    _memoryFromState,
    _endgameKeyFast,
    // MCTS 类
    MCTSNode,
    mctsSearch,
    mctsSearchBlind,
    selectPlayFromMctsAgg,
    _collectRootStats,
    _buildRootPriors,
    mctsSearchBlind,
    // 模拟
    heuristicPlayoutWithMode,
    _handTurnsEstimate,
    _sideTurnsEstimate,
    _playoutTerminalEval,
    // MCTS 类
    MCTSNode,
    mctsSearch,
    mctsSearchBlind,
    selectPlayFromMctsAgg,
    _collectRootStats,
    _buildRootPriors
};