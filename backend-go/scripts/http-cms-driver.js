#!/usr/bin/env node
/**
 * CMS 采集源（/api/stream/cms/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 上游是本地假采集站（scripts/mock-cms.js），数据固定，因此这里**全部按
 * exact 比较**（状态码 + 完整响应体）。这批端点的「解析」本来就是纯函数：
 * 拼 URL、解析 vod_play_url、挑组/集、嗅探格式——固定输入下必须逐字节一致。
 *
 * 用法：node http-cms-driver.js <baseUrl> <outFile> <mockBaseUrl>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-cms.json';
const MOCK = process.argv[4] || 'http://127.0.0.1:36530';

const fs = require('node:fs');

const log = { base: BASE, mock: MOCK, steps: [] };
let adminToken = '';
let userToken = '';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { __raw: text.slice(0, 200) };
      }
    }
    return { status: resp.status, parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function step(name, method, path, options = {}) {
  try {
    const { status, parsed } = await call(method, path, options);
    log.steps.push({ step: name, status, body: stable(parsed) });
  } catch (err) {
    log.steps.push({ step: name, error: String((err && err.message) || err) });
  }
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
  if (!token) throw new Error(`login ${username} 未拿到 accessToken`);
  return token;
}

const enc = encodeURIComponent;

async function main() {
  adminToken = await login('cms-admin', 'cms-pass-1234');
  userToken = await login('cms-user', 'cms-pass-1234');

  const asUser = { token: userToken };
  const post = (body) => ({ token: adminToken, body });

  // ===== 数据源 =====
  await step('sources', 'GET', '/api/stream/cms/sources', { token: adminToken });

  // ===== 单站搜索（siteB 走 ac=detail 兜底）=====
  await step('search-siteA', 'GET', `/api/stream/cms/search?source=cms0_siteA&keyword=${enc('演示')}`, {
    token: adminToken,
  });
  await step('search-siteB', 'GET', `/api/stream/cms/search?source=cms0_siteB&keyword=${enc('演示')}`, {
    token: adminToken,
  });
  await step('search-unknown', 'GET', '/api/stream/cms/search?source=cms9_none&keyword=a', {
    token: adminToken,
  });
  await step('search-missing-source', 'GET', '/api/stream/cms/search?keyword=a', { token: adminToken });
  await step('search-missing-keyword', 'GET', '/api/stream/cms/search?source=cms0_siteA', {
    token: adminToken,
  });

  // ===== 聚合搜索（同名「演示影片」去重）=====
  await step('search-all', 'GET', `/api/stream/cms/search-all?keyword=${enc('演示')}`, {
    token: adminToken,
  });
  await step('search-all-missing-keyword', 'GET', '/api/stream/cms/search-all', { token: adminToken });

  // ===== 详情 =====
  await step('detail', 'GET', '/api/stream/cms/detail?source=cms0_siteA&vodId=1', {
    token: adminToken,
  });
  await step('detail-unknown-vod', 'GET', '/api/stream/cms/detail?source=cms0_siteA&vodId=999', {
    token: adminToken,
  });
  await step('detail-missing-source', 'GET', '/api/stream/cms/detail?vodId=1', { token: adminToken });
  await step('detail-missing-vodId', 'GET', '/api/stream/cms/detail?source=cms0_siteA', {
    token: adminToken,
  });

  // ===== 解析（第二次必须命中缓存，响应相同）=====
  const resolveBody = {
    source: 'cms0_siteA',
    params: { vodId: '1', playFromIndex: 1, episodeIndex: 1 },
  };
  await step('resolve', 'POST', '/api/stream/cms/resolve', post(resolveBody));
  await step('resolve-cached', 'POST', '/api/stream/cms/resolve', post(resolveBody));
  await step(
    'resolve-out-of-range',
    'POST',
    '/api/stream/cms/resolve',
    post({ source: 'cms0_siteA', params: { vodId: '1', playFromIndex: 0, episodeIndex: 99 } }),
  );
  await step('resolve-missing-params', 'POST', '/api/stream/cms/resolve', post({ source: 'cms0_siteA' }));
  await step(
    'resolve-missing-vodId',
    'POST',
    '/api/stream/cms/resolve',
    post({ source: 'cms0_siteA', params: {} }),
  );
  await step(
    'resolve-unknown-source',
    'POST',
    '/api/stream/cms/resolve',
    post({ source: 'nope', params: { vodId: '1' } }),
  );

  // ===== 配置预览 =====
  await step('inspect', 'GET', `/api/stream/cms/inspect?url=${enc(`${MOCK}/tvbox.json`)}`, {
    token: adminToken,
  });
  await step('inspect-refresh', 'GET', `/api/stream/cms/inspect?url=${enc(`${MOCK}/tvbox.json`)}&refresh=1`, {
    token: adminToken,
  });
  // GBK 编码配置：两侧的 charset 嗅探都要能正确解出中文站名。
  await step('inspect-gbk', 'GET', `/api/stream/cms/inspect?url=${enc(`${MOCK}/gbk.json`)}`, {
    token: adminToken,
  });
  await step('inspect-missing-url', 'GET', '/api/stream/cms/inspect', { token: adminToken });
  await step('inspect-bad-scheme', 'GET', `/api/stream/cms/inspect?url=${enc('ftp://x/y.json')}`, {
    token: adminToken,
  });
  await step('inspect-404', 'GET', `/api/stream/cms/inspect?url=${enc(`${MOCK}/missing.json`)}`, {
    token: adminToken,
  });
  await step('inspect-forbidden', 'GET', `/api/stream/cms/inspect?url=${enc(`${MOCK}/tvbox.json`)}`, asUser);

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`驱动器完成：${log.steps.length} 个步骤 → ${OUT}`);
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String(err) }, null, 2));
  console.error('驱动器异常:', err);
  process.exit(1);
});
