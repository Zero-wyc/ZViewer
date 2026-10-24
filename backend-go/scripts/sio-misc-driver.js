#!/usr/bin/env node
/**
 * WebRTC 信令 / 观众就绪 / CLI 代理 / 预览源 / 投屏子模式 对拍驱动器（阶段 13）。
 *
 * 覆盖 11 个上行事件：
 *   WebRTC：signal-offer / signal-answer / signal-ice-candidate
 *           viewer-ready / sharer-ready / sharer-error
 *   CLI 代理：cli-register / cli-list-agents
 *   零散：play-preview-source / update-share-method / query-stream-push-availability
 *
 * 三个必须注意的点：
 *
 * 1. `cli-register` 与 `cli-list-agents` **都没有 ack**——前者把结果发成
 *    cli-registered / cli-error 事件，后者把列表发成 cli-agents 事件。
 *    驱动器只能监听下行事件，不能等回调（等了就是 4s 超时假差异）。
 *
 * 2. CLI 连接走独立握手：`auth: { agent: 'zcontrol-cli' }`，不带用户令牌。
 *    这条通道在两端都由握手中间件直接放行。
 *
 * 3. `signal-*` 的 `data` 是原样透传的 SDP / ICE 对象。这里刻意用一个
 *    带嵌套与数组的对象，验证「服务器不改写、不丢字段」。
 *
 * 用法：node sio-misc-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/sio-misc.json';

const log = { base: BASE, steps: [], assertions: [] };

let buffer = [];
const aliases = new Map();
const roomAliases = new Map();

const TS_KEYS = new Set(['updatedAt', 'serverTs', 'clientTs', 'createdAt', 'startedAt', 'endedAt']);
const SOCKET_KEYS = new Set(['socketId', 'from', 'hostSocketId', 'viewerSocketId']);

function aliasOf(socketId) {
  if (!socketId) return socketId;
  return aliases.get(socketId) || socketId;
}

function roomAlias(roomId) {
  if (!roomId) return roomId;
  if (!roomAliases.has(roomId)) roomAliases.set(roomId, `ROOM${roomAliases.size + 1}`);
  return roomAliases.get(roomId);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (TS_KEYS.has(k)) {
        out[k] = '<TS>';
        continue;
      }
      if (SOCKET_KEYS.has(k) && typeof v === 'string') {
        out[k] = aliasOf(v);
        continue;
      }
      if (k === 'roomId' && typeof v === 'string') {
        out[k] = roomAlias(v);
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
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
  'signal-offer', 'signal-answer', 'signal-ice-candidate',
  'viewer-ready', 'sharer-ready', 'sharer-error',
  'preview-source', 'movie-list', 'current-movie',
  'cli-registered', 'cli-error', 'cli-agents',
  'cli-agent-available', 'cli-agent-unavailable',
  'share-method-changed',
  'viewer-joined', 'viewer-left', 'room-closed',
];

function connect(name, auth) {
  const socket = io(BASE, {
    auth,
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
  await wait(220);
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

function assert(name, ok, detail) {
  log.assertions.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) console.error(`!! 断言失败 ${name}: ${detail}`);
}

/** 一份带嵌套 / 数组 / 空值的「SDP 形状」对象，用来验透传不改写。 */
const SDP = {
  type: 'offer',
  sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n',
  extras: { iceServers: ['stun:a', 'stun:b'], nested: { deep: [1, 2, 3] } },
  trickle: true,
  nullable: null,
};

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

  const ownerToken = await login('sio-owner', 'sio-pass-1234');
  const viewerToken = await login('sio-viewer', 'sio-pass-1234');
  const adminToken = await login('sio-admin', 'sio-pass-1234');

  const owner = connect('OWNER', { token: ownerToken });
  const viewer = connect('VIEWER', { token: viewerToken });
  const admin = connect('ADMIN', { token: adminToken }); // 不进房
  const cli = connect('CLI', { agent: 'zcontrol-cli' });
  await wait(700);

  assert('CLI 连接建立（auth.agent=zcontrol-cli）', !!cli.id, `cli.id=${cli.id}`);

  // ==================== CLI 代理 ====================
  // 普通账号冒充 CLI：必须回 cli-error「未授权的 CLI 代理连接」
  await new Promise((resolve) => {
    owner.emit('cli-register', { proxyUrl: 'http://127.0.0.1:9800' });
    setTimeout(resolve, 300);
  });
  await step('cli-register-unauthorized', { proxyUrl: 'http://127.0.0.1:9800' }, undefined);

  // 缺 proxyUrl
  await new Promise((resolve) => {
    cli.emit('cli-register', {});
    setTimeout(resolve, 300);
  });
  await step('cli-register-missing-url', {}, undefined);

  // 正常注册：hostname 会被归一到 127.0.0.1
  await new Promise((resolve) => {
    cli.emit('cli-register', {
      proxyUrl: 'http://192.168.1.50:9800/cli',
      agent: 'zcontrol-cli',
      version: '1.2.3',
      user: '  sio-owner  ',
    });
    setTimeout(resolve, 350);
  });
  await step('cli-register-ok', { proxyUrl: 'http://192.168.1.50:9800/cli' }, undefined);

  const registered = (log.steps[2].events || []).find((e) => e.event === 'cli-registered');
  assert('CLI 注册后收到 cli-registered', !!registered, JSON.stringify(log.steps[2].events));
  const available = (log.steps[2].events || []).find((e) => e.event === 'cli-agent-available');
  assert('cli-agent-available 广播给全员（OWNER 也收到）',
    (log.steps[2].events || []).some((e) => e.client === 'OWNER' && e.event === 'cli-agent-available'),
    JSON.stringify(log.steps[2].events));
  assert('proxyUrl 的 hostname 被归一为 127.0.0.1',
    available && available.payload && available.payload.proxyUrl === 'http://127.0.0.1:9800/cli',
    JSON.stringify(available && available.payload));
  assert('user 做了 trim',
    available && available.payload && available.payload.user === 'sio-owner',
    JSON.stringify(available && available.payload));

  // 列表查询（无 ack，结果是 cli-agents 事件）。
  // 注意参数形态：旧前端传的是**裸字符串** roomId，Node 侧
  // `typeof roomId === 'string'` 才回显；传对象反而不回显。
  await new Promise((resolve) => {
    viewer.emit('cli-list-agents', 'IGNORED01');
    setTimeout(resolve, 300);
  });
  await step('cli-list-agents-with-room', 'IGNORED01', undefined);
  const listed = (log.steps[3].events || []).find((e) => e.event === 'cli-agents');
  assert('cli-agents 列表含 1 个代理', listed && listed.payload && Array.isArray(listed.payload.agents)
    && listed.payload.agents.length === 1, JSON.stringify(listed && listed.payload));
  // 断言里用的是已 normalize 的 payload，roomId 已被映射成 ROOM*，
  // 所以期望值也要过一遍同一个映射函数（硬编码 ROOM1 会在换场景时失效）。
  assert('字符串参数时原样回显 roomId',
    listed && listed.payload && listed.payload.roomId === roomAlias('IGNORED01'),
    JSON.stringify(listed && listed.payload));

  // 传对象：Node 认为「不是字符串」，不回显 roomId
  await new Promise((resolve) => {
    viewer.emit('cli-list-agents', { roomId: 'IGNORED02' });
    setTimeout(resolve, 300);
  });
  await step('cli-list-agents-object-arg', { roomId: 'IGNORED02' }, undefined);
  const listedObj = (log.steps[4].events || []).find((e) => e.event === 'cli-agents');
  assert('对象参数时不回显 roomId',
    listedObj && !Object.prototype.hasOwnProperty.call(listedObj.payload, 'roomId'),
    JSON.stringify(listedObj && listedObj.payload));

  // 不带参数：payload 里不能有 roomId 键
  await new Promise((resolve) => {
    viewer.emit('cli-list-agents');
    setTimeout(resolve, 300);
  });
  await step('cli-list-agents-no-room', undefined, undefined);
  const listedNoRoom = (log.steps[5].events || []).find((e) => e.event === 'cli-agents');
  assert('不带 roomId 时 payload 只有 agents 键',
    listedNoRoom && !Object.prototype.hasOwnProperty.call(listedNoRoom.payload, 'roomId'),
    JSON.stringify(listedNoRoom && listedNoRoom.payload));

  // ==================== 建房间（投屏模式） ====================
  const created = await emitAck(owner, 'create-room', {
    name: '信令房',
    maxViewers: 5,
    mode: 'screen-share',
    requireApproval: false,
  });
  await step('setup-create-room', { name: '信令房' }, created);
  const roomId = created && created.data && created.data.roomId;
  if (!roomId) throw new Error(`create-room 未返回 roomId: ${JSON.stringify(created)}`);

  await step('setup-register-host', { roomId }, await emitAck(owner, 'register-host', { roomId }));
  await step('setup-viewer-join', { roomId }, await emitAck(viewer, 'request-join', { roomId }));

  // ==================== WebRTC 信令 ====================
  await step('signal-offer-outsider', { to: viewer.id },
    await emitAck(admin, 'signal-offer', { to: viewer.id, data: SDP }));

  // 目标 socket 不存在
  await step('signal-offer-missing-target', { to: 'NOPE' },
    await emitAck(owner, 'signal-offer', { to: 'NOPE', data: SDP }));

  await step('signal-offer-ok', { to: viewer.id },
    await emitAck(owner, 'signal-offer', { to: viewer.id, data: SDP }));

  await step('signal-answer-ok', { to: owner.id },
    await emitAck(viewer, 'signal-answer', { to: owner.id, data: { type: 'answer', sdp: 'v=0\r\n' } }));

  await step('signal-ice-ok', { to: owner.id },
    await emitAck(viewer, 'signal-ice-candidate', {
      to: owner.id,
      data: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0' },
    }));

  // data 缺失：转发对象里整个 data 键消失
  await step('signal-offer-no-data', { to: viewer.id },
    await emitAck(owner, 'signal-offer', { to: viewer.id }));

  // ==================== 观众 / 房主就绪 ====================
  await step('viewer-ready-outsider', { roomId },
    await emitAck(admin, 'viewer-ready', { roomId }));

  await step('viewer-ready-ok', { roomId }, await emitAck(viewer, 'viewer-ready', { roomId }));

  const viewerReadyStep = log.steps[log.steps.length - 1];
  assert('viewer-ready 转发给房主', (viewerReadyStep.events || []).some(
    (e) => e.client === 'OWNER' && e.event === 'viewer-ready'), JSON.stringify(viewerReadyStep.events));
  assert('viewer-ready 后观众收到 movie-list（空数组）', (viewerReadyStep.events || []).some(
    (e) => e.client === 'VIEWER' && e.event === 'movie-list'
      && Array.isArray(e.payload && e.payload.movies)), JSON.stringify(viewerReadyStep.events));
  assert('viewer-ready 后观众收到 current-movie（movieId 键存在）', (viewerReadyStep.events || []).some(
    (e) => e.client === 'VIEWER' && e.event === 'current-movie'
      && e.payload && Object.prototype.hasOwnProperty.call(e.payload, 'movieId')),
  JSON.stringify(viewerReadyStep.events));

  await step('sharer-ready-by-viewer', { roomId },
    await emitAck(viewer, 'sharer-ready', { roomId }));

  await step('sharer-ready-ok', { roomId }, await emitAck(owner, 'sharer-ready', { roomId }));

  await step('sharer-error-by-viewer', { roomId },
    await emitAck(viewer, 'sharer-error', { roomId, message: '冒充' }));

  await step('sharer-error-custom', { roomId },
    await emitAck(owner, 'sharer-error', { roomId, message: '摄像头被占用' }));

  // 空 message → 回退默认文案（键内容要逐字一致）
  await step('sharer-error-empty', { roomId },
    await emitAck(owner, 'sharer-error', { roomId, message: '' }));

  // 超长 message（> 200）→ 同样回退默认文案
  await step('sharer-error-too-long', { roomId },
    await emitAck(owner, 'sharer-error', { roomId, message: 'x'.repeat(201) }));

  // ==================== 播放预览源 ====================
  const previewSource = {
    url: 'https://example.com/preview.m3u8',
    title: '预览标题',
    sourceType: 'hls',
    duration: 120,
  };

  await step('preview-by-viewer', { roomId },
    await emitAck(viewer, 'play-preview-source', { roomId, source: previewSource }));

  await step('preview-ok', { roomId },
    await emitAck(owner, 'play-preview-source', { roomId, source: previewSource }));

  // 缺 source：广播出去的对象里没有 source 键
  await step('preview-no-source', { roomId },
    await emitAck(owner, 'play-preview-source', { roomId }));

  // ==================== 投屏子模式 ====================
  // 这条事件的 Node handler 签名是 `(_payload, callback)`：调用时**必须**
  // 带一个占位参数，否则 ack 回调会被当成 payload，永远等不到应答。
  await step('share-method-availability', null,
    await emitAck(owner, 'query-stream-push-availability', null));

  await step('share-method-by-viewer', { roomId },
    await emitAck(viewer, 'update-share-method', { roomId, shareMethod: 'stream-push' }));

  // NMS 未启用（STREAM_PUSH_ENABLED=0）→ 明确拒绝
  await step('share-method-stream-push', { roomId },
    await emitAck(owner, 'update-share-method', { roomId, shareMethod: 'stream-push' }));

  await step('share-method-webrtc', { roomId },
    await emitAck(owner, 'update-share-method', { roomId, shareMethod: 'webrtc' }));

  // 非投屏房间不允许切子模式：另建一个 watch-together 房间
  const wt = await emitAck(admin, 'create-room', {
    name: '一起看房',
    maxViewers: 3,
    mode: 'watch-together',
    requireApproval: false,
  });
  await step('setup-create-watch-together', { name: '一起看房' }, wt);
  const wtRoomId = wt && wt.data && wt.data.roomId;
  await step('setup-wt-register-host', { roomId: wtRoomId },
    await emitAck(admin, 'register-host', { roomId: wtRoomId }));
  await step('share-method-wrong-mode', { roomId: wtRoomId },
    await emitAck(admin, 'update-share-method', { roomId: wtRoomId, shareMethod: 'webrtc' }));

  // ==================== CLI 下线广播 ====================
  await new Promise((resolve) => {
    cli.disconnect();
    setTimeout(resolve, 400);
  });
  await step('cli-disconnect', undefined, undefined);
  assert('CLI 断开后广播 cli-agent-unavailable', (log.steps[log.steps.length - 1].events || []).some(
    (e) => e.event === 'cli-agent-unavailable'), JSON.stringify(log.steps[log.steps.length - 1].events));

  // ==================== 收尾 ====================
  await step('close-room', undefined, await emitAck(owner, 'close-room'));
  await step('close-wt-room', undefined, await emitAck(admin, 'close-room'));

  for (const s of [owner, viewer, admin]) {
    try { s.disconnect(); } catch { /* ignore */ }
  }
  await wait(400);

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  const failed = log.assertions.filter((a) => !a.ok);
  console.log(`steps=${log.steps.length} assertions=${log.assertions.length} failed=${failed.length} out=${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('driver failed:', err);
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String((err && err.stack) || err) }, null, 2));
  process.exit(1);
});
