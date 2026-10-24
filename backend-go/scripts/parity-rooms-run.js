#!/usr/bin/env node
/**
 * 房间 REST 对拍驱动器：对某个 base URL 跑一条固定请求序列，输出规范化 JSON。
 *
 * Node 侧（parity-node-rooms.js 起的最小应用）与 Go 侧（真实 zviewer-server）
 * 各跑一遍，输出逐字节对比——顺序、状态码、响应体、事件名都要一致。
 *
 * 「规范化」= 递归按 key 排序后再序列化。Go 的 map 输出按 key 字典序，
 * Node 的对象按插入序，直接比字符串会全是假差异。
 *
 * 用法：node parity-rooms-run.js --base http://127.0.0.1:PORT \
 *          --roomA R1 --roomB R2 --owner rooms-owner --other rooms-other
 */
const results = [];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.base;
  const roomA = args.roomA;
  const roomB = args.roomB;
  if (!base || !roomA || !roomB) {
    process.stderr.write('缺少 --base / --roomA / --roomB\n');
    process.exit(2);
  }

  const login = async (username) => {
    // Node 侧最小应用只挂了 rooms Router，令牌由 /__parity/login 直接签发；
    // Go 侧走真实登录接口。两侧拿到的都是同一用户的等价令牌。
    const probe = await fetch(base + '/__parity/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const body = await probe.json().catch(() => ({}));
    if (body.accessToken) return body.accessToken;

    const real = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: args.password || 'rooms-pass-1234' }),
    });
    const realBody = await real.json().catch(() => ({}));
    if (!realBody.accessToken) {
      throw new Error('登录失败: ' + username + ' ' + JSON.stringify(realBody));
    }
    return realBody.accessToken;
  };

  const owner = await login(args.owner || 'rooms-owner');
  const other = await login(args.other || 'rooms-other');

  const call = async (step, method, url, token, body) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { __raw: text.slice(0, 200) };
    }
    results.push({ step, status: res.status, body: canonical(parsed) });
    return parsed;
  };

  const TRACKS = `/api/rooms/${roomA}/danmaku-tracks`;
  const META = `/api/rooms/${roomA}/danmaku-meta`;
  const trackUrl = (id) => `${TRACKS}/${encodeURIComponent(id)}/offset`;

  // 1. 房间列表：只保留两个种子房间，避免历史数据干扰；同时验证
  //    viewerCount / sharerOnline 的聚合。
  const list = await call('1.列表(root)', 'GET', '/api/rooms', owner);
  const picked = (list.rooms || []).filter((r) => r.roomId === roomA || r.roomId === roomB);
  results.push({ step: '1.列表过滤', status: 200, body: canonical(picked) });

  await call('2.空轨道列表', 'GET', TRACKS, owner);
  await call('3.新增轨道', 'POST', TRACKS, owner, {
    trackId: 'bilibili-video:12345',
    label: 'B站弹幕',
    source: JSON.stringify({ type: 'bilibili', cid: 12345 }),
    items: [
      { time: 1.5, text: '第一条' },
      { time: 2.5, text: '第二条' },
    ],
    offset: 1.5,
  });
  // 同一 trackId 再写一次：必须覆盖而不是新增一条
  await call('4.同trackId覆盖', 'POST', TRACKS, owner, {
    trackId: 'bilibili-video:12345',
    label: 'B站弹幕(改)',
    source: JSON.stringify({ type: 'bilibili', cid: 12345 }),
    items: [{ time: 9, text: '覆盖后' }],
    offset: 3,
    hidden: true,
  });
  await call('5.覆盖后列表', 'GET', TRACKS, owner);
  await call('6.改偏移(只传offset)', 'PUT', trackUrl('bilibili-video:12345'), owner, { offset: 2.25 });
  await call('7.改隐藏(只传hidden)', 'PUT', trackUrl('bilibili-video:12345'), owner, { hidden: false });
  await call('8.改后列表', 'GET', TRACKS, owner);

  // 批量替换：合法条目写入，非法条目跳过
  await call('9.批量替换', 'POST', `${TRACKS}/bulk`, owner, {
    tracks: [
      { trackId: 't-2', label: '轨道二', source: '{"type":"local"}', items: [], offset: 0 },
      { trackId: 't-3', label: '轨道三', source: '{"type":"local"}', items: [{ t: 1 }] },
      { trackId: '', label: '非法', source: '{}', items: [] },
      { trackId: 't-4', label: '缺items', source: '{}' },
    ],
  });
  await call('10.批量后列表', 'GET', TRACKS, owner);
  await call('11.删除轨道', 'DELETE', `${TRACKS}/t-2`, owner);
  await call('12.删除后列表', 'GET', TRACKS, owner);
  // 删除不存在的轨道：Node 是 delete 后照样 200
  await call('13.删除不存在轨道', 'DELETE', `${TRACKS}/nope`, owner);

  await call('14.读弹幕辅助数据', 'GET', META, owner);
  await call('15.写辅助数据(含空串过滤)', 'PUT', META, owner, {
    blockKeywords: ['广告', '', '   ', '刷屏'],
    deletedLog: [{ id: 'd1', content: '被删掉的' }],
  });
  await call('16.再读辅助数据', 'GET', META, owner);
  // 只传 blockKeywords：deletedLog 必须保持原值
  await call('17.只改屏蔽词', 'PUT', META, owner, { blockKeywords: ['仅此一个'] });
  await call('18.终读辅助数据', 'GET', META, owner);

  await call('19.改名(首尾空格应被裁剪)', 'PUT', `/api/rooms/${roomA}/name`, owner, {
    name: '  改名后的房间  ',
  });
  await call('20.改名为空', 'PUT', `/api/rooms/${roomA}/name`, owner, { name: '   ' });
  await call('21.改名房间不存在', 'PUT', '/api/rooms/NoSuchRoom/name', owner, { name: 'x' });

  await call('22.非房主新增轨道', 'POST', TRACKS, other, {
    trackId: 'x',
    label: 'x',
    source: '{}',
    items: [],
  });
  await call('23.无会话读轨道', 'GET', TRACKS, other);
  await call('24.无会话读辅助数据', 'GET', META, other);
  await call('25.不存在的房间读轨道', 'GET', '/api/rooms/NoSuchRoom/danmaku-tracks', owner);
  await call('26.必填缺失', 'POST', TRACKS, owner, { trackId: 'only-id' });
  await call('27.最终轨道列表', 'GET', TRACKS, owner);

  // 注意：这里刻意不比对广播事件。Go 侧实时层未迁移（realtime.Noop 丢弃事件），
  // 事件名与载荷的一致性无法在此阶段对拍，只能由代码评审保证调用点齐全。
  // 事件名常量集中在 internal/realtime，等 socket.io 落地后补端到端验证。

  process.stdout.write(JSON.stringify(results, null, 1) + '\n');
}

main().catch((e) => {
  process.stderr.write('对拍序列失败: ' + e.stack + '\n');
  process.exit(1);
});
