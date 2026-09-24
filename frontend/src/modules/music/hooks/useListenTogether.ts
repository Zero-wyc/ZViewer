import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useShallow } from 'zustand/react/shallow'
import { useRoomStore } from '@/store/roomStore'
import {
  ROOM_MEDIA_TEARDOWN_EVENT,
  type RoomMediaTeardownDetail,
} from '@/lib/mediaTeardown'
import { apiGet, getApiUrl } from '@/lib/api'
import { appendAuthToken } from '@/modules/player/services/url-proxy'
import { buildProxyUrl } from '@/modules/player/services/url-proxy'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { resolveBilibiliViaCli } from '@/modules/bilibili/cliApi'
import { getActiveCliProxyUrl } from '@/modules/room/watch-together/movie-source-resolver'
import {
  buildBilibiliImageProxyUrl,
  isBilibiliImageUrl,
} from '@/modules/room/watch-together/resolveSource'
import { message } from '@/components/ui/message'
import { compensatePositionSec } from '../utils/syncMath'
import {
  useMusicStore,
  musicItemKey,
  parseMusicKey,
  activeQueueOf,
} from '../store'
import { useMusicSettingsStore, normalizeMusicLevel } from '../store-settings'
import type {
  MusicControlRequest,
  MusicControlResponse,
  MusicQueueItem,
  MusicSyncState,
  PlayMode,
} from '../types'

/** Socket 事件名（与后端 MusicSyncHandler 约定，见 spec「音乐播放同步」节） */
const MUSIC_EVENT = {
  /** 房主广播播放状态（换曲/播放暂停/进度/播放模式） */
  SYNC_STATE: 'music:sync-state',
  /** 房主心跳（每 2s，携带完整 MusicSyncState） */
  HOST_HEARTBEAT: 'music:host-heartbeat',
  /** 队列变更后全房间广播完整队列 */
  QUEUE_CHANGED: 'music:queue-changed',
  /** 观众控制申请（观众 → 房主） */
  CONTROL_REQUEST: 'music:control-request',
  /** 控制申请应答（房主 → 申请者） */
  CONTROL_RESPONSE: 'music:control-response',
  /** 观众切歌同步成功回执（观众 → 房主，房主左下角「xx 已同步」提示） */
  SYNC_ACK: 'music:sync-ack',
  /** 加入房间时查询当前队列 + 最新同步状态（ack 返回） */
  GET_STATE: 'music:get-state',
} as const

/**
 * music:get-state 的 ack 应答（与后端 MusicSyncHandler 契约一致）。
 * syncState 为服务端缓存的房主最新同步状态（房间从未播放时为 null）。
 */
interface GetStateResponse {
  success: boolean
  message?: string
  queue?: MusicQueueItem[]
  syncState?: MusicSyncState | null
}

/** 房主心跳广播间隔（毫秒） */
const HOST_HEARTBEAT_INTERVAL_MS = 2000

/**
 * 观众判定房主离线的心跳超时（毫秒）。
 * 取心跳间隔的 3.5 倍：容忍一次心跳延迟/丢包的网络抖动——此前 5s（2.5 倍）
 * 时 interval 单次抖动即可能误判；配合房主端可见性补发，真实离线的发现
 * 延迟仍在可接受范围。
 */
const HOST_OFFLINE_TIMEOUT_MS = 7000

/** 观众离线判定的轮询间隔（毫秒） */
const HOST_OFFLINE_CHECK_INTERVAL_MS = 1000

/** B站 相关推荐一次加入的条数上限（手动「自动推荐」与列表末尾自动扩展均为前 3 条） */
const BILI_RECOMMEND_LIMIT = 3

/** /api/stream/bilibili/related 返回的相关推荐条目 */
interface BiliRelatedItem {
  bvid: string
  cid?: number
  title: string
  pic: string
  upName?: string
  duration?: number
}

/** 相关推荐条目 key（队列去重与 markBiliRecommended 共用） */
function biliRecKey(r: BiliRelatedItem): string {
  return `bili:${r.bvid}:${r.cid ?? 0}`
}

/** 相关推荐条目 → queue-upsert 载荷（B站 条目 songId=0，标 recommended） */
function biliRecToUpsertItem(r: BiliRelatedItem) {
  return {
    songId: 0,
    name: r.title,
    artist: r.upName || '哔哩哔哩',
    album: '',
    cover: r.pic,
    durationMs: Math.round((r.duration || 0) * 1000),
    vip: false,
    biliBvid: r.bvid,
    biliCid: r.cid ?? 0,
    recommended: true,
  }
}

/**
 * 拉取指定 B站 视频的相关推荐：去重房间队列已有条目后取前
 * BILI_RECOMMEND_LIMIT 条。无 bvid/cid 的条目直接剔除（入队校验需要
 * 合法 BV 号 + 正整数 cid）。
 */
async function fetchBiliRecs(bvid: string): Promise<BiliRelatedItem[]> {
  const { data } = await apiGet<{ items?: BiliRelatedItem[] }>(
    `/api/stream/bilibili/related?bvid=${bvid}`
  )
  const recs = data?.items ?? []
  const existing = new Set(useMusicStore.getState().queue.map(musicItemKey))
  return recs
    .filter((r) => r.bvid && r.cid && !existing.has(biliRecKey(r)))
    .slice(0, BILI_RECOMMEND_LIMIT)
}

/** 观众进度对齐阈值（秒）：与房主进度差超过该值才 seek */
const SYNC_ALIGN_THRESHOLD_SEC = 2

/** 音频流音质兜底值（实际档位从音乐设置 store 读取，设置页可改） */
const FALLBACK_STREAM_LEVEL = 'exhigh'

/** 控制动作的中文描述（房主端申请提示文案） */
const CONTROL_ACTION_TEXT: Record<MusicControlRequest['action'], string> = {
  pause: '暂停',
  play: '继续播放',
  next: '切换下一首',
  prev: '切换上一首',
  addQueue: '添加歌曲到播放列表',
  seek: '调节播放进度',
  playItem: '切换歌曲',
}

/** 音乐本地音量持久化 key（与视频播放器的 zc-player-volume 相互独立） */
const VOLUME_STORAGE_KEY = 'zc-music-volume'

/** 读取持久化的本地音量（0-1，无效/缺失时回退 1） */
function loadPersistedVolume(): number {
  try {
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY)
    if (!saved) return 1
    const v = parseFloat(saved)
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
  } catch {
    return 1
  }
}

/**
 * 构建音频流代理地址。
 * 使用 getApiUrl() 实时读取（自定义后端地址变更后立即生效），
 * 并附加 access token（媒体元素请求无法携带 Authorization 头，
 * HTTP 部署场景下后端从查询参数读取 token）。
 * 携带 roomId：当前用户无网易云凭证时，后端回退用房主凭证解析
 * （spec「房主登录后全房间可播 VIP」）。
 * 音质档位从音乐设置 store 实时读取（设置页「音质选择」即时生效）；
 * 非法档位回退 exhigh。
 * 地址格式：`?songId=<id>&level=exhigh[&direct=1]`
 */
function buildStreamUrl(
  item: MusicQueueItem,
  roomId: string | undefined
): string {
  // B站 本地插播条目：地址在 playBiliSong 解析时写入缓存
  if (isBiliItem(item)) {
    const mapKey = `${item.biliBvid}:${item.biliCid ?? 0}`
    return getCachedBiliAudioUrl(mapKey) ?? ''
  }
  const roomParam = roomId ? `&roomId=${encodeURIComponent(roomId)}` : ''
  const level = normalizeMusicLevel(
    useMusicSettingsStore.getState().level || FALLBACK_STREAM_LEVEL
  )
  // 直链模式（设置「音源直连」）：请后端 302 重定向到 CDN 直链，
  // <audio> 直连网易云、服务器不走音频流；加载失败直接报错
  //（设置项为开关，关闭后走代理流）
  const directParam = useMusicSettingsStore.getState().directSource
    ? '&direct=1'
    : ''
  return appendAuthToken(
    `${getApiUrl()}/api/music/stream?songId=${item.songId}&level=${level}${roomParam}${directParam}`
  )
}

/** 从房主广播的同步状态解析曲目 key（trackKey 为权威，兼容旧 trackSongId） */
function syncKeyOf(payload: MusicSyncState): string | null {
  if (payload.trackKey != null) return payload.trackKey
  return payload.trackSongId != null ? `ncm:${payload.trackSongId}` : null
}

/** B站 本地插播条目判定（biliBvid 存在即 B站 音频源） */
function isBiliItem(item: MusicQueueItem): boolean {
  return typeof item.biliBvid === 'string' && item.biliBvid.length > 0
}

/**
 * B站 视频音频地址缓存（`<bvid>:<cid>` → { url, 解析时间 }）。
 * playBiliSong 点击时解析写入；B站 音频不入后端队列，仅本地会话有效。
 * **带 TTL**：B站 直链（代理 URL 背后的 CDN 地址/鉴权参数）通常 1~4 小时
 * 过期，长会话中切回旧歌若命中过期地址会 403 黑屏——超过 2 小时的条目
 * 视为失效并重新解析。
 */
const BILI_AUDIO_URL_TTL_MS = 2 * 60 * 60 * 1000
const biliAudioUrlMap = new Map<string, { url: string; at: number }>()

/** 读取缓存（未过期返回 URL，过期/不存在返回 null 并清除条目） */
function getCachedBiliAudioUrl(mapKey: string): string | null {
  const cached = biliAudioUrlMap.get(mapKey)
  if (!cached) return null
  if (Date.now() - cached.at > BILI_AUDIO_URL_TTL_MS) {
    biliAudioUrlMap.delete(mapKey)
    return null
  }
  return cached.url
}

/** 正在懒解析中的 B站 条目 key（同 key 重复触发直接忽略） */
const biliResolvingKeys = new Set<string>()

