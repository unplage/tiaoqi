// gomoku-ai-worker.js
const SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

function cloneBoard(board) {
    return board.map(row => row.slice());
}

function isForbidden(board, r, c) {
    // 仅黑棋禁手；白棋永远合法
    if (!inBounds(r, c) || board[r][c] !== EMPTY) return false;
    board[r][c] = BLACK;
    let forbidden = false;

    // 1) 长连（>=6）
    if (countLine(board, r, c, 1, 0, BLACK) >= 6 ||
        countLine(board, r, c, 0, 1, BLACK) >= 6 ||
        countLine(board, r, c, 1, 1, BLACK) >= 6 ||
        countLine(board, r, c, 1, -1, BLACK) >= 6) {
        forbidden = true;
    }

    // 2) 双四：完全由本次落子形成的“活四”达到 2 个以上
    if (!forbidden) {
        let fourCount = 0;
        fourCount += isLiveN(board, r, c, 1, 0, BLACK, 4) ? 1 : 0;
        fourCount += isLiveN(board, r, c, 0, 1, BLACK, 4) ? 1 : 0;
        fourCount += isLiveN(board, r, c, 1, 1, BLACK, 4) ? 1 : 0;
        fourCount += isLiveN(board, r, c, 1, -1, BLACK, 4) ? 1 : 0;
        if (fourCount >= 2) forbidden = true;
    }

    // 3) 双三：完全由本次落子形成的“活三”达到 2 个以上
    if (!forbidden) {
        let threeCount = 0;
        threeCount += isLiveN(board, r, c, 1, 0, BLACK, 3) ? 1 : 0;
        threeCount += isLiveN(board, r, c, 0, 1, BLACK, 3) ? 1 : 0;
        threeCount += isLiveN(board, r, c, 1, 1, BLACK, 3) ? 1 : 0;
        threeCount += isLiveN(board, r, c, 1, -1, BLACK, 3) ? 1 : 0;
        if (threeCount >= 2) forbidden = true;
    }

    board[r][c] = EMPTY;
    return forbidden;
}

function countLine(board, r, c, dr, dc, player) {
    let cnt = 1;
    let rr = r + dr, cc = c + dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) { cnt++; rr += dr; cc += dc; }
    rr = r - dr; cc = c - dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) { cnt++; rr -= dr; cc -= dc; }
    return cnt;
}

// 判断该方向上，本次落子形成的连续段长度是否恰好为 n，且两端开阔
function isLiveN(board, r, c, dr, dc, player, n) {
    let left = 0;
    let rr = r - dr, cc = c - dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) { left++; rr -= dr; cc -= dc; }
    const leftOpen = inBounds(rr, cc) && board[rr][cc] === EMPTY;

    let right = 0;
    rr = r + dr; cc = c + dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) { right++; rr += dr; cc += dc; }
    const rightOpen = inBounds(rr, cc) && board[rr][cc] === EMPTY;

    const total = left + 1 + right;
    if (total !== n) return false;
    if (!leftOpen || !rightOpen) return false;
    return true;
}

function legalMoves(board, player, forbiddenEnabled) {
    const result = [];
    const hasStone = board.some(row => row.some(v => v !== EMPTY));
    if (!hasStone) {
        return [[7, 7]];
    }
    const seen = new Set();
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            // 必须靠近已有棋子，控制搜索宽度
            let near = false;
            for (let rr = Math.max(0, r - 2); rr <= Math.min(SIZE - 1, r + 2) && !near; rr++) {
                for (let cc = Math.max(0, c - 2); cc <= Math.min(SIZE - 1, c + 2); cc++) {
                    if (board[rr][cc] !== EMPTY) { near = true; break; }
                }
            }
            if (!near) continue;
            if (player === BLACK && forbiddenEnabled && isForbidden(cloneBoard(board), r, c)) continue;
            const key = r * 100 + c;
            if (!seen.has(key)) { seen.add(key); result.push([r, c]); }
        }
    }
    if (result.length === 0) {
        for (let r = 0; r < SIZE; r++)
            for (let c = 0; c < SIZE; c++) {
                if (board[r][c] === EMPTY && !(player === BLACK && forbiddenEnabled && isForbidden(cloneBoard(board), r, c))) {
                    result.push([r, c]);
                }
            }
    }
    return result;
}

