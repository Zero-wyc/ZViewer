#!/usr/bin/env node
/**
 * GitCode 附件上传「路径对照」探针。
 *
 * 目的只有一个：回答「GitHub → GitCode 同步慢，是路径问题还是平台问题」。
 * 同一份文件、同一个 Release，分别走两条上传链路，量三个时间点：
 *
 *   A. put  —— 两步式：GET /releases/{tag}/upload_url → PUT 到华为云 OBS
 *              （scripts/sync-gitcode-release.mjs 现在用的就是这条）
 *   B. post —— 一步式：POST /releases/{id}/attach_files 的 multipart 表单
 *              （xzl01/action-gitcode-release 用的这条，不经过 OBS 预签名）
 *
 * 每个路径都在上传开始的同时起一个后台轮询，每 5s 回读一次 Release 附件列表，
 * 记录「附件第一次可见」的时刻。这样能把两件事分开：
 *   - 请求体发完 → 附件可见：平台的登记耗时（真正的瓶颈）
 *   - 附件可见   → 收到回包：平台/OBS 回包的滞后
 * 如果 A 的「附件可见」紧跟「请求体发完」、只是回包晚，那说明 PUT 的等待是白等；
 * 如果 B 的「附件可见」同样慢，那说明瓶颈在平台登记，跟走哪条路无关。
 *
 * 输入（全部走环境变量）：
 *   GITCODE_TOKEN        必填
 *   GITCODE_OWNER        默认 Zero-wyc
 *   GITCODE_REPO         默认 ZViewer
 *   TAG                  默认 probe-upload-<时间戳>；每次探针用一个新 tag 更干净
 *   ASSET_PATH           必填，要上传的本地文件
 *   LABEL                附件命名里的尺寸标签，默认按文件大小算，如 37mb
 *   PATHS                要测的路径，逗号分隔：post,put，默认 post,put（按顺序执行）
 *   TIMEOUT_MINUTES      请求体发完后等回包的上限（分钟），默认 60
 *   BODY_STALL_MINUTES   发请求体期间「无进展」多久算卡死（分钟），默认 5
 *   POLL_MS              附件列表轮询间隔，默认 5000
 *   DELETE_AFTER         1 = 测完删掉两个探针附件（Release 本身删不掉），默认 1
 *
 * 这个脚本不做重试：重试会把两条链路的时间混在一起，反而看不出瓶颈。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const API = (process.env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/+$/, '');
const TOKEN = (process.env.GITCODE_TOKEN || '').trim();
const OWNER = (process.env.GITCODE_OWNER || 'Zero-wyc').trim();
const REPO = (process.env.GITCODE_REPO || 'ZViewer').trim();
const TAG = (process.env.TAG || `probe-upload-${Date.now()}`).trim();
const ASSET_PATH = (process.env.ASSET_PATH || '').trim();
const PATHS = (process.env.PATHS || 'post,put')
  .split(/[\s,]+/)
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s === 'post' || s === 'put');
const TIMEOUT_MS = (Number(process.env.TIMEOUT_MINUTES) || 60) * 60_000;
const STALL_MS = (Number(process.env.BODY_STALL_MINUTES) || 5) * 60_000;
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS) || 5000);
const DELETE_AFTER = !['0', 'false', 'no'].includes((process.env.DELETE_AFTER || '1').toLowerCase());

const log = (...args) => console.log('[probe]', ...args);
const warn = (...args) => console.warn('[probe][warn]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.error('[probe][error] 缺少 GITCODE_TOKEN');
  process.exit(1);
}
if (!ASSET_PATH) {
  console.error('[probe][error] 缺少 ASSET_PATH');
  process.exit(1);
}
if (TAG.toLowerCase() === 'latest') {
  console.error('[probe][error] tag 不能叫 latest（GitCode 把 /releases/latest 当别名）');
  process.exit(1);
}
if (!PATHS.length) {
  console.error('[probe][error] PATHS 里没有可识别的值（只支持 post / put）');
  process.exit(1);
}

const repoUrl = `${API}/repos/${OWNER}/${REPO}`;
const releaseUrl = `${repoUrl}/releases/${encodeURIComponent(TAG)}`;
const pageUrl = `https://gitcode.com/${OWNER}/${REPO}/releases/tag/${TAG}`;
const withToken = (url) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`;

const size = statSync(ASSET_PATH).size;
const sizeMb = size / 1048576;
const LABEL = (process.env.LABEL || `${Math.round(sizeMb)}mb`).trim();

/** Release 里真正上传的附件；`type: source` 是 GitCode 自动生成的源码包。 */
const attachmentsOf = (release) => (release?.assets || []).filter((a) => a.type !== 'source');

