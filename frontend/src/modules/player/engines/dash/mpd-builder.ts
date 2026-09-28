/**
 * MPD 构建纯函数模块（自研分片获取链路核心，从 DashPlayer 抽离）。
 *
 * 职责：将 B站 非标准 DASH 流（分离的 video/audio m4s）包装为 dash.js 可识别的
 * MPD manifest。B站 DASH 源特点：
 * - 非标准 DASH：没有 .mpd manifest，只有分离的 video.m4s + audio.m4s
 * - m4s 是 fragmented MP4（fMP4），包含 ftyp + moov + 多个 moof/mdat
 * - mvhd.duration 为 0（duration 在 moof 的 tfdt 中累积）
 * - B站 CDN 不返回 CORS 头，必须走后端 /api/stream/proxy 代理
 *
 * 虚拟 MPD 方案：
 * - type="static" + mediaPresentationDuration（来自后端权威值）
 * - 两个 AdaptationSet（video + audio），每个一个 Representation
 * - BaseURL 由调用方决定（流模式 = 代理 URL；缓冲模式 = 本地 blob URL）
 * - dash.js 会下载 m4s 头部（ftyp + moov），扫描 moof box 构建索引
 *
 * 本模块只做纯函数与网络读取，不持有引擎实例；调用方（videojs10-dash-engine）
 * 负责生命周期与取消。
 */
import { findAllSidxInBuffer, findMoovRange } from './mp4-box-parser'
import { resolveProxyUrl, isCliProxyUrl } from '../../services/url-proxy'

/** 预下载 init segment 的最大字节数（用于解析 sidx/moov） */
const INIT_SEGMENT_PRELOAD_BYTES = 256 * 1024 // 256KB
/** 二次扫描 sidx 的最大字节数（用于检测多 sidx 结构） */
const SIDX_SCAN_BYTES = 5 * 1024 * 1024 // 5MB

export interface DashSegmentInfo {
  startTime: number
  duration: number
  byteOffset: number
  byteSize: number
}

export interface DashInitInfo {
  sidxRange?: string
  moovRange?: string
  initRange?: string
  /** sidx 覆盖的总时长（秒），用于判断 sidx 是否完整 */
  sidxCoverage?: number
  /** 是否找到多个 sidx box */
  sidxCount?: number
  /** 从 sidx 解析出的 segment 列表 */
  segments?: DashSegmentInfo[]
  /** 文件总大小（从 Content-Length 获取） */
  totalSize?: number
  /** init segment 的结束位置（moov 之后） */
  initEnd?: number
}

/** preloadInitSegment 选项 */
export interface PreloadInitOptions {
  /** 媒体总时长（秒，来自后端权威值），用于 sidx 覆盖不足时的线性估算扩展 */
  duration?: number
  /** 取消信号（切源/卸载时中断头部队据拉取） */
  signal?: AbortSignal
}

/**
 * 流模式：通过服务器代理预下载 m4s 文件头部，解析 sidx 和 moov 的字节范围。
 *
 * 为什么需要预下载：
 * - B站 m4s 是 fMP4 格式，没有标准 MPD manifest
 * - dash.js 需要 sidx box（segment index）来计算 seek 目标位置的字节偏移
 * - 没有 sidx 时，dash.js 只能顺序播放，seek 会失败（不知道从哪里下载）
 *
 * 预下载策略：
 * 1. 首次下载 256KB，解析 moov 和第一个 sidx
 * 2. 如果 sidx 覆盖时长 < duration，下载 5MB 扫描所有 sidx box
 *    （B站 m4s 可能有多 sidx 结构，每个 sidx 索引一段视频）
 * 3. sidx 仍覆盖不足时，按平均 segment 时长/大小线性估算扩展
 */
