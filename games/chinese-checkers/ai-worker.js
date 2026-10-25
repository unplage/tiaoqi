// ai-worker.js - 中国跳棋 AI Web Worker
// 将 AI 计算移至独立线程，避免阻塞主线程
//
// 设计目标：以速胜为唯一目的。核心思路：
// 1) 用"几何距离"（棋子到目标角质心的欧氏距离）替代曼哈顿距离，
//    六角棋盘斜向推进不再被低估。
// 2) 走法按（跳步优先 → 落子后距离和升序）排序后再做候选截断，
//    保证真正推进的跳步永远在搜索窗口内。
// 3) 启发式评估把"最慢棋子"（maxD）作为瓶颈重点惩罚：
//    赛跑中最后一个子决定胜负，迫使各子均衡推进、尽早清空本方起始角，
//    避免慢棋被对手占角后永久围死。
// 4) 根节点用贪心 + 前进步长挑选（窗口内取距离和最小者），
//    不做浅层 paranoid 搜索——对手"侵入本方起始角"的威胁会把
//    所有前进走法拖平，导致横向平移的无效走棋。
// 5) 难度差异化：easy/medium 只用贪心（候选窗口宽度不同），
//    hard 在末盘（≤2 子未入角）额外做 3 层自搜索，寻找连走制胜序列。

