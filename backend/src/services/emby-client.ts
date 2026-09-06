/**
 * Emby 客户端服务（独立模块，无 Express 依赖）
 *
 * 对应 synctv vendors/emby 的 REST 客户端，适配 ZViewer 技术栈：
 * - 账号密码登录（authenticatebyname）或直接使用 API Key（X-Emby-Token）
 * - 媒体库浏览（Views / Items / Seasons / Episodes）
 * - 播放信息（PlaybackInfo，生成直连 / 转码 URL）
 * 视频流代理由 routes/emby.ts 复用 services/proxy/http-proxy.ts 完成。
 */

import { normalizeServerUrlWithScheme } from './network-utils';

const DEFAULT_TIMEOUT_MS = 10000;

/** Emby 客户端标识头（所有请求都需要，登录请求尤其必需） */
const EMBY_AUTHORIZATION_HEADER =
  'MediaBrowser Client="ZViewer", Device="Web Browser", DeviceId="zviewer-web-' +
  Math.random().toString(36).slice(2, 12) +
  '", Version="1.0.0"';

export interface EmbyLoginResult {
  /** 会话 token（X-Emby-Token） */
  token: string;
  /** 服务器 ID */
  serverId: string;
  /** Emby 用户 ID */
  userId: string;
  /** 用户名 */
  userName: string;
}

export interface EmbyUserInfo {
  Id: string;
  Name: string;
  ServerId: string;
}

/** Emby 媒体流（含字幕流），对应 MediaStreams 数组元素。 */
export interface EmbyMediaStream {
  Index: number;
  Type: string; // 'Video' | 'Audio' | 'Subtitle'
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  IsExternal?: boolean;
  DeliveryMethod?: string; // 'External' | 'Embedded' | 'Hls' ...
  DeliveryUrl?: string;
}

/** Emby 媒体源（MediaSource），含流列表。 */
export interface EmbyMediaSource {
  Id: string;
  Path: string;
  Container?: string;
  DirectPlayUrl?: string;
  TranscodingUrl?: string;
  MediaStreams?: EmbyMediaStream[];
}

export interface EmbyItem {
  Id: string;
  Name: string;
  Type: string;
  /** 是否为文件夹/可展开 */
  IsFolder?: boolean;
  /** 子项数量（剧集/季等） */
  ChildCount?: number;
  /** 是否为文件（可播放） */
  IsFile?: boolean;
  /** 媒体源信息（PlaybackInfo 或带 Fields=MediaSources 时返回） */
  MediaSources?: EmbyMediaSource[];
}

export interface EmbyPlaybackInfo {
  MediaSources: EmbyMediaSource[];
}

export interface EmbyClientOptions {
  serverUrl: string;
  /** X-Emby-Token（API Key 或登录后的会话 token） */
  token?: string;
  timeoutMs?: number;
}

interface EmbyRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 使用 API Key 请求头（GET 用 query，POST 用 X-Emby-Token） */
  authHeader?: boolean;
  /** 响应类型：默认 json；字幕等纯文本响应传 'text' */
  responseType?: 'json' | 'text';
}

export class EmbyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'EmbyError';
  }
}

function normalizeServerUrl(url: string): string {
  // 统一走 network-utils：补默认 scheme（用户输入裸地址 `192.168.1.5:8096`
  // 时若不补 http://，运行时 new URL 会把 "192.168.1.5:" 当非法 scheme 抛错）
  const normalized = normalizeServerUrlWithScheme(url);
  return normalized.length > 0 ? normalized : 'http://localhost:8096';
}

