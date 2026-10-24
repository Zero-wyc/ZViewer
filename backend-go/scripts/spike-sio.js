#!/usr/bin/env node
/**
 * Socket.IO 协议层验证：用**真实的** socket.io-client@4.8.3 连接 Go 侧 internal/sio。
 *
 * 这比自写轮询客户端可信得多——前端的 socket.io-client 对线上格式一点不宽容，
 * 一个字节不对就是「连不上」或「事件静默丢弃」，而后者不会报任何错。
 *
 * 用法：node spike-sio.js [http://127.0.0.1:3411]
 * 退出码 = 失败项数。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { io } = require(path.join(ROOT, 'node_modules', 'socket.io-client'));

const baseURL = process.argv[2] || 'http://127.0.0.1:3411';
const TOKEN = 'spike-token';

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.log('  ✗ ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(opts = {}) {
  return io(baseURL, {
    auth: { token: TOKEN },
    reconnection: false,
    timeout: 8000,
    ...opts,
  });
}

/** 等一个事件；多参数时返回数组，单参数返回值本身。 */
function once(sock, event) {
  return new Promise((res) => {
    sock.once(event, (...args) => res(args.length > 1 ? args : args[0]));
  });
}

async function connect(opts = {}) {
  const sock = makeClient(opts);
  const outcome = await Promise.race([
    once(sock, 'connect').then(() => ({ ok: true })),
    once(sock, 'connect_error').then((e) => ({ ok: false, msg: e && e.message })),
    sleep(8000).then(() => ({ ok: false, msg: '连接超时' })),
  ]);
  if (!outcome.ok) {
    sock.close();
    throw new Error('连接失败: ' + outcome.msg);
  }
  return sock;
}

/** 带超时的 ack 调用。 */
function ack(sock, event, ...args) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(event + ' 的 ack 超时')), 6000);
    sock.emit(event, ...args, (...vals) => {
      clearTimeout(t);
      res(vals.length > 1 ? vals : vals[0]);
    });
  });
}

async function waitTransport(sock, name, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const tr = sock.io && sock.io.engine && sock.io.engine.transport;
    if (tr && tr.name === name) {
      return true;
    }
    await sleep(20);
  }
  const tr = sock.io && sock.io.engine && sock.io.engine.transport;
  return tr && tr.name === name;
}

async function main() {
  console.log('=== 1. 传输形态 ===');

  const def = await connect();
  const upgraded = await waitTransport(def, 'websocket');
  assert('默认（polling 起步）自动升级到 websocket', upgraded, def.io.engine.transport.name);
  def.close();

  const polling = await connect({ transports: ['polling'], upgrade: false });
  assert(
    '强制 polling 时传输保持 polling',
    polling.io.engine.transport.name === 'polling',
    polling.io.engine.transport.name,
  );
  polling.close();

  const wsOnly = await connect({ transports: ['websocket'] });
  assert(
    '直连 websocket（跳过轮询握手）',
    wsOnly.io.engine.transport.name === 'websocket',
    wsOnly.io.engine.transport.name,
  );
  wsOnly.close();

  console.log('=== 2. 连接与鉴权 ===');

  const s = await connect();
  const who = await ack(s, 'whoami');
  assert('socket.id 与握手 sid 一致', Array.isArray(who) && who[0] === s.id, who && who[0]);
  assert('鉴权填充的 socket.data 可用', Array.isArray(who) && who[1] === 42, who && who[1]);

  const bad = io(baseURL, { auth: {}, reconnection: false, timeout: 5000 });
  const badErr = await Promise.race([once(bad, 'connect_error'), sleep(6000).then(() => null)]);
  assert(
    '缺少令牌时收到 connect_error',
    badErr && badErr.message === '未提供认证令牌',
    badErr && badErr.message,
  );
  bad.close();

  console.log('=== 3. 事件与 ack ===');

  const echoed = await ack(s, 'echo', { a: 1, b: ['x', null, true] });
  assert(
    'ack 回传载荷逐字段一致',
    JSON.stringify(echoed) === JSON.stringify({ a: 1, b: ['x', null, true] }),
    JSON.stringify(echoed),
  );

  const multi = await ack(s, 'echo', 1, 'two', { three: 3 });
  assert(
    '多参数 ack 按位置返回',
    Array.isArray(multi) && multi.length === 3 && multi[0] === 1 && multi[1] === 'two',
    JSON.stringify(multi),
  );

  // 服务端 → 客户端 ack
  const ackResult = new Promise((res) => s.once('ack-result', res));
  s.on('ask-client', (prompt, cb) => cb('client-pong:' + prompt));
  await ack(s, 'ask-client', 'ping');
  assert('服务端发起 ack，客户端回执可解析', (await ackResult) === 'client-pong:ping');

  console.log('=== 4. 房间与广播 ===');

  const a = await connect();
  const b = await connect();
  await ack(a, 'join', 'r1');
  await ack(b, 'join', 'r1');

  let aGot = null;
  let bGot = null;
  a.on('room-msg', (m) => {
    aGot = m;
  });
  b.on('room-msg', (m) => {
    bGot = m;
  });

  await ack(a, 'broadcast', 'r1', 'to-others');
  await sleep(250);
  assert(
    'socket.to(room) 只发给他人',
    bGot === 'to-others' && aGot === null,
    `a=${JSON.stringify(aGot)} b=${JSON.stringify(bGot)}`,
  );

  aGot = null;
  bGot = null;
  await ack(a, 'broadcast-all', 'r1', 'to-all');
  await sleep(250);
  assert(
    'io.to(room) 发给房间内所有人',
    aGot === 'to-all' && bGot === 'to-all',
    `a=${JSON.stringify(aGot)} b=${JSON.stringify(bGot)}`,
  );

  const c = await connect();
  let cGot = null;
  c.on('room-msg', (m) => {
    cGot = m;
  });
  await ack(a, 'broadcast-all', 'r1', 'again');
  await sleep(250);
  assert('未加入房间的连接收不到', cGot === null, JSON.stringify(cGot));
  c.close();
  a.close();
  b.close();

  console.log('=== 5. 大载荷 ===');

  const upBig = 'x'.repeat(5 * 1024 * 1024);
  const upLen = await ack(s, 'big', upBig);
  assert('5MB 上行载荷完整送达', upLen === upBig.length, upLen);

  const downBig = new Promise((res) => s.once('big-down', (v) => res(v)));
  await ack(s, 'please-big-down', 3 * 1024 * 1024);
  const down = await Promise.race([downBig, sleep(6000).then(() => null)]);
  assert('3MB 下行载荷完整送达', down && down.length === 3 * 1024 * 1024, down && down.length);

  console.log('=== 6. 断线与保活 ===');

  const clientGone = new Promise((res) => s.once('disconnect', res));
  s.disconnect();
  assert('客户端主动断开', (await clientGone) === 'io client disconnect');

  const k = await connect();
  const kicked = new Promise((res) => k.once('disconnect', res));
  await ack(k, 'kick');
  const kickReason = await Promise.race([kicked, sleep(5000).then(() => null)]);
  assert('服务端主动断开', kickReason === 'io server disconnect', kickReason);
  k.close();

  // 心跳：超过一个 pingInterval(2s) 仍在线
  const hb = await connect({ transports: ['websocket'] });
  await sleep(4500);
  assert('心跳保活 4.5s 不断线', hb.connected === true, hb.connected);
  hb.close();

  console.log('');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  return failed;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('验证过程异常:', err);
    process.exit(1);
  });
