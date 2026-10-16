/**
 * 浏览器端测试运行器：零依赖，直接用 CDP 驱动本机 Chromium 内核浏览器。
 *
 * 为什么要有这个文件：
 *   浏览器测试以前是靠手工在开发者工具里粘贴脚本跑的，结果无法复现，
 *   场景之间还会互相干扰。这个运行器把整套流程固定下来：
 *     1. 确认（必要时自动启动）本地静态服务器 http://127.0.0.1:4173
 *     2. 启动一个 headless 浏览器（Chrome 或 Edge，自动探测）
 *     3. 每个场景都新建一个独立标签页，跑完即关闭 —— 场景之间零共享状态
 *     4. 通过轮询页面里的真实完成信号来判断结束，不使用固定等待时间
 *     5. 汇总结果并以退出码反映成功与否
 *
 * 用法：
 *   node tests/browser/run-browser-tests.js                  # 跑全部
 *   node tests/browser/run-browser-tests.js --only=collector # 只跑采集测试
 *   node tests/browser/run-browser-tests.js --only=gallery   # 只跑展示页测试
 *   node tests/browser/run-browser-tests.js --only=site      # 只跑官网自检
 *   node tests/browser/run-browser-tests.js --headed         # 显示浏览器窗口
 *   IG_BROWSER="C:\path\to\chrome.exe" node tests/browser/run-browser-tests.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BASE_URL = 'http://127.0.0.1:4173';
const GALLERY_URL = BASE_URL + '/extension/gallery.html?tab=1';
const COLLECTOR_URL = BASE_URL + '/tests/browser/collector-fixture.html';
const SITE_URL = BASE_URL + '/docs/index.html';

/** 展示页测试的场景列表，顺序执行（需与 tests/browser/gallery-test.js 里的 runners 一致） */
const GALLERY_SCENARIOS = ['render', 'nofallback', 'fallback', 'empty', 'reset'];

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find(function (a) { return a.indexOf('--only=') === 0; }) || '').slice(7) || 'all';
const HEADED = ARGS.indexOf('--headed') >= 0;
/** --shot=<路径>：官网自检结束后把整页截图存下来，便于人工看一眼版式 */
const SHOT = (ARGS.find(function (a) { return a.indexOf('--shot=') === 0; }) || '').slice(7);
/** --shot-selector=<CSS 选择器>：只截取某个区块，便于放大看细节 */
const SHOT_SELECTOR = (ARGS.find(function (a) { return a.indexOf('--shot-selector=') === 0; }) || '').slice(16);

// ===========================================================================
// 一、找一个可用的浏览器
// ===========================================================================

function findBrowser() {
  if (process.env.IG_BROWSER) {
    if (fs.existsSync(process.env.IG_BROWSER)) return process.env.IG_BROWSER;
    throw new Error('环境变量 IG_BROWSER 指向的路径不存在：' + process.env.IG_BROWSER);
  }

  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';

  const candidates = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  for (const exe of candidates) {
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error(
    '没有找到 Chrome / Edge。请安装其中之一，或用 IG_BROWSER 环境变量指定浏览器可执行文件路径。'
  );
}

// ===========================================================================
// 二、极简 CDP 客户端
// ===========================================================================

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.onEvent = function () {};
  }

  static connect(wsUrl) {
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(function () {
        reject(new Error('连接 CDP 超时'));
      }, 20000);
      ws.onopen = function () {
        clearTimeout(timer);
        const cdp = new Cdp(ws);
        ws.onmessage = function (event) {
          cdp.handle(event.data);
        };
        resolve(cdp);
      };
      ws.onerror = function () {
        clearTimeout(timer);
        reject(new Error('无法连接 CDP：' + wsUrl));
      };
    });
  }

  handle(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (err) {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP 调用失败'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method) this.onEvent(msg);
  }

  send(method, params, sessionId, timeoutMs) {
    const id = ++this.seq;
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    const self = this;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new Error('CDP 调用超时：' + method));
      }, timeoutMs || 60000);
      self.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      self.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (err) {
      /* 忽略 */
    }
  }
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** 在指定会话里求值；awaitPromise 为真时会等待 Promise 完成 */
async function evaluate(cdp, sessionId, expression, awaitPromise) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression: expression, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true },
    sessionId,
    120000
  );
  if (res.exceptionDetails) {
    const det = res.exceptionDetails;
    const text =
      (det.exception && (det.exception.description || det.exception.value)) || det.text || '未知异常';
    throw new Error('页面内脚本抛出异常：' + text);
  }
  return res.result ? res.result.value : undefined;
}

