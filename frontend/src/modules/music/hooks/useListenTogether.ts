import { portableMusicCoverUrl } from '../utils/neteaseImage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useShallow } from 'zustand/react/shallow'
import { useRoomStore } from '@/store/roomStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { initialMusicVolume } from '../utils/volume'
import {
  advancePersonalFm,
  fetchPersonalFmPool,
  usePersonalFmStore,
} from '../personal-fm'
import type { FetchFmPoolOptions, FmSongItem } from '../personal-fm'
import {
  ROOM_MEDIA_TEARDOWN_EVENT,
  type RoomMediaTeardownDetail,
} from '@/lib/mediaTeardown'
import { apiGet, getApiUrl } from '../musicApi'
import { appendAuthToken } from '@/modules/player/services/url-proxy'
import { buildProxyUrl } from '@/modules/player/services/url-proxy'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { resolveBilibiliViaCli } from '@/modules/bilibili/cliApi'
import { getActiveCliProxyUrl } from '@/modules/movie-source/resolver'
import { message } from '@/components/ui/message'
import { compensatePositionSec } from '../utils/syncMath'
import { needsMusicAlign } from '../utils/serverSync'
import {
  useMusicStore,
  musicItemKey,
  parseMusicKey,
  activeQueueOf,
} from '../store'
import { useMusicSettingsStore, normalizeMusicLevel } from '../store-settings'
import {
  resolveBilibiliAudioWithFallback,
  selectBilibiliAudioStream,
} from '../utils/bilibiliAudioStream'
import { resolveBiliPartMeta } from '../bilibiliPlaylist'
import { loudnessNormalizer } from '../audio/loudnessNormalizer'
import {
  MUSIC_SOCKET_EVENT,
  SYNC_ALIGN_THRESHOLD_SEC,
  MUSIC_CHECK_STATUS_INTERVAL_MS,
  SERVER_HEARTBEAT_STALE_MS,
} from '../constants'
import type {
  MusicCheckStatusAckData,
  MusicControlRequest,
  MusicControlResponse,
  MusicQueueItem,
  MusicSyncHeartbeatPayload,
  MusicSyncState,
  PlayMode,
  NcmSong,
} from '../types'
import {
  BILI_DEFAULT_QN,
  biliResolvingPromises,
  getCachedBiliAudioUrl,
  setCachedBiliAudioUrl,
} from './biliAudioCache'
import { playAudioWithRetry } from './audioElement'
import { useAudioEngine } from './useAudioEngine'
import { useQueueAdvance } from './useQueueAdvance'
import { t } from '@/i18n'

/**
 * Socket 事件名（与后端 MusicSyncHandler / MusicBroadcasterService 约定）。
 * 事件常量已集中到 constants.ts（架构对齐一起看 sync-playback/constants），
 * 此处保留别名以复用既有引用点。
 */
const MUSIC_EVENT = MUSIC_SOCKET_EVENT

/**
 * music:get-state 的 ack 应答（与后端 MusicSyncHandler 契约一致）。
 * syncState 为服务器推算后的权威状态（positionSec 已按服务器时间轴外推，
 * 后端重启后从 DB 恢复；房间从未播放时为 null）。
 */
interface GetStateResponse {
  success: boolean
  message?: string
  queue?: MusicQueueItem[]
  syncState?: MusicSyncState | null
  /** 服务器当前时间（毫秒；旧后端缺省） */
  serverTs?: number
  /** 房主是否在线（缺省 = 旧后端，维持心跳超时判定；false 时直接进入自主控制） */
  hostOnline?: boolean
}

/** 房主心跳广播间隔（毫秒）。心跳是服务器基线更新通道，观众不直接消费 */
const HOST_HEARTBEAT_INTERVAL_MS = 2000

/** B站 相关推荐一次加入的条数上限（手动「自动推荐」与列表末尾自动扩展均为前 3 条） */
const BILI_RECOMMEND_LIMIT = 3

/**
 * 私人漫游自动续播失败后的重试退避间隔（毫秒）：
 * 候选补拉返回空批次、入队 ack 超时等瞬时问题不应让漫游停在暂停态，
 * 按 2s / 5s / 10s 退避重试三次后再提示。
 */
const FM_ADVANCE_RETRY_DELAYS = [2000, 5000, 10000]

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

/**
 * 相关推荐条目 → queue-upsert 载荷（B站 条目 songId=0，标 recommended）。
 *
 * 相关推荐只给「视频级」信息（标题=合集名），而一次推荐经常落在多分P合集上：
 * 直接用 r.title 会让播放列表出现 N 行同名，且时长是整个视频的总长。这里补
 * 一次视频详情（bvid 维度有 10 分钟缓存，3 条推荐最多 3 次请求）把曲名换成
 * 分P名、时长换成分P时长；拿不到详情时静默回退标题。
 */
