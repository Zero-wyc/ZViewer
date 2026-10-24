#!/usr/bin/env node
/**
 * 房间设置与成员管理对拍驱动器（阶段 9）。
 *
 * 覆盖 12 个事件：
 *   房间设置：update-room-name / update-room-mode / update-room-settings / p2p-mode-change
 *   成员管理：approve-join / reject-join / kick-viewer / mute-viewer /
 *            unmute-viewer / transfer-host / appoint-moderator / dismiss-moderator
 *
 * 与 sio-rooms-driver.js 相同的三条规范化（socketId / roomId / 时间列），
 * 另外多一条：**bcrypt 密文不可比** —— 同一明文两次加密结果不同（随机盐），
 * 所以 room-settings-updated 里的 password 一律替换成 <HASH>，
 * 只比「有没有密码」这个事实。
 *
 * 用法：node sio-members-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/sio-members.json';

const log = { base: BASE, steps: [] };

let buffer = [];
const aliases = new Map();
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

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 时间列一律不比：两侧落库精度不同，值必然不同而格式都合法。
      if (k === 'updatedAt' || k === 'startedAt' || k === 'endedAt' || k === 'createdAt') continue;
      if (k === 'currentTime') continue;
      // bcrypt 带随机盐：同一明文两次加密不同，只能比「有没有」。
      if (k === 'password') {
        out[k] = typeof v === 'string' && v !== '' ? '<HASH>' : v;
        continue;
      }
      if (k === 'socketId' || k === 'viewerSocketId' || k === 'hostSocketId' ||
          k === 'newHostSocketId' || k === 'oldHostSocketId') {
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
  'room-closed', 'viewer-joined', 'viewer-left', 'join-request', 'join-approved',
  'join-rejected', 'movie-list', 'current-movie', 'subtitle-update',
  'moderators-changed', 'viewer-kicked', 'viewer-muted', 'room-name-updated',
  'room-mode-changed', 'room-settings-updated', 'p2p-mode-change',
  'host-transferred', 'host-disconnected',
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

async function step(name, payload, ackResponse) {
  await wait(180);
  const events = buffer
    .map((e) => {
      const payload = normalize(e.payload);
      return { client: e.client, event: e.event, payload, canon: `${e.client}|${e.event}|${stable(payload)}` };
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
  const admin = connect('ADMIN', adminToken);
  const guest = connect('GUEST', await guestToken());
  await wait(600);

  // ---- 建房间 A 并拉两个人进来（不开审批） ----
  const created = await emitAck(owner, 'create-room', {
    name: '成员管理房',
    maxViewers: 5,
    mode: 'watch-together',
    requireApproval: false,
  });
  await step('setup-create-room', { name: '成员管理房' }, created);
  const roomId = created && created.data && created.data.roomId;
  if (!roomId) throw new Error(`create-room 未返回 roomId: ${JSON.stringify(created)}`);

  const registered = await emitAck(owner, 'register-host', { roomId });
  await step('setup-register-host', { roomId }, registered);

  const viewerJoin = await emitAck(viewer, 'request-join', { roomId });
  await step('setup-viewer-join', { roomId }, viewerJoin);

  const guestJoin = await emitAck(guest, 'request-join', { roomId });
  await step('setup-guest-join', { roomId }, guestJoin);

  // ==================== 房间设置 ====================
  const nameByViewer = await emitAck(viewer, 'update-room-name', { roomId, name: '改名试试' });
  await step('name-by-viewer', { roomId, name: '改名试试' }, nameByViewer);

  const nameEmpty = await emitAck(owner, 'update-room-name', { roomId, name: '   ' });
  await step('name-empty', { roomId, name: '   ' }, nameEmpty);

  const nameMissing = await emitAck(owner, 'update-room-name', { roomId: 'NOPE1234', name: 'x' });
  await step('name-missing-room', { roomId: 'NOPE1234', name: 'x' }, nameMissing);

  const nameOk = await emitAck(owner, 'update-room-name', { roomId, name: '  改名后的房间  ' });
  await step('name-ok', { roomId, name: '改名后的房间' }, nameOk);

  const modeByViewer = await emitAck(viewer, 'update-room-mode', { roomId, mode: 'screen-share' });
  await step('mode-by-viewer', { roomId, mode: 'screen-share' }, modeByViewer);

  const modeOk = await emitAck(owner, 'update-room-mode', { roomId, mode: 'screen-share' });
  await step('mode-ok', { roomId, mode: 'screen-share' }, modeOk);

  const settingsByViewer = await emitAck(viewer, 'update-room-settings', { roomId, maxViewers: 3 });
  await step('settings-by-viewer', { roomId, maxViewers: 3 }, settingsByViewer);

  const settingsBadMax = await emitAck(owner, 'update-room-settings', { roomId, maxViewers: 0 });
  await step('settings-bad-max', { roomId, maxViewers: 0 }, settingsBadMax);

  // 5.5 属于 number 但不是整数：Node 用 Number.isInteger 挡，Go 必须同口径
  const settingsFloat = await emitAck(owner, 'update-room-settings', { roomId, maxViewers: 5.5 });
  await step('settings-float-max', { roomId, maxViewers: 5.5 }, settingsFloat);

  const settingsOk = await emitAck(owner, 'update-room-settings', {
    roomId,
    maxViewers: 6,
    requireApproval: true,
  });
  await step('settings-ok', { roomId, maxViewers: 6, requireApproval: true }, settingsOk);

  // 关掉审批，后续流程还要往里放人
  const settingsApprovalOff = await emitAck(owner, 'update-room-settings', {
    roomId,
    requireApproval: false,
  });
  await step('settings-approval-off', { roomId, requireApproval: false }, settingsApprovalOff);

  const settingsPassword = await emitAck(owner, 'update-room-settings', {
    roomId,
    password: 'pw-abcdef',
  });
  await step('settings-password', { roomId, password: 'pw-abcdef' }, settingsPassword);

  // 空串密码 = 清空（列写 NULL），不是「设成空密码」
  const settingsPasswordClear = await emitAck(owner, 'update-room-settings', {
    roomId,
    password: '',
  });
  await step('settings-password-clear', { roomId, password: '' }, settingsPasswordClear);

  // ---- p2p-mode-change：发送者自己收不到 ----
  const p2pByViewer = await emitAck(viewer, 'p2p-mode-change', { roomId, enabled: true });
  await step('p2p-by-viewer', { roomId, enabled: true }, p2pByViewer);

  const p2pByOutsider = await emitAck(admin, 'p2p-mode-change', { roomId, enabled: true });
  await step('p2p-by-outsider', { roomId, enabled: true }, p2pByOutsider);

  // ==================== 禁言 / 解禁 ====================
  const muteByViewer = await emitAck(viewer, 'mute-viewer', { roomId, userId: 0 });
  await step('mute-by-viewer', { roomId, userId: 0 }, muteByViewer);

  // 游客共享 userId=0：禁一个等于禁全体，必须拒绝并引导用踢出
  const muteGuest = await emitAck(owner, 'mute-viewer', { roomId, userId: 0 });
  await step('mute-guest', { roomId, userId: 0 }, muteGuest);

  const muteViewer = await emitAck(owner, 'mute-viewer', { roomId, userId: 2 });
  await step('mute-viewer', { roomId, userId: 2 }, muteViewer);

  const unmuteViewer = await emitAck(owner, 'unmute-viewer', { roomId, userId: 2 });
  await step('unmute-viewer', { roomId, userId: 2 }, unmuteViewer);

  // ==================== 房管任命 / 撤销 ====================
  const appointGuest = await emitAck(owner, 'appoint-moderator', { roomId, userId: 0 });
  await step('appoint-guest', { roomId, userId: 0 }, appointGuest);

  const appointSelf = await emitAck(owner, 'appoint-moderator', { roomId, userId: 1 });
  await step('appoint-owner-self', { roomId, userId: 1 }, appointSelf);

  const appointViewer = await emitAck(owner, 'appoint-moderator', { roomId, userId: 2 });
  await step('appoint-viewer', { roomId, userId: 2 }, appointViewer);

  // 幂等：已在名单里返回 {success:true} 且**不带 data**
  const appointAgain = await emitAck(owner, 'appoint-moderator', { roomId, userId: 2 });
  await step('appoint-again', { roomId, userId: 2 }, appointAgain);

  // 房管现在有权限：muteViewer 通过，但游客拦截依旧生效
  const muteGuestByMod = await emitAck(viewer, 'mute-viewer', { roomId, userId: 0 });
  await step('mute-guest-by-moderator', { roomId, userId: 0 }, muteGuestByMod);

  // 房管防篡权：不能动房主
  const kickOwnerByMod = await emitAck(viewer, 'kick-viewer', {
    roomId,
    viewerSocketId: owner.id,
  });
  await step('kick-owner-by-moderator', { roomId }, kickOwnerByMod);

  const dismiss = await emitAck(owner, 'dismiss-moderator', { roomId, userId: 2 });
  await step('dismiss-moderator', { roomId, userId: 2 }, dismiss);

  const dismissAgain = await emitAck(owner, 'dismiss-moderator', { roomId, userId: 2 });
  await step('dismiss-again', { roomId, userId: 2 }, dismissAgain);

  // ==================== 转交房主 ====================
  const transferByViewer = await emitAck(viewer, 'transfer-host', {
    roomId,
    viewerSocketId: viewer.id,
  });
  await step('transfer-by-viewer', { roomId }, transferByViewer);

  const transferToGuest = await emitAck(owner, 'transfer-host', {
    roomId,
    viewerSocketId: guest.id,
  });
  await step('transfer-to-guest', { roomId }, transferToGuest);

  // 先把 VIEWER 重新任命为房管，再转交：新房主必须从房管名单里被移除
  const reap = await emitAck(owner, 'appoint-moderator', { roomId, userId: 2 });
  await step('appoint-before-transfer', { roomId, userId: 2 }, reap);

  const transferOk = await emitAck(owner, 'transfer-host', {
    roomId,
    viewerSocketId: viewer.id,
  });
  await step('transfer-ok', { roomId }, transferOk);

  // 转交后 VIEWER 成为房主，可以踢人
  const kickMissing = await emitAck(viewer, 'kick-viewer', {
    roomId,
    viewerSocketId: 'NOPE_SOCKET_ID',
  });
  await step('kick-missing', { roomId }, kickMissing);

  const kickGuest = await emitAck(viewer, 'kick-viewer', {
    roomId,
    viewerSocketId: guest.id,
  });
  await step('kick-guest', { roomId }, kickGuest);

  // ==================== 审批进房 ====================
  const approvalRoom = await emitAck(admin, 'create-room', {
    name: '审批房',
    maxViewers: 5,
    mode: 'watch-together',
    requireApproval: true,
  });
  await step('approval-create-room', { name: '审批房' }, approvalRoom);
  const approvalRoomId = approvalRoom && approvalRoom.data && approvalRoom.data.roomId;

  if (approvalRoomId) {
    const approvalHost = await emitAck(admin, 'register-host', { roomId: approvalRoomId });
    await step('approval-register-host', { roomId: approvalRoomId }, approvalHost);

    const guest2 = connect('GUEST2', await guestToken());
    const guest3 = connect('GUEST3', await guestToken());
    await wait(400);

    const pending2 = await emitAck(guest2, 'request-join', { roomId: approvalRoomId });
    await step('pending-join-guest2', { roomId: approvalRoomId }, pending2);

    const approveMissing = await emitAck(admin, 'approve-join', { viewerSocketId: 'NOPE_SOCKET_ID' });
    await step('approve-missing', null, approveMissing);

    const approved = await emitAck(admin, 'approve-join', { viewerSocketId: guest2.id });
    await step('approve-guest2', null, approved);

    // 已被批准过（pendingRoomId 已清除）
    const rejectAfterApprove = await emitAck(admin, 'reject-join', { viewerSocketId: guest2.id });
    await step('reject-after-approve', null, rejectAfterApprove);

    const pending3 = await emitAck(guest3, 'request-join', { roomId: approvalRoomId });
    await step('pending-join-guest3', { roomId: approvalRoomId }, pending3);

    const rejected = await emitAck(admin, 'reject-join', { viewerSocketId: guest3.id });
    await step('reject-guest3', null, rejected);

    guest2.disconnect();
    guest3.disconnect();
    await step('approval-guests-disconnect', null, null);
  }

  for (const s of [owner, viewer, guest, admin]) {
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