/** 轮询直到 predicate 成立；predicate 可以是同步函数或返回 Promise */
async function waitUntil(label, predicate, timeoutMs, intervalMs) {
  const limit = Date.now() + (timeoutMs || 15000);
  let lastError = null;
  while (Date.now() < limit) {
    try {
      if (await predicate()) return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs || 50);
  }
  if (lastError) throw lastError;
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + label);
}

// ===========================================================================
// 三、静态服务器
// ===========================================================================

async function serverIsUp() {
  try {
    const res = await fetch(BASE_URL + '/extension/gallery.html', { method: 'HEAD' });
    return res.ok;
  } catch (err) {
    return false;
  }
}

async function ensureServer() {
  if (await serverIsUp()) {
    console.log('静态服务器已在运行：' + BASE_URL + '（直接复用）');
    return null;
  }
  console.log('静态服务器未运行，正在启动 tools/serve.js …');
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js')], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  await waitUntil('静态服务器就绪', serverIsUp, 15000, 200);
  console.log('静态服务器已启动：' + BASE_URL);
  return child;
}

// ===========================================================================
// 四、浏览器进程
// ===========================================================================

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', function () {
      const port = srv.address().port;
      srv.close(function () {
        resolve(port);
      });
    });
  });
}

async function launchBrowser(exe, port, profileDir) {
  const args = [
    HEADED ? '--window-size=1280,900' : '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-gpu',
    '--mute-audio',
    '--metrics-recording-only',
    'about:blank'
  ];

  const child = spawn(exe, args, { stdio: 'ignore' });

  let wsUrl = null;
  await waitUntil(
    '浏览器调试端口就绪',
    async function () {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (!res.ok) return false;
        const info = await res.json();
        wsUrl = info.webSocketDebuggerUrl;
        return !!wsUrl;
      } catch (err) {
        return false;
      }
    },
    30000,
    200
  );

  return { child: child, wsUrl: wsUrl };
}

/** 打开一个新标签页并附加会话，返回 sessionId 与关闭函数 */
async function openTarget(cdp, url) {
  const created = await cdp.send('Target.createTarget', { url: url || 'about:blank' });
  const targetId = created.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId: targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const close = async function () {
    try {
      await cdp.send('Target.closeTarget', { targetId: targetId });
    } catch (err) {
      /* 忽略 */
    }
  };
  return { targetId: targetId, sessionId: sessionId, close: close };
}

async function navigateAndWait(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url: url }, sessionId);
  await waitUntil(
    '页面加载完成：' + url,
    async function () {
      return (await evaluate(cdp, sessionId, 'document.readyState')) === 'complete';
    },
    30000,
    100
  );
}

// ===========================================================================
// 五、采集逻辑测试（页面自带断言，运行器只负责取结果）
// ===========================================================================

async function runCollector(cdp) {
  console.log('\n=== 浏览器采集测试（真实 DOM / 真实尺寸） ===');
  const target = await openTarget(cdp, COLLECTOR_URL);
  try {
    await waitUntil(
      '页面加载完成：' + COLLECTOR_URL,
      async function () {
        return (await evaluate(cdp, target.sessionId, 'document.readyState')) === 'complete';
      },
      30000,
      100
    );

    // 等待页面里的真实完成信号：断言结果对象被写出来
    await waitUntil(
      'collector-fixture.html 写出断言结果',
      async function () {
        return (await evaluate(cdp, target.sessionId, '!!window.__COLLECT_TESTS__')) === true;
      },
      30000,
      100
    );

    const report = await evaluate(cdp, target.sessionId, 'window.__COLLECT_TESTS__');
    printReport('采集测试', report);

    const images = await evaluate(
      cdp,
      target.sessionId,
      'JSON.stringify(Array.from(document.images).map(function (i) { return { src: i.getAttribute("src"), naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, complete: i.complete }; }))'
    );
    console.log('\n图片实际加载情况（交叉验证用）：');
    JSON.parse(images).forEach(function (img) {
      console.log(
        '  ' + String(img.src).padEnd(28, ' ') +
          ' natural=' + String(img.naturalWidth + 'x' + img.naturalHeight).padStart(9, ' ') +
          ' 加载完成=' + img.complete
      );
    });

    const collected = await evaluate(
      cdp,
      target.sessionId,
      'JSON.stringify(((window.__COLLECT_RESULT__ || {}).defaultRun || {}).urls || [])'
    );
    console.log('\n默认设置下采集到的条目（交叉验证用）：');
    JSON.parse(collected).forEach(function (item) {
      console.log(
        '  ' + String(item.url).padEnd(30, ' ') +
          ' ' + String(item.width + 'x' + item.height).padStart(10, ' ') +
          ' source=' + String(item.source).padEnd(10, ' ')
      );
    });

    return report;
  } finally {
    await target.close();
  }
}

