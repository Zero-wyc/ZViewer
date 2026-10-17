import { spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import { getSystemSettings } from '../system-settings';
import {
  APPLY_UPDATE_BAT_TEMPLATE,
  APPLY_UPDATE_SH_TEMPLATE,
  renderTemplate,
  SH_APPLY_DOCKER,
  SH_APPLY_LINUX,
  SH_FINISH_DOCKER,
  SH_FINISH_LINUX,
  SH_STOP_DOCKER,
  SH_STOP_LINUX,
} from './script-templates';

const REPO_OWNER = 'Zero-wyc';
const REPO_NAME = 'ZViewer';

/** CDN 加速配置，由调用方从 SystemSettings 读取后传入 */
interface CdnConfig {
  /** CDN 代理地址（含协议前缀），如 https://gh-proxy.com */
  proxyUrl: string;
}

/**
 * 将 GitHub 相关 URL 应用 CDN 代理前缀。
 *
 * gh-proxy.com 等代理的使用方式是在原始 URL 前加上代理地址：
 *   https://api.github.com/repos/...  →  https://gh-proxy.com/https://api.github.com/repos/...
 *   https://github.com/.../releases/download/...  →  https://gh-proxy.com/https://github.com/.../releases/download/...
 *
 * @param url 原始 URL
 * @param proxyUrl CDN 代理地址（如 https://gh-proxy.com）
 * @returns 加速后的 URL（非 GitHub URL 或已加前缀时返回原 URL）
 */
function applyCdnToUrl(url: string, proxyUrl: string): string {
  if (!proxyUrl) return url;
  const prefix = proxyUrl.replace(/\/+$/, '');
  // 已有代理前缀则不重复添加
  if (url.startsWith(prefix + '/')) return url;
  try {
    const parsed = new URL(url);
    const githubHosts = [
      'api.github.com',
      'github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
    ];
    if (githubHosts.includes(parsed.hostname)) {
      return `${prefix}/${url}`;
    }
    return url;
  } catch {
    return url;
  }
}

export interface UpdateInfo {
  currentVersion: string;
  remoteVersion: string;
  hasUpdate: boolean;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  downloadUrl: string;
  isPrerelease: boolean;
  assetName: string;
  assetSize: number;
}

/**
 * 判断当前运行环境是单文件版本（pkg 打包）还是 Node.js 开发模式。
 */
function isPkg(): boolean {
  return !!process.pkg;
}

/**
 * 检测是否运行在 Docker 容器内。
 *
 * Docker 容器内会存在 /.dockerenv 文件，且 cgroup 通常包含 docker / containerd 字样。
 * 容器环境下的更新流程与单文件版本不同：
 * - 单文件版：下载解压 → 生成更新脚本覆盖文件 → 脚本重启进程
 * - Docker 版：容器内文件系统是临时的（重启即丢失），必须通过镜像更新或挂载持久化目录实现。
 *   本应用 Docker 更新采用「容器内就地替换 + 退出进程触发容器重启」策略，
 *   前提是 docker run 时配置了 --restart=always 或同等 restart policy。
 */
function isDocker(): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods/.test(cgroup)) return true;
  } catch {
    // 忽略读取错误
  }
  return false;
}

