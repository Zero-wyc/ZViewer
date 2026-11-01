/**
 * 观众端 answer 的 Opus 接收上限。
 *
 * 为什么必须由客户端改 SDP：服务端 SFU 只在接收侧声明自己能不能载动共享的
 * Opus 源（`forwarding.CheckAudioReceiveLimit`），而浏览器生成的 answer 默认
 * 只有 `minptime=10;useinbandfec=1`——没有 `maxaveragebitrate` 就按 libwebrtc
 * 的 32kbps 默认值算，128kbps 的共享音频会被判「带不动」，整条中继订阅被拒。
 * Piik 的 `webrtc/opus-receive-sdp.ts` 就是这么补的。
 *
 * 这里只补 `maxaveragebitrate`，不动 `stereo`：屏幕音频多是单声道混音，硬写
 * stereo=1 会逼发布端按立体声编码，白占码率。
 *
 * 纯字符串处理，不引 sdp-transform（只为改一行 fmtp 加一个依赖不划算）。
 */

/** 与服务端 `sfu.audioBitrateCeiling` 保持一致（510kbps）。 */
export const OPUS_RECEIVE_MAX_BITRATE = 510_000

const OPUS_RTPMAP = /^a=rtpmap:(\d+)\s+opus\//i
const FMTP_PREFIX = /^a=fmtp:(\d+)\s*(.*)$/i

interface AudioSection {
  /** 已有行。 */
  lines: string[]
  /** opus payload → 它在 lines 里的下标（用于缺 fmtp 时补一行）。 */
  opusAt: Map<string, number>
  /** 已经有 fmtp 的 opus payload。 */
  withFmtp: Set<string>
}

function patchFmtp(line: string, bitrate: number): string {
  const matched = FMTP_PREFIX.exec(line)
  if (!matched) return line
  const parameters = matched[2]!
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => !/^maxaveragebitrate=/i.test(item))
  parameters.push(`maxaveragebitrate=${bitrate}`)
  return `a=fmtp:${matched[1]} ${parameters.join(';')}`
}

function flushSection(section: AudioSection, bitrate: number): string[] {
  const lines = [...section.lines]
  // 从后往前插，下标才不会漂移。
  const missing = [...section.opusAt.entries()]
    .filter(([payload]) => !section.withFmtp.has(payload))
    .sort((left, right) => right[1] - left[1])
  for (const [payload, index] of missing) {
    lines.splice(index + 1, 0, `a=fmtp:${payload} maxaveragebitrate=${bitrate}`)
  }
  return lines
}

/**
 * 给音频段里的 Opus 补上接收上限；解析不了就当没这回事，原样返回。
 *
 * 只处理 `m=audio` 段：`m=video` / `m=application` 的 payload 编号与音频段
 * 各自独立，跨段改会写错编码。
 */
export function preferOpusReceiveLimit(
  sdp: string,
  bitrate: number = OPUS_RECEIVE_MAX_BITRATE
): string {
  if (!sdp || !Number.isInteger(bitrate) || bitrate <= 0) return sdp
  const lines = sdp.split(/\r\n|\n/)
  const out: string[] = []
  let section: AudioSection | null = null

  const close = () => {
    if (!section) return
    out.push(...flushSection(section, bitrate))
    section = null
  }

  for (const line of lines) {
    if (line.startsWith('m=')) {
      close()
      if (line.startsWith('m=audio')) {
        section = { lines: [line], opusAt: new Map(), withFmtp: new Set() }
      } else {
        out.push(line)
      }
      continue
    }
    if (!section) {
      out.push(line)
      continue
    }
    const rtp = OPUS_RTPMAP.exec(line)
    if (rtp) {
      section.opusAt.set(rtp[1]!, section.lines.length)
      section.lines.push(line)
      continue
    }
    const fmtp = FMTP_PREFIX.exec(line)
    if (fmtp && section.opusAt.has(fmtp[1]!)) {
      section.withFmtp.add(fmtp[1]!)
      section.lines.push(patchFmtp(line, bitrate))
      continue
    }
    section.lines.push(line)
  }
  close()
  return out.join('\r\n')
}
