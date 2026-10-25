# ddz — 像素风格斗地主

## 项目概览

纯前端单页应用，斗地主（Doudizhu）纸牌游戏，单机 / 联机双模式融合：

| 文件 | 内容 |
|---|---|
| `index.html` | 完整应用（UI + 单机 vs AI + P2P 联机），约 2500 行 |
| `ai_core.js` | **共享 AI 内核**（约 1900 行）：牌型/记牌器/信念模型/评分/DP/残局/MCTS，浏览器与 Worker 双端复用 |
| `ai_learner.js` | AI 自学习、CEM 参数优化、复盘分析、纠错规则引擎、自对弈验证 |
| `ai_worker.js` | Web Worker 外壳：`importScripts('ai_core.js')` + 参数/规则注入 + 消息处理 |
| `sw.js` | Service Worker，离线缓存 |
| `manifest.json` | PWA 清单 |
| `bench/` | Node 基准与探针（配对自对弈 / 冒烟 / 求解器探针 / 联机冒烟），不参与部署 |
| `icons/` | PWA 图标（像素风：地主金冠 + 三张牌）；`make_icons.js` 为纯 Node 生成器（手写 PNG 编码，无依赖） |
| `clear.html` | 清理 localStorage / IndexedDB 的维护页 |

无构建工具、无包管理器、无 lint。直接浏览器打开即可运行。
校验靠 `bench/` 下的 Node 脚本（见"操作提示"）。

## 关键事实

- **运行方式**：打开 `index.html` 到浏览器；或 `python3 -m http.server 8080` 后访问
- **加载顺序**：`ai_core.js` 必须在 `ai_learner.js` 之前加载（`index.html` 已保证）
- **CDN依赖（需联网）**：Tailwind CSS、Google Fonts Press Start 2P、PeerJS（联机模式）
- **数据持久化**：`localStorage` key `landlord_stats`（战绩/金币/统计）、`landlord_ai_params`（AI 参数）、`landlord_correction_rules`（纠错规则）；对局记录在 IndexedDB
- **前端架构**：纯内联 HTML+CSS+JS，零框架，无模块系统
- **音效**：Web Audio API 合成（`playSound` 函数），无需音频文件
- **语音播报**：`speechSynthesis` API，中文语音
- **触摸优化**：禁用双击缩放、阻止非手牌区域滚动、`touch-action: manipulation`

## 双模式架构

开始画面选择模式：

- **单机模式**：AI 对手（`MasterAI` 包装 `AICore`），共享记牌器（`MasterMemory`），五级难度（easy/medium/hard/grandmaster/legendary）
- **联机模式**：PeerJS P2P，房主+2客户端，全状态同步，断线 AI 托管，10 秒（叫分）/ 15 秒（出牌）倒计时

模式由 `GameState.mode`（`'single'` / `'online'`）区分；联机以 `GameState.myRole` 为唯一真值源。

## 单机 AI：隐藏信息（公平）架构 ★

**公平性红线**：AI 只允许使用**公开信息** —— 自己的手牌、各家剩余张数、已打出的牌、地主底牌。
**禁止读取对手手牌的具体牌面**。新增搜索代码必须走 `HandBelief.sampleWorld()`，不得直接读 `state.players[对手]`。

| 组件 | 位置 | 作用 |
|---|---|---|
| `HandBelief` | ai_core.js | 从"未见牌池"（54 张 − 自己手牌 − 已出牌 − 地主底牌）采样"可能世界"；`sampleWorld()` / `sampleWorlds(n)`；`bombRiskFor()` / `rocketRiskFor()` / `beatProbability()` |
| `solveEndgameBlind` | ai_core.js | 多世界残局 minimax，跨世界按「均值 − λ×标准差」聚合（λ=`blind.robustness`），只比较样本数相同的候选 |
| `mctsSearchBlind` | ai_core.js | 多世界 MCTS，根节点用启发式先验（`blind.mctsRootPriors`），跨世界按「均值 − λ×标准差 + 覆盖率」聚合后取胜率最高者 |
| `simulateOpponentResponseBlind` | ai_core.js | 多世界对手响应模拟，取期望 |
| `refineLeadByBelief` | ai_core.js（`AICore`） | 领出时估计"被下家压住"的概率，在启发式首选与更稳的领出之间取舍 |
| `_cloneStateShallow` | ai_core.js | 轻量状态拷贝（替代 JSON 深拷贝），MCTS 每次 expand / playout 都省一次深拷贝 → 同预算下迭代数更多 |

- **god-view 函数仅限离线**：`solveEndgame` / `minimaxEndgame` / `endgameValue` 保留给 `ai_learner.js` 的反事实分析与 `bench/` 基准，**运行时决策链禁止调用**。
- **Worker 侧物理隔离**：`AiWorkerPool._serializeState(state, playerId)` 只把"自己的手牌"发给 Worker，对手只传 `{length:n}`（与联机同步的瘦身策略一致）→ AI 在 Worker 里也拿不到对手手牌。
- **参数**：全部集中在 `DEFAULT_PARAMS.blind`（`worlds.*` 各环节世界数、`endgameTimeBudgetMs` / `mctsTimeBudgetMs` 时间预算、`robustness`、`beatProb*` 领出被压概率、`bombRiskWeight` 对手握炸概率修正、`mctsRootPriors`）。
- **难度阶梯**：easy/medium 不用 MCTS、只用启发式（外加少量世界采样）；hard 及以上启用盲 MCTS + 多世界残局 + 盲响应模拟。
- **单次决策耗时**（实测，桌面 CPU）：medium ≈ 13ms，hard ≈ 460ms，grandmaster ≈ 810ms，legendary ≈ 1.6s。
- **移动端自适应**：`calibrateAiSpeed()` 用"枚举一手 17 张牌的所有合法出牌"做轻量基准，算出设备速度系数
  `AI_PERF.factor`（桌面 ≈1.0，中端手机 ≈0.4，低端 ≈0.15），**所有时间预算按该系数缩放**：
  hard 桌面 ≈500ms → 手机 ≈110~200ms；legendary 桌面 ≈1.6s → 手机 ≈350~700ms。
