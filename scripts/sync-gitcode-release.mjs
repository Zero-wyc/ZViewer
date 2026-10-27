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
 *   DIAG                 1 = 只读诊断：打印仓库/Release/上传地址结构，不写任何东西
 *   UPLOAD_ATTEMPTS      单个附件最多尝试次数（含首次），默认 3
 *
 * 行为：Release 已存在时**不删不重建**（GitCode 没有删 Release 的 API，DELETE 会 405），
 * 只把同名附件先删后传，保证页面上每个名字只有一份、且是本次构建的产物。
 * 任一附件失败都不影响其它附件，最终有失败则以退出码 1 结束。
 *
 * === 历史坑（2026-10-26 修）===
 * 旧版用内置 fetch 做附件 PUT，结果**每个 Release 都只剩 source code、一个附件都没有**：
 * undici 的 fetch 有 300s 的 `headersTimeout`，它从请求发出就开始计时、**不等请求体发完**。
 * GitHub runner → 华为云 OBS 这条跨境链路实测只有 ~100KB/s，36MB 的包根本传不完 300s，
 * 稳定在 ~301s 被掐断（`TypeError: fetch failed` / UND_ERR_HEADERS_TIMEOUT）。
 * 现在改为 `node:https` 直连 PUT：socket 不设空闲超时，只保留「10 分钟无进展」的停滞检测，
 * 并且**每传完一个附件都回读 Release 校验真的挂上了**，校验不过就重传、最终失败会让整步标红。
 *
 * 还有一个同源的症状：Release 是**先创建、后上传**的，所以上传全挂时平台上会留下一个
 * 「只有 source code」的 Release——用户看到的就是「这个项目不发二进制」。GitCode 没有
 * 删 Release 的接口（DELETE 返回 405），这种情况只能重跑补传，脚本会把缺失的列出来。
 *
 * === 2026-10-27 修：不再「先删后建」===
 * 旧版检测到同名 Release 就直接 DELETE /releases/{tag}，实测 GitCode 一律回 405
 * METHOD_NOT_ALLOWED，于是手动/自动同步凡是遇到「Release 已存在」就整步失败。
 * 现在改成保留 Release、对同名附件做「先删后传」（DELETE /releases/{tag}/attach_files/{id}），
 * 既保证页面上每个名字只有一份、是本次构建的产物，也不会出现「删掉后传不上去」的空窗。
 *
 * === 探针模式（PROBE_MODE=1）===
 * v5.0.5 这次运行是**绿色**的（脚本最终回读确实看到 3 个附件），但几小时后 API 与页面
 * 都只剩 4 个源码包。也就是说：上传链路没问题，是「传完之后被清掉」。
 * 光看一次运行结束时的状态永远发现不了这种问题，所以加 `VERIFY_MINUTES=0,1,5,15,25`：
 * 按分钟时点回读并打印附件 name/size/id，配合 `PROBE_MODE=1` 只观测、不让 job 失败。
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
const DIAG = ['1', 'true', 'yes'].includes((process.env.DIAG || '').toLowerCase());
// 默认把正文里的 GitHub 下载直链改写成 GitCode 直链（镜像页面上给 GitHub 链接等于没给）
const REWRITE_LINKS = !['0', 'false', 'no'].includes((process.env.REWRITE_GITHUB_LINKS || '1').toLowerCase());
const UPLOAD_ATTEMPTS = Math.max(1, Number(process.env.UPLOAD_ATTEMPTS || 3) || 3);
/**
 * 探针模式：只观测不裁决。上传结束后按 VERIFY_MINUTES 的时点回读附件，
 * 用来判断附件是「当时就在」还是「过一段时间被平台清理」——线上反复出现
 * 「job 绿、页面只有源码包」，就是缺这一步观测。
 */
const PROBE_MODE = ['1', 'true', 'yes'].includes((process.env.PROBE_MODE || '').toLowerCase());
const VERIFY_MINUTES = (process.env.VERIFY_MINUTES || (OBSERVE_TAG ? '0' : ''))
  .split(/[\s,]+/)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n >= 0);
