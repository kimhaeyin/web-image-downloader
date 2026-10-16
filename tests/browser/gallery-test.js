/**
 * 图片展示页（extension/gallery.html + gallery.css + gallery.js）的浏览器端测试。
 *
 * 被测对象是线上同一份 HTML / CSS / JS，只把 chrome.* 换成
 * tests/browser/chrome-stub.js 里的可观测桩对象。
 *
 * 由 tests/browser/run-browser-tests.js 驱动：每个场景都新建一个标签页，
 * 进入 gallery.html?tab=1 之后设置 window.__IG_TEST_SCENARIO__，再执行本文件，
 * 结果写入 window.__GALLERY_TEST__。场景之间没有任何共享状态。
 *
 * 三条保证测试可信的规则：
 *   1. 页面里始终只有一个活着的 gallery.js 实例。gallery.html 在加载时已经跑过一次
 *      gallery.js，那个实例也把监听器绑在了同一批按钮上；直接再执行一次会让同一个
 *      按钮有两个监听器，一次点击触发两轮逻辑，断言可能“碰巧结果一致”而通过。
 *      loadGallery 会先把这些按钮换成同 id 的克隆节点，让旧实例失效。
 *   2. 不靠固定等待时间判断“做完了”，而是轮询真实信号：批量下载用 gallery.js 写在
 *      <html data-ig-busy> 上的进行中标记，交互结果用 DOM 上的实际变化。
 *   3. 每次交互都是“先等到效果出现，再断言”，避免断言跑在浏览器更新之前。
 *
 * 场景列表（新增场景时记得同步 run-browser-tests.js 里的 GALLERY_SCENARIOS）：
 *   render     正常渲染 + 勾选 / 全选 / 取消选择 / 反选 + 批量下载 + 校验字节确实是 PNG
 *   nofallback 关闭“失败回退原格式”后，转换失败的图片必须计入失败
 *   fallback   开启回退后按原格式下载，并以中性样式标注“未能转 PNG”
 *   empty      首次加载就是空图片列表时展示空状态，并复位按钮与选择状态
 *   reset      先有内容并选中若干张，再让“重新采集”返回空列表，按钮状态必须复位
 */
