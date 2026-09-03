/**
 * 渐进式 Matroska（MKV/WebM）解复用器。
 *
 * 面向 HTTP 流式场景：上层通过 append(bytes) 喂入网络数据，解析器以
 * 元素为单位推进（元素头不完整则等待更多数据），按回调吐出结果：
 * - onTracks / onInfo：元信息就绪（Tracks 数据收齐后触发一次）
 * - onFrame：每个 SimpleBlock/Block 帧（视频与音频都回调）
 * - onClusterIndexed：Cluster 起始字节偏移 → 时间码，供 seek Range 重连
 *
 * 仅覆盖播放所需最小子集：
 * - 不解析 Cues/Chapters/Tags/Attachments（遇到即整体跳过——任何未知
 *   叶子元素都会被通用路径完整消费）
 * - BlockGroup 只取 Block；其帧不携带关键帧标志
 * - 支持 none/Xiph/fixed/EBML lacing
 */
import { readVint, readElementId, isUnknownSize, EBML_IDS } from './ebml'

/** 单条轨道描述 */
export interface DemuxedTrack {
  trackNumber: number
  trackType: number
  codecId: string
  /** CodecPrivate 原始字节（avcC / AudioSpecificConfig / ASS 头等） */
  codecPrivate: Uint8Array | null
  samplingRate: number | null
  channels: number | null
  pixelWidth: number | null
  pixelHeight: number | null
  /** 轨道语言（IETF/BCP47 简写，如 'chi'） */
  language: string | null
  /** 轨道名称（常存字幕标题） */
  name: string | null
  /** ContentCompAlgo：0=none 1=zlib 2=bzip2（>0 时帧数据被压缩） */
  contentCompAlgo: number
}

/** 解出的一个媒体帧 */
export interface DemuxedFrame {
  trackNumber: number
  /** 相对整片起始的毫秒时间戳 */
  timestampMs: number
  /** 关键帧标记（BlockGroup 内的 Block 恒为 false） */
  keyframe: boolean
  data: Uint8Array
  /** BlockDuration（毫秒）；SimpleBlock 无时长（字幕轨靠它界定显示区间） */
  durationMs: number | null
}

/** Info 元信息 */
export interface MatroskaInfo {
  timestampScaleNs: number
  /** 容器声明的时长（秒）；流式截断文件可能为 null */
  durationSec: number | null
}

export interface MatroskaDemuxerCallbacks {
  onTracks?: (tracks: DemuxedTrack[]) => void
  onInfo?: (info: MatroskaInfo) => void
  onFrame?: (frame: DemuxedFrame) => void
  /** 时间码（毫秒）→ Cluster 元素头起始的文件绝对偏移 */
  onClusterIndexed?: (timestampMs: number, byteOffset: number) => void
}

interface ContainerFrame {
  id: number
  /** 容器数据结束的全局偏移；unknown-size 为 Infinity（依赖子元素自描述推进） */
  dataEnd: number
}

const MASTER_IDS = new Set<number>([
  EBML_IDS.EBML_HEADER,
  EBML_IDS.SEGMENT,
  EBML_IDS.SEEK_HEAD,
  EBML_IDS.INFO,
  EBML_IDS.TRACKS,
  EBML_IDS.TRACK_ENTRY,
  EBML_IDS.AUDIO,
  EBML_IDS.VIDEO,
  EBML_IDS.CLUSTER,
  EBML_IDS.BLOCK_GROUP,
  EBML_IDS.CONTENT_ENCODINGS,
  EBML_IDS.CONTENT_ENCODING,
  EBML_IDS.CONTENT_COMPRESSION,
])

export class MatroskaDemuxer {
  private cb: MatroskaDemuxerCallbacks

  /** 网络流中的绝对字节位置：streamBaseOffset 为本次 buffer 首字节的偏移 */
  private buffer: Uint8Array = new Uint8Array(0)
  private bufferBase = 0
  private viewOffset = 0

  private timestampScaleNs = 1_000_000
  private durationSec: number | null = null
  private scaleEmitted = false

  private tracks: DemuxedTrack[] = []
  private tracksEmitted = false
  /** 正在收集字段值的 TRACK_ENTRY */
  private trackScratch: DemuxedTrack | null = null

  private currentClusterTimestampMs: number | null = null

  private stack: ContainerFrame[] = []

  readonly clusterIndex: { timestampMs: number; offset: number }[] = []

  constructor(cb: MatroskaDemuxerCallbacks, startByteOffset = 0) {
    this.cb = cb
    this.bufferBase = startByteOffset
  }

  /** 网络流中已消费到的绝对字节偏移（同时也是 seek 时上层应续传的位置） */
  get consumedBytes(): number {
    return this.bufferBase + this.viewOffset
  }

