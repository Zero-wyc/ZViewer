#!/usr/bin/env node
/**
 * ani-subs（/api/stream/anisubs/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 上游是本地假站（mock-anisubs.js），数据固定 → 全部 exact 比较。
 * 抓站逻辑（CSS 选择器、JSONPath、正则规则、URL 补全、Referer 回落）
 * 正是最容易两侧走样的地方，所以每一条都走真实 HTTP 而不是纯函数对拍。
 *
 * 用法：node http-anisubs-driver.js <baseUrl> <outFile> <mockBaseUrl>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-anisubs.json';
// 假站地址：详情/剧集页的 URL 要随端口变化，由对拍脚本传进来。
const MOCK = process.argv[4] || '';
const m = (path) => MOCK + path;

const fs = require('node:fs');
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
  const timer = setTimeout(() => controller.abort(), 45000);
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

async function exact(name, method, path, options) {
  try {
    const { status, parsed } = await call(method, path, options);
    log.steps.push({ step: name, mode: 'exact', status, body: stable(parsed) });
  } catch (err) {
    log.steps.push({ step: name, mode: 'exact', error: String((err && err.message) || err) });
  }
}

const enc = encodeURIComponent;

async function login(username, password) {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`login ${username} failed: ${resp.status} ${JSON.stringify(body)}`);
  const value = body.accessToken || (body.data && body.data.accessToken);
  if (!value) throw new Error(`login ${username} 未拿到 accessToken: ${JSON.stringify(body)}`);
  return value;
}

async function main() {
  token = await login('anisubs-user', 'anisubs-pass-1234');

  // ===== 注册表 =====
  await exact('sources', 'GET', '/api/stream/anisubs/sources');

  // ===== 参数校验 =====
  await exact('search-no-source', 'GET', '/api/stream/anisubs/search?keyword=x');
  await exact('search-no-keyword', 'GET', '/api/stream/anisubs/search?source=ani_subs_web-selector_0');
  await exact('search-unknown-source', 'GET', '/api/stream/anisubs/search?source=nope&keyword=x');
  await exact('episodes-no-identifier', 'GET', '/api/stream/anisubs/episodes?source=ani_subs_web-selector_0');
  await exact('resolve-no-source', 'POST', '/api/stream/anisubs/resolve', { body: {} });
  await exact('resolve-no-episode', 'POST', '/api/stream/anisubs/resolve', {
    body: { source: 'ani_subs_web-selector_0' },
  });
  await exact('resolve-episode-primitive', 'POST', '/api/stream/anisubs/resolve', {
    body: { source: 'ani_subs_web-selector_0', episode: 5 },
  });

  // ===== web-selector 甲（a 格式 + 无线路）=====
  await exact('a-search', 'GET', `/api/stream/anisubs/search?source=ani_subs_web-selector_0&keyword=${enc('孤独 摇滚!')}`);
  await exact('a-search-empty', 'GET', `/api/stream/anisubs/search?source=ani_subs_web-selector_0&keyword=${enc('!!!')}`);
  await exact(
    'a-episodes',
    'GET',
    `/api/stream/anisubs/episodes?source=ani_subs_web-selector_0&identifier=${enc(m('/s/1'))}`,
  );
  await exact('a-resolve', 'POST', '/api/stream/anisubs/resolve', {
    body: {
      source: 'ani_subs_web-selector_0',
      episode: {
        id: '第 1 集-1',
        title: '第 1 集',
        episodeNumber: 1,
        playbackParams: { episodeUrl: m('/p/1') },
      },
    },
  });
  await exact('a-resolve-none', 'POST', '/api/stream/anisubs/resolve', {
    body: {
      source: 'ani_subs_web-selector_0',
      episode: { id: '第 2 集-2', title: '第 2 集', episodeNumber: 2, playbackParams: { episodeUrl: m('/p/2') } },
    },
  });
  await exact('a-resolve-no-url', 'POST', '/api/stream/anisubs/resolve', {
    body: { source: 'ani_subs_web-selector_0', episode: { id: 'x', title: 'y' } },
  });

  // ===== web-selector 乙（JSONPath + 线路分组）=====
  await exact('b-search', 'GET', `/api/stream/anisubs/search?source=ani_subs_web-selector_1&keyword=${enc('孤独 摇滚')}`);
  await exact('b-episodes', 'GET', `/api/stream/anisubs/episodes?source=ani_subs_web-selector_1&identifier=${enc(m('/s/2'))}`);

  // ===== RSS =====
  await exact('rss-search', 'GET', `/api/stream/anisubs/search?source=ani_subs_rss_2&keyword=${enc('孤独')}`);
  await exact(
    'rss-episodes',
    'GET',
    `/api/stream/anisubs/episodes?source=ani_subs_rss_2&identifier=${enc('https://example.com/ep/1')}`,
  );
  await exact('rss-resolve', 'POST', '/api/stream/anisubs/resolve', {
    body: {
      source: 'ani_subs_rss_2',
      episode: {
        id: 'https://example.com/ep/1',
        title: '孤独摇滚 第1话',
        episodeNumber: 1,
        playbackParams: { url: 'https://cdn.example.com/1.mp4' },
      },
    },
  });

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`${log.steps.length} steps → ${OUT}`);
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ error: String(err && err.stack) }, null, 2));
  console.error(err);
  process.exit(1);
});