/** 控制面请求（建 Release、回读、删附件）都用内置 fetch，60s 足够。 */
async function api(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function getRelease() {
  try {
    return await api(withToken(releaseUrl));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function ensureRelease() {
  const existing = await getRelease();
  if (existing) {
    log(`复用已存在的 Release ${TAG}`);
    return existing;
  }
  const body = {
    tag_name: TAG,
    name: TAG,
    body: '上传路径对照探针（post vs put），可随时删除附件。',
    // pre：不让这个临时 Release 顶掉正式版的 latest
    release_status: 'pre',
    target_commitish: 'main',
  };
  const created = await api(withToken(`${repoUrl}/releases`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  log(`已创建 Release ${TAG}`);
  return created;
}

/**
 * 发一次请求体并记录时间线。
 *
 * 用 node:https 而不是 fetch：fetch 有 300s headersTimeout，会在大文件上传时
 * 提前掐断，把「平台慢」和「客户端超时」混在一起——正是要测的东西。
 */
function transfer({ method, url, headers, totalSize, writeBody, label }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'http:' ? http : https;
    const startedAt = Date.now();
    const marks = { startedAt, bodySentAt: null, headersAt: null, endedAt: null };
    let sent = 0;
    let lastSent = 0;
    let lastProgressAt = startedAt;
    let settled = false;

    const req = mod.request(
      target,
      {
        method,
        headers: { ...headers, 'Content-Length': String(totalSize) },
        agent: false,
        timeout: 0, // 关掉 socket 空闲超时，超时全部自己判
      },
      (res) => {
        marks.headersAt = Date.now();
        log(`${label} 收到回包 HTTP ${res.statusCode}（T+${((marks.headersAt - startedAt) / 1000).toFixed(1)}s）`);
        const chunks = [];
        res.on('data', (chunk) => {
          if (chunks.length < 8) chunks.push(chunk);
        });
        res.on('end', () => {
          marks.endedAt = Date.now();
          finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 800), marks, sent });
        });
      },
    );

    function finish(value) {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      resolve(value);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      err.marks = marks;
      err.sent = sent;
      reject(err);
    }

    const tick = setInterval(() => {
      if (sent > lastSent) {
        lastSent = sent;
        lastProgressAt = Date.now();
      }
      const idle = Date.now() - lastProgressAt;
      const elapsed = (Date.now() - startedAt) / 1000;
      log(`${label} 已发 ${(sent / 1048576).toFixed(1)}/${sizeMb.toFixed(1)} MB，耗时 ${elapsed.toFixed(0)}s`);
      // 请求体发完后，卡住的含义变了：这时等的是平台登记/回包，给 TIMEOUT_MS
      const limit = sent >= totalSize ? TIMEOUT_MS : STALL_MS;
      if (idle > limit) {
        req.destroy(
          new Error(
            sent >= totalSize
              ? `请求体已发完，等待回包超过 ${Math.round(limit / 60000)} 分钟，主动中断`
              : `发送停滞超过 ${Math.round(limit / 60000)} 分钟，主动中断`,
          ),
        );
      }
    }, 15000);

    req.on('error', fail);

    Promise.resolve()
      .then(() => writeBody(req, (n) => { sent += n; }))
      .then(() => {
        marks.bodySentAt = Date.now();
        log(`${label} 请求体发完（T+${((marks.bodySentAt - startedAt) / 1000).toFixed(1)}s），开始等回包`);
        req.end();
      })
      .catch((err) => req.destroy(err));
  });
}

/** 直接把文件流写进请求体（PUT 路径）。 */
function writeFileBody(req, onWrite) {
  return (async () => {
    const stream = createReadStream(ASSET_PATH, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      onWrite(chunk.length);
      if (!req.write(chunk)) await once(req, 'drain');
    }
  })();
}

