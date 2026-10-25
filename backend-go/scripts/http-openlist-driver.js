#!/usr/bin/env node
/**
 * OpenList 挂载/解析/流代理 + stream 媒体代理 —— Node ↔ Go HTTP 对拍驱动器。
 *
 * 覆盖 19 步：鉴权、挂载列表、目录浏览（含 object not found）、解析、直链、
 * me、搜索、流代理（整段 + Range）、连通性测试（成功/缺参）、增改删、
 * /api/stream/proxy-image 与 /api/stream/proxy 的错误分支与正常代理。
 *
 * 归一化原则：
 *   - 挂载的 id / createdAt / updatedAt 不打比（时间格式两侧风格不同）；
 *   - 涉及的挂载 id 由种子固定成 901，两侧一致，后续步骤直接用它；
 *   - 代理正文只记长度与首尾字节（1 MiB 的 hex 没法逐字节比）。
 *
 * 用法：node http-openlist-driver.js <baseUrl> <outFile> <user> <pass> <alistBase>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-openlist.json';
const USER = process.argv[4] || 'ol-parity';
const PASS = process.argv[5] || 'ol-parity-pass';
const ALIST = process.argv[6] || 'http://127.0.0.1:3401';

const MOUNT_ID = 901;
const log = { base: BASE, steps: [] };
let token = '';

function maskMount(mount) {
  if (!mount || typeof mount !== 'object') return mount;
  const copy = JSON.parse(JSON.stringify(mount));
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

function maskBody(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = JSON.parse(JSON.stringify(value));
  if (Array.isArray(copy.mounts)) copy.mounts = copy.mounts.map(maskMount);
  if (copy.mount) copy.mount = maskMount(copy.mount);
  return copy;
}

async function request(method, path, { body, withToken = true, range } = {}) {
  const headers = {};
  if (withToken && token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (range) headers.Range = range;
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, buffer, headers: resp.headers };
}

/** 记录一步：JSON 响应打比 body，二进制只打比长度与首尾字节。 */
async function step(name, method, path, opts = {}) {
  try {
    const { status, buffer, headers } = await request(method, path, opts);
    const contentType = headers.get('content-type') || '';
    const isJSON = contentType.includes('application/json');
    let body = null;
    if (isJSON) {
      try {
        body = maskBody(JSON.parse(buffer.toString('utf8')));
      } catch {
        body = { __raw: buffer.toString('utf8').slice(0, 300) };
      }
    }
    log.steps.push({
      step: name,
      status,
      contentType: isJSON ? contentType : contentType.replace(/;.*/, ''),
      body,
      byteLength: isJSON ? undefined : buffer.length,
      head: isJSON ? undefined : buffer.subarray(0, 4).toString('hex'),
      tail: isJSON ? undefined : buffer.subarray(-2).toString('hex'),
      acao: headers.get('access-control-allow-origin') || '',
      contentRange: headers.get('content-range') || '',
    });
  } catch (err) {
    log.steps.push({ step: name, error: String(err && err.message) });
  }
}

async function login() {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const data = await resp.json().catch(() => ({}));
  // 登录接口回的是 accessToken（不是 token），两侧一致
  token = data.accessToken || data.token || '';
  if (!token) throw new Error(`登录失败: ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
}

const mountBase = `/api/openlist/mounts/${MOUNT_ID}`;

async function main() {
  try {
    await login();
  } catch (err) {
    log.error = String(err && err.message);
    fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
    console.error(log.error);
    process.exit(1);
  }

  await step('mounts without token', 'GET', '/api/openlist/mounts', { withToken: false });
  await step('list mounts', 'GET', '/api/openlist/mounts');
  await step('browse root', 'GET', `${mountBase}/browse?path=/movie`);
  await step('browse missing', 'GET', `${mountBase}/browse?path=/missing`);
  await step('resolve file', 'GET',
    `/api/openlist/resolve?mountId=${MOUNT_ID}&path=/movie/a.mkv`);
  await step('resolve missing params', 'GET', '/api/openlist/resolve');
  await step('direct url', 'GET',
    `/api/openlist/direct-url?mountId=${MOUNT_ID}&path=/movie/a.mkv`);
  await step('me', 'GET', `/api/openlist/me?mountId=${MOUNT_ID}`);
  await step('me missing param', 'GET', '/api/openlist/me');
  await step('search', 'GET',
    `/api/openlist/search?mountId=${MOUNT_ID}&keywords=a&parent=/`);
  await step('search empty keywords', 'GET',
    `/api/openlist/search?mountId=${MOUNT_ID}&keywords=`);
  await step('proxy full', 'GET',
    `/api/openlist/proxy?mountId=${MOUNT_ID}&path=/movie/a.mkv`);
  await step('proxy range', 'GET',
    `/api/openlist/proxy?mountId=${MOUNT_ID}&path=/movie/a.mkv`, { range: 'bytes=2-5' });
  await step('proxy missing path', 'GET',
    `/api/openlist/proxy?mountId=${MOUNT_ID}`);

  await step('mounts test ok', 'POST', '/api/openlist/mounts/test', {
    body: { serverUrl: ALIST, username: 'nas-user', password: 'nas-pass', path: '/movie' },
  });
  await step('mounts test missing server', 'POST', '/api/openlist/mounts/test', {
    body: { username: 'nas-user' },
  });
  await step('mounts test bad password', 'POST', '/api/openlist/mounts/test', {
    body: { serverUrl: ALIST, username: 'nas-user', password: 'wrong', path: '/movie' },
  });

  await step('create mount', 'POST', '/api/openlist/mounts', {
    body: {
      name: '对拍新建',
      serverUrl: ALIST,
      path: '/movie',
      username: 'nas-user',
      password: 'nas-pass',
    },
  });
  await step('create mount no name', 'POST', '/api/openlist/mounts', {
    body: { serverUrl: ALIST },
  });

  // 更新/删除针对种子挂载（新建的是随机 id，两侧不同没法打比）
  await step('update name only', 'PUT', mountBase, {
    body: {
      name: '改个名字',
      serverUrl: ALIST,
      path: '/movie',
      username: 'nas-user',
      directLink: false,
    },
  });
  await step('delete mount', 'DELETE', mountBase);
  // 「删完列表里必须没有它」不在这里对拍：Node 侧（sql.js 持久化）在本序列下
  // 出现过「DELETE 回 200 但行仍在列表里」的自我不一致，Go 侧是直接落库。
  // 这条语义由 internal/api/openlist_mounts_test.go 断言（删除后列表为空 +
  // 再删 404），并在 MIGRATION 七之二登记为刻意差异。

  // stream 媒体代理
  await step('proxy-image no url', 'GET', '/api/stream/proxy-image');
  await step('proxy-image wrong domain', 'GET',
    '/api/stream/proxy-image?url=' + encodeURIComponent('https://example.com/a.jpg'));
  await step('stream proxy no url', 'GET', '/api/stream/proxy');
  await step('stream proxy local', 'GET',
    '/api/stream/proxy?url=' + encodeURIComponent(`${ALIST}/file.mkv`), { range: 'bytes=0-3' });

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`wrote ${OUT} (${log.steps.length} steps)`);
}

main();
