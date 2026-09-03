/**
 * MKV 内嵌字幕前端提取（原后端 ffmpeg 职责的前端化）。
 *
 * 技术选型：MatroskaDemuxer 流式解复用而非 ffmpeg.wasm——
 * ffmpeg.wasm 必须把整个文件载入 WASM 堆（上限约 2GB），GB 级影片直接
 * 不可行；而 MKV 内嵌文本字幕本身就是「每帧一个文本块」，demux 即提取。
 * 复用 lib/mkv 的流式解复用器（自研，与播放引擎解耦）：
 * - 探测：Range 拉取文件头（几 MB 内含 Tracks 元素）→ 字幕轨列表
 * - 提取（小文件）：全量流式扫描 → 收集目标轨帧 → zlib 解压（如有）→ 组装
 * - 提取（大文件）：稀疏 Range 扫描——Cues 锚点分段（含 CueTime），
 *   段内按元素 size 链顺序前进（Cues 不保证覆盖全部 Cluster，锚点间
 *   直跳会漏帧）、块链上只读块头字节、视频/音频负载按字节算术跳过
 *   不传输。5GB 级片源只需传输 ~10% 字节量且一次遍历提取全部轨道；
 *   worker 按「距当前播放位置最近」的优先级选锚点（seek 感知），
 *   跳转后目标区域字幕秒级可用，其余区域后台补齐
 * - 组装 SRT / ASS 文本 → 交给 subtitleParser 解析渲染
 *
 * 支持的编码：S_TEXT/UTF8（SRT）、S_TEXT/SSA / S_TEXT/ASS、
 * S_TEXT/WEBVTT（按 SRT 兜底）。位图字幕（PGS/VOBSUB）标记不支持，
 * 前端无可行提取路径（后端 ffmpeg 已移除，无回退）。
 */
import { MatroskaDemuxer, type DemuxedFrame, type DemuxedTrack } from '@/lib/mkv/matroska-demuxer'
import { TRACK_TYPE } from '@/lib/mkv/ebml'

/** 探测时最多预取的头部字节数（Tracks 元素必须在其中收齐） */
const PROBE_HEAD_BYTES = 4 * 1024 * 1024
/** 该大小以下走全量流式提取（一次顺序读，简单可靠且更快） */
const FULL_STREAM_LIMIT = 512 * 1024 * 1024
/**
 * 并发 worker 数。浏览器对同源 HTTP/1.1 最多 6 个并发连接，
 * 且视频播放本身占用连接；并发过高会排队超时/失败（实测 12 会打挂
 * server-files 代理）。流式提取（边播边补）无需激进并发，2 足够。
 */
const SPARSE_CONCURRENCY = 2
/**
 * 稀疏模式窗口大小（块链读取粒度）。
 *
 * MKV 块头间隔由块负载大小决定（视频块 ~5-200KB，平均 ~15KB）。
 * 窗口必须显著大于平均块间距，否则每个块头读取都是缓存未命中——
 * 5.7GB 文件 × 每 15KB 一次 fetchRange = 62 万次 HTTP 请求，
 * Firefox 单请求开销（连接建立/调度）显著高于 Chrome，提取期间
 * 会挤占 video 元素的连接配额并拖慢首播。64KB 窗口可让连续
 * 4-5 个块头共享缓存，请求次数降为 1/7。
 */
const SPARSE_WINDOW = 64 * 1024
/** 稀疏模式允许的 Cluster 解析失败比例（超过则判整体失败） */
const SPARSE_MAX_FAIL_RATIO = 0.1

export interface MkvSubtitleTrack {
  /** MKV TrackNumber（前端提取的轨道标识，与后端 ffmpeg stream index 不同） */
  trackNumber: number
  codecId: string
  language: string | null
  title: string | null
  label: string
  /** 文幕类字幕才可前端提取 */
  supported: boolean
}

export interface ExtractedSubtitle {
  content: string
  format: 'srt' | 'ass'
}

export interface ExtractOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** 进度回调（0-100 整数） */
  onProgress?: (pct: number) => void
  /**
   * 当前播放时间（秒）。稀疏提取按「距该时间最近」的优先级选择锚点：
   * GB 级文件的提取按文件顺序爬取需数分钟，seek 到未爬取区域时字幕
   * 会缺失；传入播放时间后 worker 优先提取播放位置附近，跳转即出字幕。
   */
  getPriorityTime?: () => number | null
}

/** 字幕轨编码 → 是否前端可提取（文本类） */
function isTextSubtitleCodec(codecId: string): boolean {
  return (
    codecId === 'S_TEXT/UTF8' ||
    codecId === 'S_TEXT/SSA' ||
    codecId === 'S_TEXT/ASS' ||
    codecId === 'S_TEXT/WEBVTT'
  )
}

function trackLabel(t: DemuxedTrack): string {
  return t.name || t.language || `轨道 ${t.trackNumber}`
}

