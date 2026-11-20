// 局域网阅卷监控服务（零依赖）
// 启动：node monitor-server.js
// 手机与电脑连同一 Wi-Fi，浏览器打开 http://电脑IP:8090

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.MONITOR_PORT || 8090);
const VERSION = 'v1.1.5';

// 运行目录（打包后为 exe 所在目录）
const APP_DIR = path.dirname(process.execPath);
const APP_EXE = process.execPath;
const UPDATE_CONF = path.join(APP_DIR, 'monitor-update.json');

// 更新源与最近一次检查结果
let UPDATE_URL = '';
let AUTO_UPDATE = true;
let pluginReloadPending = false;
let pluginDirCache = '';
let updateState = {
  hasUpdate: false,
  latest: '',
  notes: '',
  monitorUrl: '',
  pluginBase: '',
  pluginFiles: [],
  checkedAt: 0,
  error: ''
};

try {
  if (fs.existsSync(UPDATE_CONF)) {
    const conf = JSON.parse(fs.readFileSync(UPDATE_CONF, 'utf8'));
    UPDATE_URL = String(conf.updateUrl || '');
    if (conf.autoUpdate === false) AUTO_UPDATE = false;
  }
} catch (e) {}

function saveUpdateConf(url) {
  try {
    fs.writeFileSync(UPDATE_CONF, JSON.stringify({ updateUrl: url }, null, 2), 'utf8');
  } catch (e) {}
}

// 版本比较
function compareVer(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 检查监控程序自身是否有新版本
async function checkMonitorUpdate() {
  if (!UPDATE_URL) {
    updateState = { hasUpdate: false, latest: '', notes: '', monitorUrl: '', checkedAt: Date.now(), error: '未配置更新源' };
    return { success: false, error: '未配置更新源', current: VERSION };
  }

  try {
    const sep = UPDATE_URL.indexOf('?') === -1 ? '?' : '&';
    const res = await fetch(UPDATE_URL + sep + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('更新源返回 ' + res.status);

    const data = await res.json();
    const latest = String(data.version || '').replace(/^v/i, '');
    if (!latest) throw new Error('更新源缺少 version 字段');

    const hasUpdate = compareVer(latest, VERSION) > 0;
    updateState = {
      hasUpdate: hasUpdate,
      latest: latest,
      notes: data.notes || '',
      monitorUrl: data.monitorUrl || data.monitor || '',
      pluginBase: data.pluginBase || '',
      pluginFiles: Array.isArray(data.pluginFiles) ? data.pluginFiles : [],
      checkedAt: Date.now(),
      error: ''
    };
    return { success: true, current: VERSION, latest: latest, hasUpdate: hasUpdate, notes: data.notes || '' };
  } catch (error) {
    updateState = {
      hasUpdate: false,
      latest: '',
      notes: '',
      monitorUrl: '',
      pluginBase: '',
      pluginFiles: [],
      checkedAt: Date.now(),
      error: error.message
    };
    return { success: false, error: error.message, current: VERSION };
  }
}

// 定位浏览器插件目录（Chrome 里「加载已解压的扩展程序」选的那个文件夹）
function resolvePluginDir() {
  if (pluginDirCache) return pluginDirCache;

  const candidates = [];

  try {
    const conf = JSON.parse(fs.readFileSync(UPDATE_CONF, 'utf8'));
    if (conf.pluginDir) candidates.push(conf.pluginDir);
  } catch (e) {}

  candidates.push(path.join(APP_DIR, 'auto-grader-extension'));
  candidates.push(path.join(os.homedir(), 'Desktop', 'pg', 'auto-grader-extension'));
  candidates.push(path.join(os.homedir(), 'Desktop', 'auto-grader-extension'));
  candidates.push(path.join(os.homedir(), 'Documents', 'auto-grader-extension'));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'manifest.json'))) {
        pluginDirCache = dir;
        return dir;
      }
    } catch (e) {}
  }
  return '';
}