/** B站 解析默认清晰度（无 CLI 时取 720P MP4 直链，audio 元素仅出声） */
const BILI_DEFAULT_QN = 64

/**
 * 解析 B站 视频音频直链（结果写入 biliAudioUrlMap 并返回）。
 * 已有缓存直接返回；供 playBiliSong 与 loadAndPlaySong 的懒解析兜底共用
 *（队列/同步场景下 B站 条目可能尚未解析过）。
 */
async function resolveBiliAudio(
  item: MusicQueueItem
): Promise<{ playUrl: string; durationMs: number }> {
  if (!item.biliBvid) throw new Error('缺少 B站 视频信息')
  const mapKey = `${item.biliBvid}:${item.biliCid ?? 0}`
  const cached = getCachedBiliAudioUrl(mapKey)
  if (cached) return { playUrl: cached, durationMs: item.durationMs }
  const pageUrl = `https://www.bilibili.com/video/${item.biliBvid}`
  const proxyUrl = useMusicSettingsStore.getState().musicVideoCli
    ? getActiveCliProxyUrl()
    : null
  let playUrl: string
  let durationMs = item.durationMs
  if (proxyUrl) {
    // CLI 高画质：DASH 音轨 m4s（已是本地代理 URL，audio 直连）
    const r = await resolveBilibiliViaCli(
      proxyUrl,
      item.biliBvid,
      item.biliCid,
      undefined,
      false,
      true
    )
    if (!r.audioUrl && !r.videoUrl) {
      throw new Error('未获取到音频地址')
    }
    playUrl = (r.audioUrl ?? r.videoUrl) as string
    if (r.duration) durationMs = Math.round(r.duration * 1000)
  } else {
    // 服务器端解析 720P MP4 直链（音视频合一，audio 元素仅出声），
    // 经后端媒体代理注入 Referer 绕过防盗链
    const r = await resolveBilibiliWithOptions(
      pageUrl,
      BILI_DEFAULT_QN,
      undefined,
      { preferMp4: true }
    )
    if (!r.videoUrl) throw new Error('未获取到音频地址')
    playUrl = buildProxyUrl(r.videoUrl)
    if (r.duration) durationMs = Math.round(r.duration * 1000)
  }
  biliAudioUrlMap.set(mapKey, { url: playUrl, at: Date.now() })
  return { playUrl, durationMs }
}

