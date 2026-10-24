#!/usr/bin/env node
/**
 * 播放控制 / 影片列表 / 字幕轨道 / 跳转申请 对拍驱动器（阶段 10）。
 *
 * 覆盖 19 个事件：
 *   播放控制：watch-together-state / watch-together-request-state /
 *            watch-together-control / watch-together-check-status / host-heartbeat
 *   影片列表：add-movie / remove-movie / play-movie /
 *            request-movie-list / request-current-movie
 *   字幕轨道：subtitle-update / subtitle-request / track-change
 *   跳转申请：seek-request / seek-response / pause-request / pause-response /
 *            play-request / play-response
 *
 * 与阶段 9 驱动器的差别：
 * - currentTime / 各时间列不删键，改成 `<TIME>` / `<TS>` 占位。两侧的播放
 *   进度必然不同（落库时刻、推算时刻都不一样），但「这个键存在吗」是能比
 *   也必须比的——少一个键前端就走不同分支。
 * - 影片 id 按首次出现顺序映射成 MOVIE1/MOVIE2：两次跑的 DB 自增序列可能
 *   不同，而「哪条事件指向哪部影片」才是要验的语义。
 *
 * 用法：node sio-playback-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/sio-playback.json';

const log = { base: BASE, steps: [] };

let buffer = [];
const aliases = new Map();
const roomAliases = new Map();
const movieAliases = new Map();

const TIME_KEYS = new Set(['currentTime', 'positionSec', 'time', 'duration']);
const TS_KEYS = new Set(['updatedAt', 'startedAt', 'endedAt', 'createdAt', 'serverTs', 'clientTs']);
const SOCKET_KEYS = new Set([
  'socketId', 'viewerSocketId', 'hostSocketId', 'newHostSocketId', 'oldHostSocketId',
]);

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

function movieAlias(id) {
  if (id === null || id === undefined) return id;
  const key = String(id);
  if (!movieAliases.has(key)) {
    movieAliases.set(key, `MOVIE${movieAliases.size + 1}`);
  }
  return movieAliases.get(key);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 进度与时间戳：值必然不同，但「键在不在」必须比。
      if (TIME_KEYS.has(k) && typeof v === 'number') {
        out[k] = '<TIME>';
        continue;
      }
      if (TS_KEYS.has(k)) {
        out[k] = '<TS>';
        continue;
      }
      if (k === 'password') {
        out[k] = typeof v === 'string' && v !== '' ? '<HASH>' : v;
        continue;
      }
      if (SOCKET_KEYS.has(k)) {
        out[k] = typeof v === 'string' ? aliasOf(v) : v;
        continue;
      }
      if (k === 'roomId') {
        out[k] = typeof v === 'string' ? roomAlias(v) : v;
        continue;
      }
      if (k === 'movieId' || k === 'id') {
        out[k] = typeof v === 'number' ? movieAlias(v) : v;
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
  'movie-list', 'current-movie',
  'watch-together-state', 'watch-together-control', 'watch-together-request-state',
  'host-heartbeat', 'sync-heartbeat', 'server-heartbeat',
  'subtitle-update', 'track-change',
  'seek-request', 'seek-response', 'pause-request', 'pause-response',
  'play-request', 'play-response',
  'viewer-joined', 'viewer-left', 'room-closed', 'room-mode-changed',
];

/**
 * 服务器周期心跳单独收集，不进步骤缓冲。
 *
 * 原因：它是 2s 周期定时器推的，两端的相位必然不同——放进 buffer 会把
 * 「这一步收到了哪些事件」切得两边不一样，每次跑都随机多出假差异。
 * 改成「形状去重」比较：payload 的键集合、state 的键集合、source 值、
 * hostOnline 的类型。这些是确定性的，而数量与时刻不是。
 */
const heartbeats = [];

function isServerHeartbeat(event, payload) {
  if (event === 'server-heartbeat') return true;
  return event === 'sync-heartbeat' && !!payload && payload.source === 'server';
}

