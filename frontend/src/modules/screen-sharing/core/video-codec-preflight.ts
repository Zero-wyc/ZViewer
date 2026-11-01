/**
 * 开播前的编码探针：一块「必然满帧」的合成画布 + 一条回环 PC。
 *
 * 照搬 Piik `src/client/webrtc/video-codec-preflight.ts`（MIT）。判定层拆在
 * `codec-preflight-judge.ts`（纯函数，可单测），这里只剩驱动：造源、跑一次
 * 回环协商、按预算轮询。
 *
 * **为什么源必须自己刷满帧**（这是整套预检的地基，改它结论就废了）：
 *
 *  1. 探针源不是屏幕，是一块 canvas：每个 tick 重绘 24×14 个色块，色相随
 *     帧号变化，再加一条按帧号平移的白扫线。canvas 采集是绘制驱动，每 tick
 *     都画且像素确实变了，所以每个 tick 必出一帧——与真实内容动不动无关。
 *  2. `captureStream(target.frameRate)` 的帧率与 `setInterval` 的间隔取自
 *     同一个 `profile.maxFramerate`，源在构造上不可能供不上被测的目标。
 *  3. `contentHint = 'motion'`：告诉编码器这是高运动内容，拥塞/CPU 吃紧时
 *     优先掉分辨率而不是丢帧。
 *
 * 于是判定层「源不够」那一支永远不会成立，整条判据退化成纯编码器能力测试。
 */
import {
  allowedFrameLag,
  h264ProbeSustainsTarget,
  hasProbeWindow,
  h264ProbeTarget,
  readH264ProbeSample,
  type H264ProbeSample,
} from './codec-preflight-judge'
import {
  configureVideoSender,
  startupVideoProfile,
  type QualityProfile,
} from './quality'
import {
  applyH264ProbeCodec,
  normalizeVideoOfferSdp,
  type BrowserVideoCodec,
} from './video-codec'

/** 整条探针（建 PC + ICE + 测量）的硬预算；超时按「编不动」处理。 */
const PREFLIGHT_DEADLINE_MS = 4_000
/** 轮询 `getStats` 的间隔。 */
const PREFLIGHT_POLL_MS = 100
/** 预热窗口：ICE 刚通时首个窗口的统计带着建连抖动，不能用来判定。 */
const PREFLIGHT_WARMUP_MS = 500

interface H264ProbeTrack {
  track: MediaStreamTrack
  stop: () => void
}

/**
 * 画第 `frame` 帧。
 *
 * **每帧全屏都在变**：色相 = `(frame*29 + row*71 + column*43) % 360`，帧号
 * 一加全盘换色；再叠一条按帧号平移的白扫线。既没有静止区域（否则编码器
 * 可以「没变就不编」），也不是纯噪声（纯噪声的码率开销不代表真实桌面）。
 */
function drawProbeFrame(
  context: CanvasRenderingContext2D,
  target: { width: number; height: number },
  frame: number
): void {
  const columns = 24
  const rows = 14
  const tileWidth = Math.ceil(target.width / columns)
  const tileHeight = Math.ceil(target.height / rows)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const hue = (frame * 29 + row * 71 + column * 43) % 360
      const lightness = 35 + ((frame + row + column) % 30)
      context.fillStyle = `hsl(${hue} 80% ${lightness}%)`
      context.fillRect(
        column * tileWidth,
        row * tileHeight,
        tileWidth,
        tileHeight
      )
    }
  }
  const sweep =
    (frame * Math.max(8, Math.floor(target.width / 120))) % target.width
  context.fillStyle = '#ffffff'
  context.fillRect(
    sweep,
    0,
    Math.max(4, Math.floor(target.width / 180)),
    target.height
  )
}

/**
 * 建探针轨。
 *
 * 源轨道只用来读 `getSettings()`（尺寸），**不参与探针**——探针发的是这块
 * canvas，所以考编码器这件事完全不影响真实的共享画面，也不需要向浏览器
 * 再要一次采集权限。
 */
function createH264ProbeTrack(
  source: MediaStreamTrack,
  profile: QualityProfile
): H264ProbeTrack | null {
  if (typeof document === 'undefined') return null
  const target = h264ProbeTarget(source.getSettings(), profile)
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context || typeof canvas.captureStream !== 'function') return null
  const stream = canvas.captureStream(target.frameRate)
  const track = stream.getVideoTracks()[0]
  if (!track) return null
  track.contentHint = 'motion'
  let frame = 1
  drawProbeFrame(context, target, frame)
  const timer = window.setInterval(() => {
    frame += 1
    drawProbeFrame(context, target, frame)
  }, 1_000 / target.frameRate)
  return {
    track,
    stop: () => {
      window.clearInterval(timer)
      track.stop()
    },
  }
}

/**
 * 加远端候选。
 *
 * 过期候选抛的是 `OperationError`：那是可丢弃的输入，不是 SDP 失败，也不代表
 * 传输死了（Piik `nat-prediction.ts:35-54` 的口径；ZViewer 只走标准 ICE，没有
 * 「预测候选」那一支）。其它错误交给调用方——那说明这条 PC 真的有问题。
 */
async function addProbeCandidate(
  connection: RTCPeerConnection,
  candidate: RTCIceCandidate
): Promise<void> {
  try {
    await connection.addIceCandidate(candidate)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'OperationError')) {
      throw error
    }
  }
}

/**
 * 跑一次探针。
 *
 * 一条 PC 发、一条 PC 收，`iceServers: []`（纯本地回环，不出网）。所有
 * await 都挂在同一份 4 秒预算上：关 PC 不会让挂起的 SDP 操作自然结算，
 * 不这样做超时之后就会永远卡在这里。
 */
