// background.js - 后台服务，处理大模型API调用

// 默认配置
const DEFAULT_CONFIG = {
  apiUrl: 'http://47.122.117.143:57894/v1/chat/completions',
  // 密钥不写进仓库：首次使用请在「02 接口」页填写并保存
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  question: '',
  standardAnswer: '',
  totalScore: 6,
  scoringCriteria: '',
  monitorEnabled: false,
  monitorUrl: 'http://127.0.0.1:8090',
  updateUrl: ''
};

// 旧版内置的失效中转：命中就自动迁移到新默认，避免还跑在坏配置上
const LEGACY_API_MARKERS = ['business.starway.lol', 'sk-adfcc750779bfac2f10f30be8aecf1a0cb'];

function isLegacyConfig(apiUrl, apiKey) {
  const url = String(apiUrl || '');
  const key = String(apiKey || '');
  return LEGACY_API_MARKERS.some(m => url.indexOf(m) !== -1 || key.indexOf(m) !== -1);
}

// 获取配置
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULT_CONFIG), (result) => {
      const config = { ...DEFAULT_CONFIG, ...result };

      // 迁移旧配置：换掉失效的中转地址，不动用户已填的有效密钥
      if (isLegacyConfig(config.apiUrl, config.apiKey)) {
        const patch = { apiUrl: DEFAULT_CONFIG.apiUrl, model: DEFAULT_CONFIG.model };

        // 旧版内置的失效密钥直接清掉，等用户填自己的
        if (String(config.apiKey || '').indexOf('sk-adfcc750779bfac2f10f30be8aecf1a0cb') !== -1) {
          patch.apiKey = '';
        }

        chrome.storage.local.set(patch);
        Object.assign(config, patch);
      }

      resolve(config);
    });
  });
}

// 保存配置
async function saveConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set(config, () => {
      resolve();
    });
  });
}

// 规范化API地址：用户可能只填了域名/端口，自动补全 /v1/chat/completions
function normalizeApiUrl(url) {
  if (!url) return url;
  url = url.trim().replace(/\/+$/, ''); // 去掉末尾斜杠
  if (url.endsWith('/chat/completions')) return url;
  if (url.endsWith('/v1')) return url + '/chat/completions';
  return url + '/v1/chat/completions';
}

// 推送批改状态到局域网监控服务
async function pushMonitor(state) {
  const config = await getConfig();
  if (!config.monitorEnabled || !config.monitorUrl) return false;
  const url = String(config.monitorUrl).replace(/\/+$/, '') + '/api/status';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// 推送当前试卷图片到监控服务
async function pushMonitorImage(image) {
  const config = await getConfig();
  if (!config.monitorEnabled || !config.monitorUrl) return false;
  const url = String(config.monitorUrl).replace(/\/+$/, '') + '/api/image';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// 把流式增量推送给页面（100ms 批量发送，避免刷屏和性能问题）
let pendDelta = '';
let pendTabId = null;
let pendTimer = null;
let lastFlushAt = 0;

function flushStream() {
  pendTimer = null;
  if (!pendDelta || !pendTabId) return;
  const text = pendDelta;
  const tabId = pendTabId;
  pendDelta = '';
  lastFlushAt = Date.now();
  try {
    chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', delta: text }, () => {
      if (chrome.runtime.lastError) {}
    });
  } catch (e) {}
}

function notifyStream(tabId, delta) {
  if (!tabId) return;
  pendTabId = tabId;
  pendDelta += delta;
  if (pendTimer) return;
  const wait = Math.max(0, 100 - (Date.now() - lastFlushAt));
  if (wait === 0) {
    flushStream();
  } else {
    pendTimer = setTimeout(flushStream, wait);
  }
}