export class EmbyClient {
  /** 归一化后的服务器基础地址（供路由构造直连 URL） */
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: EmbyClientOptions) {
    this.baseUrl = normalizeServerUrl(opts.serverUrl);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(reqOpts: EmbyRequestOptions): Promise<T> {
    const { method = 'GET', path, query, body, authHeader = true } = reqOpts;

    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Emby-Authorization': EMBY_AUTHORIZATION_HEADER,
    };
    if (this.opts.token) {
      // 所有请求都通过 X-Emby-Token 头传递 token（Emby 推荐方式）
      headers['X-Emby-Token'] = this.opts.token;
      // GET 请求同时通过 api_key 查询参数传递（兼容旧版 Emby/Jellyfin）
      if (method === 'GET' && authHeader) {
        url.searchParams.set('api_key', this.opts.token);
      }
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = '';
        try {
          const j = (await res.json()) as { Message?: string; Error?: { message?: string } };
          detail = j.Message ?? j.Error?.message ?? '';
        } catch {
          /* ignore */
        }
        throw new EmbyError(
          detail || `Emby 请求失败: ${res.status}`,
          res.status,
          'EMBY_REQUEST_FAILED',
        );
      }
      if (res.status === 204) return undefined as T;
      if (reqOpts.responseType === 'text') {
        return (await res.text()) as unknown as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof EmbyError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EmbyError(`Emby 请求超时（${this.timeoutMs}ms）`, undefined, 'TIMEOUT');
      }
      throw new EmbyError(
        err instanceof Error ? `Emby 连接失败: ${err.message}` : 'Emby 连接失败',
        undefined,
        'UNREACHABLE',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 账号密码登录，返回会话 token 与用户信息。
   * POST /emby/Users/authenticatebyname
   */
  async login(username: string, password: string): Promise<EmbyLoginResult> {
    const res = await this.request<{
      AccessToken: string;
      ServerId: string;
      User?: { Id: string; Name: string };
    }>({
      method: 'POST',
      path: '/emby/Users/authenticatebyname',
      body: { Username: username, Pw: password },
      authHeader: false,
      // 登录请求需要 Emby 客户端标识头
    });
    if (!res.AccessToken || !res.User?.Id) {
      throw new EmbyError('Emby 登录失败：服务器未返回有效会话', undefined, 'LOGIN_FAILED');
    }
    return {
      token: res.AccessToken,
      serverId: res.ServerId,
      userId: res.User.Id,
      userName: res.User.Name,
    };
  }

  /**
   * 获取当前用户信息。
   * 优先 GET /emby/Users/Me；若失败（部分 Emby 版本返回 500），
   * 回退到 GET /emby/Users 列表，选取第一个管理员用户。
   */
  async me(): Promise<EmbyUserInfo> {
    try {
      const res = await this.request<{ Id: string; Name: string; ServerId: string }>({
        path: '/emby/Users/Me',
      });
      return res;
    } catch {
      // 回退：列出用户，取第一个管理员
      const users = await this.request<Array<{
        Id: string;
        Name: string;
        ServerId?: string;
        Policy?: { IsAdministrator?: boolean };
      }>>({
        path: '/emby/Users',
      });
      const admin = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
      if (!admin) {
        throw new EmbyError('Emby 服务器无可用用户', undefined, 'NO_USER');
      }
      return {
        Id: admin.Id,
        Name: admin.Name,
        ServerId: admin.ServerId ?? '',
      };
    }
  }

  /** 媒体库（媒体文件夹）列表 GET /emby/Users/{userId}/Views */
  async userViews(userId: string): Promise<EmbyItem[]> {
    const res = await this.request<{ Items?: EmbyItem[] }>({
      path: `/emby/Users/${encodeURIComponent(userId)}/Views`,
      query: { Fields: 'ChildCount' },
    });
    return res.Items ?? [];
  }

  /** 目录/条目列表 GET /emby/Users/{userId}/Items?ParentId= */
  async items(
    userId: string,
    parentId?: string,
    includeItemTypes?: string,
  ): Promise<EmbyItem[]> {
    const res = await this.request<{ Items?: EmbyItem[]; TotalRecordCount?: number }>({
      path: `/emby/Users/${encodeURIComponent(userId)}/Items`,
      query: {
        ParentId: parentId,
        IncludeItemTypes: includeItemTypes,
        Fields: 'ChildCount,MediaSources,Path',
        Recursive: parentId ? undefined : 'false',
      },
    });
    return res.Items ?? [];
  }

  /** 搜索 GET /emby/Users/{userId}/Items?SearchTerm= */
  async search(userId: string, term: string): Promise<EmbyItem[]> {
    const res = await this.request<{ Items?: EmbyItem[] }>({
      path: `/emby/Users/${encodeURIComponent(userId)}/Items`,
      query: {
        SearchTerm: term,
        Fields: 'ChildCount,MediaSources,Path',
        Recursive: 'true',
      },
    });
    return res.Items ?? [];
  }

  /**
   * 播放信息 POST /emby/Items/{itemId}/PlaybackInfo?UserId=
   * 返回媒体源（直连 / 转码 URL 由 Emby 生成）。
   */
  async playbackInfo(itemId: string, userId: string): Promise<EmbyPlaybackInfo> {
    const res = await this.request<EmbyPlaybackInfo>({
      method: 'POST',
      path: `/emby/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
      query: { UserId: userId, reqformat: 'json' },
      body: {},
    });
    if (!res.MediaSources?.length) {
      throw new EmbyError('Emby 未返回可用媒体源', undefined, 'NO_MEDIA_SOURCE');
    }
    return res;
  }

  /** 停止转码 POST /emby/Videos/ActiveEncodings/Delete */
  async deleteActiveEncodings(
    deviceId: string,
    playSessionId: string,
  ): Promise<void> {
    await this.request<void>({
      method: 'POST',
      path: '/emby/Videos/ActiveEncodings/Delete',
      body: { DeviceId: deviceId, PlaySessionId: playSessionId },
    });
  }

  /**
   * 获取指定字幕轨道的内容文本（SRT/ASS/VTT）。
   * GET /emby/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream[.{ext}]
   * Emby 会把内嵌字幕转封装为对应格式输出；外挂字幕同理返回文件内容。
   */
  async subtitleContent(
    itemId: string,
    mediaSourceId: string,
    index: number,
    ext?: string,
  ): Promise<string> {
    const suffix = ext ? `.${ext}` : '';
    return this.request<string>({
      path: `/emby/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(
        mediaSourceId,
      )}/Subtitles/${index}/Stream${suffix}`,
      authHeader: true,
      responseType: 'text',
    });
  }
}

/**
 * 挂载配置 → Emby 客户端。
 * 优先使用 API Key；否则用账号密码登录（登录结果可缓存）。
 */
export async function createEmbyClientFromMount(mount: {
  serverUrl: string | null;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}): Promise<EmbyClient> {
  const serverUrl = mount.serverUrl ?? '';
  if (mount.apiKey) {
    return new EmbyClient({ serverUrl, token: mount.apiKey });
  }
  if (mount.username && mount.password) {
    const client = new EmbyClient({ serverUrl });
    const result = await client.login(mount.username, mount.password);
    return new EmbyClient({ serverUrl, token: result.token });
  }
  throw new EmbyError('Emby 挂载缺少 API Key 或账号密码', undefined, 'MISSING_CREDENTIALS');
}
