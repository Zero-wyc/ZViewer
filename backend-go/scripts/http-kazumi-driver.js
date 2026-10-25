#!/usr/bin/env node
/**
 * Kazumi（/api/stream/kazumi/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 上游是本地假站（mock-kazumi.js），数据固定 → 全部 exact 比较。
 * 覆盖：规则索引展开（含坏规则跳过与下标推进）、XPath 抓站搜索/选集、
 * API 规则搜索（POST JSON）、nested/delimited 两种章节格式、episodePage
 * 模板与 variables 捕获、5 种播放页形态（直链 / player_aaaa 两种加密 /
 * iframe 嵌套 / HHJX bootstrap）以及解析不到时的 404。
 *
 * 用法：node http-kazumi-driver.js <baseUrl> <outFile> <mockBaseUrl>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-kazumi.json';
const MOCK = process.argv[4] || '';
const m = (path) => MOCK + path;

const log = { base: BASE, steps: [] };
let token = '';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

async function call(method, path, { body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
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

async function step(name, method, path, options) {
  try {
    const { status, parsed } = await call(method, path, options);
    log.steps.push({ step: name, status, body: stable(parsed) });
  } catch (err) {
    log.steps.push({ step: name, error: String((err && err.message) || err) });
  }
}

const exact = (name, method, path, options) => step(name, method, path, options);
const enc = encodeURIComponent;

async function login(username, password) {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`login ${username} failed: ${resp.status} ${JSON.stringify(body)}`);
  token = body.accessToken || body.token || '';
  if (!token) throw new Error('登录响应里没有 accessToken');
}

/** 调一次 episodes 并把结果留下来，供后续 resolve 用。 */
async function episodes(name, source, identifier) {
  const { status, parsed } = await call(
    'GET',
    `/api/stream/kazumi/episodes?source=${enc(source)}&identifier=${enc(identifier)}`,
  );
  log.steps.push({ step: name, status, body: stable(parsed) });
  return parsed && Array.isArray(parsed.episodes) ? parsed.episodes : [];
}

async function main() {
  await login('kazumi-user', 'kazumi-pass-1234');

  // ===== 数据源（索引展开 + 坏规则跳过 + 下标不塌陷）=====
  await exact('sources', 'GET', '/api/stream/kazumi/sources');

  // ===== XPath 规则：搜索 =====
  await exact(
    'search-alpha',
    'GET',
    `/api/stream/kazumi/search?source=kazumi_0&keyword=${enc('孤独摇滚')}`,
  );
  await exact('search-missing-keyword', 'GET', '/api/stream/kazumi/search?source=kazumi_0');
  await exact(
    'search-unknown-source',
    'GET',
    `/api/stream/kazumi/search?source=kazumi_9&keyword=${enc('x')}`,
  );

  // ===== XPath 规则：选集 + 6 种播放页形态逐一解析 =====
  const alphaEpisodes = await episodes('episodes-alpha', 'kazumi_0', m('/detail/1'));
  for (let index = 0; index < alphaEpisodes.length; index += 1) {
    await exact(`resolve-alpha-${index}`, 'POST', '/api/stream/kazumi/resolve', {
      body: { source: 'kazumi_0', episode: alphaEpisodes[index] },
    });
  }
  // 同一集再解一次：走缓存，结果必须一致（缓存键 = 源 + 播放参数）。
  if (alphaEpisodes[0]) {
    await exact('resolve-alpha-cached', 'POST', '/api/stream/kazumi/resolve', {
      body: { source: 'kazumi_0', episode: alphaEpisodes[0] },
    });
  }

  // ===== API 规则：搜索（POST JSON + JSONPath）+ nested 选集 =====
  await exact(
    'search-beta',
    'GET',
    `/api/stream/kazumi/search?source=kazumi_1&keyword=${enc('测试 关键字')}`,
  );
  const betaEpisodes = await episodes('episodes-beta', 'kazumi_1', m('/11'));
  if (betaEpisodes[0]) {
    await exact('resolve-beta-0', 'POST', '/api/stream/kazumi/resolve', {
      body: { source: 'kazumi_1', episode: betaEpisodes[0] },
    });
  }

  // ===== API 规则：delimited 选集（POST 表单）=====
  const gammaEpisodes = await episodes('episodes-gamma', 'kazumi_2', m('/11'));
  if (gammaEpisodes[0]) {
    await exact('resolve-gamma-0', 'POST', '/api/stream/kazumi/resolve', {
      body: { source: 'kazumi_2', episode: gammaEpisodes[0] },
    });
  }

  // ===== 参数校验 =====
  await exact('resolve-missing-source', 'POST', '/api/stream/kazumi/resolve', {
    body: { episode: { id: 'x' } },
  });
  await exact('resolve-missing-episode', 'POST', '/api/stream/kazumi/resolve', {
    body: { source: 'kazumi_0' },
  });
  await exact('episodes-missing-identifier', 'GET', '/api/stream/kazumi/episodes?source=kazumi_0');
}

main()
  .catch((err) => {
    log.error = String((err && err.stack) || err);
  })
  .finally(() => {
    fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  });
