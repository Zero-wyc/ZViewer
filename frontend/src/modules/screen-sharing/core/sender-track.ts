/**
 * 发送端独占的视频轨。
 *
 * 为什么不能直接把采集轨塞进 sender：Chromium 会把编码器的软像素目标
 * 作为**采集硬约束**回灌到原始 track 上。一旦带宽下降导致编码器降分辨率，
 * 采集源本身就被永久改小，之后即使带宽恢复，编码器也拿不回细节——
 * 表现为「切一次分辨率/卡一次之后就一直是糊的」。
 *
 * 解法照搬 Piik `src/client/media/sender-video-track.ts`：sender 用一条
 * 由 MediaStreamTrackProcessor → MediaStreamTrackGenerator 派生的轨道转发
 * 原始帧，采集约束作用在**输入轨**上，输出轨对编码器完全透明（帧不重编码、
 * 不加帧时钟、不改分辨率策略）。
 */

type FrameTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> }

interface FrameAPIs {
  MediaStreamTrackProcessor?: new (options: {
    track: MediaStreamTrack
    maxBufferSize: number
  }) => { readable: ReadableStream<VideoFrame> }
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => FrameTrack
}

/** 输出轨 → 它的采集输入轨与停止开关。 */
const inputs = new WeakMap<
  MediaStreamTrack,
  { track: MediaStreamTrack; abort: AbortController }
>()

/**
 * 派生一条发送端专用视频轨。
 *
 * 只有屏幕采集（`getSettings().displaySurface` 存在）才走帧隔离；摄像头
 * 与已停止的轨直接 clone——这两种情况编码器不会回灌采集约束。
 */
export function cloneSenderVideoTrack(
  source: MediaStreamTrack,
  onEnded: (track: MediaStreamTrack) => void
): MediaStreamTrack {
  const input = source.clone()
  input.contentHint = source.contentHint || 'motion'
  input.enabled = source.enabled
  const {
    MediaStreamTrackProcessor: Processor,
    MediaStreamTrackGenerator: Generator,
  } = globalThis as typeof globalThis & FrameAPIs
  if (
    !Processor ||
    !Generator ||
    !source.getSettings().displaySurface ||
    input.readyState !== 'live'
  ) {
    return input
  }

  let output: FrameTrack | undefined
  let readable: ReadableStream<VideoFrame> | undefined
  try {
    output = new Generator({ kind: 'video' })
    readable = new Processor({ track: input, maxBufferSize: 1 }).readable
  } catch {
    output?.stop()
    return input
  }

  const abort = new AbortController()
  const track = output
  const frames = readable
  // 输入轨必须保持 enabled：帧隔离靠 Processor 拉帧，轨道被 disable 就没帧了。
  input.enabled = true
  track.contentHint = input.contentHint
  track.enabled = source.enabled
  inputs.set(track, { track: input, abort })
  void applySenderCaptureConstraints(track, input.getConstraints())
    .then(() => frames.pipeTo(track.writable, { signal: abort.signal }))
    .catch(() => undefined)
    .finally(() => {
      inputs.delete(track)
      void frames.cancel().catch(() => undefined)
      input.stop()
      track.stop()
      if (!abort.signal.aborted) onEnded(track)
    })
  return track
}

/** 取回输出轨背后的采集输入轨（约束要作用在它上面）。 */
export function senderCaptureTrack(track: MediaStreamTrack): MediaStreamTrack {
  return inputs.get(track)?.track ?? track
}

/**
 * 应用采集约束。
 *
 * 帧隔离轨没有底层采集设备，`applyConstraints` 不会生效；必须透传到输入轨。
 * 同时给帧率加 `min: 1`——Processor 不像 RTC sender 那样会主动请求空闲重绘帧，
 * 没有下限时静态画面会彻底停帧，观众端看起来像断了。
 */
export function applySenderCaptureConstraints(
  track: MediaStreamTrack,
  constraints: MediaTrackConstraints
): Promise<void> {
  const input = inputs.get(track)?.track
  if (!input) return track.applyConstraints(constraints)
  const rate = constraints.frameRate
  const range: ConstrainDoubleRange =
    typeof rate === 'number'
      ? { ideal: rate }
      : rate && typeof rate === 'object'
        ? { ...rate }
        : {}
  return input.applyConstraints({
    ...constraints,
    frameRate: { ...range, min: 1 },
  })
}

/** 彻底停止一条发送端视频轨（连同它的输入轨与泵）。 */
export function stopSenderVideoTrack(track: MediaStreamTrack | null): void {
  if (!track) return
  const input = inputs.get(track)
  input?.abort.abort()
  input?.track.stop()
  track.stop()
}
