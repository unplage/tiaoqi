# ddz — 像素风格斗地主 PWA

## 项目概览

纯前端单页应用，斗地主（Doudizhu）纸牌游戏，单机 / 联机双模式融合。**无构建工具、无包管理器、无 lint**，直接用浏览器打开即可运行；校验靠 `bench/` 下的 Node 脚本。

| 文件 | 内容 |
|---|---|
| `index.html` | 完整应用（UI + 单机 vs AI + P2P 联机），约 3100 行 |
| `ai_core.js` | **共享 AI 内核**（约 3000 行）：牌型/记牌器/信念模型/评分/DP/残局/MCTS，浏览器与 Worker 双端复用 |
| `ai_worker.js` | AI 推理 Worker：`importScripts('ai_core.js')` + 参数/规则注入 + 消息协议 |
| `learn_worker.js` | **学习 Worker**：反事实分析 → 权重更新 → 配对自对弈验证 → 采纳/拒绝 |
| `ai_learner.js` | 浏览器侧学习层：参数存储、纠错规则、对局数据库、对局录制、参数 UI |
| `sw.js` | Service Worker，离线缓存（`CACHE_VERSION` 与 `index.html` 的 `<meta name="app-version">` 必须一致） |
| `manifest.json` / `icons/` | PWA 清单与像素风图标（`icons/make_icons.js` 为纯 Node 生成器） |
| `clear.html` | 清理 localStorage / IndexedDB 的维护页 |
| `bench/` | Node 基准与测试（不参与部署），见下"校验"一节 |

### 加载顺序（不可调换）

```
index.html
  ├── ai_core.js      →  定义 DEFAULT_PARAMS / cfg()
  ├── ai_learner.js   →  顶层 const 会立即读 DEFAULT_PARAMS，必须在 ai_core.js 之后
  └── <script> 主脚本
```

Worker 侧用 `importScripts('ai_core.js')`；Worker 之间共享全局词法作用域，因此 `const`/`class` 声明互相可见（但**不会**挂到 `globalThis` 上 —— 这条曾经坑过 `window.AiWorkerPool`）。

---

## 校验（改动后必跑）

```bash
node bench/run_all.js            # 全部（快）
node bench/run_all.js --slow     # 加上强度回归与耗时分位数
node bench/run_all.js --only=rules,smoke
```

| 脚本 | 覆盖 | 断言数 |
|---|---|---|
| `rules_test.js` | 牌型引擎单元测试 + 500 手 fuzz（每手枚举全部候选并校验合法性） | 60 |
| `smoke.js` | 五级难度的出牌/叫分路径、记牌器一致性、`lastReasoning` | 1000+ 决策 |
| `replay_test.js` | 回放重建局面 + 记牌器不变量（`sum(remain)==54-已出牌`） | 70 |
| `memory_test.js` | 记牌器单元测试 + Worker 序列化往返（`passHints` 不能丢） | 42 |
| `blind_fairness.js` | 隐藏信息公平性：换掉对手手牌，决策必须完全一致 | 40 |
| `worker_smoke.js` | Worker 六条命令协议 + 与主线程决策一致性 | 13 |
| `online_smoke.js` | 联机三端协议（建房/身份/伪造动作拒绝/掉线托管/重连/整局） | 51 |
| `learner_test.js` | 学习闭环：反事实分析、评估能区分好坏候选、噪声不被采纳 | 14 |
| `run.js` | 配对自对弈 A/B（胜率 + 配对 bootstrap CI + McNemar） | — |
| `latency_test.js` | 各难度决策耗时 p50/p95/p99 + 超时率 | — |

**强度对比必须用 `run.js`，且要够大样本**：

```bash
# 快速回归（压平难度差异，仅测流程正确性）：
node bench/run.js --a hard --b medium --deals 40 --profile fast

# 真实强度对比（保留世界数/随机因子差异，确定性模式，较快）：
node bench/run.js --a legendary --b easy --deals 30 --profile fair

# 更接近线上差异（额外按难度保留 MCTS 迭代数/世界数，明显更慢）：
node bench/run.js --a legendary --b easy --deals 10 --profile diff

# 对比历史版本（保留难度差异）：
node bench/run.js --fileA ai_core.js --fileB /tmp/old.js --a hard --b hard --deals 200 --profile fair

# 复现性自检（同 seed 必须同结果）：
node bench/run.js --check-repro
```