/** 心跳的「形状」：只保留确定性的部分。 */
function heartbeatShape(entry) {
  const payload = entry.payload || {};
  const state = payload.state && typeof payload.state === 'object' ? payload.state : null;
  return {
    event: entry.event,
    keys: Object.keys(payload).sort(),
    stateKeys: state ? Object.keys(state).sort() : null,
    source: payload.source === undefined ? '<undefined>' : payload.source,
    hostOnline: typeof payload.hostOnline,
  };
}

/** 把收到的心跳压成「形状集合」（确定性、与触发时刻无关）。 */
function summarizeHeartbeats(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const shape = heartbeatShape(entry);
    seen.set(stable(shape), shape);
  }
  return Array.from(seen.keys()).sort().map((k) => seen.get(k));
}

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
      // 服务器周期心跳由 playbackBroadcaster 每 2s 主动推，触发时刻不可控，
      // 单独收集（见 heartbeats 的注释），不进步骤缓冲。
      if (isServerHeartbeat(ev, payload)) {
        heartbeats.push({ client: name, event: ev, payload });
        return;
      }
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

/** 轮询等待条件成立（心跳是定时器推的，只能等，不能算）。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(100);
  }
  return predicate();
}

async function step(name, payload, ackResponse) {
  await wait(200);
  const events = buffer
    .map((e) => {
      const norm = normalize(e.payload);
      return { client: e.client, event: e.event, payload: norm, canon: `${e.client}|${e.event}|${stable(norm)}` };
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

/** 一个完整的播放状态（字段与 SyncStateDto 对齐）。 */
function playbackState(overrides = {}) {
  return {
    sourceUrl: 'https://example.com/vod/play.m3u8',
    sourceType: 'url',
    format: 'hls',
    isPlaying: false,
    currentTime: 0,
    playbackRate: 1,
    duration: 3600,
    ...overrides,
  };
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

  // ---- 建房（一起看模式，免审批）并拉人 ----
  const created = await emitAck(owner, 'create-room', {
    name: '播放控制房',
    maxViewers: 5,
    mode: 'watch-together',
    requireApproval: false,
  });
  await step('setup-create-room', { name: '播放控制房' }, created);
  const roomId = created && created.data && created.data.roomId;
  if (!roomId) throw new Error(`create-room 未返回 roomId: ${JSON.stringify(created)}`);

  await step('setup-register-host', { roomId }, await emitAck(owner, 'register-host', { roomId }));
  await step('setup-viewer-join', { roomId }, await emitAck(viewer, 'request-join', { roomId }));
  await step('setup-guest-join', { roomId }, await emitAck(guest, 'request-join', { roomId }));

  // ==================== 影片列表 ====================
  const added = await emitAck(owner, 'add-movie', {
    roomId,
    movie: {
      url: 'https://example.com/vod/movie-a.m3u8',
      title: '影片甲',
      source: 'url',
      format: 'hls',
      duration: 3600,
    },
  });
  await step('add-movie', { roomId, movie: { url: 'https://example.com/vod/movie-a.m3u8', title: '影片甲' } }, added);

  // 房主之外的人能不能加片，取决于权限矩阵默认值（房管/admin 默认放行、
  // user 默认拒绝），这里验的就是默认矩阵下的拒绝文案。
  const addByViewer = await emitAck(viewer, 'add-movie', {
    roomId,
    movie: { url: 'https://example.com/vod/movie-b.m3u8', title: '影片乙' },
  });
  await step('add-movie-by-viewer', { roomId, movie: { title: '影片乙' } }, addByViewer);

  const listByViewer = await emitAck(viewer, 'request-movie-list', { roomId });
  await step('request-movie-list', { roomId }, listByViewer);

  const listOutsider = await emitAck(admin, 'request-movie-list', { roomId });
  await step('request-movie-list-outsider', { roomId }, listOutsider);

  const currentEmpty = await emitAck(viewer, 'request-current-movie', { roomId });
  await step('request-current-movie-empty', { roomId }, currentEmpty);

  const currentOutsider = await emitAck(admin, 'request-current-movie', { roomId });
  await step('request-current-movie-outsider', { roomId }, currentOutsider);

  // ==================== 播放状态 ====================
  // 房主还没广播过 state：这里应该是 data=null + 让房主补一次
  const stateBeforeAny = await emitAck(viewer, 'watch-together-request-state', { roomId });
  await step('request-state-before-any', { roomId }, stateBeforeAny);

  const stateOutsider = await emitAck(admin, 'watch-together-request-state', { roomId });
  await step('request-state-outsider', { roomId }, stateOutsider);

  const pushByViewer = await emitAck(viewer, 'watch-together-state', {
    roomId,
    state: playbackState(),
  });
  await step('state-by-viewer', { roomId }, pushByViewer);

  const push = await emitAck(owner, 'watch-together-state', {
    roomId,
    state: playbackState({ isPlaying: false, currentTime: 12 }),
    diff: { reason: 'initial' },
    seq: 1,
    clientTs: Date.now(),
  });
  await step('state-ok', { roomId, seq: 1 }, push);

  const stateAfter = await emitAck(viewer, 'watch-together-request-state', { roomId });
  await step('request-state-after-push', { roomId }, stateAfter);

  // ==================== 服务器周期心跳（房主在线） ====================
  // 房主已广播过 state：房间有人、有播放记忆，服务器应开始每 2s 推一轮。
  // 等一轮是确定性的（周期固定 2s），比「跑完数收到几条」稳。
  const beforeFirstHeartbeat = heartbeats.length;
  const firstHeartbeat = await waitFor(() => heartbeats.length > beforeFirstHeartbeat, 6000);
  await step('await-server-heartbeat', { roomId }, { received: firstHeartbeat });

  // ---- 控制：play / rate / seek / pause ----
  const controlByViewer = await emitAck(viewer, 'watch-together-control', { roomId, action: 'play' });
  await step('control-by-viewer', { roomId, action: 'play' }, controlByViewer);

  await step('control-play', { roomId, action: 'play' },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'play', clientTs: Date.now() }));
  await step('request-state-after-play', { roomId },
    await emitAck(viewer, 'watch-together-request-state', { roomId }));

  await step('control-rate', { roomId, action: 'rate', value: 1.5 },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'rate', value: 1.5 }));
  await step('request-state-after-rate', { roomId },
    await emitAck(viewer, 'watch-together-request-state', { roomId }));

  await step('control-seek', { roomId, action: 'seek', value: 300 },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'seek', value: 300 }));
  await step('request-state-after-seek', { roomId },
    await emitAck(viewer, 'watch-together-request-state', { roomId }));

  // seek 后 isPlaying 应保持 true（旧实现会强制置 false 造成抖动）
  await step('control-seek-negative', { roomId, action: 'seek', value: -5 },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'seek', value: -5 }));

  await step('control-pause', { roomId, action: 'pause' },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'pause' }));
  await step('request-state-after-pause', { roomId },
    await emitAck(viewer, 'watch-together-request-state', { roomId }));

  await step('control-unknown-action', { roomId, action: 'noop' },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'noop' }));

  // ---- 心跳 ----
  const hbByViewer = await emitAck(viewer, 'host-heartbeat', {
    roomId, currentTime: 320, isPlaying: true, playbackRate: 1.5,
  });
  await step('heartbeat-by-viewer', { roomId }, hbByViewer);

  await step('heartbeat', { roomId },
    await emitAck(owner, 'host-heartbeat', {
      roomId, currentTime: 320, isPlaying: true, playbackRate: 1.5, suppressed: false,
    }));
  await step('heartbeat-suppressed', { roomId },
    await emitAck(owner, 'host-heartbeat', {
      roomId, currentTime: 322, isPlaying: true, playbackRate: 1.5, suppressed: true,
    }));

  // ---- 自检：进度偏差在容差内 / isPlaying 分歧 ----
  await step('check-status-agree', { roomId },
    await emitAck(viewer, 'watch-together-check-status', {
      roomId, currentTime: 322, isPlaying: true, playbackRate: 1.5, clientTs: Date.now(),
    }));
  await step('check-status-playing-mismatch', { roomId },
    await emitAck(viewer, 'watch-together-check-status', {
      roomId, currentTime: 322, isPlaying: false, playbackRate: 1.5,
    }));
  const checkOutsider = await emitAck(admin, 'watch-together-check-status', {
    roomId, currentTime: 0, isPlaying: false, playbackRate: 1, clientTs: Date.now(),
  });
  await step('check-status-outsider', { roomId }, checkOutsider);

  // ==================== 字幕 / 轨道 ====================
  const subtitlePayload = {
    roomId,
    tracks: [{ id: 'zh', label: '中文', mode: 'showing' }],
    cues: [{ start: 0, end: 2.5, text: '第一句' }],
  };
  const subtitleByViewer = await emitAck(viewer, 'subtitle-update', subtitlePayload);
  await step('subtitle-by-viewer', { roomId }, subtitleByViewer);

  const subtitleOk = await emitAck(owner, 'subtitle-update', subtitlePayload);
  await step('subtitle-ok', { roomId }, subtitleOk);

  // 观众主动拉取缓存（无 ack，只验回发的 subtitle-update）
  viewer.emit('subtitle-request', { roomId });
  await step('subtitle-request', { roomId }, null);

  guest.emit('subtitle-request', { roomId: 'NOPE1234' });
  await step('subtitle-request-missing-room', null, null);

  await step('subtitle-missing-room', null,
    await emitAck(owner, 'subtitle-update', { tracks: [] }));

  const trackByViewer = await emitAck(viewer, 'track-change', { roomId, type: 'subtitle', value: 2 });
  await step('track-by-viewer', { roomId, type: 'subtitle', value: 2 }, trackByViewer);

  await step('track-subtitle', { roomId, type: 'subtitle', value: 2 },
    await emitAck(owner, 'track-change', { roomId, type: 'subtitle', value: 2 }));
  await step('track-danmaku', { roomId, type: 'danmaku', value: 'track-1' },
    await emitAck(owner, 'track-change', { roomId, type: 'danmaku', value: 'track-1' }));
  await step('track-null', { roomId, type: 'subtitle', value: null },
    await emitAck(owner, 'track-change', { roomId, type: 'subtitle', value: null }));

  // ==================== 跳转 / 暂停 / 继续 申请 ====================
  await step('seek-request', { roomId, time: 120 },
    await emitAck(viewer, 'seek-request', { roomId, time: 120 }));
  await step('seek-response-accept', { roomId, accept: true, time: 120 },
    await emitAck(owner, 'seek-response', {
      roomId, viewerSocketId: viewer.id, accept: true, time: 120,
    }));
  await step('seek-response-reject', { roomId, accept: false },
    await emitAck(owner, 'seek-response', {
      roomId, viewerSocketId: viewer.id, accept: false,
    }));
  await step('seek-response-by-viewer', { roomId },
    await emitAck(viewer, 'seek-response', { roomId, viewerSocketId: viewer.id, accept: true }));

  await step('pause-request', { roomId }, await emitAck(viewer, 'pause-request', { roomId }));
  await step('pause-response-accept', { roomId },
    await emitAck(owner, 'pause-response', { roomId, viewerSocketId: viewer.id, accept: true }));
  await step('pause-response-by-viewer', { roomId },
    await emitAck(viewer, 'pause-response', { roomId, viewerSocketId: viewer.id, accept: true }));

  await step('play-request', { roomId }, await emitAck(viewer, 'play-request', { roomId }));
  await step('play-response-accept', { roomId },
    await emitAck(owner, 'play-response', { roomId, viewerSocketId: viewer.id, accept: true }));
  await step('play-response-by-viewer', { roomId },
    await emitAck(viewer, 'play-response', { roomId, viewerSocketId: viewer.id, accept: true }));

  // 申请者身份：房主不在线时必须直接拒
  await step('seek-request-outsider', { roomId, time: 10 },
    await emitAck(admin, 'seek-request', { roomId, time: 10 }));

  // ==================== 切到 screen-share 后的模式校验 ====================
  await step('mode-to-screen-share', { roomId, mode: 'screen-share' },
    await emitAck(owner, 'update-room-mode', { roomId, mode: 'screen-share' }));

  await step('state-wrong-mode', { roomId },
    await emitAck(owner, 'watch-together-state', { roomId, state: playbackState() }));
  await step('control-wrong-mode', { roomId, action: 'play' },
    await emitAck(owner, 'watch-together-control', { roomId, action: 'play' }));

  // 心跳不看模式：screen-share 下房主同样要发
  await step('heartbeat-wrong-mode', { roomId },
    await emitAck(owner, 'host-heartbeat', {
      roomId, currentTime: 10, isPlaying: true, playbackRate: 1,
    }));

  await step('mode-back', { roomId, mode: 'watch-together' },
    await emitAck(owner, 'update-room-mode', { roomId, mode: 'watch-together' }));

  // ==================== 影片切换 / 删除 ====================
  // 从 REST 拿真实影片 id：日志与事件里的 id 已经被别名化成 MOVIE1，
  // 而 play-movie / remove-movie 需要的是库里的真实自增值。
  const listResp = await fetch(`${BASE}/api/rooms/${roomId}/movies`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  }).then((r) => r.json());
  const movieIds = (listResp.movies || []).map((m) => m.id);
  if (movieIds.length === 0) throw new Error('影片列表为空，add-movie 未生效');

  await step('play-movie', { roomId },
    await emitAck(owner, 'play-movie', { roomId, movieId: movieIds[0] }));
  await step('play-movie-by-viewer', { roomId },
    await emitAck(viewer, 'play-movie', { roomId, movieId: movieIds[0] }));
  await step('play-movie-missing', { roomId },
    await emitAck(owner, 'play-movie', { roomId, movieId: 999999 }));

  await step('request-current-movie-playing', { roomId },
    await emitAck(viewer, 'request-current-movie', { roomId }));

  await step('remove-movie', { roomId },
    await emitAck(owner, 'remove-movie', { roomId, movieId: movieIds[0] }));
  await step('remove-movie-again', { roomId },
    await emitAck(owner, 'remove-movie', { roomId, movieId: movieIds[0] }));
  await step('remove-movie-by-viewer', { roomId },
    await emitAck(viewer, 'remove-movie', { roomId, movieId: movieIds[0] }));

  await step('request-current-movie-after-remove', { roomId },
    await emitAck(viewer, 'request-current-movie', { roomId }));

  // ==================== 房主掉线后服务器接管 ====================
  // 这是整条链路的真实目的：房主没了，观众端的进度得继续推进。
  // hostOnline 有个 5s 判定缓存，所以最多要等到「缓存过期 + 一个周期」，
  // 给 12s 余量；两端缓存策略相同，正常情况下都在 7s 内翻成 false。
  owner.disconnect();
  const offlineWait = await waitFor(
    () => heartbeats.some((h) => h.payload && h.payload.hostOnline === false),
    12000,
  );
  const lastAfterOffline = heartbeats.filter((h) => h.payload && h.payload.hostOnline === false).pop();
  await step('heartbeat-after-host-offline', { roomId }, {
    received: offlineWait,
    hostOnline: lastAfterOffline ? lastAfterOffline.payload.hostOnline : null,
  });

  // ==================== 收尾 ====================
  // 房主连接已断，改用管理员关房（close-room 只认房主）。
  await step('admin-close-room-after-host-offline', { roomId },
    await emitAck(admin, 'admin-close-room', { roomId }));

  viewer.disconnect();
  admin.disconnect();
  guest.disconnect();
  await wait(200);

  log.heartbeats = summarizeHeartbeats(heartbeats);
  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  const total = log.steps.length;
  console.log(`steps=${total} heartbeats=${log.heartbeats.length} -> ${OUT}`);
}

main().catch((err) => {
  console.error('driver failed:', err);
  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, error: String(err && err.stack || err), steps: log.steps }, null, 2));
  process.exit(1);
});
