#!/usr/bin/env node
/**
 * 管理端（/api/admin）—— HTTP 端点对拍驱动器。
 *
 * 覆盖 routes/admin.ts 的 12 个端点：
 *   用户：GET /users、PATCH /users/:id/role、POST /users/:id/approve、DELETE /users/:id
 *   房间：GET /rooms、DELETE /rooms/:roomId、POST /rooms/:roomId/reopen、
 *         POST /rooms/batch-delete、POST /rooms/delete-all、POST /rooms/cleanup-unused
 *   设置：GET /settings、PUT /settings
 *
 * 与 sio-* 驱动器的区别：比的是「HTTP 状态码 + 响应体」，所以规范化只做两件事：
 *   1. ISO 时间戳换成 <TIME>（两侧建行时刻必然不同，但**键存在**是语义，替换不删键）；
 *   2. JSON 键排序（stable），避免键顺序造成假差异。
 *
 * 步骤顺序是**有状态**的：删掉的房间后续查不到，改过的设置后续读到新值。
 * 两侧跑同一份脚本、同一份种子数据，所以序列必须一模一样——不要单独调换某一步。
 *
 * 用法：node http-admin-driver.js <baseUrl> <outFile>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-admin.json';

const log = { base: BASE, steps: [] };

let rootToken = '';
let adminToken = '';
let userToken = '';

/** 时间戳规范化：保留键，只换值。 */
function normalize(value) {
  if (typeof value === 'string') {
    return value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TIME>');
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

/** 排序后序列化，避免键顺序造成的假差异。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

async function request(method, path, { token = rootToken, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(`${BASE}${path}`, init);
  const text = await resp.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { __raw: text.slice(0, 200) };
    }
  }
  return { status: resp.status, body: parsed };
}

async function step(name, method, path, options) {
  let result;
  try {
    result = await request(method, path, options);
  } catch (err) {
    result = { error: String(err && err.message) };
  }
  log.steps.push({ step: name, ...stable(normalize(result)) });
  return result;
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
  if (!token) throw new Error(`login ${username} 未拿到 accessToken: ${JSON.stringify(body)}`);
  return token;
}

/** 通过管理端用户列表取 id：不写死主键，种子顺序变了也不会错。 */
async function userIds(token) {
  const resp = await fetch(`${BASE}/api/admin/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json().catch(() => ({}));
  const map = {};
  for (const u of body.users || []) map[u.username] = u.id;
  return map;
}

async function main() {
  rootToken = await login('sio-owner', 'sio-pass-1234');
  adminToken = await login('sio-admin', 'sio-pass-1234');
  userToken = await login('sio-viewer', 'sio-pass-1234');

  const ids = await userIds(rootToken);
  const viewerId = ids['sio-viewer'];
  const guestId = ids['sio-guest'];
  const doomedId = ids['sio-doomed'];
  const rootId = ids['sio-owner'];

  // ===== 1. 鉴权分档（三套 403 文案必须各自对上）=====
  await step('auth-anonymous', 'GET', '/api/admin/users', { token: '' });
  await step('auth-as-user', 'GET', '/api/admin/users', { token: userToken });
  await step('auth-as-admin', 'GET', '/api/admin/users', { token: adminToken });
  await step('auth-root-endpoint-as-admin', 'POST', '/api/admin/rooms/delete-all', { token: adminToken });

  // ===== 2. 用户管理 =====
  await step('users-list', 'GET', '/api/admin/users');
  await step('user-role-invalid', 'PATCH', `/api/admin/users/${viewerId}/role`, {
    body: { role: 'root' },
  });
  await step('user-role-missing', 'PATCH', '/api/admin/users/999999/role', { body: { role: 'admin' } });
  await step('user-role-nan', 'PATCH', '/api/admin/users/abc/role', { body: { role: 'admin' } });
  await step('user-role-fraction', 'PATCH', '/api/admin/users/1.5/role', { body: { role: 'admin' } });
  await step('user-role-root', 'PATCH', `/api/admin/users/${rootId}/role`, { body: { role: 'admin' } });
  await step('user-role-ok', 'PATCH', `/api/admin/users/${viewerId}/role`, { body: { role: 'user' } });

  await step('user-approve-guest', 'POST', `/api/admin/users/${guestId}/approve`);
  await step('user-approve-again', 'POST', `/api/admin/users/${guestId}/approve`);
  await step('user-approve-root', 'POST', `/api/admin/users/${rootId}/approve`);
  await step('user-approve-missing', 'POST', '/api/admin/users/999999/approve');

  await step('user-delete-root', 'DELETE', `/api/admin/users/${rootId}`);
  await step('user-delete-missing', 'DELETE', '/api/admin/users/999999');
  await step('user-delete-nan', 'DELETE', '/api/admin/users/abc');
  await step('user-delete-ok', 'DELETE', `/api/admin/users/${doomedId}`);
  await step('user-delete-again', 'DELETE', `/api/admin/users/${doomedId}`);
  await step('users-list-after', 'GET', '/api/admin/users');

  // ===== 3. 房间管理 =====
  await step('rooms-list', 'GET', '/api/admin/rooms');
  await step('room-delete-missing', 'DELETE', '/api/admin/rooms/NOSUCHRM');
  await step('room-delete-forbidden-admin', 'DELETE', '/api/admin/rooms/ADMROOM02', { token: adminToken });
  await step('room-delete-ok-root', 'DELETE', '/api/admin/rooms/ADMROOM02');
  await step('room-delete-again', 'DELETE', '/api/admin/rooms/ADMROOM02');

  await step('room-reopen-not-closed', 'POST', '/api/admin/rooms/ADMROOM01/reopen');
  await step('room-reopen-forbidden', 'POST', '/api/admin/rooms/ADMROOM03/reopen', { token: adminToken });
  await step('room-reopen-missing', 'POST', '/api/admin/rooms/NOSUCHRM/reopen');
  await step('room-reopen-ok', 'POST', '/api/admin/rooms/ADMROOM03/reopen');
  await step('room-reopen-again', 'POST', '/api/admin/rooms/ADMROOM03/reopen');

  await step('rooms-batch-empty', 'POST', '/api/admin/rooms/batch-delete', { body: { roomIds: [] } });
  await step('rooms-batch-not-array', 'POST', '/api/admin/rooms/batch-delete', { body: { roomIds: 'x' } });
  await step('rooms-batch-missing-key', 'POST', '/api/admin/rooms/batch-delete', { body: {} });
  // 不存在的房间号也计入 count：Node 的 deleteRoomAndRelations 不校验存在性。
  await step('rooms-batch-ok', 'POST', '/api/admin/rooms/batch-delete', {
    body: { roomIds: ['ADMROOM02', 'NOSUCHRM'] },
  });

  // 清理无人房间：ADMROOM03 已重开但无会话、ADMROOM04 无会话 → 清；
  // ADMROOM01（有会话）与 ADMROOM05（有观众）必须保留。
  await step('rooms-cleanup-unused', 'POST', '/api/admin/rooms/cleanup-unused');
  await step('rooms-list-after-cleanup', 'GET', '/api/admin/rooms');

  await step('room-delete-ok', 'DELETE', '/api/admin/rooms/ADMROOM01');
  await step('rooms-delete-all-as-admin', 'POST', '/api/admin/rooms/delete-all', { token: adminToken });
  await step('rooms-delete-all', 'POST', '/api/admin/rooms/delete-all');
  await step('rooms-list-empty', 'GET', '/api/admin/rooms');
  await step('rooms-cleanup-empty', 'POST', '/api/admin/rooms/cleanup-unused');

  // ===== 4. 系统设置 =====
  await step('settings-get', 'GET', '/api/admin/settings');
  await step('settings-put-empty', 'PUT', '/api/admin/settings', { body: {} });
  await step('settings-put-volume-float', 'PUT', '/api/admin/settings', {
    body: { roomDefaultMusicVolume: 50.5 },
  });
  await step('settings-put-volume-string', 'PUT', '/api/admin/settings', {
    body: { roomDefaultMusicVolume: '50' },
  });
  await step('settings-put-volume-range', 'PUT', '/api/admin/settings', {
    body: { roomDefaultMusicVolume: 101 },
  });
  await step('settings-put-hours-zero', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 0 },
  });
  await step('settings-put-enum', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 12, registrationMode: 'nope' },
  });
  await step('settings-put-matrix-bad-action', 'PUT', '/api/admin/settings', {
    body: {
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 12,
      roomPermissionMatrix: { unknownAction: { user: true } },
    },
  });
  await step('settings-put-matrix-bad-field', 'PUT', '/api/admin/settings', {
    body: {
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 12,
      roomPermissionMatrix: { kickViewer: { stranger: true } },
    },
  });
  await step('settings-put-matrix-bad-type', 'PUT', '/api/admin/settings', {
    body: {
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 12,
      roomPermissionMatrix: { kickViewer: { user: 'yes' } },
    },
  });
  await step('settings-put-matrix-array', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 12, roomPermissionMatrix: [] },
  });
  await step('settings-put-datasource-array', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 12, dataSourceConfig: [] },
  });
  await step('settings-put-livekit-bad', 'PUT', '/api/admin/settings', {
    body: {
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 12,
      livekitExternalUrl: 'https://livekit.example.com',
    },
  });
  await step('settings-put-multiinstance-bad', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 12, roomMultiInstanceLogin: 'yes' },
  });
  await step('settings-put-announce-bad', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 12, announceAutoPopupOnUpdate: 1 },
  });

  await step('settings-put-ok', 'PUT', '/api/admin/settings', {
    body: {
      autoDeleteInactiveRooms: false,
      autoDeleteAfterHours: 6,
      roomDefaultMusicVolume: 80,
      registrationMode: 'open',
      roomCreationMode: 'all-users',
      betaFeaturesEnabled: true,
      dashDisabled: true,
      bilibiliDefaultParseMode: 'dash',
      bilibiliPgcDefaultMode: 'cliOnly',
      cdnAccelerate: true,
      cdnProxyUrl: '  https://gh-proxy.example.com  ',
      playsvideoEnabled: false,
      roomMultiInstanceLogin: true,
      livekitExternalUrl: '  wss://livekit.example.com  ',
      announceAutoPopupOnUpdate: false,
      dataSourceConfig: { anime: true, nested: { k: [1, 2] } },
      roomPermissionMatrix: { kickViewer: { user: false }, addMovie: { moderator: true } },
    },
  });
  await step('settings-get-after', 'GET', '/api/admin/settings');
  // 只提交必填两项：其余字段必须保持上一次的值（Node 的 `!== undefined` 语义）。
  await step('settings-put-partial', 'PUT', '/api/admin/settings', {
    body: { autoDeleteInactiveRooms: true, autoDeleteAfterHours: 24 },
  });
  await step('settings-get-after-partial', 'GET', '/api/admin/settings');
  // 显式 null 清空矩阵与数据源配置。
  await step('settings-put-null', 'PUT', '/api/admin/settings', {
    body: {
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 24,
      roomPermissionMatrix: null,
      dataSourceConfig: null,
    },
  });
  await step('settings-get-after-null', 'GET', '/api/admin/settings');

  require('fs').writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`已记录 ${log.steps.length} 个步骤 → ${OUT}`);
}

main().catch((err) => {
  require('fs').writeFileSync(OUT, JSON.stringify({ error: String(err && err.stack || err) }, null, 2));
  console.error(err);
  process.exit(1);
});