// ===========================================================================
// 六、展示页测试（每个场景一个全新标签页）
// ===========================================================================

async function runGallery(cdp) {
  console.log('\n=== 图片展示页测试 ===');
  const source = fs.readFileSync(path.join(__dirname, 'gallery-test.js'), 'utf8');
  const reports = [];

  for (const scenario of GALLERY_SCENARIOS) {
    const target = await openTarget(cdp, 'about:blank');
    try {
      await navigateAndWait(cdp, target.sessionId, GALLERY_URL);

      // 场景名必须在测试脚本执行前设置好
      await evaluate(cdp, target.sessionId, 'window.__IG_TEST_SCENARIO__ = ' + JSON.stringify(scenario) + '; true');
      await evaluate(cdp, target.sessionId, 'window.__GALLERY_TEST__ = null; true');

      // 执行测试脚本（内部会自己注入 chrome 桩对象并等待真实完成信号）
      await evaluate(cdp, target.sessionId, source, true);

      const report = await evaluate(cdp, target.sessionId, 'window.__GALLERY_TEST__');
      if (!report) {
        reports.push({ scenario: scenario, total: 1, passed: 0, failed: 1, failures: ['场景未产出结果对象'] });
        continue;
      }
      reports.push(report);
      printReport('场景 ' + scenario, report);
    } catch (err) {
      reports.push({
        scenario: scenario,
        total: 1,
        passed: 0,
        failed: 1,
        failures: ['运行器捕获异常：' + String((err && err.message) || err)]
      });
      console.log('\n【场景 ' + scenario + '】运行失败：' + String((err && err.message) || err));
    } finally {
      await target.close();
    }
  }

  const total = reports.reduce(function (n, r) { return n + r.total; }, 0);
  const passed = reports.reduce(function (n, r) { return n + r.passed; }, 0);
  const failures = [];
  reports.forEach(function (r) {
    (r.failures || []).forEach(function (f) {
      failures.push(r.scenario + ' / ' + f);
    });
  });

  return { total: total, passed: passed, failed: total - passed, failures: failures, reports: reports };
}

// ===========================================================================
// 七、官网自检
// ===========================================================================

/** 只读 ZIP 尾部 EOCD，数出条目数量（用来交叉验证网页上显示的文件数） */
function zipEntryCount(buf) {
  const lowest = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  }
  throw new Error('ZIP 里找不到 EOCD');
}

