/**
 * 嵌入式 LiveKit 服务管理器。
 *
 * livekit-server 是独立 Go 二进制，无法内嵌进 pkg 产物；本管理器把它
 * 作为「伴生进程」随主进程启动/停止：
 *
 * - 单文件部署：build-all 打包时已把二进制分发到 exe 旁，启动时自动拉起
 * - 开发模式（npm run dev）：二进制缺失时自动从 GitHub Releases 下载到
 *   backend/dev-bin/ 再启动（仅开发模式；生产包不会静默联网下载）
 * - 外置部署：LIVEKIT_EXTERNAL=1 或 .env 显式配置 LiveKit 地址时跳过
 *
 * 生命周期：随主进程退出而终止子进程（SIGINT/SIGTERM/exit 三挂钩）。
 * 环境变量缺省值在启动早期注入，.env 显式配置优先：
 * LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_API_HOST / LIVEKIT_BIND
 * （客户端地址不在此配置——由 voice.routes 按请求头推导，跟随页面域名）。
 */
import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';

const DEFAULT_API_KEY = 'devkey';
const DEFAULT_API_SECRET = 'zviewer-dev-secret';
const HTTP_PORT = 3336;
/**
 * 媒体传输 UDP 端口：项目 TCP 侧未使用 3333/udp，故媒体与信令反代
 * 共用 3333 端口号（tcp=页面/API/信令反代，udp=RTP 媒体），防火墙
 * 只需放行一条 3333。
 */
const UDP_PORT = 3333;
/**
 * ICE/TCP 端口（LiveKit 原生 rtc.tcp_port，官方默认 7881）：TCP 模式下
 * 额外开启——UDP 被墙（运营商/企业防火墙）时客户端自动经此端口以 TCP
 * 直连媒体。部署侧需放行 3337/tcp（Docker 需补端口映射）。
 * 可用环境变量 LIVEKIT_RTC_TCP_PORT 覆盖。
 */
const TCP_PORT = Number(process.env.LIVEKIT_RTC_TCP_PORT?.trim()) || 3337;

export type VoiceTransportMode = 'udp' | 'tcp';
/**
 * 当前语音媒体传输模式（管理端基础设置下发）：
 * - 'udp'（默认）：仅 UDP 复用端口 3333
 * - 'tcp'：保留 UDP 3333 并额外开启 ICE/TCP 3337（LiveKit 无法禁用
 *   UDP 候选，双开由客户端 ICE 自动选路——UDP 可用走低延迟直连，
 *   被墙环境自动落到 TCP）
 */
let voiceTransportMode: VoiceTransportMode = 'udp';
/**
 * 监听地址：默认 `::`（Go dual-stack，同时收 IPv4/IPv6——IPv4 连接以
 * v4-mapped 形式进入，127.0.0.1 回环依然可达）。绑 0.0.0.0 会只收
 * IPv4，公网 IPv6 用户的媒体流无法建立。特殊环境可用 LIVEKIT_BIND 覆盖。
 */
const BIND_ADDRESS = process.env.LIVEKIT_BIND?.trim() || '::';
const READY_TIMEOUT_MS = 15_000;
/** 开发模式自动下载的 pinned 版本（与 build-all 打包版本保持一致） */
const LIVEKIT_VERSION = 'v1.13.7';

let child: ChildProcess | null = null;

function binName(): string {
  return process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
}

/** 是否为 pkg 单文件运行（生产包不自动联网下载） */
function isPkgRuntime(): boolean {
  return Boolean((process as { pkg?: unknown }).pkg);
}

function isDevMode(): boolean {
  return !isPkgRuntime();
}

function candidatePaths(): string[] {
  const name = binName();
  return [
    // pkg 产物：exe 同目录（build-all 打包时随产物分发）
    path.join(path.dirname(process.execPath), name),
    // 开发环境：backend/dev-bin（自动下载/手动放置均可）
    path.join(process.cwd(), 'dev-bin', name),
  ];
}

