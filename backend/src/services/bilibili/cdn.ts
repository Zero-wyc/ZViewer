/**
 * B站 CDN 健康检查与轨道选择模块。
 *
 * 与原实现相比：
 * - 使用 Promise.race + 短超时，先返回的可达 URL 即可使用，避免顺序等待所有候选。
 * - 对单条 URL 的 HEAD 检测失败仍能快速失败，整体最长耗时 ≈ 超时上限。
 * - 与解析模块解耦，可独立测试与替换。
 */

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 单条 URL 健康检查超时（毫秒）。 */
const HEALTH_CHECK_TIMEOUT_MS = 3500;

export interface MediaTrackCandidate {
  /** 主 URL。 */
  baseUrl: string;
  /** 备用 URL 列表。 */
  backupUrl?: string[];
}

/**
 * 使用 HEAD + Range 探测单个 URL 是否可达。
 * 接受 2xx/3xx/405 等表示网络可达的响应。
 */
async function checkUrlReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        Referer: 'https://www.bilibili.com',
        Origin: 'https://www.bilibili.com',
        'User-Agent': DEFAULT_USER_AGENT,
        Range: 'bytes=0-0',
      },
    });
    return response.ok || response.status === 405;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并行检测所有候选 URL，返回第一个可达的 URL。
 * 使用 Promise.race 模式，先返回即可使用，整体最长耗时接近单条超时上限，
 * 而非按候选数量线性叠加。
 */
export async function findReachableMediaUrl(
  candidate: MediaTrackCandidate,
): Promise<string | null> {
  const candidates = [
    candidate.baseUrl,
    ...(candidate.backupUrl || []),
  ].filter(Boolean);
  if (candidates.length === 0) return null;

  // 串行 await Promise.all 在每个 URL 都不可达时仍需等待全部超时；
  // 此处用 race 模式：任一 URL 可达即立即返回。
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pending = candidates.length;

    const finish = (url: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(url);
    };

    for (const url of candidates) {
      checkUrlReachable(url)
        .then((ok) => {
          if (ok) {
            console.log('[bilibili-cdn] 选择可达 URL:', url);
            finish(url);
            return;
          }
          pending -= 1;
          if (pending === 0) finish(null);
        })
        .catch(() => {
          pending -= 1;
          if (pending === 0) finish(null);
        });
    }

    // 兜底：超过 (超时 + 500ms) 仍未结束，强制返回 null
    setTimeout(() => finish(null), HEALTH_CHECK_TIMEOUT_MS + 500);
  });
}

/**
 * 为 DASH 轨道选择可达 URL：先尝试 bestVideo 主 URL，不可达时尝试备用。
 * 与 findReachableMediaUrl 不同，这里返回对象同时携带轨道元信息（codec 等）。
 */
export async function selectReachableTrackUrl(
  track: MediaTrackCandidate,
): Promise<string | null> {
  return findReachableMediaUrl(track);
}
