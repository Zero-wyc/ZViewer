import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useShallow } from 'zustand/react/shallow'
import { getApiUrl } from '@/lib/api'
import { appendAuthToken } from '@/modules/player/services/url-proxy'
import { message } from '@/components/ui/message'
import { useMusicStore, musicItemKey, parseMusicKey } from '../store'
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

/** 观众判定房主离线的心跳超时（毫秒） */
const HOST_OFFLINE_TIMEOUT_MS = 5000

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
 * 地址格式：`?songId=<id>&level=exhigh`
 */
function buildStreamUrl(
  item: MusicQueueItem,
  roomId: string | undefined
): string {
  const roomParam = roomId ? `&roomId=${encodeURIComponent(roomId)}` : ''
  const level = normalizeMusicLevel(
    useMusicSettingsStore.getState().level || FALLBACK_STREAM_LEVEL
  )
  return appendAuthToken(
    `${getApiUrl()}/api/music/stream?songId=${item.songId}&level=${level}${roomParam}`
  )
}

/** 从房主广播的同步状态解析曲目 key */
function syncKeyOf(payload: MusicSyncState): string | null {
  return payload.trackSongId != null ? `ncm:${payload.trackSongId}` : null
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
  /** 观众：向房主申请控制（暂停/继续/切歌） */
  requestControl: (action: MusicControlRequest['action']) => void
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
  /** 设置提示文字（null 清除） */
  setSyncNotice: (notice: string | null) => void
  /** 本地播放音量（0-1，仅本地生效不参与房间同步） */
  volume: number
  /** 设置本地播放音量（0-1，持久化到 localStorage；0 视为静音） */
  setVolume: (volume: number) => void
  /** 当前主音频元素（惰性创建；预载升格时会被替换，可视化消费方需感知） */
  getAudio: () => HTMLAudioElement | null
}