function isEmbeddedLivekitAvailable(): boolean {
  return candidatePaths().some((p) => fs.existsSync(p));
}

// ==================== 开发模式自动下载 ====================

/** https 下载（跟随重定向；GitHub releases 会 302 到对象存储） */
function httpsDownload(url: string, dest: string, depth = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    https
      .get(url, { headers: { 'User-Agent': 'zviewer-dev-setup' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          httpsDownload(
            new URL(res.headers.location, url).toString(),
            dest,
            depth + 1
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/** 解压到 dev-bin（win: zip→Expand-Archive；nix: tar.gz→tar） */
function extractLivekit(archive: string, destDir: string): void {
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -Path ${JSON.stringify(
        archive
      )} -DestinationPath ${JSON.stringify(destDir)}"`,
      { stdio: 'pipe' }
    );
  } else {
    execSync(`tar -xzf ${JSON.stringify(archive)} -C ${JSON.stringify(destDir)}`, {
      stdio: 'pipe',
    });
  }
}

/**
 * 开发模式：二进制缺失时自动下载到 backend/dev-bin/。
 * 成功返回二进制路径；失败（网络不通等）返回 null 并给出手动放置指引。
 */
async function downloadDevBinary(): Promise<string | null> {
  const destDir = path.join(process.cwd(), 'dev-bin');
  const isWin = process.platform === 'win32';
  const asset = isWin
    ? `livekit_${LIVEKIT_VERSION.slice(1)}_windows_amd64.zip`
    : `livekit_${LIVEKIT_VERSION.slice(1)}_linux_amd64.tar.gz`;
  const url = `https://github.com/livekit/livekit-server/releases/download/${LIVEKIT_VERSION}/${asset}`;
  const archive = path.join(destDir, asset);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    console.log(`[voice] 开发模式：自动下载 livekit-server ${LIVEKIT_VERSION} ...`);
    await httpsDownload(url, archive);
    extractLivekit(archive, destDir);
    const bin = path.join(destDir, binName());
    if (!fs.existsSync(bin)) throw new Error(`解压后未找到 ${bin}`);
    if (!isWin) {
      try {
        fs.chmodSync(bin, 0o755);
      } catch {
        /* ignore */
      }
    }
    console.log('[voice] livekit-server 下载完成');
    return bin;
  } catch (err) {
    console.warn(
      `[voice] livekit-server 自动下载失败（${err instanceof Error ? err.message : err}）。` +
        `可手动下载 ${url} 放置到 ${destDir} 后重启`
    );
    return null;
  } finally {
    try {
      fs.rmSync(archive, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ==================== 启动 / 就绪 / 停止 ====================

/** 轮询等待 LiveKit HTTP 端口可连接 */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`LiveKit 端口 ${port} 等待超时`));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
    };
    tryOnce();
  });
}

function killChild(): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  child = null;
}

let exitHooksInstalled = false;
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once('exit', killChild);
  process.once('SIGINT', () => {
    killChild();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    killChild();
    process.exit(0);
  });
}

/**
 * 判断 IP 是否为非公网地址（RFC1918 私网 / 回环 / 链路本地 / CGNAT / IPv6 ULA）。
 */
function isNonPublicAddress(ip: string, family: string): boolean {
  if (family === 'IPv4') {
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (/^127\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;
    // CGNAT（运营商级 NAT，100.64.0.0/10）：无端口映射时同样不可达
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6.startsWith('fe80')) return true;
  // IPv6 ULA fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;
  return false;
}

/** 枚举本机网卡，返回首个公网地址（无则 null） */
function probePublicInterfaceIp(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal) continue;
      if (!isNonPublicAddress(net.address, net.family)) return net.address;
    }
  }
  return null;
}

