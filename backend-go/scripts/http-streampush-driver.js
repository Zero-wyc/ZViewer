#!/usr/bin/env node
/**
 * OBS 推流（/api/stream-push/obs-config/:roomId）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 覆盖范围：
 *   - 鉴权 401
 *   - 房间不存在 404 / 非投屏模式 400（两套文案）
 *   - 投屏房间正常下发配置：场景集合结构、推流地址、Content-Disposition
 *   - 缺推流码时生成并落库（第二次请求必须拿到同一个码）
 *   - 已有推流码时原样复用
 *
 * 推流码是随机的，无法逐字节比较：这里把两个位置的 key 归一化成 `<KEY>`，
 * 并额外记录两个布尔断言（两处一致 / 二次请求复用），两侧比较这些断言。
 *
 * /live 反代不在这里对拍：需要一条真实 RTMP 推流才有 FLV 字节可比，
 * 由 internal/api/streampush_test.go 用假 NMS 覆盖（MIGRATION 七之二有登记）。
 *
 * 用法：node http-streampush-driver.js <baseUrl> <outFile> <user> <pass> <roomMissing> <roomNoKey> <roomWithKey>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-streampush.json';
const USER = process.argv[4] || 'push-user';
const PASS = process.argv[5] || 'push-user-pass';
const ROOM_NO_KEY = process.argv[7] || 'PUSHPAR2';
const ROOM_WITH_KEY = process.argv[8] || 'PUSHPAR3';

const log = { base: BASE, steps: [] };
let token = '';

async function call(path, { withToken = true } = {}) {
  const headers = {};
  if (withToken && token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${BASE}${path}`, { headers });
  const text = await resp.text();
  return { status: resp.status, text, headers: resp.headers };
}

/** 把响应里的推流码归一化，并返回两处一致的断言。 */
function normalizeConfig(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { body: { __raw: text.slice(0, 300) }, twoPositionsSame: false };
  }
  const out = body.sources && body.sources[1] && body.sources[1].settings
    ? body.sources[1].settings.key
    : '';
  const svc = body.service && body.service.settings ? body.service.settings.key : '';
  const twoPositionsSame = !!out && out === svc;
  const masked = JSON.parse(JSON.stringify(body));
  if (masked.sources && masked.sources[1] && masked.sources[1].settings) {
    masked.sources[1].settings.key = '<KEY>';
  }
  if (masked.service && masked.service.settings) {
    masked.service.settings.key = '<KEY>';
  }
  return { body: masked, twoPositionsSame, rawKey: out };
}

async function configStep(name, roomId, extra = {}) {
  try {
    const { status, text, headers } = await call(`/api/stream-push/obs-config/${roomId}`);
    const step = {
      step: name,
      mode: 'exact',
      status,
      body: null,
      contentType: headers.get('content-type') || '',
      contentDisposition: headers.get('content-disposition') || '',
      ...extra,
    };
    if (status === 200) {
      const { body, twoPositionsSame, rawKey } = normalizeConfig(text);
      step.body = body;
      step.twoPositionsSame = twoPositionsSame;
      step.rawKey = rawKey;
      step.endsWithNewline = /\n$/.test(text);
    } else {
      step.body = JSON.parse(text);
    }
    log.steps.push(step);
  } catch (err) {
    log.steps.push({ step: name, mode: 'exact', error: String((err && err.message) || err) });
  }
}

async function login() {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`login ${USER} failed: ${resp.status} ${JSON.stringify(body)}`);
  }
  return body.accessToken || (body.tokens && body.tokens.accessToken) || '';
}

async function main() {
  // ---- 未登录 ----
  token = '';
  await configStep('anon obs-config', ROOM_NO_KEY);

  // ---- 登录后 ----
  token = await login();
  await configStep('missing room', 'NOSUCHRM');
  await configStep('wrong mode', 'PUSHPAR1');
  await configStep('no stream key (first)', ROOM_NO_KEY);
  await configStep('no stream key (second)', ROOM_NO_KEY);
  await configStep('existing stream key', ROOM_WITH_KEY);

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String((err && err.message) || err) }, null, 2));
  process.exit(1);
});