/** Range 拉取文件头部并解析 Tracks，返回字幕轨列表。 */
export async function probeMkvSubtitleTracks(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<MkvSubtitleTrack[]> {
  const { tracks } = await probeHead(url, headers, signal)
  return tracks
    .filter((t) => t.trackType === TRACK_TYPE.SUBTITLE)
    .map((t) => ({
      trackNumber: t.trackNumber,
      codecId: t.codecId,
      language: t.language,
      title: t.name,
      label: trackLabel(t),
      supported: isTextSubtitleCodec(t.codecId),
    }))
}

/** Matroska 音轨 CodecID → 通用小写编码名（与 ffprobe 一致） */
function matroskaAudioCodecName(codecId: string): string {
  // A_DTS / A_AC3 / A_EAC3 / A_AAC / A_MPEG/L3 …
  const raw = codecId.startsWith('A_') ? codecId.slice(2) : codecId
  if (raw === 'MPEG/L3' || raw === 'MPEG/L2') return 'mp3'
  if (raw === 'AC3') return 'ac3'
  if (raw === 'EAC3') return 'eac3'
  return raw.toLowerCase()
}

export interface MkvMediaInfo {
  /** 音轨编码列表（通用小写名，如 dts / ac3 / aac） */
  audioCodecs: string[]
  /** 可前端提取的文本字幕轨数量 */
  textSubtitleTracks: number
}

/**
 * 探测 MKV 媒体信息（音轨编码 + 文本字幕轨数量）。
 * 用于添加影片时判断是否需要 WASM 引擎（DTS 音频转码 / 内嵌字幕提取）。
 */
export async function probeMkvMediaInfo(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<MkvMediaInfo> {
  const { tracks } = await probeHead(url, headers, signal)
  const audioCodecs = tracks
    .filter((t) => t.trackType === TRACK_TYPE.AUDIO && t.codecId)
    .map((t) => matroskaAudioCodecName(t.codecId))
  const textSubtitleTracks = tracks.filter(
    (t) => t.trackType === TRACK_TYPE.SUBTITLE && isTextSubtitleCodec(t.codecId)
  ).length
  return { audioCodecs, textSubtitleTracks }
}

interface HeadInfo {
  tracks: DemuxedTrack[]
  /** Info 的 timestampScale 换算为毫秒/单位 */
  tsScaleMs: number
  /** 文件总大小（字节）；服务器未给 Content-Range 时为 null */
  size: number | null
  /** Segment 数据区起始绝对偏移 */
  segmentDataStart: number
}

/**
 * 拉取文件头并解析出轨道表 / 时基 / 文件大小 / Segment 数据区起点。
 * Range 拉取 + 读到 Tracks 即取消（服务器忽略 Range 时亦兼容）。
 */
async function probeHead(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<HeadInfo> {
  const res = await fetch(url, {
    headers: { ...headers, Range: `bytes=0-${PROBE_HEAD_BYTES - 1}` },
    signal,
  })
  if (!res.ok && res.status !== 206) {
    throw new Error(`探测失败：HTTP ${res.status}`)
  }
  // 文件总大小（Content-Range: bytes 0-N-1/total）
  let size: number | null = null
  const cr = res.headers.get('content-range')
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) size = parseInt(m[1]!, 10)
  } else {
    const cl = res.headers.get('content-length')
    if (cl && res.status === 200) size = parseInt(cl, 10)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('响应无数据流')

  let tracks: DemuxedTrack[] | null = null
  let tsScaleMs = 1 // 默认 timestampScale=1e6ns → 1ms
  let firstChunk: Uint8Array | null = null
  const demuxer = new MatroskaDemuxer({
    onTracks: (t) => {
      tracks = t
    },
    onInfo: (info) => {
      tsScaleMs = info.timestampScaleNs / 1e6
    },
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!firstChunk && value.length > 0) firstChunk = value
      demuxer.append(value)
      if (tracks) {
        // Tracks 已收齐，无需更多数据
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }

  if (!tracks) {
    throw new Error('文件头部未解析到 Tracks（可能不是 MKV 或头部损坏）')
  }
  if (!firstChunk) throw new Error('响应无数据')

  // Segment 数据区起点：EBML 头 + Segment ID + Segment Size
  const segmentDataStart = parseSegmentDataStart(firstChunk)
  return { tracks, tsScaleMs, size, segmentDataStart }
}

/** 从文件首块字节解析 Segment 数据区起始偏移（未知长度同样适用）。 */
function parseSegmentDataStart(head: Uint8Array): number {
  // EBML Header: ID(1-4B) + Size VINT
  const e = parseElementHeader(head, 0)
  if (!e) throw new Error('EBML 头解析失败')
  let pos = e.end
  // 顶层逐元素直到 Segment
  for (let guard = 0; guard < 16; guard++) {
    const el = parseElementHeader(head, pos)
    if (!el) break
    if (el.id === 0x18538067) {
      return el.dataStart
    }
    if (el.end < 0) break
    pos = el.end
  }
  throw new Error('未找到 Segment 元素')
}

interface ParsedElement {
  id: number
  size: number
  dataStart: number
  end: number // unknown size 时 -1
}

/** 在缓冲内解析元素头（ID + Size VINT）；数据不足返回 null。 */
function parseElementHeader(buf: Uint8Array, off: number): ParsedElement | null {
  const idv = readVintBytes(buf, off, true)
  if (!idv) return null
  const szv = readVintBytes(buf, off + idv.length, false)
  if (!szv) return null
  const dataStart = off + idv.length + szv.length
  return {
    id: idv.value,
    size: szv.value,
    dataStart,
    end: szv.value >= 0xffffffffffffff ? -1 : dataStart + szv.value,
  }
}

/** VINT 解析：keepMarker=true 时按 ID 语义保留标记位。 */
function readVintBytes(
  buf: Uint8Array,
  off: number,
  keepMarker: boolean
): { value: number; length: number } | null {
  if (off >= buf.length) return null
  const first = buf[off]!
  if (first === 0) return null
  let len = 1
  let mask = 0x80
  while (!(first & mask)) {
    len++
    mask >>= 1
    if (len > 8) return null
  }
  if (off + len > buf.length) return null
  let value = keepMarker ? first : first & (mask - 1)
  for (let i = 1; i < len; i++) value = value * 256 + buf[off + i]!
  return { value, length: len }
}

interface RawSubtitleFrame {
  timestampMs: number
  durationMs: number | null
  data: Uint8Array
}

/**
 * 提取指定字幕轨（单轨便捷封装），见 extractMkvSubtitleTracks。
 */
export async function extractMkvSubtitleTrack(
  url: string,
  trackNumber: number,
  opts: ExtractOptions = {}
): Promise<ExtractedSubtitle> {
  const result = await extractMkvSubtitleTracks(url, [trackNumber], opts)
  const sub = result.get(trackNumber)
  if (!sub) throw new Error(`未找到字幕轨 #${trackNumber}`)
  return sub
}

/**
 * 提取多条 MKV 字幕轨，一次遍历完成。
 *
 * 策略自适应：
 * - 文件 ≤ 512MB（或大小未知 / 无 Cues / 服务器不支持 Range）：
 *   全量顺序流式扫描（与旧实现一致）
 * - 更大文件：稀疏模式——读取尾部 Cues 得到全部 Cluster 位置后，
 *   并行遍历各 Cluster 的块链：仅读取块头字节，视频/音频负载按
 *   字节算术直接跳过（不下载），遇到目标字幕块时才拉取其负载。
 *
 * @returns Map<trackNumber, ExtractedSubtitle>
 */
export async function extractMkvSubtitleTracks(
  url: string,
  trackNumbers: number[],
  opts: ExtractOptions = {}
): Promise<Map<number, ExtractedSubtitle>> {
  const { tracks, tsScaleMs, size, segmentDataStart } = await probeHead(
    url,
    opts.headers,
    opts.signal
  )
  const trackMap = new Map<number, DemuxedTrack>()
  for (const n of trackNumbers) {
    const t = tracks.find((x) => x.trackNumber === n)
    if (t && t.trackType === TRACK_TYPE.SUBTITLE && isTextSubtitleCodec(t.codecId)) {
      trackMap.set(n, t)
    }
  }
  if (trackMap.size === 0) {
    throw new Error('指定的轨道不含可提取的文本字幕轨')
  }

  let framesByTrack: Map<number, RawSubtitleFrame[]>
  let usedSparse = false
  if (size != null && size > FULL_STREAM_LIMIT) {
    try {
      framesByTrack = await extractSparse(
        url,
        trackMap,
        size,
        segmentDataStart,
        tsScaleMs,
        opts
      )
      usedSparse = true
    } catch (err) {
      console.info(
        '[mkv-embedded] 稀疏提取不可用，回退全量扫描：',
        err instanceof Error ? err.message : err
      )
      framesByTrack = await extractFullStream(url, trackMap, opts)
    }
  } else {
    framesByTrack = await extractFullStream(url, trackMap, opts)
  }
  void usedSparse

  // zlib 压缩（mkvmerge 对文本轨常见 ContentCompAlgo=1）——两条路径统一处理
  await inflateTrackFrames(trackMap, framesByTrack)

  const out = new Map<number, ExtractedSubtitle>()
  for (const [n, track] of trackMap) {
    const frames = framesByTrack.get(n) ?? []
    if (frames.length === 0) continue
    if (track.codecId === 'S_TEXT/ASS' || track.codecId === 'S_TEXT/SSA') {
      out.set(n, { content: assembleAss(track, frames), format: 'ass' })
    } else {
      out.set(n, { content: assembleSrt(frames), format: 'srt' })
    }
  }
  if (out.size === 0) throw new Error('字幕轨为空')
  return out
}

// ==================== 全量流式提取 ====================

async function extractFullStream(
  url: string,
  trackMap: Map<number, DemuxedTrack>,
  opts: ExtractOptions
): Promise<Map<number, RawSubtitleFrame[]>> {
  const res = await fetch(url, { headers: opts.headers, signal: opts.signal })
  if (!res.ok) throw new Error(`提取失败：HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) throw new Error('响应无数据流')

  const framesByTrack = new Map<number, RawSubtitleFrame[]>()
  for (const n of trackMap.keys()) framesByTrack.set(n, [])

  const demuxer = new MatroskaDemuxer({
    onFrame: (f: DemuxedFrame) => {
      const list = framesByTrack.get(f.trackNumber)
      if (list) {
        list.push({ timestampMs: f.timestampMs, durationMs: f.durationMs, data: f.data })
      }
    },
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      demuxer.append(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }

  // zlib 解压由上层 extractMkvSubtitleTracks 统一处理
  return framesByTrack
}

/** 对启用 zlib 压缩的轨道批量解压帧数据。 */
async function inflateTrackFrames(
  trackMap: Map<number, DemuxedTrack>,
  framesByTrack: Map<number, RawSubtitleFrame[]>
): Promise<void> {
  for (const [n, track] of trackMap) {
    if (track.contentCompAlgo === 1) {
      const list = framesByTrack.get(n)
      if (list) {
        for (const f of list) f.data = await inflateZlib(f.data)
      }
    } else if (track.contentCompAlgo !== 0) {
      throw new Error(`不支持的帧压缩算法 ${track.contentCompAlgo}`)
    }
  }
}

// ==================== 稀疏 Range 提取 ====================

/** Range 读取器（稀疏模式专用，要求服务器返回 206）。 */
class RangeFetcher {
  private url: string
  private opts: ExtractOptions

  constructor(url: string, opts: ExtractOptions) {
    this.url = url
    this.opts = opts
  }

  async fetchRange(start: number, len: number): Promise<Uint8Array> {
    // 偶发 5xx / 网络抖动重试一次（并发下代理可能瞬时不稳）
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(this.url, {
          headers: {
            ...this.opts.headers,
            Range: `bytes=${start}-${start + len - 1}`,
          },
          signal: this.opts.signal,
        })
        if (res.status !== 206) {
          throw new Error(`服务器不支持 Range 请求（HTTP ${res.status}）`)
        }
        return new Uint8Array(await res.arrayBuffer())
      } catch (err) {
        if (this.opts.signal?.aborted) throw err
        lastErr = err
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    throw lastErr
  }
}

/** 块链读取窗口：缓存当前窗口，越界时按需拉取。 */
class SparseWindow {
  private buf: Uint8Array | null = null
  private start = 0
  private rf: RangeFetcher
  private windowBytes: number

  constructor(rf: RangeFetcher, windowBytes: number) {
    this.rf = rf
    this.windowBytes = windowBytes
  }

  /** 读取 [pos, pos+len) 的字节（窗口命中时零拷贝切片）。 */
  async read(pos: number, len: number): Promise<Uint8Array> {
    if (
      this.buf &&
      pos >= this.start &&
      pos + len <= this.start + this.buf.length
    ) {
      return this.buf.subarray(pos - this.start, pos - this.start + len)
    }
    const wlen = Math.max(len, this.windowBytes)
    this.buf = await this.rf.fetchRange(pos, wlen)
    this.start = pos
    return this.buf.subarray(0, len)
  }

  invalidate(): void {
    this.buf = null
  }
}

async function sparseReadVint(w: SparseWindow, pos: number): Promise<{ value: number; length: number }> {
  const first = (await w.read(pos, 1))[0]!
  if (first === 0) throw new Error(`块链解析错误 @${pos}：VINT 首字节为 0`)
  let len = 1
  let mask = 0x80
  while (!(first & mask)) {
    len++
    mask >>= 1
    if (len > 8) throw new Error(`块链解析错误 @${pos}：VINT 超长`)
  }
  const bytes = await w.read(pos, len)
  let value = first & (mask - 1)
  for (let i = 1; i < len; i++) value = value * 256 + bytes[i]!
  return { value, length: len }
}

async function sparseReadElemId(w: SparseWindow, pos: number): Promise<{ id: number; length: number }> {
  const first = (await w.read(pos, 1))[0]!
  if (first === 0) throw new Error(`块链解析错误 @${pos}：元素 ID 首字节为 0`)
  let len = 1
  let mask = 0x80
  while (!(first & mask)) {
    len++
    mask >>= 1
    if (len > 4) throw new Error(`块链解析错误 @${pos}：元素 ID 超长`)
  }
  const bytes = await w.read(pos, len)
  let id = first
  for (let i = 1; i < len; i++) id = id * 256 + bytes[i]!
  return { id, length: len }
}

async function sparseReadUint(w: SparseWindow, pos: number, len: number): Promise<number> {
  const bytes = await w.read(pos, len)
  let v = 0
  for (let i = 0; i < len; i++) v = v * 256 + bytes[i]!
  return v
}

/** 稀疏提取主流程：Cues 锚点分段 → 并行顺序块链遍历（seek 感知调度）。 */
async function extractSparse(
  url: string,
  trackMap: Map<number, DemuxedTrack>,
  size: number,
  segmentDataStart: number,
  tsScaleMs: number,
  opts: ExtractOptions
): Promise<Map<number, RawSubtitleFrame[]>> {
  // 1. 尾部读取并解析 Cues → Cluster 锚点（含时间戳）
  const tailLen = Math.min(8 * 1024 * 1024, size)
  const rf = new RangeFetcher(url, opts)
  const tail = await rf.fetchRange(size - tailLen, tailLen)
  const anchors = parseCuesAnchors(tail, segmentDataStart, tsScaleMs)
  if (anchors.length === 0) {
    throw new Error('MKV 无 Cues 索引，无法稀疏提取')
  }

  // 2. 并行遍历（每个 worker 独立窗口）
  const framesByTrack = new Map<number, RawSubtitleFrame[]>()
  for (const n of trackMap.keys()) framesByTrack.set(n, [])
  const failList: number[] = []
  const scheduler = createAnchorScheduler(anchors)
  let done = 0
  const total = anchors.length

  const runWorker = async (): Promise<void> => {
    const w = new SparseWindow(rf, SPARSE_WINDOW)
    for (;;) {
      // abort 后立即退出：fetchRange 对已中止信号会即刻抛错，
      // 不检查会导致 294 个锚点逐个失败（数百次无效请求级联）
      if (opts.signal?.aborted) throw new Error('提取已中止')
      const pt = opts.getPriorityTime?.() ?? null
      const i = scheduler.pick(pt != null && Number.isFinite(pt) ? pt * 1000 : null)
      if (i < 0) break
      const start = anchors[i]!.pos
      const next = i + 1 < total ? anchors[i + 1]!.pos : size
      try {
        await walkAnchorSegment(w, start, next, trackMap, framesByTrack, tsScaleMs)
      } catch (err) {
        // abort 引起的失败不是解析失败：不计数、不重试下一个锚点
        if (opts.signal?.aborted) throw err
        failList.push(i)
        if (failList.length > Math.ceil(total * SPARSE_MAX_FAIL_RATIO) + 2) {
          throw err
        }
        console.warn(
          `[mkv-embedded] 锚点区间 #${i} 解析失败，跳过：`,
          err instanceof Error ? err.message : err
        )
      }      w.invalidate()
      done++
      opts.onProgress?.(Math.min(99, Math.round((done / total) * 100)))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SPARSE_CONCURRENCY, total) }, () => runWorker())
  )
  opts.onProgress?.(100)
  // 并行 worker 乱序完成 → 按时间戳重排（稳定排序保持同帧序）
  for (const list of framesByTrack.values()) {
    list.sort((a, b) => a.timestampMs - b.timestampMs)
  }
  return framesByTrack
}