async function runH264Probe(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal
): Promise<boolean> {
  const senderConnection = new RTCPeerConnection({ iceServers: [] })
  let receiver: RTCPeerConnection | undefined
  let pollTimer: number | undefined
  let stopReason: Error | undefined
  let stop!: (reason: Error) => void
  const stopped = new Promise<never>((_, reject) => {
    stop = (reason) => {
      stopReason ??= reason
      reject(stopReason)
    }
  })
  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopReason) throw stopReason
    const value = await Promise.race([operation(), stopped])
    if (stopReason) throw stopReason
    return value
  }
  const abort = () =>
    stop(new DOMException('Codec probe cancelled', 'AbortError'))
  const timer = window.setTimeout(
    () => stop(new Error('Codec probe timed out')),
    PREFLIGHT_DEADLINE_MS
  )
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const receiverConnection = (receiver = new RTCPeerConnection({
      iceServers: [],
    }))
    // 回环探测：只要有一对本地候选能通就可以开始编码，不必等候选收全。
    const senderCandidates: RTCIceCandidate[] = []
    const receiverCandidates: RTCIceCandidate[] = []
    let senderRemoteReady = false
    let receiverRemoteReady = false
    let iceFailed = false
    const addCandidate = async (
      target: RTCPeerConnection,
      candidate: RTCIceCandidate
    ): Promise<void> => {
      try {
        await addProbeCandidate(target, candidate)
      } catch {
        iceFailed = true
      }
    }
    senderConnection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      if (receiverRemoteReady) {
        void addCandidate(receiverConnection, event.candidate)
      } else {
        senderCandidates.push(event.candidate)
      }
    })
    receiverConnection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      if (senderRemoteReady) {
        void addCandidate(senderConnection, event.candidate)
      } else {
        receiverCandidates.push(event.candidate)
      }
    })
    const transceiver = senderConnection.addTransceiver(track, {
      direction: 'sendonly',
    })
    // 只留 H.264：探针考的是它，浏览器换成 VP8 就白考了。
    if (!applyH264ProbeCodec(transceiver)) return false
    await wait(() =>
      configureVideoSender(transceiver.sender, startupVideoProfile(profile))
    )
    const offer = await wait(() => senderConnection.createOffer())
    await wait(() => senderConnection.setLocalDescription(offer))
    await wait(() =>
      receiverConnection.setRemoteDescription({
        type: 'offer',
        // Firefox 在 setCodecPreferences 之后可能残留已排除编码的 fmtp 行，
        // Chromium 解析这种 offer 会整份失败。
        sdp: normalizeVideoOfferSdp(senderConnection.localDescription!.sdp),
      })
    )
    receiverRemoteReady = true
    await wait(() =>
      Promise.all(
        senderCandidates
          .splice(0)
          .map((candidate) => addCandidate(receiverConnection, candidate))
      )
    )
    const answer = await wait(() => receiverConnection.createAnswer())
    await wait(() => receiverConnection.setLocalDescription(answer))
    await wait(() =>
      senderConnection.setRemoteDescription(
        receiverConnection.localDescription!
      )
    )
    senderRemoteReady = true
    await wait(() =>
      Promise.all(
        receiverCandidates
          .splice(0)
          .map((candidate) => addCandidate(senderConnection, candidate))
      )
    )

    const frameLag = allowedFrameLag(profile.maxFramerate, PREFLIGHT_POLL_MS)
    let warmupBaseline: H264ProbeSample | null = null
    let measurementBaseline: H264ProbeSample | null = null
    for (;;) {
      if (signal?.aborted || track.readyState === 'ended' || iceFailed) {
        return false
      }
      const sample = readH264ProbeSample(
        await wait(() => transceiver.sender.getStats())
      )
      if (sample) {
        warmupBaseline ??= sample
        if (
          !measurementBaseline &&
          sample !== warmupBaseline &&
          hasProbeWindow(warmupBaseline, sample, PREFLIGHT_WARMUP_MS)
        ) {
          measurementBaseline = sample
        } else if (measurementBaseline && sample !== measurementBaseline) {
          const result = h264ProbeSustainsTarget(
            measurementBaseline,
            sample,
            profile.maxFramerate,
            frameLag
          )
          if (result !== null) return result
        }
      }
      await wait(
        () =>
          new Promise<void>((resolve) => {
            pollTimer = window.setTimeout(resolve, PREFLIGHT_POLL_MS)
          })
      )
    }
  } finally {
    window.clearTimeout(timer)
    window.clearTimeout(pollTimer)
    signal?.removeEventListener('abort', abort)
    senderConnection.close()
    receiver?.close()
  }
}

/**
 * 这份画面能满帧编 H.264 吗？
 *
 * 任何异常（探针源建不出来、`getStats` 形状不认识、超时、被取消）都返回
 * `'vp8'`：**证明不了能用 H.264，就不要用**——软编 H.264 跑不动的表现是
 * 持续卡顿，比画面软一点更难排查。
 */
export async function preferredVideoCodecForTrack(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal
): Promise<BrowserVideoCodec> {
  if (
    signal?.aborted ||
    track.kind !== 'video' ||
    track.readyState === 'ended'
  ) {
    return 'vp8'
  }
  let probe: H264ProbeTrack | null = null
  try {
    probe = createH264ProbeTrack(track, profile)
    return probe && (await runH264Probe(probe.track, profile, signal))
      ? 'h264'
      : 'vp8'
  } catch {
    return 'vp8'
  } finally {
    probe?.stop()
  }
}
