import { useAuthStore } from '@/store/authStore'
import Danmaku from 'danmaku'
import type {
  DanmakuAdvancedStyle,
  DanmakuTypeFilters,
} from '@/store/danmakuStore'

type DanmakuComment = {
  text?: string
  mode?: 'ltr' | 'rtl' | 'top' | 'bottom'
  time?: number
  style?: Partial<CSSStyleDeclaration> | CanvasRenderingContext2D
}

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface BilibiliDanmakuItem {
  id: string
  content: string
  time: number
  mode: number
  color: number
  size: number
}

export async function fetchBilibiliDanmaku(
  cidOrBvid: number | string
): Promise<BilibiliDanmakuItem[]> {
  const key = typeof cidOrBvid === 'number' ? 'cid' : 'bvid'
  const res = await fetch(
    `${API_URL}/api/stream/bilibili/danmaku?${key}=${encodeURIComponent(
      String(cidOrBvid)
    )}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    danmaku?: BilibiliDanmakuItem[]
    message?: string
  }
  if (!res.ok || !data.success || !data.danmaku) {
    throw new Error(data.message || '获取 B站 弹幕失败')
  }
  return data.danmaku
}

export interface SendDanmakuOptions {
  color?: number
  mode?: number
  size?: number
  stime?: number
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
  items: BilibiliDanmakuItem[]
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
  item: BilibiliDanmakuItem,
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
    let size = itemSize ?? this.baseFontSize
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

  private convertBiliItem(item: BilibiliDanmakuItem): DanmakuComment {
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
        { id: '', content: text, time: 0, mode, color: options?.color ?? 0xffffff, size: options?.size ?? 25 },
        this.filters
      )
    )
      return

    const time = Math.max(0, (this.media?.currentTime ?? 0) - 0.05)
    const emitParams = {
      text,
      mode: mapBiliModeToDanmakuJs(mode),
      time,
      style: {
        ...this.getCommentStyle(options?.color, options?.size),
      } as Partial<CSSStyleDeclaration>,
    }
    this.danmaku.emit(emitParams)
  }

  loadTimelineDanmaku(items: BilibiliDanmakuItem[]): void {
    this.loadDanmakuTrack('default', items, 0)
  }

  loadDanmakuTrack(
    trackId: string,
    comments: BilibiliDanmakuItem[],
    offset = 0
  ): void {
    this.tracks.set(trackId, {
      items: [...comments].sort((a, b) => a.time - b.time),
      offset,
    })
  }

  removeDanmakuTrack(trackId: string): void {
    this.tracks.delete(trackId)
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
  }

  seek(time: number): void {
    this.emitted.clear()
    this.lastTime = time
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
    this.densityRatio = Math.max(0, Math.min(1, ratio))
  }

  setSpeed(factor: number): void {
    const speed = this.baseSpeed * Math.max(0.25, Math.min(3, factor))
    if (this.danmaku) {
      ;(this.danmaku as unknown as { speed: number }).speed = speed
    }
  }

  setStyle(options: DanmakuStyleOptions): void {
    if (typeof options.fontSize === 'number' && options.fontSize > 0) {
      this.baseFontSize = options.fontSize
    }
    if (Array.isArray(options.blockKeywords)) {
      this.blockKeywords = options.blockKeywords.filter(
        (k) => typeof k === 'string' && k.length > 0
      )
    }
    if (Array.isArray(options.blockModes)) {
      this.blockModes = [...options.blockModes]
    }
    if (options.filters) {
      this.filters = { ...this.filters, ...options.filters }
    }
    if (options.advanced) {
      this.advanced = { ...this.advanced, ...options.advanced }
    }
    if (typeof options.scaleWithScreen === 'boolean') {
      this.scaleWithScreen = options.scaleWithScreen
    }
  }

  resize(): void {
    this.danmaku?.resize()
    this.containerWidth = this.container.offsetWidth
  }

  destroy(): void {
    this.danmaku?.destroy()
    this.danmaku = null
  }
}
