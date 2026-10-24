#!/usr/bin/env node
/**
 * 房间实时层对拍驱动器（阶段 8）。
 *
 * 做法：同一份脚本先后打到两个服务端（Node 真身 / Go 实现），把每一步
 * 「收到的事件 + ack 应答」规范化后写进 JSON，由 shell 侧逐步骤 diff。
 *
 * 规范化的三件事（不做的话每步都是差异）：
 *   1. socketId → 角色别名（OWNER / VIEWER / GUEST / ADMIN）
 *   2. roomId → ROOM（服务端随机生成，两侧必然不同）
 *   3. 去掉随时间变化的字段（playback.updatedAt / currentTime 等）
 *
 * 事件顺序不可比：两侧都是异步派发，同一批事件的到达顺序可能不同。
 * 因此每一步收集的是「该步结束后 150ms 内到达的全部事件」，按
 * (client, event, payload) 排序后再比较集合，不比较先后。
 *
 * 用法：node sio-rooms-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/sio-rooms.json';

const log = { base: BASE, steps: [] };

/** 每步收集的缓冲区 */
let buffer = [];
/** socketId → 别名 */
const aliases = new Map();
/** 服务端随机生成的 roomId → 占位符 */
const roomAliases = new Map();

function aliasOf(socketId) {
  if (!socketId) return null;
  return aliases.get(socketId) || socketId;
}

function roomAlias(roomId) {
  if (!roomId) return roomId;
  if (!roomAliases.has(roomId)) {
    roomAliases.set(roomId, `ROOM${roomAliases.size + 1}`);
  }
  return roomAliases.get(roomId);
}

/** 递归规范化：替换 id、抹掉时间相关字段 */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 时间列一律不比：两侧落库精度不同（TypeORM 秒级 / Go 毫秒级），
      // 值必然不同而格式都合法，留着只会掩盖真正的差异。
      if (k === 'updatedAt' || k === 'startedAt' || k === 'endedAt' || k === 'createdAt') continue;
      if (k === 'currentTime') continue;
      if (k === 'socketId' || k === 'viewerSocketId' || k === 'hostSocketId') {
        out[k] = typeof v === 'string' ? aliasOf(v) : v;
        continue;
      }
      if (k === 'roomId') {
        out[k] = typeof v === 'string' ? roomAlias(v) : v;
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    // 事件里可能内嵌 socketId（例如错误文案里带 id 的场景）
    if (aliases.has(value)) return aliases.get(value);
    if (roomAliases.has(value)) return roomAliases.get(value);
  }
  return value;
}

/** 键序无关的稳定序列化（对象键排序），用于比较与排序 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 建立客户端并录制它收到的所有事件 */
function connect(name, token) {
  const socket = io(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 8000,
  });
  socket.on('connect', () => {
    if (socket.id) aliases.set(socket.id, name);
  });
  // 房间相关事件全录；其余事件不关心（心跳等）
  const watched = [
    'room-closed', 'host-disconnected', 'sharer-ready', 'viewer-joined',
    'viewer-left', 'join-request', 'join-approved', 'movie-list',
    'current-movie', 'subtitle-update', 'moderators-changed', 'viewer-kicked',
    'room-name-updated',
  ];
  for (const ev of watched) {
    socket.on(ev, (payload) => {
      buffer.push({ client: name, event: ev, payload });
    });
  }
  socket.on('connect_error', (err) => {
    buffer.push({ client: name, event: 'connect_error', payload: { message: err.message } });
  });
  socket.on('disconnect', (reason) => {
    buffer.push({ client: name, event: 'disconnected', payload: { reason } });
  });
  return socket;
}

