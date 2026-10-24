#!/usr/bin/env node
/**
 * 字幕端点（/api/subtitles/*）—— Node ↔ Go HTTP 对拍驱动器。
 *
 * 覆盖 5 个端点：
 *   GET /search、/browse、/load、/embedded-tracks、/embedded-extract
 *
 * 与 http-serverfiles-driver.js 同构：比「状态码 + 响应体」，规范化只做
 * 「绝对路径 → 占位符」与「时间戳 → <TIME>」两件事。
 *
 * 影片种子由 http-subtitles-parity.sh 直接插库（固定 id），
 * 驱动器只按 id 打请求，不创建任何数据。
 *
 * 用法：node http-subtitles-driver.js <baseUrl> <outFile> <uploadsDir>
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:3333';
const OUT = process.argv[3] || '/tmp/http-subtitles.json';
const UPLOADS = process.argv[4] || '';

const log = { base: BASE, steps: [] };
let rootToken = '';
let viewerToken = '';

/** 把绝对路径与时间戳规范化掉，其余原样保留。 */
function normalize(value) {
  if (typeof value === 'string') {
    let s = value;
    if (UPLOADS) {
      s = s.split(UPLOADS).join('<UPLOADS>');
      s = s.split(UPLOADS.replace(/\//g, '\\')).join('<UPLOADS>');
    }
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TIME>');
    return s;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

/** 排序后序列化，避免键顺序造成的假差异。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

/**
 * /search 的结果顺序不是契约。
 *
 * Node 侧直接 `fs.readdirSync` / `listFTPDirectory` 的原序返回，没有排序；
 * Go 的 os.ReadDir 会按文件名字节序给一遍。两边都是「未定义顺序」，
 * 拿它当差异只会制造噪音，故按 filename 排序后再比较。
 * （/browse 相反：两侧都显式排了序，那个顺序是契约，不能动。）
 */
function sortSubtitles(body) {
  if (body && Array.isArray(body.subtitles)) {
    body.subtitles = body.subtitles
      .slice()
      .sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  }
  return body;
}

async function request(method, path, { token = rootToken } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${BASE}${path}`, { method, headers });
  const text = await resp.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { __raw: text.slice(0, 200) };
    }
  }
  return { status: resp.status, body: sortSubtitles(parsed) };
}

async function step(name, path, options) {
  let result;
  try {
    result = await request('GET', path, options);
  } catch (err) {
    result = { error: String(err && err.message) };
  }
  log.steps.push({ step: name, ...normalize(result) });
  return result;
}

async function login(username, password) {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`login ${username} failed: ${resp.status} ${JSON.stringify(body)}`);
  const token = body.accessToken || (body.data && body.data.accessToken);
  if (!token) throw new Error(`login ${username} 未拿到 accessToken: ${JSON.stringify(body)}`);
  return token;
}

/** 影片种子 id（与脚本里的插库语句一一对应）。 */
const M = {
  serverFiles: 1, // server-files, uploads:/anime/EP01.mkv, 归属 SUBROOM
  bilibili: 2, // bilibili, 无 path
  noPath: 3, // server-files, 无 path
  emby: 4, // emby, path=item-1, 无 serverUrl
  webdav: 5, // webdav, 有 path, 无 serverUrl
  ftp: 6, // ftp, 有 path, 无 serverUrl
  openlist: 7, // openlist, 有 path, 无 serverUrl
  otherRoom: 8, // server-files, 归属 OTHERROOM（viewer 无准入）
  noMatch: 9, // server-files, uploads:/other/EP02.mkv（无同名字幕）
  embyNoPath: 10, // emby, 有 serverUrl 但无 path
};

async function main() {
  rootToken = await login('sio-owner', 'sio-pass-1234');
  viewerToken = await login('sio-viewer', 'sio-pass-1234');

  const enc = encodeURIComponent;
  const q = (movieId) => `/api/subtitles/search?movieId=${movieId}`;

  // ===== 1. 中间件四道门（Node 里是路由级 use，先于 handler）=====
  await step('search-anonymous', q(M.serverFiles), { token: '' });
  await step('search-missing-movieid', '/api/subtitles/search');
  await step('search-nan-movieid', '/api/subtitles/search?movieId=abc');
  // 1.5 不是安全整数 → 「movieId 参数无效」，不是「影片不存在」
  await step('search-float-movieid', '/api/subtitles/search?movieId=1.5');
  await step('search-zero-movieid', '/api/subtitles/search?movieId=0');
  await step('search-negative-movieid', '/api/subtitles/search?movieId=-1');
  await step('search-not-found', q(99999));
  await step('search-forbidden', q(M.otherRoom), { token: viewerToken });

  // ===== 2. search =====
  await step('search-ok', q(M.serverFiles));
  await step('search-no-match', q(M.noMatch));
  await step('search-bilibili', q(M.bilibili));

  // ===== 3. browse =====
  await step('browse-default', `/api/subtitles/browse?movieId=${M.serverFiles}`);
  await step('browse-subdir', `/api/subtitles/browse?movieId=${M.serverFiles}&path=${enc('uploads:/anime/sub')}`);
  await step('browse-uploads-root', `/api/subtitles/browse?movieId=${M.serverFiles}&path=${enc('uploads:/')}`);
  await step('browse-missing-dir', `/api/subtitles/browse?movieId=${M.serverFiles}&path=${enc('uploads:/nope')}`);
  // 传文件路径当目录：返回空列表 + parentPath null（不是错误）
  await step('browse-on-file', `/api/subtitles/browse?movieId=${M.serverFiles}&path=${enc('uploads:/anime/EP01.mkv')}`);
  await step('browse-escape', `/api/subtitles/browse?movieId=${M.serverFiles}&path=${enc('uploads:../x')}`);
  await step('browse-unknown-root', `/api/subtitles/browse?movieId=${M.serverFiles}&path=${enc('custom:9:/')}`);
  await step('browse-bilibili', `/api/subtitles/browse?movieId=${M.bilibili}`);
  await step('browse-no-path', `/api/subtitles/browse?movieId=${M.noPath}`);
  await step('browse-webdav-no-serverurl', `/api/subtitles/browse?movieId=${M.webdav}&path=${enc('/d')}`);
  await step('browse-ftp-no-serverurl', `/api/subtitles/browse?movieId=${M.ftp}&path=${enc('/d')}`);
  await step('browse-openlist-no-serverurl', `/api/subtitles/browse?movieId=${M.openlist}&path=${enc('/d')}`);

  // ===== 4. load =====
  await step('load-ok', `/api/subtitles/load?movieId=${M.serverFiles}&path=${enc('uploads:/anime/EP01.chs.srt')}`);
  await step('load-ass', `/api/subtitles/load?movieId=${M.serverFiles}&path=${enc('uploads:/anime/EP01.ass')}`);
  await step('load-missing-path', `/api/subtitles/load?movieId=${M.serverFiles}`);
  await step('load-blank-path', `/api/subtitles/load?movieId=${M.serverFiles}&path=${enc('   ')}`);
  await step('load-not-found', `/api/subtitles/load?movieId=${M.serverFiles}&path=${enc('uploads:/anime/nope.srt')}`);
  await step('load-directory', `/api/subtitles/load?movieId=${M.serverFiles}&path=${enc('uploads:/anime/sub')}`);
  await step('load-escape', `/api/subtitles/load?movieId=${M.serverFiles}&path=${enc('uploads:../x.srt')}`);
  await step('load-bilibili', `/api/subtitles/load?movieId=${M.bilibili}&path=${enc('/a.srt')}`);
  await step('load-ftp-no-serverurl', `/api/subtitles/load?movieId=${M.ftp}&path=${enc('/d/a.srt')}`);
  await step('load-openlist-no-serverurl', `/api/subtitles/load?movieId=${M.openlist}&path=${enc('/d/a.srt')}`);
  await step('load-webdav-no-serverurl', `/api/subtitles/load?movieId=${M.webdav}&path=${enc('/d/a.srt')}`);

  // ===== 5. 内嵌字幕 =====
  // 非 emby 源：两条文案不同（「探测」/「提取」），不能混用
  await step('tracks-bilibili', `/api/subtitles/embedded-tracks?movieId=${M.bilibili}`);
  await step('tracks-serverfiles', `/api/subtitles/embedded-tracks?movieId=${M.serverFiles}`);
  await step('extract-bilibili', `/api/subtitles/embedded-extract?movieId=${M.bilibili}&index=1`);
  // index 缺省 / 非数字 → 400「缺少或无效的 movieId/index 参数」
  await step('extract-index-missing', `/api/subtitles/embedded-extract?movieId=${M.emby}`);
  await step('extract-index-nan', `/api/subtitles/embedded-extract?movieId=${M.emby}&index=abc`);
  // 空串必须当 0（`Number('')===0`），不能与「缺省」混为一谈
  await step('extract-index-empty', `/api/subtitles/embedded-extract?movieId=${M.emby}&index=`);
  // emby 但影片没 serverUrl → 「该影片未挂载服务器信息」（两边 catch 都回 400）
  await step('tracks-emby-no-serverurl', `/api/subtitles/embedded-tracks?movieId=${M.emby}`);
  await step('extract-emby-no-serverurl', `/api/subtitles/embedded-extract?movieId=${M.emby}&index=1`);
  await step('tracks-emby-no-path', `/api/subtitles/embedded-tracks?movieId=${M.embyNoPath}`);
  await step('extract-emby-no-path', `/api/subtitles/embedded-extract?movieId=${M.embyNoPath}&index=1`);

  // 兜底：所有步骤都记录了 body，补一层键排序保证比较稳定
  for (const s of log.steps) {
    for (const k of Object.keys(s)) {
      if (k !== 'step') s[k] = stable(s[k]);
    }
  }

  require('fs').writeFileSync(OUT, JSON.stringify(log, null, 2));
  process.stdout.write(`驱动器完成：${log.steps.length} 个步骤 → ${OUT}\n`);
}

main().catch((err) => {
  log.error = String((err && err.stack) || err);
  require('fs').writeFileSync(OUT, JSON.stringify(log, null, 2));
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