> 说明：`fast` 档为毫秒级单局、压平难度差异，仅用于流程回归；`fair` 档保留盲搜世界数与随机因子、MCTS 用固定小预算，确定性可复现且较快；`diff` 档额外按难度保留 MCTS 迭代数/世界数（`search.useDifficultyBudgets=true`），更接近线上差异但明显更慢。三者都用 `search.deterministic=true` 保证可复现。

> 统计陷阱：n=120 局时 95%CI ≈ ±9pt，**测不出 2~5pt 的真实提升**。
> 要下结论就用 `--deals 250` 以上，或用更低方差的指标。

---

## 关键事实

### 双模式架构

- **单机模式**：AI 对手（`MasterAI` 包装 `AICore`），共享记牌器（`MasterMemory`），五级难度
- **联机模式**：PeerJS P2P，房主+2客户端，全状态同步，断线 AI 托管，10 秒（叫分）/ 15 秒（出牌）倒计时
- 模式由 `GameState.mode`（`'single'` / `'online'`）区分；联机以 `GameState.myRole` 为唯一真值源

### 出牌执行是唯一的状态变更入口

`executePlayCards(player, cards)` 统一做**三重校验**（归属 / 牌型 / 能否压过），返回 `true`/`false`。
- 牌型用**手牌里的真实牌对象**重新解析（不信任调用方的 `value/rank/suit`）→ 防伪造炸弹 + 防 XSS
- 领出方过牌是非法走法，直接拒绝

### 隐藏信息（公平）架构 ★

**公平性红线**：AI 只允许使用**公开信息** —— 自己的手牌、各家剩余张数、已打出的牌、地主底牌。
**禁止读取对手手牌的具体牌面**。新增搜索代码必须走 `HandBelief.sampleWorld()`。

| 组件 | 位置 | 作用 |
|---|---|---|
| `HandBelief` | ai_core.js | 从"未见牌池"采样"可能世界"；`sampleWorld()` / `sampleWorlds(n)` / `bombRiskFor()` / `rocketRiskFor()` / `beatProbability()` |
| `solveEndgameBlind` | ai_core.js | 多世界残局 minimax，跨世界按「均值 − λ×标准差」聚合 |
| `mctsSearchBlind` | ai_core.js | 多世界 MCTS，跨世界按「均值 − λ×标准差 + 覆盖率」聚合 |
| `refineLeadByBelief` | ai_core.js | 领出时估计"被下家压住"的概率 |

**信念采样**：`sampleWorld()` 支持按手牌形状分配未见牌池，但默认 `blind.structuredBelief = 0`（均匀随机）。实测结构化采样会让对手握炸/组合牌比例失真、AI 过度保守；保留开关仅供 A/B 对照。`_worldLikelihood` 用叫分/过牌/出牌画像等公开信息对采样世界加权。

### 难度档位

五档共用同一套启发式/评分/拆牌/搜索框架，差异来自预算与随机性：
- `easy/medium`：只走启发式 + 残局求解（阈值 7/9），无 MCTS；`blunderFactor` 分别 0.25/0.08，会偶尔乱出（关键局面除外）。
- `hard/grandmaster/legendary`：追加盲 MCTS（手牌上限 12/14/17）、对手响应模拟、`beatProb`/炸弹风险修正；`rolling` 精排候选数 8/10/16。
- `legendary` 用满 4500ms MCTS 自适应预算、12 世界残局、80 次叫分模拟、随机因子 0；多 Worker 并行 MCTS 仅在 hard+ 且 ≥2 空闲 Worker 时触发。

### 搜索预算与确定性

- `search.deterministic = true` 时，搜索只用**节点/迭代预算**，不看挂钟 → **同种子必然同结果**（离线评测的前提）
- `search.nodeBudget` 是「本次残局求解的**总**节点数」，不是每候选的
- 运行时（浏览器对局）保持 `deterministic = false`，用时间预算换强度
- `AI_PERF.factor` 由 `calibrateAiSpeed()` 校准设备速度，所有时间预算按它缩放

