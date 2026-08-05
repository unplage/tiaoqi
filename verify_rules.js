// 验证 index.html 中真实的走法生成代码：几何相邻、对称性、跳跃落点、目标角规则
// 以及 ai-worker.js 的 AI 逻辑（2P/4P/6P 一致性与多玩家搜索）
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const mainScript = html.match(/<script>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/<\/?script>/g, ''))
  .find(s => s.includes('class ChineseCheckers'));

// ---- DOM 桩 ----
function makeEl() {
  return {
    style: {}, classList: {add(){}, remove(){}, toggle(){}}, dataset: {},
    addEventListener(){}, appendChild(){}, remove(){},
    setAttribute(){}, getAttribute(){ return null; },
    innerHTML: '', textContent: '', disabled: false,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({width: 600, height: 540}),
  };
}
const elements = {};
const document = {
  getElementById: id => elements[id] || (elements[id] = makeEl()),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener(){}, head: {appendChild(){}},
};
const window = { addEventListener(){} };
const navigator = { serviceWorker: undefined };

const factory = new Function('document', 'window', 'navigator',
  mainScript + '\n;return {Game: ChineseCheckers, game: game};');
const {Game, game} = factory(document, window, navigator);

// AI 类位于 ai-worker.js（index.html 通过 Web Worker 委托，内联无此类）
const workerSrc = fs.readFileSync(path.join(__dirname, 'ai-worker.js'), 'utf8');
const selfStub = { onmessage: null, postMessage(){} };
const aiFactory = new Function('self', workerSrc + '\n;return {AI: ChineseCheckersAI};');
const {AI} = aiFactory(selfStub);
const ai = new AI();

const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const ok = (msg) => console.log('PASS:', msg);
let checks = 0;
function assert(cond, msg) {
  checks++;
  if (cond) ok(msg); else fail(msg);
}

// ================= 1. getNeighbors == 渲染几何真值 =================
// 真值阈值随当前缩放换算（跨行相邻距离 = hypot(半格x, 一格y)）
function scaledSpacing() {
  const sx = game.positions[1][1].x - game.positions[1][0].x;
  const sy = game.positions[1][0].y - game.positions[2][0].y;
  return [sx, sy];
}
function trueAdjSet() {
  const [sx, sy] = scaledSpacing();
  const maxDist = Math.hypot(sx / 2, sy) + 0.5;
  const out = new Set();
  for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
    for (let r2 = 0; r2 < 17; r2++) for (let c2 = 0; c2 < game.rowCounts[r2]; c2++) {
      if (r2 === r && c2 === c) continue;
      const dx = game.positions[r2][c2].x - game.positions[r][c].x;
      const dy = game.positions[r2][c2].y - game.positions[r][c].y;
      if (dx * dx + dy * dy <= maxDist * maxDist) out.add([r + ',' + c, r2 + ',' + c2].sort().join('|'));
    }
  }
  return out;
}
function graphAdjSet() {
  const out = new Set();
  for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
    for (const n of game.getNeighbors(r, c)) {
      if (n.row < 0 || n.row >= 17 || n.col < 0 || n.col >= game.rowCounts[n.row]) {
        fail(`越界邻居 (${r},${c})->(${n.row},${n.col})`); continue;
      }
      out.add([r + ',' + c, n.row + ',' + n.col].sort().join('|'));
    }
  }
  return out;
}
const trueAdj = trueAdjSet();
const graphAdj = graphAdjSet();
assert(trueAdj.size === 312, `渲染几何相邻边 = ${trueAdj.size}（应为 312）`);
assert(graphAdj.size === 312, `getNeighbors 互惠边 = ${graphAdj.size}（应为 312）`);
const gMissing = [...trueAdj].filter(e => !graphAdj.has(e));
const gExtra = [...graphAdj].filter(e => !trueAdj.has(e));
assert(gMissing.length === 0, `几何相邻但走法图缺失: ${gMissing.length} 条（应为 0）`);
assert(gExtra.length === 0, `走法图有但几何不相邻: ${gExtra.length} 条（应为 0）`);