// 读取 SSE 流，返回完整文本
async function readSSEStream(response, tabId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let full = '';
  let raw = '';
  let sawSSE = false;
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      raw += chunkText;
      buffer += chunkText;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        sawSSE = true;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const deltaObj = obj.choices?.[0]?.delta || {};
          // 推理模型可能先输出 reasoning_content，单独推送用于实时展示
          if (deltaObj.reasoning_content) notifyStream(tabId, deltaObj.reasoning_content);
          const delta = deltaObj.content || '';
          if (delta) {
            full += delta;
            notifyStream(tabId, delta);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
  flushStream(); // 把最后一批内容推送出去
  // 有些中转会忽略 stream 参数直接返回普通 JSON，这里原样返回供后续解析
  return sawSSE ? full : raw;
}

// 调用大模型API进行阅卷评分
async function gradePaper(studentAnswerImage, questionInfo, tabId) {
  const config = await getConfig();
  
  if (!config.question) {
    return {
      success: false,
      error: '请先在扩展面板中填写【题目】',
      score: 0
    };
  }

  if (!config.standardAnswer) {
    return {
      success: false,
      error: '请先在扩展面板中设置【标准答案】',
      score: 0
    };
  }

  const totalScore = parseInt(config.totalScore) || 6;

  // 评分标准：用户未填写时按要点均分处理
  const criteriaText = config.scoringCriteria
    ? config.scoringCriteria
    : '未提供单独评分标准，按要点均分执行：把标准答案拆成若干核心要点（通常 3-5 个），每个要点分值 = 满分 ÷ 要点数（保留一位小数）；完整覆盖给该要点满分，部分覆盖给该要点 2/3 分，未覆盖给 0 分。';

  const systemPrompt = `你是一位严谨、公正的阅卷老师。你必须严格依据下面的【题目】【标准答案】【评分标准】评分，禁止脱离这三项凭整体印象直接给分。

====================
【一、题目（问题是什么）】
${config.question}

【二、标准答案（参考答案）】
${config.standardAnswer}

【三、评分标准】
${criteriaText}
====================

本题满分：${totalScore} 分

【评分流程】严格按四步执行

第一步：判断是否扣题（只在极端情况下给 0 分）
先判断学生答案是否在回答【题目】所问的内容。
- 仅以下三种情况给 0 分：① 卷面完全空白；② 内容与题目所属学科完全无关；③ 只是照抄题干原文。
- 只要学生写出了与题目相关的学科内容（哪怕是关键词、短语、口语化表达、书写不规范），都必须继续第二步按要点给分。
- 图片模糊、字迹潦草时，按能辨认出的内容尽量评分，严禁因为"看不清"给 0 分。

第二步：拆分要点
依据【标准答案】和【评分标准】，拆出若干独立的核心要点（通常 3-5 个）。
- 若【评分标准】已规定分档、采分点或扣分项，以评分标准为准，不要自行平均分配。
- 若未规定，则每个要点满分 = 本题满分 ÷ 要点数（保留一位小数）。

第三步：逐条核对
对每个要点判断学生答案的覆盖程度，并引用学生原文作为依据：
- 完整覆盖：学生明确表达出该要点的核心意思 → 给该要点满分
- 部分覆盖：只沾到该要点、意思不完整或不准确 → 给该要点 2/3 分
- 未覆盖：完全没有提到 → 0 分

同时判断作答形式（仅作限分依据，不改变要点判断结果）：
- 完整论述：有完整句子、有展开说明 → 正常计分
- 短语罗列：一条一行、只有几个字的词或短语、没有任何展开 → 每个"部分覆盖"最多 0.5 分
- 套话连篇：全是与题目无关的万能话术 → 相关要点 0 分

第四步：求和
把各要点得分相加，四舍五入取整，得到最终分数。

【判定细则】
1. 意思对了就算覆盖。学生用自己的话表达同样的意思，算完整覆盖。
2. 只按【标准答案】和【评分标准】给分。标准答案里没有的内容，即使本身正确、即使写得很漂亮，也不加分、不算要点。
3. 与题目无关的通用套话（空泛口号、万能表述）不计分。
4. 沾边但偏题的内容最多算部分覆盖，不能算完整覆盖。
5. 不要因为写得多就抬高分数，也不要因为写得少就压低分数，只看要点覆盖。
6. 学生答案完全空白、或只有涂改痕迹 → 0 分；字迹潦草但能辨认内容的，正常评分，不得给 0 分。
7. 0 分是最后手段：只有当学生确实没有任何有效作答时才使用。

【示例】本题满分 ${totalScore} 分，标准答案拆为 3 个要点，每点 ${(totalScore / 3).toFixed(1)} 分：①甲 ②乙 ③丙
- 学生写到①②且论述完整、未提③ → ①满分 + ②满分 + ③0分
- 学生只写到①的一部分，另两条偏题 → ①2/3分 + ②0分 + ③0分

【输出要求】必须严格遵守
- 只输出一个 JSON 对象：第一个字符是 {，最后一个字符是 }
- 不要输出任何解释文字，不要使用 markdown 代码块
- thinking 用一段话概括四步判断，控制在 200 字以内
- points 中每一条都要给出 earned 与 full 的数值
- score 必须是 0 到 ${totalScore} 之间的数字

{
  "score": 最终整数分数（0 到 ${totalScore}）,
  "thinking": "四步判断的简要说明（200字内）",
  "points": [
    {"point": "要点1原文", "full": 2, "earned": 2, "status": "完整覆盖", "evidence": "学生原文中的对应内容"},
    {"point": "要点2原文", "full": 2, "earned": 2, "status": "完整覆盖", "evidence": "学生原文中的对应内容"},
    {"point": "要点3原文", "full": 2, "earned": 0, "status": "未覆盖", "evidence": "无"}
  ],
  "answerStyle": "完整论述 / 短语罗列 / 套话连篇",
  "overallLevel": "优秀/良好/一般/较差/差",
  "strengths": ["学生答得好的地方"],
  "weaknesses": ["学生遗漏或答得不好的要点"],
  "reason": "评分理由：是否扣题、每个要点得分与原因、合计多少分"
}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请查看学生答案图片，依据题目、标准答案和评分标准评分。只输出 JSON。' },
        { type: 'image_url', image_url: { url: studentAnswerImage } }
      ]
    }
  ];

  const apiUrl = normalizeApiUrl(config.apiUrl);
  const baseBody = { model: config.model, messages: messages, max_tokens: 3000, temperature: 0.1 };

  try {
    // 第一次：流式请求，页面上可实时看到模型思考过程
    let content = await requestCompletion(apiUrl, config.apiKey, baseBody, tabId, true);
    let parsed = parseGradeResult(content);

    // 流式内容为空或解析失败时，用非流式再试一次（部分中转会截断流式输出）
    if (!parsed.ok) {
      content = await requestCompletion(apiUrl, config.apiKey, baseBody, tabId, false);
      parsed = parseGradeResult(content);
    }

    // 仍然解析不出分数：明确报错，绝不当成 0 分提交
    if (!parsed.ok) {
      const raw = String(content || '');
      const blind = /(看不到|无法查看|没有图片|无法识别图片|未提供图片|no image|can't see|cannot see|not support[^.]*image|image[^.]*not support)/i.test(raw);
      const hint = blind ? '（当前模型可能不支持图片输入，请在「02 接口」页探测并选择支持视觉的模型）' : '';
      return {
        success: false,
        error: '模型返回内容无法解析出分数（' + parsed.reason + '）。' + hint + '原文：' + (raw ? raw.slice(0, 200) : '空响应'),
        score: 0,
        thinking: '',
        reason: '',
        overallLevel: '',
        answerStyle: '',
        points: [],
        strengths: [],
        weaknesses: [],
        rawResponse: content || ''
      };
    }

    const data = parsed.data;
    let score = Math.round(Number(data.score) || 0);
    score = Math.max(0, Math.min(totalScore, score));

    return {
      success: true,
      score: score,
      thinking: data.thinking || '',
      reason: data.reason || '',
      overallLevel: data.overallLevel || '',
      answerStyle: data.answerStyle || '',
      points: data.points || [],
      strengths: data.strengths || [],
      weaknesses: data.weaknesses || [],
      degraded: !!parsed.degraded,
      rawResponse: content || ''
    };
  } catch (error) {
    return {
      success: false,
      error: '调用API出错: ' + error.message,
      score: 0
    };
  }
}

// 单次请求，返回模型正文（流式会边收边推送）
async function requestCompletion(apiUrl, apiKey, body, tabId, useStream) {
  const payload = Object.assign({}, body, { stream: !!useStream });
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (e) {}
    throw new Error('API ' + response.status + ' - ' + String(detail).slice(0, 300));
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (useStream && response.body && contentType.indexOf('application/json') === -1) {
    let content = await readSSEStream(response, tabId);
    if (content.trim().startsWith('{')) {
      const obj = tryParseJSON(content);
      if (obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) {
        content = obj.choices[0].message.content;
      }
    }
    return content;
  }

  const data = await response.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  if (content && tabId) notifyStream(tabId, content);
  return content;
}

function tryParseJSON(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch (e) {
    return null;
  }
}

// 要点得分求和：字段名兼容 earned / score
function sumPointsEarned(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let sum = 0;
  let hit = 0;
  points.forEach(p => {
    if (!p || typeof p !== 'object') return;
    const v = parseFloat(p.earned !== undefined ? p.earned : p.score);
    if (!isNaN(v)) {
      sum += v;
      hit++;
    }
  });
  return hit > 0 ? sum : null;
}

// 解析模型输出：多层兜底，但拿不到分数就判定失败
function parseGradeResult(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: '空响应' };

  let obj = tryParseJSON(text);

  if (!obj) {
    const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (block) obj = tryParseJSON(block[1].trim());
  }

  if (!obj) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) obj = tryParseJSON(text.slice(start, end + 1));
  }

  if (obj) {
    const points = Array.isArray(obj.points) ? obj.points : [];
    const scoreNum = parseFloat(obj.score);
    const sum = sumPointsEarned(points);
    const final = !isNaN(scoreNum) ? scoreNum : sum;

    if (final === null || isNaN(final)) {
      return { ok: false, reason: '缺少 score 字段' };
    }

    return {
      ok: true,
      data: {
        score: final,
        thinking: typeof obj.thinking === 'string' ? obj.thinking : '',
        reason: typeof obj.reason === 'string' ? obj.reason : '',
        overallLevel: typeof obj.overallLevel === 'string' ? obj.overallLevel : '',
        answerStyle: typeof obj.answerStyle === 'string' ? obj.answerStyle : '',
        points: points,
        strengths: Array.isArray(obj.strengths) ? obj.strengths : [],
        weaknesses: Array.isArray(obj.weaknesses) ? obj.weaknesses : []
      }
    };
  }

  // 兜底：正文里能明确抓到 score 数字，标记为降级解析
  const m = text.match(/["']score["']\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m) {
    return {
      ok: true,
      degraded: true,
      data: {
        score: parseFloat(m[1]),
        thinking: '',
        reason: text.slice(0, 400),
        overallLevel: '',
        answerStyle: '',
        points: [],
        strengths: [],
        weaknesses: []
      }
    };
  }

  return { ok: false, reason: '不是有效 JSON' };
}

// 消息监听
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GRADE_PAPER') {
    const tabId = sender.tab && sender.tab.id;
    gradePaper(request.studentAnswerImage, request.questionInfo || {}, tabId).then(result => {
      sendResponse(result);
    });
    return true; // 异步响应
  }
  
  if (request.type === 'GET_CONFIG') {
    getConfig().then(config => {
      sendResponse(config);
    });
    return true;
  }
  
  if (request.type === 'SAVE_CONFIG') {
    saveConfig(request.config).then(() => {
      // 通知已打开的阅卷页面刷新配置
      chrome.tabs.query({ url: 'https://single-yue.readboy.com/*' }, (tabs) => {
        if (chrome.runtime.lastError) {}
        (tabs || []).forEach(t => {
          if (!t.id) return;
          chrome.tabs.sendMessage(t.id, { type: 'CONFIG_UPDATED' }, () => {
            if (chrome.runtime.lastError) {}
          });
        });
      });
      sendResponse({ success: true });
    });
    return true;
  }

  // 把批改状态推送到局域网监控服务
  if (request.type === 'MONITOR_PUSH') {
    pushMonitor(request.state).then((ok) => {
      sendResponse({ success: ok });
    });
    return true;
  }

  if (request.type === 'MONITOR_IMAGE') {
    pushMonitorImage(request.image).then((ok) => {
      sendResponse({ success: ok });
    });
    return true;
  }

  // 防止后台标签页被内存节省程序回收
  if (request.type === 'KEEP_TAB_ALIVE') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId) {
      chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }

  // 测试API连接（由background代发，绕过popup的CORS限制）
  if (request.type === 'TEST_API') {
    testApiConnection(request.apiUrl, request.apiKey, request.model).then(result => {
      sendResponse(result);
    });
    return true;
  }

  // 探测可用模型
  if (request.type === 'GET_MODELS') {
    fetchModels(request.apiUrl, request.apiKey).then(result => {
      sendResponse(result);
    });
    return true;
  }

  // 检查更新
  if (request.type === 'CHECK_UPDATE') {
    checkUpdate(request.updateUrl || BUILTIN_UPDATE_URL).then(result => {
      sendResponse(result);
    });
    return true;
  }

  // 后台代抓图片：后台有 host 权限，不受页面 CORS 限制
  if (request.type === 'FETCH_IMAGE') {
    fetchImageAsBase64(request.url).then(result => {
      sendResponse(result);
    });
    return true;
  }
});

// 内置更新源（插件与监控共用）
const BUILTIN_UPDATE_URL = 'https://gh-proxy.com/https://raw.githubusercontent.com/zhaokelei/grade-assistant/main/update.json';

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { success: false, error: 'HTTP ' + res.status };

    const blob = await res.blob();
    if (!blob || !blob.size) return { success: false, error: '图片为空' };

    const buf = await blob.arrayBuffer();
    const mime = blob.type && blob.type.indexOf('image/') === 0 ? blob.type : 'image/png';
    return { success: true, dataUrl: 'data:' + mime + ';base64,' + bufferToBase64(buf), size: blob.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 版本号比较：a>b 返回 1，相等 0，a<b 返回 -1
function compareVersion(a, b) {
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

// 读取版本清单（update.json）
async function checkUpdate(updateUrl) {
  const current = chrome.runtime.getManifest().version;

  if (!updateUrl) {
    return { success: false, error: '未配置更新源地址', current: current };
  }

  try {
    const sep = updateUrl.indexOf('?') === -1 ? '?' : '&';
    const res = await fetch(updateUrl + sep + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      return { success: false, error: '更新源返回 ' + res.status, current: current };
    }

    const data = await res.json();
    const latest = String(data.version || '').replace(/^v/i, '');
    if (!latest) {
      return { success: false, error: '更新源缺少 version 字段', current: current };
    }

    const hasUpdate = compareVersion(latest, current) > 0;
    return {
      success: true,
      current: current,
      latest: latest,
      hasUpdate: hasUpdate,
      notes: data.notes || '',
      pluginUrl: data.plugin || '',
      monitorUrl: data.monitor || ''
    };
  } catch (error) {
    return { success: false, error: error.message, current: current };
  }
}

// 从对话接口地址推导模型列表地址
function modelsUrl(apiUrl) {
  const chat = normalizeApiUrl(apiUrl);
  const base = chat.replace(/\/chat\/completions$/i, '');
  return base + '/models';
}

// 探测模型列表（OpenAI 兼容 /v1/models）
async function fetchModels(apiUrl, apiKey) {
  const url = modelsUrl(apiUrl);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const txt = await response.text();
      return {
        success: false,
        error: `${response.status} - ${String(txt).slice(0, 160)}`,
        url: url
      };
    }

    const data = await response.json();
    let list = [];

    if (Array.isArray(data.data)) {
      list = data.data.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model)));
    } else if (Array.isArray(data.models)) {
      list = data.models.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model)));
    } else if (Array.isArray(data)) {
      list = data.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model)));
    }

    list = list.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim());
    list = Array.from(new Set(list)).sort((a, b) => a.localeCompare(b));

    return { success: true, models: list, url: url, total: list.length };
  } catch (error) {
    return { success: false, error: error.message, url: url };
  }
}

// 测试API连接
async function testApiConnection(apiUrl, apiKey, model) {
  try {
    const url = normalizeApiUrl(apiUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: '你好，请回复"连接成功"' }],
        max_tokens: 20
      })
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: data.choices?.[0]?.message?.content || '(无内容)',
        url: url
      };
    } else {
      const errorText = await response.text();
      return {
        success: false,
        error: `${response.status} - ${errorText.slice(0, 200)}`,
        url: url
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url: normalizeApiUrl(apiUrl)
    };
  }
}

// ============ 插件自动重载（配合监控程序的全自动更新） ============

function ensureReloadAlarm() {
  try {
    chrome.alarms.get('pluginAutoReload', (a) => {
      if (!a) chrome.alarms.create('pluginAutoReload', { periodInMinutes: 1 });
    });
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(ensureReloadAlarm);
chrome.runtime.onStartup.addListener(ensureReloadAlarm);
ensureReloadAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'pluginAutoReload') return;
  checkPluginReload();
});

// 监控程序替换完插件文件后会打上 needReload 标记，这里发现就自行重载
async function checkPluginReload() {
  try {
    const config = await getConfig();
    if (!config.monitorEnabled || !config.monitorUrl) return;

    const base = String(config.monitorUrl).replace(/\/+$/, '');
    const res = await fetch(base + '/api/plugin-version', { cache: 'no-store' });
    if (!res.ok) return;

    const data = await res.json();
    if (!data || !data.needReload) return;

    // 先清标记，再重载，避免重载后反复触发
    try {
      await fetch(base + '/api/plugin-reloaded', { method: 'POST' });
    } catch (e) {}

    chrome.runtime.reload();
  } catch (e) {
    // 监控没开或网络异常时静默跳过
  }
}
