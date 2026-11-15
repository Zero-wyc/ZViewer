import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  LIVE2D_DEFAULT_POLICY,
  type Live2DModelKind,
  type Live2DPeer,
  type Live2DPolicy,
} from '../types'

// 「我选了哪个模型」是本机偏好，「谁在场」与「房间策略」是房间实时状态
// （不进持久化）。

interface Live2DStoreState {
  myKind: Live2DModelKind
  myModelId: string
  myScale: number
  /**
   * 我已删除自己的角色。
   *
   * 为什么是一个**不分房间**的布尔，而不是"隐藏记录"：
   *   - 这个动作的语义是「我不要角色」，不是「暂时藏起来」——它就该跨房间、
   *     跨会话有效，跟"我选了哪个模型"同属本机偏好；
   *   - 以前用带 roomId 的记录表达"隐藏"，于是恢复路径要同时满足「房间对得
   *     上」「统一角色没开」「模型没被删」，三条里任何一条不成立就表现为
   *     用户说的"紊乱"。
   *
   * **删除不清 `myModelId`**：从模型列表里重新选同一个模型就是恢复，选择器
   * 也该继续高亮"上次用的那个"。
   */
  removed: boolean
  /** 名册：低频变化（加入/离开/换模型），高频指针不写这里 */
  peers: Live2DPeer[]
  /** 房间策略：房主设，低频，跟着快照/广播进来 */
  policy: Live2DPolicy

  setMyModel: (kind: Live2DModelKind, modelId: string) => void
  setMyScale: (scale: number) => void
  setRemoved: (removed: boolean) => void
  setPeers: (peers: Live2DPeer[]) => void
  setPolicy: (policy: Live2DPolicy) => void
  reset: () => void
}

const DEFAULTS = {
  myKind: 'builtin' as Live2DModelKind,
  myModelId: '',
  myScale: 1,
  removed: false,
}

export const useLive2DStore = create<Live2DStoreState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      peers: [],
      policy: LIVE2D_DEFAULT_POLICY,
      // 换模型 = 明确想看到它：顺手取消删除状态，否则用户点了模型却没反应。
      setMyModel: (myKind, myModelId) =>
        set({ myKind, myModelId, removed: false }),
      setMyScale: (myScale) => set({ myScale }),
      setRemoved: (removed) => set({ removed }),
      setPeers: (peers) => set({ peers }),
      setPolicy: (policy) => set({ policy }),
      reset: () =>
        set({ ...DEFAULTS, peers: [], policy: LIVE2D_DEFAULT_POLICY }),
    }),
    {
      name: 'zviewer.live2d.v1',
      version: 4,
      // v1 里有个「整个悬浮层开关」enabled，现在改成「右键角色 → 设置」，
      // 不再有全局开关（有开关却没有入口会把用户锁在外面）。
      // v2 的 hidden 是个布尔；v3 的 hidden 是带 roomId 的记录——两种都不
      // 迁移成 removed：它们表达的是"临时藏起来"，而删除是用户的明确动作，
      // 把旧的隐藏状态升级成"删除了角色"会让老用户升级后角色凭空消失。
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<Live2DStoreState>
        return {
          myKind: old.myKind ?? DEFAULTS.myKind,
          myModelId: old.myModelId ?? DEFAULTS.myModelId,
          myScale: old.myScale ?? DEFAULTS.myScale,
          removed: false,
        }
      },
      // 只持久化本机偏好：名册与策略是房间状态，写进 localStorage 只会让
      // 下次进房先闪一批已经不在场的人/上一个房间的规矩。
      partialize: (state) => ({
        myKind: state.myKind,
        myModelId: state.myModelId,
        myScale: state.myScale,
        removed: state.removed,
      }),
    }
  )
)