export async function preloadInitSegment(
  url: string,
  options: PreloadInitOptions = {}
): Promise<DashInitInfo> {
  // 统一代理策略：DASH m4s 流始终走代理（有防盗链 + 无 CORS）
  const proxyUrl = resolveProxyUrl(url, undefined, 'dash')
  const info: DashInitInfo = {}
  // CLI 代理是跨域地址，不需要 credentials（Cookie），
  // credentials: 'include' 会导致 CORS 凭证策略冲突
  const credentialsMode: RequestCredentials = isCliProxyUrl(proxyUrl)
    ? 'omit'
    : 'include'
  const { duration, signal } = options

  try {
    const response = await fetch(proxyUrl, {
      headers: {
        Range: `bytes=0-${INIT_SEGMENT_PRELOAD_BYTES - 1}`,
      },
      credentials: credentialsMode,
      signal,
    })

    if (!response.ok && response.status !== 206) {
      console.warn(
        `[mpd-builder] 预下载 init segment 失败: status=${response.status}`
      )
      return info
    }

    // 从 Content-Range 提取文件总大小
    const contentRange = response.headers.get('Content-Range')
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/)
      if (match) {
        info.totalSize = parseInt(match[1], 10)
      }
    }
    if (!info.totalSize) {
      const contentLength = response.headers.get('Content-Length')
      if (contentLength) {
        info.totalSize = parseInt(contentLength, 10)
      }
    }

    const buffer = await response.arrayBuffer()

    // 解析 moov 范围（用于 init segment 标识）
    const moovRange = findMoovRange(buffer)
    if (moovRange) {
      info.moovRange = moovRange
      const moovEnd = parseInt(moovRange.split('-')[1], 10)
      info.initRange = `0-${moovEnd}`
      info.initEnd = moovEnd + 1
    }

    // 解析所有 sidx box
    const allSidx = findAllSidxInBuffer(buffer)
    if (allSidx.length > 0) {
      const firstSidx = allSidx[0]
      info.sidxRange = firstSidx.range
      info.sidxCount = allSidx.length

      const sidx = firstSidx.info
      if (sidx && sidx.references.length > 0) {
        const totalDuration =
          sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) /
          sidx.timescale
        info.sidxCoverage = totalDuration

        // 构建 segments 列表
        const segments: DashSegmentInfo[] = []
        let currentTime = sidx.earliestPresentationTime / sidx.timescale
        // sidx box 的结束位置 = firstOffset 之前的位置
        // firstOffset 是相对于 sidx box 之后的偏移量
        const sidxEnd = parseInt(firstSidx.range.split('-')[1], 10)
        let byteOffset = sidxEnd + 1 + sidx.firstOffset

        for (const ref of sidx.references) {
          segments.push({
            startTime: currentTime,
            duration: ref.subsegmentDuration / sidx.timescale,
            byteOffset,
            byteSize: ref.referencedSize,
          })
          currentTime += ref.subsegmentDuration / sidx.timescale
          byteOffset += ref.referencedSize
        }
        info.segments = segments

        if (duration && totalDuration < duration - 1) {
          console.warn(
            `[mpd-builder] sidx 覆盖不足 (${totalDuration.toFixed(1)}s < ${duration}s)`
          )

          if (allSidx.length === 1) {
            // 单 sidx：尝试二次扫描更大范围，检测是否有多 sidx 结构
            await scanForMoreSidx(proxyUrl, info, signal)
          }

          // 二次扫描后若仍覆盖不足，使用线性估算扩展 segments
          // B站 m4s 的 sidx 通常只索引前若干 segment，剩余部分需按已知 segment 的
          // 平均时长和大小估算，让 dash.js 能 seek 到 sidx 覆盖范围外的位置
          if (
            info.segments &&
            info.sidxCoverage &&
            info.sidxCoverage < duration - 1
          ) {
            info.segments = extendSegmentsWithLinearEstimation(
              info.segments,
              info.totalSize,
              duration
            )
            // 扩展后 sidxCoverage 已等于 duration，避免重复扩展
            info.sidxCoverage = duration
          }
        }
      }
    } else {
      console.warn('[mpd-builder] 未找到 sidx box，seek 可能无法正常工作')
    }

    return info
  } catch (err) {
    console.warn('[mpd-builder] 预下载 init segment 异常:', err)
    return info
  }
}