  /**
   * 继承上一位世代的 Cluster 索引（流水线重建时调用），
   * 使新 demuxer 输出的索引保持全片连续。
   */
  inheritClusterIndex(prev: { timestampMs: number; offset: number }[]): void {
    this.clusterIndex.push(...prev)
    if (prev.length > 0) {
      // 维护上层 lastKnownClusterTsMs 的语义：重建世代起点已知
      void prev[prev.length - 1]
    }
  }

  /** 追加网络数据并尽量推进解析 */
  append(bytes: Uint8Array): void {
    if (this.viewOffset === this.buffer.length) {
      this.buffer = bytes.slice()
      this.viewOffset = 0
    } else {
      const remaining = this.buffer.subarray(this.viewOffset)
      const merged = new Uint8Array(remaining.length + bytes.length)
      merged.set(remaining, 0)
      merged.set(bytes, remaining.length)
      this.buffer = merged
      this.viewOffset = 0
    }
    try {
      this.parse()
    } finally {
      this.compact()
    }
  }

  /** 丢弃已消费前缀，防止长片播放内存增长 */
  private compact(): void {
    if (this.viewOffset > 0 && this.viewOffset === this.buffer.length) {
      this.buffer = new Uint8Array(0)
      this.viewOffset = 0
    } else if (this.viewOffset > 0) {
      this.buffer = this.buffer.slice(this.viewOffset)
      this.bufferBase += this.viewOffset
      this.viewOffset = 0
    }
  }

  private available(): number {
    return this.buffer.length - this.viewOffset
  }

