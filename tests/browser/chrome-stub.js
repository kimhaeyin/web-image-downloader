/**
 * 图片展示页测试用的 chrome.* API 桩对象。
 *
 * 通过 CDP 的 Page.addScriptToEvaluateOnNewDocument 注入到真实的
 * extension/gallery.html 之前，这样测试跑的是线上同一份 HTML/CSS/JS，
 * 只是把扩展 API 换成可观测的假实现。
 *
 * 所有下载调用都会记录在 window.__STUB__.downloads 里，测试脚本再检查
 * blob 地址背后的字节是不是真的 PNG。
 */
(function () {
  'use strict';

  const BASE = 'http://127.0.0.1:4173/tests/browser/';

  const ITEMS = [
    { url: BASE + 'assets/main.png', originalUrl: null, key: 'a', width: 800, height: 800, loaded: true, source: 'img', alt: '主图', ext: 'png' },
    { url: BASE + 'assets/detail-1.png', originalUrl: null, key: 'b', width: 750, height: 1100, loaded: true, source: 'img', alt: '详情图1', ext: 'png' },
    { url: BASE + 'assets/detail-2.png', originalUrl: null, key: 'c', width: 750, height: 1100, loaded: true, source: 'img', alt: '详情图2', ext: 'png' },
    { url: BASE + 'assets/bg.png', originalUrl: null, key: 'd', width: 900, height: 600, loaded: false, source: 'background', alt: '', ext: 'png' },
    { url: BASE + 'assets/small-32.png', originalUrl: null, key: 'e', width: 32, height: 32, loaded: true, source: 'img', alt: '小图', ext: 'png' },
    // 故意指向不存在的文件，用于验证“跨域 / 404 导致转换失败”时的提示与回退
    { url: BASE + 'assets/missing-image.png', originalUrl: null, key: 'f', width: 600, height: 600, loaded: false, source: 'img', alt: '缺失图', ext: 'png' }
  ];

  const PAYLOAD = {
    tabId: 1,
    pageUrl: 'https://item.jd.com/100012043978.html',
    pageTitle: '测试商品标题 —— 京东',
    site: '京东',
    pageKind: 'product',
    scannedAt: Date.now(),
    stats: { raw: 18, kept: ITEMS.length, duplicate: 4, scannedElements: 37, dropped: { invalid: 0, dataUrl: 0, blocked: 8, notImage: 0, tooSmall: 1 } },
    items: ITEMS
  };

  const calls = { downloads: [], sent: [], openedTabs: [] };
  window.__STUB__ = calls;

  const listeners = [];
  let downloadSeq = 500;

  function emit(message) {
    listeners.forEach(function (fn) {
      try {
        fn(message, {}, function () {});
      } catch (err) {
        /* 忽略 */
      }
    });
  }

  function handle(msg) {
    calls.sent.push(msg.type);
    if (msg.type === 'IG_GET_RESULT' || msg.type === 'IG_RESCAN') {
      const payload = window.__STUB_EMPTY__
        ? Object.assign({}, PAYLOAD, { items: [], stats: { raw: 0, kept: 0, duplicate: 0, scannedElements: 0, dropped: {} } })
        : PAYLOAD;
      return { ok: true, payload: payload };
    }
    if (msg.type === 'IG_OPEN_TAB') {
      calls.openedTabs.push(msg.url);
      return { ok: true, tabId: 999 };
    }
    if (msg.type === 'IG_DOWNLOAD') {
      const id = downloadSeq++;
      calls.downloads.push({ id: id, url: msg.url, filename: msg.filename, index: msg.index, at: Date.now() });
      // 模拟 Service Worker 在下载完成后广播的进度事件
      setTimeout(function () {
        emit({ type: 'IG_DOWNLOAD_PROGRESS', downloadId: id, state: 'complete', error: null, filename: msg.filename });
      }, 25);
      return { ok: true, downloadId: id };
    }
    return { ok: false, error: '桩对象没有实现的消息类型：' + msg.type };
  }

  window.chrome = {
    runtime: {
      getManifest: function () {
        return { version: '1.0.0' };
      },
      getURL: function (relative) {
        return relative;
      },
      sendMessage: function (msg) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            try {
              resolve(handle(msg));
            } catch (err) {
              resolve({ ok: false, error: String(err && err.message) });
            }
          }, 10);
        });
      },
      onMessage: {
        addListener: function (fn) {
          listeners.push(fn);
        }
      }
    },
    storage: {
      local: {
        get: function () {
          return Promise.resolve({ igSettings: window.__STUB_SETTINGS__ || {} });
        },
        set: function () {
          return Promise.resolve();
        }
      }
    },
    downloads: {
      download: function (options) {
        const id = downloadSeq++;
        calls.downloads.push({ id: id, url: options.url, filename: options.filename, index: options.index, at: Date.now(), local: true });
        setTimeout(function () {
          emit({ type: 'IG_DOWNLOAD_PROGRESS', downloadId: id, state: 'complete', error: null, filename: options.filename });
        }, 25);
        return Promise.resolve(id);
      }
    }
  };
})();