async function biliRecToUpsertItem(r: BiliRelatedItem) {
  const meta = await resolveBiliPartMeta(r.bvid, r.cid ?? 0, r.title)
  // 多分P时视频总时长不能当分P时长用，缺失就置 0（未知），交给播放器按需外推
  const durationSec =
    meta.durationSec > 0
      ? meta.durationSec
      : meta.multiPart
        ? 0
        : r.duration || 0
  return {
    songId: 0,
    name: meta.name,
    artist: r.upName || t('哔哩哔哩'),
    album: meta.album,
    cover: portableMusicCoverUrl(r.pic),
    durationMs: Math.round(durationSec * 1000),
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

/** 读取持久化的本地音量（0-1，无效/缺失时使用服务器默认音量） */
function loadPersistedVolume(): number {
  const fallback = useSystemSettingsStore.getState().roomDefaultMusicVolume
  try {
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY)
    return initialMusicVolume(saved, fallback)
  } catch {
    return initialMusicVolume(null, fallback)
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
 * 解析 B站 视频音频直链（结果写入 biliAudioUrlMap 并返回）。
 * 已有缓存直接返回；供 playBiliSong 与 loadAndPlaySong 的懒解析兜底共用
 *（队列/同步场景下 B站 条目可能尚未解析过）。
 */
async function resolveBiliAudio(
  item: MusicQueueItem
): Promise<{ playUrl: string; durationMs: number }> {
  if (!item.biliBvid) throw new Error(t('缺少 B站 视频信息'))
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
      throw new Error(t('未获取到音频地址'))
    }
    playUrl = (r.audioUrl ?? r.videoUrl) as string
    if (r.duration) durationMs = Math.round(r.duration * 1000)
  } else {
    // Prefer the independent audio track and preserve the selected part's CID.
    // The media proxy supplies the Referer required by Bilibili's CDN.
    const r = await resolveBilibiliAudioWithFallback((options) =>
      resolveBilibiliWithOptions(pageUrl, BILI_DEFAULT_QN, undefined, {
        ...options,
        cid: item.biliCid,
      })
    )
    playUrl = buildProxyUrl(selectBilibiliAudioStream(r))
    if (r.duration) durationMs = Math.round(r.duration * 1000)
  }
  setCachedBiliAudioUrl(mapKey, playUrl)
  return { playUrl, durationMs }
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
  /** 启动 FM 会话；确认入队后播放，候选耗尽时自动补拉。 */
  playFmSong: (song: NcmSong) => Promise<boolean>
  /** 当前主音频元素（惰性创建；预载升格时会被替换，可视化消费方需感知） */
  getAudio: () => HTMLAudioElement | null
}

/**
 * 一起听核心 Hook：音频播放引擎 + 房主/观众同步。
 *
 * 结构对齐 useWatchTogether（socket 事件注册、房主/观众分支、
 * 心跳、申请制、hostOffline → canControl），同步信令对齐一起看的
 * 「服务器权威心跳」架构（Step1/2/3）：
 * - 音频元素与无缝预载元素的生命周期（创建/挂 DOM/事件绑定/预载升格/
 *   释放）全部收敛在 useAudioEngine：本 hook 只决定「播什么」，引擎负责
 *   「怎么播」。元素惰性创建且不渲染进 React 树，创建即挂 DOM
 *   display:none——MediaSession 系统媒体通知要求媒体元素在 DOM 内
 *   （见 useAudioEngine 的 playSource/getAudio），src 走 /api/music/stream 代理
 * - 房主：togglePlay/next/prev/seek/setPlayMode 直接操作 audio 并广播
 *   'music:sync-state'（附 clientTs，服务器写侧补偿）；ended 按 playMode
 *   自动切歌；每 2s 心跳（服务器基线更新通道，观众不直接消费）
 * - 观众：进度唯一权威来源 = 服务器每 2s 广播的 music:sync-heartbeat
 *   (source='server')（positionSec 已按服务器时间轴外推，差 >2s 才 seek）；
 *   每 10s check-status 主动自检（±10s 容差）自愈；房主心跳仅在服务器
 *   心跳失联 7s 时 fallback；hostOffline 由服务器 host-disconnected /
 *   sharer-ready 事件驱动；控制走申请制
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
  const volumeAdjustedRef = useRef(false)
  const fmPlayRequestRef = useRef(0)
  /**
   * 音频加载失败处理器（私人漫游遇到无法播放的曲目时自动跳过）。
   * 引擎在固定的事件处理器里经 ref 调用，避免事件绑定期依赖调用方闭包。
   */
  const audioErrorHandlerRef = useRef<(() => boolean) | null>(null)

  // ===== Refs =====
  /**
   * 观众最近一次收到服务器心跳（music:sync-heartbeat source='server'）的
   * 时间戳（0 表示尚未收到）。房主心跳仅在该时间戳超过 SERVER_HEARTBEAT_STALE_MS
   * 失联时作 fallback 消费（旧后端兼容），双通道并存会导致重复处理。
   */
  const lastServerHeartbeatAtRef = useRef(0)
  /** 房主端待审批的观众申请 */
  const pendingControlRef = useRef<MusicControlRequest | null>(null)
  /** 用户音量镜像（0–1，未乘响度均衡增益；UI 与持久化都用它） */
  const userVolumeRef = useRef(volume)
  /** 实际写入元素的音量 = 用户音量 × 均衡增益（引擎创建元素时读取） */
  const volumeRef = useRef(volume)
  // latest ref 模式：事件回调经 ref 读取最新身份
  const socketRef = useRef(socket)
  const roomIdRef = useRef(roomId)
  const isHostRef = useRef(isHost)
  const usernameRef = useRef(username)

  // ===== 队列推进引擎：位置锚点 / 随机洗牌 / 按模式切歌（见 useQueueAdvance）=====
  const { currentQueueIdxRef, peekNextSong, computeTargetSong, resetShuffle } =
    useQueueAdvance()

  /** ended 处理器的最新实现（handleEnded 随 switchSong 依赖重建，经 ref 间接调用） */
  const endedHandlerRef = useRef<() => void>(() => {})

  /** 队列条目 → 音频流地址（roomId 经 ref 实时读取，供引擎预载与加载使用） */
  const buildUrl = useCallback(
    (item: MusicQueueItem) => buildStreamUrl(item, roomIdRef.current),
    []
  )

  // ===== 音频引擎：主播放元素 + 无缝预载元素的生命周期 =====
  const { audioRef, getAudio, playSource, stopAll, dispose } = useAudioEngine({
    volumeRef,
    endedHandlerRef,
    onErrorRef: audioErrorHandlerRef,
    peekNextSong,
    buildUrl,
    currentKey,
    queue,
    playMode,
  })

  /**
   * 把「用户音量 × 响度均衡增益」写进当前主元素。
   * 静音只由用户音量决定：均衡最多把音量压到 1/4，不会把非零音量变成静音。
   */
  const applyOutputVolume = useCallback(() => {
    const effective = Math.min(
      1,
      Math.max(0, userVolumeRef.current * loudnessNormalizer.getGain())
    )
    volumeRef.current = effective
    const audio = audioRef.current
    if (!audio) return
    audio.muted = userVolumeRef.current === 0
    audio.volume = effective
  }, [audioRef])

  useEffect(() => {
    // 增益由均衡器在测量过程中逐步给出（换曲、收敛、关闭时归 1）
    loudnessNormalizer.setGainListener(applyOutputVolume)
    return () => loudnessNormalizer.setGainListener(null)
  }, [applyOutputVolume])

  // 音量均衡是本地设置（设置页「音量均衡」）；关闭时不建 AudioContext、不跑定时器
  const volumeNormalize = useMusicSettingsStore((s) => s.volumeNormalize)
  useEffect(() => {
    loudnessNormalizer.setEnabled(volumeNormalize)
    applyOutputVolume()
    return () => loudnessNormalizer.setEnabled(false)
  }, [volumeNormalize, applyOutputVolume])

  useEffect(() => {
    userVolumeRef.current = volume
    applyOutputVolume()
  }, [volume, applyOutputVolume])

  useEffect(() => {
    socketRef.current = socket
    roomIdRef.current = roomId
    isHostRef.current = isHost
    usernameRef.current = username
  }, [socket, roomId, isHost, username])

  // 公开设置可能晚于播放器挂载返回。仅在本次未手调且无本地记录时应用。
  useEffect(() => {
    const applyDefault = () => {
      if (volumeAdjustedRef.current) return
      const value = loadPersistedVolume()
      userVolumeRef.current = value
      setVolumeState(value)
      applyOutputVolume()
    }
    const unsubscribe = useSystemSettingsStore.subscribe(applyDefault)
    void useSystemSettingsStore.getState().fetchSettings()
    return unsubscribe
  }, [applyOutputVolume])

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
  }, [audioRef])

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
        // Step1：附发出时刻时间戳，服务器写侧补偿传输延迟后基线锚定服务器时间轴
        clientTs: Date.now(),
        ...payload,
      })
    },
    [buildSyncPayload]
  )

  /** 加载指定队列条目（positionSec 为起始进度；shouldPlay 控制起播状态）。
   *  预载升格由音频引擎内部处理（命中预载则零等待接管），
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
          const inflight = biliResolvingPromises.get(mapKey)
          if (inflight) {
            // 并发解析中（如 playBiliSong 先点了同一首）：解析完成后重放
            // 本请求——后台自动连播依赖这里，静默丢弃会让切歌停摆；
            // 解析失败（缓存仍空）时静默放弃，错误已由首次请求提示
            void inflight.then(() => {
              if (getCachedBiliAudioUrl(mapKey) != null) {
                loadAndPlaySongRef.current(item, positionSec, shouldPlay)
              }
            })
            return
          }
          const notice = useMusicStore.getState().setSyncNotice
          notice(t('正在解析 B站 视频音频…'))
          const resolving = resolveBiliAudio(item)
            .then(() => {
              notice(null)
              loadAndPlaySongRef.current(item, positionSec, shouldPlay)
            })
            .catch((err) => {
              notice(null)
              message.error(
                err instanceof Error ? err.message : t('B站 音频解析失败')
              )
            })
            .finally(() => {
              biliResolvingPromises.delete(mapKey)
            })
          biliResolvingPromises.set(mapKey, resolving)
          return
        }
      }
      const url = buildStreamUrl(item, roomIdRef.current)
      useMusicStore.getState().setCurrentKey(musicItemKey(item))
      // 位置锚点：按引用在活动队列中定位本次播放的实例（重复条目可区分
      // 具体位置）；非队列条目（B站 本地插播等）置 -1，切歌时回落 key
      // 首个匹配。注意 setCurrentKey 已生效，activeQueueOf 的源过滤与新
      // 曲目一致。
      currentQueueIdxRef.current = activeQueueOf(
        useMusicStore.getState()
      ).indexOf(item)

      // 元素加载与起播交给引擎：命中预载（同 URL 且已缓冲）则升格接管，
      // 否则主元素重新 load；起始进度与起播状态由引擎按元素状态处理。
      // trackKey 用于响度均衡命中增益缓存（换曲前就位，避免前几秒明显偏响）
      playSource(url, positionSec, shouldPlay, musicItemKey(item))
    },
    [playSource, currentQueueIdxRef]
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
      fmPlayRequestRef.current++
      usePersonalFmStore.getState().deactivate()
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

  const fmAdvancingRef = useRef(false)
  /** tryFmContinue 的 latest-ref（重试定时器/音频失败回调经 ref 复用同一实现） */
  const tryFmContinueRef = useRef<() => boolean>(() => false)
  /** 自动续播失败后的重试定时器与连续失败次数（补拉空批次/入队失败的瞬时自愈） */
  const fmRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fmAdvanceFailuresRef = useRef(0)
  /** 最近一次「坏曲自动跳过」的时间戳（滚动窗口限流，防止在坏源之间空转） */
  const fmSkipTimesRef = useRef<number[]>([])
  /** 自动续播失败的重试退避间隔（毫秒）；用尽后停止重试并提示 */
  const cancelFmRetry = useCallback(() => {
    if (fmRetryTimerRef.current) {
      clearTimeout(fmRetryTimerRef.current)
      fmRetryTimerRef.current = null
    }
    fmAdvanceFailuresRef.current = 0
  }, [])
  const refillFm = useCallback(
    (options?: FetchFmPoolOptions) =>
      fetchPersonalFmPool(async (url) => {
        const { data } = await apiGet<{ data?: FmSongItem[] }>(url)
        return Array.isArray(data?.data) ? data.data : []
      }, options),
    []
  )
  const enqueueFm = useCallback(
    (song: NcmSong, targetRoom: string) =>
      new Promise<void>((resolve, reject) => {
        const activeSocket = socketRef.current
        if (!activeSocket?.connected) {
          reject(new Error(t('未连接房间')))
          return
        }
        activeSocket.timeout(8000).emit(
          'music:queue-upsert',
          {
            roomId: targetRoom,
            item: song,
            afterCurrent: true,
          },
          (
            err: Error | null,
            response: { success?: boolean; message?: string }
          ) => {
            if (err || !response?.success)
              reject(new Error(response?.message || t('漫游歌曲入队失败')))
            else resolve()
          }
        )
      }),
    []
  )
  const playFmItem = useCallback(
    (song: NcmSong, targetRoom: string) => {
      const item: MusicQueueItem = {
        ...song,
        roomId: targetRoom,
        id: -1,
        order: 0,
        addedBy: '',
      }
      loadAndPlaySong(item, 0, true)
      broadcastSyncState({
        keyOverride: musicItemKey(item),
        isPlaying: true,
        positionSec: 0,
      })
    },
    [loadAndPlaySong, broadcastSyncState]
  )
  const tryFmContinue = useCallback((): boolean => {
    const state = useMusicStore.getState()
    const fm = usePersonalFmStore.getState()
    const targetRoom = roomIdRef.current
    // 仅房主推进共享 FM；观众仍等待同步，不自行添加曲目。
    if (
      !isHostRef.current ||
      !targetRoom ||
      fm.activeRoomId !== targetRoom ||
      fm.activeKey == null ||
      fm.activeKey !== state.currentKey
    )
      return false
    if (fmAdvancingRef.current) return true
    fmAdvancingRef.current = true
    // 本轮续播的起点曲目：入队确认期间会话校验、失败重试都以它为准
    const fromKey = state.currentKey
    void advancePersonalFm(targetRoom, fromKey, {
      refill: refillFm,
      enqueue: (song) => enqueueFm(song, targetRoom),
      play: (song) => {
        playFmItem(song, targetRoom)
        if (usePersonalFmStore.getState().pool.length < 2)
          void refillFm().catch(() => {})
      },
      isCurrent: () =>
        roomIdRef.current === targetRoom &&
        isHostRef.current &&
        useMusicStore.getState().currentKey === fromKey,
    })
      .then(() => {
        fmAdvanceFailuresRef.current = 0
      })
      .catch((err: unknown) => {
        // 会话已失效（切歌/离房/换模式/用户暂停）：不再重试，避免把播放复活
        const latest = usePersonalFmStore.getState()
        if (
          !isHostRef.current ||
          roomIdRef.current !== targetRoom ||
          latest.activeKey !== fromKey
        ) {
          fmAdvanceFailuresRef.current = 0
          return
        }
        const attempt = fmAdvanceFailuresRef.current
        if (attempt >= FM_ADVANCE_RETRY_DELAYS.length) {
          fmAdvanceFailuresRef.current = 0
          message.error(err instanceof Error ? err.message : t('漫游续播失败'))
          return
        }
        // 候选补拉偶尔返回空批次、入队 ack 偶尔超时：退避后重试同一首的
        // 续播，而不是把漫游停在暂停态（用户看到的就是「自动播几首后停了」）
        fmAdvanceFailuresRef.current = attempt + 1
        if (fmRetryTimerRef.current) clearTimeout(fmRetryTimerRef.current)
        fmRetryTimerRef.current = setTimeout(() => {
          fmRetryTimerRef.current = null
          tryFmContinueRef.current()
        }, FM_ADVANCE_RETRY_DELAYS[attempt])
      })
      .finally(() => {
        fmAdvancingRef.current = false
      })
    return true
  }, [enqueueFm, playFmItem, refillFm])

  useEffect(() => {
    tryFmContinueRef.current = tryFmContinue
  }, [tryFmContinue])

  /**
   * 音频加载失败（无版权 / 需要 VIP / 直链失效等）：私人漫游自动续播时
   * 跳过该曲继续下一首。此前这种失败只会弹一次错误提示，`ended` 永不触发，
   * FM 就永久停在失败曲目上——正是「播几首后不再继续」的另一条路径。
   * 返回 true 表示已接管（引擎不再弹通用错误提示）。
   */
  const handleFmPlayError = useCallback((): boolean => {
    if (!isHostRef.current) return false
    // 已有续播在途：跳过会与本次续播打架，交回引擎的通用提示
    if (fmAdvancingRef.current) return false
    const fm = usePersonalFmStore.getState()
    const state = useMusicStore.getState()
    // 只接管私人漫游会话内的曲目；普通队列曲目仍走引擎的通用提示
    if (fm.activeKey == null || fm.activeKey !== state.currentKey) return false
    const now = Date.now()
    fmSkipTimesRef.current = fmSkipTimesRef.current.filter(
      (ts) => now - ts < 60_000
    )
    if (fmSkipTimesRef.current.length >= 4) {
      // 短时间内连续多首无法播放：停止自动跳过，避免在坏源之间空转
      cancelFmRetry()
      usePersonalFmStore.getState().deactivate()
      message.error(t('连续多首漫游歌曲无法播放，已停止自动续播'))
      return true
    }
    const skipped = usePersonalFmStore.getState().current
    // 有候选可续 → 直接换下一首（当前失败曲由续播流程记入历史）；
    // 没有候选则不消耗跳过额度，交回引擎的通用错误提示
    if (!tryFmContinueRef.current()) return false
    fmSkipTimesRef.current.push(now)
    message.info(`「${skipped?.name ?? '当前歌曲'}」无法播放，已自动跳过`)
    return true
  }, [cancelFmRetry])

  useEffect(() => {
    audioErrorHandlerRef.current = handleFmPlayError
    return () => {
      audioErrorHandlerRef.current = null
    }
  }, [handleFmPlayError])

  const playFmSong = useCallback(
    async (song: NcmSong) => {
      const targetRoom = roomIdRef.current
      if (!isHostRef.current || !targetRoom)
        throw new Error(t('私人漫游由房主控制'))
      const request = ++fmPlayRequestRef.current
      usePersonalFmStore.getState().invalidate()
      const generation = usePersonalFmStore.getState().generation
      await enqueueFm(song, targetRoom)
      if (
        request !== fmPlayRequestRef.current ||
        roomIdRef.current !== targetRoom ||
        !isHostRef.current ||
        usePersonalFmStore.getState().generation !== generation
      )
        return false
      usePersonalFmStore.getState().activate(targetRoom, song)
      playFmItem(song, targetRoom)
      if (usePersonalFmStore.getState().pool.length < 2)
        void refillFm().catch(() => {})
      return true
    },
    [enqueueFm, playFmItem, refillFm]
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
    // 倒序逐条 afterCurrent 入队 → 最终顺序与推荐一致、紧跟当前曲目。
    // 首条载荷先算好并复用给下面的「直接续播」，避免同一 BV 解析两次分P名
    const firstPayload = await biliRecToUpsertItem(fresh[0])
    let added = 0
    for (const r of [...fresh].reverse()) {
      const payload =
        r === fresh[0] ? firstPayload : await biliRecToUpsertItem(r)
      const ok = await new Promise<boolean>((resolve) => {
        currentSocket.emit(
          'music:queue-upsert',
          {
            roomId: currentRoomId,
            item: payload,
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
      name: firstPayload.name,
      artist: firstPayload.artist,
      album: firstPayload.album,
      cover: firstPayload.cover,
      durationMs: firstPayload.durationMs,
      vip: false,
      order: 0,
      addedBy: '',
      biliBvid: firstPayload.biliBvid,
      biliCid: firstPayload.biliCid,
    }
    loadAndPlaySong(item, 0, true)
    if (isHostRef.current) {
      broadcastSyncState({
        keyOverride: biliRecKey(first),
        isPlaying: true,
        positionSec: 0,
      })
    }
    message.info(`已自动播放相关推荐：${firstPayload.name}`)
  }, [switchSong, loadAndPlaySong, broadcastSyncState])

  /**
   * 「下一首」到队列末尾时的推荐续播判定：按顺序播放 + 当前 B站 条目 +
   * 「B站视频自动连播」开启时触发 handleBiliContinue（拉 3 首推荐入队并
   * 续播）。手动「下一首」（next / executeHostAction）与曲目自然播完
   * （handleEnded 队列末尾）共用本判定。返回是否已触发。
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
    if (fmAdvancingRef.current) usePersonalFmStore.getState().invalidate()
    // 用户手动播放/暂停：取消排队中的漫游续播重试（避免稍后自己跳下一首）
    cancelFmRetry()
    const audio = getAudio()
    const wantPlay = audio.paused
    if (wantPlay) {
      // 通知栏 play 按钮在后台触发时同样可能被自动播放策略拒绝，走重试
      playAudioWithRetry(audio, () => {
        message.error(t('播放失败，请重试'))
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
  }, [getAudio, broadcastSyncState, hasControl, cancelFmRetry])

  /**
   * 下一首（按播放模式计算目标）。按顺序播放已到末尾时不再回绕到列表
   * 开头，仅提示「队列中无下一首」（顺序循环/随机按各自规则继续）
   */
  const next = useCallback(() => {
    if (!hasControl()) return
    if (tryFmContinue()) return
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
          message.info(t('队列中无下一首'))
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
          message.info(t('队列中无下一首'))
        }
      }
    }
  }, [switchSong, hasControl, tryBiliContinueOnNext, tryFmContinue])

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
      resetShuffle()
      if (isHostRef.current) {
        broadcastSyncState({ playMode: mode })
      }
    },
    [broadcastSyncState, hasControl, resetShuffle]
  )

  /** 播放指定队列条目（房主点击队列/FM 切歌；条目可不带 id/order，仅要求可定位来源） */
  const playSong = useCallback(
    (item: MusicQueueItem) => {
      if (!hasControl()) return
      fmPlayRequestRef.current++
      usePersonalFmStore.getState().deactivate()
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
      volumeAdjustedRef.current = true
      userVolumeRef.current = clamped
      // 保持既有行为：调节音量即确保播放入口已创建
      getAudio()
      // 实际写入元素的是「音量 × 均衡增益」，UI 与持久化仍存用户音量
      applyOutputVolume()
      setVolumeState(clamped)
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped))
      } catch {
        // ignore：隐私模式等场景写入失败可忽略
      }
    },
    [getAudio, applyOutputVolume]
  )

  /**
   * 播放 B站 视频音频（哔哩哔哩页点击视频）：解析音频地址（默认 720P MP4
   * 直链经后端代理注入 Referer；音乐设置开启 CLI 高画质且本地代理在线时取
   * DASH 音轨 m4s）后作为本地插播曲目播放。
   * 仅本地生效：不入房间队列、不同步、观众/房主均可自由使用。
   */
  const playBiliSong = useCallback(
    async (item: MusicQueueItem) => {
      fmPlayRequestRef.current++
      usePersonalFmStore.getState().deactivate()
      if (!isBiliItem(item) || !item.biliBvid) return
      const notice = useMusicStore.getState().setSyncNotice
      notice(t('正在解析 B站 视频音频…'))
      try {
        const { durationMs } = await resolveBiliAudio(item)
        const enriched: MusicQueueItem = { ...item, durationMs }
        // 本地插播（个人试听/离线模式）：不入队列，房主跟随同步见 playSong
        useMusicStore.getState().setBiliItem(enriched)
        loadAndPlaySong(enriched, 0, true)
        notice(null)
      } catch (err) {
        notice(null)
        message.error(
          err instanceof Error ? err.message : t('B站 音频解析失败')
        )
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
          // 观众申请暂停：取消排队中的漫游续播重试
          cancelFmRetry()
          audio.pause()
          broadcastSyncState({
            isPlaying: false,
            positionSec: audio.currentTime,
          })
          break
        case 'play':
          if (useMusicStore.getState().currentKey == null) return
          // 房主可能在后台收到观众的播放申请，同样走重试
          playAudioWithRetry(audio)
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
    [
      getAudio,
      switchSong,
      broadcastSyncState,
      seek,
      playSong,
      next,
      cancelFmRetry,
    ]
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
          playAudioWithRetry(audio)
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
   * 观众：应用同步状态（服务器心跳 / 房主广播 / 心跳 fallback / get-state 共用）。
   * - 曲目 key 变化（trackSongId 匹配）→ 换源加载
   * - isPlaying 变化 → play/pause
   * - 进度差 >2s → seek 对齐（小差异让音频自然播放）
   * - playMode → 同步到 store
   *
   * options.compensate 两条路径的语义（勿混淆）：
   * - false：服务器权威路径（music:sync-heartbeat source='server' / get-state /
   *   check-status ack）。payload.positionSec 已由服务器按权威时间轴外推到
   *   「当前时刻」，直接使用——本地再补偿会重复推进。
   * - true（默认）：旧路径（房主 sync-state 直发 / 心跳 fallback）。payload
   *   是房主发出时刻的快照，用 compensatePositionSec 补偿在途推进
   *   （观众本地时钟 vs 房主 updatedAt，存在跨设备钟差，仅兜底）。
   */
  const applyViewerSync = useCallback(
    (payload: MusicSyncState, options?: { compensate?: boolean }) => {
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
      // 目标进度：服务器路径直接用（已外推）；旧路径做传输延迟补偿
      const targetPositionSec =
        options?.compensate === false
          ? payload.positionSec
          : compensatePositionSec(payload)

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
          // 观众端多处于后台：跟随房主恢复播放被拒时重试，否则会一直停在
          // 暂停态等下一次心跳
          playAudioWithRetry(audio)
        } else {
          audio.pause()
        }
      }

      // 3. 进度对齐：差值超过阈值才 seek，避免高频打断
      if (
        needsMusicAlign(
          audio.currentTime,
          targetPositionSec,
          SYNC_ALIGN_THRESHOLD_SEC
        )
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
        message.error(t('未连接房间'))
        return 0
      }
      const store = useMusicStore.getState()
      // 当前播放条目：房间队列匹配优先，本地插播条目兜底
      const current = store.currentKey
        ? (store.queue.find((q) => musicItemKey(q) === store.currentKey) ??
          store.biliItem)
        : store.biliItem
      if (!current?.biliBvid) {
        message.info(t('当前播放的不是 B站 视频，无法获取推荐'))
        return 0
      }
      let fresh: BiliRelatedItem[]
      try {
        fresh = await fetchBiliRecs(current.biliBvid)
      } catch {
        message.error(t('获取 B站 推荐失败'))
        return 0
      }
      if (fresh.length === 0) {
        message.info(t('B站 未返回可加入的相关推荐（推荐均已在使用中）'))
        return 0
      }
      if (canManage || isHostRef.current) {
        // 倒序逐条 afterCurrent 入队 → 最终顺序与推荐一致、紧跟当前曲目
        let added = 0
        for (const r of [...fresh].reverse()) {
          const payload = await biliRecToUpsertItem(r)
          const ok = await new Promise<boolean>((resolve) => {
            currentSocket.emit(
              'music:queue-upsert',
              {
                roomId: currentRoomId,
                item: payload,
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
            t('B站 推荐加入播放列表失败（需重启后端以启用新队列字段）')
          )
        }
        return added
      }
      // 观众：倒序逐条 addQueue 申请（房主代理后顺序=推荐顺序、紧跟当前）；
      // ack 失败（如房主不在线）直接提示，申请结果另经 control-response 回执
      for (const r of [...fresh].reverse()) {
        const payload = await biliRecToUpsertItem(r)
        currentSocket.emit(
          'music:control-request',
          {
            roomId: currentRoomId,
            action: 'addQueue' as const,
            item: payload,
            afterCurrent: true,
          },
          (res: { success?: boolean; message?: string }) => {
            if (res && res.success === false) {
              message.error(res.message || t('推荐歌曲申请失败'))
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
      // 单曲循环：回到开头重播（后台场景 play 可能被拒，走重试）
      try {
        audio.currentTime = 0
      } catch {
        // ignore
      }
      playAudioWithRetry(audio)
      if (isHostRef.current) {
        broadcastSyncState({ positionSec: 0, isPlaying: true })
      }
      return
    }
    if (tryFmContinue()) return
    if (playMode === 'order') {
      // 按顺序播放：顺序推进，末尾不回绕。队列末尾自动触发 B站 推荐
      // 续播——与手动点「下一首」同一管线（biliAutoContinue 开启时拉
      // 3 首相关推荐入队并续播第一条）；无推荐（非 B站 条目 / 未开
      // 自动连播）时维持原末尾语义：自然停止。
      // 单曲队列特例：computeTargetSong('next') 对唯一曲目返回自身重播
      //（switchSong 视为成功），末尾判定须先于 switchSong 拦下走推荐，
      // 无推荐时回落重播当前曲目（保持原行为）
      const state = useMusicStore.getState()
      const active = activeQueueOf(state)
      const singleSelf =
        state.currentKey != null &&
        active.length === 1 &&
        musicItemKey(active[0]) === state.currentKey
      if (singleSelf) {
        if (!tryBiliContinueOnNext()) switchSong('next')
        return
      }
      if (!switchSong('next')) {
        tryBiliContinueOnNext()
      }
      return
    }
    // 顺序循环 / 随机：切换下一首（各自按规则循环/重洗）
    switchSong('next')
  }, [
    getAudio,
    switchSong,
    broadcastSyncState,
    tryBiliContinueOnNext,
    tryFmContinue,
  ])

  // 同步 ended 处理器的最新实现（handleEnded 随 switchSong 依赖重建）
  useEffect(() => {
    endedHandlerRef.current = () => handleEnded()
  }, [handleEnded])

  // 房主心跳：每 2s 广播当前 MusicSyncState（附 clientTs）。观众端不再直接
  // 消费该心跳（Step2）：它由服务器合并进基线（写侧补偿 + 10s 节流落盘），
  // 供服务器每 2s 外推广播 music:sync-heartbeat(source='server')——观众进度的
  // 唯一权威路径；旧转发保留供旧前端兼容与新前端失联 fallback。
  // 后台标签页的 timer 会被浏览器节流导致心跳停发：回前台时立即补发一次，
  // 加速服务器基线收敛（观众端进度此时由服务器外推持续兜底）
  useEffect(() => {
    if (!socket || !roomId || !isHost) return
    const emitHeartbeat = () => {
      const payload = buildSyncPayload()
      socket.emit(MUSIC_EVENT.HOST_HEARTBEAT, {
        roomId,
        clientTs: Date.now(),
        ...payload,
      })
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

  // 观众：服务器心跳消费（Step2，进度唯一权威路径）。
  // state.positionSec 已由服务器按权威时间轴外推到「当前时刻」，直接应用
  // 不再做本地时钟补偿（compensatePositionSec 的跨设备钟差隐患由此消除）。
  // hostOffline（自主控制模式）期间整条忽略，避免拉回观众自主操作；
  // lastServerHeartbeatAtRef 供房主心跳 fallback 判定（防双通道重复处理）
  useEffect(() => {
    if (!socket || !roomId || isHost) return
    const handleServerHeartbeat = (payload: MusicSyncHeartbeatPayload) => {
      if (!payload || payload.source !== 'server' || !payload.state) return
      // 防御：仅接受当前房间的事件（切换房间时旧事件残留）
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      lastServerHeartbeatAtRef.current = Date.now()
      // 持续校正房主离线标记（必须在 hostOffline 早退守卫之前执行）：
      // 服务器心跳恒定广播，携带的 hostOnline 覆盖「观众在房主离线后才加入/
      // 刷新/socket 重连而错过 host-disconnected 事件」的场景——否则观众误
      // 以为房主在线，暂停按钮走「向房主申请」死路且心跳拉回播放（无法暂停
      // bug）。恢复跟随时不做提示（与 sharer-ready 路径一致由提示条承接）。
      const store = useMusicStore.getState()
      if (payload.hostOnline === false && !store.hostOffline) {
        store.setHostOffline(true)
        store.setSyncNotice(t('房主已断开连接，可自主控制播放'))
      } else if (payload.hostOnline === true && store.hostOffline) {
        useMusicStore.getState().setHostOffline(false)
      }
      if (useMusicStore.getState().hostOffline) return
      applyViewerSync(payload.state, { compensate: false })
    }
    socket.on(MUSIC_EVENT.SYNC_HEARTBEAT, handleServerHeartbeat)
    return () => {
      socket.off(MUSIC_EVENT.SYNC_HEARTBEAT, handleServerHeartbeat)
    }
  }, [socket, roomId, isHost, applyViewerSync])

  // 观众：CHECK_STATUS 主动自检（Step3）。每 10s 上报本地播放状态，服务器
  // 与权威推算状态比对（±10s 容差），分歧超限经 ack 下发权威状态——作为
  // 服务器心跳丢失（socket 重连窗口/网络抖动）时的自愈通道；正常情况下
  // 自检不触发纠偏（容差远大于主路径 2s 对齐阈值）
  useEffect(() => {
    if (!socket || !roomId || isHost) return
    let checkInFlight = false
    const timer = setInterval(() => {
      // 守卫：上一查在途 / 断连 / 自主控制 / 音频未就绪 / seek 进行中
      if (checkInFlight) return
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId) return
      if (useMusicStore.getState().hostOffline) return
      const audio = audioRef.current
      if (!audio || !audio.currentSrc || audio.seeking) return
      // 本地 B站 插播试听中：不参与自检（与 applyViewerSync 的保护一致）
      const store = useMusicStore.getState()
      const localBiliItemKey =
        store.biliItem != null ? musicItemKey(store.biliItem) : null
      if (
        store.currentKey?.startsWith('bili:') === true &&
        store.currentKey === localBiliItemKey
      ) {
        return
      }

      checkInFlight = true
      currentSocket.emit(
        MUSIC_EVENT.CHECK_STATUS,
        {
          roomId: currentRoomId,
          positionSec: audio.currentTime,
          isPlaying: !audio.paused,
          clientTs: Date.now(),
        },
        (response: {
          success?: boolean
          data?: MusicCheckStatusAckData | null
        }) => {
          checkInFlight = false
          if (!response?.success || !response.data?.needsSync) return
          const state = response.data.state
          if (!state) return
          // ack 等待期间可能进入自主控制，应用前再校验一次
          if (useMusicStore.getState().hostOffline) return
          applyViewerSync(state, { compensate: false })
        }
      )
    }, MUSIC_CHECK_STATUS_INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [socket, roomId, isHost, applyViewerSync, audioRef])

  // 观众：房主离线判定改由服务器事件驱动（服务器心跳恒定后，观众无法再靠
  // 房主心跳超时判离线）。host-disconnected（房主断连，服务器广播）→ 置
  // hostOffline 进入自主控制（canControl = isHost || hostOffline）；sharer-ready
  // （房主重连就绪）→ 恢复跟随。「房主已离线后观众才加入」的场景由 get-state
  // ack 的 hostOnline 字段兜底（见下方 get-state effect）
  useEffect(() => {
    if (!socket || !roomId || isHost) return
    const handleHostDisconnected = () => {
      const store = useMusicStore.getState()
      if (!store.hostOffline) {
        store.setHostOffline(true)
        store.setSyncNotice(t('房主已断开连接，可自主控制播放'))
      }
    }
    const handleSharerReady = () => {
      const store = useMusicStore.getState()
      if (store.hostOffline) {
        store.setHostOffline(false)
        store.setSyncNotice(t('房主已恢复，继续跟随播放'))
      }
    }
    socket.on(MUSIC_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
    socket.on(MUSIC_EVENT.SHARER_READY, handleSharerReady)
    return () => {
      socket.off(MUSIC_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
      socket.off(MUSIC_EVENT.SHARER_READY, handleSharerReady)
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
            resetShuffle()
          }
          // 观众：服务器上报房主在线状态（false = 房主已离线后加入，直接进入
          // 自主控制；缺省 = 旧后端，维持原行为）。房主自身不需要该标记
          if (!isHostRef.current && res.hostOnline === false) {
            const store = useMusicStore.getState()
            if (!store.hostOffline) {
              store.setHostOffline(true)
              store.setSyncNotice(t('房主不在线，可自主控制播放'))
            }
          } else if (!isHostRef.current && res.hostOnline === true) {
            if (useMusicStore.getState().hostOffline) {
              useMusicStore.getState().setHostOffline(false)
            }
          }
          if (res.syncState) {
            // 按同步状态恢复本地播放（换曲加载/播放状态/进度/播放模式）。
            // syncState 已是服务器推算的权威状态（updatedAt 为服务器时间），
            // 直接使用不再本地补偿
            applyViewerSync(res.syncState, { compensate: false })
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
  }, [socket, roomId, applyViewerSync, resetShuffle])

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

    // 观众：房主心跳（仅作 fallback——服务器心跳失联超过 SERVER_HEARTBEAT_STALE_MS
    // 时才消费，兼容旧后端未广播 music:sync-heartbeat 的窗口；正常情况下
    // 服务器心跳每 2s 到达，双通道并存会导致同一状态被重复处理）。
    // hostOffline 恢复不再依赖心跳（改由 sharer-ready / get-state hostOnline
    // 驱动），此处保留恢复逻辑兼容旧后端（无 sharer-ready 变更的场景）
    const handleHostHeartbeat = (
      payload: MusicSyncState & { roomId?: string }
    ) => {
      if (!payload || isHostRef.current) return
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      const serverHeartbeatFresh =
        Date.now() - lastServerHeartbeatAtRef.current <=
        SERVER_HEARTBEAT_STALE_MS
      if (serverHeartbeatFresh) return
      const store = useMusicStore.getState()
      if (store.hostOffline) {
        store.setHostOffline(false)
      }
      applyViewerSync(payload, { compensate: true })
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
      resetShuffle()
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
        const who = payload.username || t('观众')
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
      const who = payload.username || t('观众')
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
          message.success(t('歌曲已加入播放列表'))
        } else {
          message.error(t('无权限：房主未开启「自动通过」，无法添加到播放列表'))
        }
        useMusicStore
          .getState()
          .setSyncNotice(
            payload.approved
              ? t('歌曲已加入播放列表')
              : t('添加到播放列表被拒绝')
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
              ? t('房主已同意调节播放进度')
              : t('房主已拒绝调节播放进度')
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
      useMusicStore.getState().pushSyncAck(payload.username || t('观众'))
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
    resetShuffle,
  ])

  // 卸载/离开：释放音频资源、清理内部状态
  //（store 不在此重置，由 Task 6 的离开房间流程统一调用 reset）
  useEffect(() => {
    return () => {
      cancelFmRetry()
      usePersonalFmStore.getState().reset()
      dispose()
      resetShuffle()
      pendingControlRef.current = null
    }
  }, [dispose, resetShuffle, cancelFmRetry])

  // 房间关闭 / 断连媒体停止（RoomPage 收到 room-closed / disconnect 后
  // dispatch，见 lib/mediaTeardown）：音频与预加载元素都走后端代理，
  // 房间关闭后若继续播放会令服务端持续代理上游音频流量，必须立即停流。
  // full=false（断线）仅暂停，保留 src，重连后由同步流程恢复。
  useEffect(() => {
    const handleTeardown = (e: Event) => {
      const detail = (e as CustomEvent<RoomMediaTeardownDetail>).detail
      const full = detail?.full ?? true
      fmPlayRequestRef.current++
      cancelFmRetry()
      usePersonalFmStore.getState().deactivate()
      stopAll(full)
    }
    window.addEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
    return () =>
      window.removeEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
  }, [stopAll, cancelFmRetry])

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
    playFmSong,
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