/**
 * 顺序遍历锚点区间 [segStart, segEnd) 内的所有顶层元素。
 *
 * Cues 并不保证覆盖全部 Cluster（实测部分封装工具只为部分 Cluster 写
 * Cue 条目），直接锚点间跳转会漏掉未索引 Cluster 中的字幕帧。本函数
 * 从锚点起点按元素 size 链顺序前进——锚点仅作并行分段边界，区间内
 * （含未索引的 Cluster）一个不漏；视频/音频负载仍按字节算术跳过。
 */
async function walkAnchorSegment(
  w: SparseWindow,
  segStart: number,
  segEnd: number,
  trackMap: Map<number, DemuxedTrack>,
  framesByTrack: Map<number, RawSubtitleFrame[]>,
  tsScaleMs: number
): Promise<void> {
  let cur = segStart
  for (;;) {
    if (cur >= segEnd - 4) return
    const id = await sparseReadElemId(w, cur)
    const sz = await sparseReadVint(w, cur + id.length)
    const dataStart = cur + id.length + sz.length
    // unknown size（流式写入尾段）兜底为区间终点
    const elSize =
      sz.value >= 0xffffffffffffff ? segEnd - dataStart : sz.value
    if (elSize <= 0) throw new Error(`@${cur} 元素尺寸异常（size=${elSize}）`)
    if (id.id === 0x1f43b675) {
      // Cluster：块链收集（nextBoundary 传 Cluster 自身结束位置）
      await walkClusterIntoAsync(
        w,
        cur,
        dataStart + elSize,
        trackMap,
        framesByTrack,
        tsScaleMs
      )
    }
    // 其他顶层元素（Chapters/Tags/Attachments 等）按大小跳过
    cur = dataStart + elSize
  }
}