function emitAck(socket, event, payload, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
    const cb = (resp) => {
      clearTimeout(timer);
      resolve(resp);
    };
    if (payload === undefined) socket.emit(event, cb);
    else socket.emit(event, payload, cb);
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 结束一步：落盘规范化后的事件集合，并清空缓冲 */
async function step(name, payload, ackResponse) {
  // 事件派发是异步的，等一小段时间收齐
  await wait(180);
  const events = buffer
    .map((e) => {
      const payload = normalize(e.payload);
      return { client: e.client, event: e.event, payload, canon: `${e.client}|${e.event}|${stable(payload)}` };
    })
    // 事件派发是异步的，两侧到达顺序不可比；按稳定键排序后按集合比较。
    .sort((a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
  buffer = [];
  log.steps.push({ step: name, input: normalize(payload), ack: ackResponse === undefined ? null : normalize(ackResponse), events });
}

async function main() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  log.health = { status: health.status };

  // ---- 登录 ----
  const login = async (username, password) => {
    const resp = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await resp.json();
    if (!resp.ok) throw new Error(`login ${username} failed: ${resp.status} ${JSON.stringify(body)}`);
    return body.accessToken;
  };
  const guestResp = await fetch(`${BASE}/api/auth/guest`, { method: 'POST' });
  const guestBody = await guestResp.json();

  const ownerToken = await login('sio-owner', 'sio-pass-1234');
  const viewerToken = await login('sio-viewer', 'sio-pass-1234');
  const adminToken = await login('sio-admin', 'sio-pass-1234');

  const owner = connect('OWNER', ownerToken);
  const viewer = connect('VIEWER', viewerToken);
  const guest = connect('GUEST', guestBody.accessToken);
  const admin = connect('ADMIN', adminToken);
  await wait(600);

  // ---- 1. 权限与参数校验（不建房间） ----
  const guestCreate = await emitAck(guest, 'create-room', { name: '游客房间' });
  await step('guest-create-room', { name: '游客房间' }, guestCreate);

  const missing = await emitAck(viewer, 'request-join', { roomId: 'NOPE1234' });
  await step('join-missing-room', { roomId: 'NOPE1234' }, missing);

  const closeDenied = await emitAck(viewer, 'close-room');
  await step('viewer-close-room', null, closeDenied);

  const adminDenied = await emitAck(viewer, 'admin-close-room', { roomId: 'NOPE1234' });
  await step('viewer-admin-close', { roomId: 'NOPE1234' }, adminDenied);

  const badMax = await emitAck(owner, 'create-room', { name: 'x', maxViewers: 0 });
  await step('create-room-bad-max', { maxViewers: 0 }, badMax);

  const badMode = await emitAck(owner, 'create-room', { name: 'x', mode: 'nope' });
  await step('create-room-bad-mode', { mode: 'nope' }, badMode);

  // ---- 2. 创建房间 ----
  const created = await emitAck(owner, 'create-room', {
    name: '对拍房间',
    maxViewers: 2,
    mode: 'watch-together',
    requireApproval: false,
  });
  await step('create-room', { mode: 'watch-together' }, created);
  const roomId = created && created.data && created.data.roomId;
  if (!roomId) throw new Error(`create-room 未返回 roomId: ${JSON.stringify(created)}`);

  const registered = await emitAck(owner, 'register-host', { roomId });
  await step('register-host', { roomId }, registered);

  const hostOnOther = await emitAck(viewer, 'register-host', { roomId });
  await step('register-host-not-owner', { roomId }, hostOnOther);

  // ---- 3. 观众加入 ----
  const joined = await emitAck(viewer, 'request-join', { roomId });
  await step('viewer-join', { roomId }, joined);

  const joinedAgain = await emitAck(viewer, 'request-join', { roomId });
  await step('viewer-join-again', { roomId }, joinedAgain);

  const guest2 = connect('GUEST2', (await fetch(`${BASE}/api/auth/guest`, { method: 'POST' }).then((r) => r.json())).accessToken);
  await wait(400);
  // maxViewers=2 且已有 VIEWER + GUEST 两人：第三人必须被挡
  const full = await emitAck(guest2, 'request-join', { roomId });
  await step('guest-join-full-room', { roomId }, full);
  guest2.disconnect();
  await step('guest2-disconnect', null, null);

  // ---- 4. REST 改影片 → 广播 ----
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` };
  const createMovie = await fetch(`${BASE}/api/rooms/${roomId}/movies`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ url: 'https://example.com/a.mp4', title: '对拍影片' }),
  }).then((r) => r.json());
  await step('rest-create-movie', { title: '对拍影片' }, { success: createMovie.success });
  const movieId = createMovie.movie && createMovie.movie.id;

  if (movieId) {
    const updResp = await fetch(`${BASE}/api/rooms/${roomId}/movies/${movieId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ title: '对拍影片改名' }),
    }).then((r) => r.json());
    await step('rest-update-movie', { title: '对拍影片改名' }, { success: updResp.success });

    const delResp = await fetch(`${BASE}/api/rooms/${roomId}/movies/${movieId}`, {
      method: 'DELETE',
      headers: authHeaders,
    }).then((r) => r.json());
    await step('rest-delete-movie', { movieId }, { success: delResp.success });
  }

  // ---- 5. 观众离开 / 断线 ----
  const viewerLeave = await emitAck(viewer, 'host-leave');
  await step('viewer-host-leave', null, viewerLeave);

  viewer.disconnect();
  await step('viewer-disconnect', null, null);

  // ---- 6. 房主离开 → 重连恢复 ----
  const hostLeave = await emitAck(owner, 'host-leave');
  await step('host-leave', null, hostLeave);

  const reRegister = await emitAck(owner, 'register-host', { roomId });
  await step('host-reregister', { roomId }, reRegister);

  // 观众重新进来，验证 host-leave 后仍可加入（5 分钟宽限）
  const viewer2 = connect('VIEWER', viewerToken);
  await wait(400);
  aliases.set(viewer2.id || '', 'VIEWER');
  const rejoin = await emitAck(viewer2, 'request-join', { roomId });
  await step('viewer-rejoin', { roomId }, rejoin);

  // ---- 7. 关闭房间 ----
  const closed = await emitAck(owner, 'close-room');
  await step('close-room', null, closed);
  await wait(300);

  const reopen = await emitAck(viewer2, 'request-join', { roomId });
  await step('join-closed-room', { roomId }, reopen);

  // ---- 8. 密码房 + 管理员强制关闭 ----
  const pwRoom = await emitAck(owner, 'create-room', { name: '密码房', password: 'pw-123456' });
  await step('create-room-with-password', {}, pwRoom);
  const pwRoomId = pwRoom && pwRoom.data && pwRoom.data.roomId;

  if (pwRoomId) {
    const wrongPw = await emitAck(guest, 'request-join', { roomId: pwRoomId, password: 'bad' });
    await step('join-wrong-password', { roomId: pwRoomId }, wrongPw);

    const rightPw = await emitAck(guest, 'request-join', { roomId: pwRoomId, password: 'pw-123456' });
    await step('join-right-password', { roomId: pwRoomId }, rightPw);

    const adminClose = await emitAck(admin, 'admin-close-room', { roomId: pwRoomId });
    await step('admin-close-room', { roomId: pwRoomId }, adminClose);
    await wait(300);
  }

  const adminCloseMissing = await emitAck(admin, 'admin-close-room', { roomId: 'NOPE1234' });
  await step('admin-close-missing', { roomId: 'NOPE1234' }, adminCloseMissing);

  // ---- 收尾 ----
  for (const s of [owner, viewer2, guest, admin]) {
    try { s.disconnect(); } catch { /* ignore */ }
  }
  await wait(400);

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`steps=${log.steps.length} out=${OUT}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('driver failed:', err);
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String(err && err.stack || err) }, null, 2));
  process.exit(1);
});