/**
 * 一起听核心 Hook：音频播放引擎 + 房主/观众同步。
 *
 * 结构对齐 useWatchTogether（socket 事件注册、房主/观众分支、
 * 心跳、申请制、房主离线判定 hostOffline → canControl），但大幅简化：
 * - 音频元素惰性创建（useRef 持有，不挂 DOM），src 走 /api/music/stream 代理
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
    setSyncNotice,
  } = useMusicStore(
    useShallow((s) => ({
      queue: s.queue,
      currentKey: s.currentKey,
      playMode: s.playMode,
      hostOffline: s.hostOffline,
      syncNotice: s.syncNotice,
      setSyncNotice: s.setSyncNotice,
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

  /** 惰性获取 audio 元素（首次使用时创建，不挂 DOM；创建时应用持久化音量） */
  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.muted = volumeRef.current === 0
      audio.volume = volumeRef.current
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
      trackSongId: parsed ? parsed.songId : null,
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
        payload.trackSongId = parsed ? parsed.songId : null
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
    const { queue, currentKey } = useMusicStore.getState()
    const queueKeys = queue.map((item) => musicItemKey(item))
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
      const { queue, currentKey, playMode } = useMusicStore.getState()
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
    const { queue, currentKey, playMode } = useMusicStore.getState()
    if (queue.length === 0) return null
    if (playMode === 'repeat-one') return null
    if (playMode !== 'shuffle') {
      const keys = queue.map((item) => musicItemKey(item))
      if (keys.length === 1) return queue[0]
      const idx = currentKey == null ? -1 : keys.indexOf(currentKey)
      if (idx === -1) return queue[0]
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
      // 流加载失败（无版权/纯 VIP 未登录/解析失败等后端结构化错误）
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

  /** 复位指定音频元素：停止并释放已缓冲的流资源（Hydrogen unload 等价） */
  const resetAudioElement = useCallback((el: HTMLAudioElement) => {
    el.pause()
    el.removeAttribute('src')
    try {
      // 空源 load()：中止当前加载并释放缓冲（MDN 推荐的资源释放方式）
      el.load()
    } catch {
      // ignore
    }
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
  const loadAndPlaySong = useCallback(
    (item: MusicQueueItem, positionSec: number, shouldPlay: boolean) => {
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
        // 2) 停止旧播放（事件已摘除，不会误镜像暂停状态）
        audio.pause()
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

  /** 切歌核心：按播放模式计算目标并加载播放；房主额外广播同步状态 */
  const switchSong = useCallback(
    (direction: 'next' | 'prev') => {
      const target = computeTargetSong(direction)
      if (!target) return
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
    },
    [computeTargetSong, loadAndPlaySong, broadcastSyncState]
  )

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

  /** 下一首（按播放模式计算目标） */
  const next = useCallback(() => {
    if (!hasControl()) return
    switchSong('next')
  }, [switchSong, hasControl])

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

  /** 观众：向房主申请控制（房主在线且自己无直接控制权时） */
  const requestControl = useCallback(
    (action: MusicControlRequest['action']) => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId) return
      // 房主或房主离线时拥有直接控制权，无需申请
      if (hasControl()) return
      currentSocket.emit(MUSIC_EVENT.CONTROL_REQUEST, {
        roomId: currentRoomId,
        action,
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
    (action: MusicControlRequest['action']) => {
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
          switchSong('next')
          break
        case 'prev':
          switchSong('prev')
          break
      }
    },
    [getAudio, switchSong, broadcastSyncState]
  )

  /**
   * 观众：执行审批通过的动作（本地操作）。
   * 随机模式下观众本地洗牌序列可能与房主不一致，
   * 房主随后广播的 sync-state 会以权威 trackSongId 校正。
   */
  const executeLocalAction = useCallback(
    (action: MusicControlRequest['action']) => {
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
    executeHostAction(request.action)
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
      const trackKey = syncKeyOf(payload)

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
        loadAndPlaySong(item, payload.positionSec, payload.isPlaying)
        if (store.playMode !== payload.playMode) {
          store.setPlayMode(payload.playMode)
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
        Math.abs(audio.currentTime - payload.positionSec) >
        SYNC_ALIGN_THRESHOLD_SEC
      ) {
        try {
          audio.currentTime = payload.positionSec
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
    // 顺序循环 / 随机：切换下一首
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

  // 房主心跳：每 2s 广播当前 MusicSyncState（观众据此对齐进度并判定房主在线）
  useEffect(() => {
    if (!socket || !roomId || !isHost) return
    const timer = setInterval(() => {
      const payload = buildSyncPayload()
      socket.emit(MUSIC_EVENT.HOST_HEARTBEAT, { roomId, ...payload })
    }, HOST_HEARTBEAT_INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [socket, roomId, isHost, buildSyncPayload])

  // 观众：房主离线判定——超时未收到心跳置 hostOffline，收到即恢复（见事件监听）
  useEffect(() => {
    if (!socket || !roomId || isHost) return
    // 加入时重置计时，给予首个心跳的宽限期
    lastHeartbeatAtRef.current = Date.now()
    const timer = setInterval(() => {
      if (
        Date.now() - lastHeartbeatAtRef.current > HOST_OFFLINE_TIMEOUT_MS &&
        !useMusicStore.getState().hostOffline
      ) {
        useMusicStore.getState().setHostOffline(true)
      }
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [socket, roomId, isHost])

  // 加入房间时查询初始状态：队列 + 服务端缓存的最新同步状态。
  // 观众据此立即对齐当前播放；房主断线重连后据此恢复自己的播放进度
  //（服务端缓存的就是房主最后广播的状态）。
  useEffect(() => {
    if (!socket || !roomId) return
    socket.emit(MUSIC_EVENT.GET_STATE, { roomId }, (res: GetStateResponse) => {
      if (!res?.success) return
      if (Array.isArray(res.queue)) {
        useMusicStore.getState().setQueue(res.queue)
        // 队列变化使洗牌序列失效：标记待重建
        shuffleListRef.current = null
      }
      if (res.syncState) {
        // 按同步状态恢复本地播放（换曲加载/播放状态/进度/播放模式）
        applyViewerSync(res.syncState)
      }
    })
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
      useMusicStore.getState().setQueue(payload.items)
      // 队列变化使洗牌序列失效：标记待重建（下次随机切歌时惰性重建）
      shuffleListRef.current = null
    }

    // 房主：观众控制申请 → 播放器左上角提示 + 待审批
    const handleControlRequest = (
      payload: MusicControlRequest & { roomId?: string }
    ) => {
      if (!payload || !isHostRef.current) return
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      const action = payload.action
      if (
        action !== 'pause' &&
        action !== 'play' &&
        action !== 'next' &&
        action !== 'prev'
      ) {
        return
      }
      if (!payload.from) return
      pendingControlRef.current = {
        action,
        from: payload.from,
        username: payload.username,
      }
      const who = payload.username || '观众'
      useMusicStore
        .getState()
        .setSyncNotice(`${who} 申请${CONTROL_ACTION_TEXT[action]}`)
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
        action !== 'prev'
      ) {
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

    socket.on(MUSIC_EVENT.SYNC_STATE, handleSyncState)
    socket.on(MUSIC_EVENT.HOST_HEARTBEAT, handleHostHeartbeat)
    socket.on(MUSIC_EVENT.QUEUE_CHANGED, handleQueueChanged)
    socket.on(MUSIC_EVENT.CONTROL_REQUEST, handleControlRequest)
    socket.on(MUSIC_EVENT.CONTROL_RESPONSE, handleControlResponse)

    return () => {
      socket.off(MUSIC_EVENT.SYNC_STATE, handleSyncState)
      socket.off(MUSIC_EVENT.HOST_HEARTBEAT, handleHostHeartbeat)
      socket.off(MUSIC_EVENT.QUEUE_CHANGED, handleQueueChanged)
      socket.off(MUSIC_EVENT.CONTROL_REQUEST, handleControlRequest)
      socket.off(MUSIC_EVENT.CONTROL_RESPONSE, handleControlResponse)
    }
  }, [socket, roomId, applyViewerSync, executeLocalAction])

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
      }
      audioRef.current = null
      pendingSeekRef.current = 0
      shuffleListRef.current = null
      shufflePosRef.current = -1
      pendingControlRef.current = null
    }
  }, [])

  // 当前播放的队列条目（queue + currentKey 匹配）
  const currentSong = useMemo(() => {
    if (currentKey == null) return null
    return queue.find((item) => musicItemKey(item) === currentKey) ?? null
  }, [queue, currentKey])

  /** 是否拥有直接控制权（房主或房主离线时的观众，按钮 label 由 UI 层处理） */
  const canControl = isHost || hostOffline

  return {
    togglePlay,
    next,
    prev,
    seek,
    setPlayMode,
    playSong,
    requestControl,
    approveControl,
    rejectControl,
    currentSong,
    canControl,
    hostOffline,
    syncNotice,
    setSyncNotice,
    volume,
    setVolume,
    getAudio,
  }
}
