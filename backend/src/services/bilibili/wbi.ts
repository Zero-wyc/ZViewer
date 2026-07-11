import { createHash } from 'node:crypto';
import { bilibiliFetch } from './client';

/**
 * WBI mixin key 字符抽取表。
 * 从 imgKey + subKey 的拼接字符串中按索引取出 32 个字符，再取前 32 位。
 */
const MIXIN_KEY_ENC_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 20, 42, 19, 29, 28, 14, 7, 41, 12, 1,
];

/** 缓存的 WBI 密钥对。 */
interface WbiKeyPair {
  imgKey: string;
  subKey: string;
  /** 秒级时间戳，用于判断过期。 */
  fetchedAt: number;
}

/** 按 Cookie 缓存 WBI 密钥，避免登录态与匿名态混用。 */
const cachedKeys = new Map<string, WbiKeyPair>();
/** 密钥有效期 12 小时，B站 nav 接口返回的密钥相对稳定。 */
const KEY_TTL_SECONDS = 12 * 60 * 60;

function getCookieCacheKey(cookie?: string): string {
  if (!cookie) return 'anonymous';
  return createHash('sha256').update(cookie).digest('hex').slice(0, 16);
}

/**
 * 从 WBI 图片 URL 中提取 key。
 * URL 形如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
 * 取最后一段文件名（不含扩展名）作为 key。
 */
function extractKeyFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    return filename.replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

/**
 * 根据 imgKey 与 subKey 生成 mixinKey，用于 WBI 签名。
 */
function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TABLE.map((idx) => raw[idx]).join('').slice(0, 32);
}

/**
 * 对请求参数进行 WBI 签名。
 * @param params 原始查询参数，value 需要是字符串。
 * @param imgKey WBI img_key。
 * @param subKey WBI sub_key。
 * @returns 增加 wts、w_rid 后的参数副本。
 */
export function signParams(
  params: Record<string, string>,
  imgKey: string,
  subKey: string,
): Record<string, string> {
  const mixinKey = getMixinKey(imgKey, subKey);
  const signed: Record<string, string> = {
    ...params,
    wts: String(Math.floor(Date.now() / 1000)),
  };

  // 按键名排序并编码，空值不参与签名
  const sortedKeys = Object.keys(signed)
    .filter((k) => signed[k] !== undefined && signed[k] !== '')
    .sort();

  const queryString = sortedKeys
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(signed[k] ?? '')}`,
    )
    .join('&');

  const wRid = createHash('md5')
    .update(queryString + mixinKey)
    .digest('hex');

  signed.w_rid = wRid;
  return signed;
}

/**
 * 从 B站 web nav 接口获取 WBI 图片地址，并提取/缓存 imgKey、subKey。
 * 缓存按 Cookie 隔离，避免匿名请求与登录请求使用同一套 WBI key。
 */
export async function fetchWbiKeys(cookie?: string): Promise<WbiKeyPair> {
  const cacheKey = getCookieCacheKey(cookie);
  const cached = cachedKeys.get(cacheKey);
  if (cached) {
    const now = Math.floor(Date.now() / 1000);
    if (now - cached.fetchedAt < KEY_TTL_SECONDS) {
      return cached;
    }
  }

  interface NavData {
    wbi_img?: {
      img_url: string;
      sub_url: string;
    };
  }

  const res = await bilibiliFetch<NavData>(
    'https://api.bilibili.com/x/web-interface/nav',
    { cookie },
  );

  const imgUrl = res.data.wbi_img?.img_url;
  const subUrl = res.data.wbi_img?.sub_url;

  if (!imgUrl || !subUrl) {
    throw new Error('从 B站 nav 接口获取 WBI key 失败');
  }

  const imgKey = extractKeyFromUrl(imgUrl);
  const subKey = extractKeyFromUrl(subUrl);

  if (!imgKey || !subKey) {
    throw new Error('无法从 WBI 图片 URL 中提取 key');
  }

  const pair: WbiKeyPair = {
    imgKey,
    subKey,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
  cachedKeys.set(cacheKey, pair);

  return pair;
}

/**
 * 获取当前缓存的 WBI key，未缓存时自动拉取。
 */
export async function getWbiKeys(cookie?: string): Promise<{ imgKey: string; subKey: string }> {
  const pair = await fetchWbiKeys(cookie);
  return { imgKey: pair.imgKey, subKey: pair.subKey };
}

/**
 * 清空 WBI key 缓存，主要用于出错后重试或测试。
 */
export function clearWbiKeyCache(): void {
  cachedKeys.clear();
}
