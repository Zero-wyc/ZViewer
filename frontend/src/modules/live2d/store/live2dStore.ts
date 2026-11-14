import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  LIVE2D_DEFAULT_POLICY,
  type Live2DModelKind,
  type Live2DPeer,
  type Live2DPolicy,
} from '../types'

// 「我选了哪个模型」是本机偏好（每个房间各自记也行，但没必要按房间分），
// 「谁在场」与「房间策略」是房间实时状态（不进持久化）。

interface Live2DStoreState {
  myKind: Live2DModelKind
  myModelId: string
  myScale: number
  /**
   * 用户主动隐藏了自己的角色。
   *
   * 必须和「还没选过模型」区分开：两者都是 myModelId 为空，但前者要**保持**
   * 空着，后者应当自动补一个默认模型。没有这个标记，「隐藏角色」会被
   * 「进房自动给个角色」立刻撤销掉。
   */
  hidden: boolean
  /** 名册：低频变化（加入/离开/换模型），高频指针不写这里 */
  peers: Live2DPeer[]
  /** 房间策略：房主设，低频，跟着快照/广播进来 */
  policy: Live2DPolicy

  setMyModel: (kind: Live2DModelKind, modelId: string) => void
  setMyScale: (scale: number) => void
  setHidden: (hidden: boolean) => void
  setPeers: (peers: Live2DPeer[]) => void
  setPolicy: (policy: Live2DPolicy) => void
  reset: () => void
}

const DEFAULTS = {
  myKind: 'builtin' as Live2DModelKind,
  myModelId: '',
  myScale: 1,
  hidden: false,
}

export const useLive2DStore = create<Live2DStoreState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      peers: [],
      policy: LIVE2D_DEFAULT_POLICY,
      setMyModel: (myKind, myModelId) => set({ myKind, myModelId }),
      setMyScale: (myScale) => set({ myScale }),
      setHidden: (hidden) => set({ hidden }),
      setPeers: (peers) => set({ peers }),
      setPolicy: (policy) => set({ policy }),
      reset: () =>
        set({ ...DEFAULTS, peers: [], policy: LIVE2D_DEFAULT_POLICY }),
    }),
    {
      name: 'zviewer.live2d.v1',
      version: 2,
      // v1 里有个「整个悬浮层开关」enabled，现在改成「右键角色 → 设置」，
      // 不再有全局开关（有开关却没有入口会把用户锁在外面）。这里只是把它丢掉，
      // 其余本机偏好照旧保留。
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<Live2DStoreState>
        return {
          myKind: old.myKind ?? DEFAULTS.myKind,
          myModelId: old.myModelId ?? DEFAULTS.myModelId,
          myScale: old.myScale ?? DEFAULTS.myScale,
          hidden: false,
        }
      },
      // 只持久化本机偏好：名册与策略是房间状态，写进 localStorage 只会让
      // 下次进房先闪一批已经不在场的人/上一个房间的规矩。
      partialize: (state) => ({
        myKind: state.myKind,
        myModelId: state.myModelId,
        myScale: state.myScale,
        hidden: state.hidden,
      }),
    }
  )
)
