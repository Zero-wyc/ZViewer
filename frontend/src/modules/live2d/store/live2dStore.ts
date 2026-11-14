import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Live2DHidden } from '../core/visibility'
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
   * 我在某个房间隐藏了自己的角色。
   *
   * 为什么不是布尔：
   *   - 布尔分不清「还没选过模型」和「主动隐藏」，只能靠清空 myModelId 来表达，
   *     而清空之后就再也回不到原来那个模型；
   *   - 布尔不分房间，在 A 房隐藏会让 B 房也没有角色——而且它被持久化，
   *     关掉浏览器第二天回来还是隐藏。
   *
   * 现在它是一条带 roomId 的记录，且**不动 myModelId**：隐藏只是让生效模型
   * 暂时为空，恢复就是把它置回 null。跨房自动失效（roomId 不匹配）。
   */
  hidden: Live2DHidden | null
  /** 名册：低频变化（加入/离开/换模型），高频指针不写这里 */
  peers: Live2DPeer[]
  /** 房间策略：房主设，低频，跟着快照/广播进来 */
  policy: Live2DPolicy

  setMyModel: (kind: Live2DModelKind, modelId: string) => void
  setMyScale: (scale: number) => void
  setHidden: (hidden: Live2DHidden | null) => void
  setPeers: (peers: Live2DPeer[]) => void
  setPolicy: (policy: Live2DPolicy) => void
  reset: () => void
}

const DEFAULTS = {
  myKind: 'builtin' as Live2DModelKind,
  myModelId: '',
  myScale: 1,
  hidden: null as Live2DHidden | null,
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
      version: 3,
      // v1 里有个「整个悬浮层开关」enabled，现在改成「右键角色 → 设置」，
      // 不再有全局开关（有开关却没有入口会把用户锁在外面）。
      // v2 的 hidden 是个布尔且不知道属于哪个房间：直接丢掉（置 null）。
      // 留着它等于把「上次在某个房间隐藏过」变成「以后进任何房间都没角色」，
      // 而界面上又没有任何地方能看出这件事是怎么发生的。
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<Live2DStoreState>
        return {
          myKind: old.myKind ?? DEFAULTS.myKind,
          myModelId: old.myModelId ?? DEFAULTS.myModelId,
          myScale: old.myScale ?? DEFAULTS.myScale,
          hidden: null,
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
