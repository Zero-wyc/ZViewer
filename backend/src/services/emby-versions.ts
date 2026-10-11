/**
 * Emby/Jellyfin 多版本（多 MediaSource）支持
 *
 * Emby/Jellyfin 同一部影片可能有多个 MediaSource（多清晰度 / 多版本，
 * 如 Remux-1080P 与 2160P 高码率版）。PlaybackInfo 的 MediaSources[0]
 * 是服务器默认（通常最高码率），旧逻辑恒取第一个导致低清晰度无法选择。
 *
 * 本模块提供：
 * - buildEmbyVersions：把 MediaSources 转成前端可展示的版本列表
 * - selectEmbySource：按 mediaSourceId 选择版本（缺省回退第一个）
 * - buildEmbyResolvePayload：统一构建 resolve / movie-source 响应
 *   （emby.ts 与 jellyfin.ts 共用，仅 apiPrefix 不同）
 */
import type { EmbyClient, EmbyMediaSource, EmbyPlaybackInfo } from './emby-client';
import { detectMediaFormat } from './mediaFormat';
import { upgradeDirectUrlValidated } from '../modules/shared/mount-utils';
import type { UserMount } from '../entities/UserMount';

/** 前端可展示的版本条目 */
export interface EmbyVersionInfo {
  /** MediaSource.Id（切换版本时回传 ms 参数） */
  id: string;
  /** 展示标签，如 `1080P · MKV · 12.3GB` */
  label: string;
  /** 视频流分辨率高度（如 1080） */
  height?: number;
  /** 文件大小（字节） */
  size?: number;
  /** 容器格式（如 mkv） */
  container?: string;
}

/** 把 PlaybackInfo 的 MediaSources 转成版本列表 */
export function buildEmbyVersions(sources: EmbyMediaSource[]): EmbyVersionInfo[] {
  return sources.map((s, i) => {
    const video = s.MediaStreams?.find((st) => st.Type === 'Video');
    const height = video?.Height;
    const container = (s.Container ?? '').trim();
    const size = s.Size;
    const parts: string[] = [];
    if (s.Name) parts.push(s.Name);
    if (height) parts.push(`${height}P`);
    if (container) parts.push(container.toUpperCase());
    if (size && size > 0) {
      const gb = size / (1024 * 1024 * 1024);
      parts.push(gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(size / (1024 * 1024))}MB`);
    }
    return {
      id: s.Id,
      label: parts.length > 0 ? parts.join(' · ') : `版本 ${i + 1}`,
      ...(height !== undefined ? { height } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(container ? { container } : {}),
    };
  });
}

/** 按 mediaSourceId 选择版本；未匹配时回退第一个（服务器默认=最高码率） */
export function selectEmbySource(
  sources: EmbyMediaSource[],
  mediaSourceId?: string,
): EmbyMediaSource {
  if (mediaSourceId) {
    const found = sources.find((s) => s.Id === mediaSourceId);
    if (found) return found;
  }
  return sources[0];
}

export interface EmbyResolvePayloadParams {
  session: { client: EmbyClient; userId: string; token: string };
  mount: UserMount;
  itemId: string;
  mountId: number;
  /** 路由前缀：'emby' | 'jellyfin'（代理/流 URL 由此构造） */
  apiPrefix: 'emby' | 'jellyfin';
  /** 指定版本（多清晰度切换）；缺省取 MediaSources[0] */
  mediaSourceId?: string;
  /** 影片 ID：提供时额外返回 streamUrl（/api/{prefix}/stream?movieId=N&ms=X） */
  movieId?: number;
}

export interface EmbyResolvePayload {
  title: string;
  videoUrl: string;
  /** 影片 ID 场景下的播放 URL（观众可访问，不依赖请求者自有挂载） */
  streamUrl?: string;
  directUrl: string;
  format: string;
  duration: number;
  audioCodec: string | null;
  needsAudioTranscode: boolean;
  versions: EmbyVersionInfo[];
  mediaSourceId: string;
  multiVersion: boolean;
  [key: string]: unknown;
}

/**
 * 统一构建 resolve 响应：
 * 选版本 → 音轨兼容性检测 → 代理/直链 URL（带 ms 选版本参数）→ 版本列表。
 */
export async function buildEmbyResolvePayload(
  params: EmbyResolvePayloadParams,
): Promise<EmbyResolvePayload> {
  const { session, mount, itemId, mountId, apiPrefix, mediaSourceId, movieId } = params;
  const info: EmbyPlaybackInfo = await session.client.playbackInfo(itemId, session.userId);
  const source = selectEmbySource(info.MediaSources, mediaSourceId);
  const versions = buildEmbyVersions(info.MediaSources);

  // ── 音频编码兼容性检测（与原 resolve 逻辑一致）──────────────
  const BROWSER_SUPPORTED_AUDIO = new Set(['aac', 'mp3', 'flac', 'opus', 'vorbis']);
  const audioStream = source.MediaStreams?.find((s) => s.Type === 'Audio');
  const audioCodec = audioStream?.Codec ?? null;
  const needsAudioTranscode =
    !!audioStream && !!audioStream.Codec &&
    !BROWSER_SUPPORTED_AUDIO.has(audioStream.Codec.toLowerCase());

  const title = source.Path?.split(/[\\/]/).pop() || `item-${itemId}`;
  const format = needsAudioTranscode ? 'hls' : detectMediaFormat(source.Path ?? title);

  // 选版本参数：upstream URL 追加 MediaSourceId 才能播到指定版本
  const msQuery =
    info.MediaSources.length > 1
      ? `&ms=${encodeURIComponent(source.Id)}`
      : '';
  const transcodeQuery = needsAudioTranscode ? '&at=1' : '';

  // 代理 URL（请求者需持有该挂载；添加影片时由 createMovie 重写为 stream 形式）
  const proxyUrl = `/api/${apiPrefix}/proxy?mountId=${mountId}&path=${encodeURIComponent(
    itemId,
  )}${transcodeQuery}${msQuery}`;

  // 观众可访问的流 URL（按 movieId 查挂载凭证，无需请求者自有挂载）
  const streamUrl =
    movieId !== undefined
      ? `/api/${apiPrefix}/stream?movieId=${movieId}${transcodeQuery}${msQuery}`
      : undefined;

  // 直连 URL（浏览器直连 Emby/Jellyfin；直链模式影片使用）
  const directUrlRaw = needsAudioTranscode
    ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000${msQuery}`
    : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream?static=true&api_key=${session.token}${msQuery}`;
  // 升级前对 https 端点现场活性校验，防陈旧缓存产出不可达的 https 直链
  const directUrl = await upgradeDirectUrlValidated(mount, directUrlRaw);

  return {
    title,
    videoUrl: proxyUrl,
    ...(streamUrl ? { streamUrl } : {}),
    directUrl,
    format,
    duration: 0,
    audioCodec,
    needsAudioTranscode,
    versions,
    mediaSourceId: source.Id,
    multiVersion: info.MediaSources.length > 1,
    [apiPrefix]: { itemId, container: source.Container ?? '' },
  };
}