  private makeView(): DataView {
    return new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + this.viewOffset,
      this.available()
    )
  }

  /** 主循环：反复尝试消耗一个「可完成的最小单元」 */
  private parse(): void {
    let guard = 0
    for (;;) {
      if (++guard > 200000) {
        console.warn('[matroska-demuxer] 解析循环超限')
        return
      }

      // 1. 已知大小容器读完 → 关闭出栈
      const top = this.stack[this.stack.length - 1]
      if (top && Number.isFinite(top.dataEnd)) {
        if (this.consumedAbs() >= top.dataEnd) {
          this.stack.pop()
          this.handleMasterClose(top.id)
          continue
        }
      }

      // 2. 读取下一个元素头（不足则等待更多数据）
      const avail = this.available()
      if (avail < 2) return
      const view = this.makeView()
      const idRes = readElementId(view, 0, avail)
      if (idRes === 'need-more' || !idRes) return
      let cursor = idRes.length
      if (avail < cursor + 1) return

      const unknownSize = isUnknownSize(view.getUint8(cursor))
      let size = -1
      let sizeLen = 0
      if (!unknownSize) {
        const sizeRes = readVint(view, cursor, avail - cursor)
        if (sizeRes === 'need-more' || !sizeRes) return
        size = sizeRes.value
        sizeLen = sizeRes.length
      }
      cursor += sizeLen

      const headerStart = this.consumedAbs()
      const dataStart = headerStart + cursor

      if (MASTER_IDS.has(idRes.id)) {
        const dataEnd = unknownSize ? Infinity : dataStart + size
        this.stack.push({ id: idRes.id, dataEnd })
        this.handleMasterOpen(idRes.id, headerStart)
        this.viewOffset += cursor
        continue
      }

      // 叶子元素：数据收齐才处理
      if (!unknownSize && avail < cursor + size) return
      const data = this.buffer.subarray(
        this.viewOffset + cursor,
        this.viewOffset + cursor + size
      )
      this.handleLeaf(idRes.id, dataStart, data)
      this.viewOffset += cursor + size
    }
  }

  private consumedAbs(): number {
    return this.bufferBase + this.viewOffset
  }

  private handleMasterOpen(id: number, headerStart: number): void {
    switch (id) {
      case EBML_IDS.TRACK_ENTRY:
        this.trackScratch = {
          trackNumber: 0,
          trackType: 0,
          codecId: '',
          codecPrivate: null,
          samplingRate: null,
          channels: null,
          pixelWidth: null,
          pixelHeight: null,
          language: null,
          name: null,
          contentCompAlgo: 0,
        }
        break
      case EBML_IDS.BLOCK_GROUP:
        this.blockGroupDurationMs = null
        this.blockGroupFrames = []
        break
      case EBML_IDS.CLUSTER:
        this.currentClusterTimestampMs = null
        // 记录 Cluster 头起始偏移（含 TIMECODE 在内的时间码在首个叶子时回填时间戳）
        this.pendingClusterHeaderStart = headerStart
        break
      default:
        break
    }
  }

  private pendingClusterHeaderStart = 0

  private handleMasterClose(id: number): void {
    switch (id) {
      case EBML_IDS.BLOCK_GROUP:
        // BlockDuration 与 Block 的出现顺序在规范中不确定：统一在组关闭
        // 时回填（帧对象引用同一实例，回调持有者可见回填后的值）
        if (this.blockGroupDurationMs !== null) {
          for (const f of this.blockGroupFrames) {
            f.durationMs = this.blockGroupDurationMs
          }
        }
        this.blockGroupDurationMs = null
        this.blockGroupFrames = []
        break
      case EBML_IDS.TRACK_ENTRY:
        if (
          this.trackScratch &&
          (this.trackScratch.trackType !== 0 || this.trackScratch.codecId)
        ) {
          this.tracks.push(this.trackScratch)
        }
        this.trackScratch = null
        break
      case EBML_IDS.TRACKS:
        if (!this.tracksEmitted) {
          this.tracksEmitted = true
          this.cb.onTracks?.([...this.tracks])
        }
        break
      case EBML_IDS.INFO:
        if (!this.scaleEmitted) {
          this.scaleEmitted = true
          this.cb.onInfo?.({
            timestampScaleNs: this.timestampScaleNs,
            durationSec: this.durationSec,
          })
        }
        break
      case EBML_IDS.CLUSTER:
        this.currentClusterTimestampMs = null
        break
      default:
        break
    }
  }

  private handleLeaf(id: number, _dataStart: number, data: Uint8Array): void {
    switch (id) {
      case EBML_IDS.TIMECODE_SCALE: {
        const v = Number(this.readUint(data))
        if (v > 0) this.timestampScaleNs = v
        break
      }
      case EBML_IDS.DURATION: {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const v = data.byteLength === 4 ? dv.getFloat32(0) : dv.getFloat64(0)
        if (Number.isFinite(v) && v > 0) {
          this.durationSec = (v * this.timestampScaleNs) / 1e9
        }
        break
      }
      case EBML_IDS.TRACK_NUMBER:
        if (this.trackScratch)
          this.trackScratch.trackNumber = Number(this.readUint(data))
        break
      case EBML_IDS.TRACK_TYPE:
        if (this.trackScratch)
          this.trackScratch.trackType = Number(this.readUint(data))
        break
      case EBML_IDS.CODEC_ID:
        if (this.trackScratch) this.trackScratch.codecId = decodeAscii(data)
        break
      case EBML_IDS.CODEC_PRIVATE:
        if (this.trackScratch) this.trackScratch.codecPrivate = data.slice()
        break
      case EBML_IDS.TRACK_NAME:
        if (this.trackScratch && this.trackScratch.name === null)
          this.trackScratch.name = decodeUtf8(data)
        break
      case EBML_IDS.TRACK_LANGUAGE:
        if (this.trackScratch && this.trackScratch.language === null)
          this.trackScratch.language = decodeAscii(data)
        break
      case EBML_IDS.CONTENT_COMP_ALGO:
        // CompAlgo 出现在 ContentCompression 内、TrackEntry 之下，
        // trackScratch 仍活着
        if (this.trackScratch && this.trackScratch.contentCompAlgo === 0)
          this.trackScratch.contentCompAlgo = Number(this.readUint(data))
        break
      case EBML_IDS.BLOCK_DURATION:
        // BlockGroup 内的显式时长（毫秒，按 timestampScale 换算）
        this.blockGroupDurationMs =
          (Number(this.readUint(data)) * this.timestampScaleNs) / 1e6
        break
      case EBML_IDS.SAMPLING_FREQ: {
        if (!this.trackScratch) break
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
        // Matroska Float 元素可为 4 或 8 字节；ffmpeg 写出的 MKV 常见 8 字节
        this.trackScratch.samplingRate =
          data.byteLength === 4
            ? dv.getFloat32(0)
            : data.byteLength === 8
              ? dv.getFloat64(0)
              : Number(this.readUint(data)) || null
        break
      }
      case EBML_IDS.CHANNELS:
        if (this.trackScratch)
          this.trackScratch.channels = Number(this.readUint(data))
        break
      case EBML_IDS.PIXEL_WIDTH:
        if (this.trackScratch)
          this.trackScratch.pixelWidth = Number(this.readUint(data))
        break
      case EBML_IDS.PIXEL_HEIGHT:
        if (this.trackScratch)
          this.trackScratch.pixelHeight = Number(this.readUint(data))
        break
      case EBML_IDS.TIMECODE: {
        const ts = Number(this.readUint(data))
        this.currentClusterTimestampMs = (ts * this.timestampScaleNs) / 1e6
        this.clusterIndex.push({
          timestampMs: this.currentClusterTimestampMs,
          offset: this.pendingClusterHeaderStart,
        })
        this.cb.onClusterIndexed?.(
          this.currentClusterTimestampMs,
          this.pendingClusterHeaderStart
        )
        break
      }
      case EBML_IDS.SIMPLE_BLOCK:
      case EBML_IDS.BLOCK:
        if (this.currentClusterTimestampMs !== null) {
          this.parseBlock(
            data,
            this.currentClusterTimestampMs,
            id === EBML_IDS.SIMPLE_BLOCK
          )
        }
        break
      default:
        break
    }
  }

  /** 读大端无符号整数 */
  private readUint(data: Uint8Array): number {
    let v = 0
    for (let i = 0; i < Math.min(data.length, 6); i++) v = v * 256 + data[i]!
    return v
  }

  /**
   * 解析 SimpleBlock / Block：
   * [VINT trackNumber][int16 relTimecode][flags][frames...(+lacing)]
   */
  private parseBlock(
    data: Uint8Array,
    clusterTimestampMs: number,
    simple: boolean
  ): void {
    if (data.length < 4) return
    let p = 0
    const first = data[p++]!
    if (first === 0) return
    let trackNumLen = 1
    let mask = 0x80
    while (!(first & mask)) {
      trackNumLen++
      mask >>= 1
      if (trackNumLen > 4) return
    }
    let trackNumber = first & (mask - 1)
    for (let i = 1; i < trackNumLen; i++)
      trackNumber = trackNumber * 256 + data[p++]!

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const relTimecode = dv.getInt16(p)
    p += 2

    const flags = data[p++] ?? 0
    const keyframe = simple && !!(flags & 0x80)
    const lacing = (flags >> 1) & 0x3
    let frameCount = 1
    if (lacing !== 0) frameCount = (flags & 0x3) + 1

    const baseMs = clusterTimestampMs + relTimecode
    let frames: Uint8Array[]

    if (lacing === 0) {
      frames = [data.subarray(p)]
    } else if (lacing === 2) {
      // fixed-size lacing
      const each = Math.floor((data.length - p) / frameCount)
      frames = []
      for (let i = 0; i < frameCount; i++)
        frames.push(data.subarray(p + i * each, p + (i + 1) * each))
    } else if (lacing === 1) {
      // Xiph lacing：每帧长度用 255-续位字节编码（首帧起均显式存储，共 n-1 个）
      const sizes: number[] = []
      for (let i = 0; i < frameCount - 1; i++) {
        let size = 0
        let b = 255
        while (b === 255 && p < data.length) {
          b = data[p++]!
          size += b
        }
        sizes.push(size)
      }
      const consumed = sizes.reduce((a, b) => a + b, 0)
      sizes.push(Math.max(0, data.length - p - consumed))
      frames = splitBySizes(data, p, sizes)
    } else {
      // EBML lacing：首帧绝对 VINT，后续为带符号差值
      const viewL = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const firstRes = readVint(viewL, p, data.length - p)
      if (firstRes === 'need-more' || !firstRes) return
      let prev = firstRes.value
      const sizes: number[] = [prev]
      p += firstRes.length
      for (let i = 1; i < frameCount - 1; i++) {
        const dRes = readVint(viewL, p, data.length - p)
        if (dRes === 'need-more' || !dRes) return
        const bias = Math.pow(2, dRes.length * 7 - 1) - 1
        prev += dRes.value - bias
        sizes.push(prev)
        p += dRes.length
      }
      const consumed = sizes.reduce((a, b) => a + b, 0)
      sizes.push(Math.max(0, data.length - p - consumed))
      frames = splitBySizes(data, p, sizes)
    }

    for (const f of frames) {
      if (f.length === 0) continue
      const frame: DemuxedFrame = {
        trackNumber,
        timestampMs: baseMs,
        keyframe,
        data: f.slice(),
        durationMs: null,
      }
      // Block（非 SimpleBlock）位于 BlockGroup 内：登记以供组关闭时回填
      // BlockDuration；SimpleBlock 恒无时长
      if (!simple) this.blockGroupFrames.push(frame)
      this.cb.onFrame?.(frame)
    }
  }

  /** BlockGroup 内当前显式时长与已发帧（关闭时回填） */
  private blockGroupDurationMs: number | null = null
  private blockGroupFrames: DemuxedFrame[] = []
}

function splitBySizes(
  data: Uint8Array,
  start: number,
  sizes: number[]
): Uint8Array[] {
  const out: Uint8Array[] = []
  let p = start
  for (const s of sizes) {
    out.push(data.subarray(p, p + s))
    p += s
  }
  return out
}

function decodeAscii(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]!)
  return s.trim()
}

const utf8Decoder = new TextDecoder('utf-8')
function decodeUtf8(data: Uint8Array): string {
  return utf8Decoder.decode(data).trim()
}
