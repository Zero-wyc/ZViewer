import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Live2DModelKind, Live2DPeer } from '../types'

// 「我选了哪个模型」是本机偏好（每个房间各自记也行，但没必要按房间分），
// 「谁在场」是房间实时状态（不进持久化）。

interface Live2DStoreState {
  /** 整个悬浮层的开关。 */
  enabled: boolean
  myKind: Live2DModelKind
  myModelId: string
  myScale: number
  /** 名册：低频变化（加入/离开/换模型），高频指针不写这里 */
  peers: Live2DPeer[]

  setEnabled: (enabled: boolean) => void
  setMyModel: (kind: Live2DModelKind, modelId: string) => void
  setMyScale: (scale: number) => void
  setPeers: (peers: Live2DPeer[]) => void
  reset: () => void
}

const DEFAULTS = {
  enabled: true,
  myKind: 'builtin' as Live2DModelKind,
  myModelId: '',
  myScale: 1,
}

export const useLive2DStore = create<Live2DStoreState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      peers: [],
      setEnabled: (enabled) => set({ enabled }),
      setMyModel: (myKind, myModelId) => set({ myKind, myModelId }),
      setMyScale: (myScale) => set({ myScale }),
      setPeers: (peers) => set({ peers }),
      reset: () => set({ ...DEFAULTS, peers: [] }),
    }),
    {
      name: 'zviewer.live2d.v1',
      version: 1,
      // 只持久化本机偏好：名册是房间状态，写进 localStorage 只会让下次进房
      // 先闪一批已经不在场的人。
      partialize: (state) => ({
        enabled: state.enabled,
        myKind: state.myKind,
        myModelId: state.myModelId,
        myScale: state.myScale,
      }),
    }
  )
)