- **主线程回退不卡 UI**：`MasterAI.think` 走本地内核（Worker 不可用时）额外把 `core.budgetScale` 设为 0.5，
  限制单次同步决策的最长阻塞时间。
- **思考看门狗按实际预算**：`processSinglePlay` 的超时阈值取 `max(thinkingSeconds, 实际预算 + 2.5s)`，
  避免慢设备上把 AI 算好的着法当"思考超时"丢弃（等价于强制过牌）。
- **AI 思考指示**：`setAiThinkingHint()` 在 AI 回合显示"思考中…"，避免玩家误以为界面卡死。
- **在线模式同样公平**：房主端 AI 托管走的是同一套盲决策；广播给客户端时对手手牌只传张数（`broadcastFullState` 里做瘦身）。

### 强度实测（`node bench/run.js`，同副牌配对自对弈）

| 对比 | A 胜率 | 样本 |
|---|---|---|
| 盲 hard vs **旧版开天眼 hard**（git HEAD 的 ai_core.js） | 45.8% | 120 局 |
| 盲 hard vs 盲 medium | 71.3% | 80 局 |
| 盲 medium vs 盲 easy | 60.0% | 80 局 |
| 盲 grandmaster vs 盲 hard | 56.2% | 80 局 |
| 盲 grandmaster vs 盲 legendary | 50.0% | 80 局 |

结论：**在完全不看对手手牌的前提下，AI 强度与原来的"开天眼"版本基本持平（差异 ≈ 0.8σ）**；
宗师级与传奇级差距不明显，两者都显著强于大师级。


## 架构要点

- **AI 引擎**：`MasterAI.think(phase, state)` → `AICore.think`；`phase='call'` 返回分数，`phase='play'` 返回出牌数组
- **记牌器**：`MasterMemory` 跟踪剩余牌分布、已出牌历史、炸弹/王炸可能性；两个 AI 共享同一实例（记牌器是公开信息，不构成泄漏）
- **牌型识别**：`getCardType(cards)` 返回 `{type, value, cards}`；`canBeat(current, last)` 比较大小
- **出牌生成**：`getAllValidPlays(hand, lastPlay)` 穷举所有合法牌型
- **牌值编码**：3→0, 4→1, ..., A→11, 2→12, 小王→13, 大王→14
- **花色**：`♠♥♣♦` + `JOKER`
- **GameState 对象**：全局状态（含 `mode`, `myIndex`, `myRole`, `peer`, `connections`, `callScores` 等）
- **状态同步**：联机模式 `broadcastFullState()` / `handleSync()`，房主持有权威状态，按连接顺序分配玩家索引（1, 2）
- **Service Worker**：sw.js 根据自身路径自动确定作用域（`BASE_PATH`），支持 GitHub Pages 多项目部署

## 操作提示

- 修改 AI 后跑 `node bench/smoke.js`：覆盖五级难度的决策路径，检查无异常、无非法牌
- **公平性回归**：`node bench/blind_fairness.js` —— 同一局面造两份 state（把另外两人的手牌整体换成不同的牌），
  要求 AI 决策**完全一致**；不一致即说明有代码路径偷看了对手手牌（该测试用固定种子 + 宽时间预算，避免截断造成假阳性）
- 强度回归跑 `node bench/run.js --a hard --b medium --deals 40`：配对自对弈（同一副牌两种配置各打一遍）
- 与历史版本对比：`git show HEAD~1:ai_core.js > /tmp/old.js` 后用 `--fileA/--fileB` 双文件 A/B
- 调参可用 `--paramsA/--paramsB` 传局部参数覆盖（如 `{"blind":{"worlds":{"mcts":{"hard":2}}}}`）
- 修改后直接刷新浏览器验证（无 lint/构建）
- 改图标：编辑 `icons/make_icons.js` 的点阵/配色后跑 `node icons/make_icons.js`（会重生成 64/128/192/512 + maskable + apple-touch + favicon）
- 全部内联（CSS + HTML + JS 在同一文件），编辑时注意各段范围
- 牌型枚举定义在 `CardType` 常量对象
- 联机叫分/出牌分别 10 秒 / 15 秒超时，超时自动弃权（联机房主端 AI 接管）
- **提交到 GitHub 规则**：
  - `index.html`、`ai_core.js`、`ai_learner.js`、`ai_worker.js` 任一变更提交时，必须同时升版 `sw.js` 中的 `CACHE_VERSION`（如 `v68→v69`）并一起提交
  - `sw.js` 永远与上述文件成对提交，不可单独提交一方