function projectRoot(): string {
  if (isPkg()) {
    // pkg 打包后 __dirname 指向虚拟文件系统（只读 snapshot），
    // 使用 process.execPath 定位可执行文件所在目录。
    // 比 process.cwd() 更可靠：cwd 可能因启动方式不同而变化
    // （如 systemd、绝对路径启动、符号链接等），而 execPath 始终指向可执行文件本身。
    // Docker 中：process.execPath = /app/zviewer-backend → 返回 /app
    // Linux 单文件：process.execPath = /path/to/zviewer-backend → 返回 /path/to
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..', '..', '..', '..');
}

/**
 * 获取当前平台对应的构建产物名称。
 */
function getPlatformAssetName(): string {
  return os.platform() === 'win32'
    ? 'zviewer-windows-x64.zip'
    : 'zviewer-linux-x64.tar.gz';
}

/**
 * HTTPS GET JSON — 请求 GitHub API（直连，不走 CDN 代理）。
 *
 * 检查更新走直连 GitHub API，避免 gh-proxy.com 等代理转发 API 请求时
 * 因共享 IP/账号触发 GitHub API 速率限制（403 rate limit exceeded）。
 * CDN 代理仅用于 release 文件下载（见 downloadFile）。
 */
function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ZViewer-Updater',
          Accept: 'application/vnd.github+json',
        },
        timeout: 30_000,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          // 重定向跟随
          httpsGetJson<T>(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (err) {
            reject(new Error(`解析响应失败: ${String(err)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * 获取本地版本号。
 *
 * 单文件版本（pkg）从同目录的 package.json 读取；
 * 开发模式从项目根目录的 package.json 读取。
 *
 * CI 构建时会注入版本号：
 * - tag 推送 (v*)：版本号为 tag 名（如 1.0.0）
 * - main 分支推送：版本号为 0.0.0-dev.<sha前7位>
 */
export function getLocalVersion(): string {
  const root = projectRoot();
  const pkgPath = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(
      fs.readFileSync(pkgPath, 'utf8'),
    ) as { version?: string };
    const version = pkg.version || '0.0.0';
    console.log(`[updater] 本地版本: ${version} (读取自 ${pkgPath})`);
    return version;
  } catch (err) {
    console.warn(
      `[updater] 读取版本号失败: ${pkgPath} - ${err instanceof Error ? err.message : String(err)}`,
    );
    return '0.0.0';
  }
}

/**
 * 判断版本号是否为开发版本（0.0.0-dev.xxx 格式）。
 */
function isDevVersion(version: string): boolean {
  return version.startsWith('0.0.0-dev.');
}

/**
 * 比较语义化版本号 a.b.c（支持 prerelease 后缀，如 1.2.0-beta.1）。
 * 返回 >0 表示 a>b，<0 表示 a<b，0 表示相等。
 * 遵循 semver 规则：同数值版本下，无 prerelease 者更新（1.2.0 > 1.2.0-beta.1）；
 * 两个 prerelease 按后缀字典序比较。
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const normalized = v.replace(/^v/, '');
    // 拆出 prerelease 后缀（1.2.0-beta.1 → 数值核 1.2.0 + pre 'beta.1'），
    // 避免 Number('0-beta') 产生 NaN 被静默当 0 处理。
    const dashIdx = normalized.indexOf('-');
    const core = dashIdx === -1 ? normalized : normalized.slice(0, dashIdx);
    const pre = dashIdx === -1 ? '' : normalized.slice(dashIdx + 1);
    return { parts: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const va = pa.parts[i] || 0;
    const vb = pb.parts[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) {
    if (pa.pre > pb.pre) return 1;
    if (pa.pre < pb.pre) return -1;
  }
  return 0;
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

/**
 * 从 GitHub Releases 检查更新。
 *
 * 版本判断策略：
 *
 * 1. 正式版（!prerelease）：
 *    - 用 tag_name（如 v1.0.0）与本地版本做语义化比较
 *    - 如果本地是开发版本（0.0.0-dev.xxx），正式版总是"有更新"
 *
 * 2. 预发布版（prerelease，tag: latest）：
 *    - 仅当 includePrerelease=true 时才考虑
 *    - tag_name 为 `latest`，无法做语义化比较
 *
 * 整体逻辑：
 * - includePrerelease=false：只在正式版之间更新，忽略所有预发布版
 * - includePrerelease=true：始终使用最新构建版本（releases 列表第一条，
 *   GitHub API 按 created_at 降序返回；无论其 prerelease 标志，
 *   main 分支 CI 构建的 latest 预发布或正式版发布都算）
 * - 本地版本 0.0.0（无法确定）→ 总是提示有更新
 */
export async function getUpdateInfo(
  includePrerelease = false,
): Promise<UpdateInfo> {
  const currentVersion = getLocalVersion();
  const assetName = getPlatformAssetName();

  // 读取 CDN 加速配置
  const settings = await getSystemSettings();
  const cdnConfig: CdnConfig | undefined = settings.cdnAccelerate
    ? { proxyUrl: settings.cdnProxyUrl || 'https://gh-proxy.com' }
    : undefined;

  // 检查更新：直连 GitHub API，不走 CDN 代理。
  // 原因：gh-proxy.com 等代理转发 api.github.com 时使用代理自身的 GitHub 账号/IP，
  // 多用户共用易触发 GitHub API 速率限制（403 rate limit exceeded）。
  // CDN 代理仅用于 release 文件下载（下载不受 API 限制）。
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=10`;

  // 获取 releases 列表（包含正式版和预发布版）
  const releases = await httpsGetJson<GithubRelease[]>(apiUrl);

  if (!releases || releases.length === 0) {
    throw new Error('未找到任何发布版本');
  }

  let release: GithubRelease;
  let hasUpdate: boolean;

  if (includePrerelease) {
    // 预发布模式：始终使用最新构建版本。
    // GitHub Releases API 按 created_at 降序返回，releases[0] 即最新一次构建
    // （main 分支 CI 推送的 latest 预发布，或正式版发布，无论 prerelease 标志）。
    // 旧逻辑「优先正式版，无正式版更新才看预发布」会导致 dev 构建永远
    // 更新到旧的正式版，拿不到最新的 main 分支产物。
    release = releases[0];

    if (currentVersion === '0.0.0' || isDevVersion(currentVersion)) {
      // 本地版本无法确定，或本地是 dev 构建：预发布 tag 为 latest
      // 无法语义化比较，保守提示有更新（应用更新会重新安装最新产物）
      hasUpdate = true;
    } else if (release.prerelease) {
      // 本地是正式版而最新构建是预发布版（tag: latest，无法语义化比较）：
      // 用户开启预发布即为跟随最新构建 → 提示有更新
      hasUpdate = true;
    } else {
      // 本地与最新构建都是正式版 → 语义化版本比较
      hasUpdate = compareVersions(release.tag_name, currentVersion) > 0;
    }
  } else {
    // 正式版模式：只在正式版之间更新
    const stableRelease = releases.find((r) => !r.prerelease);

    if (currentVersion === '0.0.0') {
      // 本地版本无法确定 → 总是提示有更新
      release = stableRelease || releases[0];
      hasUpdate = true;
    } else if (stableRelease) {
      release = stableRelease;
      if (isDevVersion(currentVersion)) {
        // 本地是开发版本 → 正式版总是有更新
        hasUpdate = true;
      } else {
        // 本地也是正式版 → 语义化版本比较
        hasUpdate = compareVersions(stableRelease.tag_name, currentVersion) > 0;
      }
    } else {
      // 没有任何正式版 Release：使用第一个 release 作为信息来源，
      // 但不提示有更新（用户未开启预发布，不引导安装预发布版）
      release = releases[0];
      hasUpdate = false;
    }
  }

  const remoteVersion = release.tag_name;
  const asset = release.assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(
      `Release ${remoteVersion} 中未找到平台对应的构建产物 ${assetName}`,
    );
  }

  return {
    currentVersion,
    remoteVersion,
    hasUpdate,
    releaseNotes: release.body || '',
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    downloadUrl: asset.browser_download_url,
    isPrerelease: release.prerelease,
    assetName: asset.name,
    assetSize: asset.size,
  };
}

/**
 * 流式下载文件，支持重定向跟随与进度回调。
 *
 * CDN 模式（cdnConfig 存在）失败不回退直连：用户明确选择 CDN 加速后，
 * 静默切换直连会绕过用户的网络决策（如直连 GitHub 被墙导致卡死），
 * 失败直接报错并在错误信息中引导用户调整设置。
 *
 * @param url       下载地址
 * @param dest      目标文件路径
 * @param onProgress 进度回调（每收到一段数据触发一次），参数为已接收字节数和总字节数
 *                   总字节数可能为 0（服务器未返回 content-length）
 */
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  cdnConfig?: CdnConfig,
): Promise<void> {
  // CDN 模式下的失败提示后缀：引导用户关闭 CDN 加速而非静默直连
  const cdnHint = cdnConfig?.proxyUrl
    ? '（CDN 加速节点不可用，可在更新设置中关闭 CDN 加速后重试）'
    : '';
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { timeout: 300_000 }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // 关闭当前文件流，重定向后重新下载（保留进度回调）
        file.close();
        fs.unlinkSync(dest);
        // CDN 代理：对重定向 URL 也应用代理前缀（统一处理所有 GitHub 域名）
        let redirectUrl = res.headers.location;
        if (cdnConfig?.proxyUrl) {
          redirectUrl = applyCdnToUrl(redirectUrl, cdnConfig.proxyUrl);
        }
        downloadFile(redirectUrl, dest, onProgress, cdnConfig)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}${cdnHint}`));
        return;
      }
      // 从响应头读取总大小（可能不存在）
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
    });
    req.on('error', (err) => {
      // CDN 模式不回退直连：网络错误直接失败并附 CDN 引导提示
      reject(new Error(`下载网络错误: ${err.message}${cdnHint}`));
    });
    req.on('timeout', () => {
      req.destroy();
      // CDN 模式不回退直连：超时直接失败并附 CDN 引导提示
      reject(new Error(`下载超时${cdnHint}`));
    });
  });
}

/**
 * 解压压缩包到指定目录。
 * - .zip：Windows 使用 PowerShell Expand-Archive；Linux/Docker 使用 adm-zip
 *   纯 Node 解压（容器内没有 unzip 命令，也不依赖任何系统工具）
 * - .tar.gz：Linux 使用 tar
 */
function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<void> {
  const isWindows = os.platform() === 'win32';
  const isZip = archivePath.toLowerCase().endsWith('.zip');

  // Linux/Docker 下的 .zip：adm-zip 纯 Node 解压。
  // 旧实现 Linux 分支一律 `tar xzf`，仅支持 .tar.gz——手动上传 .zip 时
  // tar 报 "This does not look like a tar archive"，Docker 环境手动上传
  // 压缩包更新必然失败。
  if (!isWindows && isZip) {
    return new Promise((resolve, reject) => {
      try {
        new AdmZip(archivePath).extractAllTo(destDir, true);
        resolve();
      } catch (err) {
        reject(
          err instanceof Error
            ? new Error(`解压失败: ${err.message}`)
            : new Error(`解压失败: ${String(err)}`),
        );
      }
    });
  }

  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];

    if (isWindows) {
      const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      cmd = 'powershell';
      args = ['-NoProfile', '-Command', psCmd];
    } else {
      cmd = 'tar';
      args = ['xzf', archivePath, '-C', destDir];
    }

    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`解压失败 (exit ${code}): ${stderr}`));
      }
    });
  });
}

/**
 * 生成 Windows 更新批处理脚本。
 *
 * 与旧版本的区别：
 * - 不再执行 npm install / npm run build（下载的是构建好的单文件产物）
 * - 同时支持单文件版本（exe）和 Node.js 开发模式
 * - 停止服务时同时尝试终止 exe 和 node 进程
 */
function writeApplyUpdateBat(
  root: string,
  tempDir: string,
  extractedDir: string,
): string {
  const batPath = path.join(root, 'apply-update.bat');
  // 路径直接注入模板（模板中的反斜杠已是单反斜杠语义），不做 replace 转义：
  // 曾用 root.replace(反斜杠, 双反斜杠) 产生双反斜杠路径。
  const content = renderTemplate(APPLY_UPDATE_BAT_TEMPLATE, {
    ROOT: root,
    TEMP_DIR: tempDir,
    EXTRACTED_DIR: extractedDir,
  });
  // 关键：Windows bat 文件必须使用 CRLF 换行符！
  // Node.js fs.writeFileSync 默认使用 LF，cmd.exe 解析 LF 换行的 bat 时
  // 会出现语法错误（如 '" is not recognized as an internal or external command'），
  // 导致脚本无法执行。
  const batContent = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(batPath, batContent, 'utf8');
  return batPath;
}

/**
 * 生成 Docker 容器内更新 shell 脚本。
 *
 * Docker 更新策略（容器内重启，不重启容器）：
 * 1. 备份 config 目录（包含数据库、用户上传等持久化数据）
 * 2. 用解压出的新文件覆盖 /app/ 下的程序文件
 * 3. 恢复 config 目录
 * 4. 创建 .restart-backend 标记文件
 * 5. kill 后端进程（容器主进程的子进程）
 *
 * entrypoint-linux-single.sh 的监控循环检测到后端退出后，
 * 会检查 .restart-backend 标记：存在则重启后端，不退出容器。
 * 这样容器不重启，只是后端进程在容器内重启，加载已更新的程序文件。
 *
 * 优点：
 * - 不依赖 docker run 的 --restart 策略
 * - 容器重启速度更快（无需重新初始化容器环境）
 * - config volume 挂载状态保持不变
 */
function writeDockerUpdateSh(
  root: string,
  tempDir: string,
  extractedDir: string,
): string {
  const shPath = path.join(root, 'apply-update.sh');
  const content = renderTemplate(APPLY_UPDATE_SH_TEMPLATE, {
    ROOT: root,
    TEMP_DIR: tempDir,
    EXTRACTED_DIR: extractedDir,
    TAG: '[Docker 更新脚本]',
    EXTRA_VARS: 'RESTART_MARKER="$ROOT/.restart-backend"',
    AFTER_BACKUP: '',
    STOP_SECTION: SH_STOP_DOCKER,
    APPLY_SECTION: SH_APPLY_DOCKER,
    FINISH_SECTION: SH_FINISH_DOCKER,
  });
  fs.writeFileSync(shPath, content, 'utf8');
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

/**
 * 生成 Linux 更新 shell 脚本。
 */
function writeApplyUpdateSh(
  root: string,
  tempDir: string,
  extractedDir: string,
): string {
  const shPath = path.join(root, 'apply-update.sh');
  const content = renderTemplate(APPLY_UPDATE_SH_TEMPLATE, {
    ROOT: root,
    TEMP_DIR: tempDir,
    EXTRACTED_DIR: extractedDir,
    TAG: '[更新脚本]',
    EXTRA_VARS: 'SELF_PID=$$',
    AFTER_BACKUP: '  rm -rf "$CONFIG_DIR"',
    STOP_SECTION: SH_STOP_LINUX,
    APPLY_SECTION: SH_APPLY_LINUX,
    FINISH_SECTION: SH_FINISH_LINUX,
  });
  fs.writeFileSync(shPath, content, 'utf8');
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

/**
 * 更新过程阶段事件，供 SSE 流式接口推送进度。
 */
export type UpdateStageEvent =
  | { stage: 'downloading'; received: number; total: number }
  | { stage: 'extracting' }
  | { stage: 'starting' }
  | { stage: 'done'; message: string }
  | { stage: 'error'; message: string };

/**
 * 应用更新（从已下载或已上传的压缩包）。
 *
 * 流程：
 * 1. 将压缩包保存到临时目录（若为 URL 则流式下载，支持进度回调）
 * 2. 解压
 * 3. 生成更新脚本（bat/sh）
 * 4. detached 启动更新脚本，后台替换文件并重启
 *
 * @param onStage 阶段事件回调，用于推送下载/解压/启动进度
 */
async function applyUpdateFromArchive(
  archiveData: Buffer | string,
  archiveFilename: string,
  onStage?: (event: UpdateStageEvent) => void,
  cdnConfig?: CdnConfig,
): Promise<{ success: boolean; message: string }> {
  const root = projectRoot();
  const tempDir = path.join(root, '.update-temp');
  const archivePath = path.join(tempDir, archiveFilename);

  // 清理并创建临时目录
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 写入压缩包
    if (typeof archiveData === 'string') {
      // archiveData 是 URL，需要下载（带进度），透传 CDN 配置
      await downloadFile(archiveData, archivePath, (received, total) => {
        if (onStage) onStage({ stage: 'downloading', received, total });
      }, cdnConfig);
    } else {
      fs.writeFileSync(archivePath, archiveData);
    }

    // 解压
    if (onStage) onStage({ stage: 'extracting' });
    await extractArchive(archivePath, tempDir);

    // 找到解压后的产物目录
    // GitHub Release 的 zip/tar.gz 解压后通常直接包含文件（无外层目录）
    // 但也可能有外层目录，需要检查
    let extractedDir = tempDir;
    const entries = fs.readdirSync(tempDir).filter(
      (name) => !name.endsWith('.zip') && !name.endsWith('.tar.gz'),
    );
    // 如果解压后只有一个目录且不包含 exe/可执行文件，进入该目录
    if (entries.length === 1) {
      const onlyEntry = path.join(tempDir, entries[0]);
      if (fs.statSync(onlyEntry).isDirectory()) {
        const subEntries = fs.readdirSync(onlyEntry);
        const hasExe = subEntries.some(
          (name) =>
            name.startsWith('zviewer-') ||
            name === 'start.bat' ||
            name === 'start.sh',
        );
        if (hasExe) {
          extractedDir = onlyEntry;
        }
      }
    }

    // 生成并启动更新脚本
    if (onStage) onStage({ stage: 'starting' });
    const isWindows = os.platform() === 'win32';
    // Docker 环境使用专用脚本：不重启进程，而是 kill 后端触发容器 restart
    const dockerMode = !isWindows && isDocker();
    const scriptPath = isWindows
      ? writeApplyUpdateBat(root, tempDir, extractedDir)
      : dockerMode
        ? writeDockerUpdateSh(root, tempDir, extractedDir)
        : writeApplyUpdateSh(root, tempDir, extractedDir);

    if (isWindows) {
      spawn('cmd', ['/c', scriptPath], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      spawn('bash', [scriptPath], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
      }).unref();
    }

    const successMessage = dockerMode
      ? '更新已触发，后台将自动替换文件并在容器内重启后端进程'
      : '更新已触发，后台将自动替换文件并重启服务';
    if (onStage) onStage({ stage: 'done', message: successMessage });
    return {
      success: true,
      message: successMessage,
    };
  } catch (err) {
    // 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
    const errMsg = err instanceof Error ? err.message : '应用更新失败';
    if (onStage) onStage({ stage: 'error', message: errMsg });
    throw err;
  }
}

/**
 * 从 GitHub Releases 下载最新构建产物并应用更新。
 *
 * @param includePrerelease 是否跟随最新构建版本（含预发布版）
 * @param onStage 阶段事件回调，用于推送下载/解压/启动进度
 */
export async function applyUpdate(
  includePrerelease = false,
  onStage?: (event: UpdateStageEvent) => void,
): Promise<{
  success: boolean;
  message: string;
}> {
  const info = await getUpdateInfo(includePrerelease);
  if (!info.downloadUrl) {
    throw new Error('未找到可用的下载地址');
  }

  // 读取 CDN 配置（getUpdateInfo 已读取一次，这里再读一次确保最新）
  const settings = await getSystemSettings();
  const cdnConfig: CdnConfig | undefined = settings.cdnAccelerate
    ? { proxyUrl: settings.cdnProxyUrl || 'https://gh-proxy.com' }
    : undefined;

  // 对 downloadUrl 应用 CDN 代理前缀（覆盖 github.com 等所有 GitHub 域名）
  let downloadUrl = info.downloadUrl;
  if (cdnConfig?.proxyUrl) {
    downloadUrl = applyCdnToUrl(downloadUrl, cdnConfig.proxyUrl);
    console.log(`[updater] CDN 加速: ${cdnConfig.proxyUrl}`);
  }

  // downloadFile 在 302 重定向跟随后也会对重定向 URL 应用 CDN 代理前缀；
  // CDN 模式失败不回退直连，直接报错并引导用户调整 CDN 设置
  return applyUpdateFromArchive(downloadUrl, info.assetName, onStage, cdnConfig);
}

/**
 * 从用户上传的压缩包应用更新。
 *
 * @param fileData 压缩包文件的 Buffer 数据
 * @param filename 原始文件名（用于判断压缩格式）
 * @param onStage 阶段事件回调（上传场景无下载阶段，仅推送解压/启动/完成）
 */
export async function applyUpdateFromFile(
  fileData: Buffer,
  filename: string,
  onStage?: (event: UpdateStageEvent) => void,
): Promise<{ success: boolean; message: string }> {
  // 验证文件类型
  const lowerName = filename.toLowerCase();
  if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.tar.gz')) {
    throw new Error('仅支持 .zip 或 .tar.gz 格式的压缩包');
  }

  // 统一使用 .zip 或 .tar.gz 扩展名保存
  const archiveName = lowerName.endsWith('.tar.gz')
    ? 'uploaded-update.tar.gz'
    : 'uploaded-update.zip';

  return applyUpdateFromArchive(fileData, archiveName, onStage);
}
