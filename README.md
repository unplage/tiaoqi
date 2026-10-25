# 游戏集 Arcade

离线可安装的多游戏 PWA 合集，部署在 GitHub Pages：`https://unplage.github.io/tiaoqi/`。

## 已接入游戏

| 游戏 | 目录 | 说明 |
|---|---|---|
| 玻璃跳棋 | `games/chinese-checkers/` | 中国跳棋，2/4/6 人，人机、自由模式、连跳、僵局提示 |
| 五子棋 | `games/gomoku/` | 标准五子棋 + 禁手，双人 / 人机 / AI 对战 / 沙盒 |
| 像素斗地主 | `games/ddz/` | 单机 AI 与 P2P 联机、记牌器、语音音效、战绩 |
| 巨幕拼图 | `games/pintu/` | 交换 / 滑动 / 旋转拼图，关卡、每日挑战、成就 |
| 贪吃蛇进化论 | `games/tcs/` | 经典 / 限时 / 生存 / 竞技，道具、皮肤、任务 |
| 打地鼠 | `games/dds/` | 并发地鼠、难度曲线、五类目标、纪录 |
| 俄罗斯方块 | `games/elsfk/` | SRS、T-Spin、多模式、DAS/ARR、移动端手势 |
| 麻将 | `games/mahjong/` | 2/3/4 人、国标/香港/四川基础、吃碰胡 |

每个游戏目录都是独立应用，保留原版入口 `index.html`、Service Worker 与资源路径；主入口 `index.html` 只做游戏集主页与跳转。

## 开发与运行

```bash
python3 -m http.server 8080
# 访问 http://localhost:8080/
```

Service Worker、PWA manifest 与相对路径需要通过本地服务器访问，不能直接双击 `index.html`。

## 测试

```bash
node verify_rules.js
```

覆盖中国跳棋的几何相邻、跳跃落点、AI 走法一致性、多玩家轮转、布局适配等回归检查。五子棋与其它游戏使用各自的内置测试或直接在浏览器中验证。

## PWA 约定

- 所有 URL 必须相对，站点运行在 `/tiaoqi/` 子路径。
- 主页 manifest 的 `start_url` / `scope` 固定为 `/tiaoqi/`。
- `sw.js` 按自身 URL 推导基路径；新增或修改游戏资产后，必须更新 `CACHE_NAME` 版本号。
- 各游戏保持独立的 SW 与缓存前缀，避免互相清理缓存。

## 结构

- `index.html`：游戏集主页
- `games/<game>/`：单个游戏完整工程（页面、AI、SW、图标、tests）
- `sw.js`：主页与集合级离线缓存
- `verify_rules.js`：规则回归测试