// 下载并覆盖插件文件（先下到临时目录，全部成功后再替换，避免半个版本）
async function updatePluginFiles() {
  if (!updateState.pluginBase || !updateState.pluginFiles.length) {
    return { success: false, error: '更新源未提供插件文件清单' };
  }

  const dir = resolvePluginDir();
  if (!dir) {
    return { success: false, error: '未找到插件目录，请在 monitor-update.json 里配置 pluginDir' };
  }

  const tmpDir = path.join(APP_DIR, 'plugin-update-tmp');
  const base = updateState.pluginBase.replace(/\/+$/, '');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const name of updateState.pluginFiles) {
      let res = null;

      // Gitee 对连续请求会返回 451/429，这里退避重试
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(base + '/' + name, {
          cache: 'no-store',
          redirect: 'follow',
          headers: { 'User-Agent': UA, 'Referer': 'https://gitee.com/' }
        });
        if (res.ok) break;
        if (res.status === 451 || res.status === 429 || res.status >= 500) {
          await sleep(900 * (attempt + 1));
          continue;
        }
        break;
      }

      if (!res || !res.ok) {
        throw new Error('下载 ' + name + ' 失败（' + (res ? res.status : '无响应') + '）');
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error(name + ' 内容为空');
      fs.writeFileSync(path.join(tmpDir, name), buf);

      // 控制节奏，避免触发限流
      await sleep(180);
    }

    for (const name of updateState.pluginFiles) {
      fs.copyFileSync(path.join(tmpDir, name), path.join(dir, name));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    pluginReloadPending = true;

    return { success: true, dir: dir, files: updateState.pluginFiles.length, version: updateState.latest };
  } catch (error) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return { success: false, error: error.message };
  }
}

// 下载新版本并替换自身后重启
async function applyMonitorUpdate() {
  if (!updateState.hasUpdate || !updateState.monitorUrl) {
    return { success: false, error: '没有可用的更新' };
  }

  // 先把插件文件替换掉；失败不阻塞监控自身更新
  let pluginResult = null;
  try {
    pluginResult = await updatePluginFiles();
  } catch (e) {
    pluginResult = { success: false, error: e.message };
  }

  const tmpExe = path.join(APP_DIR, 'update-new.exe');

  try {
    const res = await fetch(updateState.monitorUrl);
    if (!res.ok) throw new Error('下载失败 ' + res.status);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024 * 1024) throw new Error('下载文件异常，大小 ' + buf.length + ' 字节');
    fs.writeFileSync(tmpExe, buf);

    // 用批处理等本进程退出后替换并重启
    const bat = path.join(APP_DIR, 'apply-update.bat');
    const lines = [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      'move /y "' + tmpExe + '" "' + APP_EXE + '"',
      'start "" "' + APP_EXE + '"',
      'del "%~f0"'
    ];
    fs.writeFileSync(bat, lines.join('\r\n'), 'utf8');

    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 400);

    return { success: true, version: updateState.latest, plugin: pluginResult };
  } catch (error) {
    return { success: false, error: error.message, plugin: pluginResult };
  }
}

let state = {
  status: '等待插件连接…',
  gradedCount: 0,
  lastScore: null,
  isAutoGrading: false,
  isPaused: false,
  totalScore: 0,
  question: '',
  standardAnswer: '',
  scoringCriteria: '',
  logs: [],
  history: [],
  imageVersion: 0,
  updatedAt: 0
};

// 当前正在批改的试卷图片（仅存内存，不落盘）
let currentImage = null;   // { mime, buffer }
let imageVersion = 0;

const clients = new Set();

function broadcast() {
  const payload = 'data: ' + JSON.stringify(state) + '\n\n';
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (e) {}
  }
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07080b">
<title>阅卷监控</title>
<style>
:root{
  --bg:#07080b;
  --bg-2:#0d0f14;
  --ink:#ece7da;
  --text:#ece7da;
  --text-dim:#9d988c;
  --text-faint:#6c685f;
  --hot:#ff5a1f;
  --hot-hover:#ff7440;
  --hot-2:#7fd8ff;
  --line:rgb(236 231 218 / .14);
  --line-strong:rgb(236 231 218 / .3);
  --panel:rgb(7 8 11 / .78);
  --f-ui:system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
  --f-dot:ui-monospace,"SF Mono","Cascadia Mono",Consolas,"Courier New",monospace;
  --t-12:12px;--t-13:13px;--t-15:15px;--t-17:17px;--t-21:21px;
  --s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:24px;
  --r-1:6px;--r-2:12px;--r-pill:999px;
  --pitch:9px;
  --ease:cubic-bezier(.16,1,.3,1);
  --ease-in-out:cubic-bezier(.65,0,.35,1);
  --t-fast:.16s;--t-mid:.32s;--t-slow:.7s;
  color-scheme:dark;
}
@media (prefers-reduced-motion:reduce){:root{--t-fast:0ms;--t-mid:0ms;--t-slow:0ms}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  min-height:100dvh;
  max-width:560px;
  margin:0 auto;
  padding:16px 14px calc(24px + env(safe-area-inset-bottom));
  font-family:var(--f-ui);
  font-size:var(--t-15);
  line-height:1.55;
  color:var(--text);
  background:var(--bg);
  -webkit-font-smoothing:antialiased;
}
#field{position:fixed;inset:0;z-index:0;width:100%;height:100%;pointer-events:none}
body>*{position:relative;z-index:1}

.matrix{font-family:var(--f-dot);font-weight:900;letter-spacing:.06em}

