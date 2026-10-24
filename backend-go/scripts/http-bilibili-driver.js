#!/usr/bin/env node
/**
 * B站 账号域 + 内容浏览域（/api/stream/bilibili/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 覆盖 22 个端点。与字幕/服务器文件对拍的区别在于：这些端点大多**真的会打
 * 上游 B站 接口**，返回值随线上数据变化，逐字段比对必然抖动。因此按端点性质
 * 分三档：
 *
 *   exact —— 参数校验/未绑定账号等确定性分支，比「状态码 + 完整响应体」；
 *   shape —— 需要上游数据的分支，只比「状态码 + 递归类型骨架（键集合与类型）」；
 *   status —— 上游结果极不稳定（合集 id 未必存在），只比状态码。
 *
 * 三档都只做一件事：把两侧的可确定性差异暴露出来。真实数据的正确性由
 * internal/bilibili 的单测（假上游）与手工冒烟负责。
 *
 * 用法：node http-bilibili-driver.js <baseUrl> <outFile>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-bilibili.json';

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

/**
 * 递归类型骨架：只保留键集合与值类型，数组只取首元素形状。
 *
 * 这样「有没有这个键」仍然会比（那是契约的一部分），但具体数值不会。
 */
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

async function call(method, path, { auth = true, body } = {}) {
  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
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

/** 判断响应里是否真的拿到了数据（用于识别上游「软风控返回空集」）。 */
const hasItems = (key) => (body) => Array.isArray(body && body[key]) && body[key].length > 0;

/**
 * 会真的打 B站 的步骤：数据为空时重试两次。
 *
 * B站 对匿名请求偶发「code 0 + 空列表」的软风控（不报错、就是没有数据），
 * 一旦两侧各撞一次就成了假差异。重试到有数据为止，仍为空才按原样记录。
 */
async function shapeStep(name, path, ensure) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, parsed } = await call('GET', path);
      last = { status, parsed };
      if (!ensure || ensure(parsed)) break;
    } catch (err) {
      last = { error: String((err && err.message) || err) };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (!last || last.error) {
    log.steps.push({ step: name, mode: 'shape', error: last ? last.error : 'no response' });
    return;
  }
  log.steps.push({ step: name, mode: 'shape', status: last.status, body: shape(last.parsed) });
}

const statusOnly = (name, path) => step(name, 'status', 'GET', path);

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

const BV = 'BV1GJ411x7h7'; // 稳定存在的公开视频（aid 80433022）
const enc = encodeURIComponent;

async function main() {
  token = await login('bili-user', 'bili-pass-1234');

  // ===== 账号域：未绑定 B站 的确定性分支 =====
  await exact('login-status', 'GET', '/api/stream/bilibili/login-status');
  await exact('cookie-get', 'GET', '/api/stream/bilibili/cookie');
  await exact('user-info', 'GET', '/api/stream/bilibili/user-info');
  await exact('cookie-login-empty', 'POST', '/api/stream/bilibili/cookie-login', { body: {} });
  await exact('cookie-login-no-sessdata', 'POST', '/api/stream/bilibili/cookie-login', {
    body: { cookie: 'foo=bar; baz=1' },
  });
  await exact('logout', 'POST', '/api/stream/bilibili/logout');

  // ===== 账号域：需要上游 =====
  await shapeStep('qr', '/api/stream/bilibili/qr');
  await shapeStep('qr-poll-bogus', '/api/stream/bilibili/qr/poll?qrcode_key=bogus-key-for-parity');

  // ===== 参数校验（exact）=====
  await exact('view-missing-bvid', 'GET', '/api/stream/bilibili/view');
  await exact('view-bad-bvid', 'GET', '/api/stream/bilibili/view?bvid=BVbad');
  await exact('related-bad-bvid', 'GET', '/api/stream/bilibili/related?bvid=notabv');
  await exact('search-missing-keyword', 'GET', '/api/stream/bilibili/search');
  await exact('comments-bad-bvid', 'GET', '/api/stream/bilibili/comments?bvid=bad');
  await exact('comment-replies-bad', 'GET', `/api/stream/bilibili/comment-replies?bvid=${BV}&rpid=0`);
  await exact('link-meta-missing', 'GET', '/api/stream/bilibili/link-meta');
  await exact('link-meta-invalid', 'GET', `/api/stream/bilibili/link-meta?url=${enc('not a url')}`);
  await exact(
    'link-meta-unsupported',
    'GET',
    `/api/stream/bilibili/link-meta?url=${enc('https://example.com/1/lists/2')}`,
  );
  await exact('collection-videos-bad', 'GET', '/api/stream/bilibili/collection-videos?mid=0&sid=0');
  await exact('fav-list-videos-bad', 'GET', '/api/stream/bilibili/fav-list-videos?fid=0');

  // ===== 未绑定 B站 的 401 分支（exact）=====
  await exact('fav-videos-unauth', 'GET', '/api/stream/bilibili/fav-videos');
  await exact('fav-folders-unauth', 'GET', '/api/stream/bilibili/fav-folders');
  await exact('fav-collect-bad-bvid', 'POST', '/api/stream/bilibili/fav/collect', {
    body: { bvid: 'bad' },
  });
  await exact('fav-collect-unauth', 'POST', '/api/stream/bilibili/fav/collect', {
    body: { bvid: BV },
  });
  await exact('fav-status-bad-bvid', 'GET', '/api/stream/bilibili/fav/status?bvid=bad');
  await exact('fav-status-unauth', 'GET', `/api/stream/bilibili/fav/status?bvid=${BV}`);
  await exact('following-bangumi-unauth', 'GET', '/api/stream/bilibili/following-bangumi');
  await exact('bangumi-episodes-missing', 'GET', '/api/stream/bilibili/bangumi-episodes');

  // ===== 需要上游数据（shape）=====
  await shapeStep('view', `/api/stream/bilibili/view?bvid=${BV}`);
  await shapeStep('region-new', '/api/stream/bilibili/region-new?rid=3&ps=2&pn=1', hasItems('items'));
  await shapeStep('related', `/api/stream/bilibili/related?bvid=${BV}`, hasItems('items'));
  await shapeStep(
    'search',
    `/api/stream/bilibili/search?keyword=${enc('音乐')}&pn=1&mode=search`,
    hasItems('items'),
  );
  await shapeStep(
    'comments',
    `/api/stream/bilibili/comments?bvid=${BV}&mode=2&next=0`,
    hasItems('replies'),
  );
  await shapeStep(
    'comment-replies',
    `/api/stream/bilibili/comment-replies?bvid=${BV}&rpid=1&pn=1&ps=10`,
    hasItems('replies'),
  );
  await shapeStep('bangumi-episodes', '/api/stream/bilibili/bangumi-episodes?seasonId=33378', hasItems('episodes'));

  // ===== 上游结果不稳定：只比状态码 =====
  await statusOnly(
    'link-meta-favlist',
    `/api/stream/bilibili/link-meta?url=${enc('https://space.bilibili.com/2/favlist?fid=2')}`,
  );
  await statusOnly(
    'collection-videos',
    '/api/stream/bilibili/collection-videos?mid=2&sid=1&kind=series&pn=1&ps=2',
  );

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`驱动器完成：${log.steps.length} 个步骤 → ${OUT}`);
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String(err) }, null, 2));
  console.error('驱动器异常:', err);
  process.exit(1);
});
