/**
 * 视频编码偏好与 SDP 归一化。
 *
 * 直接搬 Piik `src/client/webrtc/video-codec.ts` 的两个纯函数（MIT），
 * 去掉需要 `sdp-transform` 的接收侧校验（那是观众侧 P2 的事）。
 *
 * 为什么必须显式偏好：Chrome 的默认顺序里 VP8 常排在前面，而屏幕共享在
 * 60fps 下 VP8 是纯软件编码，CPU 开销直接吃掉可用的帧率。H.264 有硬件
 * 编码路径，桌面场景优先它；WebRTC 修复用的 RTX/RED/ULPFEC 必须跟着排在
 * 后面，否则 NACK 重传拿不到对端支持的封装。
 */
export type BrowserVideoCodec = 'h264' | 'vp8'

export interface BrowserVideoCodecPreference {
  primary: BrowserVideoCodec
  vp8Fallback: boolean
}

/** 只发 VP8：SFU 侧解码与 simulcast 的兼容性最稳（P3 发布端用这个）。 */
export const VP8_ONLY_VIDEO_CODEC: BrowserVideoCodecPreference = {
  primary: 'vp8',
  vp8Fallback: false,
}

/** H.264 优先、VP8 兜底：P2P 直连的默认选择（保留 ZViewer 原有行为）。 */
export const H264_PREFERRED_VIDEO_CODEC: BrowserVideoCodecPreference = {
  primary: 'h264',
  vp8Fallback: true,
}

const REPAIR_CODEC_MIME_TYPES = new Set([
  'video/rtx',
  'video/red',
  'video/ulpfec',
  'video/flexfec-03',
])

function videoCapabilities(): RTCRtpCodec[] {
  return RTCRtpSender.getCapabilities?.('video')?.codecs ?? []
}

function vp8Codecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType }) => mimeType.toLowerCase() === 'video/vp8')
}

function h264ModeOneCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType, sdpFmtpLine }) => {
    if (mimeType.toLowerCase() !== 'video/h264') return false
    return (
      !sdpFmtpLine || /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(sdpFmtpLine)
    )
  })
}

function repairCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType }) =>
    REPAIR_CODEC_MIME_TYPES.has(mimeType.toLowerCase())
  )
}

function applyCodecs(
  transceiver: RTCRtpTransceiver,
  codecs: RTCRtpCodec[]
): boolean {
  if (typeof transceiver.setCodecPreferences !== 'function') return false
  try {
    transceiver.setCodecPreferences(codecs)
    return true
  } catch {
    return false
  }
}

/**
 * 给 transceiver 应用编码偏好。
 *
 * 返回 false 表示浏览器不支持所要求的编码——调用方必须把它当成硬失败，
 * 而不是「将就用默认编码」：默认编码跑不动 60fps 时用户看到的是持续卡顿，
 * 比直接报错更难排查。
 */
export function applyVideoCodecPreference(
  transceiver: RTCRtpTransceiver,
  preference: BrowserVideoCodecPreference
): boolean {
  if (typeof RTCRtpSender === 'undefined') return false
  const codecs = videoCapabilities()
  const vp8 = vp8Codecs(codecs)
  if (
    (preference.primary === 'vp8' || preference.vp8Fallback) &&
    vp8.length === 0
  ) {
    return false
  }
  const h264 = preference.primary === 'h264' ? h264ModeOneCodecs(codecs) : []
  if (preference.primary === 'h264' && h264.length === 0) return false
  return applyCodecs(transceiver, [
    ...h264,
    ...(preference.primary === 'vp8' || preference.vp8Fallback ? vp8 : []),
    ...repairCodecs(codecs),
  ])
}

/**
 * 删掉被排除的编码在本地 offer 里残留的属性行。
 *
 * Firefox 在 `setCodecPreferences` 之后仍可能保留已排除编码的 `a=fmtp` /
 * `a=rtcp-fb`（Mozilla bug 1909443），Chromium 解析这种 offer 会整份失败——
 * 表现为「Firefox 房主 → Chrome 观众」完全连不上。这里只删属性行，不改
 * 编码选择、不动合法的反馈行、不碰 answer（answer 的 payload 类型可以不对称）。
 */
export function normalizeVideoOfferSdp(sdp: string): string {
  let payloads: Set<number> | null = null
  let changed = false
  const lines = sdp.split(/\r?\n/).filter((line) => {
    if (line.startsWith('m=')) {
      const fields = line.trim().split(/\s+/)
      payloads =
        fields[0] === 'm=video' && fields.length >= 4
          ? new Set(fields.slice(3).map(Number))
          : null
    }
    const attribute = /^a=(?:fmtp|rtcp-fb):(\d+)(?:\s|$)/.exec(line)
    if (payloads && attribute && !payloads.has(Number(attribute[1]))) {
      changed = true
      return false
    }
    return true
  })
  return changed ? lines.join(sdp.includes('\r\n') ? '\r\n' : '\n') : sdp
}
