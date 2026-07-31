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

    evaluate(boardState, player) {
        const target = this.TARGET_MAP[player];
        const targetPositions = this.CORNER_POSITIONS[target];
        let score = 0;
        for (const tp of targetPositions) {
            if (boardState.get(`${tp.row}-${tp.col}`) === player) score += 200;
        }
        boardState.forEach((p, key) => {
            if (p === player) {
                const [r, c] = key.split('-').map(Number);
                let minDist = Infinity;
                for (const tp of targetPositions) {
                    const d = Math.abs(r - tp.row) + Math.abs(c - tp.col);
                    if (d < minDist) minDist = d;
                }
                score -= minDist * 5;
            }
        });
        const opponent = 1 - player;
        const oppTarget = this.CORNER_POSITIONS[opponent];
        boardState.forEach((p, key) => {
            if (p === player) {
                const [r, c] = key.split('-').map(Number);
                for (const tp of oppTarget) {
                    if (tp.row === r && tp.col === c) { score += 30; break; }
                }
            }
        });
        return score;
    }

    _mctsNode(state, player, parent, move) {
        return {state, player, parent, move, children: [], visits: 0, wins: 0, untriedMoves: null};
    }

    _ucb1(node, exploration = 1.414) {
        if (node.visits === 0) return Infinity;
        return node.wins / node.visits + exploration * Math.sqrt(Math.log(node.parent.visits) / node.visits);
    }

    mcts(boardState, player, maxIter = 800) {
        const root = this._mctsNode(boardState, player, null, null);
        root.untriedMoves = this.getAllMoves(boardState, player);
        const startTime = Date.now();
        const maxTime = 1500;

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
                const nextPlayer = this._getNextPlayer(node.player, player);
                const child = this._mctsNode(newState, nextPlayer, node, move);
                child.untriedMoves = this.getAllMoves(newState, nextPlayer);
                node.children.push(child);
                node = child;
            }

            let simState = node.state;
            let simPlayer = node.player;
            let depth = 0;
            const maxDepth = 60;
            while (depth < maxDepth) {
                if (this._checkWinState(simState, player)) break;
                if (this._checkWinState(simState, 1 - player)) break;
                const moves = this.getAllMoves(simState, simPlayer);
                if (moves.length === 0) break;
                const randMove = moves[Math.floor(Math.random() * moves.length)];
                simState = this.applyMove(simState, randMove);
                simPlayer = this._getNextPlayer(simPlayer, player);
                depth++;
            }

            const aiWon = this._checkWinState(simState, player);
            const oppWon = this._checkWinState(simState, 1 - player);
            const result = aiWon ? 1 : (oppWon ? 0 : 0.5);
            let current = node;
            while (current) {
                current.visits++;
                current.wins += (current.player === player) ? result : (1 - result);
                current = current.parent;
            }
        }

        if (root.children.length === 0) return null;
        const best = root.children.reduce((a, b) => a.visits > b.visits ? a : b);
        return best.move;
    }

    _getNextPlayer(current, aiPlayer) {
        return current === aiPlayer ? 0 : aiPlayer;
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

    minimax(boardState, aiPlayer, playerToMove, depth, alpha, beta, deadline) {
        if (this._checkWinState(boardState, aiPlayer)) return {score: Infinity, move: null};
        if (this._checkWinState(boardState, 1 - aiPlayer)) return {score: -Infinity, move: null};
        if (depth === 0) return {score: this.evaluate(boardState, aiPlayer), move: null};
        if (deadline && Date.now() > deadline) return {score: this.evaluate(boardState, aiPlayer), move: null};

        const moves = this.getAllMoves(boardState, playerToMove);
        if (moves.length === 0) return {score: this.evaluate(boardState, aiPlayer), move: null};

        moves.sort((a, b) => {
            if (a.isJump !== b.isJump) return b.isJump - a.isJump;
            return b.jumpCount - a.jumpCount;
        });

        const limitedMoves = moves.slice(0, 15);

        const isMaximizing = (playerToMove === aiPlayer);
        if (isMaximizing) {
            let maxEval = -Infinity;
            let bestMove = limitedMoves[0];
            for (const move of limitedMoves) {
                const newState = this.applyMove(boardState, move);
                const evalResult = this.minimax(newState, aiPlayer, 1 - aiPlayer, depth - 1, alpha, beta, deadline);
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
                const evalResult = this.minimax(newState, aiPlayer, aiPlayer, depth - 1, alpha, beta, deadline);
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

    getBestMove(boardStateObj, currentPlayer, difficulty) {
        const boardState = this.getBoardState(boardStateObj);
        const player = currentPlayer;

        let piecesInTarget = 0;
        const target = this.TARGET_MAP[player];
        const targetPositions = this.CORNER_POSITIONS[target];
        boardState.forEach((p, key) => {
            if (p === player) {
                const [r, c] = key.split('-').map(Number);
                for (const tp of targetPositions) {
                    if (tp.row === r && tp.col === c) { piecesInTarget++; break; }
                }
            }
        });

        const isEndgame = piecesInTarget >= 7;
        const allMoves = this.getAllMoves(boardState, player);
        if (allMoves.length === 0) return null;

        let iterations, depth;
        switch (difficulty) {
            case 'easy':
                iterations = 200; depth = 2;
                break;
            case 'hard':
                iterations = 1500; depth = 4;
                break;
            default:
                iterations = 800; depth = 3;
        }

        if (isEndgame) {
            const result = this.minimax(boardState, player, player, depth, -Infinity, Infinity, Date.now() + 800);
            return result.move || allMoves[0];
        } else {
            const move = this.mcts(boardState, player, iterations);
            return move || allMoves[0];
        }
    }
}

// Web Worker 消息处理
const ai = new ChineseCheckersAI();

self.onmessage = function(e) {
    const { type, data } = e.data;
    
    if (type === 'getBestMove') {
        const { boardState, currentPlayer, difficulty } = data;
        try {
            const bestMove = ai.getBestMove(boardState, currentPlayer, difficulty);
            self.postMessage({ type: 'bestMove', data: bestMove });
        } catch (err) {
            self.postMessage({ type: 'error', data: err.message });
        }
    }
};