.head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:0 2px;margin-bottom:var(--s-3)}
.head h1{display:flex;align-items:center;gap:8px;font-size:var(--t-21);font-weight:600;letter-spacing:.01em}
.head h1 .ico-logo{width:20px;height:20px;fill:none;stroke:var(--hot);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:.1 3.6}
.head .ver{font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.08em;color:var(--hot)}

.panel{
  padding:var(--s-4);
  margin-bottom:var(--s-3);
  border-radius:var(--r-2);
  background:var(--panel);
  box-shadow:inset 0 0 0 1px var(--line);
  -webkit-backdrop-filter:blur(10px);
  backdrop-filter:blur(10px);
}

/* ---------- 状态 ---------- */
.status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:var(--s-3)}
.status{font-size:var(--t-15);font-weight:600;letter-spacing:.01em;color:var(--text)}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--hot);box-shadow:0 0 6px rgb(255 90 31 / .6);transition:background var(--t-mid) var(--ease)}
.dot.idle{background:var(--text-faint);box-shadow:none}
.dot.paused{background:transparent;box-shadow:inset 0 0 0 1px var(--text-dim)}
.dot.error{background:var(--hot);box-shadow:0 0 8px rgb(255 90 31 / .85)}

.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-radius:var(--r-1);overflow:hidden}
.metric{padding:10px 6px;text-align:center;background:var(--bg-2)}
.num{font-family:var(--f-dot);font-weight:900;font-size:22px;line-height:1.15;letter-spacing:.03em;color:var(--text)}
.label{margin-top:2px;font-size:11px;color:var(--text-faint)}
.num.high{color:var(--hot-2)}
.num.mid{color:var(--text)}
.num.low{color:var(--hot)}

.wp{margin-top:var(--s-3);padding-top:var(--s-3);border-top:1px solid var(--line)}
.wp-track{position:relative;height:10px;border-radius:var(--r-pill);background-image:radial-gradient(circle,var(--line-strong) 1px,transparent 1.6px);background-size:var(--pitch) var(--pitch);background-position:0 50%;box-shadow:inset 0 0 0 1px var(--line)}
.wp-track i{display:block;height:100%;width:0;border-radius:var(--r-pill);background-image:radial-gradient(circle,var(--hot) 1.2px,transparent 1.8px);background-size:var(--pitch) var(--pitch);background-position:0 50%;background-repeat:repeat-x;transition:width var(--t-mid) var(--ease)}
.wp-label{margin-top:6px;text-align:center;font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.06em;color:var(--text-dim)}

/* ---------- 本题信息 ---------- */
.task-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:var(--s-2)}
.task-title{font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.08em;color:var(--hot);text-transform:uppercase}
.task-tag{padding:2px 9px;border-radius:var(--r-pill);box-shadow:inset 0 0 0 1px var(--line);font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.04em;color:var(--text-dim)}
.kicker{display:inline-block;margin-bottom:6px;font-family:var(--f-dot);font-weight:900;font-size:10px;letter-spacing:.08em;color:var(--text-faint);text-transform:uppercase}
.task-text{font-size:var(--t-13);line-height:1.7;color:var(--text-dim);white-space:pre-wrap;word-break:break-word}
.task-missing{color:var(--text-faint);font-style:italic}
.task-fold{margin-top:var(--s-3);padding-top:var(--s-2);border-top:1px solid var(--line)}
.task-fold summary{display:flex;align-items:center;gap:6px;font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.06em;color:var(--text-dim);cursor:pointer;list-style:none;outline:none}
.task-fold summary::-webkit-details-marker{display:none}
.task-fold summary::before{content:'+';width:10px;color:var(--hot)}
.task-fold[open] summary::before{content:'–'}
.task-fold[open] summary{margin-bottom:var(--s-2)}
.task-fold .task-text{max-height:34dvh;overflow-y:auto}
.task-fold summary:focus-visible{outline:1.5px solid var(--hot);outline-offset:4px;border-radius:var(--r-1)}

