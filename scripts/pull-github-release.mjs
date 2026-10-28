#!/usr/bin/env node
/**
 * 从 GitHub 拉取正式版 Release，转交给 scripts/sync-gitcode-release.mjs 发布到 GitCode。
 *
 * 设计取向：**拉，不是推**。
 * GitHub 侧只负责构建并把 tag 推到 GitCode；GitCode 侧按小时轮询本脚本，
 * 自己发现「GitHub 上有、GitCode 上没有」的 Release 再补上。
 * 好处是跨境上传失败不会影响 GitHub 发版，重试也只发生在 GitCode 的网络里。
 *
 * 只处理正式版（tag 匹配 v<数字>、非 draft、非 prerelease）。
 * main 分支的 `latest` 预发布不在这里同步——它每推送一次就重建，按小时轮询没有意义。
 *
 * 环境变量：
 *   GITCODE_TOKEN   必填，GitCode 个人令牌（仓库 Secrets 里配）
 *   GITCODE_OWNER   默认 Zero-wyc
 *   GITCODE_REPO    默认 ZViewer
 *   GITHUB_REPO     默认 Zero-wyc/ZViewer
 *   GITHUB_TOKEN    选填，只用来提高 GitHub API 限流额度
 *   GITCODE_API_BASE 默认 https://api.gitcode.com/api/v5
 *   GITHUB_API_BASE  默认 https://api.github.com
 *   TAG             只同步指定 tag（手动触发时用）
 *   FORCE           1 = 已同步过也重新拉取
 *   MAX_SYNC        单轮最多补几个 Release，默认 1（一个包 130MB，别一次压满）
 *   GH_PROXY        GitHub 下载加速前缀，如 https://ghfast.top/（下载失败时才会用）
 *   DRY_RUN         1 = 只打印计划，不下载不上传
 *
 * 用法：
 *   node scripts/pull-github-release.mjs
 *   TAG=v5.0.8 FORCE=1 node scripts/pull-github-release.mjs
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const env = process.env;
const GC_API = (env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/+$/, '');
const GH_API = (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const GH_REPO = (env.GITHUB_REPO || 'Zero-wyc/ZViewer').trim();
const GC_OWNER = (env.GITCODE_OWNER || 'Zero-wyc').trim();
const GC_REPO = (env.GITCODE_REPO || 'ZViewer').trim();
const GC_TOKEN = (env.GITCODE_TOKEN || '').trim();
const GH_TOKEN = (env.GITHUB_TOKEN || '').trim();
const ONLY_TAG = (env.TAG || '').trim();
const FORCE = truthy(env.FORCE);
const DRY_RUN = truthy(env.DRY_RUN);
const MAX_SYNC = Math.max(1, Number(env.MAX_SYNC ?? 1) || 1);
const GH_PROXY = (env.GH_PROXY || '').replace(/\/+$/, '');
/** 单轮总时长上限，超过就不再开新的 tag（避免 job 超时半途杀掉上传）。 */
const BUDGET_MS = Math.max(5, Number(env.BUDGET_MINUTES || 150)) * 60 * 1000;

const log = (...a) => console.log('[pull]', ...a);
const warn = (...a) => console.warn('[pull][warn]', ...a);

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!GC_TOKEN && !DRY_RUN) {
  console.error('[pull][error] 缺少 GITCODE_TOKEN：请在 GitCode 仓库「设置 → 密钥」里配置后重跑。');
  process.exit(1);
}

// ---------------------------------------------------------------- HTTP

