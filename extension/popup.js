/**
 * 图提取 ImageGrab —— 工具栏弹窗
 *
 * 职责：
 *   1. 显示当前标签页是否受支持。
 *   2. 提供“获取本页图片”的快捷入口。
 *   3. 维护采集与下载设置（保存在 chrome.storage.local 的 igSettings）。
 */
(function () {
  'use strict';

  const CORE = globalThis.IGCore;

  const el = {
    version: document.getElementById('version'),
    tabInfo: document.getElementById('tabInfo'),
    btnGrab: document.getElementById('btnGrab'),
    hint: document.getElementById('hint'),
    setConvertPng: document.getElementById('setConvertPng'),
    setFallback: document.getElementById('setFallback'),
    setBackground: document.getElementById('setBackground'),
    setScanScripts: document.getElementById('setScanScripts'),
    setPreferOriginal: document.getElementById('setPreferOriginal'),
    setMinSize: document.getElementById('setMinSize'),
    minSizeOut: document.getElementById('minSizeOut'),
    btnReset: document.getElementById('btnReset')
  };

  let settings = Object.assign({}, CORE.DEFAULT_SETTINGS);
  let activeTabId = null;

  function syncInputs() {
    el.setConvertPng.checked = !!settings.convertToPng;
    el.setFallback.checked = !!settings.fallbackOriginal;
    el.setBackground.checked = !!settings.includeBackground;
    el.setScanScripts.checked = !!settings.scanScripts;
    el.setPreferOriginal.checked = !!settings.preferOriginal;
    el.setMinSize.value = String(settings.minSize);
    el.minSizeOut.textContent = settings.minSize > 0 ? settings.minSize + ' px' : '不限制';
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({ igSettings: settings });
    } catch (err) {
      /* 忽略 */
    }
    // 通知已打开的页面重新读取设置
    if (typeof activeTabId === 'number') {
      chrome.tabs.sendMessage(activeTabId, { type: 'IG_SETTINGS_CHANGED' }).catch(function () {});
    }
  }

  // ==========================================================================
  // 设置项绑定
  // ==========================================================================

  el.setConvertPng.addEventListener('change', function () {
    settings.convertToPng = el.setConvertPng.checked;
    saveSettings();
  });
  el.setFallback.addEventListener('change', function () {
    settings.fallbackOriginal = el.setFallback.checked;
    saveSettings();
  });
  el.setBackground.addEventListener('change', function () {
    settings.includeBackground = el.setBackground.checked;
    saveSettings();
  });
  el.setScanScripts.addEventListener('change', function () {
    settings.scanScripts = el.setScanScripts.checked;
    saveSettings();
  });
  el.setPreferOriginal.addEventListener('change', function () {
    settings.preferOriginal = el.setPreferOriginal.checked;
    saveSettings();
  });
  el.setMinSize.addEventListener('input', function () {
    settings.minSize = Number(el.setMinSize.value) || 0;
    el.minSizeOut.textContent = settings.minSize > 0 ? settings.minSize + ' px' : '不限制';
  });
  el.setMinSize.addEventListener('change', function () {
    saveSettings();
  });
  el.btnReset.addEventListener('click', function () {
    settings = Object.assign({}, CORE.DEFAULT_SETTINGS);
    syncInputs();
    saveSettings();
  });

  // ==========================================================================
  // 获取本页图片
  // ==========================================================================

  el.btnGrab.addEventListener('click', function () {
    el.btnGrab.disabled = true;
    el.btnGrab.textContent = '提取中…';
    chrome.runtime
      .sendMessage({ type: 'IG_START' })
      .then(function (res) {
        if (!res || !res.ok) {
          el.hint.textContent = '提取失败：' + ((res && res.error) || '未知错误');
          el.btnGrab.disabled = false;
          el.btnGrab.textContent = '获取本页图片';
          return;
        }
        window.close();
      })
      .catch(function (err) {
        el.hint.textContent = '提取失败：' + String((err && err.message) || err);
        el.btnGrab.disabled = false;
        el.btnGrab.textContent = '获取本页图片';
      });
  });

  // ==========================================================================
  // 初始化
  // ==========================================================================

  async function init() {
    el.version.textContent = 'v' + chrome.runtime.getManifest().version;

    try {
      const stored = await chrome.storage.local.get('igSettings');
      settings = Object.assign({}, CORE.DEFAULT_SETTINGS, (stored && stored.igSettings) || {});
    } catch (err) {
      settings = Object.assign({}, CORE.DEFAULT_SETTINGS);
    }
    syncInputs();

    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0];
    } catch (err) {
      tab = null;
    }

    if (!tab || !tab.url) {
      el.tabInfo.textContent = '无法读取当前标签页信息。';
      el.tabInfo.className = 'tab-info bad';
      return;
    }

    activeTabId = tab.id;
    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch (err) {
      host = '';
    }

    if (!CORE.isSupportedHost(host)) {
      el.tabInfo.textContent = '当前页面不受支持：' + host + '。请在淘宝、天猫、京东或拼多多的商品详情页使用。';
      el.tabInfo.className = 'tab-info bad';
      el.btnGrab.disabled = true;
      return;
    }

    const site = CORE.detectSite(host);
    const kind = CORE.detectPageKind(tab.url);
    el.tabInfo.textContent =
      (site ? site.name : host) +
      (kind === 'product' ? ' · 商品详情页' : ' · 非标准商品详情页（仍可尝试提取）');
    el.btnGrab.disabled = false;
    if (kind !== 'product') {
      el.hint.textContent = '提示：如果图片没加载出来，先在页面上滚动一遍再提取。';
    }
  }

  init();
})();
