import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
  DanmakuProviderContext,
} from '../types';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * fetch 请求统一超时时间（毫秒）。
 * 巴哈姆特服务器在台湾，从大陆访问延迟较高，10s 经常超时，提高到 25s。
 */
const FETCH_TIMEOUT_MS = 25_000;
/** 网络请求最大重试次数（仅对超时/网络层错误重试，HTTP 4xx/5xx 不重试）。 */
const MAX_FETCH_RETRIES = 1;

interface BahamutSearchResult {
  sn: string;
  title: string;
  cover?: string;
}

interface BahamutEpisodeInfo {
  sn: string;
  label: string;
}

/** 解码常见的 HTML 实体，避免标题中出现 &amp; 等转义字符。 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * 规范化封面 URL：
 * - 协议相对（//xxx）→ 补 https:
 * - 路径相对（/xxx）→ 补巴哈姆特域名
 * - 空/无效 → 返回 undefined
 */
function normalizeCoverUrl(url: string | undefined): string | undefined {
  if (!url || !url.trim()) return undefined;
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `https://ani.gamer.com.tw${trimmed}`;
  return trimmed;
}

/**
 * 创建一个带超时的 AbortController，超时后会自动 abort。
 * 返回 controller 与清理函数，调用方需在请求结束后调用 clear 清理定时器。
 */
function createTimeoutSignal(timeoutMs: number = FETCH_TIMEOUT_MS): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/** 将可能是网络错误/超时的异常转换为带语义的错误消息。 */
function wrapNetworkError(stage: string, url: string, err: unknown): Error {
  if (err instanceof Error) {
    // AbortError 来自超时
    if (err.name === 'AbortError') {
      return new Error(`巴哈姆特${stage}超时（${FETCH_TIMEOUT_MS / 1000}s）：${url}`);
    }
    // 其它 TypeError / 网络层错误
    return new Error(`巴哈姆特${stage}网络错误：${err.message}`);
  }
  return new Error(`巴哈姆特${stage}发生未知错误`);
}

/**
 * 抓取指定 URL 的 HTML 文本，带超时、重试与错误归一化。
 * 仅对超时/网络层错误重试，HTTP 4xx/5xx 直接抛错不重试。
 */
