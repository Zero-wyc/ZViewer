/**
 * 网易云（NCM）凭证读写服务。
 *
 * 负责 cookie 的解析 / 合并 / 持久化，以及「当前用户 → 房主」的凭证回退链。
 * 路由层不直接操作 NcmCredential 仓库。
 *
 * 凭证存储形态：NcmCredential.cookies 为 JSON 数组字符串
 * （如 '["MUSIC_U=xxx; Path=/", "__csrf=yyy"]'），对外发送时转换为请求头格式。
 */
import { AppDataSource } from '../../data-source';
import { NcmCredential } from '../../entities/NcmCredential';
import { Room } from '../../entities/Room';

/** 从 Set-Cookie 原始串提取 cookie 名（首个 = 之前的部分） */
function cookieName(setCookie: string): string {
  const eq = setCookie.indexOf('=');
  return (eq > 0 ? setCookie.slice(0, eq) : setCookie).trim();
}

/** 将持久化的 cookie JSON 数组转为请求头格式（仅取 name=value 部分，以 "; " 连接） */
export function toCookieHeader(cookiesRaw: string): string {
  try {
    const arr = JSON.parse(cookiesRaw) as unknown;
    if (!Array.isArray(arr)) return '';
    return arr
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .map((c) => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  } catch {
    return '';
  }
}

/** 解析持久化的 cookie JSON 数组（失败 / 非数组返回空数组） */
export function parseStoredCookies(cookiesRaw: string): string[] {
  try {
    const arr = JSON.parse(cookiesRaw) as unknown;
    return Array.isArray(arr)
      ? arr.filter((c): c is string => typeof c === 'string')
      : [];
  } catch {
    return [];
  }
}

/** 将新 Set-Cookie 数组合并进既有数组（按 cookie 名去重，新值覆盖旧值） */
export function mergeCookies(
  existing: string[],
  incoming: string[],
): string[] {
  const map = new Map<string, string>();
  for (const c of [...existing, ...incoming]) {
    if (typeof c !== 'string' || !c) continue;
    map.set(cookieName(c), c);
  }
  return Array.from(map.values());
}

/** 读取当前用户的持久化凭证（游客 / 未登录返回 null） */
export async function loadCredential(
  userId: number | undefined,
): Promise<NcmCredential | null> {
  if (!userId || userId <= 0) return null;
  return AppDataSource.getRepository(NcmCredential).findOneBy({ userId });
}

/** 从 NCM 响应体提取网易云账号资料（兼容 body.profile 与 body.data.profile 两种结构）。
 *  另取 vipStatus / redVipLevel 供 VIP 判定兜底（profile.vipType 对部分黑胶
 *  会员不反映实际会员状态，Hydrogen 用 /vip/info 判定同因）。 */
export function extractProfile(body: unknown): {
  nickname: string | null;
  avatarUrl: string | null;
  vipType: number | null;
  vipStatus: number | null;
  redVipLevel: number | null;
} | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  let raw: unknown = b.profile;
  if (
    (!raw || typeof raw !== 'object') &&
    b.data &&
    typeof b.data === 'object'
  ) {
    raw = (b.data as Record<string, unknown>).profile;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const nickname = typeof p.nickname === 'string' ? p.nickname : null;
  const avatarUrl = typeof p.avatarUrl === 'string' ? p.avatarUrl : null;
  const vipType = typeof p.vipType === 'number' ? p.vipType : null;
  const vipStatus = typeof p.vipStatus === 'number' ? p.vipStatus : null;
  const redVipLevel = typeof p.redVipLevel === 'number' ? p.redVipLevel : null;
  if (!nickname && !avatarUrl) return null;
  return { nickname, avatarUrl, vipType, vipStatus, redVipLevel };
}

/**
 * 将合并后的 cookie 持久化到 NcmCredential（同时更新昵称/头像缓存）。
 * 仅在响应携带登录态 cookie（MUSIC_U / __csrf）时调用。
 */
export async function persistCookies(
  userId: number,
  mergedCookies: string[],
  body: unknown,
): Promise<void> {
  const repo = AppDataSource.getRepository(NcmCredential);
  const profile = extractProfile(body);
  const existing = await repo.findOneBy({ userId });
  if (existing) {
    existing.cookies = JSON.stringify(mergedCookies);
    if (profile?.nickname) existing.nickname = profile.nickname;
    if (profile?.avatarUrl) existing.avatarUrl = profile.avatarUrl;
    if (profile?.vipType != null) existing.vipType = profile.vipType;
    if (profile?.vipStatus != null) existing.vipStatus = profile.vipStatus;
    await repo.save(existing);
  } else {
    await repo.save(
      repo.create({
        userId,
        cookies: JSON.stringify(mergedCookies),
        nickname: profile?.nickname ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        vipType: profile?.vipType ?? null,
        vipStatus: profile?.vipStatus ?? null,
      }),
    );
  }
}

/** 判断 Set-Cookie 列表是否包含登录态 cookie（MUSIC_U / __csrf） */
export function hasLoginCookies(setCookies: string[]): boolean {
  return setCookies.some((c) => {
    const name = cookieName(c).toLowerCase();
    return name === 'music_u' || name.includes('csrf');
  });
}

/**
 * 凭证回退链（/stream 与 /song-quality 共用）：
 * 当前用户凭证 → 房主凭证（请求带 roomId 时）。
 * 实现 spec「房主登录网易云后全房间可播 VIP」：观众自己未登录/
 * 无凭证时，借用房主的持久化凭证解析直链。
 */
export async function resolveNcmCredentialForRequest(
  userId: number | undefined,
  roomId: string,
): Promise<NcmCredential | null> {
  const credential = await loadCredential(userId);
  if (credential) return credential;
  if (roomId) {
    const room = await AppDataSource.getRepository(Room).findOneBy({
      roomId,
    });
    if (room?.ownerUserId) {
      return loadCredential(room.ownerUserId);
    }
  }
  return null;
}
