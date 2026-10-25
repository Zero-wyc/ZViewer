#!/usr/bin/env node
/**
 * 更新器（/api/system/update/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 为什么只覆盖「拒绝路径」：五个端点里四个会真的下载发布包、覆盖程序文件并
 * 拉起脚本重启进程；那个脚本第一步就是 taskkill / pgrep-kill 本进程。
 * 在对拍机上跑成功路径等于把两个后端连同测试目录一起干掉。
 *
 * 所以这里比的是「进到危险动作之前」的全部判定：
 *   - 鉴权（401）与权限（403）的文案
 *   - 上传体的类型白名单（400）
 *   - 扩展名校验（500）与「先校验后切 SSE」的顺序（SSE error 事件）
 * 成功路径的版本判定由 gen-updater-fixtures.js + Go 单测覆盖。
 *
 * 桌面托管（409）不在对拍里：ZVIEWER_DESKTOP 是进程启动时的环境变量，
 * 为了它单独起一对进程不划算，那条由 Go 的 api/updater_test.go 钉住。
 *
 * 用法：node http-updater-driver.js <baseUrl> <outFile> <rootUser> <rootPass> <userName> <userPass>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-updater.json';
const ROOT_USER = process.argv[4] || 'updater-root';
const ROOT_PASS = process.argv[5] || 'updater-root-pass';
const NORMAL_USER = process.argv[6] || 'updater-user';
const NORMAL_PASS = process.argv[7] || 'updater-user-pass';

const log = { base: BASE, steps: [] };
let token = '';

const ENDPOINTS = [
  ['check', 'GET', '/api/system/update/check'],
  ['apply-stream', 'POST', '/api/system/update/apply-stream'],
  ['apply', 'POST', '/api/system/update/apply'],
  ['upload-stream', 'POST', '/api/system/update/upload-stream'],
  ['upload', 'POST', '/api/system/update/upload'],
];

async function call(method, path, { body, contentType, withToken = true } = {}) {
  const headers = {};
  if (withToken && token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers['Content-Type'] = contentType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    return { status: resp.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** exact：状态码 + 解析后的 JSON 全等。 */
async function exact(name, method, path, options) {
  try {
    const { status, text } = await call(method, path, options);
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { __raw: text.slice(0, 300) };
      }
    }
    log.steps.push({ step: name, mode: 'exact', status, body: parsed });
  } catch (err) {
    log.steps.push({ step: name, mode: 'exact', error: String((err && err.message) || err) });
  }
}

/** raw：状态码 + 原文（给 SSE 用，事件流不是合法 JSON）。 */
async function raw(name, method, path, options) {
  try {
    const { status, text } = await call(method, path, options);
    log.steps.push({ step: name, mode: 'raw', status, text });
  } catch (err) {
    log.steps.push({ step: name, mode: 'raw', error: String((err && err.message) || err) });
  }
}

async function login(username, password) {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`login ${username} failed: ${resp.status} ${JSON.stringify(body)}`);
  }
  return body.accessToken || (body.tokens && body.tokens.accessToken) || '';
}

async function main() {
  // ---- 未登录：五个端点都应 401 ----
  token = '';
  for (const [name, method, path] of ENDPOINTS) {
    await exact(`anon ${name}`, method, path);
  }

  // ---- 普通用户：403「仅 root 可操作」 ----
  token = await login(NORMAL_USER, NORMAL_PASS);
  for (const [name, method, path] of ENDPOINTS) {
    await exact(`user ${name}`, method, path);
  }

  // ---- root：入参校验 ----
  token = await login(ROOT_USER, ROOT_PASS);

  await exact('root upload no-content-type', 'POST', '/api/system/update/upload', {
    body: new Uint8Array([1, 2, 3]),
  });
  // 彻底空：无 Content-Type、零长度。Express 的 raw 同样不解析。
  await exact('root upload no-body', 'POST', '/api/system/update/upload', {
    body: new Uint8Array(0),
  });
  await exact('root upload empty-body', 'POST', '/api/system/update/upload', {
    body: '',
    contentType: 'application/zip',
  });
  await exact('root upload wrong-type', 'POST', '/api/system/update/upload', {
    body: '{}',
    contentType: 'application/json',
  });
  await exact(
    'root upload bad-extension',
    'POST',
    '/api/system/update/upload?filename=update.tar',
    { body: 'whatever', contentType: 'application/octet-stream' },
  );

  // 注意：**不要**在这里塞「扩展名对但内容不是压缩包」的用例。
  // Node 在 Windows 上用 PowerShell Expand-Archive 解压，非压缩包时
  // 退出码仍是 0（错误只落在 stderr），于是 Node 会一路走到「拉起更新脚本」：
  // 那个脚本会 taskkill /IM node.exe、把仓库根的 config/ 挪走再复制垃圾文件。
  // 实测跑一次就把对拍进程全杀了、config 被短暂移走（随后恢复）。
  // 这条分支的 Go 行为由 internal/api/updater_test.go 单测覆盖；
  // Node 的「假成功」是它自己的缺陷，不该被当成对拍基线。

  // 先校验后切流：状态码恒 200，错误只出现在 SSE 事件里。
  await raw(
    'root upload-stream bad-extension',
    'POST',
    '/api/system/update/upload-stream?filename=bad.tar',
    { body: 'whatever', contentType: 'application/octet-stream' },
  );

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String((err && err.message) || err) }, null, 2));
  process.exit(1);
});
