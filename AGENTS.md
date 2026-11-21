# AGENTS.md

## Overview
Static multi-game PWA collection deployed on GitHub Pages at
`https://unplage.github.io/tiaoqi/`. No build system, no runtime dependencies.
Root `index.html` is the collection shell; each game lives under `games/<id>/`
and is launched by normal relative navigation.

## Current games
- `games/chinese-checkers/`: Chinese checkers legacy app, migrated intact.
- `games/gomoku/`: Gomoku with sandbox and forbidden moves.
- `games/ddz/`: pixel card game (DouDizhu).
- `games/pintu/`: jigsaw puzzle.
- `games/tcs/`: snake evolution.
- `games/dds/`: whack-a-mole.
- `games/elsfk/`: Tetris.
- `games/mahjong/`: Mahjong (multi-player base rules).
- `games/wheel/`: 幸运大转盘（自定义奖池、去重抽奖、抽奖记录）。
- `games/doushouqi/`: 斗兽棋（完整规则 + MiniMax AI + 三档难度）。
- `games/shooter/`: 星际战机（拖拽射击 + 全机型预警弹幕 + 三阶段随机招式 BOSS + 平衡武器 + 评级/续关）。
- `games/longhu/`: 龙虎斗（经典/双人/押注三种玩法）。
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
- Other games rely on their own pages/tests and browser smoke checks.
- Serve locally with `python3 -m http.server`, do not open HTML directly.

## Development commands
- `node verify_rules.js`
- `python3 -m http.server 8080`