for (const [r, c] of [[0, 0], [16, 0]]) {
  assert(game.getNeighbors(r, c).length === 2, `尖角 (${r},${c}) 邻居数 = ${game.getNeighbors(r, c).length}（应为 2）`);
}

// ================= 2. AI 与游戏邻居全棋盘一致 =================
let aiMismatch = 0;
for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
  const g = game.getNeighbors(r, c).map(n => n.row + ',' + n.col).sort().join(';');
  const a = ai.getNeighbors(r, c).map(n => n.row + ',' + n.col).sort().join(';');
  if (g !== a) aiMismatch++;
}
assert(aiMismatch === 0, `AI 与游戏 getNeighbors 全棋盘一致（不一致数 = ${aiMismatch}）`);

// ================= 3. 空棋盘：单步 = 邻居集合 =================
game.currentPlayer = 0;
game.boardState.clear();
game.isInJumpChain = false;
game.jumpStartPosition = {row: -1, col: -1};
// 注意：规则要求目标角内棋子不得移出，因此角内起点会缺失越角邻居目标
const cornerCells = new Set(game.getAllCornerPositions()[1].map(p => p.row + ',' + p.col));
let stepMiss = 0, stepBad = 0, totalStep = 0;
for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
  const moves = game.calculateValidMoves({row: r, col: c});
  const got = new Set(moves.map(m => m.row + ',' + m.col));
  const want = new Set(game.getNeighbors(r, c).map(n => n.row + ',' + n.col));
  if (cornerCells.has(r + ',' + c)) {
    for (const w of [...want]) if (!cornerCells.has(w)) want.delete(w);
  }
  totalStep += want.size;
  for (const w of want) if (!got.has(w)) stepMiss++;
  for (const m of moves) if (m.isJump) stepBad++;
  if (got.size !== want.size) stepBad++;
}
assert(stepMiss === 0, `单步目标数与邻居一致（含角内规则，缺失 = ${stepMiss}，共 ${totalStep}）`);
assert(stepBad === 0, `空棋盘无跳跃误报（异常 = ${stepBad}）`);

// ================= 4. 跳跃落点正确性 =================
// 同排跳跃
game.boardState.clear();
game.boardState.set('5-1', 0);
game.boardState.set('5-2', 0);
const moves = game.calculateValidMoves({row: 5, col: 1});
assert(!!moves.find(m => m.row === 5 && m.col === 3 && m.isJump), '同排跳跃 (5,1) 越过 (5,2) 落 (5,3) 存在');
// 跨行跳跃（旧方向集无法正确表达的边界情况）：(4,5) 越过 (3,1) 落 (2,1)
game.boardState.clear();
game.boardState.set('4-5', 0);
game.boardState.set('3-1', 1);
const moves2 = game.calculateValidMoves({row: 4, col: 5});
const land = moves2.find(m => m.isJump);
assert(land && land.row === 2 && land.col === 1, `跨行跳跃 (4,5) 越过 (3,1) 落 (2,1)${land ? '（实际 ' + land.row + ',' + land.col + '）' : ''}`);
// 旧错误邻居 (3,0)->(4,0) 135px 幻影边不应再出现
game.boardState.clear();
game.boardState.set('3-0', 0);
const moves3 = game.calculateValidMoves({row: 3, col: 0});
assert(!moves3.some(m => m.row === 4 && m.col === 0), '旧 135px 幻影走法 (3,0)->(4,0) 已消除');

