#!/usr/bin/env node
/**
 * 服务器文件 / 统计 / 客户端日志 / 直链解析 / CLI 代理 —— HTTP 端点对拍驱动器。
 *
 * 覆盖 18 个端点：
 *   服务器文件：roots（列/增/删）、browse、browse-system、upload、folder、
 *               rename、file(DELETE)、resolve、proxy(GET/HEAD)
 *   其余：/api/stats/traffic、/api/client-logs、/api/direct-resolve/movie、
 *         /api/cli/resolve
 *
 * 与事件流驱动器的区别：这里比的是「HTTP 状态码 + 响应体」，因此规范化只做三件事：
 *   1. 两侧 uploads/custom 目录的绝对路径换成 <UPLOADS> / <CUSTOM>（临时目录必然不同）；
 *   2. 文件时间戳换成 <TIME>（建目录的时刻不同）；
 *   3. 统计类数值（traffic 的字节数/速度）只比键集合，不比具体值。
 *
 * 用法：node http-serverfiles-driver.js <baseUrl> <outFile> <uploadsDir> <customDir>
 */
'use strict';

const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-serverfiles.json';
const UPLOADS = process.argv[4] || '';
const CUSTOM = process.argv[5] || '';

const log = { base: BASE, steps: [] };
let rootToken = '';
let userToken = '';