/**
 * 启动嵌入式 LiveKit 服务（幂等；不具备条件时静默跳过）。
 *
 * 调用时机：bootstrap 早期 fire-and-forget（不阻塞主服务启动；
 * 下载期间 /api/voice/token 会 503，前端提示「语音服务未就绪」）。
 */
/** 拉起 livekit 子进程并等待 HTTP 端口就绪；超时/退出返回 false */
async function spawnAndAwait(
  bin: string,
  bind: string,
  nodeIp: string | undefined
): Promise<boolean> {
  const args = [
    '--dev',
    // dual-stack 监听（IPv4+IPv6），见 BIND_ADDRESS 注释
    '--bind',
    bind,
    // HTTP/信令端口：默认 7880，统一改为 3336 避开常见端口占用
    '--port',
    String(HTTP_PORT),
    '--udp-port',
    String(UDP_PORT),
    // 注意：livekit-server CLI 没有 --tcp-port flag（v1.13.7 实测报
    // "flag provided but not defined"），rtc.tcp_port 只能经 config 环
    // 境变量 LIVEKIT_RTC_TCP_PORT 下发（在 startEmbeddedLivekit 注入区
    // 按传输模式设置/删除，机制同 LIVEKIT_RTC_USE_EXTERNAL_IP）。
    // --keys 格式硬性要求 "key: secret"（冒号后必须带空格），缺空格
    // livekit 会直接退出（冒烟实测踩坑）
    '--keys',
    `${process.env.LIVEKIT_API_KEY}: ${process.env.LIVEKIT_API_SECRET}`,
  ];
  // 广播给客户端的 ICE 地址：显式 LIVEKIT_NODE_IP 直接指定；容器内未
  // 指定时由 LIVEKIT_RTC_USE_EXTERNAL_IP 驱动 LiveKit 自行 STUN 探测
  // 公网 IP（bridge NAT 下枚举网卡只得 172.x 内网地址，浏览器不可达）。
  if (nodeIp) args.push('--node-ip', nodeIp);
  // TURN/TLS 中继（TCP 5349）：域名寻址 + 正式证书，浏览器经 TCP 主动连
  // 服务器中继媒体，彻底不依赖 IP 广播——防火墙拦截 UDP/NAT 复杂场景的
  // 兜底通道。UDP 直连（node-ip/host candidate）仍并行尝试，优先走低延迟
  // 直连。三个 env 齐全才启用（自签证书不被浏览器信任，必须正式证书）。
  const turnDomain = process.env.LIVEKIT_TURN_DOMAIN?.trim();
  const turnCert = process.env.LIVEKIT_TURN_CERT?.trim();
  const turnKey = process.env.LIVEKIT_TURN_KEY?.trim();
  if (turnDomain && turnCert && turnKey) {
    process.env.LIVEKIT_TURN_ENABLED ??= 'true';
    process.env.LIVEKIT_TURN_TLS_PORT ??= '5349';
    process.env.LIVEKIT_TURN_EXTERNAL_TLS ??= 'false';
    args.push('--turn-cert', turnCert, '--turn-key', turnKey);
    console.log(`[voice] TURN/TLS 已启用: ${turnDomain}:5349 (TCP 中继兜底)`);
  } else if (turnDomain || turnCert || turnKey) {
    console.warn(
      '[voice] TURN 配置不完整（需 LIVEKIT_TURN_DOMAIN + LIVEKIT_TURN_CERT + LIVEKIT_TURN_KEY 三者），已忽略'
    );
  }

  child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[livekit] ${chunk}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[livekit] ${chunk}`);
  });
  child.once('exit', (code) => {
    console.warn(`[voice] 嵌入式 LiveKit 进程退出 (code=${code})`);
    child = null;
  });

  installExitHooks();

  try {
    await waitForPort(HTTP_PORT, READY_TIMEOUT_MS);
    console.log(`[voice] 嵌入式 LiveKit 已就绪 (bind ${bind})`);
    return true;
  } catch {
    // 等待失败时若进程仍在（如启动过慢）先终止，避免残留占端口
    killChild();
    return false;
  }
}

export async function startEmbeddedLivekit(): Promise<void> {
  if (child) return;
  if (process.env.LIVEKIT_EXTERNAL === '1') return;

  // 环境变量缺省值先注入（显式配置 ??= 不覆盖），下载期间路由即可用
  process.env.LIVEKIT_API_KEY ??= DEFAULT_API_KEY;
  process.env.LIVEKIT_API_SECRET ??= DEFAULT_API_SECRET;
  process.env.LIVEKIT_API_HOST ??= `http://127.0.0.1:${HTTP_PORT}`;
  // 默认开启 LiveKit 原生 STUN 外部 IP 发现（未显式 LIVEKIT_NODE_IP 时）：
  // 容器 bridge / 云服务器 EIP（网卡只有内网 IP）等 NAT 场景下枚举网卡
  // 只得不可达的内网地址，STUN 探测拿到真实公网 IP（v4+v6 均支持）。
  // 显式 LIVEKIT_NODE_IP 时跳过注入（手填地址优先级最高，二者不叠加）。
  // STUN 失败（纯内网部署）时 LiveKit 回落枚举网卡，行为与不开一致。
  if (!process.env.LIVEKIT_NODE_IP?.trim()) {
    process.env.LIVEKIT_RTC_USE_EXTERNAL_IP ??= 'true';
    console.log('[voice] 已启用 LiveKit 原生 STUN 外部 IP 发现');
  }
  // ICE/TCP 端口（LiveKit 原生 rtc.tcp_port）：CLI 无 --tcp-port flag，
  // 只能经 config 环境变量下发。TCP 模式注入（未显式配置时默认 3337）；
  // UDP 模式删除——热重启从 TCP 切回 UDP 时清除上次注入的残留。
  if (voiceTransportMode === 'tcp') {
    process.env.LIVEKIT_RTC_TCP_PORT = String(TCP_PORT);
    console.log(`[voice] ICE/TCP 已启用: ${TCP_PORT}/tcp（UDP 直连仍并行尝试）`);
  } else {
    delete process.env.LIVEKIT_RTC_TCP_PORT;
  }
  // 注意：此处不设置 LIVEKIT_URL——客户端地址由 voice.routes 按请求头
  // 推导（跟随页面域名与协议）。在容器/多网卡环境探测本机 IP 会得到
  // 内部地址（如 Docker bridge 172.24.x.x），浏览器不可达。

  let bin = candidatePaths().find((p) => fs.existsSync(p));
  if (!bin) {
    if (!isDevMode()) {
      console.warn(
        '[voice] 未找到 livekit-server 伴生二进制且未配置外置 LiveKit——语音功能不可用。' +
          '容器部署：请用最新 Dockerfile.linux-single 重建镜像（内嵌 livekit-server，' +
          '构建前先跑 node build-all.js --linux 生成 dist/linux/livekit-server）；' +
          '单文件部署：请使用完整 build-all 产物包（含 livekit-server）'
      );
      return;
    }
    const downloaded = await downloadDevBinary();
    if (!downloaded) return;
    bin = downloaded;
  }

  console.log(
    `[voice] 启动嵌入式 LiveKit: ${bin} (bind ${BIND_ADDRESS}, HTTP ${HTTP_PORT}, UDP ${UDP_PORT}, URL=${process.env.LIVEKIT_URL})`
  );

  // 广播地址：显式 LIVEKIT_NODE_IP 最高优先级；未指定时由上面注入的
  // LIVEKIT_RTC_USE_EXTERNAL_IP 驱动 LiveKit 自行 STUN 探测公网 IP。
  const nodeIp = process.env.LIVEKIT_NODE_IP?.trim() || undefined;

  let ok = await spawnAndAwait(bin, BIND_ADDRESS, nodeIp);
  // 无 IPv6 协议栈的环境绑 :: 会直接退出（缺少 IPv6 支持时）——回退纯
  // IPv4 重试一次，代价是 IPv6 媒体不可用，但语音整体可用
  if (!ok && BIND_ADDRESS === '::') {
    console.warn('[voice] bind :: 启动失败，回退 0.0.0.0 (仅 IPv4) 重试');
    ok = await spawnAndAwait(bin, '0.0.0.0', nodeIp);
  }
  if (!ok) {
    console.error(
      '[voice] 嵌入式 LiveKit 启动失败——语音将不可用，请检查端口占用与二进制完整性'
    );
    return;
  }

  // 外网可达性自检：本机网卡全为私网地址且未配置 NODE_IP/TURN 时，
  // LiveKit 广播的 ICE 候选（host=私网地址；STUN srflx=NAT 出口 IP 但
  // 无端口映射时同样不可达）对外网用户不可达。经 EdgeOne / CDN / 反向
  // 代理等七层服务暴露外网时，页面与信令正常（HTTP/WS 走代理），但
  // WebRTC 媒体（UDP/TCP）不经过七层代理——把这种静默失败变成启动
  // 日志里的显式警告，避免「局域网语音正常、外网连不上」难以排查。
  // 例外：云服务器 EIP 场景网卡是私网但 STUN 可探测到公网 IP（需安全组
  // 放行 3333/udp），此警告可忽略。
  if (
    !nodeIp &&
    !process.env.LIVEKIT_TURN_DOMAIN?.trim() &&
    probePublicInterfaceIp() === null
  ) {
    console.warn(
      '[voice] ⚠️ 语音媒体外网可达性警告：本机网卡均为私网地址，且未配置 LIVEKIT_NODE_IP 与 TURN。\n' +
        '[voice] 局域网内语音正常；外网用户经 EdgeOne/CDN/反向代理访问时页面与信令正常，但 WebRTC 媒体（UDP/TCP）不经过七层代理，语音将无法连接。\n' +
        '[voice] 解决路径（三选一）：\n' +
        '[voice]   ① 部署到有公网 IP 的主机，安全组/防火墙放行 3333/udp（容器场景 docker-compose 已含映射）；\n' +
        '[voice]   ② 用支持端口转发的穿透（frp 等）把 3333/udp 映射到公网，并设 LIVEKIT_NODE_IP=穿透公网地址；\n' +
        '[voice]   ③ 配置 TURN/TLS 中继：LIVEKIT_TURN_DOMAIN + LIVEKIT_TURN_CERT + LIVEKIT_TURN_KEY 三项，' +
        '并把 5349/tcp 映射到公网（需正式证书，浏览器不信任自签）。'
    );
  }
}

/**
 * 下发语音传输模式（管理端基础设置保存时调用；启动时 bootstrap 也用它
 * 从系统设置注入初始模式）。
 *
 * - 进程尚未启动：仅记录模式，startEmbeddedLivekit 按当前模式拉起
 * - 进程已在跑且模式变化：热重启 livekit 子进程使新参数生效——
 *   进行中的语音会短暂中断，客户端自动重连
 */
export async function applyVoiceTransportMode(
  mode: string | undefined | null
): Promise<void> {
  const next: VoiceTransportMode = mode === 'tcp' ? 'tcp' : 'udp';
  const changed = next !== voiceTransportMode;
  voiceTransportMode = next;
  if (!changed) return;
  console.log(
    `[voice] 语音传输模式: ${next === 'tcp' ? `TCP（ICE/TCP ${TCP_PORT}，UDP 直连仍并行尝试）` : 'UDP（仅 3333/udp）'}`
  );
  if (!child) return;
  killChild();
  // 等待端口释放（Windows 上 TCP TIME_WAIT 期间重绑可能失败）
  await new Promise((resolve) => setTimeout(resolve, 500));
  await startEmbeddedLivekit();
}
