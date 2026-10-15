/**
 * 采集侧实测帧率计（借鉴 ZViewerAPP screenShareFrameMeter.ts）。
 *
 * 通过 MediaStreamTrackProcessor 读取 track 的 clone 流并纯计数帧，
 * 不重新编码、不碰发送中的 track，几乎零开销。
 *
 * 与 outbound-rtp 的发送帧率（framesPerSecond，混入编码+网络因素）不同，
 * 本帧率计测的是「捕获源真实产出帧率」，用于定位瓶颈：
 * - 采集帧率低 → 捕获源/机器问题，调发送参数无效；
 * - 采集帧率高、发送帧率低 → 编码器在丢帧（CPU 过载或带宽不足）。
 */

interface FrameProcessor {
  readable: ReadableStream<{ close(): void }>
}

export interface CaptureFrameMeter {
  /** 返回最近一次采样的实测帧率；尚无采样数据时返回 undefined */
  sample(): number | undefined
  stop(): void
}

export function createCaptureFrameMeter(
  track: MediaStreamTrack
): CaptureFrameMeter | undefined {
  const Processor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor?: new (options: {
        track: MediaStreamTrack
      }) => FrameProcessor
    }
  ).MediaStreamTrackProcessor
  // 不支持 MediaStreamTrackProcessor 的环境（如 Firefox 旧版）静默降级，不影响共享
  if (!Processor) return undefined

  const clone = track.clone()
  let reader: ReadableStreamDefaultReader<{ close(): void }>
  try {
    reader = new Processor({ track: clone }).readable.getReader()
  } catch {
    clone.stop()
    return undefined
  }

  let active = true
  let frames = 0
  let lastFrames = 0
  let sampled = false
  let rate = 0
  let lastTime = performance.now()

  const stop = () => {
    if (!active) return
    active = false
    clone.stop()
    void reader.cancel().catch(() => {})
  }

  void (async () => {
    try {
      while (active) {
        const result = await reader.read()
        if (result.done) break
        try {
          if (active) frames++
        } finally {
          result.value.close()
        }
      }
    } catch {
      /* 帧率计任何异常都不允许中断采集 */
    } finally {
      stop()
    }
  })()

  return {
    sample() {
      const now = performance.now()
      const elapsed = now - lastTime
      if (!active) return undefined
      if (elapsed >= 500) {
        rate = Math.round(((frames - lastFrames) * 10000) / elapsed) / 10
        lastFrames = frames
        lastTime = now
        sampled = true
      }
      return sampled ? rate : undefined
    },
    stop,
  }
}
