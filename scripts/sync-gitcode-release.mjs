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
 *   TAG                  必填。Release 对应 tag，如 v5.0.1 或 dev（**不能叫 latest**，见下）
 *   RELEASE_NAME         Release 标题，默认 TAG
 *   RELEASE_BODY_FILE    Release 说明的 markdown 文件路径，可选
 *   PRERELEASE           1 = 预发布（GitCode release_status=pre），默认 0（latest）
 *   ASSETS               附件路径，空格/换行/逗号分隔
 *   TARGET_COMMITISH     tag 在 GitCode 上不存在时用它建 tag（分支名或 commit SHA），默认 main
 *   GITCODE_API_BASE     默认 https://api.gitcode.com/api/v5
 *   DRY_RUN              1 = 只打印计划，不写远端
 *   NO_RECREATE          1 = 已存在同名 Release 时原地补传附件（不删不重建），失败重跑/修复用
 *   DIAG                 1 = 只读诊断：打印仓库/Release/上传地址结构，不写任何东西
 *   UPLOAD_ATTEMPTS      单个附件最多尝试次数（含首次），默认 3
 *   KEEP_EMPTY_RELEASE   1 = 附件全失败时也保留 Release（默认会删掉空壳，见下）
 *   VERIFY_DOWNLOAD      1（默认）= 上传后真的把附件下回来核对字节数与大小，0 = 只查 API 列表
 *   OBSERVE_TAG          只读复核某个已存在的 tag（不建、不传、不删）
 *
 * === 2026-10-26 第二次修正：从「名字在列表里」升级为「附件真的可用」===
 * 症状：job 绿色，脚本自己回读也确实看到 3 个附件，几小时后 API 与页面只剩 4 个源码包。
 *
 * 根因（对照 GitCode 上正常发布附件的仓库确认，例如 hust-open-atom-club/atomgit-cli）：
 * 一个**真正挂上**的附件在 `/releases/{tag}` 里长这样——
 *     { "type": "attach", "id": 115467, "size": 3166908,
 *       "browser_download_url": ".../releases/download/v0.3/ag_darwin_amd64.tar.gz" }
 * 而自动生成的源码包是 `{ "type": "source" }`，**没有 id、没有 size**。
 *
 * 也就是说：`type/id/size` 三者齐全才算「登记完成」。旧版只比对 `type !== 'source'` 的
 * `name`，于是把「预签名地址已签发、OBS 已收字节、但平台回调还没写库」的中间态也算成功，
 * job 因此变绿；这类中间态记录随后会被平台回收——用户看到的就是「只有 source code」。
 *
 * 现在每个附件必须同时满足三条才算上传成功，否则换一张新的预签名地址重传：
 *   1. Release 里出现同名 `type=attach` 条目，且带数字 `id`；
 *   2. 该条目的 `size` 与本地文件字节数一致（缺失或为 0 视为未登记）；
 *   3. 走一遍 `GET /releases/{tag}/attach_files/{name}/download` 拿到真实响应头，
 *      能对上总字节数（`VERIFY_DOWNLOAD=0` 可关闭这一条，仅在内网/带宽极紧时用）。
 *
 * PUT 侧同时补了两件事（参考 space-ast/action-git-release 的实现）：
 *   - 单次上传不设 socket 空闲超时，只保留「10 分钟无进展」的停滞检测；
 *   - 400/405 时回退成 multipart POST 再试一次（文档与社区示例对此有分歧）。
 *
 * === 探针模式（PROBE_MODE=1）===
 * 只观测不裁决：附件缺失不让 job 变红，配合 VERIFY_MINUTES 按分钟时点回读。
 * 用法见 `.github/workflows/gitcode-probe.yml`（手动触发）。
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const API = (process.env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/+$/, '');
const TOKEN = (process.env.GITCODE_TOKEN || '').trim();
const OWNER = (process.env.GITCODE_OWNER || 'Zero-wyc').trim();
const REPO = (process.env.GITCODE_REPO || 'ZViewer').trim();
/**
 * 只读复核：只回读某个已存在的 tag，绝不建、绝不传、绝不删。
 * 用来隔几小时再确认「附件还在不在」——这一步不需要再走一次上传，
 * 也不消耗带宽，所以可以在观察到异常后随时补跑。
 */
