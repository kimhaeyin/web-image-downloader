/**
 * 图提取 ImageGrab —— 内容脚本
 *
 * 职责：
 *   1. 判断当前站点是否受支持，不受支持的站点直接退出，不注入任何 UI。
 *   2. 在页面右下角渲染“获取图片”悬浮按钮（Shadow DOM，样式相互隔离）。
 *   3. 采集当前页面的商品图片候选（只读取 DOM，不发起任何跨域请求）。
 *   4. 响应 Service Worker 的采集请求，返回过滤去重后的结果。
 *
 * 安全边界：不读取 Cookie，不绕过登录，不伪造 Referer，不修改页面业务数据。
 */
(function () {
  'use strict';

  // 防止内容脚本被重复注入（扩展安装前打开的页面需要通过 scripting 补注入）
  if (globalThis.__IMAGE_GRAB_LOADED__) return;
  globalThis.__IMAGE_GRAB_LOADED__ = true;

  const CORE = globalThis.IGCore;
  if (!CORE) {
    console.warn('[图提取] 采集核心 lib/extract-core.js 未加载，内容脚本退出');
    return;
  }

  const host = location.hostname || '';
  if (!CORE.isSupportedHost(host)) return; // 其他网站不显示按钮

  const site = CORE.detectSite(host);
  const pageKind = CORE.detectPageKind(location.href);
  if (pageKind === 'auth') return; // 登录 / 注册页不显示按钮

  let settings = Object.assign({}, CORE.DEFAULT_SETTINGS);
  let lastStats = null;
  let lastCount = 0;
  let ui = null;
  let currentUrl = location.href;

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

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.igSettings) {
        settings = Object.assign({}, CORE.DEFAULT_SETTINGS, changes.igSettings.newValue || {});
      }
    });
  } catch (err) {
    /* 忽略：设置监听失败不影响采集 */
  }

  // ==========================================================================
  // 采集
  // ==========================================================================

  function collect() {
    const result = CORE.collectFromDocument(document, settings);
    lastStats = result.stats;
    lastCount = result.items.length;
    return result;
  }

  /** 采集结果的摘要文案，用于提示条与计数徽标 */
  function describeStats(stats) {
    if (!stats) return '';
    const d = stats.dropped || {};
    const parts = [];
    parts.push('候选 ' + stats.raw + ' 张');
    parts.push('去重 ' + stats.duplicate + ' 张');
    const blocked = (d.blocked || 0) + (d.notImage || 0) + (d.dataUrl || 0) + (d.invalid || 0);
    if (blocked) parts.push('过滤 ' + blocked + ' 张');
    if (d.tooSmall) parts.push('过小 ' + d.tooSmall + ' 张');
    return parts.join('・');
  }

  // ==========================================================================
  // 消息处理
  // ==========================================================================

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'IG_PING') {
      sendResponse({ ok: true, site: site ? site.name : '', pageKind: pageKind });
      return;
    }

    if (msg.type === 'IG_COLLECT_REQUEST') {
      try {
        const result = collect();
        if (ui) ui.setCount(result.items.length);
        sendResponse({
          ok: true,
          items: result.items,
          stats: result.stats,
          site: site ? site.name : '',
          pageKind: pageKind,
          pageUrl: location.href,
          pageTitle: document.title
        });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return;
    }

    if (msg.type === 'IG_SETTINGS_CHANGED') {
      loadSettings();
      return;
    }
  });

  // ==========================================================================
  // 界面
  // ==========================================================================

  const CSS_URL = chrome.runtime.getURL('content.css');

  function createUi() {
    const hostEl = document.createElement('div');
    hostEl.id = 'imagegrab-host';
    hostEl.setAttribute('data-imagegrab', '1');

    const shadow = hostEl.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    shadow.appendChild(link);

    const wrap = document.createElement('div');
    wrap.className = 'ig-wrap';

    const mainBtn = document.createElement('button');
    mainBtn.className = 'ig-btn';
    mainBtn.type = 'button';
    mainBtn.title = '提取本页商品图片并集中预览下载';

    const icon = document.createElement('span');
    icon.className = 'ig-btn-icon';
    const text = document.createElement('span');
    text.className = 'ig-btn-text';
    text.textContent = '获取图片';
    const badge = document.createElement('span');
    badge.className = 'ig-badge';
    badge.textContent = '0';
    badge.setAttribute('data-empty', '1');

    mainBtn.appendChild(icon);
    mainBtn.appendChild(text);
    mainBtn.appendChild(badge);

    const miniBtn = document.createElement('button');
    miniBtn.className = 'ig-mini';
    miniBtn.type = 'button';
    miniBtn.title = '收起按钮（不会遮挡页面操作）';
    miniBtn.textContent = '×';

    const dotBtn = document.createElement('button');
    dotBtn.className = 'ig-dot';
    dotBtn.type = 'button';
    dotBtn.title = '展开图提取按钮';

    const toast = document.createElement('div');
    toast.className = 'ig-toast';

    wrap.appendChild(mainBtn);
    wrap.appendChild(miniBtn);
    wrap.appendChild(dotBtn);
    wrap.appendChild(toast);
    shadow.appendChild(wrap);

    let toastTimer = null;

    function showToast(message, tone) {
      toast.textContent = message;
      toast.setAttribute('data-show', '1');
      if (tone) toast.setAttribute('data-tone', tone);
      else toast.removeAttribute('data-tone');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toast.setAttribute('data-show', '0');
      }, 3600);
    }

    function setLoading(loading) {
      if (loading) mainBtn.setAttribute('data-loading', '1');
      else mainBtn.removeAttribute('data-loading');
      text.textContent = loading ? '提取中…' : '获取图片';
    }

    function setCount(count) {
      lastCount = count;
      badge.textContent = String(count);
      if (count > 0) badge.removeAttribute('data-empty');
      else badge.setAttribute('data-empty', '1');
    }

    mainBtn.addEventListener('click', function () {
      if (mainBtn.getAttribute('data-loading') === '1') return;
      setLoading(true);
      chrome.runtime
        .sendMessage({ type: 'IG_START' })
        .then(function (res) {
          setLoading(false);
          if (!res || !res.ok) {
            showToast('提取失败：' + ((res && res.error) || '未知错误'), 'error');
            return;
          }
          setCount(res.count || 0);
          if (!res.count) {
            showToast('当前页面没有采集到符合条件的商品图片。\n可以试试先滚动页面加载懒加载图片，或切换商品规格后再试。', 'error');
          } else {
            showToast('已提取 ' + res.count + ' 张图片，正在打开展示页…', 'ok');
          }
        })
        .catch(function (err) {
          setLoading(false);
          showToast('提取失败：' + String((err && err.message) || err), 'error');
        });
    });

    miniBtn.addEventListener('click', function () {
      wrap.setAttribute('data-collapsed', '1');
    });
    dotBtn.addEventListener('click', function () {
      wrap.removeAttribute('data-collapsed');
    });

    // 挂到 documentElement，尽量减少被页面容器裁剪或覆盖的可能
    document.documentElement.appendChild(hostEl);

    ui = {
      hostEl: hostEl,
      setCount: setCount,
      showToast: showToast,
      setLoading: setLoading
    };
    return ui;
  }

  /** 页面重渲染时按钮可能被移除，低频检测并重新挂载 */
  function watchRemoval() {
    if (!ui) return;
    let scheduled = false;
    const observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        if (!ui) return;
        if (!document.documentElement.contains(ui.hostEl)) {
          document.documentElement.appendChild(ui.hostEl);
        }
      }, 800);
    });
    observer.observe(document.documentElement, { childList: true });
  }

  // ==========================================================================
  // 单页应用（SPA）路由变化检测
  // ==========================================================================

  function notifyNavigation() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    chrome.runtime.sendMessage({ type: 'IG_TAB_NAVIGATED', url: currentUrl }).catch(function () {});
    if (ui) {
      ui.setCount(0);
      ui.showToast('页面已切换，请重新点击“获取图片”', 'ok');
    }
  }

  function watchNavigation() {
    // Navigation API 能观察到页面自己发起的同文档导航（内容脚本运行在隔离世界，
    // 直接包装 page 的 history.pushState 是观察不到的）
    if (typeof window.navigation !== 'undefined' && window.navigation) {
      try {
        window.navigation.addEventListener('navigate', function () {
          setTimeout(notifyNavigation, 300);
        });
        return;
      } catch (err) {
        /* 退回轮询 */
      }
    }
    setInterval(notifyNavigation, 1500);
  }

  // ==========================================================================
  // 启动
  // ==========================================================================

  loadSettings().then(function () {
    createUi();
    if (pageKind !== 'product' && ui) {
      ui.hostEl.title = '图提取 ImageGrab（当前页面不是标准商品详情页，仍可尝试提取）';
    }
    watchRemoval();
    watchNavigation();
  });
})();
