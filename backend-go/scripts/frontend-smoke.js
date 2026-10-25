#!/usr/bin/env node
/**
 * 前端全链路冒烟（阶段 5 检查单第 4 项）。
 *
 * 用真实 Chromium 打开 Go 后端托管的前端产物，逐页检查「页面能出来、控制台干净」：
 *   /            首页（匿名）
 *   /login       登录页（匿名）
 *   /admin       未登录应被引导走（不能白屏、不能直接渲染管理页）
 *   /rooms       登录后房间列表
 *   /admin       登录后管理页
 *   /profile     个人中心
 *   /room/:id    房间页（含 socket 握手，最容易暴露实时层问题）
 *
 * 断言口径刻意选「控制台零 error + 页面锚点文案」：不依赖脆弱的 DOM 结构，
 * 又能抓住「接口 404/500 导致白屏」「socket 连不上」「资源 404」这类真回归。
 *
 * 用法：node frontend-smoke.js <baseUrl> <adminUser> <adminPass> <roomId>
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

/**
 * 找本机已装的 Chromium。
 *
 * @playwright/test 自带的版本号可能与本机缓存里的目录不一致（1.62 想要 1234，
 * 机器上装的可能是 1243），此时 npx 会要求重新下载。这里直接扫缓存目录里
 * 版本号最大的那份，用 executablePath 显式指定——回归脚本不该强依赖联网下载。
 */
function findChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  const candidates = [
    path.join('chrome-win64', 'chrome.exe'),
    path.join('chrome-win', 'chrome.exe'),
    path.join('chrome-linux', 'chrome'),
    path.join('chrome-linux64', 'chrome'),
    path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
    } catch {
      continue;
    }
    for (const dir of dirs) {
      for (const rel of candidates) {
        const full = path.join(root, dir, rel);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const ADMIN_USER = process.argv[3] || 'fe-admin';
const ADMIN_PASS = process.argv[4] || 'fe-admin-pass';
const ROOM_ID = process.argv[5] || 'FESMOKE1';

const errors = [];
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
}

async function visit(page, path, label) {
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 });
  // 给 store 初始化 / socket 握手留一点时间，避免「刚挂载就断言」
  await page.waitForTimeout(800);
  return label;
}