/**
 * 遍历单个 Cluster 的块链，收集目标轨字幕帧。
 * 只读取块头字节；非目标轨负载按大小跳过不传输。
 * 并发 worker 各持独立窗口，本函数内部 await 窗口读取。
 */
async function walkClusterIntoAsync(
  w: SparseWindow,
  clusterStart: number,
  nextBoundary: number,
  trackMap: Map<number, DemuxedTrack>,
  framesByTrack: Map<number, RawSubtitleFrame[]>,
  tsScaleMs: number
): Promise<void> {
  // Cluster 元素头
  const id = await sparseReadElemId(w, clusterStart)
  if (id.id !== 0x1f43b675) {
    throw new Error(`@${clusterStart} 不是 Cluster 元素（0x${id.id.toString(16)}）`)
  }
  const sz = await sparseReadVint(w, clusterStart + id.length)
  const unknownSize = sz.value >= 0xffffffffffffff
  const clusterEnd = unknownSize
    ? nextBoundary
    : clusterStart + id.length + sz.length + sz.value
  let cur = clusterStart + id.length + sz.length

  // 1) 块区之前的子元素：找 Timecode(0xE7)，其余（PrevSize/Position 等）跳过
  let clusterTimecode = 0
  while (cur < clusterEnd - 4) {
    const elId = await sparseReadElemId(w, cur)
    const elSz = await sparseReadVint(w, cur + elId.length)
    if (elId.id === 0xe7) {
      clusterTimecode = await sparseReadUint(
        w,
        cur + elId.length + elSz.length,
        elSz.value
      )
      cur = cur + elId.length + elSz.length + elSz.value
      continue
    }
    if (elId.id === 0xa3 || elId.id === 0xa0) break // 已到块区
    if (elSz.value >= 0xffffffffffffff) break
    cur = cur + elId.length + elSz.length + elSz.value
  }

  // 2) 块区遍历
  while (cur < clusterEnd - 4 && cur < nextBoundary - 4) {
    const elId = await sparseReadElemId(w, cur)
    const elSz = await sparseReadVint(w, cur + elId.length)
    const dataStart = cur + elId.length + elSz.length
    const elSize =
      elSz.value >= 0xffffffffffffff ? nextBoundary - dataStart : elSz.value
    if (elSize < 0) break
    let nextCur = dataStart + elSize
    if (nextCur <= cur) break // 防御：解析异常时避免死循环

    if (elId.id === 0xa3) {
      // SimpleBlock
      await parseSparseBlock(
        w,
        dataStart,
        elSize,
        clusterTimecode,
        null,
        trackMap,
        framesByTrack,
        tsScaleMs
      )
    } else if (elId.id === 0xa0) {
      // BlockGroup：内含 Block(0xA1) + 可选 BlockDuration(0x9B)
      const groupEnd = dataStart + elSize
      let q = dataStart
      let blockPos = -1
      let blockSize = 0
      let durationMs: number | null = null
      while (q < groupEnd - 4) {
        const bId = await sparseReadElemId(w, q)
        const bSz = await sparseReadVint(w, q + bId.length)
        const bData = q + bId.length + bSz.length
        if (bSz.value >= 0xffffffffffffff) break
        if (bId.id === 0xa1) {
          blockPos = bData
          blockSize = bSz.value
        } else if (bId.id === 0x9b) {
          durationMs = (await sparseReadUint(w, bData, bSz.value)) * tsScaleMs
        }
        q = bData + bSz.value
      }
      if (blockPos >= 0) {
        await parseSparseBlock(
          w,
          blockPos,
          blockSize,
          clusterTimecode,
          durationMs,
          trackMap,
          framesByTrack,
          tsScaleMs
        )
      }
    }
    // 其他子元素（PrevSize/Position/Void 等）按大小跳过
    cur = nextCur
  }
}

