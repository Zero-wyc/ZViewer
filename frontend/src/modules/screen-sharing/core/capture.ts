/**
 * 屏幕采集。
 *
 * 关键取舍（全部来自 Piik `media/quality.ts:238-350` + `audio-capture.ts`）：
 *  - 宽高只下发 `max`，是上限不是目标：用 `ideal` 会让采集器为了凑尺寸裁画面。
 *  - 屏幕声必须显式要求「不做语音处理」，否则 Chromium 默认给 web 采集上
 *    回声消除/降噪/自动增益，系统声里的音乐会被当成噪声磨掉。
 *  - `contentHint = "motion"`：屏幕共享常见 PPT 翻页与视频播放，motion 让
 *    编码器优先保帧率而不是把静止画面长时间压到极低码率。
 */
import {
  applySenderCaptureConstraints,
  senderCaptureTrack,
} from './sender-track'
import {
  captureConstraints,
  supportsCaptureProfile,
  type QualityProfile,
} from './quality'

type DisplayMediaAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: 'include' | 'exclude'
  windowAudio?: 'exclude' | 'window' | 'system'
}

type BrowserAudioConstraints = MediaTrackConstraints & {
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

export function displayMediaOptions(
  video: MediaTrackConstraints
): DisplayMediaStreamOptions {
  return {
    video,
    audio: audioInputConstraints(false),
    systemAudio: 'include',
    windowAudio: 'window',
  } as DisplayMediaAudioHints
}

/** 屏幕 / 窗口 / 标签页采集。无视频轨时抛错，不留半条流。 */
export async function captureDisplay(
  profile: QualityProfile
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('getDisplayMedia unavailable')
  }
  if (!supportsCaptureProfile(profile)) {
    throw new Error('unsupported capture profile')
  }
  const stream = await navigator.mediaDevices.getDisplayMedia(
    displayMediaOptions(captureConstraints(profile))
  )
  const videoTrack = stream.getVideoTracks()[0]
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('display capture produced no video track')
  }
  videoTrack.contentHint = 'motion'
  for (const audioTrack of stream.getAudioTracks()) {
    audioTrack.contentHint = 'music'
  }
  return stream
}

/**
 * 只在采集轨上应用档位约束。
 *
 * 帧隔离轨没有底层采集设备，`getCapabilities()` 里不含宽高/帧率，对它
 * 下发约束是空操作——所以先剥回采集输入轨再判断。
 */
export async function applyVideoCaptureProfile(
  track: MediaStreamTrack,
  profile: QualityProfile
): Promise<void> {
  const capture = senderCaptureTrack(track)
  const capabilities = capture.getCapabilities?.()
  const ownsConstraints =
    !capabilities ||
    'width' in capabilities ||
    'height' in capabilities ||
    'frameRate' in capabilities
  if (!ownsConstraints) return
  await applySenderCaptureConstraints(capture, captureConstraints(profile))
}

/** 暂停/恢复一条流的全部轨道（不改分辨率，只关开关）。 */
export function setMediaPaused(stream: MediaStream, paused: boolean): boolean {
  const tracks = stream.getTracks()
  if (tracks.length === 0) return false
  for (const track of tracks) {
    track.enabled = !paused
  }
  return true
}
