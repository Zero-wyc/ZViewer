#!/usr/bin/env node
/**
 * 把 GitHub 上的正式版 Release 同步到 Gitee（发行版）。
 *
 * 与之前 GitCode 那套的区别：
 * - Gitee 的附件是普通 multipart 直传，同步返回结果，不需要等平台异步回调；
 * - Release 支持 PATCH / DELETE，正文和附件都能正常修改；
 * - 只用 node:https / node:fs 内置模块（不用 fetch / FormData），
 *   Node 14 以上的环境都能跑，不挑 CI 镜像。
 *
 * 环境变量：
 *   GITEE_TOKEN      必填，Gitee 私人令牌（需要 repos 权限）
 *   GITEE_OWNER      默认 Zero-wyc
 *   GITEE_REPO       默认 ZViewer
 *   GITHUB_REPO      默认 Zero-wyc/ZViewer
 *   GITHUB_TOKEN     选填，提高 GitHub API 限流额度
 *   TAG              只同步指定 tag
 *   FORCE            1 = 已同步过也重传
 *   MAX_SYNC         单轮最多补几个版本，默认 1
 *   GH_PROXY         GitHub 下载加速前缀（下载失败时才用），如 https://ghfast.top/
 *   GITEE_TARGET_BRANCH  tag 在 Gitee 上不存在时，用它建 tag（默认不传）
 *   DRY_RUN          1 = 只打印计划
 *
 * 用法：
 *   node scripts/sync-release-to-gitee.mjs
 *   TAG=v5.1.0 FORCE=1 node scripts/sync-release-to-gitee.mjs
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const GH_API = (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const GITEE_API = (env.GITEE_API_BASE || 'https://gitee.com/api/v5').replace(/\/+$/, '');
const GH_REPO = (env.GITHUB_REPO || 'Zero-wyc/ZViewer').trim();
const OWNER = (env.GITEE_OWNER || 'Zero-wyc').trim();
const REPO = (env.GITEE_REPO || 'ZViewer').trim();
const TOKEN = (env.GITEE_TOKEN || '').trim();
const GH_TOKEN = (env.GITHUB_TOKEN || '').trim();
const ONLY_TAG = (env.TAG || '').trim();
const FORCE = truthy(env.FORCE);
const DRY_RUN = truthy(env.DRY_RUN);
const MAX_SYNC = Math.max(1, Number(env.MAX_SYNC || 1) || 1);
const GH_PROXY = (env.GH_PROXY || '').replace(/\/+$/, '');
/** 已经在本地就绪的附件（CI 里产物就在工作目录，没必要再从 GitHub 下一遍） */
const LOCAL_ASSETS = (env.LOCAL_ASSETS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const TARGET_BRANCH = (env.GITEE_TARGET_BRANCH || '').trim();
/** Gitee 单个附件上限 100MB（GVP 200MB），超过就没必要浪费带宽去试 */
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

const log = (...a) => console.log('[gitee]', ...a);
const warn = (...a) => console.warn('[gitee][warn]', ...a);

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

if (!TOKEN && !DRY_RUN) {
  console.error('[gitee][error] 缺少 GITEE_TOKEN：请在仓库「管理 → 环境变量」里配置后重跑。');
  process.exit(1);
}
if (!DRY_RUN && !ONLY_TAG) {
  // 手动指定 tag 时允许覆盖正式版过滤，方便补发
}

// ---------------------------------------------------------------- HTTP 基础

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openRequest(url, { method = 'GET', headers = {}, body = null, timeout = 120000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      { method, headers, timeout },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          resolve(openRequest(next, { method, headers, body, timeout, redirects: redirects - 1 }));
          return;
        }
        resolve(res);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${mask(url)} 超时`)));
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else {
      if (body) req.write(body);
      req.end();
    }
  });
}

/** 日志里不能出现令牌：Gitee 用 query 传 token */
function mask(url) {
  return String(url).replace(/access_token=[^&]+/, 'access_token=***');
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function requestJson(url, { method = 'GET', headers = {}, body = null, attempts = 3, label = '' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await openRequest(url, { method, headers, body });
      const text = (await readAll(res)).toString('utf8');
      if (res.statusCode === 404) {
        return { status: 404, json: null };
      }
      if (res.statusCode >= 400) {
        const err = new Error(`${label || method} → HTTP ${res.statusCode} ${text.slice(0, 300)}`);
        err.status = res.statusCode;
        err.body = text;
        if (res.statusCode === 403 && /rate limit/i.test(text)) {
          err.message =
            'GitHub API 限流：请在 Gitee 仓库环境变量里配 GITHUB_TOKEN（公开仓库不配也能跑，只是额度低）。';
        }
        throw err;
      }
      return { status: res.statusCode, json: text ? JSON.parse(text) : null };
    } catch (err) {
      lastErr = err;
      const retriable = !err.status || err.status >= 500 || err.status === 429;
      if (!retriable) throw err;
      if (i < attempts) {
        warn(`${label || '请求'} 第 ${i} 次失败（${err.message}），${i * 2}s 后重试`);
        await sleep(2000 * i);
      }
    }
  }
  throw lastErr;
}

const withToken = (url) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`;

// ---------------------------------------------------------------- GitHub 侧

async function listGithubReleases() {
  const url = ONLY_TAG
    ? `${GH_API}/repos/${GH_REPO}/releases/tags/${encodeURIComponent(ONLY_TAG)}`
    : `${GH_API}/repos/${GH_REPO}/releases?per_page=30`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'zviewer-gitee-sync',
    ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
  };
  const { json } = await requestJson(url, { headers, label: '读取 GitHub Release' });
  const list = Array.isArray(json) ? json : [json];
  return list.filter((r) => {
    if (!r || r.draft) return false;
    if (ONLY_TAG) return true;
    return !r.prerelease && /^v\d/.test(r.tag_name || '');
  });
}

async function downloadAsset(asset, dir) {
  const dest = path.join(dir, asset.name);
  const urls = [asset.browser_download_url];
  if (GH_PROXY) urls.push(`${GH_PROXY}${asset.browser_download_url}`);

  let lastErr;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await openRequest(url, {
          headers: { 'User-Agent': 'zviewer-gitee-sync' },
          timeout: 0,
        });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(dest);
          res.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          res.pipe(out);
        });
        const stat = await fsp.stat(dest);
        if (asset.size && stat.size !== asset.size) {
          throw new Error(`下载不完整：${stat.size}/${asset.size} 字节`);
        }
        log(`  下载完成 ${asset.name}（${(stat.size / 1048576).toFixed(1)} MB）`);
        return dest;
      } catch (err) {
        lastErr = err;
        const route = GH_PROXY && url.startsWith(GH_PROXY) ? '加速' : '直连';
        warn(`  下载 ${asset.name} 失败（${attempt}/2，${route}）：${err.message}`);
        await fsp.rm(dest, { force: true }).catch(() => {});
        await sleep(3000 * attempt);
      }
    }
  }
  throw new Error(`下载 ${asset.name} 失败：${lastErr?.message}`);
}

