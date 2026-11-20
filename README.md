# 读书郎自动阅卷助手

Chrome/Edge 扩展 + 局域网监控服务：调用大模型 API 按「题目 / 标准答案 / 评分标准」三要素自动批改主观题，并支持手机实时查看批改进度。

## 目录

- `auto-grader-extension/` — 浏览器扩展（在 chrome://extensions 里加载这个文件夹）
- `monitor-server.js` — 局域网监控服务（零依赖 Node 脚本）
- `launch.js` — 打包入口
- `update.json` — 版本清单，插件与监控程序都从这里检查更新

## 本地运行

```bash
node monitor-server.js           # 启动监控，默认 8090 端口
npx pkg launch.js --targets node22-win-x64 --output GradeMonitor.exe   # 打包 exe
```

## 自动更新机制

1. `update.json` 放在仓库内，通过 Gitee raw 地址对外提供
2. 监控程序启动 6 秒后检查一次，之后每 30 分钟一次
3. 发现新版本时：
   - 按 `pluginFiles` 清单逐个下载插件文件，全部落到临时目录后再整体覆盖
   - 替换监控程序自身并重启
4. 扩展内 `chrome.alarms` 每分钟查询 `/api/plugin-version`，看到 `needReload` 就调用 `chrome.runtime.reload()`
5. 插件目录自动探测顺序：`monitor-update.json` 的 `pluginDir` → exe 同级 `auto-grader-extension` → `桌面/pg/auto-grader-extension` → `桌面/auto-grader-extension`

## 发布新版本

1. 改 `auto-grader-extension/manifest.json` 与 `monitor-server.js` 里的版本号
2. 提交并推送
3. 打包 exe，上传到 Releases
4. 修改 `update.json` 的 `version` 与 `monitorUrl`，提交推送
5. 客户端 30 分钟内自动完成升级