// ================= 5. 游戏与 AI 走法完全一致（含目标角规则） =================
function buildBoard(scenario) {
  const st = new Map();
  if (scenario === 'full2P') {
    for (const p of [{r:16,c:0},{r:15,c:0},{r:15,c:1},{r:14,c:0},{r:14,c:1},{r:14,c:2},{r:13,c:0},{r:13,c:1},{r:13,c:2},{r:13,c:3}]) st.set(`${p.r}-${p.c}`, 0);
    for (const p of [{r:0,c:0},{r:1,c:0},{r:1,c:1},{r:2,c:0},{r:2,c:1},{r:2,c:2},{r:3,c:0},{r:3,c:1},{r:3,c:2},{r:3,c:3}]) st.set(`${p.r}-${p.c}`, 1);
    st.delete('13-0'); st.set('4-5', 0); // 红子跳入中路
    st.set('5-1', 1); st.set('5-2', 1); // 蓝子成被跳链
  } else {
    for (const [k, p] of [['5-0',0],['5-1',0],['4-6',0],['6-0',1],['6-1',1],['7-1',1]]) st.set(k, p);
    st.set('1-1', 0); st.set('3-2', 0); // 0 在目标角（角1）内
    st.set('14-1', 1); // 1 在目标角（角0）内
  }
  return st;
}
for (const scenario of ['full2P', 'corner']) {
  const st = buildBoard(scenario);
  game.boardState = st;
  game.currentPlayer = 0;
  game.isInJumpChain = false;
  game.jumpStartPosition = {row: -1, col: -1};
  const gameMoves = new Set();
  for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
    if (st.get(`${r}-${c}`) !== 0) continue;
    for (const m of game.calculateValidMoves({row: r, col: c})) gameMoves.add(`${r}-${c}>${m.row}-${m.col}`);
  }
  const aiMoves = new Set(ai.getAllMoves(st, 0).map(m => `${m.from.row}-${m.from.col}>${m.to.row}-${m.to.col}`));
  const onlyGame = [...gameMoves].filter(m => !aiMoves.has(m));
  const onlyAI = [...aiMoves].filter(m => !gameMoves.has(m));
  assert(onlyGame.length === 0 && onlyAI.length === 0,
    `场景[${scenario}] 游戏与 AI 走法完全一致（仅游戏=${onlyGame.length}，仅AI=${onlyAI.length}）`);
  if (onlyGame.length) console.log('  仅游戏:', onlyGame.slice(0, 5).join(' '));
  if (onlyAI.length) console.log('  仅AI:', onlyAI.slice(0, 5).join(' '));
}

// ================= 6. 目标角内不可移出 =================
{
  game.boardState = buildBoard('corner');
  game.currentPlayer = 0;
  game.isInJumpChain = false;
  game.jumpStartPosition = {row: -1, col: -1};
  const cornerMoves = game.calculateValidMoves({row: 1, col: 1});
  const cornerCells = new Set(game.getAllCornerPositions()[1].map(p => p.row + ',' + p.col));
  let out = 0;
  for (const m of cornerMoves) if (!cornerCells.has(m.row + ',' + m.col)) out++;
  assert(out === 0 && cornerMoves.length > 0, `角内棋子无越角走法（越界=${out}，角内走法=${cornerMoves.length}）`);
  const normMoves = game.calculateValidMoves({row: 5, col: 0});
  assert(normMoves.some(m => !cornerCells.has(m.row + ',' + m.col)), '角外棋子可自由移动');
}

// ================= 7. AI 跳跃落点非空校验 =================
{
  const st = new Map();
  st.set('4-4', 0); st.set('4-5', 1); st.set('4-6', 0);
  const aij = ai.getAllMoves(st, 0);
  let bad = 0;
  for (const m of aij) {
    if (!m.isJump) continue;
    if (st.has(`${m.to.row}-${m.to.col}`)) bad++;
  }
  assert(bad === 0, `AI 跳跃落点非空检查（${aij.length} 个走法，非法=${bad}）`);
}

console.log(process.exitCode ? '\n有 FAIL' : '\n全部通过（' + checks + ' 项检查）');