// ---------------------------------------------------------------- Gitee 侧

const repoUrl = `${GITEE_API}/repos/${OWNER}/${REPO}`;

async function getGiteeRelease(tag) {
  const { status, json } = await requestJson(withToken(`${repoUrl}/releases/tags/${encodeURIComponent(tag)}`), {
    attempts: 2,
    label: `读取 Gitee 发行版 ${tag}`,
  });
  return status === 404 ? null : json;
}

/** Gitee 正文里的下载直链跟 GitHub 不是一个域名，换成本站链接才有意义。 */
function rewriteLinks(text, tag) {
  return text.replace(
    /https:\/\/github\.com\/[^\s/()]+\/[^\s/()]+\/releases\/download\/[^\s/()]+\//g,
    `https://gitee.com/${OWNER}/${REPO}/releases/download/${tag}/`,
  );
}

async function ensureRelease(tag, payload) {
  const existing = await getGiteeRelease(tag);
  if (!existing) {
    const body = JSON.stringify(payload);
    const { json } = await requestJson(withToken(`${repoUrl}/releases`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body: Buffer.from(body),
      label: `创建 Gitee 发行版 ${tag}`,
    });
    log(`发行版 ${tag} 已创建（id=${json.id}）`);
    return json;
  }
  // 已存在：正文/名称允许改，Gitee 的 PATCH 正常接受 JSON
  const patch = JSON.stringify({ tag_name: tag, name: payload.name, body: payload.body, prerelease: false });
  await requestJson(withToken(`${repoUrl}/releases/${existing.id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(patch) },
    body: Buffer.from(patch),
    label: `更新 Gitee 发行版 ${tag}`,
  }).catch((err) => warn(`更新发行版说明失败（不影响附件）：${err.message}`));
  log(`发行版 ${tag} 已存在（id=${existing.id}），复用并按需补附件`);
  return existing;
}

/** multipart 上传：手写请求体，边读边发，不把 70MB 一次性读进内存。 */
function uploadAsset(releaseId, filePath, fileName) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ASSET_BYTES) {
      reject(new Error(`${fileName} 有 ${(stat.size / 1048576).toFixed(1)}MB，超过 Gitee 单附件 100MB 限制`));
      return;
    }
    const boundary = `----zviewer${crypto.randomBytes(8).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="access_token"\r\n\r\n${TOKEN}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const total = head.length + stat.size + tail.length;

    const url = new URL(`${repoUrl}/releases/${releaseId}/attach_files`);
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(total),
          'User-Agent': 'zviewer-gitee-sync',
        },
        timeout: 0,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error(`上传 ${fileName} → HTTP ${res.statusCode} ${text.slice(0, 300)}`);
            err.status = res.statusCode;
            reject(err);
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', reject);
    req.write(head);
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => req.destroy(err));
    stream.pipe(req, { end: false });
    stream.on('end', () => req.end(tail));
  });
}

