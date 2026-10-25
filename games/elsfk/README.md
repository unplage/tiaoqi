# elsfk

俄罗斯方块 PWA — [在线游玩](https://unplage.github.io/elsfk/)

## 功能特性

- **SRS 旋转系统**（踢墙表与 [Tetris Wiki](https://tetris.wiki/SRS) 官方规范一致，含回归测试）
- **T-Spin 判定**：3 角规则 + 前/后角判定，区分 **Mini / Full T-Spin**
- **官方计分**：Single/Double/Triple/Tetris = 100/300/500/800 × level，T-Spin = 200/400/800/1200/1600，
  支持 **Back-to-Back ×1.5**、**Combo 50×连击×level**、**Perfect Clear** 额外加分
- **Lock Delay**（500ms，15 次移动/旋转重置上限，到达新最低行自动重置计数）
- **DAS/ARR 可配置**：Tap / 5G / 10G / 20G / 30G / Infinity 预设
- **官方重力曲线** `(0.8-(L-1)×0.007)^(L-1)`，按难度缩放
- **Hard Drop** 冲击波动画、**Tetris / T-Spin / Perfect Clear** 横幅 + 震屏 + 震动反馈
- **多游戏模式**：经典、限时(120s)、Sprint(40行)、Ultra(2分钟)、马拉松(150行)、生存、**禅**、**每日挑战**
- **启动界面**：进入先显示棋盘与模式选择，点「开始游戏」或按任意游戏键正式开始（不会一进来就自动下落）
- **Next 队列 3 个**、暂存不可用时置灰、堆叠过高时危险提示
- **移动端手势**：左右滑=移动、上滑=旋转、下滑=硬降、轻点=暂存
- **个人统计 + 16 项成就**、**分模式排行榜**
- **多主题皮肤**、音效、**PWA 离线支持**、HiDPI 高清渲染

## 操作

| 按键 | 功能 |
|------|------|
| ← → | 左右移动（DAS/ARR） |
| ↓ | 软降（加速下落，+1 分/行） |
| ↑ / Z / X | 旋转 |
| 空格 | Hard Drop（+2 分/行） |
| C | Hold |
| P | 暂停 |
| Esc | 设置 |

> 手机端可直接在棋盘上滑动操作（左右滑=移动，上滑=旋转，下滑=硬降，轻点=暂存）。

## PWA 资源

```
manifest.json          # 应用清单（name / theme_color / icons / scope 均为相对路径）
sw.js                  # Service Worker（按目录隔离缓存，v11）
offline.html           # 完全离线时的兜底页面
icons/
  icon.svg             # 图标源文件（512 画布，SVG）
  icon-192.png         # 常规图标 192x192
  icon-512.png         # 常规图标 512x512
  maskable.svg         # Android 自适应图标源文件（图形收在 80% 安全区内）
  maskable-192.png     # 自适应图标 192x192
  maskable-512.png     # 自适应图标 512x512
  apple-touch-icon.png # iOS 主屏图标 180x180
  favicon.svg / .ico / favicon-32.png / favicon-16.png
```

图标由 `icons/*.svg` 渲染生成，修改 SVG 后重新导出：

```bash
inkscape icons/icon.svg                -e icons/icon-512.png -w 512 -h 512 -y 0
inkscape icons/icon.svg                -e icons/icon-192.png -w 192 -h 192 -y 0
inkscape icons/maskable.svg            -e icons/maskable-512.png -w 512 -h 512 -y 0
inkscape icons/maskable.svg            -e icons/maskable-192.png -w 192 -h 192 -y 0
inkscape icons/apple-touch-icon.svg    -e icons/apple-touch-icon.png -w 180 -h 180
inkscape icons/favicon.svg             -e icons/favicon-32.png -w 32 -h 32 -y 0
convert icons/favicon-32.png icons/favicon-16.png icons/favicon.ico
```

> 修改 `sw.js` 或静态资源后，请同步递增 `sw.js` 顶部的 `CACHE_VERSION`，否则老用户会继续使用旧缓存。

## 测试

无需任何依赖，Node 直接运行：

```bash
node tests/game.test.js   # 计分 / T-Spin 判定 / 锁延迟 / 暂存 / 模式目标 等 36 项
node tests/srs.test.js    # SRS 踢墙表与官方规范一致性 34 项
node tests/fuzz.test.js   # 8 种模式 × 4 难度 × 3 网格的随机对局模糊测试
node tests/sw-isolation.test.js   # SW 多 PWA 同源共存隔离性 11 项
PUPPETEER_PATH=/tmp node tests/browser.test.js   # 浏览器端 20 项（需 puppeteer）
```

`tests/dom-stub.js` 提供最小 DOM/Canvas 模拟，使 `index.html` 中的游戏逻辑可在 Node 中直接执行。

> **同源多 PWA 注意事项**：所有项目站都部署在 `https://unplage.github.io` 同一源下，
> 而 CacheStorage 是**按源**隔离而非按 SW 隔离。因此 `sw.js` 的 activate 清理逻辑
> 必须只匹配**自身路径前缀**（`PROJECT_PREFIX`），绝不能使用 `pwa-cache-` 这类通用前缀，
> 否则更新一个 PWA 的 SW 会把同源下其它 PWA 的缓存一并删除，导致那些应用离线失效。
> `tests/sw-isolation.test.js` 会验证这一隔离性。