// ================= 8. 布局适配：任意容器尺寸下不截断、几何仍正确、尽量大 =================
{
  const containerEl = elements['board-container'];
  const sizes = [
    [375, 640],     // 手机竖屏
    [844, 390],     // 手机横屏（高度受限）
    [1920, 1040],   // 桌面
    [1920, 700],    // 桌面矮窗口（宽>高，旧版棋子溢出棋盘的回归场景）
    [320, 200],     // 极小屏
    [600, 540],     // 默认兜底
  ];
  let clip = 0, geoBad = 0, sizeBad = 0;
  const reports = [];
  for (const [W, H] of sizes) {
    containerEl.offsetWidth = W;
    containerEl.offsetHeight = H;
    game.calculatePositions();
    const s = game.currentScale;
    // 正方形棋盘区：边长取宽高较小值；坐标以 #board（边长 side）为基准
    const side = Math.min(W, H);
    const expect = Math.min((side - 40) / 360, (side - 40) / ((game.totalRows - 1) * game.spacingY));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
      const p = game.positions[r][c];
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // 内容必须完整落在棋盘（side×side）内；棋盘由容器 flex 居中，故亦在容器内
    if (minX < 0 || maxX > side || minY < 0 || maxY > side) clip++;
    if (Math.abs(s - expect) > 1e-9) sizeBad++;
    // 每个尺寸下重新做全量几何校验（旧实现在此处会缺失/幻影）
    const t = trueAdjSet(), g = graphAdjSet();
    const miss = [...t].filter(e => !g.has(e)).length;
    const extra = [...g].filter(e => !t.has(e)).length;
    if (miss || extra) geoBad += miss + extra;
    const sx = scaledSpacing()[0];
    const pieceDia = 2 * Math.max(4, Math.round(13 * s));
    const holeDia = 2 * Math.max(3, Math.round(9 * s));
    if (s >= 0.15 && (pieceDia > sx || holeDia > sx)) sizeBad++;
    reports.push(`${W}x${H}: scale=${s.toFixed(3)} 内容范围 x[${minX.toFixed(0)},${maxX.toFixed(0)}] y[${minY.toFixed(0)},${maxY.toFixed(0)}]`);
  }
  console.log('  布局采样:\n    ' + reports.join('\n    '));
  assert(clip === 0, `各尺寸棋盘内容均在容器内（越界=${clip}）`);
  assert(geoBad === 0, `各尺寸下几何相邻零缺失/零幻影（异常=${geoBad}）`);
  assert(sizeBad === 0, `缩放比例取满可用空间、棋子/洞尺寸不重叠（异常=${sizeBad}）`);
  containerEl.offsetWidth = 600; containerEl.offsetHeight = 540;
  game.calculatePositions();
}

// ================= 9. 多人模式：非 0/1 玩家的走法一致性 =================
function multiBoard(players) {
  const st = new Map();
  for (const p of players) {
    for (const pos of game.getAllCornerPositions()[p]) st.set(`${pos.row}-${pos.col}`, p);
  }
  // 中路添加被跳链，制造跳跃场景
  st.set('4-5', players[1]); st.set('4-6', players[1]);
  st.set('8-5', players[2]); st.set('8-6', players[2]);
  return st;
}
{
  const scenarios = [
    { players: [0, 1, 2, 5], label: '4P' },
    { players: [0, 1, 2, 3, 4, 5], label: '6P' },
  ];
  for (const { players, label } of scenarios) {
    const st = multiBoard(players);
    for (const p of players) {
      game.boardState = st;
      game.currentPlayer = p;
      game.isInJumpChain = false;
      game.jumpStartPosition = { row: -1, col: -1 };
      const gameMoves = new Set();
      for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
        if (st.get(`${r}-${c}`) !== p) continue;
        for (const m of game.calculateValidMoves({ row: r, col: c })) gameMoves.add(`${r}-${c}>${m.row}-${m.col}`);
      }
      const aiMoves = new Set(ai.getAllMoves(st, p).map(m => `${m.from.row}-${m.from.col}>${m.to.row}-${m.to.col}`));
      const onlyGame = [...gameMoves].filter(m => !aiMoves.has(m));
      const onlyAI = [...aiMoves].filter(m => !gameMoves.has(m));
      assert(onlyGame.length === 0 && onlyAI.length === 0,
        `[${label}] 玩家${p} 游戏与 AI 走法完全一致（仅游戏=${onlyGame.length}，仅AI=${onlyAI.length}）`);
    }
  }
}