/* ---------- 试卷 ---------- */
.paper-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:var(--s-2)}
.paper-title{font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.08em;color:var(--text-dim)}
.paper-tip{font-size:11px;color:var(--text-faint)}
.paper-img{display:block;width:100%;height:auto;border-radius:var(--r-1);box-shadow:inset 0 0 0 1px var(--line);background:var(--bg-2);cursor:zoom-in}
.paper-img.is-portrait{max-height:62vh;object-fit:contain}
.img-zoom{position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;padding:10px;background:rgb(7 8 11 / .97);cursor:zoom-out}
.img-zoom[hidden]{display:none}
.img-zoom img{max-width:100%;max-height:100%;object-fit:contain;border-radius:var(--r-1)}
.update-bar{display:flex;align-items:center;gap:10px;margin:var(--s-3) 0 0;padding:10px 12px;border-radius:var(--r-1);background:rgb(255 90 31 / .1);box-shadow:inset 0 0 0 1px rgb(255 90 31 / .3);font-size:var(--t-12);color:var(--hot)}
.update-bar[hidden]{display:none}
.update-text{flex:1;min-width:0;line-height:1.5}
.update-btn{flex:none;min-height:32px;padding:0 12px;border:0;border-radius:var(--r-pill);background:var(--hot);color:#07080b;font-family:var(--f-ui);font-size:12px;font-weight:700;cursor:pointer;transition:transform var(--t-fast) var(--ease)}
.update-btn:active{transform:scale(.96)}
.update-btn:disabled{opacity:.6;cursor:progress}
.paper-empty{display:flex;align-items:center;justify-content:center;min-height:120px;padding:20px;text-align:center;font-size:12px;line-height:1.6;color:var(--text-faint);border-radius:var(--r-1);background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line)}

/* ---------- AI 思考 ---------- */
.stream-title{margin-bottom:var(--s-2);font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.08em;color:var(--hot)}
.stream-text{max-height:30dvh;overflow-y:auto;font-size:var(--t-13);line-height:1.7;color:var(--text-dim);white-space:pre-wrap;word-break:break-word}
.stream-panel{box-shadow:inset 0 0 0 1px var(--line),inset 2px 0 0 var(--hot)}

/* ---------- 成绩 ---------- */
.section{margin:0 2px var(--s-2);font-family:var(--f-dot);font-weight:900;font-size:11px;letter-spacing:.08em;color:var(--text-faint);text-transform:uppercase}
.scores{display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:var(--s-2);margin-bottom:var(--s-3)}
.score-card{padding:10px 6px;text-align:center;border-radius:var(--r-1);background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line)}
.score-big{font-family:var(--f-dot);font-weight:900;font-size:19px;letter-spacing:.03em;color:var(--text)}
.score-sub{margin-top:2px;font-size:10px;color:var(--text-faint)}

