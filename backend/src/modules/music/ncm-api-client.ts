/**
 * 内部 NCM API 调用客户端。
 *
 * 所有网易云业务（转发、登录态校验、专辑补齐、音频流解析）统一经此处调用
 * 内部服务，避免每处各自拼 URL / 解析 JSON / 处理 Set-Cookie。
 */
import { getNcmApiBase } from './ncm-api.service';

/** 内部 NCM API 调用结果 */
export interface NcmCallResult {
  status: number;
  body: unknown;
  setCookies: string[];
}

/**
 * 以 GET 方式调用内部 NCM API 并解析 JSON 响应。
 *
 * 每次请求附加 timestamp 参数：内部服务挂有 2 分钟的 apicache 中间件，
 * 缓存 key 仅含 method+URL（不含 cookie），不同登录态的相同 URL 会命中
 * 同一缓存导致串味（匿名结果被 VIP 用户拿到），必须以唯一 URL 绕过。
 */
export async function callNcmApi(
  path: string,
  cookieHeader: string,
): Promise<NcmCallResult> {
  const timestamp = Date.now();
  const url = `${getNcmApiBase()}${path}${path.includes('?') ? '&' : '?'}timestamp=${timestamp}`;
  const upstream = await fetch(url, {
    method: 'GET',
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  const setCookies = upstream.headers.getSetCookie();
  const text = await upstream.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: upstream.status, body, setCookies };
}
