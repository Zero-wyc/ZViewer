import Danmaku from 'danmaku'
import type {
  DanmakuAdvancedStyle,
  DanmakuTypeFilters,
} from '@/store/danmakuStore'
import type { DanmakuItem } from '@/modules/danmaku/types'

type DanmakuComment = {
  text?: string
  mode?: 'ltr' | 'rtl' | 'top' | 'bottom'
  time?: number
  style?: Partial<CSSStyleDeclaration> | CanvasRenderingContext2D
}

export interface SendDanmakuOptions {
  color?: number
  mode?: number
  size?: number
  stime?: number
  /** 发送者名称，提供后弹幕会显示 "发送者: 内容" 并附加颜色线框 */
  sender?: string
}

export interface DanmakuStyleOptions {
  fontSize?: number
  blockKeywords?: string[]
  blockModes?: number[]
  filters?: DanmakuTypeFilters
  advanced?: Partial<DanmakuAdvancedStyle>
  scaleWithScreen?: boolean
}

export interface DanmakuTrackData {
  items: DanmakuItem[]
  offset: number
}

const DEFAULT_FILTERS: DanmakuTypeFilters = {
  scroll: true,
  fixed: true,
  color: true,
  advanced: true,
}

const DEFAULT_ADVANCED: DanmakuAdvancedStyle = {
  fontFamily:
    '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif',
  strokeWidth: 0,
  shadowBlur: 2,
  density: 1,
}

function mapBiliModeToDanmakuJs(mode: number): DanmakuComment['mode'] {
  switch (mode) {
    case 4:
      return 'bottom'
    case 5:
      return 'top'
    case 1:
    case 2:
    case 3:
    case 6:
    default:
      return 'rtl'
  }
}

function decimalColorToHex(color: number): string {
  const c = Math.max(0, Math.min(0xffffff, color))
  return `#${c.toString(16).padStart(6, '0')}`
}

function isBlocked(
  text: string,
  mode: number,
  blockKeywords: string[],
  blockModes: number[]
): boolean {
  if (blockModes.length > 0 && blockModes.includes(mode)) return true
  if (blockKeywords.length === 0 || text.length === 0) return false
  return blockKeywords.some((kw) => kw.length > 0 && text.includes(kw))
}

function isBlockedByType(
  item: DanmakuItem,
  filters: DanmakuTypeFilters
): boolean {
  const isScroll = [1, 2, 3, 6].includes(item.mode)
  const isFixed = [4, 5].includes(item.mode)
  const isAdvanced = [7, 8].includes(item.mode)

  if (!filters.scroll && isScroll) return true
  if (!filters.fixed && isFixed) return true
  if (!filters.advanced && isAdvanced) return true
  if (!filters.color && item.color !== 0xffffff) return true

  return false
}

export class DanmakuEngineAdapter {
  private danmaku: Danmaku | null = null
  private tracks = new Map<string, DanmakuTrackData>()
  private enabled = true
  private opacity = 1
  private densityRatio = 1
  private blockKeywords: string[] = []
  private blockModes: number[] = []
  private baseFontSize = 25
  private emitted = new Set<string>()
  private lastTime = -1
  private container: HTMLElement
  private media?: HTMLVideoElement
  private filters: DanmakuTypeFilters = { ...DEFAULT_FILTERS }
  private advanced: DanmakuAdvancedStyle = { ...DEFAULT_ADVANCED }
  private scaleWithScreen = true
  private containerWidth = 0
  private baseSpeed = 144

  constructor(container: HTMLElement, media?: HTMLVideoElement) {
    this.container = container
    this.media = media
    this.danmaku = new Danmaku({
      container,
      media,
      engine: 'dom',
      speed: this.baseSpeed,
    })

    this.containerWidth = container.offsetWidth
  }

  private getEffectiveFontSize(itemSize?: number): number {
    // 用户设置的 baseFontSize 作为基准（默认 25px）。
    // B站弹幕条目自带 size（如 18/25/36），按 item.size/25 比例缩放，
    // 保留弹幕间相对大小差异的同时让用户字号设置生效。
    // 实时弹幕无 itemSize，直接使用 baseFontSize。
    const BASE_REFERENCE = 25
    const itemRatio = itemSize ? itemSize / BASE_REFERENCE : 1
    let size = this.baseFontSize * itemRatio
    if (this.scaleWithScreen && this.containerWidth > 0) {
      const ratio = Math.min(1.5, Math.max(0.5, this.containerWidth / 1920))
      size *= ratio
    }
    return size
  }

