// 验证 index.html 中真实的走法生成代码：几何相邻、对称性、跳跃落点、目标角规则
const fs = require('fs');

const html = fs.readFileSync('/home/jiemiaoxing/work/opencode_task/tiaoqi/index.html', 'utf8');
const mainScript = html.match(/<script>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/<\/?script>/g, ''))
  .find(s => s.includes('class ChineseCheckers'));

// ---- DOM 桩 ----
function makeEl() {
  return {
    style: {}, classList: {add(){}, remove(){}}, dataset: {},
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
  mainScript + '\n;return {Game: ChineseCheckers, AI: ChineseCheckersAI, game: game};');
const {Game, AI, game} = factory(document, window, navigator);
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
    // 正方形棋盘区：边长取宽高较小值
    const side = Math.min(W, H);
    const expect = Math.min((side - 32) / 360, (side - 32) / ((game.totalRows - 1) * game.spacingY));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let r = 0; r < 17; r++) for (let c = 0; c < game.rowCounts[r]; c++) {
      const p = game.positions[r][c];
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (minX < 0 || maxX > W || minY < 0 || maxY > H) clip++;
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
console.log(process.exitCode ? '\n有 FAIL' : '\n全部通过（' + checks + ' 项检查）');
