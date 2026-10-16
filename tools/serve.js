/**
 * 本地静态服务器，用于本地预览官网和跑浏览器测试。
 *
 *   node tools/serve.js            # 默认 http://127.0.0.1:4173 ，根目录是仓库根
 *   node tools/serve.js 5000       # 指定端口
 *
 * 仓库根作为站点根，因此：
 *   http://127.0.0.1:4173/docs/index.html          官网
 *   http://127.0.0.1:4173/extension/gallery.html   图片展示页
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer(function (req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/docs/index.html';

  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('静态服务器已启动：http://127.0.0.1:' + PORT + '/');
  console.log('  官网        http://127.0.0.1:' + PORT + '/docs/index.html');
  console.log('  图片展示页  http://127.0.0.1:' + PORT + '/extension/gallery.html');
  console.log('  采集测试页  http://127.0.0.1:' + PORT + '/tests/browser/collector-fixture.html');
});
