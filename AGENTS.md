# AGENTS.md

## Overview
Static Chinese checkers (中国跳棋) PWA deployed on GitHub Pages at
`https://unplage.github.io/tiaoqi/`. No build system, dependencies, tests, or CI.

## Key facts
- All code lives inline in `index.html`: CSS (~line 8) + AI logic as `class
  ChineseCheckersAI` (~line 670) + game logic as `class ChineseCheckers`
  (~line 975) + service worker registration (~line 1515).
  There are no separate source files; edit `index.html` directly.
- UI text and comments are in Chinese — keep new text/comments in Chinese.
- Verify locally by serving the folder (e.g. `python3 -m http.server`), not
  by opening the file directly (SW and relative paths need a server).

## GitHub Pages constraints
- Keep all URLs relative (`./`, `../`); the site runs under the `/tiaoqi/`
  subpath, so absolute paths break.
- `manifest.json` `start_url`/`scope` are hardcoded to `/tiaoqi/` — keep in
  sync with the repo name.
- `sw.js` derives its base path from its own URL; static assets are
  cache-first. When adding/changing precached assets, bump the version suffix
  in `CACHE_NAME` (sw.js:10, currently `v4`), otherwise old cached versions
  persist. `sw.js` only cleans caches under its own `CACHE_PREFIX`.