// ================= 10. playOrder 轮转与名次顺序 =================
{
  assert(ai._getNextPlayer(0, [0,1,2,5]) === 1, '4P 下一位 0→1');
  assert(ai._getNextPlayer(5, [0,1,2,5]) === 0, '4P 下一位 5→0（循环回起点）');
  assert(ai._getNextPlayer(4, [0,1,2,5,4,3]) === 3, '6P 下一位 4→3');
  assert(ai._getNextPlayer(3, [0,1,2,5,4,3]) === 0, '6P 下一位 3→0');
  assert(game.getPlayOrder().join(',') === '0,1,2,5,4,3', '6P 出场顺序');
  game.playerCount = 4;
  assert(game.getPlayOrder().join(',') === '0,1,2,5', '4P 出场顺序');
  game.playerCount = 2;
  assert(game.getPlayOrder().join(',') === '0,1', '2P 出场顺序');
  game.playerCount = 6;
}

// ================= 11. 多人 evaluate 单调性（越靠近目标评分越高） =================
{
  const playOrder = [0, 1, 2, 5];
  const st = multiBoard(playOrder);
  st.set('6-1', 2);              // 玩家 2 起始角的一子
  const base = ai.evaluate(st, 2, playOrder);
  st.delete('6-1');
  st.set('8-5', 2);              // 挪近目标角（角5），(8,5) 为空
  const closer = ai.evaluate(st, 2, playOrder);
  assert(closer > base, `多人 evaluate 靠近目标得分更高（${base} -> ${closer}）`);
}

// ================= 12. 多人 getBestMove 合法走法 =================
{
  const playOrder = [0, 1, 2, 5];
  const st = multiBoard(playOrder);
  st.set('4-5', 1); st.set('5-5', 1);   // 跳链
  for (const p of playOrder) {
    const mv = ai.getBestMove(Object.fromEntries(st), p, 'easy', playOrder);
    assert(!!mv, `4P 玩家${p} getBestMove 有解`);
    if (mv) {
      assert(st.get(`${mv.from.row}-${mv.from.col}`) === p, `4P 玩家${p} 走法来自本棋子`);
      assert(!st.has(`${mv.to.row}-${mv.to.col}`), `4P 玩家${p} 走法落点为空`);
    }
  }
}

