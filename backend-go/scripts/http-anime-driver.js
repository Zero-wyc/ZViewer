#!/usr/bin/env node
/**
 * 动漫源（/api/stream/anime/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 大部分步骤打的是本地假上游（mock-anime.js），数据固定 → exact 比较；
 * 唯一真的打 B站 的步骤（bilibili_bangumi 直连 seasonId）用 shape 比较，
 * 因为线上封面/标题随时可能微调。
 *
 * 用法：node http-anime-driver.js <baseUrl> <outFile>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-anime.json';

const fs = require('node:fs');
const log = { base: BASE, steps: [] };
let token = '';

/** 递归按键名排序，消除键序造成的假差异。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

/** 递归类型骨架：只保留键集合与值类型，数组只取首元素形状。 */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length > 0 ? ['array', shape(value[0])] : ['array'];
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = shape(value[key]);
    return out;
  }
  return typeof value;
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

async function step(name, mode, method, path, options) {
  try {
    const { status, parsed } = await call(method, path, options);
    let body;
    if (mode === 'exact') body = stable(parsed);
    else if (mode === 'shape') body = shape(parsed);
    else body = null;
    log.steps.push({ step: name, mode, status, body });
  } catch (err) {
    log.steps.push({ step: name, mode, error: String((err && err.message) || err) });
  }
}

const exact = (name, method, path, options) => step(name, 'exact', method, path, options);
const shapeOf = (name, path) => step(name, 'shape', 'GET', path);
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
  token = await login('anime-user', 'anime-pass-1234');

  // ===== 注册表 =====
  await exact('sources', 'GET', '/api/stream/anime/sources');

  // ===== 参数校验 =====
  await exact('search-no-source', 'GET', '/api/stream/anime/search?keyword=x');
  await exact('search-blank-source', 'GET', '/api/stream/anime/search?source=%20%20&keyword=x');
  await exact('search-unknown-source', 'GET', '/api/stream/anime/search?source=nope&keyword=x');
  await exact('search-no-keyword', 'GET', '/api/stream/anime/search?source=bilibili_bangumi');
  await exact('episodes-no-source', 'GET', '/api/stream/anime/episodes?identifier=1');
  await exact('episodes-no-identifier', 'GET', '/api/stream/anime/episodes?source=bilibili_bangumi');
  await exact('resolve-no-source', 'POST', '/api/stream/anime/resolve', { body: {} });
  await exact('resolve-no-episode', 'POST', '/api/stream/anime/resolve', {
    body: { source: 'bilibili_bangumi' },
  });
  await exact('resolve-episode-string', 'POST', '/api/stream/anime/resolve', {
    body: { source: 'bilibili_bangumi', episode: 'x' },
  });

  // ===== RSS 源 =====
  await exact('rss-search', 'GET', `/api/stream/anime/search?source=rss_demo&keyword=${enc('孤独')}`);
  await exact('rss-search-miss', 'GET', `/api/stream/anime/search?source=rss_demo&keyword=${enc('不存在的番')}`);
  await exact('atom-search', 'GET', `/api/stream/anime/search?source=rss_atom&keyword=${enc('孤独')}`);
  await exact(
    'rss-episodes',
    'GET',
    `/api/stream/anime/episodes?source=rss_demo&identifier=${enc('https://example.com/ep/1')}`,
  );
  await exact(
    'rss-episodes-missing',
    'GET',
    `/api/stream/anime/episodes?source=rss_demo&identifier=${enc('https://example.com/none')}`,
  );
  await exact('rss-resolve', 'POST', '/api/stream/anime/resolve', {
    body: {
      source: 'rss_demo',
      episode: {
        id: 'https://example.com/ep/1',
        title: '孤独摇滚 第1话',
        episodeNumber: 1,
        playbackParams: { url: 'https://cdn.example.com/1.mp4', title: '孤独摇滚 第1话' },
      },
    },
  });
  await exact('rss-resolve-no-url', 'POST', '/api/stream/anime/resolve', {
    body: { source: 'rss_demo', episode: { id: 'x', title: 'y' } },
  });

  // ===== 第三方源 =====
  await exact('tp-search', 'GET', `/api/stream/anime/search?source=third_party_tp&keyword=${enc('孤独 摇滚')}`);
  await exact('tp-episodes', 'GET', '/api/stream/anime/episodes?source=third_party_tp&identifier=7');
  await exact('tp-resolve', 'POST', '/api/stream/anime/resolve', {
    body: { source: 'third_party_tp', episode: { id: 'e1', title: '第一话', episodeNumber: 1 } },
  });
  await exact('tp-resolve-empty-url', 'POST', '/api/stream/anime/resolve', {
    body: { source: 'third_party_tp', episode: { id: 'bad' } },
  });
  await exact('tp-resolve-upstream-502', 'POST', '/api/stream/anime/resolve', {
    body: { source: 'third_party_tp', episode: { id: 'boom' } },
  });

  // ===== B站番剧源（打真实上游，只比形状）=====
  await shapeOf('bilibili-search-direct', `/api/stream/anime/search?source=bilibili_bangumi&keyword=ss33378`);

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`${log.steps.length} steps → ${OUT}`);
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ error: String(err && err.stack) }, null, 2));
  console.error(err);
  process.exit(1);
});
