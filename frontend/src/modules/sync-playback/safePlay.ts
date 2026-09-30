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
 * 游离元素守卫：播放器面板按影片切换重挂载（usePlayerRemountKey）后，
 * 异步回调（previewPlay / loadMovie / 恢复 effect 的 .then 链）持有的
 * 仍是重挂载前的旧 video 元素——它已脱离文档树但仍带有效 src。对其
 * play() 会产生**不受控制栏控制的游离声源**（暂停按钮只作用于新元素），
 * 即「一起看双声回声」的根源。因此脱离文档树的元素一律拒绝播放。
 *
 * @param video 目标 video 元素
 * @param options 回调选项
 * @returns Promise<void>，play() 的原始 Promise；重试后的结果不会被吞掉
 */
export function safePlay(
  video: HTMLVideoElement,
  options?: SafePlayOptions
): Promise<void> {
  if (!video.isConnected) {
    console.warn(
      '[safePlay] 拒绝播放已脱离文档树的媒体元素（防游离声源/双声回声）:',
      video.tagName,
      (video.currentSrc || video.src || '').slice(0, 80)
    )
    return Promise.resolve()
  }
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