/**
 * 解析单个块（SimpleBlock / Block 共用帧头格式）：
 * TrackNumber(VINT) + 相对时间戳(int16 BE, 有符号) + Flags(uint8) + 负载。
 * 非目标轨只消耗头部长度（负载不读）；目标轨读取负载并入帧列表。
 */
async function parseSparseBlock(
  w: SparseWindow,
  dataStart: number,
  payloadTotal: number,
  clusterTimecode: number,
  durationMs: number | null,
  trackMap: Map<number, DemuxedTrack>,
  framesByTrack: Map<number, RawSubtitleFrame[]>,
  tsScaleMs: number
): Promise<void> {
  const trackVint = await sparseReadVint(w, dataStart)
  if (trackVint.value === 0) throw new Error(`@${dataStart} 块轨道号为 0`)
  // 相对时间戳为有符号 int16（跨 Cluster 预读可为负）
  const relRaw = await sparseReadUint(w, dataStart + trackVint.length, 2)
  const rel = relRaw >= 0x8000 ? relRaw - 0x10000 : relRaw
  const flags = await sparseReadUint(w, dataStart + trackVint.length + 2, 1)
  const frameHeaderLen = trackVint.length + 3
  const payloadLen = payloadTotal - frameHeaderLen
  if (payloadLen < 0) throw new Error(`@${dataStart} 块长度异常`)

  if (!trackMap.has(trackVint.value)) return // 非目标轨：算术跳过
  const lacing = (flags & 0x06) >> 1
  if (lacing !== 0) {
    console.warn(`[mkv-embedded] 字幕块使用 lacing（不支持），跳过 @${dataStart}`)
    return
  }
  const data = await w.read(dataStart + frameHeaderLen, payloadLen)
  framesByTrack.get(trackVint.value)!.push({
    timestampMs: (clusterTimecode + rel) * tsScaleMs,
    durationMs,
    data: data.slice(), // 脱离窗口缓冲
  })
}