/** 拼 multipart 请求体（POST 路径），Content-Length 必须精确。 */
function writeMultipartBody(fileName, boundary) {
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="access_token"\r\n\r\n${TOKEN}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    prefix,
    suffix,
    totalSize: prefix.length + size + suffix.length,
    write: (req, onWrite) => (async () => {
      onWrite(prefix.length);
      if (!req.write(prefix)) await once(req, 'drain');
      const stream = createReadStream(ASSET_PATH, { highWaterMark: 1 << 20 });
      for await (const chunk of stream) {
        onWrite(chunk.length);
        if (!req.write(chunk)) await once(req, 'drain');
      }
      onWrite(suffix.length);
      req.write(suffix);
    })(),
  };
}

/** 上传期间每 POLL_MS 回读一次附件列表，记录「第一次可见」的时刻。 */
function startPoller(name, label) {
  const state = { firstSeenAt: null, busy: false };
  const timer = setInterval(async () => {
    if (state.busy || state.firstSeenAt) return;
    state.busy = true;
    try {
      const release = await getRelease();
      const asset = attachmentsOf(release).find((a) => a.name === name);
      if (asset) {
        state.firstSeenAt = Date.now();
        log(
          `${label} 附件已出现在列表：T+${((state.firstSeenAt - state.startedAt) / 1000).toFixed(1)}s，` +
            `size=${asset.size ?? '?'} id=${asset.id ?? '-'}`,
        );
      }
    } catch {
      // 轮询失败不打断上传；下一次再试
    } finally {
      state.busy = false;
    }
  }, POLL_MS);
  timer.unref?.();
  return {
    state,
    stop: () => clearInterval(timer),
    startAt: (t) => { state.startedAt = t; },
  };
}

const results = [];
const rel = await ensureRelease();
log(`Release ${TAG}：id=${rel?.id ?? '(无)'}（xzl01 的实现依赖这个 id，这里顺便确认它到底有没有）`);
log(`文件 ${ASSET_PATH}：${sizeMb.toFixed(1)} MB，路径 = ${PATHS.join(' → ')}`);

for (const kind of PATHS) {
  const name = `probe-${kind}-${LABEL}.bin`;
  const label = `${kind.toUpperCase()}`;
  const poller = startPoller(name, label);

  const row = {
    kind,
    name,
    status: '',
    bodySent: null,
    headers: null,
    ended: null,
    firstSeen: null,
    snippet: '',
    note: '',
  };

  try {
    if (kind === 'put') {
      const signRes = await api(withToken(`${releaseUrl}/upload_url?file_name=${encodeURIComponent(name)}`));
      const signUrl = signRes?.url;
      if (!signUrl) throw new Error(`upload_url 没有返回 url：${JSON.stringify(signRes).slice(0, 300)}`);
      row.note = `OBS ${new URL(signUrl).host}，header: ${Object.keys(signRes.headers || {}).join(',') || '(空)'}`;
      log(`${label} 预签名地址：${row.note}`);

      poller.startAt(Date.now());
      const res = await transfer({
        method: 'PUT',
        url: signUrl,
        headers: signRes.headers || {},
        totalSize: size,
        writeBody: writeFileBody,
        label,
      });
      row.status = String(res.status);
      row.bodySent = res.marks.bodySentAt;
      row.headers = res.marks.headersAt;
      row.ended = res.marks.endedAt;
      row.snippet = res.body;
    } else {
      // GitCode 的写接口按 tag 寻址，但 multipart 老接口在部分实现里用 release id；
      // 有 id 就先用 id，404/405 再退回 tag。两次都记进 note。
      const identifier = rel?.id != null ? String(rel.id) : TAG;
      const boundary = `----gitcodeprobe${crypto.randomBytes(8).toString('hex')}`;
      const mp = writeMultipartBody(name, boundary);
      const url = withToken(`${repoUrl}/releases/${encodeURIComponent(identifier)}/attach_files`);
      row.note = `POST /releases/${identifier}/attach_files（identifier=${rel?.id != null ? 'id' : 'tag'}），请求体 ${(mp.totalSize / 1048576).toFixed(1)} MB`;
      log(`${label} ${row.note}`);

      poller.startAt(Date.now());
      const res = await transfer({
        method: 'POST',
        url,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        totalSize: mp.totalSize,
        writeBody: mp.write,
        label,
      });
      row.status = String(res.status);
      row.bodySent = res.marks.bodySentAt;
      row.headers = res.marks.headersAt;
      row.ended = res.marks.endedAt;
      row.snippet = res.body;
    }
  } catch (err) {
    row.status = err.status ? `HTTP ${err.status}` : '失败/超时';
    row.snippet = String(err.body || err.message).slice(0, 300);
    row.bodySent = err.marks?.bodySentAt ?? null;
    row.headers = err.marks?.headersAt ?? null;
    row.ended = err.marks?.endedAt ?? null;
    warn(`${label} 上传未拿到正常回包：${err.message}`);
  }

  // 回包之后再多等一段时间，让轮询有机会看到迟早登记上的附件
  const baseline = row.bodySent ?? poller.state.startedAt ?? Date.now();
  for (let i = 0; i < 12 && !poller.state.firstSeenAt; i += 1) {
    await sleep(POLL_MS);
  }
  poller.stop();
  row.firstSeen = poller.state.firstSeenAt;
  row.baseline = baseline;

  results.push(row);
}

