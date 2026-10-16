/**
 * 图提取 ImageGrab —— Node 侧自动化测试
 *
 * 覆盖范围（全部真实执行，不是伪代码）：
 *   A. 站点识别与页面类型判断
 *   B. URL 补全、归一化、扩展名推断、srcset 解析、背景图解析
 *   C. 过滤与去重规则
 *   D. 文件名生成
 *   E. 原图地址改写（含带签名链接不动的保护）
 *   F. collectFromDocument 在注入式假 DOM 上的完整采集流程
 *
 * 这里刻意不引入任何第三方依赖：collectFromDocument 需要的 DOM 能力
 * 都通过 env 注入，因此可以在纯 Node 环境里用桩对象跑完整逻辑。
 * 真实浏览器上的采集表现由 tests/browser/collector-fixture.html 验证。
 *
 * 用法：node tests/run-tests.js
 */

'use strict';

const path = require('path');
const CORE = require(path.join(__dirname, '..', 'extension', 'lib', 'extract-core.js'));

// ===========================================================================
// 极简测试框架
// ===========================================================================

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n=== ' + name + ' ===');
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  [通过] ' + name);
  } else {
    failed++;
    failures.push(currentGroup + ' / ' + name + (detail ? ' —— ' + detail : ''));
    console.log('  [失败] ' + name + (detail ? ' —— ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, '实际 ' + a + '，期望 ' + b);
}

// ===========================================================================
// A. 站点识别
// ===========================================================================

group('A. 站点识别与页面类型');

check('taobao.com 受支持', CORE.isSupportedHost('taobao.com'));
check('item.taobao.com 受支持', CORE.isSupportedHost('item.taobao.com'));
check('detail.tmall.com 受支持', CORE.isSupportedHost('detail.tmall.com'));
check('item.jd.com 受支持', CORE.isSupportedHost('item.jd.com'));
check('mobile.yangkeduo.com 受支持', CORE.isSupportedHost('mobile.yangkeduo.com'));
check('www.pinduoduo.com 受支持', CORE.isSupportedHost('www.pinduoduo.com'));
check('www.baidu.com 不受支持', !CORE.isSupportedHost('www.baidu.com'));
check('假的 taobao.com.evil.com 不受支持', !CORE.isSupportedHost('taobao.com.evil.com'));
check('空主机名不受支持', !CORE.isSupportedHost(''));

eq('detectSite(item.taobao.com).key', CORE.detectSite('item.taobao.com').key, 'taobao');
eq('detectSite(item.jd.com).key', CORE.detectSite('item.jd.com').key, 'jd');
eq('detectSite(mobile.yangkeduo.com).key', CORE.detectSite('mobile.yangkeduo.com').key, 'pdd');
eq('detectSite(www.baidu.com)', CORE.detectSite('www.baidu.com'), null);

eq('淘宝详情页判定', CORE.detectPageKind('https://item.taobao.com/item.htm?id=123456'), 'product');
eq('天猫详情页判定', CORE.detectPageKind('https://detail.tmall.com/item.htm?id=123456'), 'product');
eq('京东详情页判定', CORE.detectPageKind('https://item.jd.com/100012043978.html'), 'product');
eq('拼多多商品页判定', CORE.detectPageKind('https://mobile.yangkeduo.com/goods.html?goods_id=1'), 'product');
eq('淘宝首页判定为 other', CORE.detectPageKind('https://www.taobao.com/'), 'other');
eq('登录页判定为 auth', CORE.detectPageKind('https://login.taobao.com/member/login.jhtml'), 'auth');
eq('passport 页判定为 auth', CORE.detectPageKind('https://passport.jd.com/new/login.aspx'), 'auth');

// ===========================================================================
// B. URL 处理
// ===========================================================================

group('B. URL 处理');

eq(
  '协议相对地址补 https',
  CORE.toAbsoluteUrl('//img.alicdn.com/a.jpg'),
  'https://img.alicdn.com/a.jpg'
);
eq(
  '相对地址按 base 补全',
  CORE.toAbsoluteUrl('./pic/a.jpg', 'https://item.jd.com/100.html'),
  'https://item.jd.com/pic/a.jpg'
);
eq('javascript: 被拒绝', CORE.toAbsoluteUrl('javascript:void(0)'), null);
eq('blob: 被拒绝', CORE.toAbsoluteUrl('blob:https://x/y'), null);
eq('about:blank 被拒绝', CORE.toAbsoluteUrl('about:blank'), null);
check('data: 保留原样', CORE.toAbsoluteUrl('data:image/png;base64,AAAA') === 'data:image/png;base64,AAAA');
eq('空字符串返回 null', CORE.toAbsoluteUrl(''), null);

eq(
  'http 与 https 归一化为同一个去重键',
  CORE.normalizeForCompare('http://img.jd.com/a.jpg'),
  CORE.normalizeForCompare('https://img.jd.com/a.jpg')
);
check(
  '追踪参数不影响去重键',
  CORE.normalizeForCompare('https://img.jd.com/a.jpg?spm=a1z10.1&_t=123') ===
    CORE.normalizeForCompare('https://img.jd.com/a.jpg')
);
check(
  '去重键忽略 hash',
  CORE.normalizeForCompare('https://img.jd.com/a.jpg#frag') ===
    CORE.normalizeForCompare('https://img.jd.com/a.jpg')
);
check(
  '相机参数类查询串参与去重键（不会被误删）',
  CORE.normalizeForCompare('https://img.jd.com/a.jpg?x-oss-process=image/resize,w_400') !==
    CORE.normalizeForCompare('https://img.jd.com/a.jpg')
);

eq('jpg 扩展名', CORE.guessExtension('https://img.jd.com/a.jpg'), 'jpg');
eq('jpeg 归一为 jpg', CORE.guessExtension('https://img.jd.com/a.jpeg'), 'jpg');
eq('webp 扩展名', CORE.guessExtension('https://img.alicdn.com/a.webp'), 'webp');
eq(
  '淘宝缩略图后缀取第一个扩展名',
  CORE.guessExtension('https://img.alicdn.com/O1CN01abc.jpg_430x430q90.jpg'),
  'jpg'
);
eq(
  '淘宝 webp 缩略图也能取到 jpg',
  CORE.guessExtension('https://img.alicdn.com/O1CN01abc.jpg_430x430q90.jpg_.webp'),
  'jpg'
);
eq('无扩展名默认 jpg', CORE.guessExtension('https://img.jd.com/jfs/t1/abc123'), 'jpg');

const srcset = CORE.parseSrcset('a-400.jpg 400w, b-800.jpg 800w, c-1600.jpg 1600w');
eq('srcset 按 宽度 降序', srcset.map(function (s) { return s.url; }), ['c-1600.jpg', 'b-800.jpg', 'a-400.jpg']);
eq(
  'srcset 按 倍率 降序',
  CORE.parseSrcset('a-1x.jpg 1x, b-3x.jpg 3x, c-2x.jpg 2x').map(function (s) { return s.url; }),
  ['b-3x.jpg', 'c-2x.jpg', 'a-1x.jpg']
);
eq('srcset 无描述符时按原顺序保留', CORE.parseSrcset('a.jpg, b.jpg').map(function (s) { return s.url; }), ['a.jpg', 'b.jpg']);
eq('srcset 跳过 data URI', CORE.parseSrcset('data:image/png;base64,AAA 1x, real.jpg 2x').map(function (s) { return s.url; }), ['real.jpg']);
eq('空 srcset 返回空数组', CORE.parseSrcset(''), []);

eq(
  'background-image 提取 url',
  CORE.extractUrlsFromCss('url("https://img.jd.com/bg.jpg")'),
  ['https://img.jd.com/bg.jpg']
);
eq(
  'background-image 多个 url 与不加引号',
  CORE.extractUrlsFromCss("url(https://img.jd.com/1.jpg), linear-gradient(#fff, #000), url('https://img.jd.com/2.jpg')"),
  ['https://img.jd.com/1.jpg', 'https://img.jd.com/2.jpg']
);
eq('background-image none 返回空', CORE.extractUrlsFromCss('none'), []);
eq('background-image 跳过 data URI', CORE.extractUrlsFromCss('url("data:image/png;base64,AAA")'), []);

eq(
  '脚本文本扫描（含转义斜杠）',
  CORE.extractUrlsFromText('var a = "https:\\/\\/img.alicdn.com\\/i1\\/x.jpg";'),
  ['https://img.alicdn.com/i1/x.jpg']
);
check(
  '脚本文本扫描能同时命中多条',
  CORE.extractUrlsFromText('"https://a.com/1.jpg","https://a.com/2.png"').length === 2
);

// ===========================================================================
// C. 过滤与去重
// ===========================================================================

group('C. 过滤与去重');

check('icon 关键词被过滤', CORE.isBlockedUrl('https://img.jd.com/icon/close.png'));
check('logo 作为整段被过滤', CORE.isBlockedUrl('https://img.jd.com/logo.png'));
check('sprite 被过滤', CORE.isBlockedUrl('https://img.jd.com/sprite_v2.png'));
check('1x1 被过滤', CORE.isBlockedUrl('https://img.jd.com/1x1.gif'));
check('logotype 是整词不匹配，不会被过滤', !CORE.isBlockedUrl('https://img.jd.com/goods/logotype-2024.jpg'));
check('正常商品图不被过滤', !CORE.isBlockedUrl('https://img14.360buyimg.com/n5/jfs/t1/123456.jpg'));
check('埋点域名被过滤', CORE.isBlockedUrl('https://log.mmstat.com/1.gif'));
check('根路径被过滤', CORE.isBlockedUrl('https://img.jd.com/'));

check('.js 结尾判定为非图片', CORE.hasNonImageExtension('https://img.jd.com/app.js'));
check('.svg 结尾判定为非图片', CORE.hasNonImageExtension('https://img.jd.com/icon.svg'));
check('.jpg 结尾不是非图片', !CORE.hasNonImageExtension('https://img.jd.com/a.jpg'));
check('无扩展名不是非图片', !CORE.hasNonImageExtension('https://img.jd.com/jfs/t1/abc'));

const filtered = CORE.filterItems([
  { url: 'https://img.jd.com/a.jpg', width: 800, height: 800, loaded: true },
  { url: 'https://img.jd.com/icon/b.png', width: 800, height: 800, loaded: true },
  { url: 'https://img.jd.com/small.png', width: 40, height: 30, loaded: true },
  { url: 'https://img.jd.com/lazy.png', width: 0, height: 0, loaded: false },
  { url: 'https://img.jd.com/big-wide.png', width: 60, height: 1200, loaded: true },
  { url: 'not-a-url', width: 10, height: 10, loaded: true },
  { url: 'data:image/png;base64,AAAA', width: 0, height: 0, loaded: false }
], {});

eq(
  '过滤后剩下的地址',
  filtered.kept.map(function (i) { return i.url; }),
  [
    'https://img.jd.com/a.jpg',
    'https://img.jd.com/lazy.png',
    'https://img.jd.com/big-wide.png'
  ]
);
eq('图标被计入 blocked', filtered.dropped.blocked, 1);
eq('小图被计入 tooSmall', filtered.dropped.tooSmall, 1);
eq('非法地址被计入 invalid', filtered.dropped.invalid, 1);
eq('data URI 被计入 dataUrl', filtered.dropped.dataUrl, 1);
check('懒加载未加载图片不会被尺寸过滤误杀', filtered.kept.some(function (i) { return i.url.indexOf('lazy.png') >= 0; }));
check('又窄又长的图不会被误杀', filtered.kept.some(function (i) { return i.url.indexOf('big-wide') >= 0; }));

eq(
  'minSize 设为 0 时不做尺寸过滤',
  CORE.filterItems([{ url: 'https://img.jd.com/tiny.png', width: 8, height: 8, loaded: true }], { minSize: 0 })
    .kept.length,
  1
);

const deduped = CORE.dedupeItems([
  { url: 'https://img.jd.com/a.jpg?spm=x', key: CORE.normalizeForCompare('https://img.jd.com/a.jpg?spm=x'), width: 0, height: 0, loaded: false },
  { url: 'https://img.jd.com/a.jpg', key: CORE.normalizeForCompare('https://img.jd.com/a.jpg'), width: 800, height: 800, loaded: true },
  { url: 'https://img.jd.com/b.jpg', key: CORE.normalizeForCompare('https://img.jd.com/b.jpg'), width: 400, height: 400, loaded: true }
]);
eq('去重后只剩两条', deduped.length, 2);
eq('同地址保留已加载且有尺寸的那条', deduped[0].url, 'https://img.jd.com/a.jpg');

// ===========================================================================
// D. 文件名
// ===========================================================================

group('D. 文件名生成');

eq('三位补零', CORE.buildFileName(1, 12, 'png'), '商品图_001.png');
eq('第十二张', CORE.buildFileName(12, 12, 'png'), '商品图_012.png');
eq('超过 999 张自动扩位', CORE.buildFileName(7, 1200, 'png'), '商品图_0007.png');
eq('扩展名带点也能处理', CORE.buildFileName(3, 5, '.jpg'), '商品图_003.jpg');
eq('默认扩展名是 png', CORE.buildFileName(3, 5, ''), '商品图_003.png');
eq('自定义前缀', CORE.buildFileName(2, 5, 'png', 'JD'), 'JD_002.png');

// ===========================================================================
// E. 原图地址改写
// ===========================================================================

group('E. 原图地址改写');

eq(
  '淘宝缩略图后缀被去掉',
  CORE.toOriginalUrl('https://img.alicdn.com/O1CN01abc.jpg_430x430q90.jpg'),
  'https://img.alicdn.com/O1CN01abc.jpg'
);
eq(
  '淘宝 webp 后缀被去掉',
  CORE.toOriginalUrl('https://img.alicdn.com/O1CN01abc.jpg_430x430q90.jpg_.webp'),
  'https://img.alicdn.com/O1CN01abc.jpg'
);
eq(
  '京东 /n5/ 改写为 /n0/',
  CORE.toOriginalUrl('https://img14.360buyimg.com/n5/jfs/t1/123/456.jpg'),
  'https://img14.360buyimg.com/n0/jfs/t1/123/456.jpg'
);
eq(
  '京东 s400x400_ 前缀被去掉',
  CORE.toOriginalUrl('https://img14.360buyimg.com/s400x400_jfs/t1/123/456.jpg'),
  'https://img14.360buyimg.com/jfs/t1/123/456.jpg'
);
eq(
  '拼多多 !400x400 后缀被去掉',
  CORE.toOriginalUrl('https://img.pddpic.com/goods/a.jpg!400x400.jpg'),
  'https://img.pddpic.com/goods/a.jpg'
);
eq(
  '带签名的云存储链接保持原样（不做任何改写）',
  CORE.toOriginalUrl('https://bucket.oss-cn-hangzhou.aliyuncs.com/a.jpg_400x400.jpg?Expires=1700000000&Signature=abc'),
  'https://bucket.oss-cn-hangzhou.aliyuncs.com/a.jpg_400x400.jpg?Expires=1700000000&Signature=abc'
);
eq(
  '普通链接原样返回',
  CORE.toOriginalUrl('https://img.jd.com/a.jpg'),
  'https://img.jd.com/a.jpg'
);

// ===========================================================================
// F. collectFromDocument（注入式假 DOM）
// ===========================================================================

group('F. 采集流程（假 DOM）');

function makeEl(tag, attrs, extra) {
  const attributeMap = Object.assign({}, attrs || {});
  const options = extra || {};
  const element = {
    tagName: String(tag).toUpperCase(),
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attributeMap, name) ? attributeMap[name] : null;
    },
    getBoundingClientRect: function () {
      return options.rect || { width: 0, height: 0 };
    },
    textContent: options.text || '',
    naturalWidth: (options.natural && options.natural.width) || 0,
    naturalHeight: (options.natural && options.natural.height) || 0
  };
  if (options.currentSrc) element.currentSrc = options.currentSrc;
  return element;
}