async function request(url, { headers = {}, method = 'GET', attempts = 3, label = '' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { method, headers, redirect: 'follow' });
      if (res.status === 404) return { res, notFound: true };
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 403 且配额耗尽时重试没意义，直接给出可操作的提示
        if (res.status === 403 && /rate limit/i.test(body)) {
          throw new Error(
            `GitHub API 限流（${label}）：请在 GitCode 仓库密钥里配 GITHUB_TOKEN，或用 GH_PROXY 走镜像。`,
          );
        }
        throw Object.assign(new Error(`${label || url} → HTTP ${res.status} ${body.slice(0, 200)}`), {
          status: res.status,
          body,
        });
      }
      return { res };
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      if (i < attempts) {
        const delay = 2000 * i;
        warn(`${label || url} 第 ${i} 次失败（${err.message}），${delay / 1000}s 后重试`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'zviewer-gitcode-release-sync',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};

async function listGitHubReleases() {
  const url = ONLY_TAG
    ? `${GH_API}/repos/${GH_REPO}/releases/tags/${encodeURIComponent(ONLY_TAG)}`
    : `${GH_API}/repos/${GH_REPO}/releases?per_page=30`;
  const { res } = await request(url, { headers: ghHeaders, label: '读取 GitHub Release' });
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return list.filter((r) => {
    if (!r || r.draft) return false;
    // 手动点名某个 tag 时不再挑拣，方便补发历史版本
    if (ONLY_TAG) return true;
    return !r.prerelease && /^v\d/.test(r.tag_name || '');
  });
}

async function getGitCodeRelease(tag) {
  const url = `${GC_API}/repos/${GC_OWNER}/${GC_REPO}/releases/${encodeURIComponent(tag)}?access_token=${encodeURIComponent(GC_TOKEN)}`;
  try {
    const { res, notFound } = await request(url, { attempts: 2, label: `读取 GitCode Release ${tag}` });
    if (notFound) return null;
    return await res.json();
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** GitCode 侧的附件里，`type: source` 是平台自动生成的源码包，不算我们传的。 */
const gitcodeAssets = (release) => (release?.assets || []).filter((a) => a?.type !== 'source');

// ---------------------------------------------------------------- 下载

async function downloadOnce(url, dest, expectSize) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'zviewer-gitcode-release-sync' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (total && expectSize && total !== expectSize) {
    warn(`Content-Length ${total} 与 API 声明 ${expectSize} 不一致，仍继续`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const stat = await fs.stat(dest);
  if (expectSize && stat.size !== expectSize) {
    throw new Error(`下载不完整：${stat.size}/${expectSize} 字节`);
  }
  return stat.size;
}

async function downloadAsset(asset, dir) {
  const dest = path.join(dir, asset.name);
  const urls = [asset.browser_download_url];
  // 直连失败再用加速前缀：GitCode 机房出境链路时好时坏，多一条路能用
  if (GH_PROXY) urls.push(`${GH_PROXY}${asset.browser_download_url}`);

  let lastErr;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const size = await downloadOnce(url, dest, asset.size);
        log(`  下载完成 ${asset.name}（${(size / 1048576).toFixed(1)} MB）`);
        return dest;
      } catch (err) {
        lastErr = err;
        const route = GH_PROXY && url.startsWith(GH_PROXY) ? '加速' : '直连';
        warn(`  下载 ${asset.name} 失败（${attempt}/2，${route}）：${err.message}`);
        await playCleanup(dest);
        await sleep(3000 * attempt);
      }
    }
  }
  throw new Error(`下载 ${asset.name} 失败：${lastErr?.message}`);
}

async function playCleanup(file) {
  await fs.rm(file, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------- 主流程

function runNode(script, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  log(`源：github.com/${GH_REPO} → 目标：gitcode.com/${GC_OWNER}/${GC_REPO}`);
  const releases = await listGitHubReleases();
  if (!releases.length) {
    log('GitHub 上没有符合条件的 Release，结束');
    return 0;
  }
  log(`GitHub 候选 Release ${releases.length} 个：${releases.map((r) => r.tag_name).join(', ')}`);

  let synced = 0;
  let skipped = 0;
  const failures = [];

  for (const release of releases) {
    if (synced >= MAX_SYNC) break;
    if (Date.now() - startedAt > BUDGET_MS) {
      warn('已到达本轮时间预算，剩余 Release 留给下一轮');
      break;
    }

    const tag = release.tag_name;
    const assets = (release.assets || []).filter((a) => a.state === 'uploaded');
    if (!assets.length) {
      log(`${tag} 没有附件，跳过`);
      skipped += 1;
      continue;
    }

    const existing = await getGitCodeRelease(tag);
    const present = new Set(gitcodeAssets(existing).map((a) => a.name));
    const missing = assets.filter((a) => !present.has(a.name));

    if (existing && !missing.length && !FORCE) {
      log(`${tag} 已在 GitCode 上且附件齐全（${assets.length} 个），跳过`);
      skipped += 1;
      continue;
    }
    if (existing && missing.length) {
      log(`${tag} 在 GitCode 上存在，缺 ${missing.length} 个附件：${missing.map((a) => a.name).join(', ')}`);
    }

    const toFetch = existing && !FORCE ? missing : assets;
    log(`${tag} 开始同步：${existing ? '补附件' : '新建 Release'}，需下载 ${toFetch.length} 个文件`);

    if (DRY_RUN) {
      log(`[dry-run] 将下载：${toFetch.map((a) => a.name).join(', ')}`);
      synced += 1;
      continue;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `zviewer-${tag}-`));
    try {
      const files = [];
      for (const asset of toFetch) {
        files.push(await downloadAsset(asset, dir));
      }

      const bodyFile = path.join(dir, 'release_body.md');
      await fs.writeFile(bodyFile, release.body || `由 GitHub Actions 自动同步的 ${tag} 构建。`, 'utf8');

      log(`${tag} 交给 sync-gitcode-release.mjs 上传（${files.length} 个文件）`);
      const code = await runNode(path.join(process.cwd(), 'scripts', 'sync-gitcode-release.mjs'), {
        TAG: tag,
        RELEASE_NAME: release.name || tag,
        RELEASE_BODY_FILE: bodyFile,
        PRERELEASE: '0',
        TARGET_COMMITISH: 'main',
        ASSETS: files.join(' '),
        // 平台回调慢时一次上传就要一小时，重传只会更慢；失败留给下一轮补
        UPLOAD_ATTEMPTS: '1',
      });
      if (code === 0) {
        synced += 1;
      } else {
        failures.push(`${tag}（上传脚本退出码 ${code}）`);
      }
    } catch (err) {
      failures.push(`${tag}（${err.message}）`);
      warn(`${tag} 同步失败：${err.message}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  log(`本轮结束：同步 ${synced} 个，跳过 ${skipped} 个，失败 ${failures.length} 个`);
  if (failures.length) {
    console.error(`[pull][error] 失败：${failures.join('；')}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[pull][error] ${err.message}`);
    process.exit(1);
  });
