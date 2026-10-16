/**
 * 图提取 ImageGrab —— 采集核心（纯函数库）
 *
 * 这个文件会被四种环境加载，因此不能依赖任何 chrome.* API：
 *   1. 内容脚本（manifest.json 的 content_scripts 按顺序加载，挂到 globalThis.IGCore）
 *   2. 图片展示页 gallery.html（<script src="lib/extract-core.js">）
 *   3. Service Worker（background.js 里 importScripts）
 *   4. Node 测试（module.exports）
 *
 * 所有 DOM 相关的能力都通过 env 参数注入（getStyle / getRect），
 * 这样 Node 端可以用 jsdom 或手写桩对象直接测试，不需要真实浏览器。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.IGCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // 一、常量与配置
  // ==========================================================================

  /** 允许显示悬浮按钮与采集图片的站点根域名 */
  const SUPPORTED_HOSTS = ['taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'yangkeduo.com'];

  /** 站点分组，用于界面文案 */
  const SITES = [
    { key: 'taobao', name: '淘宝/天猫', hosts: ['taobao.com', 'tmall.com'] },
    { key: 'jd', name: '京东', hosts: ['jd.com'] },
    { key: 'pdd', name: '拼多多', hosts: ['pinduoduo.com', 'yangkeduo.com'] }
  ];

  /** 除了 src / currentSrc 之外，常见懒加载图片地址所在的属性 */
  const IMAGE_ATTRS = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-actualsrc',
    'data-ks-lazyload',
    'data-image',
    'data-echo',
    'data-imgsrc',
    'data-src-large',
    'data-lazyload-src'
  ];

  /** srcset 相关属性 */
  const SRCSET_ATTRS = ['srcset', 'data-srcset'];

  /** 只影响“去重键”计算、不会从下载地址里删除的追踪参数 */
  const TRACKING_PARAMS = [
    'spm',
    'scm',
    'spm_id_from',
    'from',
    '_t',
    'ali_trackid',
    'utparam',
    'ut_sk',
    'abtest',
    'u_chk',
    'srcid'
  ];

  /** 明显不是商品图的 URL 路径关键词（按路径分段做整词匹配，避免 logotype 误判） */
  const BLOCK_KEYWORDS = [
    'icon',
    'icons',
    'sprite',
    'logo',
    'logos',
    'avatar',
    'placeholder',
    'placehold',
    'blank',
    'spacer',
    'qrcode',
    'qr_code',
    'qr-code',
    '1x1',
    'pixel',
    'transparent',
    'no_img',
    'noimg',
    'loading',
    'error_img',
    'broken'
  ];

  /** 统计、埋点类域名，通常返回 1x1 像素，直接过滤 */
  const BLOCK_HOSTS = [
    'mmstat.com',
    'cnzz.com',
    'doubleclick.net',
    'google-analytics.com',
    'googletagmanager.com',
    'hotjar.com',
    'clarity.ms',
    'umeng.com',
    'umengcloud.com',
    'aldstat.com',
    'talkingdata.com',
    'tanx.com',
    'admaster.com.cn'
  ];

  /** 末尾是这些扩展名的一定不是商品图片 */
  const NOT_IMAGE_EXT = [
    'js',
    'css',
    'html',
    'htm',
    'json',
    'xml',
    'mp4',
    'webm',
    'm3u8',
    'pdf',
    'zip',
    'woff',
    'woff2',
    'ttf',
    'svg'
  ];

  /** 原始图片地址里出现这些参数时视为“带签名直链”，不做任何 URL 改写 */
  const SIGNED_KEYS = [
    'signature',
    'expires',
    'ossaccesskeyid',
    'x-oss-signature',
    'x-oss-credential',
    'auth_key',
    'token',
    'sign',
    'sk'
  ];

  /** 采集行为默认值（内容脚本会把用户设置合并进来） */
  const DEFAULT_OPTIONS = {
    minSize: 100, // 宽高都小于该值时判定为图标/占位图
    includeBackground: true, // 是否处理 CSS background-image
    scanScripts: false, // 是否在 <script> 文本里做图片地址正则扫描（实验性）
    preferOriginal: false, // 是否尝试改写为“原图直链”（实验性）
    allowDataUrl: false, // 是否保留 data: URI（默认丢弃）
    debug: false // 为 true 时额外返回过滤前的候选列表，仅用于排查问题
  };

  /** 全局设置默认值（存于 chrome.storage.local 的 igSettings，不含 debug） */
  const DEFAULT_SETTINGS = {
    minSize: DEFAULT_OPTIONS.minSize,
    includeBackground: DEFAULT_OPTIONS.includeBackground,
    scanScripts: DEFAULT_OPTIONS.scanScripts,
    preferOriginal: DEFAULT_OPTIONS.preferOriginal,
    allowDataUrl: DEFAULT_OPTIONS.allowDataUrl,
    convertToPng: true, // 下载时是否转 PNG
    fallbackOriginal: true // 转 PNG 失败时是否回退为原格式下载
  };

  const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|avif)(?=[._!]|$)/i;

  // ==========================================================================
  // 二、站点识别
  // ==========================================================================

  /** 判断 hostname 是否属于支持的电商站点（含子域名） */
  function isSupportedHost(host) {
    if (!host) return false;
    const h = String(host).toLowerCase();
    return SUPPORTED_HOSTS.some(function (suffix) {
      return h === suffix || h.endsWith('.' + suffix);
    });
  }

  /** 返回站点分组信息，未知站点返回 null */
  function detectSite(host) {
    if (!host) return null;
    const h = String(host).toLowerCase();
    for (const site of SITES) {
      for (const suffix of site.hosts) {
        if (h === suffix || h.endsWith('.' + suffix)) return { key: site.key, name: site.name, host: h };
      }
    }
    return null;
  }

  /**
   * 粗判页面类型，只用于决定是否显示悬浮按钮。
   * 'product' 命中了常见商品详情页 URL 规则；'auth' 是登录类页面；其余为 'other'。
   */
  function detectPageKind(url) {
    const s = String(url || '');
    if (/(^|\/\/)(login|passport|signin|register|reg)\.|\/(login|signin|register|signup)([\/?#.]|$)/i.test(s)) {
      return 'auth';
    }
    const productRe = new RegExp(
      [
        'item\\.taobao\\.com/item\\.htm',
        'detail\\.tmall\\.com/item\\.htm',
        'chaoshi\\.detail\\.tmall\\.com/item\\.htm',
        'item\\.jd\\.com/\\d+\\.html',
        'item\\.m\\.jd\\.com/product/\\d+',
        'item\\.jd\\.hk/\\d+\\.html',
        'mobile\\.yangkeduo\\.com/goods',
        'mobile\\.pinduoduo\\.com/goods',
        'yangkeduo\\.com/goods',
        'pinduoduo\\.com/goods'
      ].join('|'),
      'i'
    );
    return productRe.test(s) ? 'product' : 'other';
  }

  // ==========================================================================
  // 三、URL 处理
  // ==========================================================================

  /** 把任意写法的地址补全为绝对地址；非 http(s) 与 data: 一律返回 null */
  function toAbsoluteUrl(raw, base) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (s.startsWith('data:')) return s;
    if (s.startsWith('blob:')) return null;
    if (/^(about|javascript|mailto|tel|chrome|chrome-extension):/i.test(s)) return null;
    if (s.startsWith('//')) s = 'https:' + s;
    try {
      const u = new URL(s, base || undefined);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  /**
   * 计算去重用的归一化键：统一 https、主机名小写、去掉 hash 与追踪参数。
   * 注意这个结果只用于判重，下载仍然使用原始地址，避免破坏带签名的直链。
   */
  function normalizeForCompare(raw, base) {
    const abs = toAbsoluteUrl(raw, base);
    if (!abs) return null;
    if (abs.startsWith('data:')) return abs.slice(0, 160);
    try {
      const u = new URL(abs);
      if (u.protocol === 'http:') u.protocol = 'https:';
      u.hostname = u.hostname.toLowerCase();
      u.hash = '';
      for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
      let s = u.toString();
      if (s.endsWith('?')) s = s.slice(0, -1);
      return s;
    } catch (e) {
      return abs;
    }
  }

  /**
   * 猜测图片真实扩展名。取路径里第一个扩展名，因为淘宝/拼多多的缩略图后缀
   * 会写成 xxx.jpg_430x430q90.jpg 这种形式，第一个 .jpg 才是原图格式。
   */
  function guessExtension(url) {
    let path = '';
    try {
      path = new URL(String(url)).pathname;
    } catch (e) {
      return 'jpg';
    }
    path = path.replace(/_\.webp$/i, '');
    const m = path.match(IMG_EXT_RE);
    if (!m) return 'jpg';
    let ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    return ext;
  }

  /** 解析 srcset，返回按“优先级”从大到小排序的候选列表 */
  function parseSrcset(value) {
    if (!value) return [];
    const text = String(value).trim();
    if (!text) return [];
    const out = [];
    // data: URI 中带逗号，这里对 data: 片段做整体跳过，避免切错
    const parts = text.split(/,(?=\s*(?:https?:|\/\/|[^\s,]+?\.(?:jpe?g|png|gif|webp|avif)))/i);
    for (const partRaw of parts) {
      const part = partRaw.trim();
      if (!part) continue;
      const sp = part.split(/\s+/);
      const url = sp[0];
      if (!url || url.startsWith('data:')) continue;
      let score = 1;
      if (sp[1]) {
        if (/^\d+(?:\.\d+)?x$/i.test(sp[1])) score = parseFloat(sp[1]);
        else if (/^\d+w$/i.test(sp[1])) score = parseInt(sp[1], 10);
        else if (/^\d+h$/i.test(sp[1])) score = parseInt(sp[1], 10);
      }
      out.push({ url: url, score: score });
    }
    out.sort(function (a, b) {
      return b.score - a.score;
    });
    return out;
  }

  /** 从 background-image 的 CSS 值里提取所有图片地址 */
  function extractUrlsFromCss(value) {
    if (!value || value === 'none') return [];
    const out = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m;
    while ((m = re.exec(value)) !== null) {
      const raw = (m[2] || '').trim();
      if (!raw || raw.startsWith('data:')) continue;
      if (raw.startsWith('#')) continue; // element(#id) 之类的引用
      out.push(raw);
    }
    return out;
  }

  /**
   * 实验性：尝试把缩略图地址改写为原图地址。
   * 覆盖淘宝/拼多多的 _430x430q90.jpg 后缀、京东的 /n5/ 与 s400x400_ 前缀。
   * 带签名参数的地址直接原样返回，避免把链接改坏。
   */
  function toOriginalUrl(url) {
    let u;
    try {
      u = new URL(String(url));
    } catch (e) {
      return url;
    }
    let keys = [];
    try {
      keys = Array.from(u.searchParams.keys()).map(function (k) {
        return k.toLowerCase();
      });
    } catch (e) {
      keys = [];
    }
    if (keys.some(function (k) { return SIGNED_KEYS.indexOf(k) >= 0; })) return url;

    const segments = u.pathname.split('/').map(function (seg) {
      if (/^n[1-9]$/.test(seg)) return 'n0'; // 京东尺寸目录 /n5/ -> /n0/
      let s = seg.replace(/^s\d+x\d+_/i, ''); // 京东 s400x400_jfs -> jfs
      s = s.replace(/(\.(?:jpe?g|png|gif|webp|bmp|avif))_\d+x\d+[^/]*$/i, '$1');
      s = s.replace(/(\.(?:jpe?g|png|gif|webp|bmp|avif))![^/]*$/i, '$1');
      return s;
    });
    u.pathname = segments.join('/');
    u.search = '';
    return u.toString();
  }

  /**
   * 在任意文本（例如 <script> 内容）中扫描图片直链，用于实验性的脚本扫描模式。
   * 同时覆盖两种写法：
   *   1. 绝对地址或协议相对地址，如 https://img.../a.jpg
   *   2. 被引号包起来的相对地址，如 "/img/a.jpg"、"assets/a.png?x=1"
   */
  function extractUrlsFromText(text, limit) {
    if (!text) return [];
    const max = limit || 300;
    const normalized = String(text).replace(/\\\//g, '/'); // 反转义 JSON 里的 \/
    const out = [];
    const seen = new Set();

    const patterns = [
      { re: /(?:https?:)?\/\/[^\s"'`<>\\()[\]{}]+?\.(?:jpe?g|png|gif|webp|avif)(?:[^\s"'`<>\\()[\]{}]*)?/gi, group: 0 },
      { re: /["']([^"'\s<>]{2,400}?\.(?:jpe?g|png|gif|webp|avif)(?:\?[^"'\s<>]{0,200})?)["']/gi, group: 1 }
    ];

    for (const { re, group } of patterns) {
      let m;
      while ((m = re.exec(normalized)) !== null) {
        const raw = m[group];
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);
        out.push(raw);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  // ==========================================================================
  // 四、过滤与去重
  // ==========================================================================

  /** 主机名是否命中埋点黑名单 */
  function isBlockedHost(host) {
    if (!host) return false;
    const h = String(host).toLowerCase();
    return BLOCK_HOSTS.some(function (b) {
      return h === b || h.endsWith('.' + b);
    });
  }

  /** URL 是否命中图标 / 占位图关键词（按路径分段整词匹配） */
  function isBlockedUrl(url) {
    let u;
    try {
      u = new URL(String(url));
    } catch (e) {
      return false;
    }
    if (isBlockedHost(u.hostname)) return true;
    if (u.pathname === '/' || u.pathname === '') return true;
    const tokens = u.pathname.toLowerCase().split(/[\/_\-.!]+/);
    for (const kw of BLOCK_KEYWORDS) {
      if (tokens.indexOf(kw) >= 0) return true;
    }
    return false;
  }

  /** 末位扩展名是否属于“确定不是图片”的类别 */
  function hasNonImageExtension(url) {
    let path = '';
    try {
      path = new URL(String(url)).pathname.toLowerCase();
    } catch (e) {
      return false;
    }
    const last = path.split('/').pop() || '';
    const idx = last.lastIndexOf('.');
    if (idx < 0) return false;
    const ext = last.slice(idx + 1);
    return NOT_IMAGE_EXT.indexOf(ext) >= 0;
  }

  /**
   * 过滤原始候选，返回 { kept, stats }。
   * 尺寸过滤只在宽高都已确定时才生效，避免把“尚未加载的懒加载真图”误杀。
   */
  function filterItems(rawItems, options) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const kept = [];
    const dropped = { invalid: 0, dataUrl: 0, blocked: 0, notImage: 0, tooSmall: 0 };

    for (const raw of rawItems || []) {
      const abs = toAbsoluteUrl(raw.url, raw.base);
      if (!abs) {
        dropped.invalid++;
        continue;
      }
      if (abs.startsWith('data:')) {
        if (!opts.allowDataUrl) {
          dropped.dataUrl++;
          continue;
        }
      }
      if (isBlockedUrl(abs)) {
        dropped.blocked++;
        continue;
      }
      if (hasNonImageExtension(abs)) {
        dropped.notImage++;
        continue;
      }
      const w = Number(raw.fw != null ? raw.fw : raw.width) || 0;
      const h = Number(raw.fh != null ? raw.fh : raw.height) || 0;
      if (opts.minSize > 0 && w > 0 && h > 0 && w < opts.minSize && h < opts.minSize) {
        dropped.tooSmall++;
        continue;
      }
      const original = opts.preferOriginal ? toOriginalUrl(abs) : null;
      kept.push({
        url: abs,
        originalUrl: original && original !== abs ? original : null,
        key: normalizeForCompare(abs),
        width: w,
        height: h,
        loaded: !!raw.loaded,
        source: raw.source || 'img',
        alt: raw.alt || '',
        ext: guessExtension(abs)
      });
    }

    return { kept: kept, dropped: dropped };
  }

  /** 按归一化键去重：保留“已加载且有尺寸”的那一条 */
  function dedupeItems(items) {
    const map = new Map();
    for (const item of items || []) {
      const key = item.key || normalizeForCompare(item.url);
      if (!key) continue;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, item);
        continue;
      }
      const prevArea = (prev.width || 0) * (prev.height || 0);
      const curArea = (item.width || 0) * (item.height || 0);
      const prevKnown = prev.loaded && prevArea > 0;
      const curKnown = item.loaded && curArea > 0;
      if (curKnown && (!prevKnown || curArea > prevArea)) map.set(key, item);
    }
    return Array.from(map.values());
  }

  // ==========================================================================
  // 五、文件名
  // ==========================================================================

  /** 生成 商品图_001.png 形式的文件名 */
  function buildFileName(index, total, ext, prefix) {
    const p = prefix == null ? '商品图' : String(prefix);
    const width = Math.max(3, String(Math.max(total || 1, 1)).length);
    const n = String(index).padStart(width, '0');
    const e = String(ext || 'png').toLowerCase().replace(/^\./, '');
    return p + '_' + n + '.' + e;
  }

  // ==========================================================================
  // 六、DOM 采集（核心入口）
  // ==========================================================================

  const BG_CLASS_RE = /(pic|img|image|thumb|photo|banner|slide|bg|cover|album)/i;

  /**
   * 遍历文档采集图片候选。
   *
   * @param {Document} doc 目标文档
   * @param {object} options 采集选项，见 DEFAULT_OPTIONS
   * @param {object} env 环境适配层，{ getStyle(el), getRect(el), maxElements }
   * @returns {{items: Array, stats: object}}
   */
  function collectFromDocument(doc, options, env) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const e = Object.assign(
      {
        getStyle: function (el) {
          return typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
        },
        getRect: function (el) {
          return el && el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        },
        maxElements: 25000
      },
      env || {}
    );

    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return { items: [], stats: { raw: 0, kept: 0, duplicate: 0, scannedElements: 0, dropped: {} } };
    }

    const base = doc.baseURI || doc.URL || undefined;
    const candidates = [];
    let scanned = 0;

    const push = function (rawUrl, source, width, height, loaded, alt, fw, fh) {
      if (!rawUrl) return;
      candidates.push({
        url: rawUrl,
        base: base,
        width: width,
        height: height,
        // 过滤专用的尺寸：取真实像素、HTML 属性、渲染盒子三者的最大值
        fw: fw == null ? width : fw,
        fh: fh == null ? height : fh,
        loaded: loaded,
        source: source,
        alt: alt || ''
      });
    };

    const readImg = function (el) {
      const natW = Number(el.naturalWidth) || 0;
      const natH = Number(el.naturalHeight) || 0;
      const rect = e.getRect(el) || { width: 0, height: 0 };
      const attrW = parseInt(el.getAttribute('width') || '', 10) || 0;
      const attrH = parseInt(el.getAttribute('height') || '', 10) || 0;
      const rectW = Math.round(rect.width) || 0;
      const rectH = Math.round(rect.height) || 0;
      // 展示用的尺寸：优先真实像素，其次 HTML 属性，最后退回渲染尺寸
      const width = natW || attrW || rectW;
      const height = natH || attrH || rectH;
      // 过滤用的尺寸取三者最大值。懒加载图片的 naturalWidth 往往只是占位图的
      // 1x1，若直接用真实像素判定“过小”，会把真正的商品大图误杀掉。
      const fw = Math.max(natW, attrW, rectW);
      const fh = Math.max(natH, attrH, rectH);
      const loaded = natW > 0 && natH > 0;
      const alt = el.getAttribute('alt') || '';

      if (el.currentSrc) push(el.currentSrc, 'img', width, height, loaded, alt, fw, fh);
      push(el.getAttribute('src'), 'img', width, height, loaded, alt, fw, fh);
      for (const attr of IMAGE_ATTRS) push(el.getAttribute(attr), 'img', width, height, loaded, alt, fw, fh);

      // srcset 只取最大候选，避免同一张图产生多个重复条目
      for (const attr of SRCSET_ATTRS) {
        const list = parseSrcset(el.getAttribute(attr));
        if (list.length) push(list[0].url, 'img', width, height, loaded, alt, fw, fh);
      }
    };

    const readBackground = function (el) {
      const style = e.getStyle(el);
      if (!style) return;
      const value = style.backgroundImage;
      if (!value || value === 'none') return;
      const urls = extractUrlsFromCss(value);
      if (!urls.length) return;
      const rect = e.getRect(el) || { width: 0, height: 0 };
      const w = Math.round(rect.width) || 0;
      const h = Math.round(rect.height) || 0;
      for (const u of urls) push(u, 'background', w, h, false, '', w, h);
    };

    // 单次遍历，保持 DOM 顺序；对非 img 元素只在“可疑是背景图”时才计算样式
    const all = doc.querySelectorAll('*');
    for (const el of all) {
      if (++scanned > e.maxElements) break;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'IMG') {
        readImg(el);
        continue;
      }
      if (!opts.includeBackground) continue;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META' || tag === 'HEAD') continue;
      const inlineStyle = el.getAttribute('style') || '';
      const cls = el.getAttribute('class') || '';
      const maybeBackground = /background/i.test(inlineStyle) || BG_CLASS_RE.test(cls);
      if (maybeBackground) readBackground(el);
    }

    // 实验性：在 <script> 文本里扫描图片直链
    if (opts.scanScripts) {
      for (const s of doc.querySelectorAll('script')) {
        const text = s.textContent || '';
        if (text.length < 32) continue;
        for (const u of extractUrlsFromText(text)) push(u, 'script', 0, 0, false, '', 0, 0);
      }
    }

    const filtered = filterItems(candidates, opts);
    const deduped = dedupeItems(filtered.kept);

    const output = {
      items: deduped,
      stats: {
        raw: candidates.length,
        kept: deduped.length,
        duplicate: filtered.kept.length - deduped.length,
        scannedElements: scanned,
        dropped: filtered.dropped
      }
    };

    // debug 模式额外返回过滤前的候选，方便在真实站点上排查“为什么某张图没被采集到”
    if (opts.debug) {
      output.candidates = candidates.map(function (c) {
        return {
          url: c.url,
          source: c.source,
          width: c.width,
          height: c.height,
          fw: c.fw,
          fh: c.fh,
          loaded: c.loaded,
          blocked: isBlockedUrl(c.url),
          nonImage: hasNonImageExtension(c.url)
        };
      });
    }

    return output;
  }

  // ==========================================================================
  // 导出
  // ==========================================================================

  return {
    // 常量
    SUPPORTED_HOSTS: SUPPORTED_HOSTS,
    SITES: SITES,
    IMAGE_ATTRS: IMAGE_ATTRS,
    SRCSET_ATTRS: SRCSET_ATTRS,
    BLOCK_KEYWORDS: BLOCK_KEYWORDS,
    BLOCK_HOSTS: BLOCK_HOSTS,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    // 站点
    isSupportedHost: isSupportedHost,
    detectSite: detectSite,
    detectPageKind: detectPageKind,
    // URL
    toAbsoluteUrl: toAbsoluteUrl,
    normalizeForCompare: normalizeForCompare,
    guessExtension: guessExtension,
    parseSrcset: parseSrcset,
    extractUrlsFromCss: extractUrlsFromCss,
    extractUrlsFromText: extractUrlsFromText,
    toOriginalUrl: toOriginalUrl,
    // 过滤
    isBlockedHost: isBlockedHost,
    isBlockedUrl: isBlockedUrl,
    hasNonImageExtension: hasNonImageExtension,
    filterItems: filterItems,
    dedupeItems: dedupeItems,
    // 文件名
    buildFileName: buildFileName,
    // 采集
    collectFromDocument: collectFromDocument
  };
});