function makeDoc(elements, scripts, base) {
  return {
    baseURI: base || 'https://item.jd.com/100012043978.html',
    URL: base || 'https://item.jd.com/100012043978.html',
    querySelectorAll: function (selector) {
      if (selector === '*') return elements;
      if (selector === 'script') return scripts || [];
      return [];
    }
  };
}

const imgMain = makeEl('img', {
  src: 'https://img14.360buyimg.com/n5/jfs/t1/main.jpg',
  'data-src': 'https://img14.360buyimg.com/n5/jfs/t1/main.jpg?spm=a1z10',
  srcset: 'https://img14.360buyimg.com/n5/jfs/t1/main-400.jpg 400w, https://img14.360buyimg.com/n5/jfs/t1/main-800.jpg 800w',
  alt: '主图'
}, { natural: { width: 800, height: 800 } });

const imgLazy = makeEl('img', { 'data-lazy-src': 'https://img14.360buyimg.com/n5/jfs/t1/lazy.jpg' }, {
  rect: { width: 750, height: 750 }
});

const imgIcon = makeEl('img', { src: 'https://img14.360buyimg.com/icon/arrow.png' }, {
  natural: { width: 16, height: 16 }
});

const imgTiny = makeEl('img', { src: 'https://img14.360buyimg.com/n5/jfs/t1/tiny.jpg' }, {
  natural: { width: 20, height: 20 }
});