const assetsOf = (release) => (release?.assets || []).filter((a) => !String(a.name || '').startsWith('source'));

// ---------------------------------------------------------------- 主流程

async function main() {
  log(`源：github.com/${GH_REPO} → 目标：gitee.com/${OWNER}/${REPO}`);
  const releases = await listGithubReleases();
  if (!releases.length) {
    log('GitHub 上没有符合条件的 Release，结束');
    return 0;
  }
  log(`GitHub 候选 ${releases.length} 个：${releases.map((r) => r.tag_name).join(', ')}`);

  let synced = 0;
  let skipped = 0;
  const failures = [];

  for (const release of releases) {
    if (synced >= MAX_SYNC) break;
    const tag = release.tag_name;
    const assets = (release.assets || []).filter((a) => a.state === 'uploaded');
    if (!assets.length) {
      log(`${tag} 没有附件，跳过`);
      skipped += 1;
      continue;
    }

    const existing = await getGiteeRelease(tag).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
    const present = new Set(assetsOf(existing).map((a) => a.name));
    const missing = assets.filter((a) => !present.has(a.name));

    if (existing && !missing.length && !FORCE) {
      log(`${tag} 已同步且附件齐全（${assets.length} 个），跳过`);
      skipped += 1;
      continue;
    }

    log(`${tag} 开始同步：${existing ? `补 ${missing.length} 个附件` : '新建发行版'}`);

    if (DRY_RUN) {
      log(`[dry-run] 将处理：${(existing ? missing : assets).map((a) => a.name).join(', ')}`);
      synced += 1;
      continue;
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `zviewer-${tag}-`));
    try {
      const localMap = new Map(LOCAL_ASSETS.map((f) => [path.basename(f), f]));
      const wanted = existing && !FORCE ? missing : assets;
      const files = [];
      for (const asset of wanted) {
        if (asset.size > MAX_ASSET_BYTES) {
          failures.push(`${tag}/${asset.name}（${(asset.size / 1048576).toFixed(1)}MB 超过 100MB 上限）`);
          continue;
        }
        const local = localMap.get(asset.name);
        if (local) {
          // 构建产物已经在工作目录，直接复用，省一次 130MB 的下载
          const stat = await fsp.stat(local).catch(() => null);
          if (stat) {
            log(`  使用本地产物 ${asset.name}（${(stat.size / 1048576).toFixed(1)} MB）`);
            files.push(local);
            continue;
          }
        }
        files.push(await downloadAsset(asset, dir));
      }

      const payload = {
        tag_name: tag,
        name: release.name || tag,
        body: rewriteLinks(release.body || `由 GitHub Actions 自动同步的 ${tag} 构建。`, tag),
        prerelease: false,
      };
      if (TARGET_BRANCH) payload.target_commitish = TARGET_BRANCH;

      const rel = await ensureRelease(tag, payload);

      // 同名但内容不同的旧附件先删掉，否则页面上会并存两份
      for (const asset of assetsOf(rel)) {
        const local = files.find((f) => path.basename(f) === asset.name);
        if (!local) continue;
        const localSize = (await fsp.stat(local)).size;
        if (asset.size && asset.size === localSize) {
          log(`  附件 ${asset.name} 体积一致，跳过上传`);
          files.splice(files.indexOf(local), 1);
          continue;
        }
        await requestJson(withToken(`${repoUrl}/releases/${rel.id}/attach_files/${asset.id}`), {
          method: 'DELETE',
          label: `删除旧附件 ${asset.name}`,
        }).catch((err) => warn(`  删除旧附件 ${asset.name} 失败：${err.message}`));
      }

      for (const file of files) {
        const name = path.basename(file);
        const size = (await fsp.stat(file)).size;
        const started = Date.now();
        log(`  上传 ${name}（${(size / 1048576).toFixed(1)} MB）...`);
        await uploadAsset(rel.id, file, name);
        log(`  ${name} 上传完成，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }

      const after = await getGiteeRelease(tag);
      const landed = assetsOf(after).map((a) => a.name);
      const missingAfter = assets.map((a) => a.name).filter((n) => !landed.includes(n));
      if (missingAfter.length) {
        failures.push(`${tag}（回读缺附件：${missingAfter.join(', ')}）`);
      } else {
        log(`${tag} 同步完成：${landed.length} 个附件 → https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
        synced += 1;
      }
    } catch (err) {
      failures.push(`${tag}（${err.message}）`);
      warn(`${tag} 失败：${err.message}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  log(`本轮结束：同步 ${synced} 个，跳过 ${skipped} 个，失败 ${failures.length} 个`);
  if (failures.length) {
    console.error(`[gitee][error] 失败：${failures.join('；')}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[gitee][error] ${err.message}`);
    process.exit(1);
  });
