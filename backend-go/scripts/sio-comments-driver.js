#!/usr/bin/env node
/**
 * 评论 / 弹幕 / 批注对拍驱动器（阶段 12）。
 *
 * 覆盖 6 个事件：
 *   send-comment / comment-history / join-room-panel
 *   send-danmaku / annotation-stroke / clear-annotations
 *
 * 与其它驱动器的区别：
 * - 记录 **argc**（事件携带的参数个数）：`clear-annotations` 是零参数事件，
 *   Node 发 `emit('clear-annotations')`，Go 侧若传 nil 会变成 `[null]`——
 *   只比 payload 的话两边都是 undefined/null，这个差异看不出来。
 * - `createdAt` 替换成 `<TS>` 而不是删键：评论的时间值两侧必然不同，
 *   但「有没有这个键」是语义，必须比。
 * - 评论自增 id 映射成 `COMMENT1/2/3`；实时弹幕 id 形如
 *   `<13 位毫秒>-<6 位 base36>`，替换成 `<DM_ID>`（含随机后缀）。
 *
 * 用法：node sio-comments-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/sio-comments.json';

const log = { base: BASE, steps: [] };

let buffer = [];
const aliases = new Map();
const roomAliases = new Map();
const commentAliases = new Map();

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

function commentAlias(id) {
  if (!commentAliases.has(id)) {
    commentAliases.set(id, `COMMENT${commentAliases.size + 1}`);
  }
  return commentAliases.get(id);
}

const DM_ID_PATTERN = /^\d{13}-[0-9a-z]{6}$/;

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 时间列：值两侧必然不同，但键的存在性是语义（comment dto 一定有 createdAt）
      if (k === 'createdAt' || k === 'updatedAt' || k === 'startedAt' || k === 'endedAt') {
        out[k] = '<TS>';
        continue;
      }
      // 评论自增 id 两侧起点不同；弹幕 id 带随机后缀
      if (k === 'id') {
        if (typeof v === 'number') {
          out[k] = commentAlias(v);
          continue;
        }
        if (typeof v === 'string' && DM_ID_PATTERN.test(v)) {
          out[k] = '<DM_ID>';
          continue;
        }
      }
      if (k === 'socketId' || k === 'senderId' || k === 'viewerSocketId' || k === 'hostSocketId') {
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
    if (DM_ID_PATTERN.test(value)) return '<DM_ID>';
    if (aliases.has(value)) return aliases.get(value);
    if (roomAliases.has(value)) return roomAliases.get(value);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const WATCHED = [
  'new-comment', 'danmaku', 'danmaku-meta-updated',
  'annotation-stroke', 'clear-annotations',
  'viewer-joined', 'viewer-left', 'room-closed', 'room-name-updated',
  'room-mode-changed', 'room-settings-updated', 'moderators-changed',
  'viewer-muted', 'viewer-kicked',
];

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
  for (const ev of WATCHED) {
    socket.on(ev, (...args) => {
      buffer.push({ client: name, event: ev, payload: args[0], argc: args.length });
    });
  }
  socket.on('connect_error', (err) => {
    buffer.push({ client: name, event: 'connect_error', payload: { message: err.message }, argc: 1 });
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

async function step(name, payload, ackResponse) {
  await wait(200);
  const events = buffer
    .map((e) => {
      const normalized = normalize(e.payload);
      return {
        client: e.client,
        event: e.event,
        argc: e.argc,
        payload: normalized,
        canon: `${e.client}|${e.event}|${e.argc}|${stable(normalized)}`,
      };
    })
    .sort((a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
  buffer = [];
  log.steps.push({
    step: name,
    input: normalize(payload),
    ack: ackResponse === undefined ? null : normalize(ackResponse),
    events,
  });
}

async function main() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  log.health = { status: health.status };

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
  const guestToken = async () => {
    const resp = await fetch(`${BASE}/api/auth/guest`, { method: 'POST' });
    return (await resp.json()).accessToken;
  };

  const ownerToken = await login('sio-owner', 'sio-pass-1234');
  const viewerToken = await login('sio-viewer', 'sio-pass-1234');
  const adminToken = await login('sio-admin', 'sio-pass-1234');

  const owner = connect('OWNER', ownerToken);
  const viewer = connect('VIEWER', viewerToken);
  const admin = connect('ADMIN', adminToken); // 不进房，用来覆盖「不在该房间中」
  const guest = connect('GUEST', await guestToken());
  await wait(600);

  // ---- 建房间并拉两个人进来 ----
  const created = await emitAck(owner, 'create-room', {
    name: '评论房',
    maxViewers: 5,
    mode: 'watch-together',
    requireApproval: false,
  });
  await step('setup-create-room', { name: '评论房' }, created);
  const roomId = created && created.data && created.data.roomId;
  if (!roomId) throw new Error(`create-room 未返回 roomId: ${JSON.stringify(created)}`);

  await step('setup-register-host', { roomId }, await emitAck(owner, 'register-host', { roomId }));
  await step('setup-viewer-join', { roomId }, await emitAck(viewer, 'request-join', { roomId }));
  await step('setup-guest-join', { roomId }, await emitAck(guest, 'request-join', { roomId }));

  // ==================== send-comment ====================
  await step('comment-outsider', { roomId, content: '外面的人' },
    await emitAck(admin, 'send-comment', { roomId, content: '外面的人' }));

  await step('comment-empty', { roomId, content: '   ' },
    await emitAck(viewer, 'send-comment', { roomId, content: '   ' }));

  // 前后空白要 trim：广播出去的 content 与 ack 都要是修剪后的
  await step('comment-ok', { roomId, content: '第一条评论' },
    await emitAck(viewer, 'send-comment', { roomId, content: '  第一条评论  ' }));

  await step('comment-danmaku-flag', { roomId, content: '带弹幕标记', isDanmaku: true },
    await emitAck(owner, 'send-comment', { roomId, content: '带弹幕标记', isDanmaku: true }));

  // 禁言后不能再发（禁言按 userId 落 room.mutedViewers）
  await step('comment-mute-target', { roomId, userId: 2 },
    await emitAck(owner, 'mute-viewer', { roomId, userId: 2 }));
  await step('comment-by-muted', { roomId, content: '被禁言了' },
    await emitAck(viewer, 'send-comment', { roomId, content: '被禁言了' }));
  await step('comment-unmute-target', { roomId, userId: 2 },
    await emitAck(owner, 'unmute-viewer', { roomId, userId: 2 }));
  await step('comment-after-unmute', { roomId, content: '解禁了' },
    await emitAck(viewer, 'send-comment', { roomId, content: '解禁了' }));

  // ==================== comment-history ====================
  await step('history-outsider', { roomId }, await emitAck(admin, 'comment-history', { roomId }));
  await step('history-ok', { roomId }, await emitAck(viewer, 'comment-history', { roomId }));

  // ==================== join-room-panel ====================
  await step('panel-missing-room', { roomId: 'NOPE1234' },
    await emitAck(admin, 'join-room-panel', { roomId: 'NOPE1234' }));
  // admin 有账号但没进过房：canReadRoom 判 false
  await step('panel-denied', { roomId },
    await emitAck(admin, 'join-room-panel', { roomId }));
  await step('panel-ok', { roomId },
    await emitAck(viewer, 'join-room-panel', { roomId }));
  // 重复加入要幂等（panelRoomIds 去重）
  await step('panel-again', { roomId },
    await emitAck(viewer, 'join-room-panel', { roomId }));
  await step('history-after-panel', { roomId }, await emitAck(viewer, 'comment-history', { roomId }));

  // ==================== send-danmaku ====================
  await step('danmaku-outsider', { roomId, content: '外面的弹幕' },
    await emitAck(admin, 'send-danmaku', { roomId, content: '外面的弹幕' }));
  await step('danmaku-empty', { roomId, content: '' },
    await emitAck(viewer, 'send-danmaku', { roomId, content: '' }));

  await step('danmaku-with-time', { roomId, content: '12.5 秒的弹幕', videoTime: 12.5 },
    await emitAck(viewer, 'send-danmaku', { roomId, content: '12.5 秒的弹幕', videoTime: 12.5 }));

  // 不带 videoTime：realtimeLog 里**不能出现 time 键**（不是 time:0）
  await step('danmaku-no-time', { roomId, content: '没有时间戳' },
    await emitAck(guest, 'send-danmaku', { roomId, content: '没有时间戳' }));

  await step('danmaku-mute-target', { roomId, userId: 2 },
    await emitAck(owner, 'mute-viewer', { roomId, userId: 2 }));
  await step('danmaku-by-muted', { roomId, content: '被禁言的弹幕' },
    await emitAck(viewer, 'send-danmaku', { roomId, content: '被禁言的弹幕' }));
  await step('danmaku-unmute-target', { roomId, userId: 2 },
    await emitAck(owner, 'unmute-viewer', { roomId, userId: 2 }));

  // ==================== annotation-stroke ====================
  await step('annotation-outsider', { roomId },
    await emitAck(admin, 'annotation-stroke', {
      roomId,
      stroke: { id: 's1', type: 'pen', color: '#f00', width: 3, points: [{ x: 1, y: 2 }] },
    }));

  await step('annotation-ok', { roomId },
    await emitAck(viewer, 'annotation-stroke', {
      roomId,
      stroke: { id: 's1', type: 'pen', color: '#f00', width: 3, points: [{ x: 1, y: 2 }] },
    }));

  // 没带 stroke：转发出去的对象里整个键消失（Node 的 {stroke: undefined}）
  await step('annotation-missing-stroke', { roomId },
    await emitAck(viewer, 'annotation-stroke', { roomId }));

  // ==================== clear-annotations ====================
  await step('clear-by-viewer', { roomId },
    await emitAck(viewer, 'clear-annotations', { roomId }));
  // 零参数事件：argc 必须是 0
  await step('clear-by-owner', { roomId },
    await emitAck(owner, 'clear-annotations', { roomId }));

  // ==================== 收尾 ====================
  await step('close-room', undefined, await emitAck(owner, 'close-room'));

  for (const s of [owner, viewer, admin, guest]) {
    try { s.disconnect(); } catch { /* ignore */ }
  }
  await wait(400);

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`steps=${log.steps.length} out=${OUT}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('driver failed:', err);
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String((err && err.stack) || err) }, null, 2));
  process.exit(1);
});