(async function () {
  'use strict';

  const scenario = window.__IG_TEST_SCENARIO__ || 'render';

  const checks = [];
  function check(name, condition, detail) {
    checks.push({
      name: name,
      pass: !!condition,
      detail: condition ? '' : String(detail === undefined ? '' : detail)
    });
  }
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function $id(id) {
    return document.getElementById(id);
  }
  function countCards() {
    return document.querySelectorAll('.card').length;
  }
  function selectedCount() {
    return document.querySelectorAll('.card[data-selected="1"]').length;
  }
  function textOf(id) {
    const node = $id(id);
    return node ? node.textContent : '';
  }
  function clip(value, max) {
    const text = String(value);
    return text.length > (max || 220) ? text.slice(0, max || 220) + '…' : text;
  }

  /** 轮询等待条件成立，返回是否在超时前成立 */
  async function waitFor(predicate, timeoutMs, intervalMs) {
    const limit = Date.now() + (timeoutMs || 5000);
    while (Date.now() < limit) {
      if (predicate()) return true;
      await sleep(intervalMs || 40);
    }
    return !!predicate();
  }

  /** 等到某个交互效果真的出现在 DOM 上（替代固定 sleep） */
  async function waitEffect(label, predicate, timeoutMs) {
    const ok = await waitFor(predicate, timeoutMs || 4000, 30);
    if (!ok) {
      check('等待「' + label + '」出现', false, '超时前条件一直没有成立');
    }
    return ok;
  }

  /** 等待批量下载真正结束（用真实的进行中标记，而不是固定等待时间） */
  async function waitIdle(timeoutMs) {
    await waitFor(function () {
      return !document.documentElement.hasAttribute('data-ig-busy');
    }, timeoutMs || 30000, 40);
    // 标记消失后，finally 里的状态复位还需要一个微任务周期
    await sleep(60);
  }

  /** 清掉上一场景可能留下的 DOM 残留，并让页面自带的那个 gallery.js 实例失效 */
  const BOUND_IDS = [
    'btnRescan',
    'btnRescan2',
    'btnRetry',
    'btnSource',
    'btnSource2',
    'btnSource3',
    'btnSelectAll',
    'btnSelectNone',
    'btnInvert',
    'btnDownload',
    'chkPng'
  ];

  function detachPreviousInstance() {
    // 换成克隆节点：同 id、同属性，但不带任何事件监听器
    BOUND_IDS.forEach(function (id) {
      const node = $id(id);
      if (node) node.replaceWith(node.cloneNode(true));
    });

    document.documentElement.removeAttribute('data-ig-busy');
    document.querySelectorAll('.card').forEach(function (node) {
      node.remove();
    });

    $id('grid').hidden = true;
    $id('toolbar').hidden = true;
    $id('stateEmpty').hidden = true;
    $id('stateError').hidden = true;
    $id('progressWrap').hidden = true;
    $id('failList').hidden = true;
    $id('progressBar').style.width = '0%';
    $id('progressText').textContent = '';
    $id('statTotal').textContent = '共 0 张';
    $id('statStats').textContent = '';
    $id('statSelected').textContent = '已选 0 张';
    $id('sourceInfo').textContent = '';
    $id('footerRight').textContent = '';
    $id('footerRight').className = '';
  }

  /** 注入桩对象并跑一份干净的 gallery.js；返回桩对象的调用记录 */
  async function loadGallery() {
    detachPreviousInstance();

    const stubSource = await fetch('/tests/browser/chrome-stub.js').then(function (r) {
      return r.text();
    });
    (0, eval)(stubSource);

    const gallerySource = await fetch('/extension/gallery.js').then(function (r) {
      return r.text();
    });
    (0, eval)(gallerySource);

    if (!window.__STUB__) {
      check('chrome 桩对象注入成功', false, 'window.__STUB__ 不存在');
      return { downloads: [], sent: [], openedTabs: [] };
    }

    // 渲染就绪信号：出现卡片，或出现空状态 / 错误状态
    const ready = await waitFor(function () {
      return countCards() > 0 || !$id('stateEmpty').hidden || !$id('stateError').hidden;
    }, 8000, 40);

    check('页面在 8 秒内完成初始渲染', ready);
    return window.__STUB__;
  }

  // =========================================================================
  // 场景 1：正常渲染、勾选与批量下载
  // =========================================================================

  async function scenarioRender() {
    window.__STUB_SETTINGS__ = {};
    window.__STUB_EMPTY__ = false;
    const stub = await loadGallery();

    check('渲染出 6 张卡片', countCards() === 6, countCards());
    check('总数文案正确', textOf('statTotal') === '共 6 张', textOf('statTotal'));
    check('统计文案包含候选与过滤数量',
      /候选 18/.test(textOf('statStats')) && /过滤 8/.test(textOf('statStats')), textOf('statStats'));
    check('来源信息包含站点与标题',
      textOf('sourceInfo').indexOf('京东') >= 0 && textOf('sourceInfo').indexOf('测试商品') >= 0,
      textOf('sourceInfo'));
    check('来源链接指向商品页',
      $id('btnSource').getAttribute('href') === 'https://item.jd.com/100012043978.html',
      $id('btnSource').getAttribute('href'));
    check('底栏显示插件版本', /v1\.0\.0/.test(textOf('footerText')), textOf('footerText'));
    check('第一张卡片显示 800 × 800',
      document.querySelector('.card[data-index="0"] .dims').textContent === '800 × 800',
      document.querySelector('.card[data-index="0"] .dims').textContent);
    check('第三张卡片的尺寸来自 stub 数据 750 × 1100',
      document.querySelector('.card[data-index="2"] .dims').textContent === '750 × 1100',
      document.querySelector('.card[data-index="2"] .dims').textContent);
    check('未选中时下载按钮禁用', $id('btnDownload').disabled === true, $id('btnDownload').disabled);
    check('背景图卡片带“背景”标记',
      Array.prototype.some.call(document.querySelectorAll('.badge-src'), function (n) {
        return n.textContent === '背景';
      }));
    check('缩略图使用原生懒加载',
      document.querySelector('.thumb img').getAttribute('loading') === 'lazy',
      document.querySelector('.thumb img').getAttribute('loading'));
    check('缩略图不发送 Referer（隐私与防盗链边界）',
      document.querySelector('.thumb img').getAttribute('referrerpolicy') === 'no-referrer',
      document.querySelector('.thumb img').getAttribute('referrerpolicy'));
    check('初始没有进行中标记',
      !document.documentElement.hasAttribute('data-ig-busy'));

    // --- 勾选交互 ---
    document.querySelector('.card[data-index="0"] .thumb').click();
    await waitEffect('点击缩略图后选中 1 张', function () { return selectedCount() === 1; });
    check('点击缩略图选中单张', selectedCount() === 1, selectedCount());
    check('已选数量实时更新', textOf('statSelected') === '已选 1 张', textOf('statSelected'));
    check('选中后下载按钮启用', $id('btnDownload').disabled === false);
    check('按钮文案带数量', $id('btnDownload').textContent.indexOf('（1）') > 0, $id('btnDownload').textContent);

    document.querySelector('.card[data-index="0"] .thumb').click();
    await waitEffect('再次点击后取消选中', function () { return selectedCount() === 0; });
    check('再次点击取消选中', selectedCount() === 0, selectedCount());

    $id('btnSelectAll').click();
    await waitEffect('全选生效', function () { return selectedCount() === 6; });
    check('全选选中全部 6 张', selectedCount() === 6, selectedCount());

    $id('btnInvert').click();
    await waitEffect('反选生效', function () { return selectedCount() === 0; });
    check('反选后全部取消', selectedCount() === 0, selectedCount());

    $id('btnSelectAll').click();
    await waitEffect('再次全选生效', function () { return selectedCount() === 6; });
    $id('btnSelectNone').click();
    await waitEffect('取消选择生效', function () { return selectedCount() === 0; });
    check('取消选择按钮清空选择', selectedCount() === 0, selectedCount());

    // --- 批量下载三张 ---
    ['0', '1', '2'].forEach(function (index) {
      document.querySelector('.card[data-index="' + index + '"] input[type="checkbox"]').click();
    });
    await waitEffect('通过复选框选中 3 张', function () { return selectedCount() === 3; });
    check('通过复选框选中 3 张', selectedCount() === 3, selectedCount());

    $id('btnDownload').click();
    // 点击后立刻就应该出现进行中标记（runBatch 在第一个 await 之前就设置了）
    check('点击下载后立刻出现进行中标记',
      document.documentElement.hasAttribute('data-ig-busy'));

    await waitIdle(30000);

    check('批量下载结束后进行中标记被清除',
      !document.documentElement.hasAttribute('data-ig-busy'));

    const downloads = stub.downloads;
    check('批量下载触发了 3 次下载调用', downloads.length === 3,
      JSON.stringify(downloads.map(function (d) { return d.filename; })));
    check('文件名按 商品图_001.png 递增编号',
      downloads.map(function (d) { return d.filename; }).join(',') ===
        '商品图_001.png,商品图_002.png,商品图_003.png',
      downloads.map(function (d) { return d.filename; }).join(','));
    check('下载地址是 blob（说明走了 canvas 转 PNG 流程）',
      downloads.length > 0 && downloads.every(function (d) { return d.url.indexOf('blob:') === 0; }),
      downloads.map(function (d) { return d.url.slice(0, 12); }).join(','));

    // --- 逐字节校验：下载下来的内容必须真的是 PNG ---
    const pngReports = [];
    for (const record of downloads) {
      try {
        const buffer = new Uint8Array(await (await fetch(record.url)).arrayBuffer());
        const isPng =
          buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
          buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
        const view = new DataView(buffer.buffer);
        pngReports.push({
          filename: record.filename,
          isPng: isPng,
          width: view.getUint32(16),
          height: view.getUint32(20),
          bytes: buffer.length
        });
      } catch (err) {
        pngReports.push({ filename: record.filename, error: String((err && err.message) || err) });
      }
    }

    check('三份下载内容都带 PNG magic 头',
      pngReports.length === 3 && pngReports.every(function (p) { return p.isPng; }),
      JSON.stringify(pngReports));
    check('第一张 PNG 的 IHDR 宽高为 800×800',
      pngReports[0] && pngReports[0].width === 800 && pngReports[0].height === 800,
      JSON.stringify(pngReports[0]));
    check('第二张 PNG 的 IHDR 宽高为 750×1100',
      pngReports[1] && pngReports[1].width === 750 && pngReports[1].height === 1100,
      JSON.stringify(pngReports[1]));
    check('第三张 PNG 的 IHDR 宽高为 750×1100',
      pngReports[2] && pngReports[2].width === 750 && pngReports[2].height === 1100,
      JSON.stringify(pngReports[2]));

    check('进度条走到 100%', $id('progressBar').style.width === '100%', $id('progressBar').style.width);
    check('进度文案给出完成统计',
      textOf('progressText').indexOf('处理完成：共 3 张') >= 0, clip(textOf('progressText')));
    check('统计里成功转 PNG 3 张',
      textOf('progressText').indexOf('成功转 PNG 3 张') >= 0, clip(textOf('progressText')));
    check('没有误报失败', textOf('progressText').indexOf('失败') < 0, clip(textOf('progressText')));
    check('下载结束后按钮恢复可用，并保持原有的 3 张选中状态',
      $id('btnDownload').disabled === false && $id('btnDownload').textContent.indexOf('（3）') > 0,
      $id('btnDownload').disabled + ' / ' + $id('btnDownload').textContent);

    return { pngReports: pngReports, downloads: downloads.map(function (d) {
      return { filename: d.filename, kind: d.url.indexOf('blob:') === 0 ? 'blob' : 'url', url: d.url };
    }) };
  }

  // =========================================================================
  // 场景 2：转换失败且关闭回退 => 必须计入失败，不能假成功
  // =========================================================================

  async function scenarioNoFallback() {
    window.__STUB_SETTINGS__ = { convertToPng: true, fallbackOriginal: false };
    window.__STUB_EMPTY__ = false;
    const stub = await loadGallery();

    check('正常渲染出 6 张卡片（场景 2 基线）', countCards() === 6, countCards());

    // 第 6 张（index 5）指向不存在的文件，fetch 会得到 404
    document.querySelector('.card[data-index="5"] input[type="checkbox"]').click();
    await waitEffect('选中第 6 张', function () { return selectedCount() === 1; });
    $id('btnDownload').click();
    await waitIdle(20000);

    check('转换失败且关闭回退时没有发起任何下载', stub.downloads.length === 0,
      JSON.stringify(stub.downloads));
    check('进度文案计入失败 1 张',
      textOf('progressText').indexOf('失败 1 张') >= 0, clip(textOf('progressText')));
    check('进度文案没有谎报成功',
      textOf('progressText').indexOf('成功转 PNG') < 0, clip(textOf('progressText')));
    check('失败明细列表可见', $id('failList').hidden === false);
    check('失败明细里包含 HTTP 404 原因',
      textOf('failList').indexOf('404') >= 0, clip(textOf('failList')));
    check('失败条目使用错误样式而不是降级说明样式',
      document.querySelectorAll('#failList li:not(.note)').length === 1 &&
        document.querySelectorAll('#failList li.note').length === 0,
      clip(textOf('failList')));
    check('底栏状态标记为异常', $id('footerRight').className === 'bad', $id('footerRight').className);

    return { progressText: textOf('progressText'), failList: textOf('failList') };
  }

  // =========================================================================
  // 场景 3：开启回退 => 按原格式下载，并明确标注“未能转 PNG”
  // =========================================================================

  async function scenarioFallback() {
    window.__STUB_SETTINGS__ = { convertToPng: true, fallbackOriginal: true };
    window.__STUB_EMPTY__ = false;
    const stub = await loadGallery();

    document.querySelector('.card[data-index="5"] input[type="checkbox"]').click();
    await waitEffect('选中第 6 张', function () { return selectedCount() === 1; });
    $id('btnDownload').click();
    await waitIdle(20000);

    check('开启回退后发起了 1 次下载', stub.downloads.length === 1, JSON.stringify(stub.downloads));
    check('回退下载用的是原始 http 地址而不是 blob',
      stub.downloads[0] && stub.downloads[0].url.indexOf('http') === 0,
      stub.downloads[0] && stub.downloads[0].url);
    check('进度文案区分“按原格式下载”',
      textOf('progressText').indexOf('按原格式下载 1 张') >= 0, clip(textOf('progressText')));
    check('进度文案里没有把它算成 PNG 成功',
      textOf('progressText').indexOf('成功转 PNG') < 0, clip(textOf('progressText')));
    check('降级说明使用中性样式而不是失败样式',
      document.querySelectorAll('#failList li.note').length === 1 &&
        document.querySelectorAll('#failList li:not(.note)').length === 0,
      clip(textOf('failList')));
    check('降级说明里写明了转换失败原因',
      textOf('failList').indexOf('PNG 转换失败') >= 0, clip(textOf('failList')));

    return { progressText: textOf('progressText'), failList: textOf('failList') };
  }

  // =========================================================================
  // 场景 4：首次加载就是空图片列表
  // =========================================================================

  async function scenarioEmpty() {
    window.__STUB_SETTINGS__ = {};
    window.__STUB_EMPTY__ = true;
    await loadGallery();

    check('空列表时展示空状态', $id('stateEmpty').hidden === false, $id('stateEmpty').hidden);
    check('空列表时不显示网格', $id('grid').hidden === true, $id('grid').hidden);
    check('空列表时隐藏工具条（避免残留按钮）', $id('toolbar').hidden === true, $id('toolbar').hidden);
    check('空列表时给出可操作提示',
      textOf('emptyHint').indexOf('重新采集') >= 0, clip(textOf('emptyHint')));
    check('空列表时总数复位为 0', textOf('statTotal') === '共 0 张', textOf('statTotal'));
    check('空列表时已选数量复位为 0', textOf('statSelected') === '已选 0 张', textOf('statSelected'));
    check('空列表时下载按钮不可用', $id('btnDownload').disabled === true, $id('btnDownload').disabled);
    check('空列表时不显示进度区', $id('progressWrap').hidden === true, $id('progressWrap').hidden);
    check('空列表时不显示失败明细', $id('failList').hidden === true, $id('failList').hidden);

    return { emptyHint: textOf('emptyHint') };
  }

  // =========================================================================
  // 场景 5：从“有内容且已选中”变成“空列表”，按钮状态必须一起复位
  //
  // 这是空列表复位逻辑的回归测试：如果 applyPayload 在空列表分支里漏掉了
  // updateCounters()，按钮会残留上一轮的“下载选中（3）”并且仍然可点。
  // =========================================================================

  async function scenarioReset() {
    window.__STUB_SETTINGS__ = {};
    window.__STUB_EMPTY__ = false;
    await loadGallery();

    check('复位场景基线：渲染出 6 张卡片', countCards() === 6, countCards());

    ['0', '1', '2'].forEach(function (index) {
      document.querySelector('.card[data-index="' + index + '"] input[type="checkbox"]').click();
    });
    await waitEffect('选中 3 张', function () { return selectedCount() === 3; });
    check('切换前按钮可点击且带数量',
      $id('btnDownload').disabled === false && $id('btnDownload').textContent.indexOf('（3）') > 0,
      $id('btnDownload').disabled + ' / ' + $id('btnDownload').textContent);

    // 让下一次“重新采集”返回空列表
    window.__STUB_EMPTY__ = true;
    $id('btnRescan').click();
    await waitEffect('重新采集后进入空状态', function () { return $id('stateEmpty').hidden === false; }, 8000);

    check('空列表时展示空状态', $id('stateEmpty').hidden === false, $id('stateEmpty').hidden);
    check('空列表时下载按钮被禁用', $id('btnDownload').disabled === true, $id('btnDownload').disabled);
    check('空列表时按钮文案复位，不再带上一轮的已选数量',
      $id('btnDownload').textContent === '下载选中', $id('btnDownload').textContent);
    check('空列表时已选数量复位为 0', textOf('statSelected') === '已选 0 张', textOf('statSelected'));
    check('空列表时总数复位为 0', textOf('statTotal') === '共 0 张', textOf('statTotal'));
    check('空列表时卡片全部清空', countCards() === 0, countCards());
    check('空列表时工具条被隐藏', $id('toolbar').hidden === true, $id('toolbar').hidden);
    check('空列表时进度区被隐藏', $id('progressWrap').hidden === true, $id('progressWrap').hidden);
    check('空列表时失败明细被隐藏', $id('failList').hidden === true, $id('failList').hidden);

    return {
      buttonText: $id('btnDownload').textContent,
      buttonDisabled: $id('btnDownload').disabled,
      statSelected: textOf('statSelected')
    };
  }

  // =========================================================================
  // 分发
  // =========================================================================

  const runners = {
    render: scenarioRender,
    nofallback: scenarioNoFallback,
    fallback: scenarioFallback,
    empty: scenarioEmpty,
    reset: scenarioReset
  };

  let extra = {};
  if (!runners[scenario]) {
    check('场景名有效（' + scenario + '）', false, '支持的场景：' + Object.keys(runners).join(', '));
  } else {
    try {
      extra = (await runners[scenario]()) || {};
    } catch (err) {
      check('场景执行过程没有抛出异常', false, String((err && err.stack) || err));
    }
  }

  const failures = checks.filter(function (c) { return !c.pass; });
  const summary = Object.assign(
    {
      scenario: scenario,
      total: checks.length,
      passed: checks.length - failures.length,
      failed: failures.length,
      failures: failures.map(function (c) { return c.name + ' —— ' + c.detail; }),
      checks: checks
    },
    extra
  );

  window.__GALLERY_TEST__ = summary;
  return JSON.stringify(summary);
})();
