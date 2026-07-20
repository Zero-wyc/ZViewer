/**
 * 安全播放工具：统一处理浏览器自动播放策略。
 *
 * 浏览器（Chrome/Safari/Firefox）的自动播放策略会阻止未交互页面调用
 * `video.play()`，抛出 `NotAllowedError`。观众端进入房间时通常没有
 * 用户交互，因此需要：
 *   1. 首次 play() 失败时自动静音并重试，绕过自动播放限制；
 *   2. 通过回调通知 UI 层切换静音状态，让用户知道视频被静音播放；
 *   3. 后续用户手动点击取消静音即可恢复声音。
 *
 * 房主端通常已通过点击"播放影片"按钮获得用户交互，play() 不会被阻止。
 */

export interface SafePlayOptions {
  /**
   * 当因自动播放策略被强制静音时触发，UI 层可据此更新静音按钮状态。
   */
  onAutoMuted?: () => void
}

/**
 * 尝试播放视频元素，遇到 NotAllowedError 时自动静音重试。
 *
 * @param video 目标 video 元素
 * @param options 回调选项
 * @returns Promise<void>，play() 的原始 Promise；重试后的结果不会被吞掉
 */
export function safePlay(
  video: HTMLVideoElement,
  options?: SafePlayOptions
): Promise<void> {
  return video.play().catch((err: DOMException) => {
    if (err?.name === 'NotAllowedError' && !video.muted) {
      video.muted = true
      options?.onAutoMuted?.()
      return video.play().catch((retryErr: DOMException) => {
        console.warn(
          '[safePlay] muted play retry also failed:',
          retryErr?.name,
          retryErr?.message
        )
      })
    }
    // 其他错误（如 AbortError：play() 被 load() 中断）静默处理
    console.warn('[safePlay] play failed:', err?.name, err?.message)
  })
}
