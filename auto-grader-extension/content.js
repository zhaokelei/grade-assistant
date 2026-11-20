// content.js - 注入页面的内容脚本，负责页面交互

(function() {
  'use strict';

  let isAutoGrading = false;
  let isPaused = false;
  let gradedCount = 0;
  let currentConfig = null;
  let gradeHistory = []; // 评分历史记录（内存副本，与本地存储同步）
  let lastScore = null; // 上一份的分数

  // 历史记录持久化配置
  const HISTORY_KEY = 'gradeHistory';
  const HISTORY_LIMIT = 1000; // 最多保留的条数

  // ============ 后台运行支持 ============
  // 后台标签页的 setTimeout 会被 Chrome 节流到 1 秒甚至 1 分钟，
  // 这里用 Web Worker 计时器规避节流，再用保活音频防止标签页被冻结。
  let timerWorker = null;
  let timerSeq = 0;
  const timerCallbacks = {};

  function createTimerWorker() {
    try {
      return new Worker(chrome.runtime.getURL('timer-worker.js'));
    } catch (e) {}
    // 页面 CSP 阻止扩展资源时，退回 Blob 方式
    try {
      const code = 'self.onmessage=function(e){setTimeout(function(){self.postMessage({id:e.data.id})},e.data.ms)};';
      return new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    } catch (e) {}
    return null;
  }

  function initTimerWorker() {
    if (timerWorker) return;
    timerWorker = createTimerWorker();
    if (!timerWorker) return;
    timerWorker.onmessage = (e) => {
      const cb = timerCallbacks[e.data.id];
      if (cb) {
        delete timerCallbacks[e.data.id];
        cb();
      }
    };
    timerWorker.onerror = () => { timerWorker = null; };
  }

  // 检测扩展上下文是否有效（扩展被刷新/更新后旧页面会失效）
  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // 安全发送消息：上下文失效时返回错误而不是抛异常
  function safeSendMessage(message) {
    return new Promise((resolve) => {
      if (!isContextValid()) {
        resolve({ success: false, error: 'EXTENSION_CONTEXT_INVALIDATED', contextInvalid: true });
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('context invalidated')) {
              resolve({ success: false, error: 'EXTENSION_CONTEXT_INVALIDATED', contextInvalid: true });
            } else {
              resolve({ success: false, error: msg });
            }
            return;
          }
          resolve(response || { success: false, error: '无响应' });
        });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg.includes('context invalidated')) {
          resolve({ success: false, error: 'EXTENSION_CONTEXT_INVALIDATED', contextInvalid: true });
        } else {
          resolve({ success: false, error: msg });
        }
      }
    });
  }

  // 从本地存储加载历史记录（扩展重新加载后依然保留）
  function loadHistoryFromStorage() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.get([HISTORY_KEY], (res) => {
        if (chrome.runtime.lastError) return;
        const saved = res && res[HISTORY_KEY];
        if (Array.isArray(saved)) {
          gradeHistory = saved;
        }
      });
    } catch (e) {}
  }

  // 把历史记录写入本地存储
  function persistHistory() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ [HISTORY_KEY]: gradeHistory }, () => {
        if (!chrome.runtime.lastError) return;
        // 存储超限时逐步缩减条数后重试
        if (gradeHistory.length > 100) {
          gradeHistory = gradeHistory.slice(0, Math.floor(gradeHistory.length / 2));
          persistHistory();
        }
      });
    } catch (e) {}
  }

  // 监听存储变化（例如在弹窗里清空历史记录时同步内存）
  function watchHistoryChanges() {
    if (!isContextValid()) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[HISTORY_KEY]) return;
        const newVal = changes[HISTORY_KEY].newValue;
        gradeHistory = Array.isArray(newVal) ? newVal : [];
      });
    } catch (e) {}
  }

  // 不受后台节流影响的等待
  function sleep(ms) {
    return new Promise(resolve => {
      if (!timerWorker) {
        setTimeout(resolve, ms);
        return;
      }
      const id = ++timerSeq;
      timerCallbacks[id] = resolve;
      timerWorker.postMessage({ id: id, ms: ms });
    });
  }

  // 保活音频：播放极低增益的音频，让页面不被判定为空闲，
  // 从而避免进入 intensive throttling 或标签页冻结。
  let keepAliveCtx = null;
  let keepAliveTimer = null;

  function startKeepAlive() {
    if (keepAliveCtx) {
      if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      keepAliveCtx = new AudioCtx();
      const osc = keepAliveCtx.createOscillator();
      const gain = keepAliveCtx.createGain();
      gain.gain.value = 0.0001;
      osc.frequency.value = 4000;
      osc.connect(gain);
      gain.connect(keepAliveCtx.destination);
      osc.start();
      if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
      keepAliveTimer = setInterval(() => {
        if (keepAliveCtx && keepAliveCtx.state === 'suspended') {
          keepAliveCtx.resume().catch(() => {});
        }
      }, 3000);
    } catch (e) {
      keepAliveCtx = null;
    }
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (keepAliveCtx) {
      try { keepAliveCtx.close(); } catch (e) {}
      keepAliveCtx = null;
    }
  }

  // 告诉后台不要回收这个标签页
  function requestKeepTab() {
    safeSendMessage({ type: 'KEEP_TAB_ALIVE' });
  }

  // 初始化
  function init() {
    initTimerWorker();
    loadConfig();
    loadHistoryFromStorage();
    watchHistoryChanges();
    createFloatingPanel();
    startContextWatch();
    watchProgress();
    
    // 监听来自popup的消息
    if (!isContextValid()) return;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'START_AUTO_GRADING') {
        const err = validateGradingConfig();
        if (err) {
          updatePanelStatus('缺少题目或标准答案');
          addLog(`${err}`, 'error');
          scheduleMonitorPush();
          sendResponse({ success: false, error: err });
          return true;
        }
        startAutoGrading();
        sendResponse({ success: true });
      }
      if (request.type === 'STOP_AUTO_GRADING') {
        stopAutoGrading();
        sendResponse({ success: true });
      }
      if (request.type === 'PAUSE_AUTO_GRADING') {
        isPaused = true;
        updatePanelStatus();
        sendResponse({ success: true });
      }
      if (request.type === 'RESUME_AUTO_GRADING') {
        isPaused = false;
        updatePanelStatus();
        sendResponse({ success: true });
      }
      if (request.type === 'GRADE_CURRENT') {
        gradeCurrentPaper().then(result => {
          sendResponse(result);
        });
        return true;
      }
      if (request.type === 'CONFIG_UPDATED') {
        loadConfig();
        sendResponse({ success: true });
      }
      if (request.type === 'GET_HISTORY') {
        sendResponse({ history: gradeHistory });
      }
      if (request.type === 'CLEAR_HISTORY') {
        gradeHistory = [];
        sendResponse({ success: true });
      }
      if (request.type === 'STREAM_CHUNK') {
        appendStreamChunk(request.delta || '');
      }
    });
  }

  // 加载配置
  async function loadConfig() {
    const config = await safeSendMessage({ type: 'GET_CONFIG' });
    if (config && !config.contextInvalid && !config.error) {
      currentConfig = config;
    }
    updatePanelInfo();
  }

  // 校验阅卷三要素：题目、标准答案必须有，评分标准可选
  function validateGradingConfig() {
    if (!currentConfig) return '配置尚未加载，请按 F5 刷新页面后重试';
    const missing = [];
    if (!currentConfig.question) missing.push('题目');
    if (!currentConfig.standardAnswer) missing.push('标准答案');
    if (missing.length === 0) return '';
    return `请先在扩展面板「题目与答案」中填写：${missing.join('、')}`;
  }

  // 监听扩展上下文是否失效（扩展被刷新后旧页面会失效）
  let contextLostNotified = false;
  function startContextWatch() {
    setInterval(() => {
      if (contextLostNotified) return;
      if (!isContextValid()) {
        contextLostNotified = true;
        isAutoGrading = false;
        isPaused = false;
        try {
          updatePanelStatus('扩展已更新，请刷新页面 (F5)');
          addLog('扩展已更新或重新加载，当前页面连接已失效。请按 F5 刷新页面后重新开始', 'error');
        } catch (e) {}
      }
    }, 3000);
  }

  // 空白卷判定的墨迹占比阈值（低于此比例直接判 0 分，不调用 AI）
  const BLANK_DARK_RATIO = 0.002; // 0.2%

  // 统计图片墨迹占比：返回 { blank, ratio }，ratio 为深色像素占比
  function analyzeBlankImage(ctx, width, height) {
    try {
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      let darkPixelCount = 0;

      // 抽样检测（每 4 个像素检测 1 个，提高速度）
      const step = 4;

      for (let i = 0; i < data.length; i += 4 * step) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // 亮度低于 200 视为"墨迹/文字"像素（不是纯白或浅灰）
        const brightness = r * 0.299 + g * 0.587 + b * 0.114;
        if (brightness < 200) darkPixelCount++;
      }

      const sampledPixels = Math.max(1, Math.floor(data.length / (4 * step)));
      const ratio = darkPixelCount / sampledPixels;

      return { ratio: ratio, blank: ratio < BLANK_DARK_RATIO };
    } catch (e) {
      // 检测失败就认为不是空白（保守处理）
      return { ratio: null, blank: false, failed: true };
    }
  }

  // 获取学生答案图片，返回 { image, isBlank, width, height, natural }
  async function getStudentAnswerImage() {
    const img = document.querySelector('.question-block-img img, .img-container img, [id^="paperImg_"]');
    if (!img) throw new Error('未找到学生答案图片');

    const imgSrc = img.src;
    const MAX_EDGE = 2000; // 长边限幅：只在超大截图时才缩，避免缩得太多影响识别

    // 1) 优先直接抓原图转 base64：同源 fetch 带登录态，且不受 canvas 跨域污染
    let sourceUrl = imgSrc;
    try {
      const res = await fetch(imgSrc, { credentials: 'include' });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size > 0) {
          sourceUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(new Error('读取图片失败'));
            fr.readAsDataURL(blob);
          });
        }
      }
    } catch (e) {
      // 抓取失败就继续用原始地址
    }

    // 2) 画到 canvas：限幅、空白检测、重新编码为 JPEG
    return new Promise((resolve) => {
      const tempImg = new Image();

      tempImg.onload = function () {
        const nw = tempImg.naturalWidth || 0;
        const nh = tempImg.naturalHeight || 0;
        let w = nw;
        let h = nh;

        if (nw > 0 && nh > 0 && Math.max(nw, nh) > MAX_EDGE) {
          const k = MAX_EDGE / Math.max(nw, nh);
          w = Math.max(1, Math.round(nw * k));
          h = Math.max(1, Math.round(nh * k));
        }

        const canvas = document.createElement('canvas');
        canvas.width = w || 1;
        canvas.height = h || 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);

        const blankInfo = analyzeBlankImage(ctx, canvas.width, canvas.height);

        let out = sourceUrl;
        try {
          out = canvas.toDataURL('image/jpeg', 0.9);
        } catch (e) {
          // 画布被污染时退回抓到的 dataURL 或原始地址
        }
        if (!out || out.length < 64) out = sourceUrl;

        resolve({
          image: out,
          isBlank: blankInfo.blank,
          blackRatio: blankInfo.ratio,
          blankCheckFailed: !!blankInfo.failed,
          width: canvas.width,
          height: canvas.height,
          natural: nw + 'x' + nh
        });
      };

      tempImg.onerror = function () {
        resolve({ image: sourceUrl, isBlank: false, width: 0, height: 0, natural: '加载失败' });
      };

      tempImg.src = sourceUrl;
    });
  }

  // 获取题目信息
  function getQuestionInfo() {
    const questionInfo = {};
    
    const questionNumEl = document.querySelector('.num-pad + .question-num, [class*="二."]');
    if (questionNumEl) {
      const rawNum = questionNumEl.textContent.trim();
      // 只接受合理题号，避免把页码、缩放等文本（如 -18）当题号
      if (/^[一二三四五六七八九十]+[.、]\d+/.test(rawNum) || /^\d{1,3}(?:[.、]\d+)?$/.test(rawNum)) {
        questionInfo.questionNumber = rawNum;
      }
    } else {
      const panelText = document.querySelector('.mark-panel, .score-panel, [class*="mark"]')?.textContent || '';
      const match = panelText.match(/[一二三四五六七八九十]+\.\d+/);
      if (match) {
        questionInfo.questionNumber = match[0];
      }
    }
    
    const scoreMatch = document.body.textContent.match(/\((\d+)分\)/);
    if (scoreMatch) {
      questionInfo.totalScore = parseInt(scoreMatch[1]);
    }
    
    return questionInfo;
  }

  // 点击分数按钮
  function clickScoreButton(score) {
    return new Promise((resolve, reject) => {
      const buttons = document.querySelectorAll('.num-pad__button');
      
      if (buttons.length === 0) {
        reject(new Error('未找到打分按钮'));
        return;
      }
      
      let targetBtn = null;
      for (const btn of buttons) {
        if (btn.textContent.trim() === String(score)) {
          targetBtn = btn;
          break;
        }
      }
      
      if (!targetBtn) {
        if (score === 0) {
          targetBtn = document.querySelector('.btn-zero, .btn-score.btn-zero');
        } else if (currentConfig && score === parseInt(currentConfig.totalScore)) {
          targetBtn = document.querySelector('.btn-full, .btn-score.btn-full');
        }
      }
      
      if (targetBtn) {
        targetBtn.click();
        sleep(300).then(resolve);
      } else {
        reject(new Error(`未找到分数为 ${score} 的按钮`));
      }
    });
  }

  // 提交当前评分
  function submitScore() {
    return new Promise((resolve, reject) => {
      const submitBtn = document.querySelector('.submit-btn, button.submit');
      
      if (submitBtn && !submitBtn.disabled) {
        submitBtn.click();
        sleep(1000).then(resolve);
      } else {
        resolve();
      }
    });
  }

  // 进入下一份试卷，返回是否点到了「继续阅卷」
  async function goToNextPaper() {
    await sleep(1000);

    const continueBtn = Array.from(document.querySelectorAll('button')).find(
      b => b.textContent.includes('继续阅卷') || b.textContent.includes('下一份')
    );

    if (continueBtn && !continueBtn.disabled) {
      continueBtn.click();
      await sleep(2000);
      return true;
    }
    return false;
  }

  // 当前试卷图片的标识，用于判断是否真的切换到了下一份
  function getCurrentPaperKey() {
    const img = document.querySelector('.question-block-img img, .img-container img, [id^="paperImg_"]');
    return img && img.src ? img.src : '';
  }

  // 页面任务是否还有未批改的试卷
  function hasRemainingPapers() {
    const p = progressInfo;
    if (p && p.reviewed !== null && p.total !== null && p.total > 0) {
      return p.reviewed < p.total;
    }
    return true; // 读不到任务进度时，不主动判定结束
  }

  // 结束自动阅卷
  function finishAutoGrading(reason) {
    isAutoGrading = false;
    isPaused = false;
    stopKeepAlive();
    updatePanelStatus('阅卷已完成');
    updatePanelInfo();
    addLog(reason, 'success');
    addLog(`本次共批改 ${gradedCount} 份试卷`, 'info');
    addLog('━━━━━━━━━━━━━━━━━━━━', 'divider');
  }

  // 批改当前试卷
  async function gradeCurrentPaper() {
    const startTime = new Date();
    let gradeRecord = {
      id: Date.now(),
      time: startTime.toLocaleTimeString(),
      score: 0,
      thinking: '',
      reason: '',
      overallLevel: '',
      answerStyle: '',
      points: [],
      strengths: [],
      weaknesses: [],
      status: 'pending'
    };

    try {
      updatePanelStatus('正在识别答案图片...');
      addLog('正在提取学生答案图片...', 'info');

      // 打印本次评分依据的题目，方便核对录入是否正确
      const qText = (currentConfig && currentConfig.question) || '';
      if (qText) {
        const brief = qText.length > 50 ? qText.slice(0, 50) + '…' : qText;
        addLog(`评分依据题目：${brief}`, 'info');
      }
      
      const shot = await getStudentAnswerImage();
      const studentImage = shot.image;
      const isBlank = shot.isBlank;
      const questionInfo = getQuestionInfo();
      gradeRecord.questionNumber = questionInfo.questionNumber || '未知';

      // 面板满分与页面上显示的分数不一致时提醒（避免按错的满分档位评分）
      if (questionInfo.totalScore && currentConfig && parseInt(currentConfig.totalScore) !== questionInfo.totalScore) {
        addLog(`提示：面板满分 ${currentConfig.totalScore} 分，页面显示 ${questionInfo.totalScore} 分，本次以面板设置为准`, 'miss');
      }

      if (shot.width) {
        const pctText = shot.blackRatio === null || shot.blackRatio === undefined
          ? '未知'
          : (shot.blackRatio * 100).toFixed(2) + '%';
        addLog(`答案图片 ${shot.width}×${shot.height}（原始 ${shot.natural}），墨迹占比 ${pctText}`, 'info');
      }

      // 同步当前试卷图片到手机监控
      uploadPaperImage(studentImage);

      // 空白卷：墨迹占比低于阈值，直接 0 分，不调用 AI
      if (isBlank) {
        const pct = shot.blackRatio === null || shot.blackRatio === undefined
          ? '—'
          : (shot.blackRatio * 100).toFixed(2) + '%';
        addLog(`墨迹占比 ${pct}，低于 ${(BLANK_DARK_RATIO * 100).toFixed(1)}% 阈值，判定空白卷，直接给 0 分`, 'blank');

        gradeRecord.score = 0;
        gradeRecord.thinking = '学生答案区域为空白，没有作答内容。';
        gradeRecord.reason = `空白卷：图片墨迹占比 ${pct}，未见有效作答，得 0 分。`;
        gradeRecord.status = 'success';
        gradeRecord.isBlank = true;

        updatePanelStatus('空白卷：0分');

        addLog('点击 0 分按钮...', 'info');
        await clickScoreButton(0);
        await sleep(500);
        await submitScore();

        lastScore = 0;
        gradedCount++;
        updatePanelInfo();
        updatePanelStatus('空白卷已打0分');
        addLog('分数已提交', 'success');
        addLog('━━━━━━━━━━━━━━━━━━━━', 'divider');

        addHistoryRecord(gradeRecord);

        return {
          success: true,
          score: 0,
          thinking: gradeRecord.thinking,
          reason: gradeRecord.reason,
          overallLevel: '空白卷',
          answerStyle: '空白',
          points: [],
          strengths: [],
          weaknesses: [],
          isBlank: true
        };
      }

      if (shot.blankCheckFailed) {
        addLog('墨迹检测失败，本次交由 AI 判断是否空白', 'info');
      }
      
      resetStreamLog();
      addLog('正在调用AI模型分析答案（实时输出如下）...', 'info');
      updatePanelStatus('AI正在分析答案...');
      
      const result = await safeSendMessage({
        type: 'GRADE_PAPER',
        studentAnswerImage: studentImage,
        questionInfo: questionInfo
      });
      
      if (result.contextInvalid) {
        gradeRecord.status = 'error';
        gradeRecord.error = '扩展已更新，请刷新页面';
        addLog(`扩展已更新，当前页面连接已失效。请按 F5 刷新页面后重新开始`, 'error');
        updatePanelStatus('请刷新页面 (F5)');
        return { success: false, error: 'EXTENSION_CONTEXT_INVALIDATED', contextInvalid: true };
      }
      
      if (!result.success) {
        gradeRecord.status = 'error';
        gradeRecord.error = result.error;
        addLog(`评分失败: ${result.error}`, 'error');
        updatePanelStatus(`评分失败`);
        addHistoryRecord(gradeRecord);
        return { success: false, error: result.error, id: gradeRecord.id };
      }
      
      gradeRecord.score = result.score;
      gradeRecord.thinking = result.thinking;
      gradeRecord.reason = result.reason;
      gradeRecord.overallLevel = result.overallLevel || '';
      gradeRecord.answerStyle = result.answerStyle || '';
      gradeRecord.points = result.points || [];
      gradeRecord.strengths = result.strengths || [];
      gradeRecord.weaknesses = result.weaknesses || [];
      gradeRecord.status = 'success';
      
      // 添加详细日志
      resetStreamLog();
      addLog(`AI评分完成：${result.score}分${result.overallLevel ? '（' + result.overallLevel + '）' : ''}`, 'success');
      gradeRecord.degraded = !!result.degraded;

      if (result.score === 0) {
        const why = (result.reason || '').slice(0, 60);
        addLog(`判定 0 分${why ? '，依据：' + why : '，未给出理由'}`, 'miss');
      }

      if (result.degraded) {
        addLog('提示：模型输出为降级解析，只取到分数、缺少明细，建议核对本次结果', 'miss');
      }
      
      if (result.answerStyle) {
        addLog(`作答形式：${result.answerStyle}`, 'info');
      }
      
      if (result.thinking) {
        addLog(`思考过程：${result.thinking}`, 'thinking');
      }
      
      // 逐要点核对明细
      if (result.points && result.points.length > 0) {
        addLog(`要点核对（共${result.points.length}个要点）：`, 'point');
        result.points.forEach((p, i) => {
          const earned = typeof p.earned === 'number' ? p.earned : 0;
          const full = typeof p.full === 'number' ? p.full : 0;
          const mark = earned >= full && full > 0 ? '完成' : (earned > 0 ? '部分' : '未答');
          addLog(`   ${mark} · ${i + 1}. ${p.point} → ${p.status}（${earned}/${full}分）`, earned > 0 ? 'point-detail' : 'miss-detail');
          if (p.evidence && p.evidence !== '无') {
            addLog(`      依据：${p.evidence}`, 'point-detail');
          }
        });
      }
      
      if (result.strengths && result.strengths.length > 0) {
        addLog(`亮点：`, 'point');
        result.strengths.forEach((p, i) => {
          addLog(`   ${i + 1}. ${p}`, 'point-detail');
        });
      }
      
      if (result.weaknesses && result.weaknesses.length > 0) {
        addLog(`不足：`, 'miss');
        result.weaknesses.forEach((p, i) => {
          addLog(`   ${i + 1}. ${p}`, 'miss-detail');
        });
      }
      
      if (result.reason) {
        addLog(`评分理由：${result.reason}`, 'reason');
      }
      
      updatePanelStatus(`AI评分: ${result.score}分，正在点击打分按钮...`);
      addLog(`点击 ${result.score} 分按钮...`, 'info');
      
      await clickScoreButton(result.score);
      
      await sleep(500);
      
      await submitScore();
      
      // 保存上一份分数
      lastScore = result.score;
      
      gradedCount++;
      updatePanelInfo();
      updatePanelStatus(`已完成打分：${result.score}分`);
      addLog(`分数已提交`, 'success');
      addLog(`━━━━━━━━━━━━━━━━━━━━`, 'divider');
      
      addHistoryRecord(gradeRecord);
      
      return { 
        success: true, 
        score: result.score,
        thinking: result.thinking,
        reason: result.reason,
        overallLevel: result.overallLevel,
        answerStyle: result.answerStyle,
        points: result.points,
        strengths: result.strengths,
        weaknesses: result.weaknesses
      };
    } catch (error) {
      gradeRecord.status = 'error';
      gradeRecord.error = error.message;
      resetStreamLog();
      addLog(`出错: ${error.message}`, 'error');
      updatePanelStatus(`出错`);
      addHistoryRecord(gradeRecord);
      return { success: false, error: error.message, id: gradeRecord.id };
    }
  }

  // 开始自动阅卷
  async function startAutoGrading() {
    if (isAutoGrading) return;

    // 兜底校验：缺少题目或标准答案不启动
    const err = validateGradingConfig();
    if (err) {
      updatePanelStatus('缺少题目或标准答案');
      addLog(`${err}`, 'error');
      scheduleMonitorPush();
      return;
    }

    isAutoGrading = true;
    isPaused = false;
    gradedCount = 0;
    clearLog();
    initTimerWorker();
    startKeepAlive();
    requestKeepTab();
    updatePanelStatus('开始自动阅卷...');
    updatePanelInfo();
    addLog('开始自动阅卷模式', 'info');
    addLog('已启用后台运行保护，可切换到其他标签页', 'info');
    addLog(`━━━━━━━━━━━━━━━━━━━━`, 'divider');
    
    await autoGradeLoop();
  }

  // 自动阅卷循环
  async function autoGradeLoop() {
    let noChangeCount = 0;   // 连续未切换到新卷的次数
    let hardFailCount = 0;   // 连续"解析不出分数"的次数
    let blankStreak = 0;     // 连续被判空白卷的份数

    while (isAutoGrading) {
      if (isPaused) {
        updatePanelStatus('已暂停');
        await sleep(1000);
        continue;
      }

      // 每轮开始前刷新页面任务进度，判断是否已全部批改完
      updateProgressInfo();
      if (!hasRemainingPapers()) {
        finishAutoGrading('网页显示任务已全部批改完毕，自动停止');
        return;
      }

      const paperKey = getCurrentPaperKey();
      let result = null;
      let retryCount = 0;

      // 失败后固定等 10 秒再重试，直到成功，不设上限、不终止流程
      while (isAutoGrading) {
        if (isPaused) {
          updatePanelStatus('已暂停');
          await sleep(1000);
          continue;
        }

        result = await gradeCurrentPaper();

        // 扩展上下文失效（扩展被刷新/更新），立即停止并提示
        if (result.contextInvalid) {
          isAutoGrading = false;
          isPaused = false;
          stopKeepAlive();
          updatePanelStatus('请刷新页面 (F5)');
          addLog('自动阅卷已停止', 'info');
          addLog(`本次共批改 ${gradedCount} 份试卷`, 'info');
          return;
        }

        if (result.success) {
          // 空白卷安全网：连续多份都被判空白，说明墨迹检测可能异常
          if (result.isBlank) {
            blankStreak++;
            if (blankStreak >= 5) {
              finishAutoGrading('连续 ' + blankStreak + ' 份被判为空白卷，墨迹检测可能异常，已停止，请人工核对');
              return;
            }
          } else {
            blankStreak = 0;
          }
          break;
        }

        // 失败的记录不留在历史里，避免堆积
        if (result.id) removeHistoryRecords([result.id]);

        // 配置或接口类错误：重试没有意义，直接停止并提示
        const errText = String(result.error || '');
        if (/请先在扩展面板|API 4\d\d/.test(errText)) {
          finishAutoGrading('配置或接口异常，已自动停止：' + errText.slice(0, 90));
          return;
        }
        if (/无法解析出分数|空响应/.test(errText)) {
          hardFailCount++;
          if (hardFailCount >= 3) {
            finishAutoGrading('连续 3 次无法从模型输出解析出分数，已停止。请确认所选模型支持图片输入');
            return;
          }
        } else {
          hardFailCount = 0;
        }

        retryCount++;
        updatePanelStatus(`请求失败，10秒后重试（已重试 ${retryCount} 次）`);
        addLog(`第 ${retryCount} 次请求失败，10 秒后重试...`, 'error');
        await sleep(10000);
      }

      if (!isAutoGrading) break;

      updatePanelStatus('正在进入下一份试卷...');
      addLog('正在进入下一份试卷...', 'info');
      const clicked = await goToNextPaper();
      await sleep(1500);

      // 判断是否真的换了一份试卷
      const newKey = getCurrentPaperKey();
      if (paperKey && newKey) {
        if (newKey === paperKey) {
          noChangeCount++;
          if (noChangeCount >= 2) {
            finishAutoGrading('没有新的试卷可批改，自动停止');
            return;
          }
        } else {
          noChangeCount = 0;
        }
      } else if (!clicked) {
        finishAutoGrading('没有新的试卷可批改，自动停止');
        return;
      }

      // 显示上一份分数提示
      if (lastScore !== null) {
        addLog(`上一份得分：${lastScore}分`, 'last-score');
      }
    }

    updatePanelStatus('自动阅卷已停止');
    addLog('自动阅卷已停止', 'info');
    addLog(`本次共批改 ${gradedCount} 份试卷`, 'info');
  }

  // 停止自动阅卷
  function stopAutoGrading() {
    isAutoGrading = false;
    isPaused = false;
    stopKeepAlive();
    updatePanelStatus('已停止');
    updatePanelInfo();
  }

  // 添加历史记录（同时写入本地存储，扩展重载后不丢失）
  function addHistoryRecord(record) {
    gradeHistory.unshift(record);
    if (gradeHistory.length > HISTORY_LIMIT) {
      gradeHistory = gradeHistory.slice(0, HISTORY_LIMIT);
    }
    persistHistory();
  }

  // 重试成功后，清掉重试期间产生的失败记录
  function removeHistoryRecords(ids) {
    if (!ids.length) return;
    gradeHistory = gradeHistory.filter(r => !ids.includes(r.id));
    persistHistory();
  }

  // ============ 网页任务进度读取 ============
  let progressInfo = { reviewed: null, total: null, percent: null };

  // 从页面文字里解析「我已阅/任务量」「题块总进度」
  function readProgressFromPage() {
    try {
      const keywords = ['我已阅', '题块总进度'];
      let target = null;
      for (const kw of keywords) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue && node.nodeValue.indexOf(kw) >= 0) {
            target = node.parentElement;
            break;
          }
        }
        if (target) break;
      }
      if (!target) return null;

      // 向上多取两层，拼接文本，避免数字和标题被拆在不同节点
      let ctx = target.textContent || '';
      if (target.parentElement) ctx += ' ' + (target.parentElement.textContent || '');
      if (target.parentElement && target.parentElement.parentElement) {
        ctx += ' ' + (target.parentElement.parentElement.textContent || '');
      }

      const m = ctx.match(/(\d+)\s*\/\s*(\d+)\s*份?/);
      const p = ctx.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) {
        return {
          reviewed: parseInt(m[1]),
          total: parseInt(m[2]),
          percent: p ? parseFloat(p[1]) : null
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function updateProgressInfo() {
    const info = readProgressFromPage();
    const item = document.getElementById('agpProgressItem');
    const valEl = document.getElementById('agpProgress');
    if (!info) {
      if (item) item.style.display = 'none';
      return;
    }
    const changed = info.reviewed !== progressInfo.reviewed || info.total !== progressInfo.total;
    progressInfo = info;
    if (item) item.style.display = '';
    if (valEl) {
      const pct = info.percent !== null ? info.percent : (info.total ? Math.round(info.reviewed / info.total * 10000) / 100 : null);
      valEl.textContent = info.reviewed + '/' + info.total + (pct !== null ? '（' + pct + '%）' : '');
    }
    if (changed) scheduleMonitorPush();
  }

  // 每 5 秒刷新一次（走 Worker 计时器，后台标签页也有效）
  async function watchProgress() {
    while (true) {
      try { updateProgressInfo(); } catch (e) {}
      await sleep(5000);
    }
  }

  // ============ 局域网监控推送 ============
  let monitorLogs = [];      // 供手机端展示的日志副本
  let monitorPending = false;
  let monitorRunning = false;

  function buildMonitorState() {
    const statusEl = document.getElementById('agpStatus');
    return {
      status: statusEl ? statusEl.textContent : '未知',
      gradedCount: gradedCount,
      lastScore: lastScore,
      isAutoGrading: isAutoGrading,
      isPaused: isPaused,
      totalScore: (currentConfig && currentConfig.totalScore) || 6,
      question: (currentConfig && currentConfig.question) || '',
      standardAnswer: (currentConfig && currentConfig.standardAnswer) || '',
      scoringCriteria: (currentConfig && currentConfig.scoringCriteria) || '',
      progress: progressInfo.reviewed !== null ? progressInfo : null,
      streamText: streamBuffer ? extractStreamText(streamBuffer) : '',
      logs: monitorLogs.slice(0, 30),
      history: gradeHistory.slice(0, 20).map(item => ({
        score: item.score,
        time: item.time,
        questionNumber: item.questionNumber || '',
        overallLevel: item.overallLevel || '',
        status: item.status
      }))
    };
  }

  async function pushMonitorState() {
    if (!currentConfig || !currentConfig.monitorEnabled) return;
    await safeSendMessage({ type: 'MONITOR_PUSH', state: buildMonitorState() });
  }

  // 把当前试卷图片推送到手机监控（不阻塞批改流程）
  // 上传试卷图片到手机监控（失败时提示，最多提示两次避免刷屏）
  let paperImgFailCount = 0;
  function uploadPaperImage(dataUrl) {
    if (!currentConfig || !currentConfig.monitorEnabled) return;

    if (!dataUrl || !/^data:image/.test(dataUrl)) {
      if (paperImgFailCount < 2) {
        paperImgFailCount++;
        addLog('试卷图片不是 base64，手机端无法显示（图片可能跨域受限）', 'error');
      }
      return;
    }

    const p = safeSendMessage({ type: 'MONITOR_IMAGE', image: dataUrl });
    if (p && p.then) {
      p.then((res) => {
        if (paperImgFailCount < 2 && (!res || res.success === false)) {
          paperImgFailCount++;
          addLog('试卷图片同步失败，请确认监控程序已启动、面板里已开启手机查看', 'error');
        }
      }).catch(() => {});
    } else if (p && p.catch) {
      p.catch(() => {});
    }
  }

  function scheduleMonitorPush() {
    if (monitorPending || monitorRunning) return;
    monitorPending = true;
    sleep(400).then(() => {
      monitorPending = false;
      if (monitorRunning) return;
      monitorRunning = true;
      pushMonitorState().finally(() => {
        monitorRunning = false;
        if (monitorPending) scheduleMonitorPush();
      });
    });
  }

  // 添加日志
  function addLog(message, type = 'info') {
    // 维护推送用的日志副本
    monitorLogs.unshift({ time: new Date().toLocaleTimeString(), message, type });
    if (monitorLogs.length > 40) monitorLogs.length = 40;
    scheduleMonitorPush();

    const logContainer = document.getElementById('agpLogContainer');
    if (!logContainer) return;
    
    const logItem = document.createElement('div');
    logItem.className = `agp-log-item agp-log-${type}`;
    logItem.innerHTML = `<span class="agp-log-time">${new Date().toLocaleTimeString()}</span> ${message}`;
    logContainer.insertBefore(logItem, logContainer.firstChild);
    
    // 限制日志数量
    const items = logContainer.querySelectorAll('.agp-log-item');
    if (items.length > 100) {
      for (let i = 100; i < items.length; i++) {
        items[i].remove();
      }
    }
  }

  // 清空日志
  function clearLog() {
    const logContainer = document.getElementById('agpLogContainer');
    if (logContainer) {
      logContainer.innerHTML = '';
    }
    streamBuffer = '';
    monitorLogs = [];
    scheduleMonitorPush();
  }

  // ============ 流式输出显示 ============
  let streamBuffer = '';

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 从累积的 JSON 文本中提取可读内容（优先 thinking 字段）
  function extractStreamText(buf) {
    let s = buf;
    const idx = s.indexOf('"thinking"');
    if (idx >= 0) {
      const rest = s.slice(idx + 10);
      const colon = rest.indexOf(':');
      if (colon >= 0) s = rest.slice(colon + 1);
    }
    s = s.replace(/^\s*"/, '');
    s = s.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '  ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    // 去掉尾部尚未闭合的 JSON 残片
    s = s.replace(/["},\]]\s*$/g, '');
    if (s.length > 500) s = '…' + s.slice(-500);
    return s;
  }

  // 清掉流式临时日志
  function resetStreamLog() {
    streamBuffer = '';
    const el = document.getElementById('agpStreamItem');
    if (el) el.remove();
  }

  // 追加流式内容并实时刷新
  function appendStreamChunk(delta) {
    streamBuffer += delta;
    const logContainer = document.getElementById('agpLogContainer');
    if (!logContainer) return;
    let item = document.getElementById('agpStreamItem');
    if (!item) {
      item = document.createElement('div');
      item.id = 'agpStreamItem';
      item.className = 'agp-log-item agp-log-stream';
    }
    item.innerHTML = `<span class="agp-log-time">${new Date().toLocaleTimeString()}</span> <span class="agp-stream-text">${escapeHtml(extractStreamText(streamBuffer))}</span>`;
    // 始终置顶，保证最新内容可见
    logContainer.insertBefore(item, logContainer.firstChild);
    scheduleMonitorPush();
  }

  // ============ 面板图标（点阵线条 SVG，注入页面内联使用） ============
  const AGP_ICON = {
    logo: 'M6 13.2l4.3 4.3L18 7.8',
    list: 'M5.4 7.4h13.2M5.4 12h13.2M5.4 16.6h8.6',
    minus: 'M7.4 12h9.2',
    square: 'M7.6 7.6h8.8v8.8H7.6z',
    chevron: 'M8.4 10.2l3.6 3.6 3.6-3.6',
    bulb: 'M12 4.4a5.9 5.9 0 0 1 3.4 10.7v2.3H8.6v-2.3A5.9 5.9 0 0 1 12 4.4z'
  };

  function agpIcon(name, cls) {
    const d = AGP_ICON[name] || '';
    return '<svg class="agp-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  // 创建浮动控制面板
  function createFloatingPanel() {
    const panel = document.createElement('div');
    panel.id = 'auto-grader-panel';
    panel.innerHTML = `
      <div class="agp-header">
        <span class="agp-title">${agpIcon('logo', 'agp-ico-logo')}自动阅卷助手</span>
        <div class="agp-header-btns">
          <button class="agp-icon-btn" id="agpLogToggleBtn" title="显示/隐藏日志" aria-label="显示或隐藏评分日志">${agpIcon('list')}</button>
          <button class="agp-toggle" id="agpToggleBtn" title="收起面板" aria-label="收起面板" aria-expanded="true">${agpIcon('chevron', 'agp-toggle-icon')}</button>
        </div>
      </div>
      <div class="agp-body" id="agpBody">
        <div class="agp-info">
          <div class="agp-info-item">
            <span class="agp-label">已批改：</span>
            <span class="agp-value" id="agpGradedCount">0</span> 份
          </div>
          <div class="agp-info-item">
            <span class="agp-label">状态：</span>
            <span class="agp-value agp-status" id="agpStatus">就绪</span>
          </div>
          <div class="agp-info-item" id="agpProgressItem" style="display:none;">
            <span class="agp-label">已阅：</span>
            <span class="agp-value" id="agpProgress">-</span>
          </div>
          <div class="agp-info-item agp-last-score" id="agpLastScoreItem" style="display:none;">
            <span class="agp-label">上一份：</span>
            <span class="agp-value agp-last-score-value" id="agpLastScore">-</span> 分
          </div>
        </div>
        <div class="agp-actions">
          <button class="agp-btn agp-btn-primary" id="agpGradeOneBtn">批改当前</button>
          <button class="agp-btn agp-btn-success" id="agpStartBtn">开始自动阅卷</button>
          <button class="agp-btn agp-btn-warning" id="agpPauseBtn" style="display:none;">暂停</button>
          <button class="agp-btn agp-btn-danger" id="agpStopBtn" style="display:none;">停止</button>
        </div>
        
        <!-- 日志区域切换按钮 -->
        <div class="agp-log-header" id="agpLogHeader">
          <span>评分日志</span>
          <span class="agp-log-arrow is-open" id="agpLogArrow">${agpIcon('chevron')}</span>
        </div>
        
        <!-- 日志区域 -->
        <div class="agp-log-container" id="agpLogContainer">
          <div class="agp-log-empty">暂无日志，点击"批改当前"开始</div>
        </div>
        
        <div class="agp-tip">
          ${agpIcon('bulb', 'agp-ico-tip')}请先在扩展面板「题目与答案」中填写题目和标准答案
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // 绑定事件
    document.getElementById('agpToggleBtn').addEventListener('click', togglePanel);
    document.getElementById('agpLogHeader').addEventListener('click', toggleLogPanel);
    document.getElementById('agpLogToggleBtn').addEventListener('click', toggleLogPanel);
    
    document.getElementById('agpGradeOneBtn').addEventListener('click', () => {
      gradeCurrentPaper();
    });
    document.getElementById('agpStartBtn').addEventListener('click', () => {
      // 用户手势内启动保活音频，避免被浏览器自动播放策略拦截
      startKeepAlive();
      startAutoGrading();
      document.getElementById('agpStartBtn').style.display = 'none';
      document.getElementById('agpPauseBtn').style.display = 'inline-block';
      document.getElementById('agpStopBtn').style.display = 'inline-block';
    });
    document.getElementById('agpPauseBtn').addEventListener('click', () => {
      if (isPaused) {
        isPaused = false;
        document.getElementById('agpPauseBtn').textContent = '暂停';
      } else {
        isPaused = true;
        document.getElementById('agpPauseBtn').textContent = '继续';
      }
      updatePanelStatus();
    });
    document.getElementById('agpStopBtn').addEventListener('click', () => {
      stopAutoGrading();
      document.getElementById('agpStartBtn').style.display = 'inline-block';
      document.getElementById('agpPauseBtn').style.display = 'none';
      document.getElementById('agpStopBtn').style.display = 'none';
      document.getElementById('agpPauseBtn').textContent = '暂停';
    });
    
    makeDraggable(panel);
  }

  // 切换面板展开/收起
  function togglePanel() {
    const body = document.getElementById('agpBody');
    const btn = document.getElementById('agpToggleBtn');
    const willCollapse = body.style.display !== 'none';

    if (willCollapse) {
      body.style.display = 'none';
      btn.classList.add('is-collapsed');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = '展开面板';
      btn.setAttribute('aria-label', '展开面板');
    } else {
      body.style.display = 'block';
      btn.classList.remove('is-collapsed');
      btn.setAttribute('aria-expanded', 'true');
      btn.title = '收起面板';
      btn.setAttribute('aria-label', '收起面板');
    }
  }

  // 切换日志面板展开/收起
  function toggleLogPanel() {
    const logContainer = document.getElementById('agpLogContainer');
    const arrow = document.getElementById('agpLogArrow');
    if (logContainer.style.display === 'none') {
      logContainer.style.display = 'block';
      arrow.classList.add('is-open');
    } else {
      logContainer.style.display = 'none';
      arrow.classList.remove('is-open');
    }
  }

  // 更新面板状态
  function updatePanelStatus(status) {
    // 同步面板状态，供样式用光点表达运行/暂停
    const panelEl = document.getElementById('auto-grader-panel');
    if (panelEl) {
      panelEl.setAttribute('data-state', isPaused ? 'paused' : (isAutoGrading ? 'running' : 'idle'));
    }
    const statusEl = document.getElementById('agpStatus');
    if (statusEl) {
      if (status) {
        statusEl.textContent = status;
      } else if (isPaused) {
        statusEl.textContent = '已暂停';
      } else if (isAutoGrading) {
        statusEl.textContent = '自动阅卷中...';
      } else {
        statusEl.textContent = '就绪';
      }
    }
  }

  // 更新面板信息
  function updatePanelInfo() {
    const countEl = document.getElementById('agpGradedCount');
    if (countEl) {
      countEl.textContent = gradedCount;
    }
    
    // 更新上一份分数显示
    const lastScoreItem = document.getElementById('agpLastScoreItem');
    const lastScoreEl = document.getElementById('agpLastScore');
    if (lastScoreItem && lastScoreEl && lastScore !== null) {
      lastScoreItem.style.display = 'block';
      lastScoreEl.textContent = lastScore;
      // 根据分数设置颜色
      const totalScore = currentConfig?.totalScore || 6;
      const percent = (lastScore / totalScore) * 100;
      lastScoreEl.className = 'agp-value agp-last-score-value';
      if (percent >= 80) {
        lastScoreEl.classList.add('score-high');
      } else if (percent >= 50) {
        lastScoreEl.classList.add('score-mid');
      } else {
        lastScoreEl.classList.add('score-low');
      }
    }
  }

  // 拖拽功能
  function makeDraggable(element) {
    const header = element.querySelector('.agp-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      element.style.right = 'auto';
      element.style.left = startLeft + 'px';
      element.style.top = startTop + 'px';
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      element.style.left = (startLeft + dx) + 'px';
      element.style.top = (startTop + dy) + 'px';
    });
    
    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