### 学习闭环（2026-11 重写）

```
对局结束 → GameRecorder 录盘 → learn_worker.js
   ├─ 反事实分析：把每一步与「盲搜索最优解」对比
   ├─ 权重更新：按「权重绝对步长」更新（不是特征归一化后再乘小系数）
   ├─ 配对自对弈验证：同副牌、角色平衡、Wilson CI + 配对 bootstrap
   └─ 只有 95% 下界 > 0.5 才采纳 → 主线程落盘 + 广播给所有 AI Worker
```

**关键设计**：
- 学习**全程在 Worker 里**（旧实现在主线程同步跑 25~43 秒，界面直接卡死）
- 权重步长按**绝对值**定义（`lr = 0.06`），单批步长上限为默认权重的 15%
- 验证用**确定性档**（`deterministicParams`），19× 于线上档的提速（8.3s/局 → 0.44s/局）
- 采纳门槛：≥30 局有效对局、0 无效对局、配对 bootstrap 下界 > 0.5

> 历史教训：旧实现的学习步长 ≈ 1e-4，被 0.0005 阈值过滤 → **最重要的权重 `playPower` 永远学不到**。

### AI Worker 池

`AiWorkerPool` 在 `index.html` 里是**顶层 `const`** → 不会挂到 `window`。
`ParamConfig._persist()` 用 `typeof AiWorkerPool !== 'undefined'` 访问（不要再写 `window.AiWorkerPool`）。

---

## 性能热点（`--cpu-prof` 实测，2026-11）

| 优化 | 位置 | 效果 |
|---|---|---|
| `getCardType` 按点数签名缓存 | ai_core.js | 12.6% → 7.4% CPU |
| `extractHandFeatures` 缓存 | ai_core.js | 10% → 5.8% |
| 牌面 id → 小整数索引，缓存键用 `String.fromCharCode` | ai_core.js | `_playKey` 快一个数量级 |
| `extractPlayFeatures` 用 `Set` 代替 `includes` | ai_core.js | 去掉 O(n·m) 扫描 |
| `outsideBombCount` 单条记忆缓存 | ai_core.js | 同一手牌的所有候选共用一次计算 |
| `search.nodeBudget` 语义修正为「总节点数」 | ai_core.js | 离线评估 19× 提速 |

> **不要**为了提速削弱 rollout 策略：实测把 `heuristicPlayout.richCandidates` 从 8 砍到 4
> 会让胜率从 50% 掉到 42.5%。提速请走缓存。

---

## 操作提示

- 改 AI 后跑 `node bench/run_all.js`（比逐个跑脚本可靠）
- **公平性回归**：`node bench/blind_fairness.js` —— 同一局面造两份 state（另外两人的手牌整体换成不同的牌），
  要求 AI 决策**完全一致**；不一致即说明有代码路径偷看了对手手牌
- 强度回归：`node bench/run.js --a hard --b medium --deals 40`（配对自对弈）
- 与历史版本对比：`git show HEAD~1:ai_core.js > /tmp/old.js` 后用 `--fileA/--fileB` 双文件 A/B
- 调参可用 `--paramsA/--paramsB` 传局部参数覆盖（如 `{"blind":{"worlds":{"mcts":{"hard":2}}}}`）
- 顶栏 `⚡自动` 可设置 AI 算力倍率（`0.5~2.5×`），保存于 `landlord_ai_power`；大于 1 会同步到所有 Worker，更耗电但搜得更久
- 改图标：编辑 `icons/make_icons.js` 的点阵/配色后跑 `node icons/make_icons.js`
- **提交到 GitHub 规则**：
  - `index.html`、`ai_core.js`、`ai_learner.js`、`ai_worker.js`、`learn_worker.js` 任一变更提交时，
    必须同时升 `sw.js` 的 `CACHE_VERSION` **和** `index.html` 的 `<meta name="app-version">`（两者必须一致）
  - `sw.js` 永远与上述文件成对提交，不可单独提交一方