/** Cues 锚点：Cluster 绝对位置 + 该 CuePoint 时间戳（ms） */
interface CueAnchor {
  pos: number
  timeMs: number
}

/**
 * 在尾部缓冲中查找并解析 Cues，返回 Cluster 锚点列表
 * （按 pos 升序去重，含 CueTime 时间戳，供 seek 感知调度）。
 */
function parseCuesAnchors(
  tail: Uint8Array,
  segmentDataStart: number,
  tsScaleMs: number
): CueAnchor[] {
  // 扫描 Cues 元素 ID（1C 53 BB 6B）
  let cuesOff = -1
  for (let i = 0; i < tail.length - 12; i++) {
    if (
      tail[i] === 0x1c &&
      tail[i + 1] === 0x53 &&
      tail[i + 2] === 0xbb &&
      tail[i + 3] === 0x6b
    ) {
      const szv = readVintBytes(tail, i + 4, false)
      if (szv && szv.value > 0 && szv.value <= tail.length - i - 4 - szv.length) {
        cuesOff = i
        break
      }
    }
  }
  if (cuesOff < 0) return []
  const szv = readVintBytes(tail, cuesOff + 4, false)!
  const cuesEnd = cuesOff + 4 + szv.length + szv.value

  const anchors: CueAnchor[] = []
  let pos = cuesOff + 4 + szv.length
  while (pos < cuesEnd - 4) {
    const el = parseElementHeader(tail, pos)
    if (!el || el.end < 0) break
    if (el.id === 0xbb) {
      // CuePoint：内含 CueTime(0xB3) / CueTrackPositions(0xB7)
      // 先收齐子元素（ CueTime 与 CueTrackPositions 顺序不保证），再落锚点
      let q = el.dataStart
      let cueTime: number | null = null
      const positions: number[] = []
      while (q < el.end - 4) {
        const child = parseElementHeader(tail, q)
        if (!child || child.end < 0 || child.end > el.end) break
        if (child.id === 0xb3) {
          let v = 0
          for (let i = 0; i < child.size; i++) v = v * 256 + tail[child.dataStart + i]!
          cueTime = v * tsScaleMs
        } else if (child.id === 0xb7) {
          // CueTrackPositions：内含 CueClusterPosition(0xF1)
          let r = child.dataStart
          while (r < child.end - 4) {
            const g = parseElementHeader(tail, r)
            if (!g || g.end < 0 || g.end > child.end) break
            if (g.id === 0xf1 && g.size <= 8) {
              let v = 0
              for (let i = 0; i < g.size; i++) v = v * 256 + tail[g.dataStart + i]!
              positions.push(segmentDataStart + v)
            }
            r = g.end
          }
        }
        q = child.end
      }
      for (const p of positions) anchors.push({ pos: p, timeMs: cueTime ?? 0 })
    }
    pos = el.end
  }
  // 同位置去重（保留首个时间）+ 按 pos 升序
  const seen = new Set<number>()
  const out: CueAnchor[] = []
  for (const a of [...anchors].sort((a, b) => a.pos - b.pos)) {
    if (seen.has(a.pos)) continue
    seen.add(a.pos)
    out.push(a)
  }
  return out
}

/**
 * 锚点调度器：seek 感知的提取顺序。
 * 有播放时间时优先取「距播放位置最近」的未处理锚点（跳转后该区域字幕
 * 秒级可用，其余区域后台补齐）；无播放时间时按文件顺序推进。
 */
