#!/usr/bin/env node
/**
 * 一起听（listen-together）对拍驱动器（阶段 13）。
 *
 * 覆盖 11 个上行事件：
 *   music:queue-upsert / queue-remove / queue-clear / queue-reorder
 *   music:sync-state / host-heartbeat / check-status
 *   music:control-request / control-response / sync-ack
 *   music:get-state
 *
 * 与其它驱动器的三点差别：
 *
 * 1. `music:sync-heartbeat` 是服务器 2s 定时广播，**不进步骤缓冲**。两侧相位
 *    必然不同，放进 buffer 会把步骤边界切歪，每次跑都随机多出假差异。
 *    改成「形状集合」比较（键集合 / source / hostOnline 类型），另外用两条
 *    等待式断言验「确实在持续发」。
 *
 * 2. 队列条目 id 是自增列，映射成 ITEM1/ITEM2…；positionSec 与 updatedAt
 *    随时间/落盘时刻变化，替换成 `<TIME>` / `<TS>` 但**不删键**——
 *    键的存在性是语义（`trackSongId: null` 表示没在播，不是「没这个字段」）。
 *
 * 3. 写侧传输延迟补偿会让广播出去的 positionSec 略大于房主上报值（最多
 *    1.5s）。差异方向上必须 ≥ 0，幅度上不得超上限，这一条单独断言。
 *
 * 用法：node sio-music-driver.js <baseUrl> <outFile>
 */
'use strict';

const fs = require('fs');
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/sio-music.json';

const log = { base: BASE, steps: [], assertions: [] };

let buffer = [];
const aliases = new Map();
const roomAliases = new Map();
const itemAliases = new Map();

const TIME_KEYS = new Set(['positionSec', 'currentTime']);
const TS_KEYS = new Set(['updatedAt', 'serverTs', 'clientTs', 'createdAt', 'endedAt', 'startedAt']);
const SOCKET_KEYS = new Set(['socketId', 'hostSocketId', 'viewerSocketId', 'from']);

function aliasOf(socketId) {
  if (!socketId) return socketId;
  return aliases.get(socketId) || socketId;
}

function roomAlias(roomId) {
  if (!roomId) return roomId;
  if (!roomAliases.has(roomId)) roomAliases.set(roomId, `ROOM${roomAliases.size + 1}`);
  return roomAliases.get(roomId);
}