async function fetchHtml(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    const { signal, clear } = createTimeoutSignal();
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: 'https://ani.gamer.com.tw',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        },
      });
    } catch (err) {
      lastErr = err;
      clear();
      // 超时/网络层错误：重试（最后一次失败才抛错）
      if (attempt < MAX_FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw wrapNetworkError('请求页面', url, err);
    } finally {
      clear();
    }

    if (!res.ok) {
      // HTTP 错误状态码：不重试，直接抛错
      throw new Error(`巴哈姆特请求失败 [HTTP ${res.status}]：${url}`);
    }

    try {
      return await res.text();
    } catch (err) {
      throw new Error(`巴哈姆特读取页面内容失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 理论上不会走到这里，但 TypeScript 需要返回值
  throw wrapNetworkError('请求页面', url, lastErr ?? new Error('未知错误'));
}

/**
 * 通过关键词搜索巴哈姆特番剧。
 * 解析 search.php 返回的 HTML，提取 theme-list-main 区块。
 *
 * 巴哈姆特搜索页的 HTML 属性引号不固定（单/双引号均可能出现，且会随版本变化），
 * 因此所有正则均使用 `['"]` 字符类兼容两种引号，避免因引号变更导致解析失效。
 *
 * 搜索结果链接格式为 <a href="animeRef.php?sn=XXX" class="theme-list-main">，
 * 标题在 alt 属性或 theme-name 标签中，封面在 data-src 属性中。
 */
async function searchBahamutByKeyword(keyword: string): Promise<BahamutSearchResult[]> {
  const html = await fetchHtml(
    `https://ani.gamer.com.tw/search.php?keyword=${encodeURIComponent(keyword)}`,
  );

  const results: BahamutSearchResult[] = [];
  const seen = new Set<string>();

  // 按 theme-list-main 切分搜索结果块（兼容单/双引号）
  const blocks = html.split(/class=['"]theme-list-main['"]/);

  // 回退策略：若 theme-list-main 切分失败（页面结构变更），直接匹配所有
  // animeRef.php?sn=XXX 链接所在的 <a> ... </a> 块
  if (blocks.length <= 1) {
    return searchBahamutFallback(html);
  }

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    // 提取 sn（animeRef.php?sn=XXX）
    const snMatch = block.match(/animeRef\.php\?sn=(\d+)/);
    if (!snMatch) continue;
    const sn = snMatch[1];
    if (seen.has(sn)) continue;
    seen.add(sn);

    // 优先从 alt 属性提取标题，回退到 theme-name 标签（兼容单/双引号）
    const altMatch = block.match(/alt=['"]([^'"]+)['"]/);
    const nameMatch = block.match(/class=['"]theme-name['"]>([^<]+)</);
    const title = decodeHtmlEntities(
      (altMatch?.[1] || nameMatch?.[1] || `番剧 SN${sn}`).trim(),
    );

    // 提取封面图：优先 data-src（懒加载），回退到 src（兼容单/双引号）
    const coverMatch =
      block.match(/data-src=['"]([^'"]+)['"]/) ||
      block.match(/<img[^>]*src=['"]([^'"]+)['"]/);

    results.push({ sn, title, cover: normalizeCoverUrl(coverMatch?.[1]) });
  }

  // 若主解析未提取到结果，尝试回退策略
  if (results.length === 0) {
    return searchBahamutFallback(html);
  }

  return results.slice(0, 20);
}

/**
 * 回退搜索策略：当 theme-list-main 区块解析失败时使用。
 * 直接扫描 HTML 中所有 animeRef.php?sn=XXX 链接，提取 sn 与周围的标题/封面。
 * 每个匹配取链接前后各 ~500 字符作为上下文块解析标题与封面。
 */
function searchBahamutFallback(html: string): BahamutSearchResult[] {
  const results: BahamutSearchResult[] = [];
  const seen = new Set<string>();

  // 匹配所有 animeRef.php?sn=XXX 出现的位置
  const snRegex = /animeRef\.php\?sn=(\d+)/g;
  let snMatch: RegExpExecArray | null;
  while ((snMatch = snRegex.exec(html)) !== null) {
    const sn = snMatch[1];
    if (seen.has(sn)) continue;
    seen.add(sn);

    // 取匹配位置前后各 500 字符作为上下文
    const start = Math.max(0, snMatch.index - 500);
    const end = Math.min(html.length, snMatch.index + 500);
    const context = html.slice(start, end);

    // 提取标题：alt 属性优先，回退到 theme-name 标签
    const altMatch = context.match(/alt=['"]([^'"]+)['"]/);
    const nameMatch = context.match(/class=['"]theme-name['"]>([^<]+)</);
    const title = decodeHtmlEntities(
      (altMatch?.[1] || nameMatch?.[1] || `番剧 SN${sn}`).trim(),
    );

    // 提取封面图
    const coverMatch =
      context.match(/data-src=['"]([^'"]+)['"]/) ||
      context.match(/<img[^>]*src=['"]([^'"]+)['"]/);

    results.push({ sn, title, cover: normalizeCoverUrl(coverMatch?.[1]) });
  }

  return results.slice(0, 20);
}

/**
 * 通过番剧 sn（animeRef.php 的 sn）获取该番剧下的所有集数。
 * animeRef.php 页面包含剧集列表，格式为：
 * <a href="?sn=XXX" data-ani-video-sn="XXX">集数编号</a>
 *
 * 正则兼容单/双引号，避免页面引号风格变更导致解析失效。
 */
async function getBahamutEpisodesBySn(sn: string): Promise<BahamutEpisodeInfo[]> {
  const html = await fetchHtml(`https://ani.gamer.com.tw/animeRef.php?sn=${sn}`);

  const episodes: BahamutEpisodeInfo[] = [];
  const seen = new Set<string>();

  // 匹配 data-ani-video-sn="XXX" 的链接，提取 sn 和显示文本（集数编号）
  // 兼容单/双引号
  const epRegex = /<a[^>]*data-ani-video-sn=['"](\d+)['"][^>]*>([^<]+)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = epRegex.exec(html)) !== null) {
    const epSn = match[1];
    if (seen.has(epSn)) continue;
    seen.add(epSn);
    const label = match[2].trim();
    episodes.push({ sn: epSn, label });
  }

  // 若未匹配到剧集列表，认为当前番剧只有一集，使用番剧自身的首个 animeVideo sn
  if (episodes.length === 0) {
    // 从 animeRef 页面提取 animeVideo.php?sn=XXX
    const videoSnMatch = html.match(/animeVideo\.php\?sn=(\d+)/);
    const videoSn = videoSnMatch ? videoSnMatch[1] : sn;
    episodes.push({ sn: videoSn, label: '1' });
  }

  return episodes;
}

/**
 * 将颜色值解析为统一的数字格式（0xRRGGBB）。
 * 兼容 #RRGGBB、#RGB、纯数字（十进制）等多种输入。
 */
function parseBahamutColor(color: unknown): number {
  if (typeof color === 'number' && Number.isFinite(color)) {
    return color;
  }
  if (typeof color === 'string') {
    const trimmed = color.trim().replace(/^#/, '');
    if (!trimmed) return 0xffffff;
    // #RGB 缩写形式扩展为 #RRGGBB
    const expanded = trimmed.length === 3
      ? trimmed.split('').map((c) => c + c).join('')
      : trimmed;
    const parsed = parseInt(expanded, 16);
    if (Number.isFinite(parsed)) return parsed;
    // 可能是十进制字符串
    const dec = parseInt(trimmed, 10);
    if (Number.isFinite(dec)) return dec;
  }
  return 0xffffff;
}

/**
 * 将巴哈姆特弹幕的 size 档位映射为实际像素字号。
 * 巴哈姆特返回的 size 为档位值（1=小, 2=中, 3=大），需转换为像素值。
 */
function mapBahamutSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 25;
  switch (size) {
    case 1:
      return 20; // 小
    case 2:
      return 28; // 中
    case 3:
      return 36; // 大
    default:
      return 25;
  }
}

/** 调用巴哈姆特弹幕接口获取指定 sn 的弹幕列表。 */
async function getBahamutDanmaku(sn: string): Promise<DanmakuItem[]> {
  const url = 'https://ani.gamer.com.tw/ajax/danmuGet.php';
  const { signal, clear } = createTimeoutSignal();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: `https://ani.gamer.com.tw/animeVideo.php?sn=${sn}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({ sn }).toString(),
    });
  } catch (err) {
    throw wrapNetworkError('获取弹幕', url, err);
  } finally {
    clear();
  }

  if (!res.ok) {
    throw new Error(`巴哈姆特弹幕接口返回失败 [HTTP ${res.status}]`);
  }

  // 巴哈姆特弹幕接口直接返回数组（非 { data: [] } 包装）
  let json: Array<{
    text?: string;
    time?: number | string;
    color?: string | number;
    position?: number;
    sn?: number | string;
    size?: number;
  }>;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`巴哈姆特弹幕接口响应解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // 兼容数组或 { data: [] } 两种返回格式
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as unknown as { data?: unknown[] }).data)
      ? (json as unknown as { data: typeof json }).data
      : [];

  const items: DanmakuItem[] = [];
  for (const d of list) {
    if (typeof d.text !== 'string' || !d.text.trim()) continue;

    // 巴哈姆特弹幕 time 单位为毫秒，需除以 1000 转换为秒
    const timeNum = typeof d.time === 'number'
      ? d.time
      : parseFloat(String(d.time ?? '0'));
    const time = Number.isFinite(timeNum) ? timeNum / 1000 : 0;

    // position: 0=滚动, 1=顶部, 2=底部, 3=特殊
    // 与统一格式（0=滚动, 1=顶部, 2=底部）一致，3 及其它未知值回退为滚动
    const rawMode = typeof d.position === 'number' ? d.position : 0;
    const mode = rawMode === 1 || rawMode === 2 ? rawMode : 0;

    items.push({
      id: String(d.sn ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      content: d.text,
      time,
      mode,
      color: parseBahamutColor(d.color),
      size: mapBahamutSize(d.size),
    });
  }

  return items;
}

export const bahamutDanmakuProvider: DanmakuSourceProvider = {
  name: '巴哈姆特动画疯',

  async search(keyword: string, _ctx?: DanmakuProviderContext): Promise<DanmakuSearchResult[]> {
    const results = await searchBahamutByKeyword(keyword);
    return results.map((r) => ({
      id: r.sn,
      title: r.title,
      cover: r.cover,
      source: 'bahamut',
      extra: { sn: r.sn },
    }));
  },

  async getEpisodes(identifier: string, _ctx?: DanmakuProviderContext): Promise<DanmakuEpisode[]> {
    const sn = identifier.replace(/\D/g, '');
    if (!sn) {
      throw new Error('无法解析巴哈姆特 SN');
    }

    const episodes = await getBahamutEpisodesBySn(sn);
    return episodes.map((ep, idx) => ({
      id: ep.sn,
      title: `第 ${ep.label} 集`,
      episodeNumber: idx + 1,
      playbackParams: { sn: ep.sn },
    }));
  },

  async getDanmaku(episode: DanmakuEpisode, _ctx?: DanmakuProviderContext): Promise<DanmakuItem[]> {
    const sn = episode.playbackParams.sn;
    if (typeof sn !== 'string' || !sn) {
      throw new Error('缺少巴哈姆特 sn 参数');
    }
    return getBahamutDanmaku(sn);
  },
};