async function runSite(cdp) {
  console.log('\n=== 官网自检 ===');
  const checks = [];
  function check(name, condition, detail) {
    checks.push({
      name: name,
      pass: !!condition,
      detail: condition ? '' : String(detail === undefined ? '' : detail)
    });
  }
  function textOf(expression) {
    return evaluate(cdp, target.sessionId, expression);
  }

  const problems = [];
  const target = await openTarget(cdp, 'about:blank');

  // 监听必须在导航之前接上，否则会漏掉加载期间的报错
  cdp.onEvent = function (msg) {
    if (msg.sessionId !== target.sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      problems.push('未捕获异常：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(
        'console.error：' +
          (msg.params.args || [])
            .map(function (a) {
              return a.value !== undefined ? a.value : a.description || a.type;
            })
            .join(' ')
      );
    } else if (msg.method === 'Log.entryAdded' && (msg.params.entry || {}).level === 'error') {
      const entry = msg.params.entry;
      problems.push('加载失败：' + entry.text + (entry.url ? ' @ ' + entry.url : ''));
    }
  };

  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      target.sessionId
    );
    await cdp.send('Log.enable', {}, target.sessionId);
    await navigateAndWait(cdp, target.sessionId, SITE_URL);

    // ---- 标题、结构 ----
    check('页面标题包含产品名',
      /图提取 ImageGrab/.test(await textOf('document.title')), await textOf('document.title'));
    check('页面语言是 zh-CN', (await textOf('document.documentElement.lang')) === 'zh-CN');

    // ---- 两个本地 SVG 真的渲染出来了 ----
    const brandState = function () {
      return (
        '(function(){var i=document.querySelector(".brand img");' +
        'if(!i)return "no-img";' +
        'return i.complete+"|"+i.naturalWidth+"x"+i.naturalHeight+"|"+i.getAttribute("src");})()'
      );
    };
    // 等图片真正加载完成（真实信号），再去判断它有没有渲染出来
    await waitUntil(
      '页头 logo 图片加载结束',
      async function () {
        return String(await textOf(brandState())).indexOf('true|') === 0;
      },
      8000,
      50
    ).catch(function () {});
    const brandInfo = String(await textOf(brandState()));
    check(
      'logo.svg 成功渲染（不是破图）',
      /^true\|[1-9][0-9]*x[1-9][0-9]*\|/.test(brandInfo),
      brandInfo
    );

    const favicon = await textOf('(function(){var l=document.querySelector("link[rel=icon]");return l?l.getAttribute("href"):"";})()');
    check('favicon 使用本地 SVG', favicon === 'assets/favicon.svg', String(favicon));
    const faviconBody = await evaluate(
      cdp,
      target.sessionId,
      'fetch("assets/favicon.svg").then(function(r){return r.ok?r.text():"ERR"+r.status;}).then(function(t){return t.slice(0,80);})',
      true
    );
    check('favicon.svg 可以正常取到且是 SVG', /<svg/.test(String(faviconBody)), String(faviconBody));
    const logoBody = await evaluate(
      cdp,
      target.sessionId,
      'fetch("assets/logo.svg").then(function(r){return r.ok?r.text():"ERR"+r.status;}).then(function(t){return t.slice(0,80);})',
      true
    );
    check('logo.svg 可以正常取到且是 SVG', /<svg/.test(String(logoBody)), String(logoBody));

    const logoParse = await evaluate(
      cdp,
      target.sessionId,
      'fetch("assets/logo.svg").then(function(r){return r.text();}).then(function(t){' +
        'var d=new DOMParser().parseFromString(t,"image/svg+xml");' +
        'var e=d.querySelector("parsererror");' +
        'return e?("PARSE-ERROR: "+e.textContent.slice(0,240)):"OK";})',
      true
    );
    check('logo.svg 能被 XML 解析器接受', String(logoParse) === 'OK', String(logoParse));

    // 对照实验：浏览器能不能把一段内联 SVG 渲染成图片（用来区分“文件有问题”和“环境有限制”）
    const inlineSvgProbe = await evaluate(
      cdp,
      target.sessionId,
      'new Promise(function(resolve){' +
        'var i=new Image();' +
        'i.onload=function(){resolve("ok "+i.naturalWidth+"x"+i.naturalHeight);};' +
        'i.onerror=function(){resolve("error");};' +
        'i.src="data:image/svg+xml,"+encodeURIComponent(\'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64"/></svg>\');' +
        '})',
      true
    );
    check('环境本身可以渲染 SVG 图片（对照实验）',
      /^ok /.test(String(inlineSvgProbe)), String(inlineSvgProbe));

    // ---- 滚动进入动画 ----
    check('首屏 [data-reveal] 已经显示',
      (await textOf('document.querySelector(".hero-copy").getAttribute("data-revealed")')) === '1');

    // 滚完整页，所有 [data-reveal] 都必须显示出来，否则下方内容会一直空着
    await evaluate(
      cdp,
      target.sessionId,
      '(async function(){var h=document.body.scrollHeight;' +
        'for(var y=0;y<h;y+=500){window.scrollTo(0,y);await new Promise(function(r){setTimeout(r,80);});}' +
        'await new Promise(function(r){setTimeout(r,400);});return true;})()',
      true
    );
    const revealTotals = String(
      await textOf(
        '(function(){var a=document.querySelectorAll("[data-reveal]").length;' +
          'var b=document.querySelectorAll("[data-reveal][data-revealed=\\"1\\"]").length;' +
          'return a+"|"+b;})()'
      )
    );
    check(
      '滚完整页后所有 [data-reveal] 都已显示（没有整块空白）',
      revealTotals.split('|')[0] === revealTotals.split('|')[1],
      '总数|已显示 = ' + revealTotals
    );

    // ---- 头部滚动状态 ----
    await evaluate(cdp, target.sessionId, 'window.scrollTo(0, 800); true');
    await waitUntil(
      '头部进入滚动状态',
      async function () {
        return (await textOf('document.getElementById("siteHeader").getAttribute("data-scrolled")')) === '1';
      },
      5000,
      50
    );
    check('滚动后头部加上 data-scrolled="1"',
      (await textOf('document.getElementById("siteHeader").getAttribute("data-scrolled")')) === '1');
    await evaluate(cdp, target.sessionId, 'window.scrollTo(0, 0); true');

    // ---- 移动端导航开关 ----
    await evaluate(cdp, target.sessionId, 'document.getElementById("navToggle").click(); true');
    check('点击汉堡按钮后菜单展开',
      (await textOf('document.getElementById("siteNav").getAttribute("data-open")')) === '1');
    check('按钮 aria-expanded 同步为 true',
      (await textOf('document.getElementById("navToggle").getAttribute("aria-expanded")')) === 'true');
    await evaluate(cdp, target.sessionId, 'document.getElementById("siteNav").querySelector("a").click(); true');
    check('点击导航里的链接后菜单收起',
      (await textOf('document.getElementById("siteNav").getAttribute("data-open")')) === null);

    // ---- 页脚 ----
    check('页脚年份是当前年份',
      (await textOf('document.getElementById("year").textContent')) === String(new Date().getFullYear()),
      await textOf('document.getElementById("year").textContent'));
    const repoState = await textOf(
      '(function(){var a=document.getElementById("repoLink");var li=a.closest("li");' +
      'if(li&&li.hidden)return "hidden";return a.getAttribute("href");})()'
    );
    check('GitHub 仓库链接要么指向真实地址，要么整条隐藏（不指向 "#"）',
      repoState === 'hidden' || /^https?:\/\//.test(String(repoState)), String(repoState));

    // ---- 下载区：网页显示的信息必须和磁盘上的 ZIP 一致 ----
    const zipPath = path.join(ROOT, 'docs', 'downloads', 'imagegrab.zip');
    if (!fs.existsSync(zipPath)) {
      check('安装包存在', false, '找不到 ' + zipPath);
    } else {
      const zipBuf = fs.readFileSync(zipPath);
      const expectedHash = crypto.createHash('sha256').update(zipBuf).digest('hex');
      const expectedCount = zipEntryCount(zipBuf);
      const expectedVersion = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')
      ).version;

      // 真实完成信号：等页面把 SHA-256 填进去
      const filled = await waitUntil(
        '页面上出现安装包校验值',
        async function () {
          return (await textOf('document.getElementById("zipHash").textContent')) !== '—';
        },
        15000,
        100
      ).then(function () { return true; }).catch(function () { return false; });

      check('页面成功读出安装包信息', filled,
        await textOf('document.getElementById("zipNote").textContent'));

      check('显示的版本号与 manifest.json 一致',
        (await textOf('document.getElementById("zipVersion").textContent')) === expectedVersion,
        await textOf('document.getElementById("zipVersion").textContent'));
      check('显示的文件数量与 ZIP 实际条目数一致',
        (await textOf('document.getElementById("zipFiles").textContent')) === expectedCount + ' 个',
        await textOf('document.getElementById("zipFiles").textContent') + ' / 实际 ' + expectedCount);
      check('显示的 SHA-256 与磁盘上的 ZIP 逐字节一致',
        (await textOf('document.getElementById("zipHash").textContent')) === expectedHash,
        await textOf('document.getElementById("zipHash").textContent'));
      check('显示了包体大小',
        /KB|MB|字节/.test(String(await textOf('document.getElementById("zipSize").textContent'))),
        await textOf('document.getElementById("zipSize").textContent'));

      const linkHref = await textOf('document.getElementById("zipLink").getAttribute("href")');
      check('下载按钮指向 downloads/imagegrab.zip', linkHref === 'downloads/imagegrab.zip', String(linkHref));
      const headStatus = await evaluate(
        cdp,
        target.sessionId,
        'fetch("downloads/imagegrab.zip",{method:"HEAD"}).then(function(r){return r.status;})',
        true
      );
      check('下载地址真的能取到文件（HTTP 200）', headStatus === 200, String(headStatus));
      check('下载按钮带 download 属性（不会在浏览器里打开）',
        (await textOf('document.getElementById("zipLink").hasAttribute("download")')) === true);
    }

    // ---- 没有报错 ----
    check('加载与交互过程中没有任何控制台报错', problems.length === 0, problems.join(' | '));

    // ---- 可选的整页截图（只为人工看一眼版式，不参与断言） ----
    if (SHOT) {
      // 先自然滚一遍整个页面，让滚动进入动画按真实行为触发
      await evaluate(
        cdp,
        target.sessionId,
        '(async function(){var h=document.body.scrollHeight;' +
          'for(var y=0;y<h;y+=600){window.scrollTo(0,y);await new Promise(function(r){setTimeout(r,60);});}' +
          'window.scrollTo(0,0);await new Promise(function(r){setTimeout(r,300);});return true;})()',
        true
      );
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, target.sessionId);
      const content = metrics.cssContentSize || metrics.contentSize;
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: content.width,
            height: Math.min(content.height, 12000),
            scale: 1
          }
        },
        target.sessionId,
        60000
      );
      const outPath = path.resolve(ROOT, SHOT);
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      console.log('\n整页截图已保存：' + path.relative(ROOT, outPath));
    }

    const failed = checks.filter(function (c) { return !c.pass; });
    return {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      failures: failed.map(function (c) { return c.name + ' —— ' + c.detail; }),
      checks: checks
    };
  } finally {
    cdp.onEvent = function () {};
    await target.close();
  }
}