const divBackground = makeEl('div', { style: 'background-image: url(https://img14.360buyimg.com/n5/jfs/t1/bg.jpg)' , class: 'goods-pic' }, {
  rect: { width: 900, height: 600 }
});

const divPlain = makeEl('div', { class: 'price-line', style: 'color: red' }, { rect: { width: 100, height: 20 } });

const scriptEl = makeEl('script', {}, {
  text: 'window.__DATA__ = {"pic":"https:\\/\\/img14.360buyimg.com\\/n5\\/jfs\\/t1\\/hidden.jpg","idx":"https:\\/\\/img14.360buyimg.com\\/n5\\/jfs\\/t1\\/hidden2.jpg"}',
});

const styleMap = new Map();
styleMap.set(divBackground, { backgroundImage: 'url("https://img14.360buyimg.com/n5/jfs/t1/bg.jpg")' });
styleMap.set(divPlain, { backgroundImage: 'none' });

const doc = makeDoc(
  [imgMain, imgLazy, imgIcon, imgTiny, divBackground, divPlain],
  [scriptEl]
);

const env = {
  getStyle: function (element) {
    return styleMap.get(element) || { backgroundImage: 'none' };
  },
  getRect: function (element) {
    return element.getBoundingClientRect();
  }
};

const resultDefault = CORE.collectFromDocument(doc, {}, env);
const urlsDefault = resultDefault.items.map(function (i) { return i.url; });