  private getCommentStyle(
    itemColor?: number,
    itemSize?: number
  ): Partial<CSSStyleDeclaration> {
    const size = this.getEffectiveFontSize(itemSize)
    const style: Partial<CSSStyleDeclaration> = {
      fontSize: `${size}px`,
      fontFamily: this.advanced.fontFamily,
      fontWeight: '500',
      whiteSpace: 'nowrap',
    } as Partial<CSSStyleDeclaration>

    if (this.advanced.strokeWidth > 0) {
      style.webkitTextStroke = `${this.advanced.strokeWidth}px rgba(0, 0, 0, 0.8)`
    }

    const shadows: string[] = []
    const blur = Math.max(0, this.advanced.shadowBlur)
    if (blur > 0) {
      shadows.push(`0 1px ${blur}px rgba(0, 0, 0, 0.85)`)
    } else {
      shadows.push('0 1px 2px rgba(0, 0, 0, 0.85)')
    }
    style.textShadow = shadows.join(', ')

    if (itemColor !== undefined) {
      style.color = decimalColorToHex(itemColor)
    }

    return style
  }

  private convertBiliItem(item: DanmakuItem): DanmakuComment {
    const mode = mapBiliModeToDanmakuJs(item.mode)
    return {
      text: item.content,
      mode,
      time: item.time + this.getTrackOffset('default'),
      style: {
        ...this.getCommentStyle(item.color, item.size),
      } as Partial<CSSStyleDeclaration>,
    }
  }

  private getTrackOffset(trackId: string): number {
    return this.tracks.get(trackId)?.offset ?? 0
  }

  sendDanmaku(text: string, options?: SendDanmakuOptions): void {
    if (!this.danmaku || !this.enabled || !text) return
    const mode = options?.mode ?? 1
    if (isBlocked(text, mode, this.blockKeywords, this.blockModes)) return
    if (
      isBlockedByType(
        {
          id: '',
          content: text,
          time: 0,
          mode,
          color: options?.color ?? 0xffffff,
          size: options?.size ?? 25,
        },
        this.filters
      )
    )
      return

    const time = Math.max(0, (this.media?.currentTime ?? 0) - 0.05)
    const sender = options?.sender?.trim()
    const displayText = sender ? `${sender}: ${text}` : text
    const style = this.getCommentStyle(options?.color, options?.size)

    // 提供发送者时附加颜色线框，区分评论区发出的弹幕
    if (sender) {
      style.border = '1px solid rgba(255, 255, 255, 0.7)'
      style.borderRadius = '6px'
      style.padding = '2px 8px'
      style.boxSizing = 'border-box'
    }

    const emitParams = {
      text: displayText,
      mode: mapBiliModeToDanmakuJs(mode),
      time,
      style,
    }
    this.danmaku.emit(emitParams)
  }

  loadTimelineDanmaku(items: DanmakuItem[]): void {
    this.loadDanmakuTrack('default', items, 0)
  }

  loadDanmakuTrack(trackId: string, comments: DanmakuItem[], offset = 0): void {
    this.tracks.set(trackId, {
      items: [...comments].sort((a, b) => a.time - b.time),
      offset,
    })
  }

  removeDanmakuTrack(trackId: string): void {
    this.tracks.delete(trackId)
    // 移除整条轨道后，已通过 emit 加入 danmaku.js comments 数组的弹幕仍会保留，
    // seek/播放到对应时间点时会被重新发射。这里同步清空 emitted 集合并重置
    // danmaku.js 内部状态，确保移除的轨道弹幕不再出现。
    this.resetDanmakuComments()
    this.emitted.clear()
  }

