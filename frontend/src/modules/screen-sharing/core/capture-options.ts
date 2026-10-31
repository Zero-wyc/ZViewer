/**
 * 采集/音频输入约束。
 *
 * 单独成文件的原因：这些是纯数据拼装（可单测），而 `capture.ts` 与
 * `audio-mix.ts` 都要用同一套口径——系统声、音乐输入绝不能要求语音处理，
 * 否则 Chromium 会给它们上回声消除/降噪/自动增益，音乐被当成噪声磨掉。
 *
 * 本文件**不允许有运行时 import**：测试用 node --experimental-strip-types
 * 直接加载它，多一层 import 就要补扩展名。
 */

/** 浏览器独有的 displayMedia 声音提示（TS 标准库还没收录）。 */
export type DisplayMediaAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: 'include' | 'exclude'
  windowAudio?: 'exclude' | 'window' | 'system'
}

/** 浏览器独有的音频约束（voiceIsolation 尚未进 TS 标准库）。 */
export type BrowserAudioConstraints = MediaTrackConstraints & {
  voiceIsolation?: ConstrainBoolean
}

/** 音频输入约束。`voiceProcessing=false` 用于系统声与音乐输入。 */
export function audioInputConstraints(
  voiceProcessing: boolean
): BrowserAudioConstraints {
  return {
    echoCancellation: voiceProcessing,
    noiseSuppression: voiceProcessing,
    autoGainControl: voiceProcessing,
    // 音乐/虚拟输入要的是未处理的立体声，与屏幕声保持一致口径。
    ...(voiceProcessing
      ? {}
      : { voiceIsolation: false, channelCount: { ideal: 2 } }),
  }
}

/**
 * getDisplayMedia 的完整选项。
 *
 * `systemAudio=false` 时**完全不请求音频**：请求了再丢掉，浏览器的共享
 * 选择器仍会显示「分享系统声音」，用户会以为自己勾上了。
 */
export function displayMediaOptions(
  video: MediaTrackConstraints,
  systemAudio = true
): DisplayMediaStreamOptions {
  if (!systemAudio) return { video, audio: false }
  return {
    video,
    audio: audioInputConstraints(false),
    systemAudio: 'include',
    windowAudio: 'window',
  } as DisplayMediaAudioHints
}
