/**
 * 图提取 ImageGrab 官网脚本（原生 JavaScript，无任何依赖）。
 *
 * 负责四件事：
 *   1. 顶部导航：移动端抽屉的展开 / 收起，以及滚动后给头部加分隔线。
 *   2. 滚动进入动画：用 IntersectionObserver 给 [data-reveal] 打上 data-revealed="1"。
 *   3. 页脚的年份与 GitHub 仓库链接。
 *   4. 下载区里安装包的真实信息：版本号、文件数量、包体大小、SHA-256 校验值。
 *
 * 第 4 点刻意不写死任何数字，也不额外生成一份“元数据文件”，而是直接读取
 * downloads/imagegrab.zip 的字节：从 ZIP 中央目录里数出文件数量并解出
 * manifest.json 拿到版本号，再用 Web Crypto 算出整包的 SHA-256。
 * 这样一来，页面上显示的就是用户即将下载到的那份文件的真实信息。
 */

(function () {
  'use strict';

  /**
   * 仓库地址。
   *
   * 这里留空时，页脚的「GitHub 仓库」链接会被隐藏，而不是指向一个假地址。
   * 换上你自己的仓库地址（例如 https://github.com/你的用户名/web-image-downloader）
   * 之后，链接会自动出现。也可以用 <a id="repoLink" data-repo="..."> 覆盖。
   */
  const REPO_URL = '';

  const ZIP_URL = 'downloads/imagegrab.zip';

  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ==========================================================================
  // 一、顶部导航
  // ==========================================================================

  function initHeader() {
    const header = document.getElementById('siteHeader');
    const toggle = document.getElementById('navToggle');
    const nav = document.getElementById('siteNav');

    // 滚动后给头部加一条分隔线（用 rAF 合并高频 scroll 事件）
    if (header) {
      let ticking = false;
      const sync = function () {
        ticking = false;
        header.setAttribute('data-scrolled', window.scrollY > 4 ? '1' : '0');
      };
      window.addEventListener(
        'scroll',
        function () {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(sync);
        },
        { passive: true }
      );
      sync();
    }

    if (!toggle || !nav) return;

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) nav.setAttribute('data-open', '1');
      else nav.removeAttribute('data-open');
    }

    function isOpen() {
      return toggle.getAttribute('aria-expanded') === 'true';
    }

    toggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });

    // 点了菜单里的链接就收起抽屉
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    // Esc 收起
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) setOpen(false);
    });

    // 点到抽屉和按钮以外的地方也收起
    document.addEventListener('click', function (event) {
      if (!isOpen()) return;
      if (event.target.closest('#siteNav') || event.target.closest('#navToggle')) return;
      setOpen(false);
    });

    // 视口变宽（回到桌面布局）时收起抽屉，避免留下一个隐藏的展开状态
    window.addEventListener('resize', function () {
      if (window.innerWidth > 860 && isOpen()) setOpen(false);
    });
  }

  // ==========================================================================
  // 二、滚动进入动画
  // ==========================================================================

  function initReveal() {
    const targets = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
    if (!targets.length) return;

    // 用户要求减少动效，或浏览器不支持 IntersectionObserver：直接显示
    if (prefersReducedMotion || typeof IntersectionObserver !== 'function') {
      targets.forEach(function (node) {
        node.setAttribute('data-revealed', '1');
      });
      return;
    }

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.setAttribute('data-revealed', '1');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );

    targets.forEach(function (node) {
      observer.observe(node);
    });
  }

  // ==========================================================================
  // 三、页脚年份与仓库链接
  // ==========================================================================

  function initFooter() {
    const year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());

    const link = document.getElementById('repoLink');
    if (!link) return;
    const url = link.getAttribute('data-repo') || REPO_URL;
    if (url) {
      link.setAttribute('href', url);
      return;
    }
    // 没有配置仓库地址时整条隐藏，而不是留一个点不动的链接
    const item = link.closest('li');
    if (item) item.hidden = true;
    else link.hidden = true;
  }

  // ==========================================================================
  // 四、安装包真实信息
  // ==========================================================================

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' 字节';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function toHex(buffer) {
    return Array.prototype.map
      .call(new Uint8Array(buffer), function (byte) {
        return byte.toString(16).padStart(2, '0');
      })
      .join('');
  }

  /** 从尾部向前找 ZIP 的中央目录结束记录（EOCD） */
  function findEocd(view, byteLength) {
    const lowest = Math.max(0, byteLength - 22 - 65535);
    for (let i = byteLength - 22; i >= lowest; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  /** 解析中央目录，拿到内部条目清单（不依赖任何第三方库） */
  function readCentralDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view, bytes.length);
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = [];

    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      entries.push({
        name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
        method: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localOffset: view.getUint32(offset + 42, true)
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  }

  /** 取出并解压一个条目 */
  async function readEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new Error(entry.name + ' 的本地文件头损坏');
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return raw; // 未压缩
    if (entry.method !== 8) throw new Error('不支持的压缩方式：' + entry.method);

    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function initPackageInfo() {
    const versionEl = document.getElementById('zipVersion');
    const sizeEl = document.getElementById('zipSize');
    const filesEl = document.getElementById('zipFiles');
    const hashEl = document.getElementById('zipHash');
    const noteEl = document.getElementById('zipNote');
    if (!versionEl || !sizeEl || !filesEl || !hashEl) return;

    try {
      if (!window.crypto || !window.crypto.subtle) throw new Error('当前环境不支持 SHA-256 计算');

      const url = new URL(ZIP_URL, window.location.href).href;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('安装包请求返回 HTTP ' + response.status);

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (!bytes.length) throw new Error('安装包是空文件');

      const entries = readCentralDirectory(bytes);

      let version = '';
      const manifest = entries.filter(function (e) {
        return e.name === 'manifest.json';
      })[0];
      if (manifest) {
        const data = await readEntry(bytes, manifest);
        version = String(JSON.parse(new TextDecoder('utf-8').decode(data)).version || '');
      }

      const hash = toHex(await window.crypto.subtle.digest('SHA-256', buffer));

      if (version) versionEl.textContent = version;
      filesEl.textContent = entries.length + ' 个';
      sizeEl.textContent = formatBytes(bytes.length);
      hashEl.textContent = hash;
      hashEl.title = hash;
    } catch (error) {
      // 读不到就保持占位符，并如实说明：下载按钮本身不依赖这段信息
      const reason = String((error && error.message) || error);
      if (noteEl) {
        noteEl.textContent = '暂时读不到安装包信息（' + reason + '），下载按钮可以直接使用。';
      }
    }
  }

  // ==========================================================================

  function main() {
    initHeader();
    initReveal();
    initFooter();
    initPackageInfo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