function hasWinner(board) {
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const p = board[r][c];
            if (p === EMPTY) continue;
            if (countLine(board, r, c, 1, 0, p) >= 5) return p;
            if (countLine(board, r, c, 0, 1, p) >= 5) return p;
            if (countLine(board, r, c, 1, 1, p) >= 5) return p;
            if (countLine(board, r, c, 1, -1, p) >= 5) return p;
        }
    return 0;
}

function scoreRun(len, openEnds) {
    if (len >= 5) return 100000;
    if (len === 4) return openEnds === 2 ? 10000 : (openEnds === 1 ? 1000 : 0);
    if (len === 3) return openEnds === 2 ? 1000 : (openEnds === 1 ? 100 : 0);
    if (len === 2) return openEnds === 2 ? 10 : (openEnds === 1 ? 1 : 0);
    return 0;
}

function evaluateBoard(board, forPlayer) {
    const opponent = forPlayer === BLACK ? WHITE : BLACK;
    let myScore = 0, opScore = 0;

    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const p = board[r][c];
                if (p !== BLACK && p !== WHITE) continue;
                // 只在段起点处评分，避免重复
                const prevR = r - dr, prevC = c - dc;
                if (inBounds(prevR, prevC) && board[prevR][prevC] === p) continue;

                // 计算该方向连续段
                let cnt = 0;
                let rr = r, cc = c;
                while (inBounds(rr, cc) && board[rr][cc] === p) { cnt++; rr += dr; cc += dc; }
                const open1 = inBounds(rr, cc) && board[rr][cc] === EMPTY;
                rr = r - dr; cc = c - dc;
                // 已从起点开始，反向仅判断开头开阔
                const open0 = inBounds(rr, cc) && board[rr][cc] === EMPTY;
                const openEnds = (open0 ? 1 : 0) + (open1 ? 1 : 0);
                const s = scoreRun(cnt, openEnds);
                if (p === forPlayer) myScore += s;
                else opScore += s;
            }
        }
    }
    return myScore - opScore * 1.05; // 略微偏重防守
}

function moveValue(board, r, c, player) {
    if (board[r][c] !== EMPTY) return -1e9;
    board[r][c] = player;
    let v = 0;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
        let cnt = 1, openEnds = 0;
        let rr = r + dr, cc = c + dc;
        while (inBounds(rr, cc) && board[rr][cc] === player) { cnt++; rr += dr; cc += dc; }
        if (inBounds(rr, cc) && board[rr][cc] === EMPTY) openEnds++;
        rr = r - dr; cc = c - dc;
        while (inBounds(rr, cc) && board[rr][cc] === player) { cnt++; rr -= dr; cc -= dc; }
        if (inBounds(rr, cc) && board[rr][cc] === EMPTY) openEnds++;
        v += scoreRun(cnt, openEnds);
    }
    board[r][c] = EMPTY;
    return v;
}

function sortCandidates(board, moves, player) {
    const arr = moves.map(([r, c]) => ({ r, c, v: moveValue(board, r, c, player) + moveValue(board, r, c, player === BLACK ? WHITE : BLACK) * 0.9 }));
    arr.sort((a, b) => b.v - a.v);
    return arr.map(x => [x.r, x.c]);
}

function clone2d(b) { return b.map(x => x.slice()); }

