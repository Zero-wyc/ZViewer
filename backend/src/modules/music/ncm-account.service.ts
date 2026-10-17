/**
 * 网易云账号信息服务。
 *
 * - 登录状态：按需补全昵称/头像/会员信息（扫码登录落库时 /login/qr/check
 *   只返回 code，不含账号资料），并用 /vip/info 三档会员对象兜底 VIP 判定；
 * - 专辑全量歌曲：登录态下 /album/{id} 的 songs 可能被截断，
 *   按 album.size 检测后以匿名上下文补齐。
 */
import { AppDataSource } from '../../data-source';
import { NcmCredential } from '../../entities/NcmCredential';
import { callNcmApi } from './ncm-api-client';
import {
  extractProfile,
  loadCredential,
  toCookieHeader,
} from './ncm-cookie.service';

/** 登录状态响应（与前端约定字段一致） */
export interface NcmLoginStatus {
  loggedIn: boolean;
  nickname: string | null;
  avatarUrl: string | null;
  vipType: number | null;
  vipStatus: number | null;
}

/**
 * 用凭据 cookie 实时补全账号资料与会员信息并回写。
 *
 * 触发条件：凭据存在且 vipType 为空/0（购买会员后存量缓存会被误判为普通用户）。
 * 失败仅告警，不影响登录状态返回。
 */
async function refreshProfileIfNeeded(
  credential: NcmCredential,
): Promise<void> {
  if (credential.vipType != null && credential.vipType !== 0) return;
  try {
    const cookieHeader = toCookieHeader(credential.cookies);
    if (!cookieHeader) return;
    const { body } = await callNcmApi('/user/account', cookieHeader);
    const profile = extractProfile(body);
    if (profile) {
      credential.nickname = profile.nickname ?? credential.nickname;
      credential.avatarUrl = profile.avatarUrl ?? credential.avatarUrl;
      credential.vipType = profile.vipType ?? credential.vipType;
      credential.vipStatus = profile.vipStatus ?? credential.vipStatus;
    }
    // profile.vipType 仍为 0/缺省：调 /vip/info 以三档会员对象
    // （associator 黑胶 / musicPackage 音乐包 / redplus 黑胶 PLUS）
    // 判定实际会员状态。每档含 vipCode/expireTime/iconUrl；
    // expireTime > now 即在有效期；SVIP 由会员图标 URL 含 'svip' 判定
    if (credential.vipType == null || credential.vipType === 0) {
      const vipRes = await callNcmApi('/vip/info', cookieHeader);
      const vipData =
        vipRes.body && typeof vipRes.body === 'object'
          ? ((vipRes.body as Record<string, unknown>).data as
              | Record<string, unknown>
              | undefined)
          : undefined;
      if (vipData && typeof vipData === 'object') {
        const now = Date.now();
        // 兼容字段（部分上游版本存在）：redVipLevel / SVIP 动态图标
        const legacyRedVipLevel =
          typeof vipData.redVipLevel === 'number' ? vipData.redVipLevel : 0;
        const legacyIconUrl =
          typeof (vipData as Record<string, unknown>).redVipDynamicIconUrl ===
          'string'
            ? ((vipData as Record<string, unknown>)
                .redVipDynamicIconUrl as string)
            : '';
        let active = legacyRedVipLevel > 0 || legacyIconUrl !== '';
        let svip = legacyIconUrl.toLowerCase().includes('svip');
        for (const slotKey of ['associator', 'musicPackage', 'redplus']) {
          const slot = (vipData as Record<string, unknown>)[slotKey];
          if (!slot || typeof slot !== 'object') continue;
          const s = slot as Record<string, unknown>;
          const vipCode = typeof s.vipCode === 'number' ? s.vipCode : 0;
          const expireTime =
            typeof s.expireTime === 'number' ? s.expireTime : 0;
          const slotIcon = typeof s.iconUrl === 'string' ? s.iconUrl : '';
          if (expireTime > now || (expireTime === 0 && vipCode > 0)) {
            active = true;
            if (slotIcon.toLowerCase().includes('svip')) svip = true;
          }
        }
        // 只要有任一档会员在有效期内即按 VIP 展示；SVIP 图标优先
        credential.vipStatus = active ? 1 : 0;
        if (active) {
          credential.vipType = svip ? 11 : 10;
        } else if (profile?.vipType != null) {
          credential.vipType = profile.vipType;
        }
        if (credential.vipStatus == null) credential.vipStatus = 0;
      }
    }
    await AppDataSource.getRepository(NcmCredential).save(credential);
  } catch (err) {
    console.warn('[music] login/status 账号资料补全失败:', err);
  }
}

/** 查询当前用户的网易云登录状态（游客未登录返回 loggedIn:false） */
export async function getNcmLoginStatus(
  userId: number | undefined,
): Promise<NcmLoginStatus> {
  const credential = await loadCredential(userId);
  if (credential) await refreshProfileIfNeeded(credential);
  return {
    loggedIn: !!credential,
    nickname: credential?.nickname ?? null,
    avatarUrl: credential?.avatarUrl ?? null,
    vipType: credential?.vipType ?? null,
    vipStatus: credential?.vipStatus ?? null,
  };
}

/** 专辑详情响应体（仅声明消费字段） */
interface AlbumBody {
  album?: { size?: number };
  songs?: unknown[];
}

/**
 * 获取专辑详情并补齐被截断的歌曲列表。
 *
 * 网易云 /api/v1/album/{id} 在部分登录态（cookie 携带 MUSIC_U）下会把
 * songs 截断（如仅返回 50 首），匿名/Web 身份则返回全量；响应中的
 * album.size 为专辑歌曲总数。参照 Hydrogen 歌单 hydration 的补齐思路：
 * 主请求带用户 cookie（保留 privileges/fee 等登录态字段），当
 * songs.length < album.size 时改用无 cookie 的匿名上下文再请求一次，
 * 匿名结果歌曲数更多则整单采用，否则回退主结果。
 *
 * 解析失败返回 null（调用方回 502）。
 */
export async function getAlbumWithFullSongs(
  id: number,
  cookieHeader: string,
): Promise<unknown | null> {
  const primary = await callNcmApi(`/album?id=${id}`, cookieHeader);
  const body = primary.body as AlbumBody | null;
  if (!body) return null;
  const size = Number(body.album?.size) || 0;
  const songs = Array.isArray(body.songs) ? body.songs : [];
  // 截断检测：songs 少于专辑总数 → 匿名上下文补齐
  if (size > songs.length) {
    try {
      const anonymous = await callNcmApi(`/album?id=${id}`, '');
      const anonBody = anonymous.body as AlbumBody | null;
      const anonSongs = Array.isArray(anonBody?.songs) ? anonBody.songs : [];
      if (anonSongs.length > songs.length) return anonBody;
    } catch (err) {
      // 补齐失败：回退主结果
      console.warn('[music] 专辑匿名补齐失败:', err);
    }
  }
  return body;
}
