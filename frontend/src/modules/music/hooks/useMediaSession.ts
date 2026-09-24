/**
 * Media Session 接入：把「一起听」播放状态映射到系统媒体控件——
 * Android 通知栏/媒体面板、iOS 控制中心/锁屏播放器、桌面媒体键。
 * 手机端播放时歌曲（封面/歌名/歌手）出现在系统状态栏，锁屏/后台
 * 可直接 播放/暂停/上下曲/拖进度。
 *
 * - metadata：曲名/歌手/专辑/封面。B站 封面在入队时已统一代理化
 *   （store setQueue 兜底），代理 URL 与网易云直链均可直接作 artwork；
 *   相对路径经 new URL 解析为绝对地址（MediaSession 拉取 artwork 无页面
 *   上下文，相对路径会解析失败）
 * - 动作：play/pause/previoustrack/nexttrack/seekto/seekbackward/
 *   seekforward/stop → 拥有直接控制权（房主/房主离线）时操作本地引擎；
 *   观众走 requestControl 申请流程（与页面按钮同语义，房主端弹审批）
 * - playbackState / setPositionState：isPlaying 镜像 + 1Hz 轮询 audio
 *   元素读取实时进度——预载升格会替换元素实例（useListenTogether
 *   getAudio），轮询天然跟随最新元素，不依赖事件绑定；1Hz 足够锁屏
 *   进度条平滑（系统会按 playbackRate 自行走针）
 *
 * 后台播放本身无需额外代码：<audio> 媒体元素在页面后台/锁屏期间由
 * 浏览器继续拉流出声（Android Chrome / iOS Safari 均如此，不受 JS
 * 定时器节流影响——节流只影响心跳等 JS 逻辑，见 useListenTogether
 * 心跳注释），本 hook 提供的正是后台场景下系统栏的控制与展示入口。
 */
import { useEffect } from 'react'
import { useMusicPlayer } from './useMusicPlayer'

/** 浏览器是否支持 Media Session（不支持的桌面/旧环境整体静默跳过） */
function isMediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
}

/** 封面 URL → MediaSession artwork（空封面返回空数组；相对地址转绝对） */
function toArtwork(cover: string | undefined): MediaImage[] {
  if (!cover) return []
  try {
    return [{ src: new URL(cover, window.location.href).href }]
  } catch {
    return []
  }
}

/**
 * 同步播放状态到系统媒体控件。挂在 MusicPlayerProvider 内的常驻壳层
 * （MusicAppShell ShellInner）——provider 实例唯一（外层复用或自建），
 * 不会重复注册动作处理器。
 */
export function useMediaSessionSync(): void {
  const {
    isPlaying,
    currentSong,
    canControl,
    togglePlay,
    next,
    prev,
    seek,
    requestControl,
    getAudio,
  } = useMusicPlayer()

  // ===== 元数据：曲名/歌手/专辑/封面（换曲即更新系统栏展示） =====
  // isPlaying 也作为依赖：部分实现只在「播放开始」时刻采用/刷新当前
  // metadata，换曲先于播放发生时仅靠 currentSong 依赖可能不生效——
  // 播放开始时幂等重设一次兜底（对象重建开销可忽略）
  useEffect(() => {
    if (!isMediaSessionSupported() || typeof MediaMetadata !== 'function') {
      return
    }
    if (!currentSong) {
      navigator.mediaSession.metadata = null
      return
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.name,
      artist: currentSong.artist || undefined,
      album: currentSong.album || undefined,
      artwork: toArtwork(currentSong.cover),
    })
  }, [currentSong, isPlaying])

  // ===== 播放状态镜像（系统栏播放/暂停图标跟随） =====
  useEffect(() => {
    if (!isMediaSessionSupported()) return
    navigator.mediaSession.playbackState = currentSong
      ? isPlaying
        ? 'playing'
        : 'paused'
      : 'none'
  }, [isPlaying, currentSong])

  // ===== 系统栏控制动作：有直接控制权走本地引擎，观众走申请流程 =====
  useEffect(() => {
    if (!isMediaSessionSupported()) return
    const { mediaSession } = navigator

    /** 播放：仅暂停态生效（通知栏 play 按钮只在暂停时出现，防御性判定） */
    const handlePlay = () => {
      if (!canControl) {
        requestControl('play')
        return
      }
      const audio = getAudio()
      if (audio?.paused) togglePlay()
    }
    /** 暂停：仅播放态生效（语义同上） */
    const handlePause = () => {
      if (!canControl) {
        requestControl('pause')
        return
      }
      const audio = getAudio()
      if (audio && !audio.paused) togglePlay()
    }
    /** 快进/快退（秒）：锁屏面板的 ±10s 按钮 */
    const handleSeekBy = (offsetSec: number) => {
      if (offsetSec <= 0) return
      const audio = getAudio()
      const base = audio ? audio.currentTime : 0
      const target = Math.max(0, base + offsetSec)
      if (canControl) {
        seek(target)
      } else {
        requestControl('seek', target)
      }
    }

    /** setActionHandler 对不支持的 action 会抛 NotSupportedError，逐个兜住 */
    const setHandler = (
      action: MediaSessionAction,
      handler: (details: MediaSessionActionDetails) => void
    ) => {
      try {
        mediaSession.setActionHandler(action, handler)
      } catch {
        // 该 action 当前环境不支持，静默跳过
      }
    }

    setHandler('play', handlePlay)
    setHandler('pause', handlePause)
    setHandler('previoustrack', () => {
      if (!canControl) {
        requestControl('prev')
        return
      }
      prev()
    })
    setHandler('nexttrack', () => {
      if (!canControl) {
        requestControl('next')
        return
      }
      next()
    })
    setHandler('seekto', (details) => {
      if (details.seekTime == null) return
      if (canControl) {
        seek(details.seekTime)
      } else {
        requestControl('seek', details.seekTime)
      }
    })
    setHandler('seekbackward', (details) =>
      handleSeekBy(-(details.seekOffset ?? 10))
    )
    setHandler('seekforward', (details) =>
      handleSeekBy(details.seekOffset ?? 10)
    )
    setHandler('stop', handlePause)

    return () => {
      // 依赖变化/卸载时清空处理器，避免悬挂闭包引用旧引擎实例
      for (const action of [
        'play',
        'pause',
        'previoustrack',
        'nexttrack',
        'seekto',
        'seekbackward',
        'seekforward',
        'stop',
      ] as MediaSessionAction[]) {
        try {
          mediaSession.setActionHandler(action, null)
        } catch {
          // ignore
        }
      }
    }
  }, [canControl, togglePlay, next, prev, seek, requestControl, getAudio])

  // ===== 锁屏进度条：isPlaying 期间 1Hz 轮询元素回传位置状态 =====
  useEffect(() => {
    if (!isMediaSessionSupported()) return
    if (!isPlaying) return
    const update = () => {
      const audio = getAudio()
      if (!audio) return
      const duration = audio.duration
      // 无时长（未加载完/直播流）不回传，系统隐藏进度条
      if (!Number.isFinite(duration) || duration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(Math.max(audio.currentTime, 0), duration),
        })
      } catch {
        // 部分实现对 position > duration 等非法值抛错，静默跳过
      }
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [isPlaying, currentSong, getAudio])

  // ===== 卸载（离开音乐模块）：清空系统栏展示，避免残留上一会话的曲目 =====
  useEffect(() => {
    if (!isMediaSessionSupported()) return
    const { mediaSession } = navigator
    return () => {
      mediaSession.metadata = null
      mediaSession.playbackState = 'none'
    }
  }, [])
}
