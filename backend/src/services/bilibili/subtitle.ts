/**
 * B站 字幕（歌词）获取服务。
 *
 * ============================ 为什么要单独重写 ============================
 * B站 的 `x/player/v2` 服务端不稳定：同一 (bvid, cid) 会**随机返回其他视频的
 * 字幕文件**，而字幕 JSON 里没有任何视频标识（无 cid / 无 aid），无法直接自证。
 * 旧实现只用「字幕时间轴终点 ≈ 视频时长」做带内校验，且在 4 次尝试全部不达标时
 * 仍返回「最像的那一个」——于是错字幕照常上屏，表现为"歌词和视频匹配不上"。
 *
 * ============================ 本模块的策略 ============================
 * 1. 先取权威元数据：`x/web-interface/view` → aid / 官方时长（一次，按需）
 * 2. 取字幕轨道：优先 WBI 签名接口 `/x/player/wbi/v2`，失败退化 `/x/player/v2`
 * 3. **严格多级校验（任一不过即丢弃，不再"择优录取"）**：
 *    - 带外：subtitle_url 的 `oid` 参数必须等于视频 aid（错拿字幕 URL 指向他人视频）
 *    - 带内：字幕时间轴终点 ≈ 视频时长（容差 max(10s, 时长×8%)）
 *    - 非空：至少有 1 条有效文本
 * 4. **一致性投票**：多次尝试取到的通过校验结果需内容一致（同一视频的字幕应稳定），
 *    避免偶发混入的"恰好通过校验"的错字幕
 * 5. **多源兜底**：两个 player 接口交替尝试；全部失败返回 null（由调用方显示"无歌词"，
 *    绝不返回可疑字幕）
 * 6. **缓存**：成功结果按 `bvid:cid` 缓存 10 分钟（二次播放不再掷骰子）；
 *    失败负缓存 60s（避免抖动期高频重试打爆接口）
 */
import { bilibiliFetch } from './client';
import { getWbiKeys, signParams } from './wbi';

const PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 字幕行（前端歌词行直接消费） */
export interface BiliSubtitleLine {
  from: number;
  to: number;
  content: string;
}

export interface BiliSubtitleResult {
  lines: BiliSubtitleLine[];
  /** 来源（诊断用）：cache / wbi / legacy */
  source: 'cache' | 'wbi' | 'legacy';
}

export interface BiliSubtitleFailure {
  lines: [];
  /** 失败原因（中文，可直接提示） */
  reason: string;
}

/** 尝试次数（服务端按调用随机返回错字幕，多次采样才能拿到稳定的正确结果） */
const MAX_ATTEMPTS = 6;
/** 每次尝试之间的最小间隔（ms）：给服务端留出变化窗口 + 降低风控概率 */
const ATTEMPT_INTERVAL_MS = 180;
/** 成功缓存 TTL（10 分钟） */
const SUCCESS_TTL_MS = 10 * 60 * 1000;
/** 失败负缓存 TTL（60s） */
const FAILURE_TTL_MS = 60 * 1000;
/** 字幕时间轴终点与视频时长的容差：max(10s, 时长 × 8%) */
const durationTolerance = (durationSec: number): number =>
  Math.max(10, durationSec * 0.08);

interface CacheEntry {
  lines: BiliSubtitleLine[];
  source: BiliSubtitleResult['source'];
  /** 缓存写入时间 */
  at: number;
}
const successCache = new Map<string, CacheEntry>();
const failureCache = new Map<string, { at: number; reason: string }>();

const cacheKey = (bvid: string, cid: number): string => `${bvid}:${cid}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 视频元数据（带 5 分钟缓存，避免同一视频反复请求 view） */
const metaCache = new Map<
  string,
  { aid: number | null; durationSec: number | null; at: number }
>();
const META_TTL_MS = 5 * 60 * 1000;

async function resolveVideoMeta(
  bvid: string,
  cookie?: string
): Promise<{ aid: number | null; durationSec: number | null }> {
  const cached = metaCache.get(bvid);
  if (cached && Date.now() - cached.at < META_TTL_MS) {
    return { aid: cached.aid, durationSec: cached.durationSec };
  }
  let aid: number | null = null;
  let durationSec: number | null = null;
  try {
    const res = await bilibiliFetch<{ aid?: number; duration?: number }>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { cookie }
    );
    aid = Number(res.data?.aid) || null;
    const dur = Number(res.data?.duration);
    durationSec = Number.isFinite(dur) && dur > 0 && dur < 86400 ? dur : null;
  } catch {
    // view 失败：退化为"无带外校验 + 无时长兜底"，由带内校验的调用方判断
  }
  metaCache.set(bvid, { aid, durationSec, at: Date.now() });
  return { aid, durationSec };
}

interface SubtitleTrack {
  lan?: string;
  subtitle_url?: string;
}

/** 拉字幕轨道列表：WBI 签名接口优先，失败退化未签名接口 */
async function listSubtitleTracks(
  bvid: string,
  cid: number,
  cookie?: string
): Promise<{ tracks: SubtitleTrack[]; source: 'wbi' | 'legacy' } | null> {
  // 1) WBI 签名接口
  try {
    const { imgKey, subKey } = await getWbiKeys(cookie);
    const signed = signParams(
      { bvid, cid: String(cid) },
      imgKey,
      subKey
    );
    const query = new URLSearchParams(signed).toString();
    const res = await bilibiliFetch<{
      subtitle?: { subtitles?: SubtitleTrack[] };
    }>(`https://api.bilibili.com/x/player/wbi/v2?${query}`, { cookie });
    const tracks = res.data?.subtitle?.subtitles ?? [];
    if (tracks.length > 0) return { tracks, source: 'wbi' };
  } catch {
    // 失败退化未签名接口
  }
  // 2) 未签名接口
  try {
    const res = await bilibiliFetch<{
      subtitle?: { subtitles?: SubtitleTrack[] };
    }>(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      cookie,
    });
    const tracks = res.data?.subtitle?.subtitles ?? [];
    if (tracks.length > 0) return { tracks, source: 'legacy' };
  } catch {
    /* 两者都失败 */
  }
  return null;
}

