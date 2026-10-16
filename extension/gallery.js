/**
 * 图提取 ImageGrab —— 图片展示页
 *
 * 职责：
 *   1. 从 Service Worker 拉取指定标签页的采集结果并渲染网格。
 *   2. 勾选、全选、取消选择、反选与已选计数。
 *   3. 单张下载与批量下载：先取字节 → canvas 转 PNG → 通过 chrome.downloads 下载。
 *   4. 汇总下载进度，区分“成功转 PNG”“按原格式下载”“未确认”“失败”，
 *      并且绝不在转换失败时把原格式文件伪装成 PNG。
 */
(function () {
  'use strict';

  const CORE = globalThis.IGCore;

  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tab'));

  const el = {
    sourceInfo: document.getElementById('sourceInfo'),
    btnRescan: document.getElementById('btnRescan'),
    btnRescan2: document.getElementById('btnRescan2'),
    btnRetry: document.getElementById('btnRetry'),
    btnSource: document.getElementById('btnSource'),
    btnSource2: document.getElementById('btnSource2'),
    btnSource3: document.getElementById('btnSource3'),
    toolbar: document.getElementById('toolbar'),
    statTotal: document.getElementById('statTotal'),
    statStats: document.getElementById('statStats'),
    statSelected: document.getElementById('statSelected'),
    btnSelectAll: document.getElementById('btnSelectAll'),
    btnSelectNone: document.getElementById('btnSelectNone'),
    btnInvert: document.getElementById('btnInvert'),
    chkPng: document.getElementById('chkPng'),
    btnDownload: document.getElementById('btnDownload'),
    progressWrap: document.getElementById('progressWrap'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    failList: document.getElementById('failList'),
    grid: document.getElementById('grid'),
    stateLoading: document.getElementById('stateLoading'),
    stateEmpty: document.getElementById('stateEmpty'),
    stateError: document.getElementById('stateError'),
    emptyHint: document.getElementById('emptyHint'),
    errorTitle: document.getElementById('errorTitle'),
    errorDetail: document.getElementById('errorDetail'),
    footerText: document.getElementById('footerText'),
    footerRight: document.getElementById('footerRight')
  };

  let settings = Object.assign({}, CORE.DEFAULT_SETTINGS);
  let payload = null;
  let items = [];
  let selected = new Set();
  const cardMap = new Map();
  let running = false;

  // ==========================================================================
  // 小工具
  // ==========================================================================

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function sendBg(type, extra) {
    return chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}));
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      const tail = u.pathname.split('/').filter(Boolean).pop() || '';
      return u.hostname + '/' + (tail.length > 28 ? tail.slice(0, 28) + '…' : tail);
    } catch (err) {
      return url.length > 48 ? url.slice(0, 48) + '…' : url;
    }
  }

  function setSourceLinks(url) {
    [el.btnSource, el.btnSource2, el.btnSource3].forEach(function (a) {
      if (!a) return;
      if (url) {
        a.href = url;
        a.hidden = false;
      } else {
        a.hidden = true;
      }
    });
  }

  function showOnly(which) {
    el.stateLoading.hidden = which !== 'loading';
    el.stateEmpty.hidden = which !== 'empty';
    el.stateError.hidden = which !== 'error';
    el.grid.hidden = which !== 'grid';
    el.toolbar.hidden = which !== 'grid';
  }

  function showError(title, detail) {
    el.errorTitle.textContent = title || '读取失败';
    el.errorDetail.textContent = detail || '未知错误。';
    showOnly('error');
  }

  // ==========================================================================
  // 设置
  // ==========================================================================

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('igSettings');
      settings = Object.assign({}, CORE.DEFAULT_SETTINGS, (stored && stored.igSettings) || {});
    } catch (err) {
      settings = Object.assign({}, CORE.DEFAULT_SETTINGS);
    }
  }

  async function persistSettings() {
    try {
      await chrome.storage.local.set({ igSettings: settings });
    } catch (err) {
      /* 忽略：设置保存失败不影响本次下载 */
    }
  }

  // ==========================================================================
  // 下载进度等待
  // ==========================================================================

  const pending = new Map(); // downloadId -> resolver
  const settledCache = new Map(); // downloadId -> info（下载可能在登记之前就完成了）

  function waitDownload(downloadId, timeoutMs) {
    if (typeof downloadId !== 'number') {
      return Promise.resolve({ state: 'unknown' });
    }
    if (settledCache.has(downloadId)) {
      const cached = settledCache.get(downloadId);
      settledCache.delete(downloadId);
      return Promise.resolve(cached);
    }
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        pending.delete(downloadId);
        resolve({ state: 'timeout' });
      }, timeoutMs);
      pending.set(downloadId, function (info) {
        clearTimeout(timer);
        pending.delete(downloadId);
        resolve(info);
      });
    });
  }

  const DL_ERROR_TEXT = {
    FILE_FAILED: '文件写入失败',
    FILE_ACCESS_DENIED: '没有权限写入该位置',
    FILE_NO_SPACE: '磁盘空间不足',
    FILE_NAME_TOO_LONG: '文件名过长',
    FILE_TOO_LARGE: '文件过大',
    FILE_VIRUS_INFECTED: '文件被安全软件拦截',
    FILE_TRANSIENT_ERROR: '文件写入临时错误',
    FILE_BLOCKED: '文件被策略阻止',
    FILE_SECURITY_CHECK_FAILED: '文件安全检查失败',
    FILE_TOO_SHORT: '文件内容不完整',
    NETWORK_FAILED: '网络错误',
    NETWORK_TIMEOUT: '网络超时',
    NETWORK_DISCONNECTED: '网络已断开',
    NETWORK_SERVER_DOWN: '服务器不可用',
    NETWORK_INVALID_REQUEST: '请求不合法',
    SERVER_FAILED: '服务器错误',
    SERVER_BAD_CONTENT: '服务器返回内容异常',
    SERVER_UNAUTHORIZED: '服务器拒绝访问（可能需要登录）',
    SERVER_FORBIDDEN: '服务器拒绝访问（防盗链或权限限制）',
    SERVER_CERT_PROBLEM: '证书错误',
    SERVER_ACCESS_DENIED: '服务器拒绝访问',
    USER_CANCELED: '下载被取消',
    USER_SHUTDOWN: '浏览器已退出',
    CRASH: '下载过程崩溃'
  };

  function describeDownloadError(code) {
    if (!code) return '未知原因';
    return DL_ERROR_TEXT[code] || code;
  }

  // ==========================================================================
  // 取字节与 PNG 转换
  // ==========================================================================

  async function fetchImageBlob(url) {
    let res;
    try {
      // credentials: 'omit' —— 不携带任何 Cookie，避免触碰登录态与防盗链策略
      res = await fetch(url, { credentials: 'omit' });
    } catch (err) {
      throw new Error('网络请求失败或被浏览器拦截（' + String((err && err.message) || err) + '）');
    }
    if (!res.ok) throw new Error('服务器返回 HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw new Error('服务器返回的内容为空');
    return blob;
  }

  const MAX_PIXELS = 64 * 1024 * 1024; // 约 8000×8000，超过则放弃转换

  async function convertToPng(blob) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      throw new Error('图片解码失败，返回的可能不是有效的图片数据');
    }
    try {
      if (bitmap.width * bitmap.height > MAX_PIXELS) {
        throw new Error('图片尺寸过大（' + bitmap.width + '×' + bitmap.height + '），已跳过 PNG 转换');
      }
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建 canvas 绘图上下文');
      ctx.drawImage(bitmap, 0, 0);

      const out = await new Promise(function (resolve, reject) {
        try {
          canvas.toBlob(function (b) {
            if (b) resolve(b);
            else reject(new Error('PNG 编码失败'));
          }, 'image/png');
        } catch (err) {
          if (err && err.name === 'SecurityError') {
            reject(new Error('图片受跨域安全策略限制，浏览器不允许在画布中重新编码'));
          } else {
            reject(err);
          }
        }
      });
      return { blob: out, width: canvas.width, height: canvas.height };
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  /**
   * 发起一次下载并等待结果。
   * blob: 地址优先交给后台下载；若后台拒绝（部分 Chrome 版本不允许
   * Service Worker 下载页面创建的 blob 地址），改由展示页自己发起。
   */
  async function saveUrl(url, filename, index) {
    const isBlob = url.indexOf('blob:') === 0;
    let res = null;
    try {
      res = await sendBg('IG_DOWNLOAD', { url: url, filename: filename, index: index });
    } catch (err) {
      res = null;
    }

    if (res && res.ok && typeof res.downloadId === 'number') {
      const info = await waitDownload(res.downloadId, 90000);
      if (info.state === 'interrupted') {
        throw new Error('下载被中断：' + describeDownloadError(info.error));
      }
      if (info.state === 'timeout') return { state: 'uncertain' };
      return { state: 'complete' };
    }

    if (isBlob) {
      const localId = await chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      const info = await waitDownload(localId, 90000);
      if (info.state === 'interrupted') {
        throw new Error('下载被中断：' + describeDownloadError(info.error));
      }
      if (info.state === 'timeout') return { state: 'uncertain' };
      return { state: 'complete' };
    }

    throw new Error((res && res.error) || '发起下载失败');
  }

  async function saveBlob(blob, filename, index) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await saveUrl(objectUrl, filename, index);
    } finally {
      // 推迟回收，确保下载任务已经读完这个 blob
      setTimeout(function () {
        URL.revokeObjectURL(objectUrl);
      }, 20000);
    }
  }

  /** 下载一张图片，返回处理结果分类 */
  async function downloadOne(item, seq, total, index) {
    const src = item.originalUrl || item.url;
    const wantPng = el.chkPng.checked;

    if (wantPng) {
      try {
        const blob = await fetchImageBlob(src);
        const png = await convertToPng(blob);
        const filename = CORE.buildFileName(seq, total, 'png');
        const saved = await saveBlob(png.blob, filename, index);
        return { kind: saved.state === 'uncertain' ? 'uncertain' : 'png', detail: filename };
      } catch (err) {
        const reason = String((err && err.message) || err);
        if (!settings.fallbackOriginal) {
          return { kind: 'failed', reason: 'PNG 转换失败：' + reason };
        }
        try {
          const filename = CORE.buildFileName(seq, total, item.ext || 'jpg');
          const saved = await saveUrl(src, filename, index);
          return {
            kind: saved.state === 'uncertain' ? 'uncertain' : 'original',
            reason: 'PNG 转换失败（' + reason + '），已按原格式下载',
            detail: filename
          };
        } catch (err2) {
          return {
            kind: 'failed',
            reason: reason + '；按原格式下载也失败：' + String((err2 && err2.message) || err2)
          };
        }
      }
    }

    const filename = CORE.buildFileName(seq, total, item.ext || 'jpg');
    const saved = await saveUrl(src, filename, index);
    return { kind: saved.state === 'uncertain' ? 'uncertain' : 'original', detail: filename };
  }

  // ==========================================================================
  // 批量下载
  // ==========================================================================

  function setProgress(percent) {
    el.progressBar.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }

  function setProgressText(text) {
    el.progressText.textContent = text;
  }

  /** 渲染明细列表：failures 为真正的失败（红色），notes 为降级说明（中性） */
  function renderDetails(failures, notes) {
    el.failList.textContent = '';
    const all = [];
    (failures || []).forEach(function (f) {
      all.push({ tone: 'fail', url: f.url, reason: f.reason });
    });
    (notes || []).forEach(function (n) {
      all.push({ tone: 'note', url: n.url, reason: n.reason });
    });
    if (!all.length) {
      el.failList.hidden = true;
      return;
    }
    for (const entry of all) {
      const li = document.createElement('li');
      if (entry.tone === 'note') li.className = 'note';
      li.textContent = shortUrl(entry.url) + ' —— ' + entry.reason;
      el.failList.appendChild(li);
    }
    el.failList.hidden = false;
  }

  /**
   * 批量下载进行中的标记。
   * 除了内部防止重入，也写到 DOM 上，便于外部（测试脚本或用户脚本）
   * 判断当前是否还在下载，而不是靠固定等待时间来猜。
   */
  function setBusy(busy) {
    const root = document.documentElement;
    if (busy) root.setAttribute('data-ig-busy', '1');
    else root.removeAttribute('data-ig-busy');
  }

  async function runBatch(indices) {
    if (running) return;
    const list = indices.slice().sort(function (a, b) {
      return a - b;
    });
    if (!list.length) return;

    running = true;
    setBusy(true);
    el.btnDownload.disabled = true;
    el.progressWrap.hidden = false;
    el.failList.hidden = true;
    renderDetails([], []);
    setProgress(0);

    const failures = [];
    const notes = [];
    let png = 0;
    let original = 0;
    let uncertain = 0;
    let failed = 0;
    const total = list.length;

    try {
      for (let i = 0; i < total; i++) {
        const index = list[i];
        const item = items[index];
        const seq = i + 1;
        if (!item) continue;

        setProgressText('正在处理 ' + seq + ' / ' + total + '：' + shortUrl(item.url));
        try {
          const result = await downloadOne(item, seq, total, index);
          if (result.kind === 'png') png++;
          else if (result.kind === 'original') {
            original++;
            if (result.reason) notes.push({ url: item.url, reason: result.reason });
          } else if (result.kind === 'uncertain') uncertain++;
          else {
            failed++;
            failures.push({ url: item.url, reason: result.reason || '未知错误' });
          }
        } catch (err) {
          failed++;
          failures.push({ url: item.url, reason: String((err && err.message) || err) });
        }
        setProgress(((i + 1) / total) * 100);
        if (i < total - 1) await sleep(260); // 控制节奏，降低触发“允许下载多个文件”拦截的概率
      }

      const parts = [];
      if (png) parts.push('成功转 PNG ' + png + ' 张');
      if (original) parts.push('按原格式下载 ' + original + ' 张');
      if (uncertain) parts.push('状态未确认 ' + uncertain + ' 张');
      if (failed) parts.push('失败 ' + failed + ' 张');
      setProgressText('处理完成：共 ' + total + ' 张。' + (parts.join('，') || '没有需要下载的内容') + '。');
      renderDetails(failures, notes);

      el.footerRight.textContent = '最近一次下载：' + parts.join('，');
      el.footerRight.className = failed ? 'bad' : 'ok';
    } finally {
      // 无论中途是否出异常，都必须解除进行中标记并恢复按钮状态
      running = false;
      setBusy(false);
      updateCounters();
    }
  }

  // ==========================================================================
  // 渲染
  // ==========================================================================

  function updateCounters() {
    el.statTotal.textContent = '共 ' + items.length + ' 张';
    el.statSelected.textContent = '已选 ' + selected.size + ' 张';
    el.btnDownload.disabled = running || selected.size === 0;
    el.btnDownload.textContent = selected.size ? '下载选中（' + selected.size + '）' : '下载选中';
  }

  function setSelected(index, on) {
    const card = cardMap.get(index);
    if (on) selected.add(index);
    else selected.delete(index);
    if (card) {
      card.dataset.selected = on ? '1' : '0';
      const cb = card.querySelector('input[type="checkbox"]');
      if (cb && cb.checked !== on) cb.checked = on;
    }
    updateCounters();
  }

  const SOURCE_LABEL = { img: '图片', background: '背景', script: '脚本' };

  function buildCard(item, index) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.index = String(index);
    card.dataset.selected = '0';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = item.alt || '商品图 ' + (index + 1);
    img.src = item.url;
    img.addEventListener('error', function () {
      thumb.dataset.broken = '1';
      img.style.visibility = 'hidden';
    });
    thumb.appendChild(img);

    const picker = document.createElement('div');
    picker.className = 'picker';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.title = '选择这张图片';
    cb.addEventListener('change', function () {
      setSelected(index, cb.checked);
    });
    picker.appendChild(cb);
    thumb.appendChild(picker);

    const srcBadge = document.createElement('span');
    srcBadge.className = 'badge-src';
    srcBadge.textContent = SOURCE_LABEL[item.source] || item.source || '图片';
    thumb.appendChild(srcBadge);

    thumb.addEventListener('click', function (event) {
      if (event.target.closest('.picker')) return;
      setSelected(index, !selected.has(index));
    });

    const body = document.createElement('div');
    body.className = 'card-body';

    const dims = document.createElement('div');
    dims.className = 'dims';
    if (item.width && item.height) dims.textContent = item.width + ' × ' + item.height;
    else if (item.width || item.height) dims.textContent = (item.width || '?') + ' × ' + (item.height || '?');
    else dims.textContent = '尺寸未知';

    const urlLine = document.createElement('div');
    urlLine.className = 'url';
    urlLine.textContent = item.url;
    urlLine.title = item.url;

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn-link';
    dlBtn.textContent = '下载此张';
    dlBtn.addEventListener('click', function () {
      runBatch([index]);
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-link';
    copyBtn.textContent = '复制链接';
    copyBtn.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(item.url);
        copyBtn.textContent = '已复制';
      } catch (err) {
        copyBtn.textContent = '复制失败';
      }
      setTimeout(function () {
        copyBtn.textContent = '复制链接';
      }, 1600);
    });

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn-link';
    openBtn.textContent = '打开';
    openBtn.addEventListener('click', function () {
      sendBg('IG_OPEN_TAB', { url: item.url }).catch(function () {});
    });

    actions.appendChild(dlBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(openBtn);

    body.appendChild(dims);
    body.appendChild(urlLine);
    body.appendChild(actions);

    card.appendChild(thumb);
    card.appendChild(body);
    return card;
  }

  function renderGrid() {
    el.grid.textContent = '';
    cardMap.clear();
    const fragment = document.createDocumentFragment();
    items.forEach(function (item, index) {
      const card = buildCard(item, index);
      cardMap.set(index, card);
      fragment.appendChild(card);
    });
    el.grid.appendChild(fragment);
  }

  function renderSourceInfo() {
    if (!payload) return;
    const when = payload.scannedAt ? new Date(payload.scannedAt).toLocaleTimeString() : '';
    const title = payload.pageTitle ? payload.pageTitle : payload.pageUrl;
    const parts = [];
    if (payload.site) parts.push(payload.site);
    if (title) parts.push(title.length > 70 ? title.slice(0, 70) + '…' : title);
    if (when) parts.push('采集于 ' + when);
    parts.push('共 ' + items.length + ' 张');
    el.sourceInfo.textContent = parts.join(' · ');
    setSourceLinks(payload.pageUrl || '');
  }

  function applyPayload(next) {
    payload = next;
    items = (next.items || []).slice();
    selected = new Set();
    el.statStats.textContent = next.stats ? describeStats(next.stats) : '';
    renderSourceInfo();
    if (!items.length) {
      // 空列表时必须把列表与选择状态一并复位，否则上一轮的“已选 N 张”
      // 与下载按钮的可用状态会残留下来，与实际内容不一致。
      selected = new Set();
      cardMap.clear();
      el.grid.textContent = '';
      setProgress(0);
      setProgressText('');
      el.progressWrap.hidden = true;
      renderDetails([], []);
      updateCounters();
      const pageKind = next.pageKind;
      el.emptyHint.textContent =
        pageKind === 'product'
          ? '这个商品页暂时没有采集到符合条件的图片。可以先在页面上滚动到底部让懒加载图片加载出来，切换商品规格，然后点击“重新采集”。'
          : '当前页面可能不是标准的商品详情页。可以打开具体的商品详情页后再试，或者点击“重新采集”。';
      showOnly('empty');
      return;
    }
    renderGrid();
    updateCounters();
    showOnly('grid');
  }

  function describeStats(stats) {
    if (!stats) return '';
    const d = stats.dropped || {};
    const blocked = (d.blocked || 0) + (d.notImage || 0) + (d.dataUrl || 0) + (d.invalid || 0);
    const parts = ['候选 ' + stats.raw];
    if (stats.duplicate) parts.push('去重 ' + stats.duplicate);
    if (blocked) parts.push('过滤 ' + blocked);
    if (d.tooSmall) parts.push('过小 ' + d.tooSmall);
    return parts.join(' · ');
  }

  // ==========================================================================
  // 事件绑定
  // ==========================================================================

  el.btnSelectAll.addEventListener('click', function () {
    items.forEach(function (_, index) {
      setSelected(index, true);
    });
  });

  el.btnSelectNone.addEventListener('click', function () {
    Array.from(selected).forEach(function (index) {
      setSelected(index, false);
    });
  });

  el.btnInvert.addEventListener('click', function () {
    items.forEach(function (_, index) {
      setSelected(index, !selected.has(index));
    });
  });

  el.btnDownload.addEventListener('click', function () {
    runBatch(Array.from(selected));
  });

  el.chkPng.addEventListener('change', function () {
    settings.convertToPng = el.chkPng.checked;
    persistSettings();
  });

  async function rescan() {
    if (running) return;
    showOnly('loading');
    try {
      const res = await sendBg('IG_RESCAN', { tabId: tabId });
      if (!res || !res.ok) {
        showError('重新采集失败', (res && res.error) || '未知错误');
        return;
      }
      applyPayload(res.payload);
    } catch (err) {
      showError('重新采集失败', String((err && err.message) || err));
    }
  }

  el.btnRescan.addEventListener('click', rescan);
  el.btnRescan2.addEventListener('click', rescan);
  el.btnRetry.addEventListener('click', function () {
    init();
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'IG_DOWNLOAD_PROGRESS') {
      const info = { state: msg.state, error: msg.error, filename: msg.filename };
      const resolver = pending.get(msg.downloadId);
      if (resolver) {
        resolver(info);
      } else {
        settledCache.set(msg.downloadId, info);
        setTimeout(function () {
          settledCache.delete(msg.downloadId);
        }, 15000);
      }
    } else if (msg.type === 'IG_RESULT_UPDATED') {
      if (msg.tabId === tabId && !running) {
        el.footerRight.textContent = '来源页面已重新采集（' + msg.count + ' 张），点击“重新采集”刷新列表';
        el.footerRight.className = '';
      }
    }
  });

  // ==========================================================================
  // 启动
  // ==========================================================================

  async function init() {
    el.footerText.textContent = '图提取 ImageGrab v' + chrome.runtime.getManifest().version;
    showOnly('loading');
    await loadSettings();
    el.chkPng.checked = !!settings.convertToPng;

    if (!Number.isFinite(tabId)) {
      showError('缺少来源标签页参数', '请从商品页面点击“获取图片”按钮打开展示页。');
      return;
    }

    try {
      const res = await sendBg('IG_GET_RESULT', { tabId: tabId });
      if (!res || !res.ok) {
        showError('没有读取到采集结果', (res && res.error) || '未知错误');
        return;
      }
      applyPayload(res.payload);
    } catch (err) {
      showError('读取采集结果失败', String((err && err.message) || err) + '（可以点击“重试”再试一次）');
    }
  }

  init();
})();
