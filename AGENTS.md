# AGENTS.md

## Overview
Static Chinese checkers (中国跳棋) PWA deployed on GitHub Pages at
`https://unplage.github.io/tiaoqi/`. No build system, dependencies, tests, or CI.

## Key facts
- Game logic lives inline in `index.html`: CSS (~line 8) + game logic as `class
  ChineseCheckers` (~line 634) + service worker registration (~end of body).
  The AI logic (`class ChineseCheckersAI`) lives in the separate file
  `ai-worker.js`; `index.html` calls it through a Web Worker (`getAIMoveAsync`),
  so the two files must stay consistent.
- Supported modes: 2/4/6 人, 4/6 人支持可选 AI 数量（含全 AI 观战），每个 AI
  可独立设置 简单/中等/困难 难度；多人模式下夺冠玩家棋子留在棋盘、其余玩家
  继续争夺 2/3…N 名。AI 全阶段用启发式 minimax（easy=深度2/medium=3/hard=4），
  根节点做"深度值窗口+前进优先"选择（避免中盘横向平移占优），制胜步先快速
  扫描必抓，仅在根节点启发式平局时以 MCTS（贪心复盘）破平。
- 僵局：无吃子规则下棋子可能永久封死目标角。连续 40 步无人取得进展时弹出
  "僵局"提示（仅提示不判和），玩家可选"继续对局"或"重置"。
- UI text and comments are in Chinese — keep new text/comments in Chinese.
- Verify locally by serving the folder (e.g. `python3 -m http.server`), not
  by opening the file directly (SW and relative paths need a server).

## Testing
- `node verify_rules.js` — regression suite (rules geometry, AI move-set
  equality for 2/4/6P, multi-player play-order, full-AI near-endgame smoke,
  responsive layout). It loads the `ChineseCheckers` class from `index.html`
  and the `ChineseCheckersAI` class from `ai-worker.js` via DOM stubs.

## GitHub Pages constraints
- Keep all URLs relative (`./`, `../`); the site runs under the `/tiaoqi/`
  subpath, so absolute paths break.
- `manifest.json` `start_url`/`scope` are hardcoded to `/tiaoqi/` — keep in
  sync with the repo name.
- `sw.js` derives its base path from its own URL; static assets are
  cache-first. When adding/changing precached assets, bump the version suffix
  in `CACHE_NAME` (sw.js:10, currently `v8`), otherwise old cached versions
  persist. `sw.js` only cleans caches under its own `CACHE_PREFIX`.