function createAnchorScheduler(anchors: CueAnchor[]): {
  pick: (priorityTimeMs: number | null) => number
  remaining: () => number
} {
  const total = anchors.length
  const processed = new Uint8Array(total)
  let remainingCount = total
  let seqCursor = 0
  const pick = (priorityTimeMs: number | null): number => {
    if (priorityTimeMs != null && Number.isFinite(priorityTimeMs)) {
      let best = -1
      let bestDist = Infinity
      for (let i = 0; i < total; i++) {
        if (processed[i]) continue
        const d = Math.abs(anchors[i]!.timeMs - priorityTimeMs)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      if (best >= 0) {
        processed[best] = 1
        remainingCount--
        return best
      }
      return -1
    }
    while (seqCursor < total && processed[seqCursor]) seqCursor++
    if (seqCursor >= total) return -1
    processed[seqCursor] = 1
    remainingCount--
    return seqCursor
  }
  return { pick, remaining: () => remainingCount }
}

/** DecompressionStream('deflate') = zlib（RFC1950）封装 */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

// ==================== 流式增量提取 ====================

/** 流式交付的字幕文本块 */
export interface SubtitleStreamChunk {
  /**
   * ASS：完整头部 + Format 行 + 本批 Dialogue 行（独立可解析）；
   * SRT：本批条目（序号全局连续）
   */
  text: string
  format: 'srt' | 'ass'
}

export interface StreamOptions extends ExtractOptions {
  /** 每批字幕文本回调（批内按时间升序，批间时间递增） */
  onChunk: (chunk: SubtitleStreamChunk) => void
}

/** 流式批大小（帧数） */
const STREAM_FLUSH_FRAMES = 2000
/** 流式 flush 时间兜底（有数据但未达批大小时，超过该间隔强制交付） */
const STREAM_FLUSH_INTERVAL_MS = 3000

/** 单帧 → SRT 条目（空文本返回空串） */
function srtEntry(idx: number, f: RawSubtitleFrame, endMs: number): string {
  const text = utf8.decode(f.data).trim()
  if (!text) return ''
  return `${idx}\n${msToSrtTime(f.timestampMs)} --> ${msToSrtTime(endMs)}\n${text}\n`
}

/** ASS 轨道头（codecPrivate 或内置默认） */
function assTrackHeader(track: DemuxedTrack): string {
  return track.codecPrivate && track.codecPrivate.byteLength > 0
    ? utf8.decode(track.codecPrivate).replace(/\r\n/g, '\n').replace(/\s+$/, '')
    : '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1'
}

/**
 * 流式提取指定字幕轨：边提取边交付，首段字幕秒级到达即可播放，
 * 后台继续补齐后续内容（无需等完整提取）。
 *
 * 每批文本独立可解析（ASS 块自带头部），调用方逐块 parseSubtitle 并
 * 追加 cues 即可实现「字幕渐进加载」。
 */
export async function streamMkvSubtitleTrack(
  url: string,
  trackNumber: number,
  opts: StreamOptions
): Promise<void> {
  const { tracks, tsScaleMs, size, segmentDataStart } = await probeHead(
    url,
    opts.headers,
    opts.signal
  )
  const track = tracks.find((t) => t.trackNumber === trackNumber)
  if (
    !track ||
    track.trackType !== TRACK_TYPE.SUBTITLE ||
    !isTextSubtitleCodec(track.codecId)
  ) {
    throw new Error('指定的轨道不是可提取的文本字幕轨')
  }
  if (track.contentCompAlgo !== 0 && track.contentCompAlgo !== 1) {
    throw new Error(`不支持的帧压缩算法 ${track.contentCompAlgo}`)
  }
  const isAss =
    track.codecId === 'S_TEXT/ASS' || track.codecId === 'S_TEXT/SSA'
  const needInflate = track.contentCompAlgo === 1

  const pending: RawSubtitleFrame[] = []
  let srtIdx = 0
  let lastFlush = Date.now()
  let emittedChunks = 0

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    if (needInflate) {
      for (const f of pending) f.data = await inflateZlib(f.data)
    }
    // seek 感知调度下锚点乱序完成：按时间排序恢复「下一帧时间戳」
    // 作为结束时间的正确语义（否则边界帧可能拿到更早的 nextTs）
    if (pending.length > 1) {
      pending.sort((a, b) => a.timestampMs - b.timestampMs)
    }
    const parts: string[] = []
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i]!
      const nextTs =
        i + 1 < pending.length ? pending[i + 1]!.timestampMs : null
      const end =
        f.durationMs && f.durationMs > 0
          ? f.timestampMs + f.durationMs
          : nextTs ?? f.timestampMs + 3000
      if (isAss) {
        const raw = utf8.decode(f.data)
        // 去掉 ReadOrder 和 Layer 前两字段（到第二个逗号）：
        // 帧 9 字段 → Dialogue 10 字段（插入 Start/End），Style..Text 原样保留，
        // 避免 Text 拿到 "Effect,Text" 导致首字符为逗号（同 assembleAss）
        const c1 = raw.indexOf(',')
        const c2 = c1 >= 0 ? raw.indexOf(',', c1 + 1) : -1
        const body = c2 >= 0 ? raw.slice(c2 + 1) : raw
        parts.push(
          `Dialogue: 0,${msToAssTime(f.timestampMs)},${msToAssTime(end)},${body}`
        )
      } else {
        const entry = srtEntry(++srtIdx, f, end)
        if (entry) parts.push(entry)
      }
    }
    let text: string
    if (isAss) {
      // 每批自带完整头部（独立可解析：parseAss 依赖 PlayRes/Style/Format 行）
      text = `${assTrackHeader(track)}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${parts.join('\n')}\n`
    } else {
      text = parts.join('\n')
    }
    pending.length = 0
    lastFlush = Date.now()
    emittedChunks++
    opts.onChunk({ text, format: isAss ? 'ass' : 'srt' })
  }

  const maybeFlush = async (): Promise<void> => {
    if (
      pending.length >= STREAM_FLUSH_FRAMES ||
      (pending.length > 0 && Date.now() - lastFlush >= STREAM_FLUSH_INTERVAL_MS)
    ) {
      await flush()
    }
  }

  /** 全量流式路径（小文件 / 无 Cues / 大小未知）：顺序读 + 增量交付 */
  const streamFullScan = async (): Promise<void> => {
    const res = await fetch(url, { headers: opts.headers, signal: opts.signal })
    if (!res.ok) throw new Error(`提取失败：HTTP ${res.status}`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('响应无数据流')
    const demuxer = new MatroskaDemuxer({
      onFrame: (f: DemuxedFrame) => {
        if (f.trackNumber === trackNumber) {
          pending.push({ timestampMs: f.timestampMs, durationMs: f.durationMs, data: f.data })
        }
      },
    })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        demuxer.append(value)
        await maybeFlush()
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
    await flush()
  }

  // 小文件 / 大小未知：全量流式扫描（顺序天然有序）
  if (size == null || size <= FULL_STREAM_LIMIT) {
    await streamFullScan()
    if (emittedChunks === 0) throw new Error('字幕轨为空')
    return
  }

  // 大文件：稀疏路径 + seek 感知调度 + 完成即交付
  const tailLen = Math.min(8 * 1024 * 1024, size)
  const rf = new RangeFetcher(url, opts)
  const tail = await rf.fetchRange(size - tailLen, tailLen)
  const anchors = parseCuesAnchors(tail, segmentDataStart, tsScaleMs)
  if (anchors.length === 0) {
    // 无 Cues：回退全量流式（GB 级耗时较长，但仍可边读边交付）
    await streamFullScan()
    if (emittedChunks === 0) throw new Error('字幕轨为空')
    return
  }

  const total = anchors.length
  const trackMap = new Map([[trackNumber, track]])
  const scheduler = createAnchorScheduler(anchors)
  let done = 0
  let hardFail = 0

  const runWorker = async (): Promise<void> => {
    const w = new SparseWindow(rf, SPARSE_WINDOW)
    for (;;) {
      // abort 后立即退出：fetchRange 对已中止信号会即刻抛错，
      // 不检查会导致全部锚点逐个失败（数百次无效请求级联）
      if (opts.signal?.aborted) throw new Error('提取已中止')
      const pt = opts.getPriorityTime?.() ?? null
      const priorityMs = pt != null && Number.isFinite(pt) ? pt * 1000 : null
      const i = scheduler.pick(priorityMs)
      if (i < 0) break
      const start = anchors[i]!.pos
      const next = i + 1 < total ? anchors[i + 1]!.pos : size
      const local: RawSubtitleFrame[] = []
      try {
        await walkAnchorSegment(
          w,
          start,
          next,
          trackMap,
          new Map([[trackNumber, local]]),
          tsScaleMs
        )
      } catch (err) {
        // abort 引起的失败不是解析失败：不计数、立即终止 worker
        if (opts.signal?.aborted) throw err
        hardFail++
        if (hardFail > Math.ceil(total * SPARSE_MAX_FAIL_RATIO) + 2) throw err
        console.warn(
          `[mkv-embedded] 锚点区间 #${i} 解析失败，跳过：`,
          err instanceof Error ? err.message : err
        )
      }
      w.invalidate()
      // 乱序交付安全：调用方把 cues 追加进轨道、渲染层按激活时间
      // 线性扫描全部 cues，与到达顺序无关（flush 前按时间排序）
      for (const f of local) pending.push(f)
      // 播放位置附近的锚点立即 flush（seek 后秒级出字幕）；
      // 其余按批大小 / 时间间隔节奏交付
      const nearPriority =
        priorityMs != null &&
        local.length > 0 &&
        Math.abs(anchors[i]!.timeMs - priorityMs) < 30000
      if (nearPriority) {
        await flush()
      } else {
        await maybeFlush()
      }
      done++
      opts.onProgress?.(Math.min(99, Math.round((done / total) * 100)))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SPARSE_CONCURRENCY, total) }, () => runWorker())
  )
  await flush()
  opts.onProgress?.(100)
  if (emittedChunks === 0) throw new Error('字幕轨为空')
}

