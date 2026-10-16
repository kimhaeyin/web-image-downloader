# 图提取 ImageGrab

面向电商商品页的图片提取与批量下载 Chrome 扩展（Manifest V3），外加一个静态官网。

在淘宝、天猫、京东、拼多多的商品详情页点一下页面右下角的「获取图片」，插件会把页面里
散落各处的商品图一次性抓出来，在独立标签页里网格预览，勾选后按编号批量下载为 PNG。

- 官网（GitHub Pages）：<https://kimhaein.github.io/web-image-downloader/>
- 安装包：`docs/downloads/imagegrab.zip`（下载后按官网「安装步骤」加载，不要直接双击）

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 图片提取 | 覆盖 `src`、`currentSrc`、`srcset`，以及 `data-src`、`data-lazy-src`、`data-original`、`data-ks-lazyload` 等常见懒加载来源，并处理 CSS `background-image` |
| 去重与过滤 | 归一化地址后去重；过滤图标、logo、占位图、统计埋点像素和 1×1 图片，剔除宽高都小于阈值的图片（阈值可在弹窗里调） |
| 集中预览 | 网格展示全部结果，每张卡片显示宽高尺寸与完整地址，附带复制链接、单独下载、打开原图 |
| 自由勾选 | 全选 / 取消选择 / 反选，也可以点缩略图逐张切换，已选数量实时显示在下载按钮上 |
| PNG 转换 | 取回图片字节后用 canvas 重新编码为 PNG；转换失败会说明具体原因，可回退为原格式下载 |
| 批量下载 | 串行调用浏览器下载接口，文件名形如 `商品图_001.png`，结束时给出成功、原格式回退与失败的数量明细 |

支持站点：`taobao.com`、`tmall.com`、`jd.com`、`pinduoduo.com`、`yangkeduo.com`。

## 边界说明

插件只读取你当前已经打开的页面上可见的图片地址，**不绕过登录、不绕过访问控制、不伪造
Referer 或 Cookie 去规避防盗链**。如果某个图片服务器拒绝了扩展发起的请求，插件会明确
报告这一张转换失败，而不会把原格式文件改名成 `.png` 冒充成功。

## 安装

1. 下载 `docs/downloads/imagegrab.zip` 并解压到一个固定目录（解压后应直接看到 `manifest.json`）。
2. 地址栏输入 `chrome://extensions`（只能手动输入），打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选中第 1 步的文件夹。

## 目录结构

```
extension/          Chrome 扩展本体（也是打包进 ZIP 的全部内容）
  manifest.json
  content.js/.css   内容脚本：页面数据采集 + 右下角「获取图片」按钮
  background.js     Service Worker：下载调度、进度广播、结果缓存
  popup.html/.js/.css  弹窗：开关与阈值设置
  gallery.html/.js/.css 展示页：网格预览、勾选、批量下载与 PNG 转换
  lib/extract-core.js   纯逻辑层（站点识别、URL 处理、过滤去重、采集），浏览器与 Node 共用
  icons/            图标（由 tools/make-icons.js 生成）
docs/               静态官网（GitHub Pages 直接发布这个目录）
tests/              自动化测试
tools/              打包、校验、图标生成、本地静态服务器
```

## 开发与测试

零第三方依赖，只需要 Node.js 18+（本机实测 v24）。

```bash
node tools/serve.js        # 本地预览：http://127.0.0.1:4173/
                           #   官网        /docs/index.html
                           #   图片展示页  /extension/gallery.html
                           #   采集测试页  /tests/browser/collector-fixture.html

npm test                   # Node 单元测试（99 项）
npm run test:browser       # 浏览器测试（需要 Chrome 或 Edge）
npm run test:all           # 两者都跑
```

浏览器测试用 `tests/browser/run-browser-tests.js` 驱动：它自己通过 CDP 拉起本机的
Chrome / Edge，必要时自动启动静态服务器，每个测试场景开一个独立标签页、跑完即关，
判断"做完了"一律靠页面里的真实信号（`<html data-ig-busy>` 标记、DOM 变化、
`window.__COLLECT_TESTS__` 等），不使用固定等待时间。

```bash
node tests/browser/run-browser-tests.js --only=collector   # 只跑采集逻辑测试
node tests/browser/run-browser-tests.js --only=gallery     # 只跑展示页测试
node tests/browser/run-browser-tests.js --only=site        # 只跑官网自检
node tests/browser/run-browser-tests.js --headed           # 显示浏览器窗口
node tests/browser/run-browser-tests.js --only=site --shot=preview.png   # 顺便截整页图
```

当前状态：Node 单元测试 99 项、浏览器采集测试 23 项、展示页测试 75 项、官网自检 25 项，
合计 222 项全部通过。

## 打包与校验

```bash
npm run build:zip    # 把 extension/ 打成 docs/downloads/imagegrab.zip
npm run verify:zip   # 逐条校验 CRC32，并与 extension/ 逐文件比对
```

打包结果可复现：文件顺序、压缩方式与时间戳都是固定的。官网下载区显示的版本号、
文件数量、包体大小和 SHA-256 都由这份 ZIP 的真实字节推导出来，不写死在页面里。

## 许可

MIT