const ASSETS = (process.env.ASSETS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/** 单次上传允许「无任何进展」多久（毫秒）。跨境慢链路给足余量，真卡死才中断。 */
const STALL_TIMEOUT_MS = 10 * 60 * 1000;

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
const releaseUrl = `${repoUrl}/releases/${encodeURIComponent(TAG)}`;
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

/** 用 node:https 直连 PUT 字节（内置 fetch 有 300s headersTimeout，会掐断大附件上传）。 */
function putBytes(url, headers, body, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`上传地址不是合法 URL：${err.message}`));
      return;
    }
    const mod = target.protocol === 'http:' ? http : https;
    const req = mod.request(
      target,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Length': String(body.length) },
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

async function readBody() {
  if (!BODY_FILE) return `由 GitHub Actions 自动同步的 ${TAG} 构建。`;
  try {
    return await fs.readFile(BODY_FILE, 'utf8');
  } catch {
    warn(`读取说明文件失败（${BODY_FILE}），使用占位说明`);
    return `由 GitHub Actions 自动同步的 ${TAG} 构建。`;
  }
}

async function getRelease() {
  const res = await request(withToken(`${releaseUrl}?temp_download_url=false`), {}, { label: '回读 Release', attempts: 3 });
  return res.json();
}

/** 正文里的 GitHub 下载直链（镜像页面上给 GitHub 链接，大陆用户点了还是下不动）。 */
const GITHUB_DL = /https:\/\/github\.com\/[^\s/()]+\/[^\s/()]+\/releases\/download\/[^\s/()]+\//g;

/**
 * 把说明里的 GitHub 直链换成本站直链。
 *
 * **只在创建 Release 时替换，不再上传完再 PATCH**：
 * - GitCode 的 PATCH 参数是 formData（官方文档），发 JSON 一直被拒，脚本又只 warn，
 *   所以这条改写从来没生效过（线上正文至今仍是 GitHub 链接）。
 * - 更要紧的是，“上传完再动 Release”是上传之后唯一的写操作。附件被清掉的真实原因
 *   还没定性，留着这一步等于给自己留一个无法排除的嫌疑人。
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

/** Release 里真正上传的附件；`type: source` 是 GitCode 自动生成的四个源码包。 */
const attachmentsOf = (release) => (release?.assets || []).filter((a) => a.type !== 'source');

async function isAttached(name) {
  const release = await getRelease();
  return attachmentsOf(release).some((a) => a.name === name);
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
      const detail = attached.map((a) => `${a.name}(${a.size ?? '?'}B,id=${a.id ?? '-'})`).join('、') || '（无）';
      note(`T+${minutes}min 上传附件 ${attached.length} 个：${detail}`);
    } catch (err) {
      note(`T+${minutes}min 回读失败：${err.message}`);
    }
  }
}

