import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PEER_SCALE_MAX, PEER_SCALE_MIN } from '../core/peer-scale'
import {
  LIVE2D_DEFAULT_POLICY,
  type Live2DModelKind,
  type Live2DPeer,
  type Live2DPolicy,
} from '../types'

// 「我选了哪个模型」是本机偏好，「谁在场」与「房间策略」是房间实时状态
// （不进持久化）。

/** 与 core/face-tracker 的 Live2DFaceQuality 一致（这里不 import，避免 store 拖进 wasm 类型）。 */
export type Live2DFaceQuality = 'smooth' | 'standard' | 'precise'

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
  /**
   * 动捕精度档位（本机偏好）。
   *
   * 为什么默认 standard：smooth 的 320×240 在 1080p 屏幕上脸只有 ~90px，
   * 3D 头部会明显抖；precise 的 30fps 在核显笔记本上会吃掉一整个核。
   * standard（480×360 / 15fps）是"看不出抖、也不烫手"的折中。
   */
  faceQuality: Live2DFaceQuality
  /** 3D 头部：三轴旋转 + 6DOF 平移视差 */
  head3d: boolean
  /** 眼球跟随：虹膜驱动 ParamEyeBall */
  eyeTrack: boolean
  /**
   * 语音口型：说话时用麦克风响度推动嘴型（不开摄像头也有口型）。
   *
   * 为什么默认开：这是「一起看片」场景里最自然的在场感——语音本来就开着，
   * 说话时角色跟着张嘴不需要任何额外动作。它只读本机麦克风、不上传音频，
   * 且静音时不生效（见 voice-chat/lib/mic-level），所以默认开不会构成意外。
   */
  voiceLipSync: boolean
  /** 名册：低频变化（加入/离开/换模型），高频指针不写这里 */
  peers: Live2DPeer[]
  /** 房间策略：房主设，低频，跟着快照/广播进来 */
  policy: Live2DPolicy

  setMyModel: (kind: Live2DModelKind, modelId: string) => void
  setMyScale: (scale: number) => void
  setFaceQuality: (quality: Live2DFaceQuality) => void
  setHead3d: (enabled: boolean) => void
  setEyeTrack: (enabled: boolean) => void
  setRemoved: (removed: boolean) => void
  setVoiceLipSync: (enabled: boolean) => void
  setPeers: (peers: Live2DPeer[]) => void
  setPolicy: (policy: Live2DPolicy) => void
  reset: () => void
}

const DEFAULTS = {
  myKind: 'builtin' as Live2DModelKind,
  myModelId: '',
  myScale: 1,
  removed: false,
  voiceLipSync: true,
  faceQuality: 'standard' as Live2DFaceQuality,
  head3d: true,
  eyeTrack: true,
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
      // 夹一遍：滑杆、快捷档、以及被手改过的 localStorage 都从这里过，
      // 一个 NaN 或 50 会让模型直接消失（baseScale 乘出来是 0 或溢出视口）。
      setMyScale: (myScale) => set({ myScale: clampMyScale(myScale) }),
      setFaceQuality: (faceQuality) => set({ faceQuality }),
      setHead3d: (head3d) => set({ head3d }),
      setEyeTrack: (eyeTrack) => set({ eyeTrack }),
      setRemoved: (removed) => set({ removed }),
      setVoiceLipSync: (voiceLipSync) => set({ voiceLipSync }),
      setPeers: (peers) => set({ peers }),
      setPolicy: (policy) => set({ policy }),
      reset: () =>
        set({ ...DEFAULTS, peers: [], policy: LIVE2D_DEFAULT_POLICY }),
    }),
    {
      name: 'zviewer.live2d.v1',
      version: 6,
      // v1 里有个「整个悬浮层开关」enabled，现在改成「右键角色 → 设置」，
      // 不再有全局开关（有开关却没有入口会把用户锁在外面）。
      // v2 的 hidden 是个布尔；v3 的 hidden 是带 roomId 的记录——两种都不
      // 迁移成 removed：它们表达的是"临时藏起来"，而删除是用户的明确动作，
      // 把旧的隐藏状态升级成"删除了角色"会让老用户升级后角色凭空消失。
      // v5 新增 voiceLipSync：老数据里没有这个键，按默认开启补齐。
      // v6 新增动捕精度三件套（faceQuality/head3d/eyeTrack）：老用户升级后
      // 直接拿到 standard + 全开，与"改造前 + 新能力"一致，不会突然降级。
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<Live2DStoreState>
        return {
          myKind: old.myKind ?? DEFAULTS.myKind,
          myModelId: old.myModelId ?? DEFAULTS.myModelId,
          myScale: clampMyScale(old.myScale),
          removed: false,
          voiceLipSync: old.voiceLipSync ?? DEFAULTS.voiceLipSync,
          faceQuality: normalizeQuality(old.faceQuality),
          head3d:
            typeof old.head3d === 'boolean' ? old.head3d : DEFAULTS.head3d,
          eyeTrack:
            typeof old.eyeTrack === 'boolean'
              ? old.eyeTrack
              : DEFAULTS.eyeTrack,
        }
      },
      // 只持久化本机偏好：名册与策略是房间状态，写进 localStorage 只会让
      // 下次进房先闪一批已经不在场的人/上一个房间的规矩。
      partialize: (state) => ({
        myKind: state.myKind,
        myModelId: state.myModelId,
        myScale: state.myScale,
        removed: state.removed,
        voiceLipSync: state.voiceLipSync,
        faceQuality: state.faceQuality,
        head3d: state.head3d,
        eyeTrack: state.eyeTrack,
      }),
    }
  )
)

/** 老数据/手改的 localStorage 可能给一个不存在的档位，回退到标准。 */
function normalizeQuality(value: unknown): Live2DFaceQuality {
  return value === 'smooth' || value === 'precise' || value === 'standard'
    ? value
    : 'standard'
}

/** 模型大小的合法区间，与滑杆/右键菜单同源（core/peer-scale）。 */
function clampMyScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULTS.myScale
  }
  return Math.min(PEER_SCALE_MAX, Math.max(PEER_SCALE_MIN, value))
}
