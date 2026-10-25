# tcs 贪吃蛇 · 进化论

https://unplage.github.io/tcs/

对标商业贪吃蛇（Snake.io / Slither.io）的离线单文件 PWA：人机对战、冲刺斩蛇、道具、皮肤、任务与每日挑战。

## 玩法

- **目标**：吃食物变长拿分；头撞任何蛇身会死亡；**冲刺中撞到对手**可将其斩断并得分（斩蛇）。
- **边界**：四周为可穿越的环绕通道，从一侧穿出会从对侧出现。
- **模式**：经典 / 限时（倒计时）/ 生存（持续提速）/ 竞技（障碍 + 高斩蛇分）。
- **难度**：休闲 / 标准 / 狂野 / 地狱（影响 AI 数量、速度与反应）。
- **道具**：黄金（加分）、磁铁（吸附食物）、幽灵（穿墙穿身）、护盾（抵挡一次致命伤）、涡轮（加速）、冰缓（AI 变慢）。
- **成长**：金币 → 皮肤商店（6 款）；任务每日刷新；每日挑战；成就；本地排行榜。

## 操作

| 平台 | 转向 | 冲刺 | 其他 |
| --- | --- | --- | --- |
| 手机 | 画布滑动 / 左下虚拟摇杆 | 按住右下 ⚡ | 页面切后台自动暂停 |
| 电脑 | 方向键 / WASD | 空格 / 按住 ⚡ | P 暂停，R 重开 |

## URL 参数

- `?mode=classic|timed|survival|arena` 预选模式
- `?diff=easy|medium|hard|insane` 预选难度
- `?debug=1` 暴露只读状态接口 `window.__tcs.state()`（自动化测试用，无写操作）

## 结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | 单文件游戏（HTML + CSS + JS 内联，rAF 插值渲染 + DPR 高清） |
| `manifest.json` | PWA 清单（图标、主题色、standalone、模式快捷方式） |
| `sw.js` | Service Worker：离线缓存、版本化清理 |
| `icon.svg` / `icon-maskable.svg` | 图标源文件（矢量） |
| `icon-192.png` / `icon-512.png` | 常规图标 |
| `icon-maskable-192.png` / `icon-maskable-512.png` | Android 自适应（maskable）图标 |
| `apple-touch-icon.png` | iOS 添加到主屏图标（180×180） |
| `favicon.ico` | 浏览器标签页图标（16/32/48） |

## 本地数据（localStorage）

`snakeHS` 最高分 · `snakeElite` 排行榜 · `snakeStats` 统计 · `snakeAchievements` 成就 ·
`snakeSettings` 设置 · `snakeCoins` 金币 · `snakeSkins` 皮肤 · `snakeQuests` 任务 ·
`snakeDaily` 每日挑战 · `snakeConfig` 模式/难度/网格 · `snakeSeenHelp` 首次引导

## 缓存隔离规则

同一域名下的多个 PWA 共用一份 Cache Storage，因此 `sw.js` 严格按作用域隔离：

- 缓存名格式：`pwa-cache<作用域路径>v<版本>`，例如 `/tcs/` → `pwa-cache-tcs-v7`
- 激活时只删除匹配 `^pwa-cache<作用域路径>v\d+$` 且内容全部位于本作用域内的旧缓存
- 同源下其它项目（如 `/pwa1/`）的缓存、以及名字相近的项目缓存都不会被删除
- 修改缓存内容时，把 `sw.js` 里的 `CACHE_VERSION` 加 1，旧缓存会在下次激活时自动回收