check('主图 srcset 取到最大候选', urlsDefault.indexOf('https://img14.360buyimg.com/n5/jfs/t1/main-800.jpg') >= 0);
check(
  'src 与带 spm 的 data-src 被判定为同一张图，只保留一条',
  urlsDefault.filter(function (u) { return u === 'https://img14.360buyimg.com/n5/jfs/t1/main.jpg'; }).length === 1
);
check('带 spm 的追踪参数版本没有被单独保留', urlsDefault.every(function (u) { return u.indexOf('spm=') < 0; }));
check('采集到懒加载 data-lazy-src 图片', urlsDefault.indexOf('https://img14.360buyimg.com/n5/jfs/t1/lazy.jpg') >= 0);
check('采集到 CSS 背景图', urlsDefault.indexOf('https://img14.360buyimg.com/n5/jfs/t1/bg.jpg') >= 0);
check('图标被过滤掉', urlsDefault.indexOf('https://img14.360buyimg.com/icon/arrow.png') < 0);
check('极小图片被过滤掉', urlsDefault.indexOf('https://img14.360buyimg.com/n5/jfs/t1/tiny.jpg') < 0);
check('默认不扫描 script 标签', urlsDefault.indexOf('https://img14.360buyimg.com/n5/jfs/t1/hidden.jpg') < 0);
check('主图尺寸取自 naturalWidth/naturalHeight', resultDefault.items.some(function (i) { return i.url.indexOf('main') >= 0 && i.width === 800 && i.height === 800; }));
check('懒加载图片尺寸取自渲染盒子', resultDefault.items.some(function (i) { return i.url.indexOf('lazy') >= 0 && i.width === 750; }));
check('采集统计里有候选数量', resultDefault.stats.raw > 0);
check('采集统计里有被过滤数量', Object.keys(resultDefault.stats.dropped).length === 5);

const resultNoBg = CORE.collectFromDocument(doc, { includeBackground: false }, env);
check('关闭背景图采集后不再出现 bg.jpg', resultNoBg.items.every(function (i) { return i.url.indexOf('bg.jpg') < 0; }));

const resultScripts = CORE.collectFromDocument(doc, { scanScripts: true }, env);
check('打开脚本扫描后能找到隐藏图片地址', resultScripts.items.some(function (i) { return i.url.indexOf('hidden.jpg') >= 0; }));
check('脚本扫描的结果被标记为 script 来源', resultScripts.items.some(function (i) { return i.source === 'script'; }));

const resultOriginal = CORE.collectFromDocument(doc, { preferOriginal: true }, env);
check('开启原图改写后主图带上了 originalUrl', resultOriginal.items.some(function (i) { return i.originalUrl && i.originalUrl.indexOf('/n0/') >= 0; }));

// ===========================================================================
// 汇总
// ===========================================================================

console.log('\n' + '='.repeat(56));
console.log('测试完成：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach(function (f) {
    console.log('  - ' + f);
  });
  process.exit(1);
}
console.log('全部通过。');
