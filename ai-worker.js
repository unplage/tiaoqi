// ai-worker.js - 中国跳棋 AI Web Worker
// 将 AI 计算移至独立线程，避免阻塞主线程

class ChineseCheckersAI {
    constructor() {
        this.SPACING_X = 30;
        this.CENTER_X = 300;
        this.TARGET_MAP = {0:1, 1:0, 2:5, 3:4, 4:3, 5:2};
        this.ROW_COUNTS = [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1];
        this.TOTAL_ROWS = 17;
        this.CORNER_POSITIONS = [
            [{row:16,col:0},{row:15,col:0},{row:15,col:1},{row:14,col:0},{row:14,col:1},{row:14,col:2},{row:13,col:0},{row:13,col:1},{row:13,col:2},{row:13,col:3}],
            [{row:0,col:0},{row:1,col:0},{row:1,col:1},{row:2,col:0},{row:2,col:1},{row:2,col:2},{row:3,col:0},{row:3,col:1},{row:3,col:2},{row:3,col:3}],
            [{row:4,col:0},{row:4,col:1},{row:5,col:0},{row:4,col:2},{row:5,col:1},{row:6,col:0},{row:4,col:3},{row:5,col:2},{row:6,col:1},{row:7,col:0}],
            [{row:4,col:12},{row:4,col:11},{row:5,col:11},{row:4,col:10},{row:5,col:10},{row:6,col:10},{row:4,col:9},{row:5,col:9},{row:6,col:9},{row:7,col:9}],
            [{row:12,col:0},{row:11,col:0},{row:12,col:1},{row:10,col:0},{row:11,col:1},{row:12,col:2},{row:9,col:0},{row:10,col:1},{row:11,col:2},{row:12,col:3}],
            [{row:12,col:12},{row:11,col:11},{row:12,col:11},{row:10,col:10},{row:11,col:10},{row:12,col:10},{row:9,col:9},{row:10,col:9},{row:11,col:9},{row:12,col:9}]
        ];
        // 每个角的入口阻塞位置（基座行靠近中心的3个点，停留此处会阻塞走廊）
        this.BLOCKING_POSITIONS = [
            [{row:13,col:1},{row:13,col:2},{row:13,col:3}],
            [{row:3,col:1},{row:3,col:2},{row:3,col:3}],
            [{row:4,col:1},{row:4,col:2},{row:4,col:3}],
            [{row:4,col:9},{row:4,col:10},{row:4,col:11}],
            [{row:12,col:1},{row:12,col:2},{row:12,col:3}],
            [{row:12,col:9},{row:12,col:10},{row:12,col:11}]
        ];
    }

    isValid(row, col) {
        return row >= 0 && row < this.TOTAL_ROWS && col >= 0 && col < this.ROW_COUNTS[row];
    }

    _rowStartX(row) {
        return this.CENTER_X - (this.ROW_COUNTS[row] - 1) * this.SPACING_X / 2;
    }

    _posX(row, col) {
        return this._rowStartX(row) + col * this.SPACING_X;
    }

    getNeighbors(row, col) {
        const neighbors = [];
        for (const dc of [-1, 1]) {
            if (this.isValid(row, col + dc)) neighbors.push({row: row, col: col + dc});
        }
        for (const dr of [-1, 1]) {
            const nr = row + dr;
            if (nr < 0 || nr >= this.TOTAL_ROWS) continue;
            const px = this._posX(row, col);
            for (let nc = 0; nc < this.ROW_COUNTS[nr]; nc++) {
                if (Math.abs(this._posX(nr, nc) - px) <= this.SPACING_X / 2 + 0.5) {
                    neighbors.push({row: nr, col: nc});
                }
            }
        }
        return neighbors;
    }

    getJumpLanding(pos, adj) {
        const jumpRow = adj.row + (adj.row - pos.row);
        if (jumpRow < 0 || jumpRow >= this.TOTAL_ROWS) return null;
        const mirrorX = 2 * this._posX(adj.row, adj.col) - this._posX(pos.row, pos.col);
        for (let c = 0; c < this.ROW_COUNTS[jumpRow]; c++) {
            if (Math.abs(this._posX(jumpRow, c) - mirrorX) <= 1) {
                return {row: jumpRow, col: c};
            }
        }
        return null;
    }