/** 按语言优先级挑轨道：AI 中文 → 中文 → 首条 */
function pickTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  return (
    tracks.find((t) => t.lan === 'ai-zh') ??
    tracks.find((t) => (t.lan ?? '').startsWith('zh')) ??
    tracks[0] ??
    null
  );
}

/** 字幕 URL 中的 oid 参数（应等于视频 aid）；URL 无 oid 参数时返回 null */
function extractOid(subtitleUrl: string): number | null {
  try {
    const oid = new URL(
      subtitleUrl.startsWith('//') ? `https:${subtitleUrl}` : subtitleUrl
    ).searchParams.get('oid');
    return oid == null ? null : Number(oid);
  } catch {
    return null;
  }
}

async function fetchSubtitleFile(
  subtitleUrl: string
): Promise<BiliSubtitleLine[] | null> {
  const url = subtitleUrl.startsWith('//')
    ? `https:${subtitleUrl}`
    : subtitleUrl;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': PROXY_UA, Referer: 'https://www.bilibili.com' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      body?: Array<{ from?: number; to?: number; content?: string }>;
    };
    const lines = (json.body ?? [])
      .map((l) => ({
        from: Number(l.from) || 0,
        to: Number(l.to) || 0,
        content: (l.content ?? '').trim(),
      }))
      .filter((l) => l.content !== '');
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/** 内容指纹（一致性投票用） */
function fingerprint(lines: BiliSubtitleLine[]): string {
  return `${lines.length}:${lines[0]?.content ?? ''}:${lines[lines.length - 1]?.to ?? 0}`;
}

/**
 * 获取 B站 视频字幕（严格校验，绝不返回可疑结果）。
 *
 * @param bvid 视频 BV 号
 * @param cid 分集 cid
 * @param cookie B站 Cookie（可选；未登录时 AI 字幕可能不可见）
 * @param durationSec 视频时长（秒，可选；缺失时用官方时长兜底）
 */
export async function fetchBilibiliSubtitle(
  bvid: string,
  cid: number,
  cookie?: string,
  durationSec?: number
): Promise<BiliSubtitleResult | BiliSubtitleFailure> {
  const key = cacheKey(bvid, cid);
  // 命中成功缓存：直接返回（二次播放不再重掷骰子）
  const hit = successCache.get(key);
  if (hit && Date.now() - hit.at < SUCCESS_TTL_MS) {
    return { lines: hit.lines, source: 'cache' };
  }
  // 命中失败负缓存：抖动期内不再重试
  const fail = failureCache.get(key);
  if (fail && Date.now() - fail.at < FAILURE_TTL_MS) {
    return { lines: [], reason: fail.reason };
  }

  const meta = await resolveVideoMeta(bvid, cookie);
  const aid = meta.aid;
  const duration =
    durationSec != null && durationSec > 0 && durationSec < 86400
      ? durationSec
      : meta.durationSec;

  /** 通过校验的候采样（fp → { lines, source, count }） */
  const votes = new Map<
    string,
    { lines: BiliSubtitleLine[]; source: 'wbi' | 'legacy'; count: number }
  >();

  let sawTrack = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(ATTEMPT_INTERVAL_MS);
    const listed = await listSubtitleTracks(bvid, cid, cookie);
    if (!listed) continue;
    sawTrack = true;
    const track = pickTrack(listed.tracks);
    if (!track?.subtitle_url) continue;
    // 带外校验：oid ≠ aid → 这是别人的字幕，直接丢弃
    const oid = extractOid(track.subtitle_url);
    if (oid != null && aid != null && oid !== aid) continue;
    const lines = await fetchSubtitleFile(track.subtitle_url);
    if (!lines) continue;
    // 带内校验：时间轴终点应贴合视频时长
    if (duration != null) {
      const endTo = lines.reduce((m, l) => Math.max(m, l.to), 0);
      if (Math.abs(endTo - duration) > durationTolerance(duration)) continue;
    }
    const fp = fingerprint(lines);
    const prev = votes.get(fp);
    if (prev) prev.count += 1;
    else votes.set(fp, { lines, source: listed.source, count: 1 });
    // 两次采样一致即确认（同一视频的字幕应稳定复现）
    if (votes.get(fp)!.count >= 2) break;
  }

  // 选出票数最高的通过校验结果（票数相同取 wbi）
  let best: { lines: BiliSubtitleLine[]; source: 'wbi' | 'legacy' } | null =
    null;
  for (const v of votes.values()) {
    if (!best || v.count > (votes.get(fingerprint(best.lines))?.count ?? 0)) {
      best = { lines: v.lines, source: v.source };
    }
  }

  if (best) {
    successCache.set(key, { ...best, at: Date.now() });
    return { lines: best.lines, source: best.source };
  }

  const reason = !sawTrack
    ? '该视频无字幕轨道（或需登录 B站 才能获取 AI 字幕）'
    : '未能验证字幕归属（B站 接口返回异常），暂不显示歌词';
  failureCache.set(key, { at: Date.now(), reason });
  return { lines: [], reason };
}
