# AGENTS.md

## Overview
Static multi-game PWA collection deployed on GitHub Pages at
`https://unplage.github.io/tiaoqi/`. No build system, no runtime dependencies.
Root `index.html` is the collection shell; each game lives under `games/<id>/`
and is launched by normal relative navigation.

## Current games
- `games/chinese-checkers/`: Chinese checkers legacy app, migrated intact.
- `games/gomoku/`: Gomoku with sandbox and forbidden moves.
- `games/ddz/`: pixel DouDizhu with single-player fair hidden-information AI, PeerJS multiplayer, card counting, and a Worker-based self-learning loop; synced from `unplage/ddz`.
- `games/pintu/`: jigsaw puzzle.
- `games/tcs/`: snake evolution.
- `games/dds/`: whack-a-mole.
- `games/elsfk/`: Tetris.
- `games/mahjong/`: Mahjong (multi-player base rules).
- `games/wheel/`: 幸运大转盘（自定义奖池、去重抽奖、抽奖记录）。
- `games/doushouqi/`: 斗兽棋（完整规则 + MiniMax AI + 三档难度）。
- `games/shooter/`: 星际战机（拖拽射击 + 全机型预警弹幕 + 三阶段随机招式 BOSS + 平衡武器 + 评级/续关）。
- `games/longhu/`: 龙虎斗（经典/双人/押注三种玩法）。
- `games/sanguo/`: 三国群英斩（原创三国横版割草动作，6关/4难度、连段/技能/无双狂斩、闪避格挡与破防、三武器六兵种相克、城门/BOSS 前摇、商店升级、评级成就、离线可用）。
- `games/xiangzhang/`: 我是乡长（乡村经营养成，开放世界 320×256 写意中国地貌（青藏高原/黄河/长江/秦岭/四川盆地/海岸岛屿+迷雾探索+小地图+地标发现）/自定义作物与产物拓展/二十四节气与逐作物农时/天气与三日预报/逐地块土壤肥力/pH/有机质/轮作/品种推广/旱涝水利与地下水位/水权/休耕与暂停/桥梁温室/集市行情与批量出售/种质资源库与良种选育/有机认证/乡村旅游与节庆/地标开发项目/村庄评级与乡村建设/发展路线/每日任务与随机事件/动态向四周无限拓荒与地形改造/相机平移与双指缩放/建造耗时与建材/道路连通/服务覆盖与幸福度/科技/主线与成就/订单/离线收益与挂机自动收成/压缩 IndexedDB 存档，离线可用）。
- `games/mario/`: 超级像素兄弟（马里奥式横版跳跃，4 世界含水下关、像素精灵动画、蹲下/钻管道/隐藏砖、旗杆评分、本地存档、吐火 BOSS，键盘与多点触控，离线可用）。

## Important facts
- Chinese checkers game logic and AI tests are integrated through
  `verify_rules.js`, which reads `games/chinese-checkers/index.html` and
  `games/chinese-checkers/ai-worker.js`.
- Each game is isolated: do not assume shared globals except browser APIs.
- Game-specific Service Workers derive their base path from their own URL.
- Relative URLs only; site runs under `/tiaoqi/`.
- PWA manifests are intentionally game-local; root manifest remains `/tiaoqi/`.
- Static assets cached by SW; changing game pages/assets requires bumping the
  relevant cache version in that game's `sw.js` (and root `sw.js` when root
  assets change).
- Keep UI text and comments in Chinese.

## Testing
- `node verify_rules.js` verifies Chinese checkers rules and layout.
- `node games/ddz/bench/run_all.js` verifies DouDizhu rules, memory, replay, fairness, Worker protocol, online protocol, single-player flow and the learning loop.
- `python3 tools/verify_sanguo.py` verifies 三国群英斩 loading, combat, shop, save persistence and touch controls (requires Playwright + Chromium).
- Other games rely on their own pages/tests and browser smoke checks.
- Serve locally with `python3 -m http.server`, do not open HTML directly.

## Development commands
- `node verify_rules.js`
- `node games/ddz/bench/run_all.js`
- `python3 tools/verify_sanguo.py`
- `python3 -m http.server 8080`