// ===========================================================================
// 八、输出
// ===========================================================================

function printReport(label, report) {
  console.log('\n【' + label + '】通过 ' + report.passed + ' / ' + report.total + ' 项');
  if (!report.checks) return;
  report.checks.forEach(function (c) {
    if (c.pass) return;
    console.log('  [失败] ' + c.name + (c.detail ? ' —— ' + c.detail : ''));
  });
}

function main() {
  const started = Date.now();
  const results = { collector: null, gallery: null };

  let exe;
  let port;
  let profileDir;
  let browser = null;
  let cdp = null;
  let server = null;

  (async function () {
    exe = findBrowser();
    console.log('浏览器：' + exe);
    console.log(HEADED ? '模式：有窗口' : '模式：headless');

    server = await ensureServer();

    port = await freePort();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-browser-test-'));
    browser = await launchBrowser(exe, port, profileDir);
    cdp = await Cdp.connect(browser.wsUrl);

    if (ONLY === 'all' || ONLY === 'collector') {
      results.collector = await runCollector(cdp);
    }
    if (ONLY === 'all' || ONLY === 'gallery') {
      results.gallery = await runGallery(cdp);
    }
    if (ONLY === 'all' || ONLY === 'site') {
      results.site = await runSite(cdp);
    }

    // ---------------------------------------------------------------------
    // 汇总
    // ---------------------------------------------------------------------
    const LABELS = { collector: '浏览器采集测试', gallery: '图片展示页测试', site: '官网自检' };
    const parts = [];
    let total = 0;
    let passed = 0;
    const allFailures = [];

    Object.keys(LABELS).forEach(function (key) {
      const r = results[key];
      if (!r) return;
      total += r.total;
      passed += r.passed;
      parts.push(LABELS[key] + '：通过 ' + r.passed + ' 项，失败 ' + r.failed + ' 项（共 ' + r.total + ' 项）');
      (r.failures || []).forEach(function (f) { allFailures.push(LABELS[key] + ' / ' + f); });
    });

    const failed = total - passed;

    console.log('\n' + '='.repeat(60));
    parts.forEach(function (p) { console.log(p); });
    if (results.gallery) {
      results.gallery.reports.forEach(function (r) {
        console.log('  - ' + r.scenario.padEnd(11, ' ') + r.passed + ' / ' + r.total);
      });
    }
    console.log('合计：通过 ' + passed + ' 项，失败 ' + failed + ' 项（耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒）');

    if (allFailures.length) {
      console.log('\n失败明细：');
      allFailures.forEach(function (f) { console.log('  - ' + f); });
    } else {
      console.log('\n全部通过。');
    }

    process.exitCode = failed ? 1 : 0;
  })()
    .catch(function (err) {
      console.error('\n运行器出错：' + String((err && err.stack) || err));
      process.exitCode = 2;
    })
    .then(function () {
      // 收尾：关闭浏览器、清理临时配置目录
      if (cdp) cdp.close();
      if (browser && browser.child) {
        try {
          browser.child.kill();
        } catch (err) {
          /* 忽略 */
        }
      }
      if (server) {
        try {
          server.kill();
        } catch (err) {
          /* 忽略 */
        }
      }
      if (profileDir) {
        setTimeout(function () {
          try {
            fs.rmSync(profileDir, { recursive: true, force: true });
          } catch (err) {
            /* 忽略：临时目录清理失败不影响测试结论 */
          }
        }, 300);
      }
    });
}

main();
