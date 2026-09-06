/**
 * 挂载路由共享工具函数。
 *
 * 消除 emby.ts / jellyfin.ts / ftp.ts / webdav.ts 中的重复代码。
 */
import { AppDataSource } from '../../data-source';
import { UserMount } from '../../entities/UserMount';

/** 移除挂载对象的密码字段，返回安全的响应对象。 */
export function stripPassword(mount: UserMount): Omit<UserMount, 'password'> {
  const { password: _password, ...rest } = mount;
  return rest;
}

/** 从未知错误对象中提取错误消息。 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** HTTPS 能力探测超时（毫秒） */
const HTTPS_PROBE_TIMEOUT_MS = 5000;

/**
 * 探测源站 HTTPS 直连能力（配置期执行，结果随挂载持久化）。
 *
 * 对 serverUrl 的 https:// 同端口地址发 HEAD：任何 HTTP 响应
 * （2xx-5xx，含 401/404）都证明 TLS 握手成功 → true；TLS/网络错误
 * （EPROTO、证书、超时）→ false。serverUrl 本身是 https → true；
 * 非 http(s) 协议（如 ftp://）不适用 → null。
 */
export async function probeHttpsCapability(
  serverUrl: string,
): Promise<boolean | null> {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return null;
  const httpsUrl = `https://${serverUrl.slice(serverUrl.indexOf('://') + 3)}`;
  try {
    const res = await fetch(httpsUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HTTPS_PROBE_TIMEOUT_MS),
      headers: { 'user-agent': 'ZViewer-HttpsProbe' },
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return res.status >= 200 && res.status < 600;
  } catch {
    return false;
  }
}

/**
 * 将直链 URL 的 http 协议升级为 https（挂载探测通过时调用）。
 *
 * 同 host + 同端口改写协议；非 http 直链原样返回。
 */
export function maybeUpgradeDirectUrl(
  directUrl: string,
  httpsDirect: boolean | null | undefined
): string {
  if (httpsDirect !== true) return directUrl;
  try {
    const u = new URL(directUrl);
    if (u.protocol !== 'http:') return directUrl;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return directUrl;
  }
}

/**
 * 确保挂载的 HTTPS 能力已探测（幂等）。
 *
 * httpsDirect 非 null 直接返回缓存值；否则现场探测一次并写回 DB
 * （写回失败不影响返回值，下次再试）。direct-url 调用时的旧数据兜底：
 * 挂载保存时的异步探测可能尚未完成。
 */
export async function ensureHttpsProbe(mount: UserMount): Promise<boolean | null> {
  if (mount.httpsDirect !== null && mount.httpsDirect !== undefined) {
    return mount.httpsDirect;
  }
  if (!mount.serverUrl) return null;
  const result = await probeHttpsCapability(mount.serverUrl);
  mount.httpsDirect = result;
  try {
    await AppDataSource.getRepository(UserMount).save(mount);
  } catch {
    /* 探测结果写回失败不影响本次返回，下次再试 */
  }
  return result;
}

/**
 * 挂载保存时的 HTTPS 能力探测与提示。
 *
 * 直链模式 + http 源：同步探测（阻塞至多 5s）——探测结果决定响应
 * warning：源站不支持 TLS 时直链在 HTTPS 页面下无法播放（浏览器混合
 * 内容策略强制升级协议后握手失败），提示用户配置 HTTPS 或改为服务器
 * 中转。其余组合异步探测持久化（不阻塞保存响应）。
 *
 * @returns 响应携带的 warning 文案；无需提示时返回 null
 */
export async function probeForMountSave(
  mount: UserMount,
): Promise<string | null> {
  const isHttpSource =
    !!mount.serverUrl && mount.serverUrl.startsWith('http://');
  if (mount.directLink && isHttpSource) {
    const probe =
      mount.httpsDirect === null || mount.httpsDirect === undefined
        ? await probeHttpsCapability(mount.serverUrl!)
        : mount.httpsDirect;
    mount.httpsDirect = probe;
    try {
      await AppDataSource.getRepository(UserMount).save(mount);
    } catch {
      /* ignore */
    }
    if (probe === false) {
      let host = mount.serverUrl || '';
      try {
        host = new URL(mount.serverUrl!).host;
      } catch {
        /* 保留原值 */
      }
      return `挂载源站不支持 HTTPS（${host}），HTTPS 页面下直链将无法播放。请为源站配置 HTTPS（如反向代理）后重新保存，或改为服务器中转模式`;
    }
    return null;
  }
  // 非直链或 https 源：异步探测持久化（不阻塞保存响应）
  if (isHttpSource) {
    void probeHttpsCapability(mount.serverUrl!)
      .then((result) => {
        if (result === null) return;
        mount.httpsDirect = result;
        return AppDataSource.getRepository(UserMount).save(mount);
      })
      .catch(() => {});
  }
  return null;
}