  updateTrackOffset(trackId: string, offset: number): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.offset = offset
    // 偏移变更后允许已发射过的弹幕重新对齐
    for (const key of this.emitted) {
      if (key.startsWith(`${trackId}:`)) {
        this.emitted.delete(key)
      }
    }
  }

  clear(): void {
    this.danmaku?.clear()
    this.resetDanmakuComments()
    this.emitted.clear()
  }

  seek(time: number): void {
    this.emitted.clear()
    this.lastTime = time
    this.clear()
    // 立即按当前时间补发当前 tracks 中的弹幕，避免 seek 后画面空白
    // 直到下一次 timeupdate 才有弹幕
    this.setTime(time)
  }

  setTime(time: number): void {
    if (!this.enabled || this.tracks.size === 0 || !this.danmaku) return

    if (this.lastTime >= 0 && Math.abs(time - this.lastTime) > 3) {
      this.emitted.clear()
    }

    for (const [trackId, track] of this.tracks) {
      const windowStart = Math.max(0, time - 0.6)
      const windowEnd = time + 0.05

      for (const item of track.items) {
        const effectiveTime = item.time + track.offset
        if (effectiveTime < windowStart) continue
        if (effectiveTime > windowEnd) {
          if (effectiveTime > time + 1) break
          continue
        }
        const key = `${trackId}:${item.id}`
        if (this.emitted.has(key)) continue
        this.emitted.add(key)
        if (this.densityRatio < 1 && Math.random() > this.densityRatio) continue
        if (
          isBlocked(
            item.content,
            item.mode,
            this.blockKeywords,
            this.blockModes
          )
        )
          continue
        if (isBlockedByType(item, this.filters)) continue

        const cmt = this.convertBiliItem(item)
        if (trackId !== 'default') {
          cmt.time = effectiveTime
        }
        this.danmaku.emit(cmt)
      }
    }

    this.lastTime = time
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) {
      this.danmaku?.show()
      this.container.style.display = ''
    } else {
      this.danmaku?.hide()
      this.danmaku?.clear()
      this.container.style.display = 'none'
    }
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity))
    this.container.style.opacity = String(this.opacity)
  }

  setDensity(ratio: number): void {
    // 密度范围 0-1：<1 时按概率丢弃弹幕，>=1 时全部显示
    this.densityRatio = Math.max(0, Math.min(1, ratio))
  }

  setSpeed(factor: number): void {
    const speed = this.baseSpeed * Math.max(0.25, Math.min(3, factor))
    if (this.danmaku) {
      ;(this.danmaku as unknown as { speed: number }).speed = speed
      // 速度变更后清空已渲染弹幕，使当前时间轴重新以新速度发射，
      // 避免旧速度弹幕继续残留导致用户感知不到调节效果；
      // 清空后同样立即按当前进度补发（同上，防"调完就不出弹幕"）
      this.seek(Math.max(0, this.lastTime))
    }
  }

  setStyle(options: DanmakuStyleOptions): void {
    let shouldRefresh = false

    if (typeof options.fontSize === 'number' && options.fontSize > 0) {
      if (this.baseFontSize !== options.fontSize) {
        this.baseFontSize = options.fontSize
        shouldRefresh = true
      }
    }
    if (typeof options.scaleWithScreen === 'boolean') {
      if (this.scaleWithScreen !== options.scaleWithScreen) {
        this.scaleWithScreen = options.scaleWithScreen
        shouldRefresh = true
      }
    }
    if (Array.isArray(options.blockKeywords)) {
      const newKeywords = options.blockKeywords.filter(
        (k) => typeof k === 'string' && k.length > 0
      )
      if (
        newKeywords.length !== this.blockKeywords.length ||
        newKeywords.some((k, i) => k !== this.blockKeywords[i])
      ) {
        this.blockKeywords = newKeywords
        shouldRefresh = true
      }
    }
    if (Array.isArray(options.blockModes)) {
      this.blockModes = [...options.blockModes]
    }
    if (options.filters) {
      const prev = this.filters
      const next = { ...prev, ...options.filters }
      if (
        next.scroll !== prev.scroll ||
        next.fixed !== prev.fixed ||
        next.color !== prev.color ||
        next.advanced !== prev.advanced
      ) {
        this.filters = next
        shouldRefresh = true
      }
    }
    if (options.advanced) {
      const prev = this.advanced
      const next = { ...prev, ...options.advanced }
      if (
        next.fontFamily !== prev.fontFamily ||
        next.strokeWidth !== prev.strokeWidth ||
        next.shadowBlur !== prev.shadowBlur
      ) {
        this.advanced = next
        shouldRefresh = true
      }
    }

    if (shouldRefresh && this.danmaku) {
      // 样式/过滤/屏蔽词变更后清空已渲染弹幕，
      // 让当前时间窗口的弹幕立即以新样式/新规则重新出现。
      // 清空后必须立即按当前进度重新补发：否则若外部时间轴在清空后没有
      // 推进（或引擎内部状态被重置），当前窗口的弹幕将永远不再发射，
      // 表现为"调完设置弹幕再也出不来"。
      this.seek(Math.max(0, this.lastTime))
    }
  }

  resize(): void {
    this.danmaku?.resize()
    this.containerWidth = this.container.offsetWidth
  }

  /**
   * 重置 danmaku.js 内部的 comments 数组与 position 指针。
   *
   * danmaku.js 的 `clear()` 只清空 DOM 节点和 runningList，不清空 `comments`
   * 数组。通过 `emit()` 发射过的弹幕会永久保留在 `comments` 中，当 video
   * seeking 事件触发时，danmaku.js 会从 `comments` 重新发射弹幕，导致：
   * - 用户删除弹幕后，已删除的弹幕仍在 comments 中，seek 时被重新发射
   * - 用户移除弹幕轨道后，旧轨道的弹幕仍会重新出现
   *
   * 通过直接重置 comments 和 position，确保下次 setTime 只发射当前 tracks
   * 中的弹幕，已删除/已移除的弹幕不会被重新发射。
   */
  private resetDanmakuComments(): void {
    if (!this.danmaku) return
    const internal = this.danmaku as unknown as {
      comments: unknown[]
      _: { position: number }
    }
    internal.comments = []
    internal._.position = 0
  }

  destroy(): void {
    this.danmaku?.destroy()
    this.danmaku = null
  }
}
