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
import { displayMediaOptions } from './capture-options'
import {
  cameraCaptureConstraints,
  cameraFallbackConstraints,
  cameraTrackConstraints,
} from './capture-devices'
import {
  captureConstraints,
  supportsCaptureProfile,
  type QualityProfile,
} from './quality'

/** 屏幕 / 窗口 / 标签页采集。无视频轨时抛错，不留半条流。 */
export async function captureDisplay(
  profile: QualityProfile,
  options: { systemAudio?: boolean } = {}
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('getDisplayMedia unavailable')
  }
  if (!supportsCaptureProfile(profile)) {
    throw new Error('unsupported capture profile')
  }
  const stream = await navigator.mediaDevices.getDisplayMedia(
    displayMediaOptions(
      captureConstraints(profile),
      options.systemAudio ?? true
    )
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
 * 摄像头采集。
 *
 * 与屏幕采集的差别不只是「换一个 getUserMedia」：
 *  - 没有系统声，`shareSystemAudio` 对摄像头无意义（声音只能来自麦克风）；
 *  - `displaySurface` 不存在，发送端不会做帧隔离；
 *  - 设备可能被别的程序占着，`OverconstrainedError`/`NotReadableError` 要
 *    原样抛给调用方，界面才能提示「摄像头被占用」。
 */
export async function captureCamera(
  profile: QualityProfile,
  options: { deviceId?: string } = {}
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia unavailable')
  }
  if (!supportsCaptureProfile(profile)) {
    throw new Error('unsupported capture profile')
  }
  const primary = cameraCaptureConstraints(
    profile.resolution,
    profile.maxFramerate,
    options.deviceId ?? ''
  )
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: primary,
    })
  } catch (error) {
    // `resizeMode: exact 'none'` 在非 Chromium 上可能直接判过约束：
    // 去掉它再试一次，宁可让浏览器自己裁剪，也不要整个共享起不来。
    if (
      error instanceof Error &&
      (error.name === 'OverconstrainedError' || error.name === 'TypeError')
    ) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: cameraFallbackConstraints(primary),
      })
    } else {
      throw error
    }
  }
  const videoTrack = stream.getVideoTracks()[0]
  if (!videoTrack || videoTrack.readyState === 'ended') {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('camera produced no live video track')
  }
  videoTrack.contentHint = 'motion'
  return stream
}

/**
 * 只在采集轨上应用档位约束。
 *
 * 判断「这条轨有没有采集设备」要剥回输入轨（帧隔离轨的 `getCapabilities()`
 * 里不含宽高/帧率），但**下发约束必须用发送端这条轨**：`applySenderCaptureConstraints`
 * 内部会把它透传到输入轨，并且顺带补上 `min: 1`（Piik `quality.ts:313-338`）。
 * 直接对输入轨下发会绕过那层合并，静态画面可能彻底停帧。
 *
 * 屏幕与摄像头的约束口径不同（上限 vs 理想尺寸），按 `displaySurface` 分流；
 * 摄像头这条**不能带 deviceId/facingMode**，否则等于换了一颗摄像头。
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
  const constraints = capture.getSettings?.().displaySurface
    ? captureConstraints(profile)
    : cameraTrackConstraints(profile.resolution, profile.maxFramerate)
  await applySenderCaptureConstraints(track, constraints)
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
