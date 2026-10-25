#!/usr/bin/env node
/**
 * 压缩版 soak（阶段 5 检查单第 2 项的自动化部分）。
 *
 * 真机 24h 无法在 CI 里跑，这里做的是「同一份代码在高频请求下的短时稳定性」：
 * 固定并发、循环打一批代表性端点（含鉴权、DB 读、静态产物、日志上报），
 * 记录状态码分布与延迟，并检测
 *   - 出现 5xx（除白名单）
 *   - 请求超时
 *   - 吞吐随时间是掉下去（缓存/连接池泄漏的典型表现）
 *
 * 用法：node soak-driver.js <baseUrl> <adminUser> <adminPass> <roomId> <seconds>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const ADMIN_USER = process.argv[3] || 'soak-admin';
const ADMIN_PASS = process.argv[4] || 'soak-admin-pass';
const ROOM_ID = process.argv[5] || 'SOAKROOM1';
const SECONDS = Number(process.argv[6] || 120);
const CONCURRENCY = 4;

// 允许的 5xx：这几个端点在「没配外部服务」时本来就是 503/500，
// 属于部署缺依赖而不是稳定性问题（music 需要外部 NCM 服务）。
const ALLOWED_5XX = [/^\/api\/music\//];

let token = '';
const stats = {
  total: 0,
  byStatus: {},
  failures: [],
  timeouts: 0,
  slowest: [],
  windows: [], // 每 10s 一桶，用来看吞吐有没有衰减
};
const deadline = Date.now() + SECONDS * 1000;
let currentWindow = { start: Date.now(), count: 0, errors: 0 };

const ENDPOINTS = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/api/auth/public-settings' },
  { method: 'GET', path: '/api/auth/registration-mode' },
  { method: 'GET', path: '/api/auth/me', auth: true },
  { method: 'GET', path: '/api/rooms', auth: true },
  { method: 'GET', path: `/api/rooms/${ROOM_ID}/danmaku-tracks`, auth: true },
  { method: 'GET', path: `/api/rooms/${ROOM_ID}/danmaku-meta`, auth: true },
  { method: 'GET', path: '/api/server-files/roots', auth: true },
  { method: 'GET', path: '/api/admin/settings', auth: true },
  // 端点要求 { entries: [...] } 且非空，否则 400
  {
    method: 'POST',
    path: '/api/client-logs',
    body: { entries: [{ level: 'info', message: 'soak heartbeat', source: 'soak' }] },
  },
];

async function login() {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.accessToken) throw new Error(`soak 登录失败: ${resp.status}`);
  token = data.accessToken;
}

async function hit(ep) {
  const headers = {};
  if (ep.auth) headers.Authorization = `Bearer ${token}`;
  if (ep.body) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const started = Date.now();
  try {
    const resp = await fetch(BASE + ep.path, {
      method: ep.method,
      headers,
      body: ep.body ? JSON.stringify(ep.body) : undefined,
      signal: ctrl.signal,
    });
    await resp.text();
    const cost = Date.now() - started;
    stats.total += 1;
    currentWindow.count += 1;
    stats.byStatus[resp.status] = (stats.byStatus[resp.status] || 0) + 1;
    stats.slowest.push({ path: ep.path, cost });
    if (stats.slowest.length > 20) stats.slowest.shift();
    const isAllowed = ALLOWED_5XX.some((re) => re.test(ep.path));
    if (resp.status >= 500 && !isAllowed) {
      currentWindow.errors += 1;
      if (stats.failures.length < 20) stats.failures.push(`${resp.status} ${ep.method} ${ep.path}`);
    }
    return cost;
  } catch (err) {
    stats.total += 1;
    currentWindow.count += 1;
    currentWindow.errors += 1;
    stats.timeouts += 1;
    if (stats.failures.length < 20) {
      stats.failures.push(`ERR ${ep.method} ${ep.path}: ${err && err.name}`);
    }
    return -1;
  } finally {
    clearTimeout(timer);
  }
}

async function worker() {
  while (Date.now() < deadline) {
    const ep = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
    await hit(ep);
    // 每 3 秒重新登录一次，覆盖「token 续签」路径
    if (Math.random() < 0.02) await login().catch(() => {});
  }
}

async function main() {
  await login();
  console.log(`soak: ${SECONDS}s / 并发 ${CONCURRENCY} / ${ENDPOINTS.length} 个端点`);

  const ticker = setInterval(() => {
    stats.windows.push(currentWindow);
    currentWindow = { start: Date.now(), count: 0, errors: 0 };
  }, 10000);

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  clearInterval(ticker);
  stats.windows.push(currentWindow);

  // 结束后再敲一次健康检查：进程要是半死状态，这条会失败
  const health = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);

  const slowest = stats.slowest.sort((a, b) => b.cost - a.cost)[0];
  // 去掉最后一个窗口：施压结束时它往往是截断的（只跑了几百毫秒），
  // 把它算进后半程会让 throughputDrop 假性下降
  const counts = stats.windows.map((w) => w.count).slice(0, -1);
  const firstHalf = counts.slice(0, Math.ceil(counts.length / 2));
  const lastHalf = counts.slice(Math.ceil(counts.length / 2));
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const throughputDrop = avg(firstHalf) > 0 ? avg(lastHalf) / avg(firstHalf) : 1;

  console.log(
    JSON.stringify(
      {
        total: stats.total,
        byStatus: stats.byStatus,
        timeouts: stats.timeouts,
        failures: stats.failures,
        slowest,
        healthAfter: health,
        throughputDrop: Number(throughputDrop.toFixed(2)),
        windows: counts,
      },
      null,
      2,
    ),
  );

  const failed =
    stats.timeouts > 0 ||
    stats.failures.length > 0 ||
    health !== 200 ||
    // 后半程吞吐掉到前半程一半以下 → 疑似泄漏/退化
    throughputDrop < 0.5 ||
    stats.total === 0;
  if (failed) {
    console.log('✗ soak 未通过');
    process.exit(1);
  }
  console.log('✓ soak 通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
