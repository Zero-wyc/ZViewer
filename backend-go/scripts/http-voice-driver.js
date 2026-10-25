#!/usr/bin/env node
/**
 * 语音（/api/voice/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 媒体面在 LiveKit，本驱动器只打 ZViewer 的三个端点，并把 Twirp 调用指向
 * mock-livekit.js（固定参与者 + 调用记录），因此可以逐步骤比较：
 *   - 401 / 400 / 403 / 404 的判定顺序与文案
 *   - 签出的 AccessToken payload（忽略 iat/exp/nbf，只比 iss/sub/name/video）
 *   - 禁言/解禁/踢人时打到 LiveKit 的调用序列（漏轨、漏 metadata 都会露出来）
 *
 * 503（LIVEKIT_API_KEY/SECRET 缺失）不在对拍里：两侧都要配好密钥才能跑
 * 后面的步骤，另起一对不配密钥的进程不划算——由 internal/api/voice_test.go 覆盖。
 *
 * 用法：
 *   node http-voice-driver.js <baseUrl> <outFile> <owner> <ownerPass> \
 *     <viewer> <viewerPass> <outsider> <outsiderPass> <mockLivekitUrl> <roomId> <closedRoomId>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2];
const OUT = process.argv[3];
const OWNER = process.argv[4];
const OWNER_PASS = process.argv[5];
const VIEWER = process.argv[6];
const VIEWER_PASS = process.argv[7];
const OUTSIDER = process.argv[8];
const OUTSIDER_PASS = process.argv[9];
const MOCK = process.argv[10];
const ROOM = process.argv[11] || 'VOICEPAR1';
const CLOSED_ROOM = process.argv[12] || 'VOICECLOSED';

const log = { base: BASE, steps: [] };
let token = '';

async function call(method, path, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { __raw: text.slice(0, 300) };
  }
  return { status: resp.status, body: parsed };
}

/** 取 mock 本轮收到的 Twirp 调用（取完即清空）。 */
async function drainCalls() {
  const resp = await fetch(`${MOCK}/__calls`);
  const body = await resp.json();
  return body.calls || [];
}

function jwtPayload(rawToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(rawToken).split('.')[1], 'base64url').toString('utf8'),
    );
    const picked = {};
    for (const key of ['iss', 'sub', 'name', 'video']) {
      if (key in payload) picked[key] = payload[key];
    }
    const ttlHours =
      typeof payload.exp === 'number' && typeof payload.nbf === 'number'
        ? Math.round((payload.exp - payload.nbf) / 3600)
        : null;
    return { payload: picked, ttlHours };
  } catch {
    return { payload: { __invalid: true }, ttlHours: null };
  }
}

async function step(name, method, path, body, extra = {}) {
  try {
    const resp = await call(method, path, body);
    log.steps.push({ step: name, status: resp.status, body: resp.body, ...extra });
  } catch (err) {
    log.steps.push({ step: name, error: String((err && err.message) || err) });
  }
}

/** 语音管理操作：发请求 + 拉取本次触发的 Twirp 调用序列。 */
async function controlStep(name, path, body) {
  await fetch(`${MOCK}/__reset`, { method: 'POST' }).catch(() => {});
  await step(name, 'POST', path, body);
  try {
    log.steps[log.steps.length - 1].calls = await drainCalls();
  } catch (err) {
    log.steps[log.steps.length - 1].callsError = String((err && err.message) || err);
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
  await fetch(`${MOCK}/__reset`, { method: 'POST' }).catch(() => {});

  const ownerToken = await login(OWNER, OWNER_PASS);
  const viewerToken = await login(VIEWER, VIEWER_PASS);
  const outsiderToken = await login(OUTSIDER, OUTSIDER_PASS);

  // ---- 未登录 ----
  token = '';
  await step('anon token', 'POST', '/api/voice/token', { roomId: ROOM });

  // ---- 房主：入参/房间校验 ----
  token = ownerToken;
  await step('token no roomId', 'POST', '/api/voice/token', {});
  await step('token missing room', 'POST', '/api/voice/token', { roomId: 'NOSUCHRM' });
  await step('token closed room', 'POST', '/api/voice/token', { roomId: CLOSED_ROOM });

  // ---- 无会话的用户：403 ----
  token = outsiderToken;
  await step('token not admitted', 'POST', '/api/voice/token', { roomId: ROOM });

  // ---- 已准入观众：200 + token payload ----
  token = viewerToken;
  try {
    const resp = await call('POST', '/api/voice/token', { roomId: ROOM, username: '观众甲' });
    const jwt = resp.body && resp.body.token ? jwtPayload(resp.body.token) : null;
    log.steps.push({
      step: 'token ok viewer',
      status: resp.status,
      // url 来自 LIVEKIT_URL（两侧同值），token 只比 payload
      body: resp.body ? { success: resp.body.success, url: resp.body.url } : resp.body,
      hasToken: !!(resp.body && resp.body.token),
      tokenPayload: jwt ? jwt.payload : null,
      tokenTTLHours: jwt ? jwt.ttlHours : null,
      tokenSegments: resp.body && resp.body.token ? String(resp.body.token).split('.').length : 0,
    });
  } catch (err) {
    log.steps.push({ step: 'token ok viewer', error: String((err && err.message) || err) });
  }

  // ---- 禁言 / 解禁 ----
  token = viewerToken;
  await step('mute missing params', 'POST', '/api/voice/mute', { roomId: ROOM });
  await step('mute forbidden', 'POST', '/api/voice/mute', {
    roomId: ROOM,
    identity: 'user:1',
    muted: true,
  });

  token = ownerToken;
  await step('mute target absent', 'POST', '/api/voice/mute', {
    roomId: ROOM,
    identity: 'user:3',
    muted: true,
  });
  await controlStep('mute ok', '/api/voice/mute', {
    roomId: ROOM,
    identity: 'user:1',
    muted: true,
  });
  await controlStep('unmute ok', '/api/voice/mute', {
    roomId: ROOM,
    identity: 'user:1',
    muted: false,
  });

  // ---- 踢人 ----
  token = viewerToken;
  await step('kick missing params', 'POST', '/api/voice/kick', { roomId: ROOM });
  await step('kick forbidden', 'POST', '/api/voice/kick', {
    roomId: ROOM,
    identity: 'user:1',
  });

  token = ownerToken;
  await controlStep('kick ok', '/api/voice/kick', { roomId: ROOM, identity: 'user:1' });

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String((err && err.message) || err) }, null, 2));
  process.exit(1);
});
