// popup.js - 弹出面板逻辑

const DEFAULT_CONFIG = {
  apiUrl: 'http://47.122.117.143:57894/v1/chat/completions',
  // 密钥不入库：首次使用请在「02 接口」页填写并保存
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  question: '',
  standardAnswer: '',
  totalScore: 6,
  scoringCriteria: '',
  updateUrl: ''
};

let currentConfig = { ...DEFAULT_CONFIG };

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initLatticeUI();
  loadConfig();
  bindEvents();
});

// ============ Lattice 点阵界面 ============

function initLatticeUI() {
  initField();
  buildTabDots();
  buildSwitchDots();
}

// 背景点场：网格点 + 指针推力 + 弹簧回位
function initField() {
  const cv = document.getElementById('latticeField');
  if (!cv || typeof createLatticeField !== 'function') return;
  createLatticeField(cv, { pitch: 16, maxPoints: 900, radius: 70, push: 12, alpha: 0.12 });
}

// 标签页：一串按顺序点亮的点
function buildTabDots() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.querySelector('.tab-dots')) return;
    const wrap = document.createElement('span');
    wrap.className = 'tab-dots';
    wrap.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 7; i++) {
      const d = document.createElement('i');
      d.style.transitionDelay = (i * 22) + 'ms';
      wrap.appendChild(d);
    }
    btn.appendChild(wrap);
  });
}

// 开关：19 点相变（关闭=气体散布，开启=右端六边形晶体）
function buildSwitchDots() {
  const track = document.querySelector('#monitorSwitch .lx-switch__track');
  if (!track || track.querySelector('i')) return;

  const crystal = [{ x: 0, y: 0 }];
  const gap = 6.6;
  for (let ring = 1; ring <= 2; ring++) {
    const n = 6 * ring;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (ring === 2 ? Math.PI / 12 : 0);
      crystal.push({ x: Math.cos(a) * gap * ring, y: Math.sin(a) * gap * ring });
    }
  }

  const cx = 47;
  const cy = 15;
  crystal.forEach((p, i) => {
    const d = document.createElement('i');
    d.style.setProperty('--tx', (9 + Math.random() * 34).toFixed(1) + 'px');
    d.style.setProperty('--ty', (6 + Math.random() * 18).toFixed(1) + 'px');
    d.style.setProperty('--cx', (cx + p.x - 1.5).toFixed(1) + 'px');
    d.style.setProperty('--cy', (cy + p.y - 1.5).toFixed(1) + 'px');
    d.style.transitionDelay = (i * 12) + 'ms';
    track.appendChild(d);
  });
}

function setMonitorSwitch(on) {
  const sw = document.getElementById('monitorSwitch');
  if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
}

function isMonitorSwitchOn() {
  const sw = document.getElementById('monitorSwitch');
  return !!sw && sw.getAttribute('aria-checked') === 'true';
}

// ============ 草稿自动保存（popup 被关闭也不丢内容） ============

const DRAFT_KEY = 'formDraft';
const DRAFT_FIELDS = ['question', 'standardAnswer', 'scoringCriteria', 'totalScore', 'apiUrl', 'apiKey', 'model', 'monitorUrl'];
let draftTimer = null;

function collectForm() {
  const data = {};
  DRAFT_FIELDS.forEach(f => {
    const el = document.getElementById(f);
    if (el) data[f] = el.value;
  });
  data.monitorEnabled = isMonitorSwitchOn();
  data.updatedAt = Date.now();
  return data;
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 250);
}

function flushDraft() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  try {
    chrome.storage.local.set({ [DRAFT_KEY]: collectForm() });
  } catch (e) {
    // 扩展上下文失效时忽略
  }
}

function clearDraft() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  try {
    chrome.storage.local.remove(DRAFT_KEY);
  } catch (e) {}
}

function hideDraftBanner() {
  const banner = document.getElementById('draftBanner');
  if (banner) banner.hidden = true;
}

// 把草稿中与已保存配置不同的字段填回表单
function applyDraft(draft) {
  if (!draft) return;
  let changed = 0;

  DRAFT_FIELDS.forEach(f => {
    const el = document.getElementById(f);
    if (!el || draft[f] === undefined || draft[f] === null) return;
    const savedValue = currentConfig[f] === undefined || currentConfig[f] === null ? '' : String(currentConfig[f]);
    if (String(draft[f]) !== savedValue) {
      el.value = draft[f];
      changed++;
    }
  });

  if (typeof draft.monitorEnabled === 'boolean' && draft.monitorEnabled !== !!currentConfig.monitorEnabled) {
    setMonitorSwitch(draft.monitorEnabled);
    changed++;
  }

  updateCharCount();

  if (changed > 0) {
    const banner = document.getElementById('draftBanner');
    if (banner) banner.hidden = false;
  }
}

