#!/usr/bin/env node
/**
 * 一起听（/api/music/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 上游是本地假 NCM 服务（mock-ncm.js），两侧都指过去，数据固定 → 全部 exact。
 * 覆盖：游客分支、Cookie 登录（两种输入格式）、凭证落库与退出、
 * 通用转发的 cookie 注入与 cookie/noCookie 剥离、扫码三接口不带 cookie、
 * 上游 3xx / 非 JSON、专辑匿名补齐、音质降级链（含试听、无版权、
 * 非白名单域名、老接口回退）、直链 302 与缓存、音质元数据与缓存、云盘上传。
 *
 * 用法：node http-music-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-music.json';

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

async function rawCall(method, path, { body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function call(method, path, { body, headers = {} } = {}) {
  const merged = { ...headers };
  if (token) merged.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    merged['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const resp = await rawCall(method, path, { body: payload, headers: merged });
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
}

async function step(name, method, path, options) {
  try {
    const { status, parsed } = await call(method, path, options);
    log.steps.push({ step: name, status, body: stable(parsed) });
  } catch (err) {
    log.steps.push({ step: name, error: String((err && err.message) || err) });
  }
}

/** 302 步骤只比状态码与 Location（Express 会往响应体里塞一段 HTML，Go 不会）。 */
async function redirectStep(name, path) {
  try {
    const merged = token ? { Authorization: `Bearer ${token}` } : {};
    const resp = await rawCall('GET', path, { headers: merged });
    await resp.text();
    log.steps.push({
      step: name,
      status: resp.status,
      location: resp.headers.get('location'),
      body: null,
    });
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

async function main() {
  // ===== 游客分支（无 token）=====
  await exact('anon-cookie', 'GET', '/api/music/ncm-cookie');
  await exact('anon-cookie-login', 'POST', '/api/music/ncm-cookie-login', {
    body: { cookie: 'MUSIC_U=x' },
  });
  await exact('anon-login-status', 'GET', '/api/music/login/status');

  await login('music-user', 'music-pass-1234');

  // ===== Cookie 登录 =====
  await exact('cookie-empty', 'POST', '/api/music/ncm-cookie-login', { body: { cookie: '   ' } });
  await exact('cookie-no-music-u', 'POST', '/api/music/ncm-cookie-login', {
    body: { cookie: 'NMTID=abc; __csrf=xyz' },
  });
  await exact('cookie-login-header', 'POST', '/api/music/ncm-cookie-login', {
    body: { cookie: 'MUSIC_U=manual-uuid; __csrf=manual-csrf' },
  });
  await exact('cookie-after-login', 'GET', '/api/music/ncm-cookie');
  // 登录状态会触发 /user/account + /vip/info 补全（vipType 0 → 黑胶 10）
  await exact('login-status-after', 'GET', '/api/music/login/status');

  // 第二种输入格式：Set-Cookie JSON 数组
  await exact('cookie-login-json', 'POST', '/api/music/ncm-cookie-login', {
    body: { cookie: '["MUSIC_U=json-uuid; Path=/; HttpOnly","__csrf=json-csrf"]' },
  });
  await exact('cookie-after-json', 'GET', '/api/music/ncm-cookie');

  // ===== 通用转发 =====
  // query / body 里的 cookie、noCookie 必须剥掉；服务端注入自己的 cookie
  // 挂载点本身（不带尾斜杠）也要转发到上游根
  await exact('fwd-root', 'GET', '/api/music/ncm');
  await exact('fwd-echo-get', 'GET', '/api/music/ncm/echo?cookie=evil&noCookie=1&x=2');
  await exact('fwd-echo-post', 'POST', '/api/music/ncm/echo', {
    body: { cookie: 'evil', noCookie: 1, a: 2 },
  });
  // 扫码三接口必须在无 cookie 的干净上下文调用
  await exact('fwd-qr-key', 'GET', '/api/music/ncm/login/qr/key');
  await exact('fwd-redirect', 'GET', '/api/music/ncm/redirect');
  await exact('fwd-not-json', 'GET', '/api/music/ncm/not-json');
  await exact('fwd-method', 'PUT', '/api/music/ncm/echo');
  // 转发响应带登录态 Set-Cookie 时要落库（值不变，但走一遍写链路）
  await exact('fwd-refresh-cookie', 'GET', '/api/music/ncm/nuser/account/get');
  await exact('cookie-after-refresh', 'GET', '/api/music/ncm-cookie');

  // ===== 专辑（登录态被截断 → 匿名补齐）=====
  await exact('album-bad', 'GET', '/api/music/album/full?id=abc');
  await exact('album-full', 'GET', '/api/music/album/full?id=5');

  // ===== 音频流 =====
  await exact('stream-bad-id', 'GET', '/api/music/stream?songId=abc');
  await exact('stream-vip', 'GET', '/api/music/stream?songId=3003');
  await exact('stream-no-copyright', 'GET', '/api/music/stream?songId=4004');
  await exact('stream-failed', 'GET', '/api/music/stream?songId=7007');
  await exact('stream-evil-host', 'GET', '/api/music/stream?songId=6006');
  // 直链模式：302 到 CDN（媒体元素直连，服务器不承担流量）
  await redirectStep('stream-direct', '/api/music/stream?songId=1001&level=exhigh&direct=1');
  await exact('stream-direct-cached', 'GET', '/api/music/stream?songId=1001&level=exhigh&direct=1');
  // 降级链：exhigh 空 → higher 有地址，实际解析档位为 higher
  await redirectStep('stream-direct-downgrade', '/api/music/stream?songId=2002&level=exhigh&direct=1');
  // v1 依赖残缺（404）→ 回退老接口 /song/url
  await redirectStep('stream-direct-legacy', '/api/music/stream?songId=5005&level=exhigh&direct=1');

  // ===== 音质元数据 =====
  await exact('quality-bad', 'GET', '/api/music/song-quality?songId=0');
  await exact('quality', 'GET', '/api/music/song-quality?songId=1001&level=exhigh');
  await exact('quality-cached', 'GET', '/api/music/song-quality?songId=1001&level=exhigh');
  await exact('quality-downgrade', 'GET', '/api/music/song-quality?songId=2002&level=exhigh');

  // ===== 云盘上传（multipart 原样透传）=====
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('fake-audio-bytes')], { type: 'audio/mpeg' }), 'a.mp3');
  await step('cloud-upload', 'POST', '/api/music/cloud/upload', { body: form });
  // 不是 multipart → 400（此处仍持有凭证）
  await exact('cloud-upload-bad', 'POST', '/api/music/cloud/upload', { body: { file: 1 } });

  // ===== 退出登录 =====
  await exact('logout', 'POST', '/api/music/logout');
  await exact('cookie-after-logout', 'GET', '/api/music/ncm-cookie');
  await exact('login-status-after-logout', 'GET', '/api/music/login/status');

  // ===== 退出后：无凭证的匿名链路 =====
  // ZViewer 仍登录着，但网易云凭证已删 → 匿名解析（不注入 cookie）。
  // 换一首没解析过的歌，避免撞上「同 userId 的凭证缓存」而变成缓存命中。
  await redirectStep('stream-anon-direct', '/api/music/stream?songId=2002&level=standard&direct=1');
  const noLoginForm = new FormData();
  noLoginForm.append('file', new Blob([Buffer.from('x')], { type: 'audio/mpeg' }), 'a.mp3');
  await step('cloud-upload-no-login', 'POST', '/api/music/cloud/upload', { body: noLoginForm });

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`steps: ${log.steps.length} → ${OUT}`);
}

main().catch((err) => {
  log.error = String((err && err.stack) || err);
  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.error(err);
  process.exit(1);
});