/* ---------- 日志 ---------- */
.logs{max-height:52dvh;margin-bottom:var(--s-3);padding:var(--s-2);overflow-y:auto;border-radius:var(--r-2);background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.log{display:flex;gap:8px;padding:5px 8px;border-radius:var(--r-1);box-shadow:inset 2px 0 0 transparent;font-size:var(--t-12);line-height:1.6}
.log+.log{margin-top:2px}
.log-time{flex:none;padding-top:1px;font-family:var(--f-dot);font-weight:900;font-size:10px;letter-spacing:.04em;color:var(--text-faint)}
.log-msg{color:var(--text-dim);word-break:break-word}
.log.success{background:rgb(127 216 255 / .06);box-shadow:inset 2px 0 0 rgb(127 216 255 / .5)}
.log.success .log-msg{color:var(--hot-2)}
.log.error{background:rgb(255 90 31 / .07);box-shadow:inset 2px 0 0 rgb(255 90 31 / .55)}
.log.error .log-msg{color:var(--hot)}
.log.last-score{background:rgb(236 231 218 / .05);box-shadow:inset 2px 0 0 var(--line-strong)}
.log.last-score .log-msg{color:var(--text);font-weight:600}
.log.divider{display:none}
.empty{padding:18px 0;text-align:center;font-size:var(--t-12);color:var(--text-faint)}
.refresh{text-align:center;font-family:var(--f-dot);font-weight:900;font-size:10px;letter-spacing:.06em;color:var(--text-faint)}
</style>
</head>
<body>
<canvas id="field" aria-hidden="true"></canvas>
<div class="head">
  <h1><svg class="ico-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 13.2l4.3 4.3L18 7.8"/></svg>阅卷监控</h1>
  <span class="ver">LATTICE · v1.1.5</span>
</div>

<section class="panel">
  <div class="status-row">
    <span class="status" id="status">连接中…</span>
    <span class="dot idle" id="dot" aria-hidden="true"></span>
  </div>
  <div class="metrics">
    <div class="metric"><div class="num" id="count">0</div><div class="label">已批改</div></div>
    <div class="metric"><div class="num" id="last">-</div><div class="label">上一份</div></div>
    <div class="metric"><div class="num" id="full">-</div><div class="label">满分</div></div>
  </div>
  <div class="wp" id="webProgress" style="display:none">
    <div class="wp-track"><i id="wpFill"></i></div>
    <div class="wp-label" id="wpLabel"></div>
  </div>
</section>

<section class="panel stream-panel" id="streamCard" style="display:none">
  <div class="stream-title">Stream / AI 实时思考</div>
  <div class="stream-text" id="streamText"></div>
</section>

<div class="section">Log / 批改日志</div>
<div class="logs" id="logs"><div class="empty">暂无日志</div></div>



<section class="panel" id="paperCard" style="display:none">
  <div class="paper-head"><span class="paper-title">Paper / 当前试卷</span><span class="paper-tip">点图放大</span></div>
  <div class="paper-empty" id="paperEmpty">等待上传试卷图片…开始批改后自动显示</div>
  <img class="paper-img" id="paperImg" alt="当前试卷" style="display:none" />
</section>

<div class="img-zoom" id="imgZoom" hidden>
  <img id="imgZoomPic" alt="试卷大图" />
</div>

<div class="section">Recent / 最近成绩</div>
<div class="scores" id="scores"><div class="empty" style="grid-column:1/-1">暂无记录</div></div>

<section class="panel" id="taskCard" style="display:none">
  <div class="task-head">
    <span class="task-title">Task / 本题</span>
    <span class="task-tag" id="taskScoreTag"></span>
  </div>
  <span class="kicker">Question · 问题是什么</span>
  <div class="task-text" id="taskQuestion"></div>
  <details class="task-fold" id="answerFold">
    <summary>标准答案</summary>
    <div class="task-text" id="taskAnswer"></div>
  </details>
  <details class="task-fold" id="criteriaFold">
    <summary>评分标准</summary>
    <div class="task-text" id="taskCriteria"></div>
  </details>
</section>

<div class="update-bar" id="updateBar" hidden>
  <span class="update-text" id="updateText">发现新版本</span>
  <button class="update-btn" id="updateBtn">立即更新</button>
</div>
<div class="refresh" id="refresh">等待数据…</div>

<script>
/* lattice-field.js — 点阵 Field（Canvas 2D 本地实现）
   复刻 Lattice 点场行为：网格点集、指针推力、弹簧回位、热度泛橙、静止停机。
   无外部依赖，不加载任何网络资源。 */

(function (global) {
  'use strict';

  var ICON = {};

  function quantize(heat) {
    var q = Math.round(heat * 12) / 12;
    if (q < 0.02) q = 0;
    var key = 'q' + q;
    var hit = ICON[key];
    if (hit) return hit;
    var r = Math.round(236 + (255 - 236) * q);
    var g = Math.round(231 + (90 - 231) * q);
    var b = Math.round(218 + (31 - 218) * q);
    var a = 0.14 + 0.74 * q;
    ICON[key] = {
      style: 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')',
      size: 1 + q * 1.2
    };
    return ICON[key];
  }

  function createLatticeField(canvas, options) {
    if (!canvas || !canvas.getContext) return null;
    var o = Object.assign(
      {
        pitch: 16,        // 点距
        maxPoints: 1600,  // 上限，超出则稀疏采样
        radius: 92,       // 指针影响半径
        push: 18,         // 最大推力
        alpha: 0.14,
        idleMs: 1800      // 静止多久后停机
      },
      options || {}
    );

    var ctx = canvas.getContext('2d');
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var pts = [];
    var width = 0;
    var height = 0;
    var pointer = { x: -9999, y: -9999, inside: false };
    var raf = 0;
    var running = false;
    var lastActive = 0;

    function build() {
      var rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var pitch = o.pitch;
      var cols = Math.ceil(width / pitch) + 1;
      var rows = Math.ceil(height / pitch) + 1;
      var ox = (width - (cols - 1) * pitch) / 2;
      var oy = (height - (rows - 1) * pitch) / 2;
      var total = cols * rows;
      var step = total > o.maxPoints ? Math.ceil(total / o.maxPoints) : 1;

      pts = [];
      for (var j = 0; j < rows; j++) {
        for (var i = 0; i < cols; i++) {
          if (step > 1 && (j * cols + i) % step !== 0) continue;
          var x = ox + i * pitch;
          var y = oy + j * pitch;
          pts.push({ bx: x, by: y, x: x, y: y, vx: 0, vy: 0, heat: 0 });
        }
      }
    }

    function frame() {
      raf = 0;
      ctx.clearRect(0, 0, width, height);
      var moving = false;
      var i, p;

      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        var heat = 0;

        if (pointer.inside) {
          var dx = pointer.x - p.bx;
          var dy = pointer.y - p.by;
          var d2 = dx * dx + dy * dy;
          if (d2 < o.radius * o.radius && d2 > 0.01) {
            var d = Math.sqrt(d2);
            var t = 1 - d / o.radius;
            heat = t * t;
            var f = (o.push * heat) / d;
            p.vx -= dx * f * 0.05;
            p.vy -= dy * f * 0.05;
          }
        }

        // 弹簧回位
        p.vx += (p.bx - p.x) * 0.14;
        p.vy += (p.by - p.y) * 0.14;
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;

        if (!moving && (Math.abs(p.vx) + Math.abs(p.vy)) > 0.015) moving = true;

        p.heat += (heat - p.heat) * 0.2;

        var st = quantize(p.heat);
        ctx.fillStyle = st.style;
        ctx.fillRect(p.x - st.size / 2, p.y - st.size / 2, st.size, st.size);
      }

      if (pointer.inside || moving || Date.now() - lastActive < o.idleMs) {
        raf = global.requestAnimationFrame(frame);
      } else {
        running = false;
      }
    }

    function start() {
      lastActive = Date.now();
      if (running) return;
      running = true;
      if (!raf) raf = global.requestAnimationFrame(frame);
    }

    function onMove(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      pointer.x = clientX - rect.left;
      pointer.y = clientY - rect.top;
      pointer.inside = true;
      start();
    }

    function onLeave() {
      pointer.inside = false;
      start();
    }

    build();
    start();

    global.addEventListener('pointermove', function (e) {
      onMove(e.clientX, e.clientY);
    }, { passive: true });
    global.addEventListener('pointerdown', function (e) {
      onMove(e.clientX, e.clientY);
    }, { passive: true });
    global.addEventListener('pointerup', function () {
      lastActive = Date.now();
    }, { passive: true });
    global.addEventListener('pointerleave', onLeave, { passive: true });
    global.addEventListener('blur', onLeave);

    var resizeTimer = 0;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        build();
        start();
      }, 160);
    });

    return { rebuild: build, count: function () { return pts.length; } };
  }

  global.createLatticeField = createLatticeField;
})(typeof window !== 'undefined' ? window : this);