async function main() {
  report.releaseUrl = pageUrl;

  // 只读复核：不建、不传、不删，只按 VERIFY_MINUTES 的时点回读附件。
  // 与 PROBE_MODE 的区别——它是「上传完再跟踪」，这里是「几小时后再来看一眼」。
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
      note(`仓库可见：${repoInfo?.path_with_namespace || `${OWNER}/${REPO}`}`);
    } catch (err) {
      note(`读取仓库失败：${err.message}`);
    }
    try {
      const release = await getRelease();
      note(`Release 存在：附件 ${attachmentsOf(release).length} 个（源码包 ${(release.assets || []).length - attachmentsOf(release).length} 个）`);
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

  // 2) 同名 Release 已存在就复用：GitCode 没有删 Release 的接口，DELETE 会 405，
  //    所以「先删后建」这条路在本平台行不通，只能在附件层面覆盖。
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
    note(`Release ${TAG} 已存在：保留 Release，稍后按附件名覆盖`);
  }

  // 3) 创建 Release。tag 尚未在 GitCode 存在时，必须带 target_commitish 让平台自己建 tag，
  //    所以从第一次请求就带上（旧版只在重试时才带，latest 这类移动 tag 常常第一次就 400）。
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
      note(`Release ${TAG} 已创建（HTTP ${created.status}）`);
    } catch (err) {
      if (isImageRepoError(err)) throw new Error(MIRROR_REPO_HINT);
      note(`创建 Release 失败：${err.message}`);
      throw err;
    }
  }

  // 4) 同名附件先删后传。GitCode 删不了 Release，只能删附件；不删的话同名文件会叠加，
  //    而且回读校验会被旧文件蒙混过关（PUT 失败也看起来「已挂上」）。
  if (existing) {
    const wanted = new Set(ASSETS.map((file) => path.basename(file)));
    for (const asset of attachmentsOf(existing)) {
      if (asset.id == null || !wanted.has(asset.name)) continue;
      try {
        await request(
          withToken(`${releaseUrl}/attach_files/${encodeURIComponent(asset.id)}`),
          { method: 'DELETE' },
          { label: `删除旧附件 ${asset.name}`, attempts: 2 },
        );
        note(`已删除旧附件 ${asset.name}（id=${asset.id}），随后重传`);
      } catch (err) {
        warn(`删除旧附件 ${asset.name} 失败（${err.message}），继续上传（页面上可能短暂出现同名两份）`);
      }
    }
  }

  // 5) 逐个上传附件：先取预签名地址，再 PUT 原始字节，最后回读校验真的挂上了
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

        const putRes = await putBytes(sign.url, sign.headers || {}, bytes, {
          onProgress: ({ written, seconds }) => {
            if (seconds < 15) return;
            const pct = ((written / entry.size) * 100).toFixed(0);
            log(`${tagText} 上传中 ${pct}%（${(written / 1048576).toFixed(1)}/${(entry.size / 1048576).toFixed(1)} MB，${seconds.toFixed(0)}s）`);
          },
        });

        // 203 = 对象写进 OBS 了，但平台回调没成功 → 附件不会出现在 Release 里，必须重传
        if (putRes.status === 203) throw new Error(`PUT HTTP 203（对象已写入但平台回调未登记）：${putRes.body}`);
        if (putRes.status < 200 || putRes.status >= 300) throw new Error(`PUT HTTP ${putRes.status}：${putRes.body}`);

        // 回读校验：PUT 成功 ≠ 附件挂上（回调丢失时就是这样，旧版因此静默零附件）
        let ok = await isAttached(name);
        if (!ok) {
          await sleep(3000);
          ok = await isAttached(name);
        }
        if (!ok) throw new Error('PUT 成功但 Release 附件列表里没有该文件（回调未登记）');

        entry.status = 'ok';
        entry.seconds = (Date.now() - startedAt) / 1000;
        note(
          `${tagText} 上传完成并已挂到 Release，用时 ${entry.seconds.toFixed(1)}s（${(entry.size / 1048576 / entry.seconds).toFixed(2)} MB/s）`,
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

  // 6) 最终回读，产出大陆下载地址（正文已在创建时写好，这里不再 PATCH）

  let release = null;
  try {
    release = await getRelease();
  } catch (err) {
    warn(`回读 Release 失败：${err.message}`);
  }
  const uploaded = new Set(attachmentsOf(release).map((a) => a.name));
  const links = [];
  const missing = [];
  for (const entry of report.files) {
    // 以远端实况为准：远端没有就算失败，不再「乐观输出」
    if (release ? !uploaded.has(entry.name) : entry.status !== 'ok') {
      missing.push(entry.name);
      continue;
    }
    const found = attachmentsOf(release).find((a) => a.name === entry.name);
    links.push(found?.browser_download_url || `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${encodeURIComponent(entry.name)}`);
  }

  note(`GitCode Release 页面：${pageUrl}`);
  for (const link of links) note(`下载：${link}`);
  if (missing.length) note(`未出现在 Release 里：${missing.join('、')}`);
  if (release) {
    note(`远端附件实况：${attachmentsOf(release).length} 个上传附件 + ${(release.assets || []).length - attachmentsOf(release).length} 个源码包`);
  }
  if (VERIFY_MINUTES.length) await runVerificationSchedule();
  if (PROBE_MODE) {
    note('PROBE_MODE=1：只观测不裁决，附件缺失不影响退出码');
    return;
  }
  if (missing.length) {
    note(`失败详情：${report.files.filter((f) => missing.includes(f.name)).map((f) => `${f.name}（${f.detail || '未知原因'}）`).join('；')}`);
    // GitCode 删不了 Release（DELETE 405），「只有源码包」的空壳只能靠重跑补传。
    if (release && uploaded.size === 0) {
      note(`Release ${TAG} 目前一个附件都没有（页面只剩源码包），重跑本 workflow 即可补传`);
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
      const result = f.status === 'ok' ? '✅ 已上传' : `❌ ${f.detail || '失败'}`;
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
