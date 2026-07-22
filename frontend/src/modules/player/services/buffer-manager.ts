/**
 * SourceBuffer 缓冲管理服务
 *
 * 从旧 msePlayer.ts 抽取的全部 SourceBuffer 操作逻辑。
 *
 * 职责：
 * - 等待 SourceBuffer 脱离 updating 状态
 * - 分块 appendBuffer（自动等待上一次完成）
 * - 定期清理已播放数据（pruneSourceBuffer，保留 5 分钟窗口）
 * - QuotaExceededError 时强制清理（forcePruneSourceBuffer，保留 60 秒窗口）
 * - 缓冲前瞻量查询（getBufferedAhead / getBufferedEnd）
 *
 * 设计要点：
 * - pruneSourceBuffer 保留 5 分钟数据，覆盖绝大多数回退 seek 场景
 * - forcePruneSourceBuffer 保留 60 秒数据，仅在溢出时作为最后手段
 * - 所有 remove 操作通过 Promise 等待 updateend，确保串行化
 */

/** 单次 appendBuffer 超时（毫秒），防止 SourceBuffer 卡在 updating 状态。 */
const APPEND_TIMEOUT_MS = 30000

/**
 * 等待 SourceBuffer 脱离 updating 状态。
 * appendBuffer 是串行的，必须等上一次 updateend 后才能下一次 append。
 */
export function waitForSourceBufferReady(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      resolve()
    }
    const onErr = (e: Event) => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      reject(e)
    }
    sb.addEventListener('updateend', onEnd)
    sb.addEventListener('error', onErr)
    setTimeout(
      () => reject(new Error('SourceBuffer 更新超时')),
      APPEND_TIMEOUT_MS
    )
  })
}

/**
 * 等待 SourceBuffer 脱离 updating 状态（宽松版，不设超时、不 reject）。
 * 用于 remove 操作前的等待，remove 失败不中断播放。
 */
export function waitForSourceBufferIdle(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve) => {
    const onEnd = () => {
      sb.removeEventListener('updateend', onEnd)
      resolve()
    }
    sb.addEventListener('updateend', onEnd)
  })
}

/**
 * 向 SourceBuffer 追加数据，自动等待上一次 append 完成。
 */
export async function appendBuffer(
  sb: SourceBuffer,
  data: BufferSource
): Promise<void> {
  await waitForSourceBufferReady(sb)
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      resolve()
    }
    const onErr = (e: Event) => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      reject(e)
    }
    sb.addEventListener('updateend', onEnd)
    sb.addEventListener('error', onErr)
    try {
      sb.appendBuffer(data)
    } catch (err) {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      reject(err)
    }
  })
}

/**
 * 判断错误是否为 SourceBuffer 配额溢出。
 * Chrome 在 SourceBuffer 内存达上限（约 150MB）时抛出此错误。
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.message.includes('SourceBuffer is full')
  )
}

/**
 * 获取 SourceBuffer 末尾时间（已缓冲数据的最后时间戳）。
 */
export function getBufferedEnd(sb: SourceBuffer): number {
  if (!sb.buffered.length) return 0
  return sb.buffered.end(sb.buffered.length - 1)
}

/**
 * 获取已缓冲数据中位于 currentTime 之后的时长（秒）。
 */
export function getBufferedAhead(
  sb: SourceBuffer,
  currentTime: number
): number {
  if (!sb.buffered.length) return 0
  const end = getBufferedEnd(sb)
  return Math.max(0, end - currentTime)
}

/**
 * 强制清理 SourceBuffer：移除 currentTime 之前所有已缓冲数据。
 * 仅在 QuotaExceededError 发生时调用，作为最后手段释放空间。
 * 保留 currentTime 前 60 秒的数据，避免小幅回退 seek 到未缓冲区域导致卡死。
 */
export async function forcePruneSourceBuffer(
  sb: SourceBuffer,
  currentTime: number
): Promise<void> {
  if (!sb.buffered.length) return
  await waitForSourceBufferIdle(sb)
  if (sb.updating) return
  const start = sb.buffered.start(0)
  // 保留 currentTime 前 60 秒的数据，移除更早的部分。
  const safeStart = Math.max(start, currentTime - 60)
  if (safeStart > start) {
    try {
      await new Promise<void>((resolve) => {
        const onEnd = () => {
          sb.removeEventListener('updateend', onEnd)
          resolve()
        }
        sb.addEventListener('updateend', onEnd)
        sb.remove(start, safeStart)
      })
    } catch {
      // 清理失败不中断
    }
  }
}

/**
 * 清空 SourceBuffer 中的所有数据。
 *
 * 用于 MSE seek 模式初始化失败时回退：init segment 已 append 但估算偏移下载失败，
 * 需要清空已 append 的数据，让主循环从头重新加载，避免数据不一致。
 */
export async function clearSourceBuffer(sb: SourceBuffer): Promise<void> {
  if (sb.buffered.length === 0) return
  await waitForSourceBufferIdle(sb)
  if (sb.updating || sb.buffered.length === 0) return
  const start = sb.buffered.start(0)
  const end = sb.buffered.end(sb.buffered.length - 1)
  await new Promise<void>((resolve) => {
    const onEnd = () => {
      sb.removeEventListener('updateend', onEnd)
      resolve()
    }
    sb.addEventListener('updateend', onEnd)
    try {
      sb.remove(start, end)
    } catch {
      sb.removeEventListener('updateend', onEnd)
      resolve()
    }
  })
}

/**
 * 清理 SourceBuffer 中已播放过的数据，保持 buffer 窗口在合理范围内。
 * 防止长时间播放后 SourceBuffer 内存溢出导致 QuotaExceededError。
 * 保留 currentTime 前 5 分钟的数据，支持回退 seek 而不卡死。
 */
export async function pruneSourceBuffer(
  sb: SourceBuffer,
  currentTime: number
): Promise<void> {
  if (sb.updating) return
  if (!sb.buffered.length) return
  const start = sb.buffered.start(0)
  // 保留 currentTime 前 5 分钟的数据，移除更早的部分。
  // 5 分钟的视频数据约 75MB（1080P），仍在 SourceBuffer 150MB 上限内。
  const safeStart = currentTime - 300
  if (safeStart > start + 5) {
    try {
      await new Promise<void>((resolve) => {
        const onEnd = () => {
          sb.removeEventListener('updateend', onEnd)
          resolve()
        }
        sb.addEventListener('updateend', onEnd)
        sb.remove(start, Math.min(safeStart, sb.buffered.end(0)))
      })
    } catch {
      // 清理失败不中断播放
    }
  }
}
