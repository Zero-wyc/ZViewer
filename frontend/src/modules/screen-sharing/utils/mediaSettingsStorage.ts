import type { ResolutionPreset } from '../constants'
import {
  AUDIO_BITRATE_OPTIONS,
  DEGRADATION_OPTIONS,
  FRAME_RATE_OPTIONS,
  RESOLUTION_PRESETS,
} from '../constants'

/**
 * WebRTC 屏幕共享媒体设置的 localStorage 持久化。
 *
 * 借鉴 mirotalk 的 lsSettings（screen_fps / screen_quality）：用户上次的
 * 帧率/分辨率/码率/音频选择在下次进房时自动恢复，而不是每次重置默认值。
 */

const STORAGE_KEY = 'zviewer.webrtc-share.settings.v1'

export interface WebrtcShareMediaSettings {
  frameRate: number
  maxBitrateMbps: number
  shareSystemAudio: boolean
  shareMicrophone: boolean
  resolutionPreset: ResolutionPreset
  /** 画面偏好：带宽不足时保清晰度还是保流畅。 */
  degradationPreference: RTCDegradationPreference
  /** 系统声音码率（bps）。 */
  maxAudioBitrate: number
  /** 采集源：共享屏幕，还是共享摄像头。 */
  captureSource: CaptureSource
  /** 摄像头设备 id；空串表示让浏览器选默认。 */
  cameraDeviceId: string
}

export type CaptureSource = 'screen' | 'camera'

const DEFAULTS: WebrtcShareMediaSettings = {
  frameRate: 30,
  maxBitrateMbps: 8,
  shareSystemAudio: false,
  shareMicrophone: false,
  resolutionPreset: '1080p',
  degradationPreference: 'balanced',
  maxAudioBitrate: 128_000,
  captureSource: 'screen',
  cameraDeviceId: '',
}

/** 读取持久化设置；缺失/损坏/字段非法时逐字段回退默认值 */
export function loadMediaSettings(): WebrtcShareMediaSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<WebrtcShareMediaSettings>
    const validFrameRates = FRAME_RATE_OPTIONS.map((o) => o.value)
    return {
      frameRate:
        typeof parsed.frameRate === 'number' &&
        validFrameRates.includes(parsed.frameRate)
          ? parsed.frameRate
          : DEFAULTS.frameRate,
      maxBitrateMbps:
        typeof parsed.maxBitrateMbps === 'number' &&
        parsed.maxBitrateMbps >= 0.5 &&
        parsed.maxBitrateMbps <= 50
          ? parsed.maxBitrateMbps
          : DEFAULTS.maxBitrateMbps,
      shareSystemAudio:
        typeof parsed.shareSystemAudio === 'boolean'
          ? parsed.shareSystemAudio
          : DEFAULTS.shareSystemAudio,
      shareMicrophone:
        typeof parsed.shareMicrophone === 'boolean'
          ? parsed.shareMicrophone
          : DEFAULTS.shareMicrophone,
      resolutionPreset:
        parsed.resolutionPreset &&
        RESOLUTION_PRESETS.includes(parsed.resolutionPreset)
          ? parsed.resolutionPreset
          : DEFAULTS.resolutionPreset,
      // 老版本存下的设置没有这两个字段：逐字段回退，不要整份丢掉。
      degradationPreference: DEGRADATION_OPTIONS.some(
        (option) => option.value === parsed.degradationPreference
      )
        ? (parsed.degradationPreference as RTCDegradationPreference)
        : DEFAULTS.degradationPreference,
      maxAudioBitrate: AUDIO_BITRATE_OPTIONS.some(
        (option) => option.value === parsed.maxAudioBitrate
      )
        ? (parsed.maxAudioBitrate as number)
        : DEFAULTS.maxAudioBitrate,
      // 老版本没有采集源字段：默认共享屏幕，别让升级后莫名其妙开摄像头。
      captureSource:
        parsed.captureSource === 'camera' ? 'camera' : DEFAULTS.captureSource,
      cameraDeviceId:
        typeof parsed.cameraDeviceId === 'string'
          ? parsed.cameraDeviceId
          : DEFAULTS.cameraDeviceId,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 保存设置（静默失败：隐私模式等场景 localStorage 可能不可用） */
export function saveMediaSettings(settings: WebrtcShareMediaSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // ignore
  }
}

/**
 * 观众端音量的独立存储。
 *
 * 与房主设置分开：同一个浏览器可能既当房主又当观众，两边的音量语义不同
 * （房主调的是自己麦克风的增益，观众调的是别人画面里的系统声）。
 */
const VIEWER_VOLUME_KEY = 'zviewer.webrtc-share.viewerVolume.v1'

export const VIEWER_VOLUME_MAX = 2

/** 读取上次的观众音量；越界/损坏一律回 1（原始音量）。 */
export function loadViewerVolume(): number {
  try {
    const raw = localStorage.getItem(VIEWER_VOLUME_KEY)
    if (raw === null) return 1
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > VIEWER_VOLUME_MAX) {
      return 1
    }
    return value
  } catch {
    return 1
  }
}

export function saveViewerVolume(level: number): void {
  try {
    localStorage.setItem(VIEWER_VOLUME_KEY, String(level))
  } catch {
    // ignore
  }
}