var es = new EventSource('/api/stream');
es.onmessage = function (e) {
  try { render(JSON.parse(e.data)); } catch (err) {}
};
es.onerror = function () {
  document.getElementById('status').textContent = '与电脑断开，正在重连…';
  document.getElementById('dot').className = 'dot error';
};

function scoreColor(v, full) {
  if (!full) return '';
  var r = v / full;
  if (r >= 0.8) return 'high';
  if (r >= 0.5) return 'mid';
  return 'low';
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

function fmtTime(t) {
  if (!t) return '';
  // 数字时间戳
  if (typeof t === 'number') {
    var d1 = new Date(t);
    if (isNaN(d1.getTime())) return '';
    return pad(d1.getHours()) + ':' + pad(d1.getMinutes());
  }
  var s = String(t);
  // 已经是 "10:24:05" 或 "上午10:24:05" 这类格式，直接取时间部分
  var m = s.match(/\d{1,2}:\d{2}(?::\d{2})?/);
  if (m) return m[0];
  var d2 = new Date(s);
  if (isNaN(d2.getTime())) return '';
  return pad(d2.getHours()) + ':' + pad(d2.getMinutes());
}

function render(d) {
  var dotClass = 'dot';
  if (d.isPaused) dotClass += ' paused';
  else if (d.isAutoGrading) dotClass += '';
  else dotClass += ' idle';
  document.getElementById('dot').className = dotClass;

  var st = d.status || '未知';
  if (d.isPaused && st.indexOf('暂停') === -1) st = '已暂停';
  document.getElementById('status').textContent = st;

  // 当前试卷图片
  var iv = d.imageVersion || 0;
  var paperCard = document.getElementById('paperCard');
  var paperImg = document.getElementById('paperImg');
  var paperEmpty = document.getElementById('paperEmpty');

  if (iv > 0) {
    if (window.__imgVersion !== iv) {
      window.__imgVersion = iv;
      paperImg.src = '/api/image?v=' + iv;
    }
    paperImg.style.display = 'block';
    if (paperEmpty) paperEmpty.style.display = 'none';
    paperCard.style.display = 'block';
  } else {
    // 没有图片时保留卡片并给出提示，避免让人以为功能消失了
    paperImg.style.display = 'none';
    if (paperEmpty) {
      paperEmpty.style.display = 'block';
      paperEmpty.textContent = d.status && d.status.indexOf('阅卷') !== -1
        ? '正在获取试卷图片…'
        : '等待上传试卷图片…开始批改后自动显示';
    }
    paperCard.style.display = 'block';
  }

  // 实时思考内容
  var streamCard = document.getElementById('streamCard');
  var streamEl = document.getElementById('streamText');
  var sText = d.streamText || '';
  if (sText) {
    streamCard.style.display = 'block';
    if (streamEl.textContent !== sText) {
      streamEl.textContent = sText;
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  } else {
    streamCard.style.display = 'none';
  }

  document.getElementById('count').textContent = d.gradedCount || 0;
  document.getElementById('full').textContent = d.totalScore || '-';

  // 本题信息：题目 / 标准答案 / 评分标准
  var taskCard = document.getElementById('taskCard');
  var qv = String(d.question || '').trim();
  var av = String(d.standardAnswer || '').trim();
  var cv = String(d.scoringCriteria || '').trim();
  if (qv || av || cv) {
    taskCard.style.display = 'block';
    setTaskText('taskQuestion', qv, '（未填写）');
    setTaskText('taskAnswer', av, '（未填写）');
    setTaskText('taskCriteria', cv, '未填写，按要点均分');
    document.getElementById('taskScoreTag').textContent = d.totalScore ? d.totalScore + ' 分' : '';
  } else {
    taskCard.style.display = 'none';
  }

  // 网页任务进度
  var prog = d.progress;
  var wpEl = document.getElementById('webProgress');
  if (prog && prog.total) {
    var pct = (prog.percent !== null && prog.percent !== undefined)
      ? prog.percent
      : Math.round(prog.reviewed / prog.total * 10000) / 100;
    wpEl.style.display = 'block';
    var wpLabel = document.getElementById('wpLabel');
    var wpFill = document.getElementById('wpFill');
    if (wpLabel) wpLabel.textContent = '已阅 ' + prog.reviewed + ' / ' + prog.total + ' 份 · ' + pct + '%';
    if (wpFill) wpFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  } else {
    wpEl.style.display = 'none';
  }

  var lastEl = document.getElementById('last');
  if (d.lastScore === null || d.lastScore === undefined) {
    lastEl.textContent = '-';
    lastEl.className = 'num';
  } else {
    lastEl.textContent = d.lastScore;
    lastEl.className = 'num ' + scoreColor(d.lastScore, d.totalScore);
  }

  var hist = d.history || [];
  var scoresEl = document.getElementById('scores');
  if (!hist.length) {
    scoresEl.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无记录</div>';
  } else {
    var html = '';
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      var cls = h.status === 'success' ? scoreColor(h.score, d.totalScore) : 'low';
      var txt = h.status === 'success' ? String(h.score) : '!';
      var parts = [];
      var timeStr = fmtTime(h.time);
      if (timeStr) parts.push(timeStr);
      parts.push('#' + (hist.length - i));
      html += '<div class="score-card"><div class="score-big ' + cls + '">' + txt + '</div>' +
        '<div class="score-sub">' + escapeHtml(parts.join(' · ')) + '</div></div>';
    }
    scoresEl.innerHTML = html;
  }

  var logs = d.logs || [];
  var logsEl = document.getElementById('logs');
  if (!logs.length) {
    logsEl.innerHTML = '<div class="empty">暂无日志</div>';
  } else {
    var html2 = '';
    for (var j = 0; j < logs.length; j++) {
      var g = logs[j];
      if (g.type === 'divider') continue;
      html2 += '<div class="log ' + (g.type || '') + '"><span class="log-time">' + (g.time || '') +
        '</span><span class="log-msg">' + escapeHtml(g.message || '') + '</span></div>';
    }
    logsEl.innerHTML = html2;
  }

  document.getElementById('refresh').textContent = '最后更新：' + (d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : '暂无');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setTaskText(id, value, placeholder) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = value || placeholder;
  el.className = value ? 'task-text' : 'task-text task-missing';
}

// 横竖图自适应 + 点击全屏查看
var paperImgEl = document.getElementById('paperImg');
var imgZoom = document.getElementById('imgZoom');
var imgZoomPic = document.getElementById('imgZoomPic');

paperImgEl.onload = function () {
  var ratio = this.naturalWidth / this.naturalHeight;
  // 竖图/方图限高避免撑满屏；横图按宽度铺满，字更清楚
  this.classList.toggle('is-portrait', ratio < 1.05);
};

paperImgEl.onclick = function () {
  if (!window.__imgVersion) return;
  imgZoomPic.src = '/api/image?v=' + window.__imgVersion;
  imgZoom.hidden = false;
};

imgZoom.onclick = function () {
  imgZoom.hidden = true;
};



// ---- 自动更新检查 ----
var updateBar = document.getElementById('updateBar');
var updateText = document.getElementById('updateText');
var updateBtn = document.getElementById('updateBtn');

async function checkSelfUpdate() {
  try {
    var r = await fetch('/api/update', { cache: 'no-store' });
    var d = await r.json();
    if (d && d.success && d.hasUpdate) {
      updateText.textContent = '发现新版本 v' + d.latest + '（当前 ' + d.current + '）' + (d.notes ? ' · ' + d.notes : '');
      updateBar.hidden = false;
    }
  } catch (e) {}
}

updateBtn.onclick = async function () {
  updateBtn.disabled = true;
  updateBtn.textContent = '更新中…';
  try {
    var r = await fetch('/api/update/apply', { method: 'POST' });
    var d = await r.json();
    if (d && d.success) {
      updateBtn.textContent = '即将重启…';
      updateText.textContent = '已下载新版本，程序正在重启，页面稍后会自动刷新';
      setTimeout(function () { location.reload(); }, 7000);
    } else {
      updateBtn.disabled = false;
      updateBtn.textContent = '重试';
      updateText.textContent = '更新失败：' + ((d && d.error) || '未知错误');
    }
  } catch (e) {
    updateBtn.disabled = false;
    updateBtn.textContent = '重试';
    updateText.textContent = '更新失败，请检查网络';
  }
};

setTimeout(checkSelfUpdate, 3000);
setInterval(checkSelfUpdate, 30 * 60 * 1000);

// 点阵场初始化
createLatticeField(document.getElementById('field'), { pitch: 16, maxPoints: 1400, radius: 96, push: 16, alpha: 0.13 });
</script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 插件上报状态
  if (url.pathname === '/api/status' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        state = Object.assign({}, data, { updatedAt: Date.now(), imageVersion: imageVersion });
        broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false}');
      }
    });
    return;
  }

  // 插件下发更新源地址
  if (url.pathname === '/api/update-config' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        UPDATE_URL = String(data.updateUrl || '').trim();
        saveUpdateConf(UPDATE_URL);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, updateUrl: UPDATE_URL }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false}');
      }
    });
    return;
  }

  // 检查监控自身是否有新版本
  if (url.pathname === '/api/update' && req.method === 'GET') {
    checkMonitorUpdate().then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // 下载并应用更新（会重启进程）
  if (url.pathname === '/api/update/apply' && req.method === 'POST') {
    applyMonitorUpdate().then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // 插件轮询：是否需要重载
  if (url.pathname === '/api/plugin-version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      latest: updateState.latest || '',
      needReload: pluginReloadPending,
      pluginDir: resolvePluginDir(),
      hasUpdate: !!updateState.hasUpdate
    }));
    return;
  }

  // 插件已自行重载，清除待重载标记
  if (url.pathname === '/api/plugin-reloaded' && req.method === 'POST') {
    pluginReloadPending = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // 手动更新插件文件
  if (url.pathname === '/api/update/plugin' && req.method === 'POST') {
    updatePluginFiles().then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // 插件上传当前试卷图片
  if (url.pathname === '/api/image' && req.method === 'POST') {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const { image } = JSON.parse(body);
        const m = String(image || '').match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
        if (!m) throw new Error('bad image');
        currentImage = { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
        imageVersion++;
        state.imageVersion = imageVersion;
        broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: imageVersion }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false}');
      }
    });
    return;
  }

  // 获取当前试卷图片
  if (url.pathname === '/api/image' && req.method === 'GET') {
    if (!currentImage) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no image');
      return;
    }
    res.writeHead(200, {
      'Content-Type': currentImage.mime,
      'Cache-Control': 'no-cache'
    });
    res.end(currentImage.buffer);
    return;
  }

  // 查询当前状态
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state));
    return;
  }

  // 实时推流
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('data: ' + JSON.stringify(state) + '\n\n');
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// 心跳，保持手机端连接
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch (e) {}
  }
}, 20000);

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，请先关闭占用该端口的程序，或改用其他端口：');
    console.error('  set MONITOR_PORT=8091 && node monitor-server.js');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('阅卷监控服务已启动 ' + VERSION);
  console.log('');
  console.log('  电脑访问：http://127.0.0.1:' + PORT);
  getLanIPs().forEach((ip) => {
    console.log('  手机访问：http://' + ip + ':' + PORT);
  });
  console.log('');
  console.log('手机需与电脑连同一 Wi-Fi。若手机打不开，请在 Windows 防火墙中允许本程序访问网络。');

  // 全自动更新：启动后检查一次，之后每 30 分钟一次
  if (UPDATE_URL) {
    console.log('更新源：' + UPDATE_URL + (AUTO_UPDATE ? '（自动更新已开启）' : '（仅提示，不自动安装）'));
    setTimeout(runAutoUpdate, 6000);
    setInterval(runAutoUpdate, 30 * 60 * 1000);
  }
});

// 检查 → 更新插件 → 更新监控自身
async function runAutoUpdate() {
  try {
    const result = await checkMonitorUpdate();
    if (!result || !result.success || !result.hasUpdate) return;

    console.log('[更新] 发现新版本 ' + result.latest);

    if (!AUTO_UPDATE) {
      console.log('[更新] 已关闭自动更新，请在手机/电脑页面点「立即更新」');
      return;
    }

    const pluginResult = await updatePluginFiles();
    console.log('[更新] 插件：' + (pluginResult.success ? '已更新 ' + pluginResult.files + ' 个文件' : '跳过（' + pluginResult.error + '）'));

    console.log('[更新] 正在替换监控程序并重启…');
    await applyMonitorUpdate();
  } catch (e) {
    console.log('[更新] 检查失败：' + e.message);
  }
}
