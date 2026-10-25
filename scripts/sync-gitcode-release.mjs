#!/usr/bin/env node
/**
 * 把一次 GitHub Release 复制成 GitCode（CSDN，gitcode.com）Release。
 *
 * 为什么需要：GitCode 的「仓库镜像」只同步 分支 / 标签 / 提交，**不同步 Release 与附件**，
 * 所以大陆用户仍要去 GitHub 下产物。本脚本在 CI 里用 GitCode OpenAPI 重建同名 Release
 * 并上传同一批附件，得到 gitcode.com 的下载地址。
 *
 * 输入（全部走环境变量，便于 workflow 直接传）：
 *   GITCODE_TOKEN        必填。GitCode 私人令牌（设置 → 私人令牌）。为空时整体跳过（退出码 0）。
 *   GITCODE_OWNER        仓库空间地址，默认 Zero-wyc
 *   GITCODE_REPO         仓库路径，默认 ZViewer
 *   TAG                  必填。Release 对应 tag，如 v5.0.1 或 latest
 *   RELEASE_NAME         Release 标题，默认 TAG
 *   RELEASE_BODY_FILE    Release 说明的 markdown 文件路径，可选
 *   PRERELEASE           1 = 预发布（GitCode release_status=pre），默认 0（latest）
 *   ASSETS               附件路径，空格/换行/逗号分隔
 *   TARGET_COMMITISH     tag 在 GitCode 上不存在时用它建 tag（分支名或 commit SHA），默认 main
 *   GITCODE_API_BASE     默认 https://api.gitcode.com/api/v5
 *   DRY_RUN              1 = 只打印计划，不写远端
 *
 * 行为：同名 Release 已存在则先删后建（附件随 Release 一起消失），因此可重复执行。
 * 任一附件失败都不影响其它附件，最终有失败则以退出码 1 结束（CI 侧配 continue-on-error）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = (process.env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/+$/, '');
const TOKEN = (process.env.GITCODE_TOKEN || '').trim();
const OWNER = (process.env.GITCODE_OWNER || 'Zero-wyc').trim();
const REPO = (process.env.GITCODE_REPO || 'ZViewer').trim();
const TAG = (process.env.TAG || '').trim();
const RELEASE_NAME = (process.env.RELEASE_NAME || TAG).trim();
const BODY_FILE = (process.env.RELEASE_BODY_FILE || '').trim();
const PRERELEASE = ['1', 'true', 'yes'].includes((process.env.PRERELEASE || '').toLowerCase());
const TARGET_COMMITISH = (process.env.TARGET_COMMITISH || 'main').trim();
const DRY_RUN = ['1', 'true', 'yes'].includes((process.env.DRY_RUN || '').toLowerCase());
const ASSETS = (process.env.ASSETS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...args) => console.log('[gitcode]', ...args);
const warn = (...args) => console.warn('[gitcode][warn]', ...args);

function skip(reason) {
  log(`跳过：${reason}`);
  process.exit(0);
}

if (!TOKEN) skip('未配置 GITCODE_TOKEN（未接入 GitCode 或本次不需要同步）');
if (!TAG) {
  console.error('[gitcode][error] 缺少 TAG 环境变量');
  process.exit(1);
}

const repoUrl = `${API}/repos/${OWNER}/${REPO}`;
const releaseUrl = `${repoUrl}/releases/${encodeURIComponent(TAG)}`;
const withToken = (url) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`;

/** GitCode 的 Pull 镜像仓是只读的，任何写操作都会返回这条固定文案。 */
const MIRROR_REPO_HINT =
  '仓库是只读镜像仓（image repository）：GitCode 的「仓库镜像 → Pull」会禁用所有写入。' +
  '请到 GitCode 项目设置 → 仓库镜像 关闭 Pull 镜像后重跑（关闭后代码由 CI 推送）。';