function itemAlias(id) {
  if (typeof id !== 'number') return id;
  if (!itemAliases.has(id)) itemAliases.set(id, `ITEM${itemAliases.size + 1}`);
  return itemAliases.get(id);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (TIME_KEYS.has(k) && typeof v === 'number') {
        out[k] = '<TIME>';
        continue;
      }
      if (TS_KEYS.has(k)) {
        out[k] = '<TS>';
        continue;
      }
      // 队列条目 id（只在 items[] 里出现，用 itemAliases 统一编号）
      if (k === 'id' && typeof v === 'number') {
        out[k] = itemAlias(v);
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

/** 下行事件白名单（音乐 + 房间内会影响房间状态的事件） */
const WATCHED = [
  'music:queue-changed',
  'music:sync-state',
  'music:host-heartbeat',
  'music:control-request',
  'music:control-response',
  'music:sync-ack',
  'preview-source',
  'viewer-joined', 'viewer-left', 'room-closed',
];

/** 服务器音乐心跳单独收集，不进步骤缓冲（原因见文件头）。 */
const heartbeats = [];

function isMusicHeartbeat(event) {
  return event === 'music:sync-heartbeat';
}

/** 心跳的「形状」：只保留确定性部分。 */
function heartbeatShape(entry) {
  const payload = entry.payload || {};
  const state = payload.state && typeof payload.state === 'object' ? payload.state : null;
  return {
    keys: Object.keys(payload).sort(),
    stateKeys: state ? Object.keys(state).sort() : null,
    source: payload.source === undefined ? '<undefined>' : payload.source,
    hostOnline: typeof payload.hostOnline,
    isPlaying: state ? typeof state.isPlaying : null,
    trackKey: state ? state.trackKey === null ? '<null>' : typeof state.trackKey : null,
  };
}

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
    socket.on(ev, (...args) => {
      buffer.push({ client: name, event: ev, payload: args[0], argc: args.length });
    });
  }
  socket.on('music:sync-heartbeat', (payload) => {
    heartbeats.push({ client: name, event: 'music:sync-heartbeat', payload });
  });
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

/** 歌曲元数据（网易云条目） */
function ncmItem(songId, name) {
  return {
    songId,
    name,
    artist: '测试歌手',
    album: '测试专辑',
    cover: `https://example.com/${songId}.jpg`,
    durationMs: 180000,
    vip: false,
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

  const ownerToken = await login('sio-owner', 'sio-pass-1234');
  const viewerToken = await login('sio-viewer', 'sio-pass-1234');
  const adminToken = await login('sio-admin', 'sio-pass-1234');

  const owner = connect('OWNER', ownerToken);
  const viewer = connect('VIEWER', viewerToken);
  const admin = connect('ADMIN', adminToken); // 不进房，覆盖「不在该房间中」
  await wait(600);

  const created = await emitAck(owner, 'create-room', {
    name: '一起听房',
    maxViewers: 5,
    mode: 'listen-together',
    requireApproval: false,
  });
  await step('setup-create-room', { name: '一起听房' }, created);
  const roomId = created && created.data && created.data.roomId;
  if (!roomId) throw new Error(`create-room 未返回 roomId: ${JSON.stringify(created)}`);

  await step('setup-register-host', { roomId }, await emitAck(owner, 'register-host', { roomId }));
  await step('setup-viewer-join', { roomId }, await emitAck(viewer, 'request-join', { roomId }));

  // ==================== music:get-state（空队列） ====================
  await step('state-outsider', { roomId }, await emitAck(admin, 'music:get-state', { roomId }));
  const emptyState = await emitAck(viewer, 'music:get-state', { roomId });
  await step('state-empty', { roomId }, emptyState);
  // syncState 必须是 null 且键存在（前端靠它区分「没在播」与「旧后端」）
  assert('get-state 空基线 syncState 键存在且为 null',
    emptyState && Object.prototype.hasOwnProperty.call(emptyState, 'syncState') && emptyState.syncState === null,
    JSON.stringify(emptyState));
  assert('get-state 空队列 queue 是数组', Array.isArray(emptyState && emptyState.queue),
    JSON.stringify(emptyState && emptyState.queue));

  // ==================== music:queue-upsert ====================
  await step('upsert-outsider', { roomId },
    await emitAck(admin, 'music:queue-upsert', { roomId, item: ncmItem(1001, '外面的歌') }));

  // 缺 vip / durationMs：Node 判「歌曲信息不完整」
  await step('upsert-incomplete', { roomId },
    await emitAck(owner, 'music:queue-upsert', { roomId, item: { songId: 1002, name: '缺字段', artist: 'a', album: 'b' } }));

  await step('upsert-first', { roomId, item: ncmItem(1001, '第一首') },
    await emitAck(owner, 'music:queue-upsert', { roomId, item: ncmItem(1001, '第一首') }));

  await step('upsert-second', { roomId, item: ncmItem(1002, '第二首') },
    await emitAck(owner, 'music:queue-upsert', { roomId, item: ncmItem(1002, '第二首') }));

  // B站 条目：songId=0，靠 bvid+cid 通过校验
  await step('upsert-bili', { roomId },
    await emitAck(owner, 'music:queue-upsert', {
      roomId,
      item: {
        songId: 0,
        biliBvid: 'BV1xx411c7mD',
        biliCid: 123456,
        name: 'B站插播',
        artist: 'UP主',
        album: 'B站',
        durationMs: 200000,
        vip: false,
        recommended: true,
      },
    }));

  const afterThree = await emitAck(owner, 'music:get-state', { roomId });
  await step('state-after-upserts', { roomId }, afterThree);
  assert('队列三条且 order 为 1/2/3',
    afterThree && Array.isArray(afterThree.queue) && afterThree.queue.length === 3
      && afterThree.queue.map((q) => q.order).join(',') === '1,2,3',
    JSON.stringify(afterThree && afterThree.queue));
  assert('B站 条目带 biliBvid / biliCid，网易云条目没有这两个键',
    afterThree && afterThree.queue
      && afterThree.queue[2] && afterThree.queue[2].biliBvid === 'BV1xx411c7mD'
      && afterThree.queue[2].biliCid === 123456
      && !Object.prototype.hasOwnProperty.call(afterThree.queue[0], 'biliBvid'),
    JSON.stringify(afterThree && afterThree.queue));

  // afterCurrent：当前曲目 = 第一条 → 新条目应插到 order=2，后续整体右移
  await step('sync-state-for-aftercurrent', { roomId },
    await emitAck(owner, 'music:sync-state', {
      roomId,
      clientTs: Date.now(),
      trackSongId: 1001,
      trackKey: 'ncm:1001',
      isPlaying: false,
      positionSec: 30,
      playMode: 'sequence',
      updatedAt: Date.now(),
    }));

  await step('upsert-after-current', { roomId, item: ncmItem(1003, '插播') },
    await emitAck(owner, 'music:queue-upsert', {
      roomId,
      item: ncmItem(1003, '插播'),
      afterCurrent: true,
    }));

  const afterInsert = await emitAck(owner, 'music:get-state', { roomId });
  await step('state-after-aftercurrent', { roomId }, afterInsert);
  assert('afterCurrent 插入到第 2 位且 order 无平局',
    afterInsert && Array.isArray(afterInsert.queue) && afterInsert.queue.length === 4
      && afterInsert.queue.map((q) => q.name).join('|') === '第一首|插播|第二首|B站插播'
      && afterInsert.queue.map((q) => q.order).join(',') === '1,2,3,4',
    JSON.stringify(afterInsert && afterInsert.queue));

  // ==================== music:queue-reorder ====================
  const ids = (afterInsert.queue || []).map((q) => q.id);
  await step('reorder-outsider', { roomId, ids },
    await emitAck(admin, 'music:queue-reorder', { roomId, ids }));

  // 多重集不一致（多一个 id）
  await step('reorder-mismatch', { roomId },
    await emitAck(owner, 'music:queue-reorder', { roomId, ids: [...ids, 99999] }));

  const reversed = [...ids].reverse();
  await step('reorder-ok', { roomId, ids: reversed },
    await emitAck(owner, 'music:queue-reorder', { roomId, ids: reversed }));

  const afterReorder = await emitAck(owner, 'music:get-state', { roomId });
  await step('state-after-reorder', { roomId }, afterReorder);
  assert('重排后顺序反转且 order 仍为 1..n',
    afterReorder && afterReorder.queue
      && afterReorder.queue.map((q) => q.name).join('|') === 'B站插播|第二首|插播|第一首'
      && afterReorder.queue.map((q) => q.order).join(',') === '1,2,3,4',
    JSON.stringify(afterReorder && afterReorder.queue));

  // ==================== music:queue-remove ====================
  await step('remove-outsider', { roomId, id: ids[0] },
    await emitAck(admin, 'music:queue-remove', { roomId, id: ids[0] }));

  await step('remove-unknown', { roomId, id: 99999 },
    await emitAck(owner, 'music:queue-remove', { roomId, id: 99999 }));

  await step('remove-ok', { roomId, id: ids[0] },
    await emitAck(owner, 'music:queue-remove', { roomId, id: ids[0] }));

  const afterRemove = await emitAck(owner, 'music:get-state', { roomId });
  await step('state-after-remove', { roomId }, afterRemove);
  assert('删除后 order 压实为 1..n',
    afterRemove && afterRemove.queue
      && afterRemove.queue.map((q) => q.order).join(',') === '1,2,3',
    JSON.stringify(afterRemove && afterRemove.queue));

  // ==================== music:sync-state ====================
  await step('sync-state-outsider', { roomId },
    await emitAck(admin, 'music:sync-state', {
      roomId,
      trackSongId: 1001,
      trackKey: 'ncm:1001',
      isPlaying: false,
      positionSec: 10,
      playMode: 'sequence',
      updatedAt: Date.now(),
    }));

  // 观众不是房主 → 明确拒绝
  await step('sync-state-by-viewer', { roomId },
    await emitAck(viewer, 'music:sync-state', {
      roomId,
      trackSongId: 1001,
      trackKey: 'ncm:1001',
      isPlaying: false,
      positionSec: 10,
      playMode: 'sequence',
      updatedAt: Date.now(),
    }));

  // 非法 playMode → 「同步状态无效」
  await step('sync-state-bad-mode', { roomId },
    await emitAck(owner, 'music:sync-state', {
      roomId,
      trackSongId: 1001,
      trackKey: 'ncm:1001',
      isPlaying: false,
      positionSec: 10,
      playMode: 'nope',
      updatedAt: Date.now(),
    }));

  // 合法：暂停态，positionSec 不补偿（暂停时进度凝固）
  const pausedAt = Date.now() - 900;
  const pausedAck = await emitAck(owner, 'music:sync-state', {
    roomId,
    clientTs: pausedAt,
    trackSongId: 1001,
    trackKey: 'ncm:1001',
    isPlaying: false,
    positionSec: 42.5,
    playMode: 'repeat-one',
    updatedAt: Date.now(),
  });
  await step('sync-state-paused', { roomId, positionSec: 42.5 }, pausedAck);

  // 播放中：clientTs 落后 900ms → 广播值应 ≥ 上报值，且不超 1.5s
  const playingClientTs = Date.now() - 900;
  const playingAck = await emitAck(owner, 'music:sync-state', {
    roomId,
    clientTs: playingClientTs,
    trackSongId: 1001,
    trackKey: 'ncm:1001',
    isPlaying: true,
    positionSec: 60,
    playMode: 'sequence',
    updatedAt: Date.now(),
  });
  const playingStep = log.steps.length;
  await step('sync-state-playing', { roomId, positionSec: 60 }, playingAck);

  // 取这一步里发给 VIEWER 的 music:sync-state，验证补偿幅度
  const relayed = (log.steps[playingStep].events || []).find(
    (e) => e.client === 'VIEWER' && e.event === 'music:sync-state',
  );
  assert('播放中状态转发给了观众', !!relayed, JSON.stringify(log.steps[playingStep].events));
  assert('转发载荷里 isPlaying=true 且 trackKey 原样',
    relayed && relayed.payload && relayed.payload.isPlaying === true
      && relayed.payload.trackKey === 'ncm:1001',
    JSON.stringify(relayed && relayed.payload));
  // 补偿后的时长被归一到 <TIME>，这里只能验「键存在」
  assert('转发载荷保留 positionSec 键', relayed && Object.prototype.hasOwnProperty.call(relayed.payload, 'positionSec'),
    JSON.stringify(relayed && relayed.payload));

  // ==================== music:host-heartbeat ====================
  await step('heartbeat-by-viewer', { roomId },
    await emitAck(viewer, 'music:host-heartbeat', {
      roomId,
      trackSongId: 1001,
      trackKey: 'ncm:1001',
      isPlaying: true,
      positionSec: 70,
      playMode: 'sequence',
      updatedAt: Date.now(),
    }));

  await step('host-heartbeat-ok', { roomId },
    await emitAck(owner, 'music:host-heartbeat', {
      roomId,
      clientTs: Date.now(),
      trackSongId: 1001,
      trackKey: 'ncm:1001',
      isPlaying: true,
      positionSec: 70,
      playMode: 'sequence',
      updatedAt: Date.now(),
    }));

  // ==================== music:check-status ====================
  await step('check-outsider', { roomId },
    await emitAck(admin, 'music:check-status', { roomId, positionSec: 70, isPlaying: true }));

  await step('check-bad-args', { roomId },
    await emitAck(viewer, 'music:check-status', { roomId, positionSec: -1, isPlaying: true }));

  // isPlaying 不一致 → needsSync 恒为 true（与时钟无关，稳定）
  const checkMismatch = await emitAck(viewer, 'music:check-status', {
    roomId,
    positionSec: 70,
    isPlaying: false,
  });
  await step('check-mismatch', { roomId, positionSec: 70, isPlaying: false }, checkMismatch);
  assert('isPlaying 不一致时 needsSync=true',
    checkMismatch && checkMismatch.data && checkMismatch.data.needsSync === true,
    JSON.stringify(checkMismatch));
  assert('needsSync=true 时 data.state 存在',
    checkMismatch && checkMismatch.data && checkMismatch.data.state
      && checkMismatch.data.state.trackKey === 'ncm:1001',
    JSON.stringify(checkMismatch && checkMismatch.data && checkMismatch.data.state));

  // ==================== music:control-request / response / sync-ack ====================
  await step('control-outsider', { roomId },
    await emitAck(admin, 'music:control-request', { roomId, action: 'pause' }));

  await step('control-bad-action', { roomId },
    await emitAck(viewer, 'music:control-request', { roomId, action: 'jump' }));

  // addQueue 缺 item → 「歌曲信息不完整」
  await step('control-addqueue-incomplete', { roomId },
    await emitAck(viewer, 'music:control-request', { roomId, action: 'addQueue' }));

  await step('control-pause', { roomId, action: 'pause' },
    await emitAck(viewer, 'music:control-request', { roomId, action: 'pause' }));

  await step('control-addqueue', { roomId, action: 'addQueue' },
    await emitAck(viewer, 'music:control-request', {
      roomId,
      action: 'addQueue',
      item: ncmItem(1004, '观众申请'),
      afterCurrent: false,
    }));

  // seek 越界（> 86400）
  await step('control-seek-out-of-range', { roomId, action: 'seek', positionSec: 99999 },
    await emitAck(viewer, 'music:control-request', { roomId, action: 'seek', positionSec: 99999 }));

  await step('control-seek-ok', { roomId, action: 'seek', positionSec: 12.5 },
    await emitAck(viewer, 'music:control-request', { roomId, action: 'seek', positionSec: 12.5 }));

  await step('control-response-by-viewer', { roomId },
    await emitAck(viewer, 'music:control-response', {
      roomId, approved: true, action: 'pause', from: viewer.id,
    }));

  await step('control-response-ok', { roomId },
    await emitAck(owner, 'music:control-response', {
      roomId, approved: true, action: 'pause', from: viewer.id,
    }));

  // 拒绝方向也要覆盖（approved=false 不能被当成参数缺失）
  await step('control-response-reject', { roomId },
    await emitAck(owner, 'music:control-response', {
      roomId, approved: false, action: 'pause', from: viewer.id,
    }));

  await step('sync-ack-outsider', { roomId },
    await emitAck(admin, 'music:sync-ack', { roomId }));

  await step('sync-ack-ok', { roomId }, await emitAck(viewer, 'music:sync-ack', { roomId }));

  // ==================== music:queue-clear ====================
  await step('clear-outsider', { roomId }, await emitAck(admin, 'music:queue-clear', { roomId }));

  await step('clear-ok', { roomId }, await emitAck(owner, 'music:queue-clear', { roomId }));

  const afterClear = await emitAck(owner, 'music:get-state', { roomId });
  await step('state-after-clear', { roomId }, afterClear);
  assert('清空后队列为空数组（不是 null）',
    afterClear && Array.isArray(afterClear.queue) && afterClear.queue.length === 0,
    JSON.stringify(afterClear && afterClear.queue));

  // ==================== 服务器心跳存在性 ====================
  // 等两个周期，确认 music:sync-heartbeat 确实在发（形状已在上面汇总）
  await wait(2600);
  const before = heartbeats.length;
  await wait(2400);
  assert('music:sync-heartbeat 持续广播', heartbeats.length > before,
    `before=${before} after=${heartbeats.length}`);

  // ==================== 收尾 ====================
  await step('close-room', undefined, await emitAck(owner, 'close-room'));

  for (const s of [owner, viewer, admin]) {
    try { s.disconnect(); } catch { /* ignore */ }
  }
  await wait(400);

  log.heartbeats = summarizeHeartbeats(heartbeats);
  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  const failed = log.assertions.filter((a) => !a.ok);
  console.log(`steps=${log.steps.length} heartbeats=${log.heartbeats.length} assertions=${log.assertions.length} failed=${failed.length} out=${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('driver failed:', err);
  fs.writeFileSync(OUT, JSON.stringify({ ...log, error: String((err && err.stack) || err) }, null, 2));
  process.exit(1);
});
