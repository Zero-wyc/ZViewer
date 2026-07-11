export interface BilibiliResponse<T = unknown> {
  code: number;
  message: string;
  ttl?: number;
  data: T;
}

export interface BilibiliFetchOptions extends RequestInit {
  /** 用于请求的 B站 Cookie 字符串。 */
  cookie?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBackoffMs(): number {
  // 1s ~ 2s 之间随机退避
  return 1000 + Math.floor(Math.random() * 1000);
}

/**
 * 从未登录请求的响应头中收集 Set-Cookie，作为匿名会话复用。
 * B站 部分接口（如 WBI）依赖 buvid3 等 Cookie 才能正常返回。
 */
let anonymousCookieJar: string | null = null;

function parseSetCookieHeader(headers: Headers): string {
  const getSetCookies = (headers as unknown as { getSetCookies?: () => string[] })
    .getSetCookies;
  let values: string[] = [];

  if (typeof getSetCookies === 'function') {
    values = getSetCookies.call(headers);
  } else {
    const single = headers.get('set-cookie');
    if (single) {
      values = single.split(',').map((s) => s.trim());
    }
  }

  return values
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

/**
 * 封装对 B站 API 的请求。
 * - 自动补充 User-Agent、Referer、Cookie。
 * - 未提供 Cookie 时，复用匿名会话 Cookie（从响应头自动收集）。
 * - 遇到 412（风控）时自动重试，最多 3 次，带 1-2s 退避。
 * - 响应 JSON 的 code 不为 0 时抛出错误。
 */
export async function bilibiliFetch<T = unknown>(
  url: string,
  options?: BilibiliFetchOptions,
): Promise<BilibiliResponse<T>> {
  const { cookie, ...requestInit } = options || {};
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const effectiveCookie = cookie || anonymousCookieJar || undefined;
      const res = await fetch(url, {
        ...requestInit,
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: 'https://www.bilibili.com',
          Origin: 'https://www.bilibili.com',
          ...(effectiveCookie ? { Cookie: effectiveCookie } : {}),
          ...(requestInit.headers || {}),
        },
      });

      // 未登录时收集匿名 Cookie，后续请求复用以提高接口成功率
      if (!cookie) {
        const setCookie = parseSetCookieHeader(res.headers);
        if (setCookie) {
          anonymousCookieJar = anonymousCookieJar
            ? `${anonymousCookieJar}; ${setCookie}`
            : setCookie;
        }
      }

      // 412 通常为风控/反爬拦截，等待后重试
      if (res.status === 412) {
        lastError = new Error(`B站 API 返回 412 风控拦截: ${url}`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(randomBackoffMs());
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        throw new Error(`B站 API 请求失败 [${res.status}] ${res.statusText}: ${url}`);
      }

      const json = (await res.json()) as BilibiliResponse<T>;

      if (json.code !== 0) {
        throw new Error(
          `B站 API 业务错误 [${json.code}] ${json.message || ''}: ${url}`,
        );
      }

      return json;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(randomBackoffMs());
      }
    }
  }

  throw lastError ?? new Error(`B站 API 请求失败: ${url}`);
}

/**
 * 发起普通的 GET 请求并返回 JSON。
 */
export function bilibiliGet<T = unknown>(
  url: string,
  options?: BilibiliFetchOptions,
): Promise<BilibiliResponse<T>> {
  return bilibiliFetch<T>(url, { ...options, method: 'GET' });
}