    _inTargetCorner(pos, player) {
        const target = this.TARGET_MAP[player];
        return this.CORNER_POSITIONS[target].some(tp => tp.row === pos.row && tp.col === pos.col);
    }

    _getOutOfTargetPieces(boardState, player) {
        const targetPositions = this.CORNER_POSITIONS[this.TARGET_MAP[player]];
        const result = [];
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            if (!targetPositions.some(tp => tp.row === r && tp.col === c)) {
                result.push({row: r, col: c});
            }
        });
        return result;
    }

    _minDistToTarget(boardState, player) {
        const targetPositions = this.CORNER_POSITIONS[this.TARGET_MAP[player]];
        let minDist = Infinity;
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            for (const tp of targetPositions) {
                const d = Math.abs(r - tp.row) + Math.abs(c - tp.col);
                if (d < minDist) minDist = d;
            }
        });
        return minDist;
    }

    // 从序列化的 boardState（对象）生成 Map
    getBoardState(boardStateObj) {
        return new Map(Object.entries(boardStateObj));
    }

    getAllMoves(boardState, player) {
        const moves = [];
        const playerPieces = [];
        boardState.forEach((p, key) => {
            if (p === player) {
                const [r, c] = key.split('-').map(Number);
                playerPieces.push({row: r, col: c});
            }
        });
        for (const pos of playerPieces) {
            const restricted = this._inTargetCorner(pos, player);
            for (const n of this.getNeighbors(pos.row, pos.col)) {
                if (boardState.has(`${n.row}-${n.col}`)) continue;
                if (restricted && !this._inTargetCorner(n, player)) continue;
                moves.push({from: pos, to: n, isJump: false, jumpCount: 0});
            }
            const jumpEnds = this._getJumpEndpoints(boardState, pos, pos, player);
            for (const je of jumpEnds) {
                moves.push({from: pos, to: je.pos, isJump: true, jumpCount: je.count});
            }
        }
        return moves;
    }

    _getJumpEndpoints(boardState, startPos, currentPos, player) {
        const results = [];
        const visited = new Set();
        visited.add(`${currentPos.row}-${currentPos.col}`);
        const queue = [{pos: currentPos, count: 0}];
        while (queue.length > 0) {
            const {pos, count} = queue.shift();
            const restricted = this._inTargetCorner(pos, player);
            for (const n of this.getNeighbors(pos.row, pos.col)) {
                if (!boardState.has(`${n.row}-${n.col}`)) continue;
                const landing = this.getJumpLanding(pos, n);
                if (!landing) continue;
                if (boardState.has(`${landing.row}-${landing.col}`)) continue;
                if (landing.row === startPos.row && landing.col === startPos.col) continue;
                if (restricted && !this._inTargetCorner(landing, player)) continue;
                const key = `${landing.row}-${landing.col}`;
                if (visited.has(key)) continue;
                visited.add(key);
                const nc = count + 1;
                results.push({pos: landing, count: nc});
                queue.push({pos: landing, count: nc});
            }
        }
        return results;
    }

    applyMove(boardState, move) {
        const newState = new Map(boardState);
        const key = `${move.from.row}-${move.from.col}`;
        const player = boardState.get(key);
        newState.delete(key);
        newState.set(`${move.to.row}-${move.to.col}`, player);
        return newState;
    }

    evaluate(boardState, player, playOrder) {
        const target = this.TARGET_MAP[player];
        const targetPositions = this.CORNER_POSITIONS[target];
        const startCorner = this.CORNER_POSITIONS[player];
        let score = 0;
        // 统计目标角内棋子数（用于末盘加分）
        let inTargetCount = 0;
        for (const tp of targetPositions) {
            if (boardState.get(`${tp.row}-${tp.col}`) === player) { score += 200; inTargetCount++; }
        }
        // 已使用角集合：起始角+目标角（用于中立角检测）
        const usedCorners = new Set();
        for (const p of playOrder) {
            usedCorners.add(p);
            usedCorners.add(this.TARGET_MAP[p]);
        }
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            let minDist = Infinity;
            for (const tp of targetPositions) {
                const d = Math.abs(r - tp.row) + Math.abs(c - tp.col);
                if (d < minDist) minDist = d;
            }
            score -= minDist * 5;
            let jumpPotential = 0;
            for (const n of this.getNeighbors(r, c)) {
                if (boardState.has(`${n.row}-${n.col}`)) {
                    const mr = 2 * n.row - r, mc = 2 * n.col - c;
                    if (this.isValid(mr, mc) && !boardState.has(`${mr}-${mc}`)) jumpPotential++;
                }
            }
            score += jumpPotential * 10;
            let congestion = 0;
            for (const n of this.getNeighbors(r, c)) {
                if (boardState.get(`${n.row}-${n.col}`) === player) congestion++;
            }
            score -= congestion * 8;
            const inStart = startCorner.some(tp => tp.row === r && tp.col === c);
            if (inStart) score -= congestion * 4;
            if (!inStart) score += 15;
            // 起始角入口阻塞惩罚：停留在此处会阻塞多角星走廊
            for (const bp of this.BLOCKING_POSITIONS[player]) {
                if (r === bp.row && c === bp.col) { score -= 30; break; }
            }
            // 中立角入口阻塞惩罚：未被任何活跃玩家使用的角，停留此处同样阻塞走廊
            for (let ci = 0; ci < 6; ci++) {
                if (usedCorners.has(ci)) continue;
                for (const bp of this.BLOCKING_POSITIONS[ci]) {
                    if (r === bp.row && c === bp.col) { score -= 15; break; }
                }
            }
        });
        // 末盘加分：最后1-2子越接近目标角，奖励越大（非线性）
        if (inTargetCount >= 8) {
            const outCount = 10 - inTargetCount;
            boardState.forEach((p, key) => {
                if (p !== player) return;
                const [r, c] = key.split('-').map(Number);
                if (targetPositions.some(tp => tp.row === r && tp.col === c)) return;
                let md = Infinity;
                for (const tp of targetPositions) {
                    const d = Math.abs(r - tp.row) + Math.abs(c - tp.col);
                    if (d < md) md = d;
                }
                // 末盘时距离权重远大于普通距离惩罚
                score += Math.max(0, (20 - md) * 15 * outCount);
            });
        }
        if (playOrder && playOrder.length === 2) {
            const opponent = playOrder.find(q => q !== player);
            if (opponent !== undefined) {
                const oppTarget = this.CORNER_POSITIONS[opponent];
                boardState.forEach((p, key) => {
                    if (p === player) {
                        const [r, c] = key.split('-').map(Number);
                        for (const tp of oppTarget) {
                            if (tp.row === r && tp.col === c) { score += 30; break; }
                        }
                    }
                });
            }
        }
        if (playOrder && playOrder.length > 2) {
            for (const opp of playOrder) {
                if (opp === player) continue;
                const oppTarget = this.CORNER_POSITIONS[this.TARGET_MAP[opp]];
                for (const tp of oppTarget) {
                    if (boardState.get(`${tp.row}-${tp.col}`) === player) { score += 20; break; }
                }
            }
            // 占据非目标的其他玩家起始角 → 惩罚（避免堵死他人操作空间）
            for (const q of playOrder) {
                if (q === player) continue;
                if (this.TARGET_MAP[player] === q) continue;
                const qStart = this.CORNER_POSITIONS[q];
                for (const tp of qStart) {
                    if (boardState.get(`${tp.row}-${tp.col}`) === player) score -= 25;
                }
            }
        }
        return score;
    }

    _mctsNode(state, player, parent, move) {
        return {state, player, parent, move, children: [], visits: 0, wins: 0, untriedMoves: null};
    }

    _ucb1(node, exploration = 1.414) {
        if (node.visits === 0) return Infinity;
        return node.wins / node.visits + exploration * Math.sqrt(Math.log(node.parent.visits) / node.visits);
    }

    mcts(boardState, player, maxIter, playOrder, maxTime) {
        const root = this._mctsNode(boardState, player, null, null);
        root.untriedMoves = this.getAllMoves(boardState, player);
        const startTime = Date.now();
        if (!maxTime) maxTime = 1500;

        for (let i = 0; i < maxIter; i++) {
            if (Date.now() - startTime > maxTime) break;

            let node = root;
            while (node.untriedMoves && node.untriedMoves.length === 0 && node.children.length > 0) {
                node = node.children.reduce((a, b) => this._ucb1(a) > this._ucb1(b) ? a : b);
            }

            if (node.untriedMoves && node.untriedMoves.length > 0) {
                const idx = Math.floor(Math.random() * node.untriedMoves.length);
                const move = node.untriedMoves.splice(idx, 1)[0];
                const newState = this.applyMove(node.state, move);
                const nextPlayer = this._getNextPlayer(node.player, playOrder);
                const child = this._mctsNode(newState, nextPlayer, node, move);
                child.untriedMoves = this.getAllMoves(newState, nextPlayer);
                node.children.push(child);
                node = child;
            }

            // 模拟：按 playOrder 轮转，任一玩家入角即结束并判胜负（max-n 自利回传）。
            // 复盘不再均匀随机：每个走子者用自己颜色的启发式贪心选子，使复盘能真正走向
            // 终局、回传产生有效信号（否则随机复盘几乎到不了终局，选子退化为乱走）。
            let simState = node.state;
            let simPlayer = node.player;
            let depth = 0;
            const maxDepth = 40;
            let winner = -1;
            while (depth < maxDepth) {
                if (this._checkWinState(simState, player)) { winner = player; break; }
                const moves = this.getAllMoves(simState, simPlayer);
                if (moves.length === 0) break;
                let bestMove = moves[0];
                let bestScore = -Infinity;
                // 末盘强化：走子者有1-2子未入角时，额外奖励入角走法
                const simOut = this._getOutOfTargetPieces(simState, simPlayer).length;
                const simEndgame = simOut <= 2;
                for (const m of moves) {
                    let s = this.evaluate(this.applyMove(simState, m), simPlayer, playOrder);
                    if (simEndgame) {
                        const moved = this.applyMove(simState, m);
                        const movedOut = this._getOutOfTargetPieces(moved, simPlayer).length;
                        if (movedOut < simOut) s += 200; // 入角大幅加分
                        else {
                            const curDist = this._minDistToTarget(simState, simPlayer);
                            const newDist = this._minDistToTarget(moved, simPlayer);
                            s += Math.max(0, (curDist - newDist) * 30);
                        }
                    }
                    if (s > bestScore) { bestScore = s; bestMove = m; }
                }
                simState = this.applyMove(simState, bestMove);
                if (this._checkWinState(simState, simPlayer)) { winner = simPlayer; break; }
                simPlayer = this._getNextPlayer(simPlayer, playOrder);
                depth++;
            }

            const result = winner === player ? 1 : (winner === -1 ? 0.5 : 0);
            let current = node;
            while (current) {
                current.visits++;
                current.wins += result;
                current = current.parent;
            }
        }

        if (root.children.length === 0) return null;
        const best = root.children.reduce((a, b) => a.visits > b.visits ? a : b);
        return best.move;
    }

    _getNextPlayer(current, playOrder) {
        if (!playOrder || playOrder.length === 0) return 0;
        const idx = playOrder.indexOf(current);
        return playOrder[(idx + 1) % playOrder.length];
    }

    _checkWinState(boardState, player) {
        const target = this.TARGET_MAP[player];
        const targetPositions = this.CORNER_POSITIONS[target];
        let count = 0;
        for (const tp of targetPositions) {
            if (boardState.get(`${tp.row}-${tp.col}`) === player) count++;
        }
        return count >= 10;
    }

    minimax(boardState, aiPlayer, playerToMove, depth, alpha, beta, deadline, playOrder) {
        if (this._checkWinState(boardState, aiPlayer)) return {score: Infinity, move: null};
        // paranoid：任一其他玩家入角即视为己方失败（多玩家时其余玩家均作最小化）
        for (const p of playOrder) {
            if (p !== aiPlayer && this._checkWinState(boardState, p)) return {score: -Infinity, move: null};
        }
        if (depth === 0) return {score: this.evaluate(boardState, aiPlayer, playOrder), move: null};
        if (deadline && Date.now() > deadline) return {score: this.evaluate(boardState, aiPlayer, playOrder), move: null};

        const moves = this.getAllMoves(boardState, playerToMove);
        if (moves.length === 0) return {score: this.evaluate(boardState, aiPlayer, playOrder), move: null};

        // 末盘检测：走子者有1-2子未入角时优先推进
        const outCount = this._getOutOfTargetPieces(boardState, playerToMove).length;
        const endgameSort = outCount <= 2;

        moves.sort((a, b) => {
            if (endgameSort) {
                // 末盘：优先选择让走子者最远子靠近目标的走法
                const sa = this.applyMove(boardState, a);
                const sb = this.applyMove(boardState, b);
                const da = this._minDistToTarget(sa, playerToMove);
                const db = this._minDistToTarget(sb, playerToMove);
                return da - db;
            }
            if (a.isJump !== b.isJump) return b.isJump - a.isJump;
            return b.jumpCount - a.jumpCount;
        });

        const limitedMoves = moves.slice(0, 15);
        const isMaximizing = (playerToMove === aiPlayer);
        const nextPlayer = this._getNextPlayer(playerToMove, playOrder);

        if (isMaximizing) {
            let maxEval = -Infinity;
            let bestMove = limitedMoves[0];
            for (const move of limitedMoves) {
                const newState = this.applyMove(boardState, move);
                const evalResult = this.minimax(newState, aiPlayer, nextPlayer, depth - 1, alpha, beta, deadline, playOrder);
                if (evalResult.score > maxEval) {
                    maxEval = evalResult.score;
                    bestMove = move;
                }
                alpha = Math.max(alpha, evalResult.score);
                if (beta <= alpha) break;
            }
            return {score: maxEval, move: bestMove};
        } else {
            let minEval = Infinity;
            let bestMove = limitedMoves[0];
            for (const move of limitedMoves) {
                const newState = this.applyMove(boardState, move);
                const evalResult = this.minimax(newState, aiPlayer, nextPlayer, depth - 1, alpha, beta, deadline, playOrder);
                if (evalResult.score < minEval) {
                    minEval = evalResult.score;
                    bestMove = move;
                }
                beta = Math.min(beta, evalResult.score);
                if (beta <= alpha) break;
            }
            return {score: minEval, move: bestMove};
        }
    }

    // 本方 10 子到各自目标角的最小曼哈顿距离总和（越小=离胜利越近，用于前进优先破平）
    distanceSum(boardState, player) {
        const target = this.TARGET_MAP[player];
        const targetPositions = this.CORNER_POSITIONS[target];
        let dist = 0;
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            let md = Infinity;
            for (const tp of targetPositions) {
                md = Math.min(md, Math.abs(r - tp.row) + Math.abs(c - tp.col));
            }
            dist += md;
        });
        return dist;
    }

    getBestMove(boardStateObj, currentPlayer, difficulty, playOrder) {
        const boardState = this.getBoardState(boardStateObj);
        const player = currentPlayer;
        if (!playOrder || playOrder.length === 0) playOrder = [0, 1];

        const allMoves = this.getAllMoves(boardState, player);
        if (allMoves.length === 0) return null;

        // 制胜步快速扫描：任一走法直接入满目标角则立即返回（不依赖候选截断，
        // 防止制胜单步被排在走法列表末尾而漏掉）
        for (const m of allMoves) {
            if (this._checkWinState(this.applyMove(boardState, m), player)) return m;
        }

        // 末盘检测：本方在目标角外的棋子数（<=2 视为末盘）
        const outOfTarget = this._getOutOfTargetPieces(boardState, player);
        const isEndgame = outOfTarget.length <= 2;

        const base = {
            easy:   {iter: 200,  depth: 2, maxTime: 500},
            medium: {iter: 800,  depth: 3, maxTime: 900},
            hard:   {iter: 1500, depth: 4, maxTime: 1500}
        };
        const cfg = base[difficulty] || base.medium;
        const nFactor = playOrder.length === 2 ? 1 : (playOrder.length <= 4 ? 0.75 : 0.6);
        const iterations = Math.max(60, Math.round(cfg.iter * nFactor));
        // 末盘时增加搜索深度（最后1-2子需要多步规划）
        const depthReduction = playOrder.length === 2 ? 0 : (playOrder.length <= 4 ? 1 : 1);
        const endgameBonus = isEndgame ? 2 : 0;
        const depth = Math.max(1, cfg.depth - depthReduction + endgameBonus);
        const maxTime = Math.round(cfg.maxTime * nFactor);

        // 末盘：把最后一子的走法排到最前面，确保不被 CANDIDATE_LIMIT 截断
        let orderedMoves = allMoves;
        if (isEndgame && outOfTarget.length === 1) {
            const s = outOfTarget[0];
            const stragglerMoves = allMoves.filter(m =>
                m.from.row === s.row && m.from.col === s.col
            );
            const otherMoves = allMoves.filter(m =>
                !(m.from.row === s.row && m.from.col === s.col)
            );
            orderedMoves = [...stragglerMoves, ...otherMoves];
        }

        const PROGRESS_WINDOW = 15;
        const CANDIDATE_LIMIT = 15;
        const deadlineMs = {easy: 400, medium: 700, hard: 1200};
        const deadline = Date.now() + Math.round((deadlineMs[difficulty] || 700) * nFactor);
        const nextPlayer = this._getNextPlayer(player, playOrder);
        const scored = orderedMoves.slice(0, CANDIDATE_LIMIT).map((m) => {
            const child = this.applyMove(boardState, m);
            return {
                m,
                value: this.minimax(child, player, nextPlayer, depth - 1, -Infinity, Infinity, deadline, playOrder).score,
                progress: this.distanceSum(child, player)
            };
        });
        let best = -Infinity;
        for (const s of scored) best = Math.max(best, s.value);
        const candidates = scored.filter(s => s.value >= best - PROGRESS_WINDOW);
        // 随机打乱等价候选，增加走棋多样性
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        candidates.sort((a, b) => a.progress - b.progress);
        // 保护：如果最佳候选距离比当前更差，但有候选距离更优，优先选距离更优的
        const curDist = this.distanceSum(boardState, player);
        if (candidates.length > 0 && candidates[0].progress > curDist) {
            const better = candidates.filter(s => s.progress <= curDist);
            if (better.length > 0) {
                better.sort((a, b) => b.value - a.value);
                const mmMove = better[0].m;

        // 根节点启发式平局检测：minimax 最佳候选间差异极小（≤5）时 minimax 无法可靠区分，
        // 用 MCTS 做更宽的探索破平
        let flat = true;
        let flatBest = -Infinity, flatSecond = -Infinity;
        for (const s of scored) {
            if (s.value > flatBest) { flatSecond = flatBest; flatBest = s.value; }
            else if (s.value > flatSecond) { flatSecond = s.value; }
        }
        if (flatBest - flatSecond > 5) flat = false;
        if (flat) {
            const mctsMove = this.mcts(boardState, player, iterations, playOrder, maxTime);
            if (mctsMove) {
                const mmScore = this.evaluate(this.applyMove(boardState, mmMove), player, playOrder);
                const mctsScore = this.evaluate(this.applyMove(boardState, mctsMove), player, playOrder);
                if (mctsScore > mmScore) return mctsMove;
            }
        }
        return mmMove;
    }
}

// Web Worker 消息处理
const ai = new ChineseCheckersAI();

self.onmessage = function(e) {
    const { type, data, token } = e.data;
    
    if (type === 'getBestMove') {
        const { boardState, currentPlayer, difficulty, playOrder } = data;
        try {
            const bestMove = ai.getBestMove(boardState, currentPlayer, difficulty, playOrder);
            self.postMessage({ type: 'bestMove', data: bestMove, token: token });
        } catch (err) {
            self.postMessage({ type: 'error', data: err.message, token: token });
        }
    }
};