function isImageRepoError(err) {
  return /image repository/i.test(String(err?.body || err?.message || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带退避重试；对 4xx（除 429）不重试，直接抛出。 */
async function request(url, init = {}, { attempts = 4, label = '' } = {}) {
  const delays = [2000, 5000, 10000];
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      // 404 属于「预期内的不存在」，交给调用方判断
      if (res.status !== 429 && res.status < 500) {
        const err = new Error(`${label || init.method || 'GET'} 失败：HTTP ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        err.body = text;
        throw err;
      }
      lastErr = new Error(`${label || init.method || 'GET'} 失败：HTTP ${res.status} ${text.slice(0, 300)}`);
    } catch (err) {
      if (err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
    }
    if (i < attempts - 1) {
      warn(`${label || '请求'} 第 ${i + 1} 次失败（${lastErr.message}），${delays[i] / 1000}s 后重试`);
      await sleep(delays[i]);
    }
  }
  throw lastErr;
}

async function readBody() {
  if (!BODY_FILE) return `由 GitHub Actions 自动同步的 ${TAG} 构建。`;
  try {
    return await fs.readFile(BODY_FILE, 'utf8');
  } catch {
    warn(`读取说明文件失败（${BODY_FILE}），使用占位说明`);
    return `由 GitHub Actions 自动同步的 ${TAG} 构建。`;
  }
}

async function main() {
  log(`目标仓库 ${OWNER}/${REPO}，tag=${TAG}，预发布=${PRERELEASE}，附件 ${ASSETS.length} 个`);

  const body = await readBody();
  const payload = {
    tag_name: TAG,
    name: RELEASE_NAME,
    body,
    release_status: PRERELEASE ? 'pre' : 'latest',
  };

  if (DRY_RUN) {
    log('[dry-run] POST', `${repoUrl}/releases`, JSON.stringify({ ...payload, body: `<${body.length} 字符>` }));
    for (const file of ASSETS) {
      log('[dry-run] 上传', file);
    }
    return;
  }

  // 1) 仓库必须已存在（GitCode 不会因为 API 调用自动建仓）
  try {
    await request(withToken(repoUrl), {}, { label: `读取仓库 ${OWNER}/${REPO}`, attempts: 2 });
  } catch (err) {
    console.error(
      `[gitcode][error] 访问仓库失败：${err.message}\n` +
        `  请在 gitcode.com 先创建/导入 ${OWNER}/${REPO}，并确认令牌有该仓库写权限。`,
    );
    process.exit(1);
  }

  // 2) 已存在同名 Release 先删掉：附件名每次构建都一样，直接重建最省事
  try {
    const res = await request(withToken(releaseUrl), {}, { label: '查询已有 Release', attempts: 2 });
    if (res.ok) {
      log(`已存在 Release ${TAG}，先删除（含旧附件）`);
      await request(withToken(releaseUrl), { method: 'DELETE' }, { label: '删除已有 Release', attempts: 2 });
    }
  } catch (err) {
    if (err.status !== 404) {
      if (isImageRepoError(err)) throw new Error(MIRROR_REPO_HINT);
      throw err;
    }
  }

  // 3) 创建 Release。tag 尚未在 GitCode 存在时（还没有任何 Release），
  //    用 target_commitish 让 GitCode 自己建 tag，避免整次同步白跑。
  const postRelease = (extra = {}) =>
    request(
      withToken(`${repoUrl}/releases`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...extra }),
      },
      { label: '创建 Release' },
    );

  let created;
  try {
    created = await postRelease();
  } catch (err) {
    if (isImageRepoError(err)) {
      // 只读镜像仓：重试没有意义，直接给操作指引
      throw new Error(MIRROR_REPO_HINT);
    }
    if (!TARGET_COMMITISH) throw err;
    warn(`创建 Release 失败（${err.message}），改用 target_commitish=${TARGET_COMMITISH} 重试`);
    try {
      created = await postRelease({ target_commitish: TARGET_COMMITISH });
    } catch (retryErr) {
      if (isImageRepoError(retryErr)) throw new Error(MIRROR_REPO_HINT);
      throw retryErr;
    }
  }
  log(`Release ${TAG} 已创建（HTTP ${created.status}）`);

  // 4) 逐个上传附件：先取预签名地址，再 PUT 原始字节
  const failed = [];
  for (const [index, file] of ASSETS.entries()) {
    const name = path.basename(file);
    const tagText = `[${index + 1}/${ASSETS.length}] ${name}`;
    let size;
    let bytes;
    try {
      bytes = await fs.readFile(file);
      size = bytes.length;
    } catch (err) {
      warn(`${tagText} 读取失败，跳过：${err.message}`);
      failed.push(name);
      continue;
    }

    log(`${tagText} 开始上传（${(size / 1048576).toFixed(1)} MB）`);
    const startedAt = Date.now();
    try {
      const signRes = await request(
        withToken(`${releaseUrl}/upload_url?file_name=${encodeURIComponent(name)}`),
        {},
        { label: `${name} 获取上传地址`, attempts: 3 },
      );
      const sign = await signRes.json();
      if (!sign?.url) throw new Error(`上传地址响应异常：${JSON.stringify(sign).slice(0, 200)}`);

      const putRes = await fetch(sign.url, {
        method: 'PUT',
        headers: { ...(sign.headers || {}), 'Content-Length': String(size) },
        body: bytes,
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      if (!putRes.ok) {
        const text = await putRes.text().catch(() => '');
        throw new Error(`PUT 失败：HTTP ${putRes.status} ${text.slice(0, 200)}`);
      }
      const seconds = (Date.now() - startedAt) / 1000;
      log(`${tagText} 上传完成，用时 ${seconds.toFixed(1)}s（${(size / 1048576 / seconds).toFixed(1)} MB/s）`);
    } catch (err) {
      warn(`${tagText} 上传失败：${err.message}`);
      failed.push(name);
    }
  }

  // 5) 回读校验，产出大陆下载地址（回读失败不影响「已上传成功」的事实，单独降级处理）
  let release = null;
  try {
    const finalRes = await request(withToken(`${releaseUrl}?temp_download_url=false`), {}, { label: '回读 Release', attempts: 3 });
    release = await finalRes.json();
  } catch (err) {
    warn(`回读 Release 失败（附件可能已上传成功）：${err.message}`);
  }
  const remote = new Set((release?.assets || []).map((a) => a.name));
  const links = [];
  for (const file of ASSETS) {
    const name = path.basename(file);
    if (failed.includes(name)) continue;
    // 回读到列表时以远端为准；回读失败则按上传成功的记录乐观输出
    if (release && !remote.has(name)) continue;
    const found = (release?.assets || []).find((a) => a.name === name);
    links.push(found?.browser_download_url || `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${encodeURIComponent(name)}`);
  }

  log(`GitCode Release 页面：https://gitcode.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
  for (const link of links) log(`下载：${link}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## GitCode（大陆镜像）Release',
      '',
      `- 版本页：https://gitcode.com/${OWNER}/${REPO}/releases/tag/${TAG}`,
      ...links.map((l) => `- ${l}`),
    ];
    if (failed.length) lines.push('', `> 上传失败：${failed.join('、')}`);
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`).catch(() => {});
  }

  if (failed.length) {
    console.error(`[gitcode][error] ${failed.length} 个附件未同步：${failed.join('、')}`);
    process.exit(1);
  }
  log('全部附件同步完成');
}

main().catch((err) => {
  console.error('[gitcode][error]', err?.message || err);
  process.exit(1);
});