/** Fisher-Yates 洗牌（返回打乱后的新数组；元素为曲目 key） */
function shuffleKeys(keys: string[]): string[] {
  const arr = keys.slice()
  for (let i = 0; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

/** 判断两组曲目 key 是否为同一集合（多重集比较，忽略顺序） */
function isSameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((id, i) => id === sb[i])
}

export interface UseListenTogetherOptions {
  socket: Socket | null
  roomId: string | undefined
  /** 是否为房主（房主为同步源：直接控制 + 广播 + 心跳） */
  isHost: boolean
  /** 当前用户名（观众申请控制时随请求发送，房主提示文案用） */
  username?: string
}

export interface UseListenTogetherResult {
  /** 播放/暂停切换（拥有直接控制权时生效，否则由 UI 走申请流程） */
  togglePlay: () => void
  /** 下一首（按播放模式计算目标） */
  next: () => void
  /** 上一首（按播放模式计算目标） */
  prev: () => void
  /** 跳转到指定进度（秒） */
  seek: (sec: number) => void
  /** 切换播放模式（房主切换并广播同步） */
  setPlayMode: (mode: PlayMode) => void
  /** 播放指定曲目（按队列条目，替代 songId 签名） */
  playSong: (item: MusicQueueItem) => void
  /**
   * 播放 B站 视频音频（哔哩哔哩页点击视频）：解析后作为本地插播曲目，
   * 不入房间队列、不同步；默认同时插入 B站 播放列表当前曲目的下一首，
   * 传 { insertAfterCurrent: false } 跳过插入（自动连播路径）；异常经
   * message 提示
   */
  playBiliSong: (
    item: MusicQueueItem,
    opts?: { insertAfterCurrent?: boolean }
  ) => Promise<void>
  /**
   * 「自动推荐」按钮（播放列表弹窗工具栏）：按当前播放的 B站 视频拉取
   * 相关推荐前 3 条，插入当前曲目之后的下三首（canManage 直接入队；
   * 观众走 addQueue 申请）。返回实际加入/申请条数。
   */
  addBiliRecommendations: (canManage: boolean) => Promise<number>
  /** 观众：向房主申请控制（暂停/继续/切歌） */
  requestControl: (
    action: MusicControlRequest['action'],
    positionSec?: number,
    item?: MusicControlRequest['item']
  ) => void
  /** 房主：通过观众当前的控制申请（执行动作 + 应答申请者） */
  approveControl: () => void
  /** 房主：拒绝观众当前的控制申请（仅应答申请者） */
  rejectControl: () => void
  /** 当前播放的队列条目（queue + currentKey 匹配，无播放时 null） */
  currentSong: MusicQueueItem | null
  /** 是否拥有直接控制权（房主或房主离线时的观众） */
  canControl: boolean
  /** 房主是否离线（观众端心跳超时判定） */
  hostOffline: boolean
  /** 播放器左上角提示文字（自动消失逻辑由组件实现） */
  syncNotice: string | null
  /** 提示类别：approval = 待审批申请（房主端渲染通过/拒绝按钮） */
  syncNoticeKind: 'info' | 'approval'
  /** 设置提示文字（null 清除；kind 标记是否为待审批申请） */
  setSyncNotice: (notice: string | null, kind?: 'info' | 'approval') => void
  /** 本地播放音量（0-1，仅本地生效不参与房间同步） */
  volume: number
  /** 设置本地播放音量（0-1，持久化到 localStorage；0 视为静音） */
  setVolume: (volume: number) => void
  /** 当前主音频元素（惰性创建；预载升格时会被替换，可视化消费方需感知） */
  getAudio: () => HTMLAudioElement | null
}

/**
 * 把音频元素挂到 body 尾部（display:none）：MediaSession 系统媒体通知
 * （Android 状态栏/锁屏、iOS 控制中心）依赖浏览器对「页面内有媒体元素
 * 在播」的感知——部分安卓浏览器/WebView 对**脱离 DOM** 的媒体元素不建立
 * 媒体会话，通知不出现。挂 DOM 是 MediaSession 可靠生效的前提，
 * 幂等（已在 DOM 中时 appendChild 仅移动，无副作用）。
 */
function mountMediaElement(el: HTMLAudioElement): void {
  if (el.parentElement) return
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('data-lt-media', '')
  el.style.display = 'none'
  document.body.appendChild(el)
}

/** 把音频元素从 DOM 移除（与 mountMediaElement 配对；防替换/卸载后残留） */
function unmountMediaElement(el: HTMLAudioElement): void {
  el.remove()
}

/**
 * 一起听核心 Hook：音频播放引擎 + 房主/观众同步。
 *
 * 结构对齐 useWatchTogether（socket 事件注册、房主/观众分支、
 * 心跳、申请制、房主离线判定 hostOffline → canControl），但大幅简化：
 * - 音频元素惰性创建（useRef 持有，创建即挂 DOM display:none——
 *   MediaSession 系统媒体通知要求媒体元素在 DOM 内，见 mountMediaElement），
 *   src 走 /api/music/stream 代理
 * - 房主：togglePlay/next/prev/seek/setPlayMode 直接操作 audio 并广播
 *   'music:sync-state'；ended 按 playMode 自动切歌；每 2s 心跳
 * - 观众：监听 sync-state/心跳对齐（进度差 >2s 才 seek）；
 *   5s 未收到心跳置 hostOffline（收到即恢复）；控制走申请制
 * - 随机模式：Fisher-Yates 洗牌序列存 ref，一轮结束重新洗牌
 *   （参考 Hydrogen utils/player/queue.js 的思路实现的简版）
 */
export function useListenTogether({
  socket,
  roomId,
  isHost,
  username,
}: UseListenTogetherOptions): UseListenTogetherResult {
  const {
    queue,
    currentKey,
    playMode,
    hostOffline,
    syncNotice,
    syncNoticeKind,
    setSyncNotice,
    biliItem,
  } = useMusicStore(
    useShallow((s) => ({
      queue: s.queue,
      currentKey: s.currentKey,
      playMode: s.playMode,
      hostOffline: s.hostOffline,
      syncNotice: s.syncNotice,
      syncNoticeKind: s.syncNoticeKind,
      setSyncNotice: s.setSyncNotice,
      biliItem: s.biliItem,
    }))
  )

  // 本地音量（仅本地生效；创建 audio 元素时应用，见 getAudio）
  const [volume, setVolumeState] = useState(loadPersistedVolume)

  // ===== Refs =====
  /** 音频元素（惰性创建，不挂 DOM） */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** 换曲后的起始进度（loadedmetadata 时应用） */
  const pendingSeekRef = useRef(0)
  /** 随机模式洗牌序列（曲目 key 列表；null 表示待重建） */
  const shuffleListRef = useRef<string[] | null>(null)
  /** 当前曲目在洗牌序列中的位置（-1 表示尚未开始） */
  const shufflePosRef = useRef(-1)
  /** 观众最近一次收到房主心跳的时间戳（0 表示尚未开始计时，由离线判定 effect 初始化） */
  const lastHeartbeatAtRef = useRef(0)
  /** 房主端待审批的观众申请 */
  const pendingControlRef = useRef<MusicControlRequest | null>(null)
  /** 本地音量镜像（getAudio 创建元素时读取，避免依赖 state） */
  const volumeRef = useRef(volume)
  // latest ref 模式：事件回调经 ref 读取最新身份
  const socketRef = useRef(socket)
  const roomIdRef = useRef(roomId)
  const isHostRef = useRef(isHost)
  const usernameRef = useRef(username)

  useEffect(() => {
    socketRef.current = socket
    roomIdRef.current = roomId
    isHostRef.current = isHost
    usernameRef.current = username
    volumeRef.current = volume
  }, [socket, roomId, isHost, username, volume])

  /** 惰性获取 audio 元素（首次使用时创建并挂 DOM，创建时应用持久化音量） */
  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.muted = volumeRef.current === 0
      audio.volume = volumeRef.current
      mountMediaElement(audio)
      audioRef.current = audio
    }
    return audioRef.current
  }, [])

  /**
   * 构造同步状态快照（broadcastSyncState 与房主心跳共用）。
   */
  const buildSyncPayload = useCallback((): MusicSyncState => {
    const audio = audioRef.current
    const store = useMusicStore.getState()
    const parsed = parseMusicKey(store.currentKey)
    return {
      // B站 播放列表已并入房间队列：trackKey 为权威同步字段（B站 曲目
      // 也全房间广播）；trackSongId 仅为兼容保留（B站 曲目恒为 null）
      trackSongId: parsed && parsed.source === 'ncm' ? parsed.songId : null,
      trackKey: store.currentKey,
      isPlaying: audio ? !audio.paused : false,
      positionSec: audio ? audio.currentTime : 0,
      playMode: store.playMode,
      updatedAt: Date.now(),
    }
  }, [])

  /**
   * 房主：广播当前同步状态。
   * overrides 用于操作后立即广播时纠正 audio 事件异步生效的时间差
   * （如 play() 尚未生效时 audio.paused 仍为 true）；
   * keyOverride 用于换曲时强制以目标曲目广播（audio.src 尚未设置）。
   */
  const broadcastSyncState = useCallback(
    (overrides?: {
      /** 强制以指定 key 作为当前曲目广播（换曲时 audio 事件尚未生效） */
      keyOverride?: string | null
      isPlaying?: boolean
      positionSec?: number
      playMode?: PlayMode
    }) => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId || !isHostRef.current) return
      const payload = buildSyncPayload()
      if (overrides?.keyOverride !== undefined) {
        const targetKey = overrides.keyOverride
        const parsed = parseMusicKey(targetKey)
        // B站 曲目也全房间同步（trackKey 为权威；trackSongId 兼容旧客户端）
        payload.trackSongId =
          parsed && parsed.source === 'ncm' ? parsed.songId : null
        payload.trackKey = targetKey
      }
      if (overrides?.isPlaying !== undefined) {
        payload.isPlaying = overrides.isPlaying
      }
      if (overrides?.positionSec !== undefined) {
        payload.positionSec = overrides.positionSec
      }
      if (overrides?.playMode !== undefined) {
        payload.playMode = overrides.playMode
      }
      currentSocket.emit(MUSIC_EVENT.SYNC_STATE, {
        roomId: currentRoomId,
        ...payload,
      })
    },
    [buildSyncPayload]
  )

  /**
   * 随机模式：确保洗牌序列与当前队列一致。
   * 队列变化或锚点漂移（房主手动点歌）时重建/重锚，
   * 重建时将当前曲目置于序列头部。
   */
  const ensureShuffleList = useCallback(() => {
    const { currentKey } = useMusicStore.getState()
    // 随机序列基于「当前源的活动播放列表」构建（两源列表独立，跨源自动重建）
    const queueKeys = activeQueueOf(useMusicStore.getState()).map((item) =>
      musicItemKey(item)
    )
    if (queueKeys.length === 0) {
      shuffleListRef.current = null
      shufflePosRef.current = -1
      return
    }
    const list = shuffleListRef.current
    if (list && isSameKeySet(list, queueKeys)) {
      // 队列未变：校验位置仍指向当前曲目（手动切歌会使锚点漂移）
      if (currentKey == null) {
        shufflePosRef.current = -1
        return
      }
      const idx = list.indexOf(currentKey)
      // 当前曲目不在队列（被删除）→ 从序列头部重新开始
      shufflePosRef.current = idx >= 0 ? idx : -1
      return
    }
    // 队列变化或首次进入随机模式：重新洗牌，当前曲目置于头部
    const nextList = shuffleKeys(queueKeys)
    if (currentKey != null) {
      const curIdx = nextList.indexOf(currentKey)
      if (curIdx > 0) {
        nextList.splice(curIdx, 1)
        nextList.unshift(currentKey)
      }
      shufflePosRef.current = curIdx >= 0 ? 0 : -1
    } else {
      shufflePosRef.current = -1
    }
    shuffleListRef.current = nextList
  }, [])

  /**
   * 按播放模式计算切歌目标条目（next/prev 共用）。
   * - sequence / repeat-one：手动切歌按队列顺序循环
   *   （repeat-one 仅影响 ended 自动重播当前曲目）
   * - shuffle：沿洗牌序列推进，一轮结束重新洗牌
   *   （新一轮避免以刚播放的曲目开头，参考 Hydrogen avoidFirstSongId）
   */
  const computeTargetSong = useCallback(
    (direction: 'next' | 'prev'): MusicQueueItem | null => {
      const { currentKey, playMode } = useMusicStore.getState()
      // 切歌在「当前源的活动播放列表」内推进（两源列表完全独立）
      const queue = activeQueueOf(useMusicStore.getState())
      if (queue.length === 0) return null

      const findByKey = (key: string | null): MusicQueueItem | null =>
        key == null
          ? null
          : (queue.find((item) => musicItemKey(item) === key) ?? null)

      if (playMode !== 'shuffle') {
        const keys = queue.map((item) => musicItemKey(item))
        if (keys.length === 1) return queue[0]
        const idx = currentKey == null ? -1 : keys.indexOf(currentKey)
        if (idx === -1) return queue[0]
        // 按顺序播放（不循环）：到末尾不再前进、到头不再后退
        if (playMode === 'order') {
          if (direction === 'next') {
            return idx + 1 < keys.length ? findByKey(keys[idx + 1]) : null
          }
          return idx - 1 >= 0 ? findByKey(keys[idx - 1]) : findByKey(keys[0])
        }
        const targetKey =
          direction === 'next'
            ? keys[(idx + 1) % keys.length]
            : keys[(idx - 1 + keys.length) % keys.length]
        return findByKey(targetKey)
      }

      // 随机模式
      ensureShuffleList()
      const list = shuffleListRef.current
      if (!list || list.length === 0) return null
      if (list.length === 1) return findByKey(list[0])
      if (direction === 'next') {
        if (shufflePosRef.current >= list.length - 1) {
          // 一轮结束：重新洗牌，避免新一轮以刚播放的曲目开头
          const nextList = shuffleKeys(list)
          if (currentKey != null && nextList[0] === currentKey) {
            const swapIdx = nextList.findIndex((k) => k !== currentKey)
            if (swapIdx > 0) {
              const t = nextList[0]
              nextList[0] = nextList[swapIdx]
              nextList[swapIdx] = t
            }
          }
          shuffleListRef.current = nextList
          shufflePosRef.current = 0
          return findByKey(nextList[0])
        }
        shufflePosRef.current += 1
        return findByKey(list[shufflePosRef.current])
      }
      // prev：沿序列回退；已在序列头部时回到当前曲目开头
      if (shufflePosRef.current > 0) {
        shufflePosRef.current -= 1
        return findByKey(list[shufflePosRef.current])
      }
      return findByKey(currentKey)
    },
    [ensureShuffleList]
  )

  /**
   * 预载目标窥探（无缝衔接用）：与 computeTargetSong('next') 相同的解析逻辑，
   * 但不推进洗牌指针（避免预载导致真实切歌跳过一首）。一轮洗牌末尾不预载
   * （下一首需重新洗牌，peek 结果不稳定）。
   */
  const peekNextSong = useCallback((): MusicQueueItem | null => {
    const { currentKey, playMode } = useMusicStore.getState()
    const queue = activeQueueOf(useMusicStore.getState())
    if (queue.length === 0) return null
    if (playMode === 'repeat-one') return null
    if (playMode !== 'shuffle') {
      const keys = queue.map((item) => musicItemKey(item))
      if (keys.length === 1) return queue[0]
      const idx = currentKey == null ? -1 : keys.indexOf(currentKey)
      if (idx === -1) return queue[0]
      // 按顺序播放（不循环）：末尾无下一首，不预载
      if (playMode === 'order') {
        return idx + 1 < keys.length
          ? (queue.find((item) => musicItemKey(item) === keys[idx + 1]) ?? null)
          : null
      }
      const targetKey = keys[(idx + 1) % keys.length]
      return queue.find((item) => musicItemKey(item) === targetKey) ?? null
    }
    const list = shuffleListRef.current
    if (!list || list.length === 0) return null
    if (list.length === 1) {
      return queue.find((item) => musicItemKey(item) === list[0]) ?? null
    }
    if (shufflePosRef.current >= list.length - 1) return null
    const nextKey = list[shufflePosRef.current + 1]
    return queue.find((item) => musicItemKey(item) === nextKey) ?? null
  }, [])

  /** 无缝衔接（设置：歌曲无缝衔接）的预缓冲 audio 元素 */
  const preloadRef = useRef<HTMLAudioElement | null>(null)
  const gaplessPlayback = useMusicSettingsStore((s) => s.gaplessPlayback)

  // ===== 音频事件处理器（元素无关化，Hydrogen preparePlaybackSwitch 的等价基础） =====
  /** ended 处理器的最新实现（handleEnded 随 switchSong 依赖重建，经 ref 间接调用） */
  const endedHandlerRef = useRef<() => void>(() => {})

  /**
   * 六个音频生命周期事件的稳定 handler 集合（useState 惰性初始化，仅创建一次；
   * 项目 lint 规则禁止 render 期读写 ref，故不用 useRef 惰性初始化）。
   * 全部经 e.currentTarget / ref 访问状态（不捕获具体元素实例），
   * 因此同一组监听器可安全地在「主播放元素 ↔ 预载元素」之间迁移（升格时迁移）。
   */
  const [audioHandlers] = useState<{
    timeupdate: (e: Event) => void
    play: () => void
    pause: () => void
    ended: () => void
    loadedmetadata: (e: Event) => void
    error: (e: Event) => void
  }>(() => ({
    timeupdate: (e) => {
      const el = e.currentTarget as HTMLAudioElement
      useMusicStore.getState().setPositionSec(el.currentTime)
    },
    play: () => {
      useMusicStore.getState().setPlaying(true)
    },
    pause: () => {
      useMusicStore.getState().setPlaying(false)
    },
    ended: () => {
      endedHandlerRef.current()
    },
    loadedmetadata: (e) => {
      // 换曲后的起始进度（如观众从房主进度起播）
      const el = e.currentTarget as HTMLAudioElement
      if (pendingSeekRef.current > 0) {
        try {
          el.currentTime = pendingSeekRef.current
        } catch {
          // ignore
        }
        pendingSeekRef.current = 0
      }
    },
    error: (e) => {
      // 流加载失败（无版权/纯 VIP 未登录/解析失败等后端结构化错误；
      // 直链模式下 CDN 链接过期/失效同样在此报错，不回退代理流）
      const el = e.currentTarget as HTMLAudioElement
      console.error(
        '[useListenTogether] 音频流加载失败:',
        el.error?.code,
        el.error?.message
      )
      message.error('音频加载失败，请稍后重试或切换其他曲目')
    },
  }))

  /** 在指定音频元素上挂载生命周期事件（初始化/升格共用） */
  const attachAudioHandlers = useCallback(
    (el: HTMLAudioElement) => {
      el.addEventListener('timeupdate', audioHandlers.timeupdate)
      el.addEventListener('play', audioHandlers.play)
      el.addEventListener('pause', audioHandlers.pause)
      el.addEventListener('ended', audioHandlers.ended)
      el.addEventListener('loadedmetadata', audioHandlers.loadedmetadata)
      el.addEventListener('error', audioHandlers.error)
    },
    [audioHandlers]
  )

  /** 从指定音频元素上卸载生命周期事件（升格时从旧主元素移除） */
  const detachAudioHandlers = useCallback(
    (el: HTMLAudioElement) => {
      el.removeEventListener('timeupdate', audioHandlers.timeupdate)
      el.removeEventListener('play', audioHandlers.play)
      el.removeEventListener('pause', audioHandlers.pause)
      el.removeEventListener('ended', audioHandlers.ended)
      el.removeEventListener('loadedmetadata', audioHandlers.loadedmetadata)
      el.removeEventListener('error', audioHandlers.error)
    },
    [audioHandlers]
  )

  /** 复位指定音频元素：停止并释放已缓冲的流资源（Hydrogen unload 等价），
   *  同时从 DOM 移除（挂载与退役配对，防隐藏元素残留堆积） */
  const resetAudioElement = useCallback((el: HTMLAudioElement) => {
    el.pause()
    el.removeAttribute('src')
    try {
      // 空源 load()：中止当前加载并释放缓冲（MDN 推荐的资源释放方式）
      el.load()
    } catch {
      // ignore
    }
    unmountMediaElement(el)
  }, [])

  // 预缓冲下一首：提前建立 HTTP/媒体缓存，切歌时近乎零等待
  //（Hydrogen gaplessPlayback 的 Web 等价实现；封面预取不受开关限制，资源极轻）
  useEffect(() => {
    const target = peekNextSong()
    // 封面预取：提前拉取下一首封面进 HTTP 缓存（Hydrogen prefetchSongAssets 封面部分；
    // 同 URL 重复预取由浏览器 HTTP 缓存兜底，不产生额外网络请求）
    if (target?.cover) {
      const img = new Image()
      img.src = target.cover
    }
    const targetUrl = target ? buildStreamUrl(target, roomIdRef.current) : null
    // 幂等复用（Hydrogen 同 key 同 quality 复用）：目标未变且预载元素健康时
    // 保留已缓冲进度，避免队列重排等无关变化触发重复加载
    const existing = preloadRef.current
    if (
      gaplessPlayback &&
      targetUrl != null &&
      existing != null &&
      existing.src === targetUrl &&
      existing.error == null
    ) {
      return
    }
    // 退役旧预载元素：停止并释放已缓冲的流资源
    //（若已被升格为主播放元素，preloadRef 已在升格时被消费置 null，不在此误停主播放）
    if (existing) {
      resetAudioElement(existing)
    }
    preloadRef.current = null
    if (!gaplessPlayback || !target || targetUrl == null) return
    const el = new Audio()
    el.preload = 'auto'
    // 预载元素同步主元素的音量/静音（升格接管时仍会再校准一次）
    const currentAudio = audioRef.current
    if (currentAudio) {
      el.volume = currentAudio.volume
      el.muted = currentAudio.muted
    }
    // 挂 DOM：预载元素升格为主播放元素后承载 MediaSession 展示
    mountMediaElement(el)
    el.src = targetUrl
    preloadRef.current = el
    return () => {
      // 该元素已被升格为主播放元素时（preloadRef 不再指向它），绝不能暂停
      if (preloadRef.current === el) {
        el.pause()
        preloadRef.current = null
      }
    }
  }, [
    gaplessPlayback,
    peekNextSong,
    currentKey,
    queue,
    playMode,
    resetAudioElement,
  ])

  /** 加载指定队列条目（positionSec 为起始进度；shouldPlay 控制起播状态）。
   *  预载升格（Hydrogen play() 的 takeGaplessPreloadForCurrentSong 思路）：
   *  预载元素已缓冲同一首歌（同流 URL 且数据就绪、无错误）时，把预载元素
   *  直接升格为主播放元素并迁移事件监听——零网络/零加载等待；
   *  未命中预载时走原路径（主元素重新 load）。 */
  /** loadAndPlaySong 的 latest-ref（懒解析完成后经 ref 重新触发，规避自引用） */
  const loadAndPlaySongRef = useRef<
    (item: MusicQueueItem, positionSec: number, shouldPlay: boolean) => void
  >(() => {})

  const loadAndPlaySong = useCallback(
    (item: MusicQueueItem, positionSec: number, shouldPlay: boolean) => {
      // ===== B站 条目懒解析：队列/同步场景下音源可能尚未解析（内存缓存
      // 为空），先解析完成后再继续加载；同 key 去重防止重复触发 =====
      if (isBiliItem(item) && item.biliBvid) {
        const mapKey = `${item.biliBvid}:${item.biliCid ?? 0}`
        if (getCachedBiliAudioUrl(mapKey) == null) {
          if (biliResolvingKeys.has(mapKey)) return
          biliResolvingKeys.add(mapKey)
          const notice = useMusicStore.getState().setSyncNotice
          notice('正在解析 B站 视频音频…')
          void resolveBiliAudio(item)
            .then(() => {
              notice(null)
              loadAndPlaySongRef.current(item, positionSec, shouldPlay)
            })
            .catch((err) => {
              notice(null)
              message.error(
                err instanceof Error ? err.message : 'B站 音频解析失败'
              )
            })
            .finally(() => {
              biliResolvingKeys.delete(mapKey)
            })
          return
        }
      }
      const audio = getAudio()
      const url = buildStreamUrl(item, roomIdRef.current)
      useMusicStore.getState().setCurrentKey(musicItemKey(item))

      // ===== 预载升格路径 =====
      // 条件：同一 URL（流地址稳定：同 songId/level/roomId/token）、
      // readyState ≥ HAVE_FUTURE_DATA（可连续播放）、无加载错误
      const preloaded = preloadRef.current
      if (
        preloaded != null &&
        preloaded !== audio &&
        preloaded.src === url &&
        preloaded.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        preloaded.error == null
      ) {
        // 1) 事件迁移：先从旧主元素摘除（避免 pause 触发暂停状态镜像）
        detachAudioHandlers(audio)
        // 2) 停止旧播放（事件已摘除，不会误镜像暂停状态）并从 DOM 移除
        //    （元素角色已被预载元素接替，残留隐藏元素会堆积）
        audio.pause()
        unmountMediaElement(audio)
        // 3) 挂载事件并接管角色；预载槽消费置空（预载 effect 会重新预载下一首）
        attachAudioHandlers(preloaded)
        audioRef.current = preloaded
        preloadRef.current = null
        // 4) 同步音量/静音（主元素是音量设置的权威来源）
        preloaded.volume = audio.volume
        preloaded.muted = audio.muted
        // 5) 元数据已就绪（readyState 校验），起始进度直接生效
        if (positionSec > 0) {
          try {
            preloaded.currentTime = positionSec
          } catch {
            // ignore
          }
        }
        if (shouldPlay) {
          void preloaded.play().catch(() => {
            // 自动播放策略拒绝等：静默处理，播放状态由 audio 事件镜像
          })
        } else {
          preloaded.pause()
        }
        return
      }

      // ===== 原路径（未命中预载） =====
      if (audio.src === url && audio.readyState >= 1) {
        // 同一曲目且元数据已就绪（重播/循环）：直接 seek
        try {
          audio.currentTime = positionSec
        } catch {
          // ignore
        }
      } else {
        // 新曲目或仍在加载：记录起始进度，待 loadedmetadata 后应用
        pendingSeekRef.current = positionSec
        if (audio.src !== url) {
          audio.src = url
          audio.load()
        }
      }
      if (shouldPlay) {
        void audio.play().catch(() => {
          // 自动播放策略拒绝等：静默处理，播放状态由 audio 事件镜像
        })
      } else {
        audio.pause()
      }
    },
    [getAudio, attachAudioHandlers, detachAudioHandlers]
  )
  // latest-ref 同步（渲染后更新，规避 useCallback 自引用）
  useEffect(() => {
    loadAndPlaySongRef.current = loadAndPlaySong
  }, [loadAndPlaySong])

  /**
   * 切歌核心：按播放模式计算目标并加载播放；房主额外广播同步状态。
   * 返回是否成功切换（目标为 null 时 false，如按顺序播放已到末尾）
   */
  const switchSong = useCallback(
    (direction: 'next' | 'prev'): boolean => {
      const target = computeTargetSong(direction)
      if (!target) return false
      const targetKey = musicItemKey(target)
      loadAndPlaySong(target, 0, true)
      if (isHostRef.current) {
        // play() 异步生效，广播时显式携带目标状态避免时间差
        broadcastSyncState({
          keyOverride: targetKey,
          isPlaying: true,
          positionSec: 0,
        })
      }
      return true
    },
    [computeTargetSong, loadAndPlaySong, broadcastSyncState]
  )

  /**
   * B站 推荐续播（用户在队列末尾主动点「下一首」时触发，仅房主/拥有
   * 控制权路径调用）：当前为 B站 条目时拉相关推荐前 3 条（与「自动推荐」
   * 同管线去重、afterCurrent 入队），成功后直接续播第一条推荐。
   * 无可加推荐（拉取失败 / 均已在队列中 / 入队失败）时回落
   * switchSong('next') —— order 模式末尾返回 null，自然停止、不回绕到
   * 队列开头（旧实现 `biliList[curIdx + 1] ?? biliList[0]` 的回绕问题）。
   */
  const handleBiliContinue = useCallback(async (): Promise<void> => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    const state = useMusicStore.getState()
    // 当前播放条目：活动队列优先，房间队列兜底，本地插播条目再兜底
    //（搜索试听等本地 B站 条目不在房间队列，漏掉会永不触发推荐）
    const current = state.currentKey
      ? (activeQueueOf(state).find(
          (q) => musicItemKey(q) === state.currentKey
        ) ??
        state.queue.find((q) => musicItemKey(q) === state.currentKey) ??
        state.biliItem)
      : state.biliItem
    if (!currentSocket || !currentRoomId || !current?.biliBvid) {
      switchSong('next')
      return
    }
    let fresh: BiliRelatedItem[]
    try {
      fresh = await fetchBiliRecs(current.biliBvid)
    } catch (err) {
      // 失败不打扰用户（静默回落自然停止），仅留诊断日志
      console.error('[useListenTogether] 推荐续播拉取 B站 推荐失败:', err)
      fresh = []
    }
    if (fresh.length === 0) {
      switchSong('next')
      return
    }
    // 倒序逐条 afterCurrent 入队 → 最终顺序与推荐一致、紧跟当前曲目
    let added = 0
    for (const r of [...fresh].reverse()) {
      const ok = await new Promise<boolean>((resolve) => {
        currentSocket.emit(
          'music:queue-upsert',
          {
            roomId: currentRoomId,
            item: biliRecToUpsertItem(r),
            afterCurrent: true,
          },
          (res: { success?: boolean }) => resolve(res?.success !== false)
        )
      })
      if (ok) added++
    }
    if (added === 0) {
      switchSong('next')
      return
    }
    useMusicStore.getState().markBiliRecommended(fresh.map(biliRecKey))
    // 直接续播第一条推荐（key 为 bili:<bvid>:<cid>，与入队条目一致，
    // 后续 queue-changed 广播 / 心跳同步均按 key 对齐）；封面直链代理化
    const first = fresh[0]
    const item: MusicQueueItem = {
      id: -1,
      roomId: '',
      songId: 0,
      name: first.title,
      artist: first.upName || '哔哩哔哩',
      album: '',
      cover: isBilibiliImageUrl(first.pic)
        ? buildBilibiliImageProxyUrl(first.pic)
        : first.pic,
      durationMs: Math.round((first.duration || 0) * 1000),
      vip: false,
      order: 0,
      addedBy: '',
      biliBvid: first.bvid,
      biliCid: first.cid ?? 0,
    }
    loadAndPlaySong(item, 0, true)
    if (isHostRef.current) {
      broadcastSyncState({
        keyOverride: biliRecKey(first),
        isPlaying: true,
        positionSec: 0,
      })
    }
    message.info(`已自动播放相关推荐：${first.title}`)
  }, [switchSong, loadAndPlaySong, broadcastSyncState])

  /**
   * 「下一首」到队列末尾时的推荐续播判定：按顺序播放 + 当前 B站 条目 +
   * 「B站视频自动连播」开启时触发 handleBiliContinue（拉 3 首推荐入队并
   * 续播）。仅用户主动点「下一首」的路径调用——曲目自然播完（ended）
   * 不触发，末尾自然停止。返回是否已触发。
   */
  const tryBiliContinueOnNext = useCallback((): boolean => {
    const state = useMusicStore.getState()
    // 当前播放条目解析与 handleBiliContinue 同源（活动队列 → 房间队列
    // → 本地插播条目），本地 B站 试听播完点下一首同样触发推荐
    const current = state.currentKey
      ? (activeQueueOf(state).find(
          (q) => musicItemKey(q) === state.currentKey
        ) ??
        state.queue.find((q) => musicItemKey(q) === state.currentKey) ??
        state.biliItem)
      : state.biliItem
    if (
      state.playMode !== 'order' ||
      !current?.biliBvid ||
      !useMusicSettingsStore.getState().biliAutoContinue
    ) {
      return false
    }
    void handleBiliContinue()
    return true
  }, [handleBiliContinue])

  /** 拥有直接控制权的判定（房主或房主离线时的观众） */
  const hasControl = useCallback(
    () => isHostRef.current || useMusicStore.getState().hostOffline,
    []
  )

  /** 播放/暂停切换（房主或房主离线时直接生效；房主额外广播） */
  const togglePlay = useCallback(() => {
    if (!hasControl()) return
    if (useMusicStore.getState().currentKey == null) return
    const audio = getAudio()
    const wantPlay = audio.paused
    if (wantPlay) {
      void audio.play().catch(() => {
        message.error('播放失败，请重试')
      })
    } else {
      audio.pause()
    }
    if (isHostRef.current) {
      broadcastSyncState({
        isPlaying: wantPlay,
        positionSec: audio.currentTime,
      })
    }
  }, [getAudio, broadcastSyncState, hasControl])

  /**
   * 下一首（按播放模式计算目标）。按顺序播放已到末尾时不再回绕到列表
   * 开头，仅提示「队列中无下一首」（顺序循环/随机按各自规则继续）
   */
  const next = useCallback(() => {
    if (!hasControl()) return
    const state = useMusicStore.getState()
    // 单曲队列特例：computeTargetSong('next') 对唯一曲目返回自身重播
    // （switchSong 视为成功），会绕过末尾判定——按顺序播放时点「下一首」
    // 应视为队列末尾，走推荐续播；其余模式保持原重播语义
    const active = activeQueueOf(state)
    const singleSelf =
      state.playMode !== 'shuffle' &&
      state.currentKey != null &&
      active.length === 1 &&
      musicItemKey(active[0]) === state.currentKey
    if (singleSelf) {
      if (state.playMode === 'order') {
        if (!tryBiliContinueOnNext()) {
          message.info('队列中无下一首')
        }
      } else {
        switchSong('next')
      }
      return
    }
    if (!switchSong('next')) {
      // 队列末尾：按顺序播放 + B站 条目 + 自动连播开启 → 拉 3 首相关
      // 推荐入队并续播第一条（用户主动点「下一首」才触发）
      if (!tryBiliContinueOnNext()) {
        const { playMode } = useMusicStore.getState()
        if (playMode === 'order') {
          message.info('队列中无下一首')
        }
      }
    }
  }, [switchSong, hasControl, tryBiliContinueOnNext])

  /** 上一首（按播放模式计算目标） */
  const prev = useCallback(() => {
    if (!hasControl()) return
    switchSong('prev')
  }, [switchSong, hasControl])

  /** 跳转到指定进度（秒） */
  const seek = useCallback(
    (sec: number) => {
      if (!hasControl()) return
      const audio = getAudio()
      const target = Math.max(0, Number.isFinite(sec) ? sec : 0)
      try {
        audio.currentTime = target
      } catch {
        // ignore：元数据未就绪
      }
      if (isHostRef.current) {
        broadcastSyncState({ positionSec: target })
      }
    },
    [getAudio, broadcastSyncState, hasControl]
  )

  /** 切换播放模式（房主切换并广播；洗牌序列标记待重建） */
  const setPlayMode = useCallback(
    (mode: PlayMode) => {
      if (!hasControl()) return
      useMusicStore.getState().setPlayMode(mode)
      shuffleListRef.current = null
      if (isHostRef.current) {
        broadcastSyncState({ playMode: mode })
      }
    },
    [broadcastSyncState, hasControl]
  )

  /** 播放指定队列条目（房主点击队列/FM 切歌；条目可不带 id/order，仅要求可定位来源） */
  const playSong = useCallback(
    (item: MusicQueueItem) => {
      if (!hasControl()) return
      loadAndPlaySong(item, 0, true)
      if (isHostRef.current) {
        broadcastSyncState({
          keyOverride: musicItemKey(item),
          isPlaying: true,
          positionSec: 0,
        })
      }
    },
    [loadAndPlaySong, broadcastSyncState, hasControl]
  )

  /** 设置本地播放音量（0-1，持久化 localStorage；仅本地生效不参与同步） */
  const setVolume = useCallback(
    (value: number) => {
      const clamped = Math.min(
        1,
        Math.max(0, Number.isFinite(value) ? value : 0)
      )
      const audio = getAudio()
      audio.muted = clamped === 0
      audio.volume = clamped
      volumeRef.current = clamped
      setVolumeState(clamped)
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped))
      } catch {
        // ignore：隐私模式等场景写入失败可忽略
      }
    },
    [getAudio]
  )

  /**
   * 播放 B站 视频音频（哔哩哔哩页点击视频）：解析音频地址（默认 720P MP4
   * 直链经后端代理注入 Referer；音乐设置开启 CLI 高画质且本地代理在线时取
   * DASH 音轨 m4s）后作为本地插播曲目播放。
   * 仅本地生效：不入房间队列、不同步、观众/房主均可自由使用。
   */
  const playBiliSong = useCallback(
    async (item: MusicQueueItem) => {
      if (!isBiliItem(item) || !item.biliBvid) return
      const notice = useMusicStore.getState().setSyncNotice
      notice('正在解析 B站 视频音频…')
      try {
        const { durationMs } = await resolveBiliAudio(item)
        const enriched: MusicQueueItem = { ...item, durationMs }
        // 本地插播（个人试听/离线模式）：不入队列，房主跟随同步见 playSong
        useMusicStore.getState().setBiliItem(enriched)
        loadAndPlaySong(enriched, 0, true)
        notice(null)
      } catch (err) {
        notice(null)
        message.error(err instanceof Error ? err.message : 'B站 音频解析失败')
      }
    },
    [loadAndPlaySong]
  )

  /** 观众：向房主申请控制（房主在线且自己无直接控制权时） */
  const requestControl = useCallback(
    (
      action: MusicControlRequest['action'],
      positionSec?: number,
      item?: MusicControlRequest['item']
    ) => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId) return
      // 房主或房主离线时拥有直接控制权，无需申请
      if (hasControl()) return
      currentSocket.emit(MUSIC_EVENT.CONTROL_REQUEST, {
        roomId: currentRoomId,
        action,
        positionSec,
        item,
        from: currentSocket.id ?? '',
        username: usernameRef.current,
      })
      // 观众端即时反馈（应答到达后会被同意/拒绝文案覆盖）
      useMusicStore
        .getState()
        .setSyncNotice(`已向房主申请${CONTROL_ACTION_TEXT[action]}`)
    },
    [hasControl]
  )

  /** 房主：执行审批通过的动作（房主是同步源，执行后广播使全房间对齐） */
  const executeHostAction = useCallback(
    (
      action: MusicControlRequest['action'],
      positionSec?: number,
      item?: MusicControlRequest['item']
    ) => {
      const audio = getAudio()
      switch (action) {
        case 'pause':
          audio.pause()
          broadcastSyncState({
            isPlaying: false,
            positionSec: audio.currentTime,
          })
          break
        case 'play':
          if (useMusicStore.getState().currentKey == null) return
          void audio.play().catch(() => {
            // ignore：自动播放策略拒绝
          })
          broadcastSyncState({
            isPlaying: true,
            positionSec: audio.currentTime,
          })
          break
        case 'next':
          // 观众申请「下一首」经房主执行：与房主本地点下一首同一逻辑
          // （含队列末尾/单曲队列的推荐续播判定；next 内部已查 hasControl）
          next()
          break
        case 'prev':
          switchSong('prev')
          break
        case 'seek':
          // seek() 内含房主广播（positionSec），观众端由下一次同步对齐
          seek(positionSec ?? audio.currentTime)
          break
        case 'playItem': {
          // 观众申请切换到播放列表中的条目：按 key 匹配房间队列
          // （载荷仅含定位字段，用房间队列的完整条目播放），找不到不动作
          if (!item) break
          const targetKey = musicItemKey(item as MusicQueueItem)
          const matched = useMusicStore
            .getState()
            .queue.find((q) => musicItemKey(q) === targetKey)
          if (matched) playSong(matched)
          break
        }
      }
    },
    [getAudio, switchSong, broadcastSyncState, seek, playSong, next]
  )

  /**
   * 观众：执行审批通过的动作（本地操作）。
   * 随机模式下观众本地洗牌序列可能与房主不一致，
   * 房主随后广播的 sync-state 会以权威 trackSongId 校正。
   */
  const executeLocalAction = useCallback(
    (action: MusicControlRequest['action'], positionSec?: number) => {
      const audio = getAudio()
      switch (action) {
        case 'play':
          void audio.play().catch(() => {
            // ignore
          })
          break
        case 'pause':
          audio.pause()
          break
        case 'next':
          switchSong('next')
          break
        case 'prev':
          switchSong('prev')
          break
        case 'seek':
          // 仅在显式携带目标进度时动作（无载荷时直接跳过，防止误跳 0）；
          // 正常链路对齐由房主 SYNC_STATE 广播驱动
          if (positionSec == null) break
          try {
            audio.currentTime = Math.max(0, positionSec)
          } catch {
            // ignore：元数据未就绪
          }
          break
      }
    },
    [getAudio, switchSong]
  )

  /** 房主：通过当前观众申请（执行动作 + 定向应答申请者 + 清除提示） */
  const approveControl = useCallback(() => {
    const request = pendingControlRef.current
    pendingControlRef.current = null
    useMusicStore.getState().setSyncNotice(null)
    if (!request) return
    executeHostAction(request.action, request.positionSec, request.item)
    socketRef.current?.emit(MUSIC_EVENT.CONTROL_RESPONSE, {
      roomId: roomIdRef.current,
      approved: true,
      action: request.action,
      from: request.from,
    })
  }, [executeHostAction])

  /** 房主：拒绝当前观众申请（定向应答申请者 + 清除提示） */
  const rejectControl = useCallback(() => {
    const request = pendingControlRef.current
    pendingControlRef.current = null
    useMusicStore.getState().setSyncNotice(null)
    if (!request) return
    socketRef.current?.emit(MUSIC_EVENT.CONTROL_RESPONSE, {
      roomId: roomIdRef.current,
      approved: false,
      action: request.action,
      from: request.from,
    })
  }, [])

  /**
   * 观众：应用房主广播/心跳携带的同步状态。
   * - 曲目 key 变化（trackSongId 匹配）→ 换源加载
   * - isPlaying 变化 → play/pause
   * - 进度差 >2s → seek 对齐（小差异让音频自然播放）
   * - playMode → 同步到 store
   */
  const applyViewerSync = useCallback(
    (payload: MusicSyncState) => {
      const store = useMusicStore.getState()
      const audio = getAudio()
      // 权威曲目 key：trackKey 优先（B站 曲目也同步），回退 trackSongId
      const trackKey = syncKeyOf(payload)
      // 本地 B站 插播保护：仅覆盖观众**主动本地插播**的场景（正在播自己
      // 插播的 B站 条目=个人试听，不参与房间同步）——此时不被房主心跳拉回
      //（房主播 B站 队列条目时仍跟随；房主切网易云时保持试听）。观众跟随
      // 房主播的**队列** B站 条目不受保护：否则房主从 B站 切回网易云时
      // 观众会被永久挡住无法跟随（currentKey 已非插播条目）
      const localBiliItemKey =
        store.biliItem != null ? musicItemKey(store.biliItem) : null
      const viewerSyncBlocked =
        store.currentKey?.startsWith('bili:') === true &&
        store.currentKey === localBiliItemKey &&
        !(
          trackKey != null &&
          trackKey.startsWith('bili:') &&
          store.queue.some((q) => musicItemKey(q) === trackKey)
        )
      if (viewerSyncBlocked) return
      // 传输延迟补偿后的目标进度（暂停态/时钟异常时即原值）
      const targetPositionSec = compensatePositionSec(payload)

      // 1. 曲目变化 → 换源加载（按 key 从队列匹配条目）
      if (trackKey !== store.currentKey) {
        if (trackKey == null) {
          // 房主停止/清空播放
          audio.pause()
          store.setCurrentKey(null)
          return
        }
        const item = store.queue.find((q) => musicItemKey(q) === trackKey)
        if (!item) {
          // 队列尚未包含该曲目（房主端临时条目/广播竞态）：跳过对齐等待下一次心跳
          return
        }
        loadAndPlaySong(item, targetPositionSec, payload.isPlaying)
        if (store.playMode !== payload.playMode) {
          store.setPlayMode(payload.playMode)
        }
        // 同步回执：观众完成换曲同步后告知房主（左下角「xx 已同步」提示）。
        // 仅在曲目真正切换的分支发送——心跳同曲对齐不会重复发送；
        // 房主重连自恢复（isHost）不发
        if (!isHostRef.current) {
          socketRef.current?.emit(MUSIC_EVENT.SYNC_ACK, {
            roomId: roomIdRef.current,
          })
        }
        return
      }

      // 2. 同曲目：播放状态对齐
      if (store.isPlaying !== payload.isPlaying) {
        if (payload.isPlaying) {
          void audio.play().catch(() => {
            // 自动播放策略拒绝：保持暂停，等待后续心跳或用户交互
          })
        } else {
          audio.pause()
        }
      }

      // 3. 进度对齐：差值超过阈值才 seek，避免高频打断
      if (
        Math.abs(audio.currentTime - targetPositionSec) >
        SYNC_ALIGN_THRESHOLD_SEC
      ) {
        try {
          audio.currentTime = targetPositionSec
        } catch {
          // ignore：元数据未就绪
        }
      }

      // 4. 播放模式同步（仅状态镜像，不影响本地播放推进）
      if (store.playMode !== payload.playMode) {
        store.setPlayMode(payload.playMode)
      }
    },
    [getAudio, loadAndPlaySong]
  )

  /**
   * 「自动推荐」按钮（播放列表弹窗工具栏）：按当前播放的 B站 视频拉取
   * 相关推荐前 3 条（去重后），插入到当前曲目之后的下三首。
   * - 房主/房管（canManage）：倒序 afterCurrent 直接入队（全房间同步）
   * - 观众：倒序逐条 addQueue 申请，房主按「自动通过」开关代理入队或拒绝
   * 返回实际加入/申请的条数（0=未加入）。
   */
  const addBiliRecommendations = useCallback(
    async (canManage: boolean): Promise<number> => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId) {
        message.error('未连接房间')
        return 0
      }
      const store = useMusicStore.getState()
      // 当前播放条目：房间队列匹配优先，本地插播条目兜底
      const current = store.currentKey
        ? (store.queue.find((q) => musicItemKey(q) === store.currentKey) ??
          store.biliItem)
        : store.biliItem
      if (!current?.biliBvid) {
        message.info('当前播放的不是 B站 视频，无法获取推荐')
        return 0
      }
      let fresh: BiliRelatedItem[]
      try {
        fresh = await fetchBiliRecs(current.biliBvid)
      } catch {
        message.error('获取 B站 推荐失败')
        return 0
      }
      if (fresh.length === 0) {
        message.info('B站 未返回可加入的相关推荐（推荐均已在使用中）')
        return 0
      }
      if (canManage || isHostRef.current) {
        // 倒序逐条 afterCurrent 入队 → 最终顺序与推荐一致、紧跟当前曲目
        let added = 0
        for (const r of [...fresh].reverse()) {
          const ok = await new Promise<boolean>((resolve) => {
            currentSocket.emit(
              'music:queue-upsert',
              {
                roomId: currentRoomId,
                item: biliRecToUpsertItem(r),
                afterCurrent: true,
              },
              (res: { success?: boolean }) => resolve(res?.success !== false)
            )
          })
          if (ok) added++
        }
        if (added > 0) {
          useMusicStore.getState().markBiliRecommended(fresh.map(biliRecKey))
          message.success(`已将 ${added} 首推荐歌曲加入当前播放之后`)
        } else {
          message.error(
            'B站 推荐加入播放列表失败（需重启后端以启用新队列字段）'
          )
        }
        return added
      }
      // 观众：倒序逐条 addQueue 申请（房主代理后顺序=推荐顺序、紧跟当前）；
      // ack 失败（如房主不在线）直接提示，申请结果另经 control-response 回执
      for (const r of [...fresh].reverse()) {
        currentSocket.emit(
          'music:control-request',
          {
            roomId: currentRoomId,
            action: 'addQueue' as const,
            item: biliRecToUpsertItem(r),
            afterCurrent: true,
          },
          (res: { success?: boolean; message?: string }) => {
            if (res && res.success === false) {
              message.error(res.message || '推荐歌曲申请失败')
            }
          }
        )
      }
      message.info(`已申请加入 ${fresh.length} 首推荐歌曲，等待房主确认`)
      return fresh.length
    },
    []
  )

  /** 曲目自然播完：按播放模式自动切歌（仅房主或房主离线时推进） */
  const handleEnded = useCallback(() => {
    const { playMode, hostOffline } = useMusicStore.getState()
    // 房主在线时观众不自行推进：本地先结束属于缓冲差异，等待房主广播
    if (!isHostRef.current && !hostOffline) return
    const audio = getAudio()
    if (playMode === 'repeat-one') {
      // 单曲循环：回到开头重播
      try {
        audio.currentTime = 0
      } catch {
        // ignore
      }
      void audio.play().catch(() => {
        // ignore
      })
      if (isHostRef.current) {
        broadcastSyncState({ positionSec: 0, isPlaying: true })
      }
      return
    }
    if (playMode === 'order') {
      // 按顺序播放：到队列末尾自然停止不回绕。B站 推荐续播只在用户
      // 主动点「下一首」时触发（next / executeHostAction），自然播完
      // 不自动加歌
      switchSong('next')
      return
    }
    // 顺序循环 / 随机：切换下一首（各自按规则循环/重洗）
    switchSong('next')
  }, [getAudio, switchSong, broadcastSyncState])

  // 音频元素事件绑定：handler 集合元素无关（升格时随元素迁移），此处只做
  // 初始主元素的挂载/卸载；ended 经 endedHandlerRef 间接调用最新实现
  useEffect(() => {
    const audio = getAudio()
    attachAudioHandlers(audio)
    return () => detachAudioHandlers(audio)
  }, [getAudio, attachAudioHandlers, detachAudioHandlers])

  // 同步 ended 处理器的最新实现（handleEnded 随 switchSong 依赖重建）
  useEffect(() => {
    endedHandlerRef.current = () => handleEnded()
  }, [handleEnded])

  // 房主心跳：每 2s 广播当前 MusicSyncState（观众据此对齐进度并判定房主在线）。
  // 后台标签页的 timer 会被浏览器节流（暂停播放的页面尤其明显）导致心跳停发、
  // 观众误判房主离线：回前台时立即补发一次心跳，观众端恢复离线判定与状态同步
  //（后台期间的进度漂移由 compensatePositionSec 的 10s 补偿上限兜底）
  useEffect(() => {
    if (!socket || !roomId || !isHost) return
    const emitHeartbeat = () => {
      const payload = buildSyncPayload()
      socket.emit(MUSIC_EVENT.HOST_HEARTBEAT, { roomId, ...payload })
    }
    const timer = setInterval(emitHeartbeat, HOST_HEARTBEAT_INTERVAL_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') emitHeartbeat()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [socket, roomId, isHost, buildSyncPayload])

  // 观众：房主离线判定——超时未收到心跳置 hostOffline，收到即恢复（见事件监听）。
  // 自身后台时本页 timer 同样被节流，无法区分「房主停发」与「自身节流导致的
  // 大间隔」，hidden 期间跳过判定（恢复前台后下一次轮询立即给出正确结论）
  useEffect(() => {
    if (!socket || !roomId || isHost) return
    // 加入时重置计时，给予首个心跳的宽限期
    lastHeartbeatAtRef.current = Date.now()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (
        Date.now() - lastHeartbeatAtRef.current > HOST_OFFLINE_TIMEOUT_MS &&
        !useMusicStore.getState().hostOffline
      ) {
        useMusicStore.getState().setHostOffline(true)
      }
    }, HOST_OFFLINE_CHECK_INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [socket, roomId, isHost])

  // 加入房间时查询初始状态：队列 + 服务端缓存的最新同步状态。
  // 观众据此立即对齐当前播放；房主断线重连后据此恢复自己的播放进度
  //（服务端缓存的就是房主最后广播的状态）。
  // 挂载即发存在时序竞态：通用 join-room 与本模块挂载并行，get-state
  // 可能先于加入完成到达——服务端 isSocketInRoom 校验会拒绝（「不在该
  // 房间中」），导致首次进入房间拿不到歌单。因此 ack 失败时按退避重试
  //（500ms 起步 ×2、上限 3s）直到成功；断线重连由 connect 事件触发重发。
  useEffect(() => {
    if (!socket || !roomId) return
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryDelay = 500
    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }
    const requestGetState = () => {
      socket.emit(
        MUSIC_EVENT.GET_STATE,
        { roomId },
        (res: GetStateResponse) => {
          if (disposed) return
          if (!res?.success) {
            // 未加入房间/服务端瞬时错误：退避重试直到加入完成拉取成功
            clearRetry()
            retryTimer = setTimeout(() => {
              retryDelay = Math.min(retryDelay * 2, 3000)
              requestGetState()
            }, retryDelay)
            return
          }
          clearRetry()
          retryDelay = 500
          if (Array.isArray(res.queue)) {
            useMusicStore.getState().setQueue(res.queue)
            // 队列变化使洗牌序列失效：标记待重建
            shuffleListRef.current = null
          }
          if (res.syncState) {
            // 按同步状态恢复本地播放（换曲加载/播放状态/进度/播放模式）
            applyViewerSync(res.syncState)
          }
        }
      )
    }
    requestGetState()

    const handleConnect = () => {
      // 断线重连后重发（服务端房间会话可能已失效，重连后重新拉取）；
      // get-state 幂等，与退避重试并发无害
      clearRetry()
      requestGetState()
    }
    socket.on('connect', handleConnect)
    return () => {
      disposed = true
      clearRetry()
      socket.off('connect', handleConnect)
    }
  }, [socket, roomId, applyViewerSync])

  // Socket 事件监听：观众同步 / 队列变更 / 控制申请与应答
  useEffect(() => {
    if (!socket || !roomId) return

    // 观众：房主广播的同步状态
    const handleSyncState = (payload: MusicSyncState & { roomId?: string }) => {
      if (!payload || isHostRef.current) return
      // 防御：仅接受当前房间的事件（切换房间时旧事件残留）
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      applyViewerSync(payload)
    }

    // 观众：房主心跳（重置离线计时 + 状态对齐）
    const handleHostHeartbeat = (
      payload: MusicSyncState & { roomId?: string }
    ) => {
      if (!payload || isHostRef.current) return
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      lastHeartbeatAtRef.current = Date.now()
      const store = useMusicStore.getState()
      if (store.hostOffline) {
        store.setHostOffline(false)
      }
      applyViewerSync(payload)
    }

    // 全员：队列变更（后端广播完整队列）
    const handleQueueChanged = (payload: {
      items?: MusicQueueItem[]
      roomId?: string
    }) => {
      if (!payload || !Array.isArray(payload.items)) return
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      const store = useMusicStore.getState()
      const prevQueue = store.queue
      store.setQueue(payload.items)
      // 队列变化使洗牌序列失效：标记待重建（下次随机切歌时惰性重建）
      shuffleListRef.current = null
      // 清空播放列表：当前曲目原属队列且新队列已空 → 立即停声并清当前
      // 曲目（此前只清队列不动音频，声音继续播）。房主额外广播空 trackKey
      // ——观众端 applyViewerSync 走 trackKey==null 分支同步停声；观众本地
      // 插播（currentKey 不在房间队列）不受清空影响
      if (
        payload.items.length === 0 &&
        store.currentKey != null &&
        prevQueue.some((q) => musicItemKey(q) === store.currentKey)
      ) {
        const audio = getAudio()
        audio.pause()
        try {
          audio.currentTime = 0
        } catch {
          // ignore
        }
        store.setCurrentKey(null)
        broadcastSyncState({
          keyOverride: null,
          isPlaying: false,
          positionSec: 0,
        })
      }
    }

    // 房主：观众控制申请 → 播放器左上角提示 + 待审批；
    // addQueue（观众申请添加 B站 音频到播放队列）不走审批——房主开启
    // 「自动通过」时直接代理入队，关闭时回执拒绝
    const handleControlRequest = (
      payload: MusicControlRequest & { roomId?: string }
    ) => {
      if (!payload || !isHostRef.current) return
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      const action = payload.action
      if (action === 'addQueue') {
        if (!payload.from || !payload.item) return
        const autoApprove = useRoomStore.getState().autoApproveRequests
        if (!autoApprove) {
          socketRef.current?.emit(MUSIC_EVENT.CONTROL_RESPONSE, {
            roomId: roomIdRef.current,
            approved: false,
            action: 'addQueue',
            from: payload.from,
          })
          return
        }
        socketRef.current?.emit(
          'music:queue-upsert',
          {
            roomId: roomIdRef.current,
            item: payload.item,
            afterCurrent: payload.afterCurrent === true,
          },
          (res: { success?: boolean }) => {
            socketRef.current?.emit(MUSIC_EVENT.CONTROL_RESPONSE, {
              roomId: roomIdRef.current,
              approved: res?.success !== false,
              action: 'addQueue',
              from: payload.from,
            })
          }
        )
        return
      }
      // playItem（观众申请切换到播放列表条目）：自动通过时按 key 匹配
      // 房间队列后代理切歌并应答（条目不存在回执拒绝）；关闭时走审批
      if (action === 'playItem') {
        if (!payload.from || !payload.item) return
        if (useRoomStore.getState().autoApproveRequests) {
          const targetKey = musicItemKey(payload.item as MusicQueueItem)
          const matched = useMusicStore
            .getState()
            .queue.find((q) => musicItemKey(q) === targetKey)
          socketRef.current?.emit(MUSIC_EVENT.CONTROL_RESPONSE, {
            roomId: roomIdRef.current,
            approved: Boolean(matched),
            action: 'playItem',
            from: payload.from,
          })
          if (matched) playSong(matched)
          return
        }
        pendingControlRef.current = {
          action: 'playItem',
          from: payload.from,
          username: payload.username,
          item: payload.item,
        }
        const who = payload.username || '观众'
        useMusicStore
          .getState()
          .setSyncNotice(
            `${who} 申请${CONTROL_ACTION_TEXT.playItem}`,
            'approval'
          )
        return
      }
      // pause/play/next/prev/seek：房主开启「自动通过」时直接执行并定向
      // 应答（观众无需逐次等待审批）；关闭时统一走左上角审批条
      if (
        action !== 'pause' &&
        action !== 'play' &&
        action !== 'next' &&
        action !== 'prev' &&
        action !== 'seek'
      ) {
        return
      }
      if (!payload.from) return
      if (action === 'seek' && payload.positionSec == null) return
      if (useRoomStore.getState().autoApproveRequests) {
        executeHostAction(action, payload.positionSec)
        socketRef.current?.emit(MUSIC_EVENT.CONTROL_RESPONSE, {
          roomId: roomIdRef.current,
          approved: true,
          action,
          from: payload.from,
        })
        return
      }
      pendingControlRef.current = {
        action,
        from: payload.from,
        username: payload.username,
        ...(action === 'seek' ? { positionSec: payload.positionSec } : {}),
      }
      const who = payload.username || '观众'
      useMusicStore
        .getState()
        .setSyncNotice(`${who} 申请${CONTROL_ACTION_TEXT[action]}`, 'approval')
    }

    // 观众：控制申请应答（approved 时执行对应本地操作，并提示结果）
    const handleControlResponse = (
      payload: MusicControlResponse & { roomId?: string }
    ) => {
      if (!payload || isHostRef.current) return
      // 防御：仅处理发给自己的应答（后端定向下发时天然满足）
      if (payload.from && socket.id && payload.from !== socket.id) return
      const action = payload.action
      if (
        action !== 'pause' &&
        action !== 'play' &&
        action !== 'next' &&
        action !== 'prev' &&
        action !== 'addQueue' &&
        action !== 'seek' &&
        action !== 'playItem'
      ) {
        return
      }
      if (action === 'playItem') {
        // 切歌的实际换源由房主端执行后的 SYNC_STATE 广播驱动（房主是
        // 同步源），应答仅更新提示
        useMusicStore
          .getState()
          .setSyncNotice(
            payload.approved
              ? `房主已同意${CONTROL_ACTION_TEXT[action]}`
              : `房主已拒绝${CONTROL_ACTION_TEXT[action]}`
          )
        return
      }
      if (action === 'addQueue') {
        // 申请结果用 message 明确提示（哔哩哔哩页等无播放器场景也可见）
        if (payload.approved) {
          message.success('歌曲已加入播放列表')
        } else {
          message.error('无权限：房主未开启「自动通过」，无法添加到播放列表')
        }
        useMusicStore
          .getState()
          .setSyncNotice(
            payload.approved ? '歌曲已加入播放列表' : '添加到播放列表被拒绝'
          )
        return
      }
      if (action === 'seek') {
        // seek 的实际对齐交给房主端执行后的 SYNC_STATE 广播（房主是
        // 同步源）；应答本身不携带目标进度，本地不再自行 seek 避免与
        // 广播竞态
        useMusicStore
          .getState()
          .setSyncNotice(
            payload.approved
              ? '房主已同意调节播放进度'
              : '房主已拒绝调节播放进度'
          )
        return
      }
      if (payload.approved) {
        useMusicStore
          .getState()
          .setSyncNotice(`房主已同意${CONTROL_ACTION_TEXT[action]}`)
        executeLocalAction(action)
      } else {
        useMusicStore
          .getState()
          .setSyncNotice(`房主已拒绝${CONTROL_ACTION_TEXT[action]}`)
      }
    }

    // 房主：观众切歌同步回执 → 左下角「xx 已同步」提示（过期清理在组件）
    const handleSyncAck = (payload: { roomId?: string; username?: string }) => {
      if (!payload || !isHostRef.current) return
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      useMusicStore.getState().pushSyncAck(payload.username || '观众')
    }

    socket.on(MUSIC_EVENT.SYNC_STATE, handleSyncState)
    socket.on(MUSIC_EVENT.HOST_HEARTBEAT, handleHostHeartbeat)
    socket.on(MUSIC_EVENT.QUEUE_CHANGED, handleQueueChanged)
    socket.on(MUSIC_EVENT.CONTROL_REQUEST, handleControlRequest)
    socket.on(MUSIC_EVENT.CONTROL_RESPONSE, handleControlResponse)
    socket.on(MUSIC_EVENT.SYNC_ACK, handleSyncAck)

    return () => {
      socket.off(MUSIC_EVENT.SYNC_STATE, handleSyncState)
      socket.off(MUSIC_EVENT.HOST_HEARTBEAT, handleHostHeartbeat)
      socket.off(MUSIC_EVENT.QUEUE_CHANGED, handleQueueChanged)
      socket.off(MUSIC_EVENT.CONTROL_REQUEST, handleControlRequest)
      socket.off(MUSIC_EVENT.CONTROL_RESPONSE, handleControlResponse)
      socket.off(MUSIC_EVENT.SYNC_ACK, handleSyncAck)
    }
  }, [
    socket,
    roomId,
    applyViewerSync,
    executeLocalAction,
    executeHostAction,
    playSong,
    getAudio,
    broadcastSyncState,
  ])

  // 卸载/离开：释放音频资源、清理内部状态
  //（store 不在此重置，由 Task 6 的离开房间流程统一调用 reset）
  useEffect(() => {
    return () => {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.srcObject = null
        audio.removeAttribute('src')
        audio.load()
        unmountMediaElement(audio)
      }
      audioRef.current = null
      const preload = preloadRef.current
      if (preload) {
        preload.pause()
        preload.removeAttribute('src')
        try {
          preload.load()
        } catch {
          // ignore
        }
        unmountMediaElement(preload)
      }
      preloadRef.current = null
      pendingSeekRef.current = 0
      shuffleListRef.current = null
      shufflePosRef.current = -1
      pendingControlRef.current = null
    }
  }, [])

  // 房间关闭 / 断连媒体停止（RoomPage 收到 room-closed / disconnect 后
  // dispatch，见 lib/mediaTeardown）：音频与预加载元素都走后端代理，
  // 房间关闭后若继续播放会令服务端持续代理上游音频流量，必须立即停流。
  // full=false（断线）仅暂停，保留 src，重连后由同步流程恢复。
  useEffect(() => {
    const handleTeardown = (e: Event) => {
      const detail = (e as CustomEvent<RoomMediaTeardownDetail>).detail
      const full = detail?.full ?? true
      const stopEl = (el: HTMLAudioElement) => {
        el.pause()
        if (full) {
          el.removeAttribute('src')
          el.load()
        }
      }
      if (audioRef.current) stopEl(audioRef.current)
      if (preloadRef.current) {
        stopEl(preloadRef.current)
        if (full) {
          // 引用即将丢弃，从 DOM 一并移除（否则隐藏元素残留 body 无法 GC）
          unmountMediaElement(preloadRef.current)
          preloadRef.current = null
        }
      }
    }
    window.addEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
    return () =>
      window.removeEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
  }, [])

  // 当前播放的队列条目（queue + currentKey 匹配；B站 本地插播条目
  // 不在房间队列中，从 store.biliItem 合并）
  const currentSong = useMemo(() => {
    if (currentKey == null) return null
    const inQueue = queue.find((item) => musicItemKey(item) === currentKey)
    if (inQueue) return inQueue
    if (biliItem && musicItemKey(biliItem) === currentKey) return biliItem
    return null
  }, [queue, currentKey, biliItem])

  /** 是否拥有直接控制权（房主或房主离线时的观众，按钮 label 由 UI 层处理） */
  const canControl = isHost || hostOffline

  return {
    togglePlay,
    next,
    prev,
    seek,
    setPlayMode,
    playSong,
    playBiliSong,
    addBiliRecommendations,
    requestControl,
    approveControl,
    rejectControl,
    currentSong,
    canControl,
    hostOffline,
    syncNotice,
    syncNoticeKind,
    setSyncNotice,
    volume,
    setVolume,
    getAudio,
  }
}