// ================= 13. 全 AI 4P 冒烟对局（名次齐全、有限步结束） =================
// 每名玩家 9 子已在目标角、1 子在入口格（单步可入）：验证排名轮转、离场跳过与
// 仅用“活跃玩家”参与 AI 搜索（避免已完成玩家的对角被 paranoid 视为己方失败）。
{
  const playOrder = [0, 1, 2, 5];
  const entrance = {
    0: { target: 1, empty: [3, 3], piece: [4, 7] },
    1: { target: 0, empty: [13, 3], piece: [12, 7] },
    2: { target: 5, empty: [12, 9], piece: [12, 8] },
    5: { target: 2, empty: [7, 0], piece: [8, 0] },
  };
  let st = new Map();
  for (const p of playOrder) {
    const cfg = entrance[p];
    const corner = game.getAllCornerPositions()[cfg.target];
    for (const pos of corner) {
      if (pos.row === cfg.empty[0] && pos.col === cfg.empty[1]) continue;
      st.set(`${pos.row}-${pos.col}`, p);
    }
    st.set(`${cfg.piece[0]}-${cfg.piece[1]}`, p);
  }
  const finished = [];
  let current = playOrder[0];
  let steps = 0;
  const nextActive = (cur) => {
    const i = playOrder.indexOf(cur);
    for (let k = 1; k <= playOrder.length; k++) {
      const c = playOrder[(i + k) % playOrder.length];
      if (!finished.includes(c)) return c;
    }
    return cur;
  };
  while (finished.length < playOrder.length - 1 && steps < 100) {
    if (!finished.includes(current)) {
      const active = playOrder.filter(p => !finished.includes(p));
      const move = ai.getBestMove(Object.fromEntries(st), current, 'easy', active);
      if (move) {
        st = ai.applyMove(st, move);
        if (ai._checkWinState(st, current)) finished.push(current);
      }
    }
    current = nextActive(current);
    steps++;
  }
  const last = playOrder.find(p => !finished.includes(p));
  if (last !== undefined && !finished.includes(last)) finished.push(last);
  assert(finished.length === playOrder.length, `全 AI 4P 对局决出全部名次（${finished.length}/${playOrder.length}，步数=${steps}）`);
  assert(steps < 100, `全 AI 4P 对局有限步内结束（${steps} 步）`);
}

// ================= 14. AI 不"乱走"：开局/中盘走子必须改善本方启发式 =================
// 回归防护：中盘引擎若退化为随机选子，会出现大量"走完本方评分变差"的走法。
{
  const playOrder = [0, 1];
  const makeBoard = () => new Map([
    ['13-0',0],['13-1',0],['13-2',0],['13-3',0],['14-0',0],['14-1',0],['14-2',0],['15-0',0],['15-1',0],['16-0',0],
    ['3-0',1],['3-1',1],['3-2',1],['3-3',1],['2-0',1],['2-1',1],['2-2',1],['1-0',1],['1-1',1],['0-0',1]
  ]);
  const heur = (st, p) => {
    const t = ai.TARGET_MAP[p]; let s = 0;
    for (const tp of ai.CORNER_POSITIONS[t]) if (st.get(`${tp.row}-${tp.col}`) === p) s += 200;
    st.forEach((q, k) => { if (q === p) {
      const [r, c] = k.split('-').map(Number);
      let md = 1e9;
      for (const tp of ai.CORNER_POSITIONS[t]) md = Math.min(md, Math.abs(r - tp.row) + Math.abs(c - tp.col));
      s -= md * 5;
    }});
    return s;
  };
  let neg = 0, count = 0, slowest = 0;
  for (let i = 0; i < 5; i++) {
    const st = makeBoard();
    const t0 = Date.now();
    const move = ai.getBestMove(Object.fromEntries(st), 0, 'easy', playOrder);
    slowest = Math.max(slowest, Date.now() - t0);
    const next = ai.applyMove(st, move);
    if (heur(next, 0) < heur(st, 0)) neg++;
    count++;
  }
  assert(neg === 0, `2P 开局 easy 首手不降低本方评分（负向 ${neg}/${count}）`);
  assert(slowest < 1000, `2P 开局 easy 单步耗时 < 1s（实测 ${slowest}ms）`);
}

