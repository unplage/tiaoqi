# 中国跳棋（玻璃弹珠跳棋）

静态 PWA，无构建、无依赖，部署于 GitHub Pages：
<https://unplage.github.io/tiaoqi/>

## 功能

- 2 / 4 / 6 人模式，支持人机对战（MCTS + 残局极小化搜索，简单/中等/困难三档）
- 跳棋完整规则：单步、跨子跳跃、连跳（可随时结束回合）、目标角内棋子不可移出、第 10 子进角即胜
- 自由模式：任意棋子可移到任意空位（沙盒玩法）
- 走法提示（白色=单步，蓝色=跳跃，金色=可连跳）、撤销、回合动画、移动轨迹
- PWA：可安装、离线可玩（Service Worker 缓存优先）
- 棋盘自适应铺满屏幕（竖屏/横屏/桌面均不截断），棋子区取最大可用尺寸

## 开发

- 所有代码在 `index.html` 内联（CSS + `class ChineseCheckersAI` AI 逻辑 + `class ChineseCheckers` 游戏逻辑），无独立源文件
- 本地验证：`python3 -m http.server` 后访问（SW 与相对路径需服务器环境，不能直接双击打开）
- 规则/布局回归验证：`node verify_rules.js`（几何相邻、AI 一致性、跳跃落点、目标角规则、多尺寸布局不截断等 20 项断言）
- UI 文案与注释为中文，新增内容请保持中文

## 部署与 PWA 注意事项

- 所有 URL 必须相对路径（`./`、`../`），站点运行在 `/tiaoqi/` 子路径下
- `manifest.json` 的 `start_url`/`scope` 硬编码为 `/tiaoqi/`，与仓库名保持一致
- `sw.js` 以自身 URL 推导基路径；静态资源缓存优先。新增/修改预缓存资源时，必须递增 `CACHE_NAME` 的版本后缀（当前 `v4`），否则旧缓存不更新；`sw.js` 只清理自己 `CACHE_PREFIX` 前缀下的缓存
