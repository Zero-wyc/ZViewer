#!/usr/bin/env node
/**
 * 极简 WebDAV 服务器（对拍/冒烟用）。
 *
 * 只实现本项目真正依赖的三种交互：
 *   - PROPFIND Depth:0（取单文件属性，空 body = allprop）
 *   - PROPFIND Depth:1（列目录）
 *   - GET（可选 Range）
 *
 * 刻意保留两个「难搞的真实现场」：
 *   1. 文件名带中文与空格（验证两端的路径编码是否一致）；
 *   2. Basic Auth 必须严格校验（凭证错时回 401，用来验证错误码映射）。
 *
 * 用法：node mock-webdav.js <端口> [--user u --pass p]
 * 另外暴露 GET /__stats 返回 propfind/get 计数，用于验证缓存生效。
 */
const http = require('http');

const port = Number(process.argv[2] || 0);
const user = process.env.MOCK_DAV_USER || 'dav-user';
const pass = process.env.MOCK_DAV_PASS || 'dav-secret';

// 虚拟文件树：path → { type, size, lastModified }
const TREE = {
  '/dav': { type: 'directory', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
  '/dav/videos': { type: 'directory', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
  '/dav/videos/sub': { type: 'directory', lastModified: 'Wed, 21 Oct 2026 07:29:00 GMT' },
  '/dav/videos/sub/b.mp4': { type: 'file', size: 2048, lastModified: 'Wed, 21 Oct 2026 07:30:00 GMT' },
  '/dav/videos/a.mkv': { type: 'file', size: 1048576, lastModified: 'Wed, 21 Oct 2026 07:31:00 GMT' },
  '/dav/videos/测试 影片.mp4': { type: 'file', size: 4096, lastModified: 'Wed, 21 Oct 2026 07:32:00 GMT' },
};

const stats = { propfind: 0, get: 0 };

/** 按字节确定性地生成内容，便于两端校验切片是否一致。 */
function fileBytes(path, size) {
  const buf = Buffer.alloc(size);
  const seed = Buffer.from(path, 'utf8');
  for (let i = 0; i < size; i++) buf[i] = (seed[i % seed.length] + i) & 0xff;
  return buf;
}

function decodePath(rawUrl) {
  const pathname = rawUrl.split('?')[0];
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function escapeXML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function encodeHref(pathname) {
  return pathname.split('/').map(encodeURIComponent).join('/');
}

function propBlock(pathname) {
  const node = TREE[pathname];
  const isDir = node.type === 'directory';
  return (
    '<D:response>' +
    '<D:href>' + escapeXML(encodeHref(pathname)) + (isDir && pathname !== '/' ? '/' : '') + '</D:href>' +
    '<D:propstat><D:prop>' +
    '<D:displayname>' + escapeXML(pathname.split('/').filter(Boolean).pop() || '') + '</D:displayname>' +
    '<D:getlastmodified>' + node.lastModified + '</D:getlastmodified>' +
    '<D:resourcetype>' + (isDir ? '<D:collection/>' : '') + '</D:resourcetype>' +
    (isDir ? '' : '<D:getcontentlength>' + node.size + '</D:getcontentlength>') +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
    '</D:response>'
  );
}

function childrenOf(dirPath) {
  const prefix = dirPath === '/' ? '/' : dirPath + '/';
  return Object.keys(TREE).filter((p) => {
    if (p === dirPath) return false;
    if (!p.startsWith(prefix)) return false;
    return !p.slice(prefix.length).includes('/');
  });
}

const server = http.createServer((req, res) => {
  const pathname = normalize(decodePath(req.url));
  const send = (status, body, headers) => {
    res.writeHead(status, headers || {});
    res.end(body);
  };

  if (pathname === '/__stats') {
    send(200, JSON.stringify(stats), { 'Content-Type': 'application/json' });
    return;
  }

  // Basic Auth 严格校验：错凭证回 401，两端都应映射成 AUTH_FAILED
  const auth = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  if (auth !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' });
    res.end('unauthorized');
    return;
  }

  const node = TREE[pathname];
  if (!node) {
    send(404, 'not found');
    return;
  }

  if (req.method === 'PROPFIND') {
    stats.propfind += 1;
    const depth = String(req.headers.depth || '0');
    if (depth === '1' && node.type === 'directory') {
      const body =
        '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
        propBlock(pathname) +
        childrenOf(pathname).map(propBlock).join('') +
        '</D:multistatus>';
      send(207, body, { 'Content-Type': 'application/xml; charset=utf-8' });
      return;
    }
    const body =
      '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
      propBlock(pathname) +
      '</D:multistatus>';
    send(207, body, { 'Content-Type': 'application/xml; charset=utf-8' });
    return;
  }

  if (req.method === 'GET') {
    stats.get += 1;
    if (node.type === 'directory') {
      send(405, 'is a directory');
      return;
    }
    const data = fileBytes(pathname, node.size);
    const range = req.headers.range || '';
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      send(200, data, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
        'Accept-Ranges': 'bytes',
      });
      return;
    }
    let start = match[1] === '' ? undefined : Number(match[1]);
    let end = match[2] === '' ? undefined : Number(match[2]);
    if (start === undefined) {
      start = Math.max(0, data.length - (end || 0));
      end = data.length - 1;
    } else if (end === undefined || end >= data.length) {
      end = data.length - 1;
    }
    if (start >= data.length || start > end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + data.length });
      res.end('range not satisfiable');
      return;
    }
    const slice = data.subarray(start, end + 1);
    send(206, slice, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(slice.length),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length,
      'Accept-Ranges': 'bytes',
    });
    return;
  }

  send(405, 'method not allowed');
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write('[mock-webdav] listening on ' + server.address().port + '\n');
});
