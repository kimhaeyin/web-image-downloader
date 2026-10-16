/**
 * 图提取 ImageGrab —— Service Worker（后台）
 *
 * 职责：
 *   1. 作为消息中枢，接收内容脚本与展示页的消息。
 *   2. 按标签页保存图片清单（chrome.storage.session，防止 Service Worker
 *      被回收之后状态丢失）。
 *   3. 打开图片展示页，并在展示页请求“重新采集”时驱动内容脚本重新采集。
 *   4. 使用 chrome.downloads API 执行下载任务，并把下载进度广播给展示页。
 *
 * 说明：Service Worker 里没有 DOM，因此 PNG 转换在展示页用 canvas 完成，
 * 这里只负责发起下载与汇总进度。
 */

importScripts('lib/extract-core.js');

const CORE = self.IGCore;
const GALLERY_PAGE = 'gallery.html';
const TAB_KEY_PREFIX = 'ig:tab:';

/** downloadId -> { tabId, index, filename, url }，仅用于把进度事件关联回展示页 */
const downloadRegistry = new Map();

// ==========================================================================
// 存储
// ==========================================================================

function tabKey(tabId) {
  return TAB_KEY_PREFIX + tabId;
}

async function saveResult(tabId, payload) {
  const data = {};
  data[tabKey(tabId)] = payload;
  await chrome.storage.session.set(data);
}

async function loadResult(tabId) {
  const key = tabKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function clearResult(tabId) {
  await chrome.storage.session.remove(tabKey(tabId));
}

// ==========================================================================
// 采集
// ==========================================================================

/**
 * 让指定标签页的内容脚本采集图片。
 * 如果内容脚本尚未注入（扩展是在页面打开之后才安装的），补注入一次再重试。
 */
async function collectFromTab(tabId) {
  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'IG_COLLECT_REQUEST' });
  } catch (err) {
    res = null;
  }

  if (!res || !res.ok) {
    await injectContentScripts(tabId);
    res = await chrome.tabs.sendMessage(tabId, { type: 'IG_COLLECT_REQUEST' });
  }

  if (!res || !res.ok) {
    throw new Error((res && res.error) || '无法与页面通信，请刷新页面后重试');
  }

  const items = CORE.dedupeItems(res.items || []);
  const payload = {
    tabId: tabId,
    pageUrl: res.pageUrl || '',
    pageTitle: res.pageTitle || '',
    site: res.site || '',
    pageKind: res.pageKind || 'other',
    scannedAt: Date.now(),
    items: items,
    stats: res.stats || null
  };
  await saveResult(tabId, payload);
  return payload;
}

async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['lib/extract-core.js', 'content.js']
    });
    // 等待内容脚本注册好消息监听
    await new Promise(function (resolve) {
      setTimeout(resolve, 250);
    });
  } catch (err) {
    // 页面可能是不支持注入的受限页面，交给上层报错
  }
}

// ==========================================================================
// 展示页
// ==========================================================================

function galleryUrl(tabId) {
  return chrome.runtime.getURL(GALLERY_PAGE) + '?tab=' + tabId;
}

/** 打开展示页；已经打开过就复用那个标签页 */
async function openGallery(tabId) {
  const target = galleryUrl(tabId);
  const base = chrome.runtime.getURL(GALLERY_PAGE);
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    tabs = [];
  }
  const existing = tabs.find(function (t) {
    return t.url && t.url.indexOf(base) === 0;
  });
  if (existing) {
    await chrome.tabs.update(existing.id, { url: target, active: true });
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: target, active: true });
  return created.id;
}

// ==========================================================================
// 下载
// ==========================================================================

async function startDownload(url, filename, tabId, index) {
  const downloadId = await chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });
  if (typeof downloadId === 'number') {
    downloadRegistry.set(downloadId, {
      tabId: tabId,
      filename: filename,
      index: index == null ? -1 : index,
      url: url
    });
  }
  return downloadId;
}