/**
 * 缓冲模式：从本地 Blob 解析 m4s 头部。
 *
 * 与 preloadInitSegment 相比：
 * - 无需网络请求，从 Blob slice 读取前 5MB
 * - 解析 sidx/moov 后立即释放切片，内存占用低
 * - 不会因网络问题失败
 */
export async function parseInitFromBlob(
  blob: Blob,
  duration?: number
): Promise<DashInitInfo> {
  const info: DashInitInfo = {}
  info.totalSize = blob.size

  // 切片前 5MB 解析 sidx/moov（足够覆盖多 sidx 结构）
  const sliceSize = Math.min(SIDX_SCAN_BYTES, blob.size)
  const slice = blob.slice(0, sliceSize)
  const buffer = await slice.arrayBuffer()

  // 解析 moov 范围
  const moovRange = findMoovRange(buffer)
  if (moovRange) {
    info.moovRange = moovRange
    const moovEnd = parseInt(moovRange.split('-')[1], 10)
    info.initRange = `0-${moovEnd}`
    info.initEnd = moovEnd + 1
  }

  // 解析所有 sidx box
  const allSidx = findAllSidxInBuffer(buffer)
  if (allSidx.length > 0) {
    const firstSidx = allSidx[0]
    info.sidxRange = firstSidx.range
    info.sidxCount = allSidx.length

    const sidx = firstSidx.info
    if (sidx && sidx.references.length > 0) {
      const totalDuration =
        sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) /
        sidx.timescale
      info.sidxCoverage = totalDuration

      const segments: DashSegmentInfo[] = []
      let currentTime = sidx.earliestPresentationTime / sidx.timescale
      const sidxEnd = parseInt(firstSidx.range.split('-')[1], 10)
      let byteOffset = sidxEnd + 1 + sidx.firstOffset

      for (const ref of sidx.references) {
        segments.push({
          startTime: currentTime,
          duration: ref.subsegmentDuration / sidx.timescale,
          byteOffset,
          byteSize: ref.referencedSize,
        })
        currentTime += ref.subsegmentDuration / sidx.timescale
        byteOffset += ref.referencedSize
      }
      info.segments = segments

      // sidx 覆盖不足时使用线性估算扩展
      if (duration && totalDuration < duration - 1) {
        console.warn(
          `[mpd-builder] sidx 覆盖不足 (${totalDuration.toFixed(1)}s < ${duration}s)`
        )
        if (
          info.segments &&
          info.sidxCoverage &&
          info.sidxCoverage < duration - 1
        ) {
          info.segments = extendSegmentsWithLinearEstimation(
            info.segments,
            info.totalSize,
            duration
          )
          info.sidxCoverage = duration
        }
      }
    }
  } else {
    console.warn(
      '[mpd-builder] 缓冲模式：未找到 sidx box，seek 可能无法正常工作'
    )
  }

  return info
}

/**
 * 二次扫描：下载更大范围的数据，查找所有 sidx box。
 * 用于检测 B站 m4s 是否有多 sidx 结构。
 */
async function scanForMoreSidx(
  proxyUrl: string,
  info: DashInitInfo,
  signal?: AbortSignal
): Promise<void> {
  try {
    const response = await fetch(proxyUrl, {
      headers: {
        Range: `bytes=0-${SIDX_SCAN_BYTES - 1}`,
      },
      credentials: isCliProxyUrl(proxyUrl) ? 'omit' : 'include',
      signal,
    })

    if (!response.ok && response.status !== 206) {
      console.warn(`[mpd-builder] 二次扫描失败: status=${response.status}`)
      return
    }

    const buffer = await response.arrayBuffer()
    const allSidx = findAllSidxInBuffer(buffer)
    info.sidxCount = allSidx.length

    // 累加每个 sidx 的覆盖时长
    let totalCoverage = 0
    for (let i = 0; i < allSidx.length; i++) {
      const sidx = allSidx[i].info
      if (sidx && sidx.references.length > 0) {
        const duration =
          sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) /
          sidx.timescale
        totalCoverage += duration
      }
    }

    if (totalCoverage > 0) {
      info.sidxCoverage = totalCoverage
    }
  } catch (err) {
    console.warn('[mpd-builder] 二次扫描异常:', err)
  }
}

