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
  继续争夺 2/3…N 名。AI 以速胜为唯一目的：全阶段用几何距离（棋子到目标角
  质心的欧氏距离，斜向推进不被低估）做启发式评估，走法按"跳步优先 → 落子后
  距离和升序"排序后再截断（保证推进跳步总在窗口内），根节点在启发式窗口内
  取前进最多者。评估惩罚"最慢棋子"（maxD）与起始角残留（防止慢棋被对手占角
  围死、永久判负）。难度差异化仅体现在候选窗口宽度（easy=15/medium=30/
  hard=45）；hard 在末盘（≤2 子未入角）额外做 3 层自搜索找连走制胜序列。
  制胜步先快速扫描必抓。
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
  in `CACHE_NAME` (sw.js:10, currently `v11`), otherwise old cached versions
  persist. `sw.js` only cleans caches under its own `CACHE_PREFIX`.