// ================= 15. 僵局检测（连续无进展→提示，不判和） =================
{
  game.setMode(2);
  game.reset();
  const corners = game.getAllCornerPositions();
  game.boardState.clear();
  // 玩家0: 9 子在目标角1（除 (0,0)），第 10 子 (8,3) 在中场被封死
  for (const p of corners[1].slice(1)) game.boardState.set(`${p.row}-${p.col}`, 0);
  game.boardState.set('8-3', 0);
  // 玩家1: 9 子在目标角0（除 (13,3)），第 10 子 (3,3)
  for (const p of corners[0].slice(0, 9)) game.boardState.set(`${p.row}-${p.col}`, 1);
  game.boardState.set('3-3', 1);
  game.bestProgress = {0: game.progressScore(0), 1: game.progressScore(1)};
  game.stagnation = 0;
  for (let i = 0; i < 39; i++) game.updateStagnation(0);
  game.maybeTriggerStalemate();
  assert(game.awaitingStalemate === false, '连续 39 步无进展不触发僵局');
  game.updateStagnation(0);
  game.maybeTriggerStalemate();
  assert(game.awaitingStalemate === true, '连续 40 步无进展触发僵局提示');
  game.advanceTurn();
  assert(game.currentPlayer === 0, '僵局提示期间不推进回合');
  game.continueAfterStalemate();
  assert(game.awaitingStalemate === false, '继续对局后解除僵局');
  // 取得进展（棋子向目标角靠近）→ 计数清零
  game.boardState.delete('8-3');
  game.boardState.set('6-3', 0);
  game.updateStagnation(0);
  assert(game.stagnation === 0, '取得进展后僵局计数清零');
  game.reset();
  assert(game.awaitingStalemate === false, 'reset 清空僵局状态');
}

// ================= 16. AI 前进优先：中盘平移占比 + 制胜步抓取 =================
{
  // 2P medium 自对弈 100 步：统计“前进（距离和下降）/平移（不变）/后退”
  const mkPos = () => ai.getBoardState({
    '13-0':0,'13-1':0,'13-2':0,'13-3':0,'14-0':0,'14-1':0,'14-2':0,'15-0':0,'15-1':0,'16-0':0,
    '3-0':1,'3-1':1,'3-2':1,'3-3':1,'2-0':1,'2-1':1,'2-2':1,'1-0':1,'1-1':1,'0-0':1
  });
  const dsum = (st, p) => {
    const t = ai.TARGET_MAP[p]; let s = 0;
    st.forEach((q, k) => { if (q === p) {
      const [r, c] = k.split('-').map(Number);
      let md = 1e9;
      for (const tp of ai.CORNER_POSITIONS[t]) md = Math.min(md, Math.abs(r - tp.row) + Math.abs(c - tp.col));
      s += md;
    }});
    return s;
  };
  let st = mkPos(), cur = 0, fwd = 0, lat = 0;
  for (let i = 0; i < 100; i++) {
    const d0 = dsum(st, cur);
    const m = ai.getBestMove(Object.fromEntries(st), cur, 'medium', [0, 1]);
    st = ai.applyMove(st, m);
    const dd = dsum(st, cur) - d0;
    if (dd < 0) fwd++; else if (dd === 0) lat++;
    if (ai._checkWinState(st, cur)) break;
    cur = cur === 0 ? 1 : 0;
  }
  assert(fwd >= 50, `2P 中盘前进占比高（前进 ${fwd}，平移 ${lat}）`);
  assert(lat <= 50, `2P 中盘平移占比受控（前进 ${fwd}，平移 ${lat}）`);

  // 制胜步抓取：9 子入角 + 入口子一步可入，任何难度都必须立刻制胜
  const wb = new Map();
  for (const p of ai.CORNER_POSITIONS[1]) wb.set(`${p.row}-${p.col}`, 0);
  for (const p of ai.CORNER_POSITIONS[0]) wb.set(`${p.row}-${p.col}`, 1);
  wb.delete('3-3');
  wb.set('4-7', 0);
  assert(ai.getAllMoves(wb, 0).some(m => m.to.row === 3 && m.to.col === 3), '制胜局面构造有效');
  const wm = ai.getBestMove(Object.fromEntries(wb), 0, 'medium', [0, 1]);
  assert(ai._checkWinState(ai.applyMove(wb, wm), 0), 'AI 必抓制胜步（medium）');
  const wmH = ai.getBestMove(Object.fromEntries(wb), 0, 'hard', [0, 1]);
  assert(ai._checkWinState(ai.applyMove(wb, wmH), 0), 'AI 必抓制胜步（hard）');
}

console.log(process.exitCode ? '\n有 FAIL' : '\n全部通过（' + checks + ' 项检查）');
