#!/usr/bin/env node
/**
 * 最小 AList 模拟服务器，供 openlist-stream 冒烟测试使用。
 *
 * 只实现 /stream 路径真正会碰到的三个端点：
 *   POST /api/auth/login  → { code:200, data:{ token } }
 *   POST /api/fs/get      → { code:200, data:{ name, size, raw_url, related } }
 *   GET  /file.mkv        → 支持 Range 的字节流
 *
 * 用法：node mock-alist.js <port>
 * 环境变量：
 *   MOCK_USER / MOCK_PASS  登录凭据（默认 nas-user / nas-pass）
 *   MOCK_SIZE              文件字节数（默认 1 MiB）
 */
const http = require('http');

const port = Number(process.argv[2] || 0);
const USER = process.env.MOCK_USER || 'nas-user';
const PASS = process.env.MOCK_PASS || 'nas-pass';
const SIZE = Number(process.env.MOCK_SIZE || 1024 * 1024);

let loginCount = 0;
let fsGetCount = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function handleFile(req, res) {
  const range = req.headers.range;
  const total = SIZE;
  if (!range) {
    res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': total, 'Accept-Ranges': 'bytes' });
    res.end(Buffer.alloc(total, 0x61));
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  const start = m[1] === '' ? 0 : Number(m[1]);
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  const len = end - start + 1;
  res.writeHead(206, {
    'Content-Type': 'video/x-matroska',
    'Content-Length': len,
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${total}`,
  });
  res.end(Buffer.alloc(len, 0x62));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname === '/__stats') {
    json(res, 200, { loginCount, fsGetCount });
    return;
  }
  if (url.pathname === '/__reset') {
    loginCount = 0;
    fsGetCount = 0;
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/login/hash') {
    loginCount++;
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }
      if (parsed.username !== USER || parsed.password !== PASS) {
        json(res, 200, { code: 401, message: '密码错误' });
        return;
      }
      json(res, 200, { code: 200, message: 'success', data: { token: 'mock-token' } });
    });
    return;
  }
  if (url.pathname === '/api/fs/get') {
    fsGetCount++;
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }
      if (req.headers.authorization !== 'mock-token') {
        json(res, 200, { code: 401, message: 'token 无效' });
        return;
      }
      if (parsed.path !== '/movie/a.mkv') {
        json(res, 200, { code: 500, message: 'object not found' });
        return;
      }
      json(res, 200, {
        code: 200,
        message: 'success',
        data: {
          name: 'a.mkv',
          size: SIZE,
          is_dir: false,
          provider: 'Local',
          raw_url: `http://127.0.0.1:${port}/file.mkv?sign=abc`,
          related: [],
        },
      });
    });
    return;
  }
  if (url.pathname === '/file.mkv') {
    handleFile(req, res);
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-alist listening on ${server.address().port}`);
});