const rel2 = await getRelease();
for (const row of results) {
  const asset = attachmentsOf(rel2).find((a) => a.name === row.name);
  row.registered = Boolean(asset);
  row.asset = asset;
}

const secs = (from, to) => (from && to ? `${((to - from) / 1000).toFixed(1)}` : '—');
// 唯一的结论指标：请求体发完之后，附件还要多久才在列表里出现
const lag = (row) => (row.bodySent && row.firstSeen ? (row.firstSeen - row.bodySent) / 1000 : null);
const lines = [
  '| 路径 | 状态 | 发完请求体(s) | 附件首次可见(s) | 登记滞后(s) | 收到回包(s) | 回包比可见晚(s) | 登记在册 | 说明 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
for (const row of results) {
  const registerLag = lag(row);
  lines.push(
    `| ${row.kind} | ${row.status} | ${secs(row.baseline, row.bodySent)} | ${secs(row.baseline, row.firstSeen)} | ` +
      `${registerLag != null ? registerLag.toFixed(1) : '—'} | ${secs(row.baseline, row.headers)} | ` +
      `${secs(row.firstSeen, row.headers)} | ${row.registered ? '是' : '否'} | ` +
      `${row.note || row.snippet.replace(/\|/g, '/').slice(0, 80)} |`,
  );
}

const post = results.find((r) => r.kind === 'post');
const put = results.find((r) => r.kind === 'put');
lines.push('');
if (post && put && lag(post) != null && lag(put) != null) {
  const diff = lag(put) - lag(post);
  lines.push(
    diff > 60
      ? `结论：post 比 put 早 ${diff.toFixed(0)}s 登记，multipart 链路值得切为主路径。`
      : `结论：两条路径登记耗时相近（差 ${diff.toFixed(0)}s），瓶颈在平台登记而不是上传方式。`,
  );
} else {
  lines.push('结论：有一侧没测到完整数据（超时或未登记），先看上面的状态与说明。');
}

log('');
for (const line of lines) log(line);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  await fs.appendFile(
    summary,
    `### GitCode 上传路径对照（${sizeMb.toFixed(1)} MB，tag \`${TAG}\`）\n\n${lines.join('\n')}\n\n页面：${pageUrl}\n`,
  );
}

if (DELETE_AFTER) {
  const all = attachmentsOf(await getRelease()).filter((a) => a.name.startsWith('probe-'));
  for (const asset of all) {
    if (asset.id == null) continue;
    try {
      await api(withToken(`${releaseUrl}/attach_files/${encodeURIComponent(asset.id)}`), { method: 'DELETE' });
      log(`已删除探针附件 ${asset.name}（id=${asset.id}）`);
    } catch (err) {
      warn(`删除 ${asset.name} 失败：${err.message}`);
    }
  }
  log(`Release ${TAG} 本身删不掉（GitCode 无此 API），需要的话去 ${pageUrl} 手动删。`);
}

// 两条路径都没登记成功，就让 job 变红，避免「跑完了但什么都没测到」
process.exit(results.some((r) => r.registered) ? 0 : 1);
