/**
 * Socket 上行事件对账（契约快照 + Go 静态扫描比对）。
 *
 * 背景：Node 侧 65 个上行业务事件不是写在常量表里，而是各 Handler 在
 * `register(socket, io)` 里挨个 `socket.on('name', ...)`。所以静态抓源码会
 * 混进进程信号（SIGINT/SIGTERM）、流事件（close/data/end）、NMS 回调
 * （prePublish/postPublish）、以及 EventEmitter 的 error/finish 之类噪声。
 *
 * 这里改用**运行时harness**：拿生产同一份 `createSocketRegistry()`，用一个会记账
 * 的假 socket 调 `registerAll()`，凡是被 `.on()` 挂上去的名字就是真实上行事件。
 *
 * 两个模式：
 *   node event-audit.js --snapshot backend-go/testdata/contract/events.json
 *   node event-audit.js --fixture  backend-go/testdata/contract/events.json
 *
 * 第二个模式只比对「契约快照 vs Go 源码里的 sc.On("...")」，**不需要 Node 后端**
 * （只读 JSON + 读 Go 源码），backend/ 删掉之后依然可跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(REPO, 'backend');
const GO_ROOM = path.join(REPO, 'backend-go', 'internal', 'room');
const NEWLINE = String.fromCharCode(10);
const FIXTURE_VERSION = 1;

// socket.io 框架级事件：两侧都不走「业务上行事件」这条路——
// Node 用 `socket.on('disconnect')`，Go 用 `sc.OnDisconnect(...)`。
// 因此它们单独登记在快照的 lifecycle 字段里，不参与「业务事件缺失」比对；
// 比对时改为检查 Go 源码里有没有 OnDisconnect。
const LIFECYCLE = new Set(['connection', 'disconnect', 'disconnecting']);

// ---------------------------------------------------------------------------
// Node 侧：运行时 harness
// ---------------------------------------------------------------------------

function collectNodeEvents() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  const tmp = path.join(require('node:os').tmpdir(), 'zv-event-audit');
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = path.join(tmp, 'audit.sqlite');
  if (!process.env.CONFIG_DIR) process.env.CONFIG_DIR = tmp;

  require('ts-node').register({
    transpileOnly: true,
    project: path.join(BACKEND, 'tsconfig.json'),
  });

  const { createSocketRegistry } = require(path.join(BACKEND, 'src', 'modules', 'socket', 'register-handlers.ts'));

  const listeners = new Map(); // event -> [handlerName]
  const current = { name: '<unknown>' };

  // 假 socket：只要能承接 `.on()` 就行。其余成员给最小可用实现——
  // 有的 Handler 在 register 期会读 socket.id / socket.data 或调 join()。
  const FakeSocket = {
    id: 'fake-socket',
    data: {},
    rooms: new Set(['fake-socket']),
    on(name) {
      const list = listeners.get(name) || [];
      list.push(current.name);
      listeners.set(name, list);
      return this;
    },
    once(name) {
      return this.on(name);
    },
    emit() {
      return true;
    },
    to() {
      return { emit() {} };
    },
    join() {},
    leave() {},
    disconnect() {},
  };

  const io = {
    on() {},
    emit() {},
    to() {
      return { emit() {} };
    },
    in() {
      return { emit() {} };
    },
    sockets: { sockets: new Map() },
  };

  const registry = createSocketRegistry();
  const handlers = registry.handlers || [];
  if (!handlers.length) throw new Error('SocketRegistry 里没有 handler，接口可能改名了');

  const failures = [];
  for (const handler of handlers) {
    current.name = handler.name;
    try {
      handler.register(FakeSocket, io);
    } catch (err) {
      failures.push({ handler: handler.name, message: String(err && err.message) });
    }
  }

  const all = [...listeners.keys()].sort();
  const lifecycle = all.filter((e) => LIFECYCLE.has(e));
  const events = all.filter((e) => !LIFECYCLE.has(e));
  return { events, lifecycle, handlers: handlers.map((h) => h.name), failures };
}

// ---------------------------------------------------------------------------
// Go 侧：静态扫描 sc.On("name")
// ---------------------------------------------------------------------------

function collectGoEvents() {
  const files = fs.readdirSync(GO_ROOM).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
  const out = new Map(); // name -> file
  const onRe = /\.On\("([^"]+)"\s*,/;
  // 三条信令是循环注册的：for _, event := range []string{"signal-offer", ...} { sc.On(event, ...) }
  // 只认字面量 .On("x") 会把它们当成「Go 没实现」。但 []string{...} 在本包里
  // 还用来装角色名（isInRoom/isRoomHost…），所以只有当这个字面量后面紧跟
  // `.On(` 时才算事件列表——按行看不够，要往后看几行（循环体在下一行）。
  const listRe = /\[\]string\{([^}]*)\}/;
  const quotedRe = /"([^"]+)"/g;
  let hasOnDisconnect = false;

  for (const file of files) {
    const lines = fs.readFileSync(path.join(GO_ROOM, file), 'utf8').split(NEWLINE);
    if (lines.some((l) => l.includes('OnDisconnect('))) hasOnDisconnect = true;

    lines.forEach((line, i) => {
      const m = onRe.exec(line);
      if (m) out.set(m[1], file);

      const list = listRe.exec(line);
      if (!list) return;
      const window = lines.slice(i, i + 4).join(NEWLINE);
      if (!/\.On\(/.test(window.slice(line.length + 1))) return; // 认领列表之外没有 .On → 不是事件表
      quotedRe.lastIndex = 0;
      let q;
      while ((q = quotedRe.exec(list[1])) !== null) out.set(q[1], file);
    });
  }
  return { events: out, hasOnDisconnect };
}

// ---------------------------------------------------------------------------
// 快照读写
// ---------------------------------------------------------------------------

function resolvePath(file) {
  return path.isAbsolute(file) ? file : path.join(REPO, file);
}

function loadFixture(file) {
  const abs = resolvePath(file);
  if (!fs.existsSync(abs)) throw new Error(`契约快照不存在: ${abs}（先跑 --snapshot 生成）`);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(data.events) || !data.events.length) throw new Error(`快照格式不对（缺 events 数组）: ${abs}`);
  return data;
}

function writeFixture(file, events, lifecycle, handlers) {
  const abs = resolvePath(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const payload = {
    version: FIXTURE_VERSION,
    note:
      'Node 侧 Socket 上行业务事件的冻结快照。由 backend-go/scripts/event-audit.js --snapshot 生成：' +
      '用生产同一份 createSocketRegistry() 在假 socket 上跑 registerAll()，记录被 .on() 挂上的名字。' +
      'backend/ 删除后，event-audit.js --fixture 用它核对 Go 是否仍然逐条注册。' +
      'lifecycle 是 socket.io 框架级事件（disconnect 等），不计入业务事件：Go 用 OnDisconnect 处理。',
    generatedAt: new Date().toISOString(),
    total: events.length,
    lifecycle,
    handlers,
    events,
  };
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + NEWLINE, 'utf8');
  return { abs, total: events.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const snapIdx = argv.indexOf('--snapshot');
  const snapFile = snapIdx >= 0 ? argv[snapIdx + 1] : null;
  const fixIdx = argv.indexOf('--fixture');
  const fixFile = fixIdx >= 0 ? argv[fixIdx + 1] : null;

  if (snapFile) {
    const { events, lifecycle, handlers, failures } = collectNodeEvents();
    const { abs, total } = writeFixture(snapFile, events, lifecycle, handlers);
    console.log(`✓ 事件契约快照已写入 ${abs}`);
    console.log(`  ${handlers.length} 个 handler / ${total} 个上行业务事件`);
    if (lifecycle.length) console.log(`  · 框架级事件（不计入）：${lifecycle.join(', ')}`);
    if (failures.length) {
      console.log(`  ! ${failures.length} 个 handler 在 harness 里注册失败（其事件未能记录）:`);
      for (const f of failures) console.log(`    - ${f.handler}: ${f.message.slice(0, 160)}`);
    }
    return failures.length ? 1 : 0;
  }

  const fixture = fixFile ? loadFixture(fixFile) : null;
  if (!fixture) {
    if (!fs.existsSync(BACKEND)) {
      console.error('backend/ 已不存在，且没给 --fixture。用：');
      console.error('  --fixture backend-go/testdata/contract/events.json');
      return 2;
    }
    // 没给快照也没给 fixture：直接拿 Node 现算（等价于「刚 snapshot 过」）
    const live = collectNodeEvents();
    console.log(`Node 上行事件（运行时采集）: ${live.events.length} 个，${live.handlers.length} 个 handler`);
    return compare(live.events, live.lifecycle, collectGoEvents(), null);
  }

  console.log(`（使用契约快照 ${fixFile}：${fixture.total} 个事件，生成于 ${fixture.generatedAt}）`);
  return compare(fixture.events, fixture.lifecycle || [], collectGoEvents(), fixture);
}

function compare(nodeEvents, lifecycle, go, fixture) {
  const goMap = go.events;
  const nodeSet = new Set(nodeEvents);
  const missing = [...nodeSet].filter((e) => !goMap.has(e)).sort();
  const extra = [...goMap.keys()].filter((e) => !nodeSet.has(e)).sort();

  console.log(`Node 上行业务事件: ${nodeSet.size}`);
  console.log(`Go   已注册事件  : ${goMap.size}`);
  if (lifecycle.length) {
    const ok = go.hasOnDisconnect;
    console.log(`框架级事件       : ${lifecycle.join(', ')} → Go ${ok ? '有 OnDisconnect' : '没有 OnDisconnect（断连清理会丢）'}`);
    if (!ok && lifecycle.includes('disconnect')) missing.push('disconnect(缺 OnDisconnect)');
  }
  console.log('');

  if (missing.length) {
    console.log(`✗ ${missing.length} 个 Node 事件在 Go 侧没有注册（用户点了没反应）:`);
    for (const e of missing) console.log(`   ${e}`);
  }
  if (extra.length) {
    console.log(`· Go 独有 ${extra.length} 个（新增能力或改名后的遗留）:`);
    for (const e of extra) console.log(`   ${e}    〔${goMap.get(e)}〕`);
  }
  if (fixture && Array.isArray(fixture.handlers)) {
    console.log('');
    console.log(`快照包含 ${fixture.handlers.length} 个 handler: ${fixture.handlers.join(', ')}`);
  }
  if (!missing.length) {
    console.log('');
    console.log('✓ Node 的每个上行事件在 Go 侧都有处理器');
  }
  return missing.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { collectNodeEvents, collectGoEvents };
