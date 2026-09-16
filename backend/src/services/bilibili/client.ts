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

/**
 * 单次 B站 API 请求超时（毫秒）。
 *
 * B站 服务器偶尔会出现 TCP 连接保持但不返回任何数据的挂起现象，
 * 此时 fetch 既不 resolve 也不 reject，导致整个解析流程永久卡住
 * （前端表现为"正在选择可用 CDN..."后无响应）。此处用 AbortController
 * 强制单请求上限，触发后由上层 catch 走重试逻辑。
 */
const REQUEST_TIMEOUT_MS = 10000;

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
    // 单请求超时：B站 服务器偶发挂起（TCP 通但不返回数据），用 AbortController
    // 强制中断，避免整个解析流程永久卡住。与外部传入的 signal 合并：
    // 任一触发都中断本次 fetch。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const externalSignal = requestInit.signal;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const effectiveCookie = cookie || anonymousCookieJar || undefined;
      const res = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
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

      // 接口失效/风控时 B站 可能返回 HTML 错误页，res.json() 会抛出
      // "Unexpected token '<'"——这里转为可读错误并走重试逻辑
      let json: BilibiliResponse<T>;
      try {
        json = (await res.json()) as BilibiliResponse<T>;
      } catch {
        throw new Error(`B站 接口返回异常响应（非 JSON）: ${url}`);
      }

      if (json.code !== 0) {
        throw new Error(
          `B站 API 业务错误 [${json.code}] ${json.message || ''}: ${url}`,
        );
      }

      return json;
    } catch (err) {
      // AbortError 区分：超时中断 vs 外部 signal 中断
      if (err instanceof Error && err.name === 'AbortError') {
        if (externalSignal?.aborted) {
          // 外部主动取消，直接抛出不重试
          throw err;
        }
        lastError = new Error(`B站 API 请求超时 (${REQUEST_TIMEOUT_MS}ms): ${url}`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(randomBackoffMs());
      }
    } finally {
      clearTimeout(timer);
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