function minimax(board, depth, alpha, beta, side, rootPlayer, startTime, timeLimit) {
    if (Date.now() - startTime > timeLimit) return evaluateBoard(board, rootPlayer) * (side === rootPlayer ? 1 : -1);
    const winner = hasWinner(board);
    if (winner === rootPlayer) return 100000 + depth;
    if (winner !== EMPTY && winner !== rootPlayer) return -100000 - depth;
    if (depth === 0) {
        const raw = evaluateBoard(board, rootPlayer);
        return side === rootPlayer ? raw : -raw;
    }
    const moves = legalMoves(board, side, true);
    if (moves.length === 0) {
        const raw = evaluateBoard(board, rootPlayer);
        return side === rootPlayer ? raw : -raw;
    }
    const sorted = sortCandidates(board, moves, side).slice(0, 16);
    let best = -Infinity;
    for (const [r, c] of sorted) {
        board[r][c] = side;
        const val = -minimax(board, depth - 1, -beta, -alpha, side === BLACK ? WHITE : BLACK, rootPlayer, startTime, timeLimit);
        board[r][c] = EMPTY;
        if (val > best) best = val;
        if (val > alpha) alpha = val;
        if (alpha >= beta) break;
        if (Date.now() - startTime > timeLimit) break;
    }
    return best;
}

const ai = { /* namespace */ };

self.onmessage = function (e) {
    const { type, data, token } = e.data;
    if (type !== 'getBestMove') return;
    const { board, player, difficulty, forbiddenEnabled } = data;

    // 全局开关：worker 内部始终按传入规则执行
    const fdEnabled = (forbiddenEnabled !== false);

    try {
        const workBoard = clone2d(board);
        const moves = legalMoves(workBoard, player, fdEnabled);

        // 必胜步快速扫描
        for (const [r, c] of moves) {
            workBoard[r][c] = player;
            const w = hasWinner(workBoard);
            workBoard[r][c] = EMPTY;
            if (w === player) {
                self.postMessage({ type: 'bestMove', data: { row: r, col: c }, token });
                return;
            }
        }

        // 必救步：对方若有立刻制胜，优先堵截
        const opp = player === BLACK ? WHITE : BLACK;
        const oppMoves = legalMoves(workBoard, opp, fdEnabled);
        for (const [r, c] of oppMoves) {
            workBoard[r][c] = opp;
            const w = hasWinner(workBoard);
            workBoard[r][c] = EMPTY;
            if (w === opp) {
                // 对面上一招就能赢，必须堵；若该点合法则直接选用
                if (!(player === BLACK && fdEnabled && isForbidden(clone2d(workBoard), r, c))) {
                    self.postMessage({ type: 'bestMove', data: { row: r, col: c }, token });
                    return;
                }
            }
        }

        const timeMap = { easy: 350, medium: 1200, hard: 2600 };
        const depthMap = { easy: 2, medium: 4, hard: 6 };
        const timeLimit = timeMap[difficulty] || 1200;
        const maxDepth = depthMap[difficulty] || 4;
        const startTime = Date.now();

        if (moves.length === 0) {
            self.postMessage({ type: 'bestMove', data: null, token });
            return;
        }

        const sortedRoot = sortCandidates(workBoard, moves, player);
        let bestMove = sortedRoot[0];

        for (let depth = 1; depth <= maxDepth; depth++) {
            if (Date.now() - startTime > timeLimit * 0.85) break;
            let curBest = sortedRoot[0];
            let curScore = -Infinity;
            let alpha = -Infinity;
            const beta = Infinity;
            for (const [r, c] of sortedRoot) {
                if (Date.now() - startTime > timeLimit * 0.9) break;
                workBoard[r][c] = player;
                const score = -minimax(workBoard, depth - 1, -beta, -alpha, (player === BLACK ? WHITE : BLACK), player, startTime, timeLimit);
                workBoard[r][c] = EMPTY;
                if (score > curScore) {
                    curScore = score;
                    curBest = [r, c];
                }
                if (score > alpha) alpha = score;
            }
            bestMove = curBest;
            if (Date.now() - startTime > timeLimit) break;
        }

        // easy 增加轻微随机性
        if (difficulty === 'easy' && Math.random() < 0.25 && sortedRoot.length > 1) {
            bestMove = sortedRoot[Math.floor(Math.random() * Math.min(3, sortedRoot.length))];
        }

        self.postMessage({ type: 'bestMove', data: { row: bestMove[0], col: bestMove[1] }, token });
    } catch (err) {
        self.postMessage({ type: 'error', data: err.message, token });
    }
};