/** 把绝对路径与时间戳规范化掉，其余原样保留。 */
function normalize(value) {
  if (typeof value === 'string') {
    let s = value;
    if (UPLOADS) s = s.split(UPLOADS).join('<UPLOADS>');
    if (CUSTOM) s = s.split(CUSTOM).join('<CUSTOM>');
    // 反斜杠形式（Windows 的 absPath）
    if (UPLOADS) s = s.split(UPLOADS.replace(/\//g, '\\')).join('<UPLOADS>');
    if (CUSTOM) s = s.split(CUSTOM.replace(/\//g, '\\')).join('<CUSTOM>');
    // ISO 时间戳：值两侧必然不同，但「键存在」是语义，所以替换而不是删键
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TIME>');
    return s;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

/** 排序后序列化，避免键顺序造成的假差异。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

async function request(method, path, { token = rootToken, headers = {}, body, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  } else if (raw) {
    init.body = raw.body;
    h['Content-Type'] = raw.contentType;
  }
  const resp = await fetch(`${BASE}${path}`, init);
  const text = await resp.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { __raw: text.slice(0, 200) };
    }
  }
  return {
    status: resp.status,
    headers: {
      'content-type': resp.headers.get('content-type'),
      'accept-ranges': resp.headers.get('accept-ranges'),
      'content-range': resp.headers.get('content-range'),
      'content-length': resp.headers.get('content-length'),
    },
    body: parsed,
  };
}

async function step(name, method, path, options) {
  let result;
  try {
    result = await request(method, path, options);
  } catch (err) {
    result = { error: String(err && err.message) };
  }
  log.steps.push({ step: name, ...normalize(result) });
  return result;
}

async function login(username, password) {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`login ${username} failed: ${resp.status} ${JSON.stringify(body)}`);
  const token = body.accessToken || (body.data && body.data.accessToken);
  if (!token) throw new Error(`login ${username} 未拿到 accessToken: ${JSON.stringify(body)}`);
  return token;
}

/** 构造 multipart 上传体（字段顺序与前端一致：targetDir 在前）。 */
function buildUploadBody(targetDir, files) {
  const boundary = '----zviewerparity' + Math.random().toString(36).slice(2);
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s, 'utf8'));
  if (targetDir !== undefined && targetDir !== null) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="targetDir"\r\n\r\n${targetDir}\r\n`);
  }
  for (const file of files) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    push(file.content);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  rootToken = await login('sio-owner', 'sio-pass-1234');
  const viewerToken = await login('sio-viewer', 'sio-pass-1234');
  userToken = viewerToken;

  const enc = encodeURIComponent;

  // ===== 1. 根目录 =====
  await step('roots-list', 'GET', '/api/server-files/roots');
  await step('roots-list-as-user', 'GET', '/api/server-files/roots', { token: userToken });
  await step('roots-list-anonymous', 'GET', '/api/server-files/roots', { token: '' });
  await step('roots-add-empty-name', 'POST', '/api/server-files/roots', { body: { name: '  ', absPath: UPLOADS } });
  await step('roots-add-empty-path', 'POST', '/api/server-files/roots', { body: { name: 'x', absPath: '  ' } });
  await step('roots-add-missing-dir', 'POST', '/api/server-files/roots', {
    body: { name: 'x', absPath: `${UPLOADS}/definitely-missing` },
  });
  await step('roots-add-uploads-duplicate', 'POST', '/api/server-files/roots', {
    body: { name: 'x', absPath: UPLOADS },
  });
  await step('roots-add-ok', 'POST', '/api/server-files/roots', {
    body: { name: '自定义空间', absPath: CUSTOM, readonly: true },
  });
  await step('roots-add-duplicate', 'POST', '/api/server-files/roots', {
    body: { name: 'again', absPath: CUSTOM },
  });

  // ===== 2. 浏览 =====
  await step('browse-uploads', 'GET', `/api/server-files/browse?path=${enc('uploads:/')}`);
  await step('browse-custom', 'GET', `/api/server-files/browse?path=${enc('custom:1:/')}`);
  await step('browse-legacy-path', 'GET', `/api/server-files/browse?path=${enc('/dirA')}`);
  await step('browse-escape', 'GET', `/api/server-files/browse?path=${enc('uploads:../x')}`);
  await step('browse-missing-dir', 'GET', `/api/server-files/browse?path=${enc('uploads:/nope')}`);
  await step('browse-unknown-root', 'GET', `/api/server-files/browse?path=${enc('custom:9:/')}`);
  await step('browse-system-missing', 'GET', `/api/server-files/browse-system?absPath=${enc(`${UPLOADS}/nope`)}`);
  await step('browse-system-file', 'GET', `/api/server-files/browse-system?absPath=${enc(`${UPLOADS}/z.mp4`)}`);

  // ===== 3. 变更类 =====
  await step('folder-empty-name', 'POST', '/api/server-files/folder', { body: { parent: 'uploads:/', name: ' ' } });
  await step('folder-illegal', 'POST', '/api/server-files/folder', { body: { parent: 'uploads:/', name: 'a/b' } });
  await step('folder-readonly-root', 'POST', '/api/server-files/folder', {
    body: { parent: 'custom:1:/', name: 'x' },
  });
  await step('folder-ok', 'POST', '/api/server-files/folder', { body: { parent: 'uploads:/', name: '新目录' } });
  await step('folder-dup', 'POST', '/api/server-files/folder', { body: { parent: 'uploads:/', name: '新目录' } });

  await step('rename-missing-args', 'POST', '/api/server-files/rename', { body: { path: 'uploads:/新目录' } });
  await step('rename-illegal', 'POST', '/api/server-files/rename', {
    body: { path: 'uploads:/新目录', newName: 'a:b' },
  });
  await step('rename-not-found', 'POST', '/api/server-files/rename', {
    body: { path: 'uploads:/nope', newName: 'x' },
  });
  await step('rename-ok', 'POST', '/api/server-files/rename', {
    body: { path: 'uploads:/新目录', newName: '改名后' },
  });
  await step('rename-conflict', 'POST', '/api/server-files/rename', {
    body: { path: 'uploads:/改名后', newName: 'dirA' },
  });

  // ===== 4. 上传 =====
  const upload = buildUploadBody('uploads:/uploaddir', [
    { name: 'a.mp4', content: Buffer.from('hello-parity') },
  ]);
  await step('upload-ok', 'POST', '/api/server-files/upload', { raw: upload });
  const uploadDup = buildUploadBody('uploads:/uploaddir', [
    { name: 'a.mp4', content: Buffer.from('second') },
  ]);
  await step('upload-duplicate-name', 'POST', '/api/server-files/upload', { raw: uploadDup });
  const uploadReadonly = buildUploadBody('custom:1:/', [{ name: 'b.mp4', content: Buffer.from('x') }]);
  await step('upload-readonly-root', 'POST', '/api/server-files/upload', { raw: uploadReadonly });
  await step('upload-no-files', 'POST', '/api/server-files/upload', {
    raw: { body: Buffer.alloc(0), contentType: 'application/octet-stream' },
  });
  await step('upload-as-user', 'POST', '/api/server-files/upload', {
    token: userToken,
    raw: buildUploadBody('uploads:/', [{ name: 'c.mp4', content: Buffer.from('x') }]),
  });

  // ===== 5. 解析与播放代理 =====
  await step('resolve-ok', 'GET', `/api/server-files/resolve?path=${enc('uploads:/sample.mkv')}`);
  await step('resolve-missing-path', 'GET', '/api/server-files/resolve');
  await step('resolve-dir', 'GET', `/api/server-files/resolve?path=${enc('uploads:/')}`);
  await step('resolve-unknown', 'GET', `/api/server-files/resolve?path=${enc('uploads:/nope.mkv')}`);
  await step('resolve-as-user', 'GET', `/api/server-files/resolve?path=${enc('uploads:/sample.mkv')}`, {
    token: userToken,
  });

  await step('proxy-head', 'HEAD', `/api/server-files/proxy?path=${enc('uploads:/sample.mkv')}`, {
    token: userToken,
  });
  await step('proxy-range', 'GET', `/api/server-files/proxy?path=${enc('uploads:/sample.mkv')}`, {
    token: userToken,
    headers: { Range: 'bytes=2-5' },
  });
  await step('proxy-range-open', 'GET', `/api/server-files/proxy?path=${enc('uploads:/sample.mkv')}`, {
    token: userToken,
    headers: { Range: 'bytes=5-' },
  });
  await step('proxy-range-unsatisfiable', 'GET', `/api/server-files/proxy?path=${enc('uploads:/sample.mkv')}`, {
    token: userToken,
    headers: { Range: 'bytes=999-1000' },
  });
  await step('proxy-whole', 'GET', `/api/server-files/proxy?path=${enc('uploads:/sample.mkv')}`, {
    token: userToken,
  });
  await step('proxy-anonymous', 'GET', `/api/server-files/proxy?path=${enc('uploads:/sample.mkv')}`, {
    token: '',
  });
  await step('proxy-missing-path', 'GET', '/api/server-files/proxy', { token: userToken });

  // ===== 6. 删除 =====
  await step('delete-root', 'DELETE', `/api/server-files/file?path=${enc('uploads:/')}`);
  await step('delete-custom-root', 'DELETE', `/api/server-files/file?path=${enc('custom:1:/')}`);
  await step('delete-readonly-root-file', 'DELETE', `/api/server-files/file?path=${enc('custom:1:/x')}`);
  await step('delete-file-not-found', 'DELETE', `/api/server-files/file?path=${enc('uploads:/nope')}`);
  await step('delete-file-ok', 'DELETE', `/api/server-files/file?path=${enc('uploads:/uploaddir/a (1).mp4')}`);

  // ===== 7. 根目录删除 =====
  await step('roots-delete-invalid', 'DELETE', '/api/server-files/roots/abc');
  await step('roots-delete-not-found', 'DELETE', '/api/server-files/roots/999');
  await step('roots-delete-ok', 'DELETE', '/api/server-files/roots/1');
  await step('roots-delete-again', 'DELETE', '/api/server-files/roots/1');

  // ===== 8. 统计 / 客户端日志 / 直链解析 / CLI =====
  // traffic 的数值两侧必然不同，只比键集合。
  const traffic = await step('stats-traffic', 'GET', '/api/stats/traffic');
  if (traffic && traffic.body && traffic.body.stats) {
    const keys = Object.keys(traffic.body.stats).sort();
    log.steps[log.steps.length - 1] = {
      step: 'stats-traffic',
      status: traffic.status,
      headers: traffic.headers,
      body: { success: traffic.body.success, statsKeys: keys },
    };
  }
  await step('stats-traffic-as-user', 'GET', '/api/stats/traffic', { token: userToken });
  await step('stats-traffic-anonymous', 'GET', '/api/stats/traffic', { token: '' });

  const logBody = { entries: [{ level: 'warn', messages: ['对拍日志'], timestamp: '2026-01-01T00:00:00.000Z' }] };
  await step('client-logs-ok', 'POST', '/api/client-logs', { body: logBody, token: '' });
  await step('client-logs-empty', 'POST', '/api/client-logs', { body: { entries: [] }, token: '' });
  await step('client-logs-bad-shape', 'POST', '/api/client-logs', { body: { entries: 'x' }, token: '' });

  await step('direct-resolve-missing', 'GET', '/api/direct-resolve/movie');
  await step('direct-resolve-bad-id', 'GET', '/api/direct-resolve/movie?movieId=abc');
  await step('direct-resolve-not-found', 'GET', '/api/direct-resolve/movie?movieId=999999');
  await step('direct-resolve-anonymous', 'GET', '/api/direct-resolve/movie?movieId=1', { token: '' });

  await step('cli-resolve-missing-bvid', 'GET', '/api/cli/resolve', { token: '' });
  await step('cli-resolve-bad-cid', 'GET', '/api/cli/resolve?bvid=BV1xx411c7mD&cid=abc', { token: '' });

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2), 'utf8');
  console.log(`已写出 ${log.steps.length} 个步骤 → ${OUT}`);
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ error: String(err && err.stack || err) }, null, 2), 'utf8');
  console.error(err);
  process.exit(1);
});