const OBSERVE_TAG = (process.env.OBSERVE_TAG || '').trim();
const TAG = (OBSERVE_TAG || process.env.TAG || '').trim();
const RELEASE_NAME = (process.env.RELEASE_NAME || TAG).trim();
const BODY_FILE = (process.env.RELEASE_BODY_FILE || '').trim();
const PRERELEASE = ['1', 'true', 'yes'].includes((process.env.PRERELEASE || '').toLowerCase());
const TARGET_COMMITISH = (process.env.TARGET_COMMITISH || 'main').trim();
const DRY_RUN = ['1', 'true', 'yes'].includes((process.env.DRY_RUN || '').toLowerCase());
const NO_RECREATE = ['1', 'true', 'yes'].includes((process.env.NO_RECREATE || '').toLowerCase());
const DIAG = ['1', 'true', 'yes'].includes((process.env.DIAG || '').toLowerCase());
// 默认把正文里的 GitHub 下载直链改写成 GitCode 直链（镜像页面上给 GitHub 链接等于没给）
const REWRITE_LINKS = !['0', 'false', 'no'].includes((process.env.REWRITE_GITHUB_LINKS || '1').toLowerCase());
const UPLOAD_ATTEMPTS = Math.max(1, Number(process.env.UPLOAD_ATTEMPTS || 3) || 3);
const KEEP_EMPTY_RELEASE = ['1', 'true', 'yes'].includes((process.env.KEEP_EMPTY_RELEASE || '').toLowerCase());
// 上传后是否真的下载回来核对（默认开）。关掉只影响第 3 条判据，前两条仍然生效。
const VERIFY_DOWNLOAD = !['0', 'false', 'no'].includes((process.env.VERIFY_DOWNLOAD || '1').toLowerCase());
/**
 * 探针模式：只观测不裁决。上传结束后按 VERIFY_MINUTES 的时点回读附件，
 * 用来判断附件是「当时就在」还是「过一段时间被平台清理」——线上反复出现
 * 「job 绿、页面只有源码包」，就是缺这一步观测。
 */