/**
 * 线性估算扩展 segments：当 sidx 覆盖不足时，基于已知 segments 的平均时长和大小
 * 估算剩余 segments，让 dash.js 能 seek 到 sidx 覆盖范围外的位置。
 *
 * 估算策略：
 * - 使用最后 5 个 segment 的平均时长和大小作为估算基准（末尾 segment 更接近未知的剩余部分）
 * - 从最后一个 segment 的字节位置开始，按平均值逐步扩展
 * - 扩展到 duration 或 totalSize（如果已知）
 *
 * 精度说明：
 * - B站 m4s 的 segment 大小通常在 ±20% 范围内波动，估算位置可能略有偏差
 * - dash.js 在 seek 到估算位置后，会从该位置附近的 moof 开始解析
 * - 即使字节位置略有偏差，dash.js 能通过扫描 moof box 找到正确的 segment
 */
export function extendSegmentsWithLinearEstimation(
  segments: DashSegmentInfo[],
  totalSize: number | undefined,
  duration: number | undefined
): DashSegmentInfo[] {
  if (segments.length === 0 || !duration) {
    return segments
  }

  const lastSeg = segments[segments.length - 1]
  const coveredDuration = lastSeg.startTime + lastSeg.duration
  const coveredBytes = lastSeg.byteOffset + lastSeg.byteSize

  // 如果 sidx 已覆盖完整，不需要扩展
  if (coveredDuration >= duration - 1) {
    return segments
  }

  // 验证 totalSize 合理性：
  // 后端代理可能未返回 Content-Range 头，导致 totalSize 被错误地设置为
  // 分片大小（如 256KB）而非完整文件大小。如果 totalSize 小于已覆盖字节数，
  // 视为无效，忽略它（仅按 duration 扩展）
  const validTotalSize =
    totalSize && totalSize > coveredBytes + 1024 ? totalSize : undefined

  if (totalSize && !validTotalSize) {
    console.warn(
      `[mpd-builder] totalSize=${totalSize} 小于已覆盖字节 ${coveredBytes}，视为无效，忽略 totalSize`
    )
  }

  // 使用末尾 5 个 segment（或全部，如果不足 5 个）的平均时长和大小
  // 末尾 segment 更接近剩余部分的特征
  const sampleSize = Math.min(5, segments.length)
  const sample = segments.slice(-sampleSize)
  const estDuration =
    sample.reduce((sum, s) => sum + s.duration, 0) / sample.length
  const estSize = sample.reduce((sum, s) => sum + s.byteSize, 0) / sample.length

  if (estDuration <= 0 || estSize <= 0) {
    console.warn(
      '[mpd-builder] 线性估算失败: 平均时长或大小为 0',
      `estDuration=${estDuration}, estSize=${estSize}`
    )
    return segments
  }

  const extended: DashSegmentInfo[] = [...segments]
  let currentTime = coveredDuration
  let byteOffset = coveredBytes

  // 扩展到 duration 或 totalSize
  const maxIterations = 5000 // 防止无限循环
  let iter = 0

  while (currentTime < duration && iter < maxIterations) {
    // 如果 totalSize 已知且 byteOffset 接近或超过 totalSize，停止
    if (validTotalSize && byteOffset + estSize > validTotalSize) {
      // 最后一个 segment 可能小于平均值，按比例调整
      const remainingBytes = validTotalSize - byteOffset
      if (remainingBytes > 0) {
        const ratio = remainingBytes / estSize
        extended.push({
          startTime: currentTime,
          duration: estDuration * ratio,
          byteOffset,
          byteSize: remainingBytes,
        })
      }
      break
    }

    extended.push({
      startTime: currentTime,
      duration: estDuration,
      byteOffset,
      byteSize: estSize,
    })

    currentTime += estDuration
    byteOffset += estSize
    iter++
  }

  return extended
}