// 加载配置
function loadConfig() {
  chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (config) => {
    currentConfig = { ...DEFAULT_CONFIG, ...config };
    fillForm();

    // 恢复上次没点保存就被关掉的内容
    try {
      chrome.storage.local.get([DRAFT_KEY], (res) => {
        if (res && res[DRAFT_KEY]) applyDraft(res[DRAFT_KEY]);
      });
    } catch (e) {}
  });
}

// 填充表单
function fillForm() {
  document.getElementById('apiUrl').value = currentConfig.apiUrl || '';
  document.getElementById('apiKey').value = currentConfig.apiKey || '';
  document.getElementById('model').value = currentConfig.model || '';
  document.getElementById('monitorUrl').value = currentConfig.monitorUrl || 'http://127.0.0.1:8090';
  document.getElementById('updateUrl').value = currentConfig.updateUrl || '';
  setMonitorSwitch(!!currentConfig.monitorEnabled);
  document.getElementById('question').value = currentConfig.question || '';
  document.getElementById('standardAnswer').value = currentConfig.standardAnswer || '';
  document.getElementById('totalScore').value = currentConfig.totalScore || 6;
  document.getElementById('scoringCriteria').value = currentConfig.scoringCriteria || '';
  
  updateCharCount();
}

// 绑定事件
function bindEvents() {
  // 标签切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });

  // 题目、标准答案字数统计
  document.getElementById('question').addEventListener('input', updateCharCount);
  document.getElementById('standardAnswer').addEventListener('input', updateCharCount);

  // 显示/隐藏密钥
  document.getElementById('toggleKeyBtn').addEventListener('click', toggleApiKey);

  // 保存标准答案
  document.getElementById('saveAnswerBtn').addEventListener('click', saveAnswerConfig);

  // 保存API设置
  document.getElementById('saveApiBtn').addEventListener('click', saveApiConfig);

  // 测试API连接
  document.getElementById('testApiBtn').addEventListener('click', testApiConnection);

  // 探测可用模型
  document.getElementById('detectModelsBtn').addEventListener('click', detectModels);

  // 保存局域网监控设置
  document.getElementById('saveMonitorBtn').addEventListener('click', saveMonitorConfig);

  // 版本更新
  document.getElementById('saveUpdateBtn').addEventListener('click', saveUpdateUrl);
  document.getElementById('checkUpdateBtn').addEventListener('click', checkUpdate);

  // 手机查看开关
  const monitorSwitch = document.getElementById('monitorSwitch');
  if (monitorSwitch) {
    monitorSwitch.addEventListener('click', () => {
      setMonitorSwitch(!isMonitorSwitchOn());
    });
  }

  // 控制面板按钮
  document.getElementById('ctrlStartBtn').addEventListener('click', startAutoGrading);
  document.getElementById('ctrlPauseBtn').addEventListener('click', togglePause);
  document.getElementById('ctrlStopBtn').addEventListener('click', stopAutoGrading);
  document.getElementById('ctrlSingleBtn').addEventListener('click', gradeCurrent);

  // 历史记录刷新按钮
  document.getElementById('refreshHistoryBtn').addEventListener('click', loadHistory);
  // 历史记录清除按钮
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);

  // 输入即存草稿：popup 失去焦点被关掉，内容也不会丢
  DRAFT_FIELDS.forEach(f => {
    const el = document.getElementById(f);
    if (el) el.addEventListener('input', scheduleDraftSave);
  });
  if (monitorSwitch) monitorSwitch.addEventListener('click', scheduleDraftSave);

  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushDraft();
  });

  // 丢弃未保存的修改，回到已保存内容
  document.getElementById('discardDraftBtn').addEventListener('click', () => {
    clearDraft();
    hideDraftBanner();
    fillForm();
    showTip('已丢弃未保存的修改');
  });

  // 在独立窗口打开，复制答案时不会被打断
  document.getElementById('openWindowBtn').addEventListener('click', openInWindow);
}

// 独立窗口模式：编辑期间不会被焦点变化关掉
function openInWindow() {
  flushDraft();
  try {
    chrome.windows.create(
      {
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 420,
        height: 680
      },
      () => {
        try { window.close(); } catch (e) {}
      }
    );
  } catch (e) {
    showTip('无法打开独立窗口');
  }
}

