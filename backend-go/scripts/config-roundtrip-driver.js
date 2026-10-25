#!/usr/bin/env node
/**
 * config/ 双向兼容驱动器（阶段 5 检查单第 3 项）。
 *
 * 同一套动作在两个后端上各跑一遍，靠快照对比证明「谁写的、另一边都读得到」：
 *
 *   1. 登录 admin（种子数据），快照 settings / server-files roots / 两个测试账号能否登录
 *   2. 写：PUT /api/admin/settings（带本次标记）→ 注册新账号 → POST 一个新根目录
 *   3. 再快照一次
 *
 * 标记值按 tag 区分（go: 41 / node: 52），所以「第二次运行的 before 快照」就等于
 * 「第一次运行的 after 快照」——不一致即说明持久层格式不兼容。
 *
 * 用法：node config-roundtrip-driver.js <baseUrl> <outFile> <tag:go|node> <adminUser> <adminPass> <mediaDir>
 */
'use strict';

const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/config-roundtrip.json';
const TAG = process.argv[4] || 'go';
const ADMIN_USER = process.argv[5] || 'cfg-admin';
const ADMIN_PASS = process.argv[6] || 'cfg-admin-pass';
const MEDIA_DIR = process.argv[7] || '/tmp';

const MARKERS = {
  go: { autoDeleteAfterHours: 41, roomDefaultMusicVolume: 41, dashDisabled: true },
  node: { autoDeleteAfterHours: 52, roomDefaultMusicVolume: 52, dashDisabled: false },
};
const MARK = MARKERS[TAG] || MARKERS.go;
const SETTINGS_FIELDS = [
  'autoDeleteInactiveRooms',
  'autoDeleteAfterHours',
  'roomDefaultMusicVolume',
  'registrationMode',
  'dashDisabled',
];

const log = { base: BASE, tag: TAG, before: null, writes: null, after: null };
let token = '';

async function call(method, path, body, auth = true) {
  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（例如 SPA 回退）*/
  }
  return { status: resp.status, json, text: text.slice(0, 400) };
}

async function login(username, password) {
  const resp = await call('POST', '/api/auth/login', { username, password }, false);
  if (resp.status === 200 && resp.json && resp.json.accessToken) {
    token = resp.json.accessToken;
  }
  return resp.status;
}

function pickSettings(json) {
  const src = (json && (json.settings || json)) || {};
  const out = {};
  for (const key of SETTINGS_FIELDS) out[key] = src[key];
  return out;
}

async function rootNames() {
  const resp = await call('GET', '/api/server-files/roots');
  const roots = (resp.json && resp.json.roots) || [];
  return { status: resp.status, names: roots.map((r) => r.name).sort() };
}

async function userNames() {
  const resp = await call('GET', '/api/admin/users');
  const users = (resp.json && resp.json.users) || [];
  return { status: resp.status, names: users.map((u) => u.username).sort() };
}

async function snapshot() {
  const settings = await call('GET', '/api/admin/settings');
  const users = await userNames();
  const logins = {
    'u-go': await login('u-go', 'pass-go'),
    'u-node': await login('u-node', 'pass-node'),
  };
  // login() 会覆盖 token，重新登录 admin 保证后续写操作有权限
  await login(ADMIN_USER, ADMIN_PASS);
  return {
    settings: pickSettings(settings.json),
    settingsStatus: settings.status,
    roots: await rootNames(),
    users,
    logins,
  };
}

async function main() {
  const adminStatus = await login(ADMIN_USER, ADMIN_PASS);
  if (adminStatus !== 200) {
    log.error = `admin 登录失败: ${adminStatus}`;
    fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
    process.exit(1);
  }

  log.before = await snapshot();

  const put = await call('PUT', '/api/admin/settings', {
    autoDeleteInactiveRooms: true,
    ...MARK,
    registrationMode: 'open',
  });
  const register = await call(
    'POST',
    '/api/auth/register',
    { username: `u-${TAG}`, password: `pass-${TAG}` },
    false,
  );
  const root = await call('POST', '/api/server-files/roots', {
    name: `root-${TAG}`,
    absPath: MEDIA_DIR,
  });
  log.writes = {
    settings: { status: put.status, body: put.json },
    register: { status: register.status, body: register.json },
    root: { status: root.status, body: root.json },
  };

  log.after = await snapshot();
  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(
    `[${TAG}] before=${JSON.stringify(log.before.settings)} after=${JSON.stringify(log.after.settings)}`,
  );
}

main().catch((err) => {
  log.error = String((err && err.stack) || err);
  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.error(log.error);
  process.exit(1);
});