/** generateMpd 选项 */
export interface GenerateMpdOptions {
  /** 视频 m4s 的 BaseURL（流模式 = 代理 URL；缓冲模式 = 本地 blob URL） */
  videoUrl: string
  /** 音频 m4s 的 BaseURL */
  audioUrl: string
  /** 视频编码（如 'avc1.64001E'），用于 MPD codecs 属性 */
  videoCodec?: string
  /** 音频编码（如 'mp4a.40.2'），用于 MPD codecs 属性 */
  audioCodec?: string
  /** 媒体总时长（秒，后端权威值），用于 mediaPresentationDuration */
  duration?: number
  /** 头部解析结果（sidx/moov 位置与 segments 列表） */
  initInfo: DashInitInfo
}

/**
 * 生成虚拟 MPD manifest。
 *
 * 结构：
 * - MPD type="static"，mediaPresentationDuration 来自后端权威值
 * - 单个 Period
 * - 两个 AdaptationSet（video + audio），每个一个 Representation
 *
 * sidx 覆盖判断：
 * - sidx 覆盖完整（sidxCoverage >= duration）：使用 SegmentBase + indexRange，seek 快速准确
 * - sidx 覆盖不足（sidxCoverage < duration）：用线性估算扩展 segments，使用 SegmentList
 *   这样 dash.js 能基于估算的 segment 列表进行 seek，虽然精度略低但能正常跳转
 */
export function generateMpd(options: GenerateMpdOptions): string {
  const { videoUrl, audioUrl, videoCodec, audioCodec, duration, initInfo } =
    options
  const durationValue = duration ?? 0
  const durationStr = `PT${durationValue}S`
  const vCodec = videoCodec || 'avc1.64001E'
  const aCodec = audioCodec || 'mp4a.40.2'
  const sidxRange = initInfo.sidxRange
  const segments = initInfo.segments
  const initEnd = initInfo.initEnd

  let videoSegmentInfo = ''

  if (segments && segments.length > 0 && initEnd !== undefined) {
    // 使用 SegmentList + SegmentTimeline（支持不等长 segments）
    // SegmentTimeline 指定每个 segment 的精确时长和起始时间，
    // 让 dash.js 能准确计算 seek 目标位置对应的 segment
    const initRange = initInfo.initRange || `0-${initEnd - 1}`

    // SegmentTimeline: 第一个 S 需要 t 属性指定起始时间，后续继承
    const timelineEntries = segments
      .map((seg, i) => {
        const d = Math.round(seg.duration * 1000)
        if (i === 0) {
          return `        <S t="${Math.round(seg.startTime * 1000)}" d="${d}" />`
        }
        return `        <S d="${d}" />`
      })
      .join('\n')

    const segmentUrls = segments
      .map(
        (seg) =>
          `      <SegmentURL mediaRange="${seg.byteOffset}-${seg.byteOffset + seg.byteSize - 1}"/>`
      )
      .join('\n')

    videoSegmentInfo = `<SegmentList timescale="1000">
        <Initialization range="${initRange}" />
        <SegmentTimeline>
${timelineEntries}
        </SegmentTimeline>
${segmentUrls}
      </SegmentList>`
  } else if (sidxRange) {
    // fallback: SegmentBase + indexRange
    const sidxStart = parseInt(sidxRange.split('-')[0], 10)
    const initEndForBase = sidxStart - 1
    videoSegmentInfo = `<SegmentBase indexRange="${sidxRange}">
        <Initialization range="0-${initEndForBase}" />
      </SegmentBase>`
  }

  const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${durationStr}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-main:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="${escapeXml(vCodec)}" contentType="video" startWithSAP="1" segmentAlignment="true">
      <Representation id="v" bandwidth="1000000" codecs="${escapeXml(vCodec)}" mimeType="video/mp4">
        <BaseURL>${escapeXml(videoUrl)}</BaseURL>
        ${videoSegmentInfo}
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="${escapeXml(aCodec)}" contentType="audio" startWithSAP="1" segmentAlignment="true">
      <Representation id="a" bandwidth="128000" codecs="${escapeXml(aCodec)}" mimeType="audio/mp4">
        <BaseURL>${escapeXml(audioUrl)}</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

  return mpd
}

/** XML 特殊字符转义 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
