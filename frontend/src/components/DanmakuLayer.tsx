import {
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from 'react'
import type { Socket } from 'socket.io-client'
import type { BilibiliDanmakuItem } from '@/modules/room/watch-together/danmakuEngine'
import {
  DanmakuEngineAdapter,
  type SendDanmakuOptions,
} from '@/modules/room/watch-together/danmakuEngine'
import type {
  DanmakuAdvancedStyle,
  DanmakuTypeFilters,
} from '@/store/danmakuStore'

/**
 * DanmakuLayer 命令式 API。
 *
 * 通过 forwardRef + useImperativeHandle 暴露给父组件，
 * 用于发送弹幕、加载时间轴、清空、跳转、同步时间等操作。
 */
export interface DanmakuLayerHandle {
  /** 立即发送一条弹幕到舞台 */
  sendDanmaku: (text: string, options?: SendDanmakuOptions) => void
  /** 批量加载时间轴弹幕（B站格式，内部转换为 danmaku.js comment 格式并过滤） */
  loadTimelineDanmaku: (danmakuList: BilibiliDanmakuItem[]) => void
  /** 加载一条弹幕轨道 */
  loadDanmakuTrack: (
    trackId: string,
    danmakuList: BilibiliDanmakuItem[],
    offset?: number
  ) => void
  /** 移除一条弹幕轨道 */
  removeDanmakuTrack: (trackId: string) => void
  /** 更新轨道时间偏移 */
  updateTrackOffset: (trackId: string, offset: number) => void
  /** 清空当前舞台上的所有弹幕 */
  clear: () => void
  /** 跳转时间轴（单位：秒，与 video.currentTime 一致） */
  seek: (time: number) => void
  /** 同步当前时间（单位：秒，与 video.currentTime 一致） */
  syncTime: (time: number) => void
  /**
   * @deprecated 旧版本兼容：通过 B站 弹幕项发送弹幕。
   * 内部转换为 sendDanmaku 调用。
   */
  addDanmaku: (item: BilibiliDanmakuItem) => void
}

export interface DanmakuLayerProps {
  /** 视频元素，传入后会自动跟随 video 时间轴（timeupdate / seeked） */
  videoElement?: HTMLVideoElement | null
  /** 是否启用弹幕（默认 true） */
  enabled?: boolean
  /** 整体透明度 0-1（默认 1） */
  opacity?: number
  /** 显示区域比例 0-1（默认 1，占满整个容器顶部） */
  displayArea?: number
  /** 弹幕密度 0-1（默认 1，全部显示） */
  density?: number
  /** 弹幕运动速度倍率（默认 1） */
  speed?: number
  /** 是否根据容器宽度缩放字号 */
  scaleWithScreen?: boolean
  /** 类型过滤 */
  filters?: DanmakuTypeFilters
  /** 高级样式 */
  advancedStyle?: Partial<DanmakuAdvancedStyle>
  /** 屏蔽关键词列表 */
  blockKeywords?: string[]
  /** 屏蔽的弹幕类型（如 [5] 屏蔽所有顶部弹幕） */
  blockModes?: number[]
  /** 字号（像素），以 25px 为基准缩放 */
  fontSize?: number
  /** 弹幕点击回调。提供后弹幕元素可接收点击事件 */
  onDanmakuClick?: (text: string) => void
  /** @deprecated 旧版本兼容：socket 监听 'danmaku' 事件 */
  socket?: Socket | null
  /** @deprecated 旧版本兼容：速度（不再使用） */
  rawSpeed?: number
}

/**
 * DanmakuLayer —— 基于 danmaku.js 的弹幕层组件。
 *
 * 内部由 `DanmakuEngineAdapter` 驱动：
 * - 容器绝对定位覆盖视频区域，pointer-events: none，z-index 高于视频
 * - 在 useEffect 中创建引擎实例并挂载到容器
 * - 卸载时调用 destroy()
 * - props 变化时调用对应 setter
 * - 传入 videoElement 时自动监听 timeupdate / seeked 事件同步时间轴
 */
export const DanmakuLayer = forwardRef<DanmakuLayerHandle, DanmakuLayerProps>(
  function DanmakuLayer(
    {
      videoElement,
      enabled = true,
      opacity = 1,
      displayArea = 1,
      density = 1,
      speed = 1,
      scaleWithScreen = true,
      filters,
      advancedStyle,
      blockKeywords,
      blockModes,
      fontSize,
      onDanmakuClick,
      socket,
    },
    ref
  ) {
    const stageRef = useRef<HTMLDivElement>(null)
    const engineRef = useRef<DanmakuEngineAdapter | null>(null)
    // 引擎初始化前暂存的实时弹幕队列
    const pendingDanmakuRef = useRef<{ text: string; options?: SendDanmakuOptions }[]>([])
    // 保持最新的 onDanmakuClick 引用，避免重建引擎
    const onDanmakuClickRef = useRef(onDanmakuClick)

    useEffect(() => {
      onDanmakuClickRef.current = onDanmakuClick
    }, [onDanmakuClick])

    /** 发送或暂存一条实时弹幕 */
    const sendOrEnqueue = (text: string, options?: SendDanmakuOptions) => {
      if (engineRef.current) {
        engineRef.current.sendDanmaku(text, options)
      } else {
        pendingDanmakuRef.current.push({ text, options })
      }
    }

    /** 消费暂存队列 */
    const flushPending = () => {
      const pending = pendingDanmakuRef.current
      pendingDanmakuRef.current = []
      pending.forEach(({ text, options }) => {
        engineRef.current?.sendDanmaku(text, options)
      })
    }

    // 创建 danmaku.js 引擎实例并挂载到容器。
    // 使用 ResizeObserver 等待容器获得有效尺寸后再初始化，
    // 避免在 width/height 为 0 时分配空间失败导致弹幕不渲染。
    useEffect(() => {
      const stage = stageRef.current
      if (!stage) return

      let engine: DanmakuEngineAdapter | null = null
      let resizeObserver: ResizeObserver | null = null
      let cancelled = false

      const initEngine = () => {
        if (cancelled || engineRef.current) return
        const rect = stage.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return

        try {
          engine = new DanmakuEngineAdapter(stage, videoElement ?? undefined)
          if (cancelled) {
            engine.destroy()
            return
          }
          engineRef.current = engine
          engine.setEnabled(enabled)
          engine.setOpacity(opacity)
          engine.setDensity(density)
          engine.setSpeed(speed)
          engine.setStyle({
            fontSize,
            blockKeywords,
            blockModes,
            filters,
            advanced: advancedStyle,
            scaleWithScreen,
          })
          // 消费初始化前暂存的实时弹幕
          flushPending()
        } catch (err) {
          console.error('[DanmakuLayer] DanmakuEngineAdapter init failed:', err)
        }
      }

      initEngine()

      // 窗口 resize 或父容器尺寸变化时重新计算舞台尺寸
      resizeObserver = new ResizeObserver(() => {
        if (engineRef.current) {
          engineRef.current.resize()
        } else {
          initEngine()
        }
      })
      resizeObserver.observe(stage)

      return () => {
        cancelled = true
        if (resizeObserver) {
          resizeObserver.disconnect()
          resizeObserver = null
        }
        if (engine) {
          engine.destroy()
          // StrictMode 双挂载：只有当前 ref 仍指向该旧引擎时才清空，
          // 避免覆盖第二次挂载已经创建的新引擎引用。
          if (engineRef.current === engine) {
            engineRef.current = null
          }
        }
      }
      // 仅在挂载时创建一次引擎；后续 props 变化由各 setter 处理
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // enabled 变化
    useEffect(() => {
      engineRef.current?.setEnabled(enabled)
    }, [enabled])

    // opacity 变化
    useEffect(() => {
      engineRef.current?.setOpacity(opacity)
    }, [opacity])

    // density 变化
    useEffect(() => {
      engineRef.current?.setDensity(density)
    }, [density])

    // displayArea 变化：调整舞台高度后触发引擎 resize
    useEffect(() => {
      const stage = stageRef.current
      if (!stage) return
      stage.style.height = `${Math.max(0.25, Math.min(1, displayArea)) * 100}%`
      engineRef.current?.resize()
    }, [displayArea])

    // speed 变化
    useEffect(() => {
      engineRef.current?.setSpeed(speed)
    }, [speed])

    // fontSize / blockKeywords / blockModes / filters / advanced / scaleWithScreen 变化
    useEffect(() => {
      engineRef.current?.setStyle({
        fontSize,
        blockKeywords,
        blockModes,
        filters,
        advanced: advancedStyle,
        scaleWithScreen,
      })
    }, [fontSize, blockKeywords, blockModes, filters, advancedStyle, scaleWithScreen])

    // 视频时间轴同步：timeupdate -> setTime, seeked -> seek
    useEffect(() => {
      if (!videoElement) return
      const handleTimeUpdate = () => {
        engineRef.current?.setTime(videoElement.currentTime)
      }
      const handleSeeked = () => {
        engineRef.current?.seek(videoElement.currentTime)
      }
      videoElement.addEventListener('timeupdate', handleTimeUpdate)
      videoElement.addEventListener('seeked', handleSeeked)
      return () => {
        videoElement.removeEventListener('timeupdate', handleTimeUpdate)
        videoElement.removeEventListener('seeked', handleSeeked)
      }
    }, [videoElement])

    // socket 'danmaku' 事件（旧版本兼容）
    useEffect(() => {
      if (!socket) return
      const handleDanmaku = (payload: { text: string }) => {
        sendOrEnqueue(payload.text)
      }
      socket.on('danmaku', handleDanmaku)
      return () => {
        socket.off('danmaku', handleDanmaku)
      }
    }, [socket])

    // 弹幕点击监听（onDanmakuClick 提供时生效）
    useEffect(() => {
      const stage = stageRef.current
      if (!stage || !onDanmakuClick) return
      const handleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement
        if (!target || target === stage) return
        const text = target.textContent
        if (text && text.trim()) {
          onDanmakuClickRef.current?.(text.trim())
        }
      }
      stage.addEventListener('click', handleClick)
      return () => {
        stage.removeEventListener('click', handleClick)
      }
    }, [onDanmakuClick])

    // 命令式 API
    useImperativeHandle(
      ref,
      () => ({
        sendDanmaku: (text, options) => {
          sendOrEnqueue(text, options)
        },
        loadTimelineDanmaku: (danmakuList) => {
          engineRef.current?.loadTimelineDanmaku(danmakuList)
        },
        loadDanmakuTrack: (trackId, danmakuList, offset) => {
          engineRef.current?.loadDanmakuTrack(trackId, danmakuList, offset)
        },
        removeDanmakuTrack: (trackId) => {
          engineRef.current?.removeDanmakuTrack(trackId)
        },
        updateTrackOffset: (trackId, offset) => {
          engineRef.current?.updateTrackOffset(trackId, offset)
        },
        clear: () => {
          engineRef.current?.clear()
        },
        seek: (time) => {
          engineRef.current?.seek(time)
        },
        syncTime: (time) => {
          engineRef.current?.setTime(time)
        },
        addDanmaku: (item: BilibiliDanmakuItem) => {
          sendOrEnqueue(item.content, {
            color: item.color,
            mode: item.mode,
            size: item.size,
            stime: item.time,
          })
        },
      }),
      []
    )

    return (
      <>
        <div
          ref={stageRef}
          data-danmaku-stage="true"
          className="pointer-events-none absolute left-0 right-0 top-0 z-10 overflow-hidden transition-opacity duration-300"
          style={{
            opacity: enabled ? opacity : 0,
            height: `${Math.max(0.25, Math.min(1, displayArea)) * 100}%`,
            backgroundColor: 'transparent',
          }}
          aria-hidden="true"
        />
        <style>{`
          [data-danmaku-stage] {
            color: #ffffff;
          }
          [data-danmaku-stage] > * {
            color: inherit;
          }
          ${onDanmakuClick ? `[data-danmaku-stage] > * { pointer-events: auto; cursor: pointer; }` : ''}
        `}</style>
      </>
    )
  }
)