function broadcast(message) {
  // runtime.sendMessage 会把消息发给除发送者之外的所有扩展上下文，
  // 展示页与 popup 都能收到；没有接收方时会抛错，这里忽略。
  chrome.runtime.sendMessage(message).catch(function () {});
}

chrome.downloads.onChanged.addListener(function (delta) {
  if (!delta.state && !delta.error) return;
  const info = downloadRegistry.get(delta.id) || null;
  const state = delta.state ? delta.state.current : null;
  broadcast({
    type: 'IG_DOWNLOAD_PROGRESS',
    downloadId: delta.id,
    state: state,
    error: delta.error ? delta.error.current : null,
    filename: info ? info.filename : '',
    index: info ? info.index : -1,
    url: info ? info.url : ''
  });
  if (state === 'complete' || state === 'interrupted') {
    downloadRegistry.delete(delta.id);
  }
});

// ==========================================================================
// 消息路由
// ==========================================================================

const handlers = {
  /** 内容脚本点击“获取图片”按钮 */
  IG_START: async function (msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') throw new Error('无法确定来源标签页');
    const payload = await collectFromTab(tabId);
    await openGallery(tabId);
    return { ok: true, tabId: tabId, count: payload.items.length, stats: payload.stats };
  },

  /** 展示页拉取清单 */
  IG_GET_RESULT: async function (msg) {
    const tabId = msg.tabId;
    const payload = await loadResult(tabId);
    if (!payload) {
      return { ok: false, error: '没有找到该页面的采集结果，可能标签页已关闭或结果已失效。' };
    }
    return { ok: true, payload: payload };
  },

  /** 展示页请求重新采集 */
  IG_RESCAN: async function (msg) {
    const tabId = msg.tabId;
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      return { ok: false, error: '来源标签页已经关闭，无法重新采集。' };
    }
    if (!tab || !CORE.isSupportedHost(new URL(tab.url || 'https://example.invalid').hostname)) {
      return { ok: false, error: '来源页面已经不在支持的电商站点上。' };
    }
    const payload = await collectFromTab(tabId);
    broadcast({ type: 'IG_RESULT_UPDATED', tabId: tabId, count: payload.items.length });
    return { ok: true, payload: payload };
  },

  /** 展示页请求下载（用于原图直链，以及 PNG 转换后的 blob 地址） */
  IG_DOWNLOAD: async function (msg, sender) {
    if (!msg.url || !msg.filename) throw new Error('下载参数不完整');
    const tabId = sender.tab ? sender.tab.id : -1;
    const downloadId = await startDownload(msg.url, msg.filename, tabId, msg.index);
    return { ok: true, downloadId: downloadId };
  },

  /** 在新标签页打开原始图片地址（下载受限时的兜底入口） */
  IG_OPEN_TAB: async function (msg) {
    if (!msg.url) throw new Error('缺少地址');
    const tab = await chrome.tabs.create({ url: msg.url, active: true });
    return { ok: true, tabId: tab.id };
  },

  /** 内容脚本上报 SPA 路由变化 */
  IG_TAB_NAVIGATED: async function (msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === 'number') await clearResult(tabId);
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;
  const handler = handlers[msg.type];
  if (!handler) return;

  Promise.resolve()
    .then(function () {
      return handler(msg, sender);
    })
    .then(function (result) {
      sendResponse(result);
    })
    .catch(function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });

  return true; // 保持异步响应通道
});

// ==========================================================================
// 生命周期清理
// ==========================================================================

chrome.tabs.onRemoved.addListener(function (tabId) {
  clearResult(tabId).catch(function () {});
});

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get('igSettings').then(function (stored) {
    if (!stored || !stored.igSettings) {
      return chrome.storage.local.set({ igSettings: CORE.DEFAULT_SETTINGS });
    }
    return undefined;
  });
});