/** 帧显示区间：显式 BlockDuration 优先，否则延续到下一帧出现 */
function frameEndMs(frames: RawSubtitleFrame[], i: number): number {
  const f = frames[i]!
  if (f.durationMs && f.durationMs > 0) return f.timestampMs + f.durationMs
  const next = frames[i + 1]
  if (next) return next.timestampMs
  return f.timestampMs + 3000 // 末帧兜底 3s
}

function msToSrtTime(ms: number): string {
  const cs = Math.floor(ms / 10) % 100
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const h = Math.floor(ms / 3600000)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad2(cs)}`
}

function msToAssTime(ms: number): string {
  const cs = Math.floor(ms / 10) % 100
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const h = Math.floor(ms / 3600000)
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

const utf8 = new TextDecoder('utf-8')

/** S_TEXT/UTF8 → SRT：帧即条目文本（可能多行） */
function assembleSrt(frames: RawSubtitleFrame[]): string {
  const parts: string[] = []
  for (let i = 0; i < frames.length; i++) {
    const text = utf8.decode(frames[i]!.data).trim()
    if (!text) continue
    parts.push(
      `${i + 1}\n${msToSrtTime(frames[i]!.timestampMs)} --> ${msToSrtTime(
        frameEndMs(frames, i)
      )}\n${text}\n`
    )
  }
  return parts.join('\n')
}

/**
 * S_TEXT/ASS → ASS：codecPrivate 是完整 ASS 头（[Script Info]+[V4+ Styles]），
 * 帧 = "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
 * （Matroska 规范 9 字段，时间戳来自 Block）。
 * 组装：`Dialogue: 0,Start,End,` + 帧去掉前两字段（ReadOrder、Layer）后的 7 字段。
 *
 * 注意：codecPrivate 可能自带 [Events]（含 Comment 事件）且其后跟随
 * [Fonts]/[Graphics] 等段——Dialogue 必须追加在 header 之后新开的
 * [Events] 段内，否则落在 [Fonts] 段中会被解析器整体跳过。
 */
function assembleAss(track: DemuxedTrack, frames: RawSubtitleFrame[]): string {
  const lines: string[] = [
    assTrackHeader(track),
    '\n[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!
    const raw = utf8.decode(f.data)
    // 去掉 ReadOrder 和 Layer 前两字段（到第二个逗号）：
    // 帧 9 字段 → Dialogue 10 字段（插入 Start/End），Style..Text 原样保留。
    // 只去掉一个字段会使后续全部错位一格，Text 变成 "Effect,Text"，
    // Effect 为空时字幕文本首字符就是逗号。
    const c1 = raw.indexOf(',')
    const c2 = c1 >= 0 ? raw.indexOf(',', c1 + 1) : -1
    const body = c2 >= 0 ? raw.slice(c2 + 1) : raw
    lines.push(
      `Dialogue: 0,${msToAssTime(f.timestampMs)},${msToAssTime(frameEndMs(frames, i))},${body}`
    )
  }
  return lines.join('\n') + '\n'
}