class ChineseCheckersAI {
    constructor() {
        this.SPACING_X = 30;
        this.SPACING_Y = 26;
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
        // 候选窗口与启发式差异窗口（难度差异化用）
        this.DIFFICULTY_CFG = {
            easy:   {limit: 15, window: 20},
            medium: {limit: 30, window: 15},
            hard:   {limit: 45, window: 10}
        };
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

    _posY(row) {
        return (this.TOTAL_ROWS - 1 - row) * this.SPACING_Y;
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

    // 角的质心（用于几何距离度量）
    _cornerCenter(cornerIdx) {
        let x = 0, y = 0;
        for (const tp of this.CORNER_POSITIONS[cornerIdx]) {
            x += this._posX(tp.row, tp.col);
            y += this._posY(tp.row);
        }
        return {x: x / 10, y: y / 10};
    }

    // 棋子到指定角的最小几何距离（单位：格，入角为 0）
    _pieceDist(row, col, cornerIdx) {
        const cells = this.CORNER_POSITIONS[cornerIdx];
        for (const tp of cells) {
            if (tp.row === row && tp.col === col) return 0;
        }
        const cc = this._cornerCenter(cornerIdx);
        const dx = this._posX(row, col) - cc.x;
        const dy = this._posY(row) - cc.y;
        return Math.hypot(dx, dy) / this.SPACING_X;
    }

    _minDistToTarget(boardState, player) {
        const target = this.TARGET_MAP[player];
        let minDist = Infinity;
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            const d = this._pieceDist(r, c, target);
            if (d < minDist) minDist = d;
        });
        return minDist === Infinity ? 0 : minDist;
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

    // 本方 10 子到各自目标角的几何距离总和（越小=越接近胜利）
    distanceSum(boardState, player) {
        const target = this.TARGET_MAP[player];
        let dist = 0;
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            dist += this._pieceDist(r, c, target);
        });
        return dist;
    }

    // 速胜启发式评分（越大越好）
    evaluate(boardState, player, playOrder) {
        const target = this.TARGET_MAP[player];
        const targetPositions = this.CORNER_POSITIONS[target];
        const startPositions = this.CORNER_POSITIONS[player];
        let score = 0;
        let inTargetCount = 0;
        let maxD = 0;
        // 入角 +250/子；角外按几何距离减分
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            if (targetPositions.some(tp => tp.row === r && tp.col === c)) {
                score += 250;
                inTargetCount++;
            } else {
                const d = this._pieceDist(r, c, target);
                if (d > maxD) maxD = d;
                score -= d * 4;
            }
        });
        // 瓶颈惩罚：最慢棋子决定胜负，重点压低它的距离（防止慢棋掉队被围死）
        score -= maxD * 50;
        // 起始角撤离紧迫性：仍未离开起始角的子有罚分；有对手侵入本方起始角时更急
        let invasion = 0;
        startPositions.forEach(tp => {
            const q = boardState.get(`${tp.row}-${tp.col}`);
            if (q !== undefined && q !== player) invasion++;
        });
        boardState.forEach((p, key) => {
            if (p !== player) return;
            const [r, c] = key.split('-').map(Number);
            if (startPositions.some(tp => tp.row === r && tp.col === c)) {
                score -= 18;
                if (invasion > 0) score -= (24 + invasion * 8);
            }
        });
        return score;
    }

    // 末盘自搜索：只考虑本方连续走子，找直接入满目标角的连走序列
    _endgameSearch(boardState, player, depth, deadline, playOrder) {
        if (this._checkWinState(boardState, player)) return 1e9;
        if (depth === 0 || (deadline && Date.now() > deadline)) return this.evaluate(boardState, player, playOrder);
        const moves = this.getAllMoves(boardState, player);
        if (moves.length === 0) return this.evaluate(boardState, player, playOrder);
        moves.sort((a, b) => {
            if (a.isJump !== b.isJump) return b.isJump - a.isJump;
            return this.distanceSum(this.applyMove(boardState, a), player) - this.distanceSum(this.applyMove(boardState, b), player);
        });
        let best = -Infinity;
        for (const m of moves.slice(0, 15)) {
            const child = this.applyMove(boardState, m);
            if (this._checkWinState(child, player)) return 1e9;
            const v = this._endgameSearch(child, player, depth - 1, deadline, playOrder);
            if (v > best) best = v;
        }
        return best;
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

    getBestMove(boardStateObj, currentPlayer, difficulty, playOrder) {
        const boardState = this.getBoardState(boardStateObj);
        const player = currentPlayer;
        if (!playOrder || playOrder.length === 0) playOrder = [0, 1];

        const allMoves = this.getAllMoves(boardState, player);
        if (allMoves.length === 0) return null;

        // 制胜步快速扫描：任一走法直接入满目标角则立即返回
        for (const m of allMoves) {
            if (this._checkWinState(this.applyMove(boardState, m), player)) return m;
        }

        // 末盘检测：本方在目标角外的棋子数（<=2 视为末盘）
        const outOfTarget = this._getOutOfTargetPieces(boardState, player);
        const isEndgame = outOfTarget.length <= 2;

        const cfg = this.DIFFICULTY_CFG[difficulty] || this.DIFFICULTY_CFG.medium;

        // 候选排序：跳步优先 → 落子后距离和升序（真正推进的跳步总在窗口内）
        let orderedMoves = allMoves.slice().sort((a, b) => {
            if (a.isJump !== b.isJump) return b.isJump - a.isJump;
            return this.distanceSum(this.applyMove(boardState, a), player) - this.distanceSum(this.applyMove(boardState, b), player);
        });

        // 末盘且只剩一子未入角：把它的一切走法排到最前，确保不被窗口截断
        if (isEndgame && outOfTarget.length === 1) {
            const s = outOfTarget[0];
            const stragglerMoves = orderedMoves.filter(m =>
                m.from.row === s.row && m.from.col === s.col
            );
            const otherMoves = orderedMoves.filter(m =>
                !(m.from.row === s.row && m.from.col === s.col)
            );
            orderedMoves = [...stragglerMoves, ...otherMoves];
        }

        const scored = orderedMoves.slice(0, cfg.limit).map((m) => {
            const child = this.applyMove(boardState, m);
            let value;
            // hard 末盘：3 层自搜索寻找连走制胜序列；其余情况纯启发式贪心
            if (difficulty === 'hard' && isEndgame) {
                value = this._endgameSearch(child, player, 3, Date.now() + 200, playOrder);
            } else {
                value = this.evaluate(child, player, playOrder);
            }
            return {
                m,
                value,
                progress: this.distanceSum(child, player)
            };
        });

        let best = -Infinity;
        for (const s of scored) best = Math.max(best, s.value);
        const candidates = scored.filter(s => s.value >= best - cfg.window);
        // 随机打乱等价候选，增加走棋多样性
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        // 窗口内取"前进最多"（距离和最小）者
        candidates.sort((a, b) => a.progress - b.progress);
        return candidates[0].m;
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