// 切换标签
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabName}`);
  });
  
  // 切换到历史记录标签时自动加载数据
  if (tabName === 'history') {
    loadHistory();
  }
}

// 更新字数统计
function updateCharCount() {
  const q = document.getElementById('question').value;
  const a = document.getElementById('standardAnswer').value;
  document.getElementById('questionCharCount').textContent = q.length;
  document.getElementById('answerCharCount').textContent = a.length;
}

// 显示/隐藏API密钥
function toggleApiKey() {
  const input = document.getElementById('apiKey');
  const btn = document.getElementById('toggleKeyBtn');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '隐藏';
  } else {
    input.type = 'password';
    btn.textContent = '显示';
  }
}

// 保存题目与答案配置
function saveAnswerConfig() {
  const question = document.getElementById('question').value.trim();
  const standardAnswer = document.getElementById('standardAnswer').value.trim();
  const totalScore = parseInt(document.getElementById('totalScore').value) || 6;
  const scoringCriteria = document.getElementById('scoringCriteria').value.trim();

  if (!question) {
    showTip('请填写题目（问题是什么）', 'error');
    return;
  }

  if (!standardAnswer) {
    showTip('请填写标准答案', 'error');
    return;
  }

  const config = { question, standardAnswer, totalScore, scoringCriteria };
  
  chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config }, () => {
    currentConfig = { ...currentConfig, ...config };
    // 通知content script配置更新
    notifyContentScript();
    showTip('题目与答案已保存');
    hideDraftBanner();
    flushDraft();
  });
}

// 保存API配置
function saveApiConfig() {
  const apiUrl = document.getElementById('apiUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value.trim();

  if (!apiUrl || !apiKey || !model) {
    showTip('请填写完整的API信息', 'error');
    return;
  }

  const config = { apiUrl, apiKey, model };
  
  chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config }, () => {
    currentConfig = { ...currentConfig, ...config };
    showTip('API设置已保存');
    hideDraftBanner();
    flushDraft();
  });
}

// 保存局域网监控设置
function saveMonitorConfig() {
  const monitorUrl = document.getElementById('monitorUrl').value.trim() || 'http://127.0.0.1:8090';
  const monitorEnabled = isMonitorSwitchOn();

  chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: { monitorUrl, monitorEnabled } }, () => {
    chrome.runtime.lastError;
    currentConfig = { ...currentConfig, monitorUrl, monitorEnabled };

    // 立即通知页面：否则页面仍按旧的 monitorEnabled 判断，不会上传试卷图片
    notifyContentScript();

    const hint = document.getElementById('monitorHint');
    hint.style.display = 'block';
    hint.className = 'test-result success';
    hint.textContent = monitorEnabled
      ? '已开启。请先双击运行「一键阅卷监控.exe」，手机与电脑连同一 Wi-Fi，访问 http://电脑IP:8090'
      : '已关闭手机查看';

    hideDraftBanner();
    flushDraft();
  });
}

// ============ 版本更新 ============

function saveUpdateUrl() {
  const updateUrl = document.getElementById('updateUrl').value.trim();

  chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: { updateUrl } }, () => {
    chrome.runtime.lastError;
    currentConfig = { ...currentConfig, updateUrl };
    showTip('更新源已保存');
    flushDraft();
    pushUpdateUrlToMonitor(updateUrl);
  });
}

// 把更新源同步给本机监控服务，让它也能检查更新
function pushUpdateUrlToMonitor(updateUrl) {
  const base = String(
    document.getElementById('monitorUrl').value.trim() || currentConfig.monitorUrl || ''
  ).replace(/\/+$/, '');
  if (!base || !updateUrl) return null;
  return fetch(base + '/api/update-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updateUrl: updateUrl })
  }).catch(() => null);
}

async function checkUpdate() {
  const box = document.getElementById('updateResult');
  const updateUrl = document.getElementById('updateUrl').value.trim();

  if (!updateUrl) {
    box.className = 'test-result error';
    box.textContent = '请先填写更新源地址（update.json 的网址）';
    return;
  }

  box.className = 'test-result loading';
  box.textContent = '正在检查更新…';

  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ type: 'CHECK_UPDATE', updateUrl: updateUrl });
  } catch (e) {
    result = { success: false, error: e.message };
  }

  if (!result || !result.success) {
    box.className = 'test-result error';
    box.textContent = '检查失败：' + ((result && result.error) || '未知错误');
    return;
  }

  if (!result.hasUpdate) {
    box.className = 'test-result success';
    box.textContent = '已是最新版本 v' + result.current;
    return;
  }

  box.className = 'test-result success';
  box.innerHTML = '';

  const head = document.createElement('div');
  head.textContent = '发现新版本 v' + result.latest + '（当前 v' + result.current + '）';
  box.appendChild(head);

  if (result.notes) {
    const notes = document.createElement('div');
    notes.className = 'update-notes';
    notes.textContent = result.notes;
    box.appendChild(notes);
  }

  const actions = document.createElement('div');
  actions.className = 'update-actions';

  if (result.pluginUrl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-detect';
    btn.textContent = '下载插件包';
    btn.addEventListener('click', () => downloadFile(result.pluginUrl));
    actions.appendChild(btn);
  }

  if (result.monitorUrl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-detect';
    btn.textContent = '下载监控程序';
    btn.addEventListener('click', () => downloadFile(result.monitorUrl));
    actions.appendChild(btn);
  }

  box.appendChild(actions);
}

function downloadFile(url) {
  try {
    chrome.downloads.download({ url: url, saveAs: false }, () => {
      chrome.runtime.lastError;
      showTip('已开始下载');
    });
  } catch (e) {
    window.open(url, '_blank');
  }
}

// 测试API连接（通过background代发，绕过popup的CORS限制）
async function testApiConnection() {  const resultEl = document.getElementById('testResult');
  resultEl.className = 'test-result loading';
  resultEl.textContent = '正在测试连接...';

  const apiUrl = document.getElementById('apiUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value.trim();

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'TEST_API',
      apiUrl: apiUrl,
      apiKey: apiKey,
      model: model
    });

    if (result && result.success) {
      resultEl.className = 'test-result success';
      resultEl.textContent = 'API连接成功 · 模型返回：' + result.message;
    } else {
      resultEl.className = 'test-result error';
      const url = result?.url ? `\n实际请求：${result.url}` : '';
      resultEl.textContent = '连接失败: ' + (result?.error || '未知错误') + url;
    }
  } catch (error) {
    resultEl.className = 'test-result error';
    resultEl.textContent = '请求失败: ' + error.message;
  }
}

// 探测可用模型：调用 /v1/models，结果渲染为可选点阵标签
async function detectModels() {
  const btn = document.getElementById('detectModelsBtn');
  const hint = document.getElementById('modelHint');
  const listEl = document.getElementById('modelList');
  const apiUrl = document.getElementById('apiUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!apiUrl || !apiKey) {
    hint.className = 'hint-line hint-error';
    hint.textContent = '请先填写 API 地址与密钥';
    return;
  }

  btn.disabled = true;
  hint.className = 'hint-line';
  hint.textContent = '正在探测模型…';

  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ type: 'GET_MODELS', apiUrl, apiKey });
  } catch (e) {
    result = { success: false, error: e.message };
  }

  btn.disabled = false;

  if (!result || !result.success) {
    listEl.hidden = true;
    listEl.innerHTML = '';
    hint.className = 'hint-line hint-error';
    hint.textContent = '探测失败：' + ((result && result.error) || '未知错误');
    return;
  }

  if (!result.models || result.models.length === 0) {
    listEl.hidden = true;
    listEl.innerHTML = '';
    hint.className = 'hint-line hint-error';
    hint.textContent = '接口未返回任何模型';
    return;
  }

  renderModelChips(result.models);
  hint.className = 'hint-line';
  hint.textContent = `发现 ${result.models.length} 个模型 · 点击即可选用`;
}

function renderModelChips(models) {
  const listEl = document.getElementById('modelList');
  const input = document.getElementById('model');
  const current = input.value.trim();

  listEl.hidden = false;
  listEl.innerHTML = '';

  models.forEach(name => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'model-chip' + (current === name ? ' on' : '');
    chip.textContent = name;
    chip.title = name;
    chip.addEventListener('click', () => {
      input.value = name;
      listEl.querySelectorAll('.model-chip').forEach(c => c.classList.remove('on'));
      chip.classList.add('on');
      showTip('已选择 ' + name);
    });
    listEl.appendChild(chip);
  });
}

// 通知content script配置更新
function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'CONFIG_UPDATED' }, () => {
        // 清除lastError，避免控制台警告
        chrome.runtime.lastError;
      });
    }
  });
}

// 开始自动阅卷
function startAutoGrading() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'START_AUTO_GRADING' }, (response) => {
        if (chrome.runtime.lastError) {
          showTip('请先打开阅卷页面', 'error');
          return;
        }
        if (response?.success) {
          document.getElementById('ctrlStartBtn').disabled = true;
          document.getElementById('ctrlPauseBtn').disabled = false;
          document.getElementById('ctrlStopBtn').disabled = false;
          setPauseState(false);
          document.getElementById('ctrlStatus').textContent = '自动阅卷中';
          showTip('已开始自动阅卷');
        } else {
          showTip(response?.error || '请先打开阅卷页面', 'error');
        }
      });
    } else {
      showTip('请先打开阅卷页面', 'error');
    }
  });
}

// 暂停/继续
function togglePause() {
  const btn = document.getElementById('ctrlPauseBtn');
  const isPaused = btn.dataset.paused === '1';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      const type = isPaused ? 'RESUME_AUTO_GRADING' : 'PAUSE_AUTO_GRADING';
      chrome.tabs.sendMessage(tabs[0].id, { type }, () => {
        chrome.runtime.lastError; // 清除错误
        setPauseState(!isPaused);
        document.getElementById('ctrlStatus').textContent = isPaused ? '自动阅卷中' : '已暂停';
      });
    }
  });
}

// 暂停按钮状态（图标与文案分离，避免覆盖 SVG）
function setPauseState(paused) {
  const btn = document.getElementById('ctrlPauseBtn');
  const label = document.getElementById('pauseLabel');
  if (btn) btn.dataset.paused = paused ? '1' : '0';
  if (label) label.textContent = paused ? '继续' : '暂停';
}

// 停止
function stopAutoGrading() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_AUTO_GRADING' }, () => {
        chrome.runtime.lastError; // 清除错误
        document.getElementById('ctrlStartBtn').disabled = false;
        document.getElementById('ctrlPauseBtn').disabled = true;
        document.getElementById('ctrlStopBtn').disabled = true;
        setPauseState(false);
        document.getElementById('ctrlStatus').textContent = '已停止';
        showTip('已停止自动阅卷');
      });
    }
  });
}

// 批改当前试卷
function gradeCurrent() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GRADE_CURRENT' }, (response) => {
        if (chrome.runtime.lastError) {
          showTip('请先打开阅卷页面', 'error');
          return;
        }
        if (response?.success) {
          showTip(`评分完成：${response.score}分`);
          const countEl = document.getElementById('ctrlCount');
          countEl.textContent = parseInt(countEl.textContent) + 1;
        } else {
          showTip('评分失败：' + (response?.error || '未知错误'), 'error');
        }
      });
    } else {
      showTip('请先打开阅卷页面', 'error');
    }
  });
}

// 显示提示
function showTip(message, type = 'success') {
  const tipEl = document.getElementById('saveTip');
  tipEl.textContent = message;
  tipEl.className = 'save-tip show';
  
  setTimeout(() => {
    tipEl.classList.remove('show');
  }, 2000);
}

// 加载历史记录（直接读本地存储，扩展重载后依然保留）
function loadHistory() {
  chrome.storage.local.get(['gradeHistory'], (res) => {
    if (chrome.runtime.lastError) {}
    const history = Array.isArray(res?.gradeHistory) ? res.gradeHistory : [];
    renderHistory(history);
  });
}

// 清除历史记录
function clearHistory() {
  if (!confirm('确定要清除全部历史记录吗？清除后无法恢复。')) return;

  chrome.storage.local.remove(['gradeHistory'], () => {
    if (chrome.runtime.lastError) {}
    renderHistory([]);

    // 如果当前页面正在运行阅卷，同步通知它清空内存
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_HISTORY' }, () => {
          chrome.runtime.lastError;
        });
      }
    });
  });
}

// 渲染历史记录
function renderHistory(history) {
  const listEl = document.getElementById('historyList');
  const totalEl = document.getElementById('historyTotal');
  const avgEl = document.getElementById('historyAvg');
  const fullEl = document.getElementById('historyFull');
  
  // 统计数据
  const successRecords = history.filter(h => h.status === 'success');
  const total = successRecords.length;
  totalEl.textContent = total;
  
  if (total > 0) {
    const sum = successRecords.reduce((acc, h) => acc + h.score, 0);
    const avg = (sum / total).toFixed(1);
    avgEl.textContent = avg;
    
    const fullCount = successRecords.filter(h => {
      const totalScore = currentConfig.totalScore || 6;
      return h.score >= totalScore;
    }).length;
    fullEl.textContent = fullCount;
  } else {
    avgEl.textContent = '0';
    fullEl.textContent = '0';
  }
  
  // 渲染列表
  if (history.length === 0) {
    listEl.innerHTML = `
      <div class="history-empty">
        <div class="empty-icon"><svg class="ico ico-lg" aria-hidden="true"><use href="#i-doc"/></svg></div>
        <div class="empty-text">暂无评分记录</div>
        <div class="empty-desc">开始阅卷后，评分记录将显示在这里</div>
      </div>
    `;
    return;
  }
  
  const totalScore = currentConfig.totalScore || 6;
  
  listEl.innerHTML = history.map((record, index) => {
    const scorePercent = totalScore > 0 ? (record.score / totalScore) * 100 : 0;
    let scoreClass = 'score-low';
    if (scorePercent >= 80) scoreClass = 'score-high';
    else if (scorePercent >= 50) scoreClass = 'score-mid';
    
    const strengthsHtml = record.strengths?.length > 0 
      ? `<ul class="history-points-list">${record.strengths.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
      : '<div class="pt-none">无</div>';
    
    const weaknessesHtml = record.weaknesses?.length > 0 
      ? `<ul class="history-points-list missed">${record.weaknesses.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
      : '<div class="pt-none">无</div>';
    
    const pointsHtml = record.points?.length > 0
      ? record.points.map((p) => {
          const earned = typeof p.earned === 'number' ? p.earned : 0;
          const full = typeof p.full === 'number' ? p.full : 0;
          const cls = earned >= full && full > 0 ? 'pt-ok' : (earned > 0 ? 'pt-part' : 'pt-miss');
          const evidence = p.evidence && p.evidence !== '无'
            ? `<div class="pt-evidence">依据：${escapeHtml(p.evidence)}</div>`
            : '';
          return `<li class="pt ${cls}">
            <strong>${escapeHtml(p.point || '')}</strong> — ${escapeHtml(p.status || '')}（${earned}/${full}分）
            ${evidence}
          </li>`;
        }).join('')
      : '<div class="pt-none">无</div>';
    
    return `
      <div class="history-item" data-index="${index}">
        <div class="history-item-header">
          <div class="history-item-left">
            <div class="history-score-badge ${scoreClass}">${record.score}</div>
            <div class="history-item-info">
              <div class="history-item-time">${record.time} ${record.questionNumber || ''}</div>
              <div class="history-item-question">${record.overallLevel || (record.status === 'success' ? '评分成功' : '评分失败：' + (record.error || ''))}${record.answerStyle ? ' · ' + record.answerStyle : ''}</div>
            </div>
          </div>
          <svg class="ico ico-xs history-item-arrow" aria-hidden="true"><use href="#i-chevron"/></svg>
        </div>
        <div class="history-item-body">
          ${record.thinking ? `
          <div class="history-section">
            <div class="history-section-title"><svg class="ico ico-xs" aria-hidden="true"><use href="#i-think"/></svg>思考过程</div>
            <div class="history-section-content thinking">${escapeHtml(record.thinking)}</div>
          </div>
          ` : ''}
          
          ${record.points?.length > 0 ? `
          <div class="history-section">
            <div class="history-section-title"><svg class="ico ico-xs" aria-hidden="true"><use href="#i-list"/></svg>要点核对（${record.points.length}个）</div>
            <ul class="history-points-list">${pointsHtml}</ul>
          </div>
          ` : ''}
          
          ${record.strengths?.length > 0 ? `
          <div class="history-section">
            <div class="history-section-title"><svg class="ico ico-xs" aria-hidden="true"><use href="#i-check"/></svg>亮点（${record.strengths.length}个）</div>
            ${strengthsHtml}
          </div>
          ` : ''}
          
          ${record.weaknesses?.length > 0 ? `
          <div class="history-section">
            <div class="history-section-title"><svg class="ico ico-xs" aria-hidden="true"><use href="#i-x"/></svg>不足（${record.weaknesses.length}个）</div>
            ${weaknessesHtml}
          </div>
          ` : ''}
          
          ${record.reason ? `
          <div class="history-section">
            <div class="history-section-title"><svg class="ico ico-xs" aria-hidden="true"><use href="#i-doc"/></svg>评分理由</div>
            <div class="history-reason">${escapeHtml(record.reason)}</div>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  // 绑定展开/收起事件
  listEl.querySelectorAll('.history-item-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.parentElement;
      item.classList.toggle('expanded');
    });
  });
}

// HTML转义
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