async function main() {
  const executablePath = findChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  console.log(`  · Chromium: ${executablePath || '(默认路径)'}`);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text().slice(0, 300)}`);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) badResponses.push(`${resp.status()} ${new URL(resp.url()).pathname}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${String(err.message).slice(0, 300)}`));
  page.on('requestfailed', (req) => {
    const reason = req.failure() ? req.failure().errorText : 'failed';
    errors.push(`[requestfailed] ${req.url()} ${reason}`);
  });

  // ---- 匿名页面 ----
  await visit(page, '/', 'home');
  const homeText = await page.textContent('body');
  record(
    '首页渲染出 ZViewer 文案',
    (homeText || '').includes('ZViewer'),
    `正文摘要=${JSON.stringify((homeText || '').replace(/\s+/g, ' ').slice(0, 160))} 4xx=${badResponses.join(',') || '无'}`,
  );

  await visit(page, '/login', 'login');
  const hasPassword = await page.locator('input[type="password"]').count();
  record('登录页有密码输入框', hasPassword > 0, `password input = ${hasPassword}`);

  await visit(page, '/admin', 'admin-anon');
  const anonAdminText = await page.textContent('body');
  record(
    '未登录访问 /admin 不会落到管理页',
    !(anonAdminText || '').includes('管理页面'),
    '匿名下渲染了管理页面（鉴权重定向失效）',
  );

  // ---- 登录（cookie 与浏览器上下文共享，等价于 UI 登录后的状态）----
  const loginResp = await context.request.post(`${BASE}/api/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  record('API 登录成功（cookie 已写入上下文）', loginResp.status() === 200, `status=${loginResp.status()}`);
  const loginBody = await loginResp.json().catch(() => ({}));
  record('登录返回 accessToken', typeof loginBody.accessToken === 'string', JSON.stringify(loginBody).slice(0, 200));

  // 明文 HTTP 下两侧都**不写 cookie**（见 auth/cookie.go#SetAuthCookies 与
  // middleware/auth.ts#setAuthCookies 的注释：SameSite=None 必须配 Secure，
  // HTTP 写进去只会留下半失效的 cookie）。前端因此把 token 放 localStorage，
  // 由 authTransport 统一附加 Authorization / socket auth.token。
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([access, refresh]) => {
      localStorage.setItem('zviewer-access-token', access);
      localStorage.setItem('zviewer-refresh-token', refresh);
    },
    [loginBody.accessToken || '', loginBody.refreshToken || ''],
  );
  const stored = await page.evaluate(() => localStorage.getItem('zviewer-access-token') || '');
  record('token 已写入 localStorage（HTTP 模式的鉴权载体）', stored === loginBody.accessToken, 'localStorage 未写入');

  // ---- 登录后页面 ----
  await visit(page, '/rooms', 'rooms');
  const roomsText = await page.textContent('body');
  record('房间列表页渲染', (roomsText || '').includes('房间'), '未找到「房间」文案');

  await visit(page, '/admin', 'admin');
  const adminText = await page.textContent('body');
  record(
    '管理页渲染',
    (adminText || '').includes('管理页面'),
    `当前 URL=${page.url()} 正文摘要=${JSON.stringify((adminText || '').replace(/\s+/g, ' ').slice(0, 200))}`,
  );

  await visit(page, '/profile', 'profile');
  const profileText = await page.textContent('body');
  record('个人中心渲染', (profileText || '').length > 0 && !(profileText || '').includes('404'), '页面为空');

  // ---- 房间页：实时层最容易出问题 ----
  await visit(page, `/room/${ROOM_ID}`, 'room');
  const roomText = await page.textContent('body');
  record('房间页渲染', (roomText || '').length > 0, '页面为空');

  // ---- 资源与接口：确认没有 404 的 API 或静态资源 ----
  badResponses.length = 0;
  await visit(page, '/', 'home-again');
  record(
    '二次进首页没有 4xx/5xx 请求',
    badResponses.length === 0,
    badResponses.slice(0, 6).join(', '),
  );

  const realErrors = errors.filter(
    (e) =>
      // 未登录时的 401 是正常流程（AuthInitializer 会去刷新/跳登录），不算回归
      !/\b401\b/.test(e) &&
      // 浏览器扩展/字体探测类的噪声
      !/favicon|net::ERR_BLOCKED_BY_CLIENT|Download the React DevTools/.test(e) &&
      // 前端在页面卸载时用 keepalive 上报控制台日志，浏览器会主动中断这条请求
      // （ERR_ABORTED）；这是预期行为，端点本身由 clientlogs 的测试覆盖
      !(/\/api\/client-logs .*ERR_ABORTED/.test(e)) &&
      // 本地 CLI 代理（可选的 ZViewer CLI，默认 127.0.0.1:9333）没跑时探测必然失败，
      // 与后端无关；桌面端有 CLI 时这条才会连上
      !/127\.0\.0\.1:9333\/health/.test(e) &&
      // 上面那条被拦掉之后，浏览器还会补一条不带 URL 的 console error。
      // 这里只放过这条通配文案：任何**别的**连接失败都会以 [requestfailed] <url>
      // 的形式留着（见上面的 requestfailed 监听），灵敏度不丢。
      !/^\[console\] Failed to load resource: net::ERR_CONNECTION_REFUSED$/.test(e),
  );
  record('控制台无 error', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  if (failed === 0) {
    console.log(`✓ ${results.length} 项前端冒烟全部通过`);
    process.exit(0);
  }
  console.log(`✗ ${failed} / ${results.length} 项失败`);
  process.exit(1);
}

main().catch((err) => {
  console.error('driver error:', err);
  process.exit(1);
});