const PROBE_MODE = ['1', 'true', 'yes'].includes((process.env.PROBE_MODE || '').toLowerCase());
const VERIFY_MINUTES = (process.env.VERIFY_MINUTES || (OBSERVE_TAG ? '0' : ''))
  .split(/[\s,]+/)
  // 空串会被 Number('') 变成 0，等于偷偷排了一次 T+0 回读，这里显式丢掉
  .filter((s) => s !== '')
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n >= 0);
const ASSETS = (process.env.ASSETS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/** 单次上传允许「无任何进展」多久（毫秒）。跨境慢链路给足余量，真卡死才中断。 */
const STALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 下载核验最多读多少字节（默认读头部 64 KB 就够证明对象可读，且不浪费带宽）。 */
const DOWNLOAD_PROBE_BYTES = Math.max(1024, Number(process.env.DOWNLOAD_PROBE_BYTES || 65536) || 65536);

const log = (...args) => console.log('[gitcode]', ...args);
const warn = (...args) => console.warn('[gitcode][warn]', ...args);

/** 收集报告，最后统一打到日志与 GITHUB_STEP_SUMMARY（CI 页面上直接可见，不用翻日志）。 */
const report = { steps: [], files: [], error: null, releaseUrl: '' };
const note = (line) => {
  report.steps.push(line);
  log(line);
};

function skip(reason) {
  log(`跳过：${reason}`);
  process.exit(0);
}

if (!TOKEN) skip('未配置 GITCODE_TOKEN（未接入 GitCode 或本次不需要同步）');
if (!TAG) {
  console.error('[gitcode][error] 缺少 TAG 环境变量');
  process.exit(1);
}
/**
 * GitCode 把 `/releases/latest` 当作「仓库最新 Release」的别名：
 * 用 tag=latest 时 GET 会返回**别的** Release（比如 v5.0.4），接着 DELETE 又 404，
 * 整步静默失败、GitCode 上永远没有 latest 镜像。所以 tag 一律不能叫 latest。
 */
if (TAG.toLowerCase() === 'latest') {
  console.error(
    '[gitcode][error] tag 不能叫 latest：GitCode 的 /releases/latest 是「最新 Release」别名，按 tag 寻址会打到别的 Release。\n' +
      '  请给 GitCode 侧换一个 tag（本仓库 main 分支镜像用 dev）。',
  );
  process.exit(1);
}

const repoUrl = `${API}/repos/${OWNER}/${REPO}`;
/**
 * 读 / 写 / 附件都按 tag 寻址。`/releases/{tag}` 与 `/releases/tags/{tag}` 在 GitCode 上都可用，
 * 前者是本仓库一直在用的形式，后者是官方文档与 space-ast/action-git-release 用的形式；
 * 这里两种都试，避免某一边悄悄下线。
 */
const releasePath = (base) => `${repoUrl}/releases/${encodeURIComponent(TAG)}`;
const releaseUrl = releasePath();
const tagPath = () => `${repoUrl}/releases/tags/${encodeURIComponent(TAG)}`;
const pageUrl = `https://gitcode.com/${OWNER}/${REPO}/releases/tag/${TAG}`;
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

/** 用 node:https 直连发字节（内置 fetch 有 300s headersTimeout，会掐断大附件上传）。 */
function putBytes(url, headers, body, { method = 'PUT', contentType, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`上传地址不是合法 URL：${err.message}`));
      return;
    }
    const mod = target.protocol === 'http:' ? http : https;
    const finalHeaders = { ...headers };
    if (contentType) finalHeaders['Content-Type'] = contentType;
    finalHeaders['Content-Length'] = String(body.length);
    const req = mod.request(
      target,
      {
        method,
        headers: finalHeaders,
        agent: false,
        timeout: 0, // 关掉 socket 空闲超时，改用下面的停滞检测
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          if (chunks.length < 16) chunks.push(chunk);
        });
        res.on('end', () => {
          finish();
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 600),
          });
        });
      },
    );

    const startedAt = Date.now();
    let lastMark = startedAt;
    let lastBytes = 0;
    let settled = false;
    const tick = setInterval(() => {
      const written = req.socket ? req.socket.bytesWritten : 0;
      const seconds = (Date.now() - startedAt) / 1000;
      const stalledFor = Date.now() - lastMark;
      if (written > lastBytes) {
        lastBytes = written;
        lastMark = Date.now();
      } else if (stalledFor > STALL_TIMEOUT_MS) {
        const err = new Error(`上传停滞超过 ${Math.round(STALL_TIMEOUT_MS / 60000)} 分钟，主动中断`);
        err.fatal = true;
        req.destroy(err);
        return;
      }
      if (onProgress) onProgress({ written, total: body.length, seconds, stalledFor });
    }, 15000);

    function finish() {
      settled = true;
      clearInterval(tick);
    }

    req.on('error', (err) => {
      finish();
      if (settled) return;
      reject(err);
    });
    req.end(body);
  });
}

/** multipart POST 回退：文档写 PUT，但社区示例里也有用表单直传的，400/405 时试一次。 */
async function postMultipart(url, headers, body, name) {
  const form = new FormData();
  form.append('file', new Blob([body]), name);
  const rest = { ...headers };
  // FormData 自己带 boundary，原签名里的 Content-Type 必须去掉，否则请求体解析失败
  delete rest['Content-Type'];
  delete rest['content-type'];
  const res = await fetch(url, { method: 'POST', headers: rest, body: form, signal: AbortSignal.timeout(60 * 60 * 1000) });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text.slice(0, 600) };
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

/**
 * 读取 Release。先试官方文档形式 `/releases/tags/{tag}`，404 再回退 `/releases/{tag}`。
 * 两者都不存在时返回 null（调用方决定是新建还是补传）。
 */
