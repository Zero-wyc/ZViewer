/**
 * playsvideo 内嵌字幕 → ZViewer 字幕管线的桥接层。
 *
 * ## 为什么需要这一层
 *
 * playsvideo 提取内嵌字幕后，产物是**本机原生 `<track>` 元素 + blob URL**，
 * 而 ZViewer 的同步观影模型要求字幕以 `ParsedCue[]` 形式由房主经 socket
 * 全量广播给观众（`subtitle-update`）。blob URL 无法跨客户端传递，两者
 * 数据形态不兼容，因此需要一个转换层。
 *
 * 本模块做三件事：
 * 1. 从 playsvideo 挂载的 `<track>` 取回 WebVTT 文本（fetch blob URL）
 * 2. 用 ZViewer 的 `parseSubtitle` 解析为 `ParsedCue[]`
 * 3. 以发布/订阅把结果交给 `useSubtitles`，后续渲染与广播完全复用既有管线
 *
 * ## 关于世代
 *
 * 引擎 attach 会开启新会话，旧会话的字幕可能在切换后才提取完成。发布时
 * 携带世代号，消费侧据此丢弃过期结果，避免切影片后旧字幕串台。
 */
import { parseSubtitle, type ParsedCue } from '@/lib/subtitleParser'

/** playsvideo 提取出的一条内嵌字幕轨（已解析为 ZViewer 内部格式）。 */
export interface PlaysVideoEmbeddedSubtitle {
  /** 轨道序号（对应 playsvideo 的 SubtitleTrackInfo.index） */
  index: number
  /** 展示标签（语言 + 名称） */
  label: string
  /** ISO 639-2/T 语言代码，未知为 null */
  language: string | null
  /** 原始编码（srt / ass / ssa / webvtt / tx3g / ttml） */
  codec: string
  cues: ParsedCue[]
}

type Listener = (subtitle: PlaysVideoEmbeddedSubtitle) => void

const listeners = new Set<Listener>()

/** 当前会话世代；引擎每次 attach 递增 */
let generation = 0

export function getPlaysVideoSubtitleGeneration(): number {
  return generation
}

/**
 * 开启新会话（引擎 attach 时调用），使旧会话的提取结果作废。
 * @returns 新世代号，引擎需持有它并在发布时回传
 */
export function resetPlaysVideoSubtitles(): number {
  generation += 1
  return generation
}

/**
 * 发布一条提取完成的字幕轨。
 * 世代不匹配（旧会话的迟到结果）时直接丢弃。
 */
export function publishPlaysVideoSubtitle(
  gen: number,
  subtitle: PlaysVideoEmbeddedSubtitle
): void {
  if (gen !== generation) return
  for (const listener of listeners) {
    try {
      listener(subtitle)
    } catch (err) {
      console.error('[playsvideo-subtitles] 订阅者处理失败:', err)
    }
  }
}

/** 订阅内嵌字幕提取结果，返回取消订阅函数。 */
export function subscribePlaysVideoSubtitles(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 从 playsvideo 挂载的 `<track>` 元素取回 WebVTT 文本并解析为 ParsedCue[]。
 *
 * 直接 fetch blob URL 而非读取 `track.track.cues`：
 * - blob URL 是同源的，fetch 必然成功，不依赖浏览器何时加载轨道
 * - 不必把轨道切到 hidden 模式，避免与 playsvideo 自己的 mode 管理打架
 *   （策略为 off 时它会在 load 后显式置为 disabled）
 *
 * @returns 解析后的 cue 数组；轨道无内容时返回空数组
 */
export async function fetchPlaysVideoTrackCues(
  element: HTMLTrackElement,
  signal?: AbortSignal
): Promise<ParsedCue[]> {
  const src = element.src
  // 只认 playsvideo 创建的 blob: 轨道。页面上可能存在其他来源的 <track>
  // （如 ArtPlayer 的占位轨道，src 为空或指向网络地址），对它们发起读取
  // 只会得到空结果或无意义的请求。
  if (!src || !src.startsWith('blob:')) return []
  let text: string
  try {
    const res = await fetch(src, signal ? { signal } : undefined)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (err) {
    if (signal?.aborted) return []
    console.warn(
      '[playsvideo-subtitles] 读取字幕 blob 失败:',
      err instanceof Error ? err.message : err
    )
    return []
  }
  if (!text.trim()) return []
  return parseSubtitle(text, 'vtt')
}
