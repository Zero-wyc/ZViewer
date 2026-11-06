/**
 * 共享设置的跨组件桥。
 *
 * 设置的真相在 `WebrtcSharePage` 里：它持有 Piik 会话（`usePiikShareHost`），
 * 热切换分辨率/采集源、改编码参数这些动作只有它能做。而「共享设置」卡片
 * 渲染在下方的控制卡片区（`RoomPage` → `RoomLayout`），两者不是父子关系。
 *
 * 所以由共享页把「当前设置 + 当前状态 + 一组动作」发布到这里，卡片只读消费：
 *
 * - **不要**在卡片里另存一份 settings —— 那正是「界面显示 1080P、实际发 720P」
 *   的来源（两处 UI 各有一份真相）。
 * - 卡片卸载 / 共享页卸载时必须 `clear()`，否则切到观众端或一起看模式后，
 *   卡片还会拿着上一个房间的会话动作。
 */
import { create } from 'zustand'
import type { CaptureDevice } from '../core/capture-devices'
import type { QualityPresetId, ResolutionPreset } from '../constants'
import type {
  CaptureSource,
  WebrtcShareMediaSettings,
} from '../utils/mediaSettingsStorage'

/** 卡片上的每一次交互都转交给共享页处理（改设置 → 下发到会话）。 */
export interface ShareSettingsActions {
  onPresetChange: (id: QualityPresetId) => void
  onResolutionChange: (preset: ResolutionPreset) => void
  onFrameRateChange: (fps: number) => void
  onBitrateChange: (mbps: number) => void
  onDegradationChange: (preference: RTCDegradationPreference) => void
  onAudioBitrateChange: (bitrate: number) => void
  onSystemAudioChange: (enabled: boolean) => void
  onMicrophoneChange: (enabled: boolean) => void
  onCaptureSourceChange: (source: CaptureSource) => void
  onCameraDeviceChange: (deviceId: string) => void
}

export interface ShareSettingsBinding {
  settings: WebrtcShareMediaSettings
  /** 是否正在共享：决定哪些项能热改。 */
  isSharing: boolean
  switchingResolution: boolean
  switchingSource: boolean
  cameras: CaptureDevice[]
  actions: ShareSettingsActions
}

interface ShareSettingsBridgeState {
  /** 共享页未挂载（观众端、一起看模式）时为 null。 */
  binding: ShareSettingsBinding | null
  publish: (binding: ShareSettingsBinding) => void
  clear: () => void
}

export const useShareSettingsBridge = create<ShareSettingsBridgeState>(
  (set) => ({
    binding: null,
    publish: (binding) => set({ binding }),
    clear: () => set({ binding: null }),
  })
)