async function getRelease() {
  const variants = [tagPath(), releaseUrl];
  let lastErr = null;
  for (const base of variants) {
    try {
      const res = await request(withToken(`${base}?temp_download_url=false`), {}, { label: '回读 Release', attempts: 3 });
      return res.json();
    } catch (err) {
      if (err.status === 404) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  if (lastErr) return null;
  return null;
}

/** 正文里的 GitHub 下载直链（镜像页面上给 GitHub 链接，大陆用户点了还是下不动）。 */
const GITHUB_DL = /https:\/\/github\.com\/[^\s/()]+\/[^\s/()]+\/releases\/download\/[^\s/()]+\//g;

/**
 * 把说明里的 GitHub 直链换成本站直链。
 *
 * **只在创建 Release 时替换，不再上传完再 PATCH**：
 * - GitCode 的 PATCH 参数是 formData（官方文档），发 JSON 一直被拒；
 * - 更要紧的是，“上传完再动 Release”是上传之后唯一的写操作，附件被清掉的真实原因
 *   还没定性时，留着这一步等于给自己留一个无法排除的嫌疑人。
 */
function rewriteDownloadLinks(text) {
  if (!REWRITE_LINKS) return { text, hits: 0 };
  const hits = text.match(GITHUB_DL) || [];
  if (!hits.length) return { text, hits: 0 };
  return {
    text: text.replace(GITHUB_DL, `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/`),
    hits: hits.length,
  };
}

/**
 * Release 里**真正登记完成**的上传附件。
 *
 * 判据对照线上正常仓库（hust-open-atom-club/atomgit-cli）的返回结构：
 *   - 上传附件：{ type: "attach", id: 115467, size: 3166908, browser_download_url: ... }
 *   - 源码包：  { type: "source", name: "v0.3.zip", browser_download_url: ".../-/archive..." }
 * 因此 `type=attach`（或至少带数字 id 且不是 archive 链接）才算附件；源码包一律排除。
 */
const attachmentsOf = (release) =>
  (release?.assets || []).filter((a) => {
    if (a?.type === 'source') return false;
    if (String(a?.browser_download_url || '').includes('/-/archive/')) return false;
    if (a?.type === 'attach') return true;
    // 老返回里可能没有 type，靠 id 兜底
    return a?.id !== undefined && a?.id !== null;
  });

/** 找到某个已登记附件的记录（带 id / size 才算数）。 */
function findAttached(release, name) {
  return attachmentsOf(release).find((a) => a.name === name);
}

/**
 * 附件可用性核验。三条判据缺一不可，任一条不过就当作「没挂上」→ 换新签名地址重传。
 * 返回 { ok, detail }，detail 会写进日志与 step summary，方便下次不用猜。
 */
async function verifyAsset(name, size) {
  let release;
  try {
    release = await getRelease();
  } catch (err) {
    return { ok: false, detail: `回读 Release 失败：${err.message}` };
  }
  if (!release) return { ok: false, detail: 'Release 不存在' };

  const asset = findAttached(release, name);
  if (!asset) return { ok: false, detail: 'Release 附件列表里没有该文件（回调未登记）' };
  if (asset.id === undefined || asset.id === null) return { ok: false, detail: '附件没有 id（未登记完成）' };
  if (asset.size === undefined || asset.size === null || Number(asset.size) <= 0) {
    return { ok: false, detail: `附件没有 size（记录 id=${asset.id}，疑似只写了一半）` };
  }
  if (Number(asset.size) !== size) {
    return { ok: false, detail: `附件 size=${asset.size} 与本地 ${size} 不一致` };
  }

  if (!VERIFY_DOWNLOAD) return { ok: true, detail: `id=${asset.id} size=${asset.size}（未做下载核验）` };

  // 真的把字节读回来：这一步才等价于「用户点下载能拿到东西」
  const url = `${releaseUrl}/attach_files/${encodeURIComponent(name)}/download`;
  try {
    const res = await fetch(withToken(url), {
      headers: { Range: `bytes=0-${DOWNLOAD_PROBE_BYTES - 1}` },
      signal: AbortSignal.timeout(180000),
      redirect: 'follow',
    });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return { ok: false, detail: `下载核验失败：HTTP ${res.status}（附件记录在但取不到内容）` };
    }
    const total = (() => {
      const range = res.headers.get('content-range');
      const m = range && /\/(\d+)$/.exec(range);
      if (m) return Number(m[1]);
      const len = res.headers.get('content-length');
      if (res.status === 206 && !m) return null;
      return len ? Number(len) : null;
    })();
    await res.body?.cancel?.().catch(() => {});
    if (total !== null && Number.isFinite(total) && total !== size) {
      return { ok: false, detail: `下载核验失败：远端 ${total} 字节，本地 ${size} 字节` };
    }
    return { ok: true, detail: `id=${asset.id} size=${asset.size} 下载核验通过` };
  } catch (err) {
    return { ok: false, detail: `下载核验异常：${err.message}` };
  }
}

/**
 * 按分钟时点回读附件（探针模式）。
 *
 * 这一段的唯一目的，是把「上传完就绿、几小时后页面只剩源码包」变成可测数据：
 * 每个时点打印附件的 name/size/id，谁在什么时候消失一目了然。
 */
async function runVerificationSchedule() {
  const startedAt = Date.now();
  for (const minutes of VERIFY_MINUTES) {
    const waitMs = startedAt + minutes * 60_000 - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    try {
      const release = await getRelease();
      const attached = attachmentsOf(release);
      const detail =
        attached.map((a) => `${a.name}(${a.size ?? '?'}B,id=${a.id ?? '-'})`).join('、') || '（无）';
      note(`T+${minutes}min 上传附件 ${attached.length} 个：${detail}`);
    } catch (err) {
      note(`T+${minutes}min 回读失败：${err.message}`);
    }
  }
}

async function main() {
  report.releaseUrl = pageUrl;

  // 只读复核：不建、不传、不删，只按 VERIFY_MINUTES 的时点回读附件。
  if (OBSERVE_TAG) {
    note(`只读复核 ${OWNER}/${REPO} 的 tag=${TAG}（不建、不传、不删）`);
    await runVerificationSchedule();
    return;
  }

  note(`目标仓库 ${OWNER}/${REPO}，tag=${TAG}，预发布=${PRERELEASE}，附件 ${ASSETS.length} 个`);

  // 0) 只读诊断：不打任何写操作，用来确认权限、tag、上传地址是否正常
  if (DIAG) {
    try {
      const repoRes = await request(withToken(repoUrl), {}, { label: '读取仓库', attempts: 2 });
      const repoInfo = await repoRes.json().catch(() => ({}));
      note(`仓库可见：${repoInfo?.path_with_namespace || repoInfo?.full_name || `${OWNER}/${REPO}`}`);
    } catch (err) {
      note(`读取仓库失败：${err.message}`);
    }
    try {
      const release = await getRelease();
      note(
        release
          ? `Release 存在：上传附件 ${attachmentsOf(release).length} 个（源码包 ${(release.assets || []).length - attachmentsOf(release).length} 个）`
          : 'Release 不存在（首次发布时会新建）',
      );
      for (const a of attachmentsOf(release || {})) note(`  已有附件：${a.name} size=${a.size ?? '?'} id=${a.id ?? '-'}`);
    } catch (err) {
      note(`Release 读取失败（${err.status || '?'}）：${err.message}`);
    }
    for (const file of ASSETS) {
      const name = path.basename(file);
      try {
        const res = await request(
          withToken(`${releaseUrl}/upload_url?file_name=${encodeURIComponent(name)}`),
          {},
          { label: `${name} 获取上传地址`, attempts: 2 },
        );
        const sign = await res.json();
        const host = sign?.url ? new URL(sign.url).host : '(无)';
        note(`上传地址 OK：${name} → ${host}，header 键：${Object.keys(sign?.headers || {}).join(', ') || '(空)'}`);
      } catch (err) {
        note(`上传地址失败：${name} → ${err.message}`);
      }
    }
    return;
  }

  const rawBody = await readBody();
  const { text: body, hits: linkHits } = rewriteDownloadLinks(rawBody);
  if (linkHits) note(`发布说明里的 ${linkHits} 条 GitHub 下载直链将写成本站直链`);
  const payload = {
    tag_name: TAG,
    name: RELEASE_NAME,
    body,
    release_status: PRERELEASE ? 'pre' : 'latest',
  };

  if (DRY_RUN) {
    note(`[dry-run] POST ${repoUrl}/releases ${JSON.stringify({ ...payload, body: `<${body.length} 字符>` })}`);
    for (const file of ASSETS) note(`[dry-run] 上传 ${file}`);
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

  // 2) 已存在同名 Release：默认先删后建（附件名每次构建都一样，重建最省事）；
  //    NO_RECREATE=1 时只补传缺失附件，保留原说明（修复 workflow 用这个）。
  let existing = null;
  try {
    existing = await getRelease();
  } catch (err) {
    if (err.status !== 404) {
      if (isImageRepoError(err)) throw new Error(MIRROR_REPO_HINT);
      throw err;
    }
  }

  if (existing) {
    if (NO_RECREATE) {
      note(`Release ${TAG} 已存在，NO_RECREATE=1：跳过删除/重建，只补传缺失附件`);
    } else {
      note(`Release ${TAG} 已存在，先删除（含旧附件）`);
      try {
        await request(withToken(releaseUrl), { method: 'DELETE' }, { label: '删除已有 Release', attempts: 2 });
        existing = null;
      } catch (err) {
        if (isImageRepoError(err)) throw new Error(MIRROR_REPO_HINT);
        throw err;
      }
    }
  }

  // 3) 创建 Release。tag 尚未在 GitCode 存在时，必须带 target_commitish 让平台自己建 tag，
  //    所以从第一次请求就带上（旧版只在重试时才带，latest 这类移动 tag 常常第一次就 400）。
  let createdHere = false;
  if (!existing) {
    const postRelease = (extra = {}) =>
      request(
        withToken(`${repoUrl}/releases`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, ...extra }),
        },
        { label: '创建 Release', attempts: 2 },
      );

    try {
      const created = await postRelease(TARGET_COMMITISH ? { target_commitish: TARGET_COMMITISH } : {});
      createdHere = true;
      note(`Release ${TAG} 已创建（HTTP ${created.status}）`);
    } catch (err) {
      if (isImageRepoError(err)) throw new Error(MIRROR_REPO_HINT);
      note(`创建 Release 失败：${err.message}`);
      throw err;
    }
  }

  // 4) 逐个上传附件：先取预签名地址，再 PUT 原始字节，最后**下载核验**真的可用
  for (const [index, file] of ASSETS.entries()) {
    const name = path.basename(file);
    const tagText = `[${index + 1}/${ASSETS.length}] ${name}`;
    const entry = { name, size: 0, seconds: 0, attempts: 0, status: 'pending', detail: '' };
    report.files.push(entry);

    let bytes;
    try {
      bytes = await fs.readFile(file);
      entry.size = bytes.length;
    } catch (err) {
      entry.status = 'failed';
      entry.detail = `读取失败：${err.message}`;
      warn(`${tagText} ${entry.detail}`);
      continue;
    }

    // 修复模式 / 重跑：已经在且可用的附件不必再传一遍（跨境链路很贵）
    if (NO_RECREATE) {
      const pre = await verifyAsset(name, entry.size).catch(() => ({ ok: false, detail: '' }));
      if (pre.ok) {
        entry.status = 'ok';
        entry.detail = `已存在，跳过（${pre.detail}）`;
        note(`${tagText} 已存在且可用，跳过上传（${pre.detail}）`);
        continue;
      }
    }

    note(`${tagText} 开始上传（${(entry.size / 1048576).toFixed(1)} MB）`);
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
      entry.attempts = attempt;
      try {
        const signRes = await request(
          withToken(`${releaseUrl}/upload_url?file_name=${encodeURIComponent(name)}`),
          {},
          { label: `${name} 获取上传地址`, attempts: 3 },
        );
        const sign = await signRes.json();
        if (!sign?.url) throw new Error(`上传地址响应异常：${JSON.stringify(sign).slice(0, 200)}`);

        let putRes = await putBytes(sign.url, sign.headers || {}, bytes, {
          onProgress: ({ written, seconds }) => {
            if (seconds < 15) return;
            const pct = ((written / entry.size) * 100).toFixed(0);
            log(
              `${tagText} 上传中 ${pct}%（${(written / 1048576).toFixed(1)}/${(entry.size / 1048576).toFixed(1)} MB，${seconds.toFixed(0)}s）`,
            );
          },
        });

        // 文档写 PUT，社区示例里也有表单直传；400/405 说明这条地址不吃 PUT，换 POST 再试
        if (putRes.status === 400 || putRes.status === 405) {
          warn(`${tagText} PUT 返回 ${putRes.status}，回退为 multipart POST`);
          putRes = await postMultipart(sign.url, sign.headers || {}, bytes, name);
        }

        // 203 = 对象写进 OBS 了，但平台回调没成功 → 附件不会出现在 Release 里，必须重传
        if (putRes.status === 203) throw new Error(`PUT HTTP 203（对象已写入但平台回调未登记）：${putRes.body}`);
        if (putRes.status < 200 || putRes.status >= 300) throw new Error(`PUT HTTP ${putRes.status}：${putRes.body}`);

        // 关键：名称出现在列表里 ≠ 附件可用。等一秒让回调落库，再按 id/size/下载 三条核验。
        let verdict = await verifyAsset(name, entry.size);
        if (!verdict.ok) {
          await sleep(3000);
          verdict = await verifyAsset(name, entry.size);
        }
        if (!verdict.ok) throw new Error(verdict.detail);

        entry.status = 'ok';
        entry.detail = verdict.detail;
        entry.seconds = (Date.now() - startedAt) / 1000;
        note(
          `${tagText} 上传完成并核验通过（${verdict.detail}），用时 ${entry.seconds.toFixed(1)}s（${(entry.size / 1048576 / entry.seconds).toFixed(2)} MB/s）`,
        );
        break;
      } catch (err) {
        entry.status = 'failed';
        entry.detail = err.message;
        warn(`${tagText} 第 ${attempt}/${UPLOAD_ATTEMPTS} 次失败：${err.message}`);
        if (err.fatal) break;
        if (attempt < UPLOAD_ATTEMPTS) await sleep(attempt * 5000);
      }
    }
  }

  // 5) 最终回读，产出大陆下载地址（正文已在创建时写好，这里不再 PATCH）

  let release = null;
  try {
    release = await getRelease();
  } catch (err) {
    warn(`回读 Release 失败：${err.message}`);
  }
  const uploaded = new Set(attachmentsOf(release).map((a) => a.name));
  // 「核验通过」才是真的挂上了：只出现在列表里、没有 size 的那种中间态不算数
  const verified = report.files.filter((f) => f.status === 'ok').length;
  const links = [];
  const missing = [];
  for (const entry of report.files) {
    // 两条都要：本地核验通过 + 远端确实还在（防「传完被平台清掉」）
    if (entry.status !== 'ok' || (release && !uploaded.has(entry.name))) {
      missing.push(entry.name);
      continue;
    }
    const found = attachmentsOf(release || {}).find((a) => a.name === entry.name);
    links.push(
      found?.browser_download_url ||
        `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${encodeURIComponent(entry.name)}`,
    );
  }

  note(`GitCode Release 页面：${pageUrl}`);
  for (const link of links) note(`下载：${link}`);
  if (missing.length) note(`未出现在 Release 里：${missing.join('、')}`);  if (release) {
    note(
      `远端附件实况：${attachmentsOf(release).length} 个上传附件 + ${(release.assets || []).length - attachmentsOf(release).length} 个源码包`,
    );
  }
  if (VERIFY_MINUTES.length) await runVerificationSchedule();
  if (PROBE_MODE) {
    note('PROBE_MODE=1：只观测不裁决，附件缺失不影响退出码');
    return;
  }
  if (missing.length) {
    note(
      `失败详情：${report.files
        .filter((f) => missing.includes(f.name))
        .map((f) => `${f.name}（${f.detail || '未知原因'}）`)
        .join('；')}`,
    );
    // 空壳 Release 比没有 Release 更误导：页面上只剩 4 个自动生成的源码包，
    // 用户会以为这个项目不发二进制。只在「本次新建 + 回读成功 + 一个都没挂上」时删；
    // 部分成功保留（已挂上的附件仍可用），回读失败也保留（避免误删其实传成功的）。
    if (createdHere && release && !KEEP_EMPTY_RELEASE && verified === 0) {
      try {
        await request(withToken(releaseUrl), { method: 'DELETE' }, { label: '删除空 Release', attempts: 2 });
        note(`一个附件都没挂上，已删除空 Release ${TAG}（避免页面只剩源码包；KEEP_EMPTY_RELEASE=1 可保留）`);
      } catch (err) {
        warn(`删除空 Release 失败（请到 GitCode 手动删）：${err.message}`);
      }
    }
    throw new Error(`${missing.length} 个附件未同步：${missing.join('、')}`);
  }
  note('全部附件同步完成');
}

async function writeSummary() {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    `## GitCode（大陆镜像）Release ${TAG}`,
    '',
    `- 版本页：${pageUrl}`,
    ...report.steps.filter((s) => /下载：|未出现|远端附件|目标仓库|T\+\d+min/.test(s)).map((s) => `- ${s}`),
  ];
  if (report.files.length) {
    lines.push('', '| 附件 | 大小 | 次数 | 耗时 | 结果 |', '| --- | --- | --- | --- | --- |');
    for (const f of report.files) {
      const size = f.size ? `${(f.size / 1048576).toFixed(1)} MB` : '-';
      const took = f.seconds ? `${f.seconds.toFixed(0)}s` : '-';
      const result = f.status === 'ok' ? `✅ ${f.detail || '已上传'}` : `❌ ${f.detail || '失败'}`;
      lines.push(`| ${f.name} | ${size} | ${f.attempts} | ${took} | ${result} |`);
    }
  }
  if (report.error) lines.push('', '```', report.error, '```');
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`).catch(() => {});
}

main()
  .catch(async (err) => {
    report.error = err?.message || String(err);
    console.error('[gitcode][error]', report.error);
    process.exitCode = 1;
  })
  .finally(writeSummary);
