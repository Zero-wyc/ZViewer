/**
 * LiveArtPlayer —— 直播 / WebRTC 场景的 ArtPlayer 统一封装。
 *
 * 适用场景：
 * - WebRTC 远程流观看（RemoteVideoPlayer / DirectWatchPage）：父组件通过
 *   onVideoReady 拿到 art.video 后自行绑定 srcObject
 * - 本地采集预览（DirectSharePage / SharePage）：同上
 * - HTTP-FLV 直播由 FlvPlayer 单独封装（带重试与统计），不经过本组件
 *
 * isLive 模式下 ArtPlayer 自动隐藏进度条与时间显示，仅保留播放/音量/全屏。
 */
import { useEffect, useRef } from 'react'
import { useArtPlayer } from './useArtPlayer'
import { cn } from '@/lib/utils'
import './art-overrides.css'

export interface LiveArtPlayerProps {
  className?: string
  /** 暴露底层 video 元素（挂载时回调，卸载时回调 null） */
  onVideoReady?: (video: HTMLVideoElement | null) => void
  /** 初始静音（默认 true，规避浏览器自动播放限制） */
  muted?: boolean
  /**
   * 静音交由外部托管。
   *
   * 观众端用 `ViewerAudio` 统一管理「静音 + 增益」：增益模式下它会把
   * `video.muted` 强置为 true（出声改走 GainNode），此时播放器再按 React
   * 的 `muted` 回写元素，同一路声音就会播两次。为 true 时本组件只在挂载时
   * 应用一次初始值，之后不再改写。
   */
  managedMuted?: boolean
  /** 是否显示控制栏（本地预览场景可传 false 完全隐藏） */
  showControls?: boolean
}

export function LiveArtPlayer({
  className,
  onVideoReady,
  muted = true,
  managedMuted = false,
  showControls = true,
}: LiveArtPlayerProps): JSX.Element {
  const onVideoReadyRef = useRef(onVideoReady)
  useEffect(() => {
    onVideoReadyRef.current = onVideoReady
  }, [onVideoReady])

  const { containerRef, art, video } = useArtPlayer((container) => ({
    container,
    url: '',
    lang: 'zh-cn',
    isLive: true,
    muted,
    autoplay: true,
    // 禁用单击视频区域暂停：共享画面通过控制栏按钮控制
    click: false,
    hotkey: false,
    pip: false,
    screenshot: false,
    setting: false,
    loop: false,
    flip: false,
    playbackRate: false,
    aspectRatio: false,
    fullscreen: showControls,
    fullscreenWeb: false,
    subtitleOffset: false,
    miniProgressBar: false,
    airplay: false,
    mutex: true,
    backdrop: true,
    playsInline: true,
    moreVideoAttr: {
      playsInline: true,
      autoplay: true,
      muted,
    },
  }))

  // 空 url 初始化会让 ArtPlayer 一直显示 loading，延迟隐藏
  useEffect(() => {
    if (!art) return
    const timer = setTimeout(() => {
      art.loading.show = false
    }, 100)
    return () => clearTimeout(timer)
  }, [art])

  // 控制栏整体显隐
  // React Compiler 误报：直接操作 ArtPlayer 内部 DOM 是必要行为。
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    if (!art) return
    if (!showControls) {
      art.template.$bottom.style.display = 'none'
    } else {
      art.template.$bottom.style.display = ''
    }
  }, [art, showControls])

  // 暴露 video 元素给父组件（绑定 srcObject / 统计等）
  useEffect(() => {
    if (!video) return
    onVideoReadyRef.current?.(video)
    return () => {
      onVideoReadyRef.current?.(null)
    }
  }, [video])

  // ── 阻止点击视频画面暂停/播放：由控制栏按钮控制 ──────────
  // ArtPlayer 的 click:false 可能不完全阻止点击暂停，
  // 在 capture 阶段拦截 click/dblclick 确保 video 点击不触发任何操作
  useEffect(() => {
    if (!video) return
    const blockVideoClick = (e: Event) => {
      if (e.target === video) {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
    video.addEventListener('click', blockVideoClick, true)
    video.addEventListener('dblclick', blockVideoClick, true)
    return () => {
      video.removeEventListener('click', blockVideoClick, true)
      video.removeEventListener('dblclick', blockVideoClick, true)
    }
  }, [video])

  // muted 变更同步（托管模式下由 ViewerAudio 独占，见 managedMuted 注释）
  useEffect(() => {
    if (managedMuted) return
    if (video) {
      video.muted = muted
    }
  }, [video, muted, managedMuted])
  /* eslint-enable react-hooks/immutability */

  return (
    <div className={cn('zart-stage', className)}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

export default LiveArtPlayer
