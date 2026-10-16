import type { ResolutionPreset } from '../constants'
import { FRAME_RATE_OPTIONS, RESOLUTION_PRESETS } from '../constants'

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
}

const DEFAULTS: WebrtcShareMediaSettings = {
  frameRate: 30,
  maxBitrateMbps: 8,
  shareSystemAudio: false,
  shareMicrophone: false,
  resolutionPreset: '1080p',
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
