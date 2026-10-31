/**
 * 首帧证明：观众真的解出一帧，路由才算成立。
 *
 * 为什么不能拿「连接已建立」当证据：DTLS/SRTP 都通了但编码参数不匹配时，
 * 画面是全黑的，连接状态却是 `connected`。Piik 用 `framesDecoded > 0`
 * 作为唯一可证实信号（`media/decoded-frame-proof.ts`），服务端也只在
 * 收到这个证明后才提交路由。
 *
 * 采样是观测性的：读统计失败不改变任何状态，交给恢复链的超时兜底。
 */

/** 采样间隔。100ms 足够快，又不会把 getStats 变成负担。 */
const DECODED_FRAME_PROOF_INTERVAL_MS = 100

export interface DecodedFrameProofOptions {
  /** 读当前已解码视频帧数；读不到返回 null。 */
  readFramesDecoded: () => Promise<number | null>
  /** 这条连接是否仍然归本次证明所有。 */
  owns: () => boolean
  /**
   * true 时要求帧数**增长**而不是大于 0。
   *
   * 切源后统计计数可能继承旧值，这时只有增长才能证明新画面真的在解。
   */
  requireProgress?: boolean
  /** 证明成功；返回 false 表示不予采纳（例如路由已经不是当前条），继续等。 */
  onProof: () => boolean
}

/** 开始观测，返回停止函数（幂等）。 */
export function observeDecodedFrameProof(
  options: DecodedFrameProofOptions
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let baseline: number | null = null

  const stop = (): void => {
    stopped = true
    if (timer !== null) {
      globalThis.clearTimeout(timer)
      timer = null
    }
  }

  const schedule = (): void => {
    if (stopped || !options.owns()) {
      stop()
      return
    }
    timer = globalThis.setTimeout(() => {
      timer = null
      void poll()
    }, DECODED_FRAME_PROOF_INTERVAL_MS)
  }

  const poll = async (): Promise<void> => {
    if (stopped || !options.owns()) {
      stop()
      return
    }
    try {
      const framesDecoded = await options.readFramesDecoded()
      if (stopped || !options.owns()) {
        stop()
        return
      }
      if (
        framesDecoded !== null &&
        Number.isFinite(framesDecoded) &&
        framesDecoded >= 0
      ) {
        let proved = false
        if (options.requireProgress) {
          if (baseline === null || framesDecoded < baseline) {
            baseline = framesDecoded
          } else {
            proved = framesDecoded > baseline
          }
        } else {
          proved = framesDecoded > 0
        }
        if (proved && options.onProof()) {
          stop()
          return
        }
      }
    } catch {
      // 观测失败不改状态：路由负责人还有自己的超时与恢复预算。
    }
    schedule()
  }

  void poll()
  return stop
}
