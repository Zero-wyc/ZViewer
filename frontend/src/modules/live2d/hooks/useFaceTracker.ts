import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import {
  FaceTracker,
  type FaceTrackerConfig,
  type Live2DFaceQuality,
} from '../core/face-tracker'

// 摄像头动捕的启停。
//
// 三件事必须在这一处管住，散着写必然漏其中一条：
//   1. **用户手势**：申请摄像头只能在点击回调里发起，否则权限弹窗会被拦；
//   2. **异步竞态**：`FaceTracker.create()` 是异步的，await 之后用户可能已经
//      关掉了开关、换了房间、甚至组件已卸载——实例必须当场销毁，否则摄像头
//      指示灯亮着却没有任何界面能关掉它；
//   3. **房间策略**：房主关掉「允许成员动捕」时要真的停 track，不能只把按钮
//      变灰。

export interface UseFaceTrackerOptions {
  /** 房主是否允许成员动捕。变 false 时立刻停掉摄像头。 */
  allowFace: boolean
  /** 精度档位（本机偏好） */
  quality: Live2DFaceQuality
  /** 3D 头部 + 6DOF */
  head3d: boolean
  /** 眼球跟随 */
  eyeTrack: boolean
}

export interface FaceTrackerState {
  /** 实例（null = 没开）。监视窗组件需要它。 */
  tracker: FaceTracker | null
  /** 监视窗是否展开。开启动捕时自动展开一次（用户此刻最想确认"拍到我了吗"）。 */
  monitorOpen: boolean
  setMonitorOpen: (open: boolean) => void
  /** 开关三态：给面板渲染用。error 有值时代替 tooltip 里那句通用原因。 */
  face: { on: boolean; busy: boolean; error: string }
  toggle: () => void
  /** 重新标定：换坐姿/挪了电脑之后不必关掉动捕重开。 */
  recalibrate: () => void
  stop: () => void
}

export function useFaceTracker({
  allowFace,
  quality,
  head3d,
  eyeTrack,
}: UseFaceTrackerOptions): FaceTrackerState {
  const trackerRef = useRef<FaceTracker | null>(null)
  /**
   * 最新配置。
   *
   * start 是 useCallback([])（它只能在点击回调里发起，重建会让"进行中的启动"
   * 失去引用），闭包里的 quality 永远是首次渲染时的值；所以配置走 ref，
   * 由下面那个 effect 在每次变更时同步并应用到已运行的实例上。
   */
  const configRef = useRef<FaceTrackerConfig>({ quality, head3d, eyeTrack })
  // 卸载后摄像头还在跑是最糟的泄漏：启停都是异步的，必须在 await 之后复查
  const disposedRef = useRef(false)
  const [tracker, setTracker] = useState<FaceTracker | null>(null)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [face, setFace] = useState({ on: false, busy: false, error: '' })

  const stop = useCallback(() => {
    const current = trackerRef.current
    trackerRef.current = null
    current?.stop()
    setTracker(null)
    setMonitorOpen(false)
    setFace({ on: false, busy: false, error: '' })
  }, [])

  const start = useCallback(async () => {
    if (trackerRef.current) return
    setFace({ on: true, busy: true, error: '' })
    try {
      const instance = await FaceTracker.create({ config: configRef.current })
      // 启动期间用户可能已经关掉开关、离开了房间，或者组件已经被卸载
      if (disposedRef.current) {
        instance.stop()
        return
      }
      trackerRef.current = instance
      setTracker(instance)
      setMonitorOpen(true)
      setFace({ on: true, busy: false, error: '' })
    } catch (err) {
      setFace({
        on: false,
        busy: false,
        error: err instanceof Error ? err.message : t('摄像头动捕启动失败'),
      })
    }
  }, [])

  const toggle = useCallback(() => {
    if (face.on || face.busy) stop()
    else void start()
  }, [face.on, face.busy, stop, start])

  const recalibrate = useCallback(() => {
    trackerRef.current?.recalibrate()
  }, [])

  // 精度/3D/眼球变更：同步给已运行的实例。实例没开时只更新 ref，
  // 下次启动直接用新配置（不用先开一次再改）。
  useEffect(() => {
    configRef.current = { quality, head3d, eyeTrack }
    const current = trackerRef.current
    if (current) void current.setConfig(configRef.current)
  }, [quality, head3d, eyeTrack])

  // 房主关掉开关时立刻停。放进 setTimeout 是为了不在 effect 里同步 setState
  // （react-hooks 会判成级联渲染）。
  useEffect(() => {
    if (allowFace) return
    const timer = window.setTimeout(stop, 0)
    return () => window.clearTimeout(timer)
  }, [allowFace, stop])

  useEffect(() => {
    return () => {
      disposedRef.current = true
      trackerRef.current?.stop()
      trackerRef.current = null
    }
  }, [])

  return {
    tracker,
    monitorOpen,
    setMonitorOpen,
    face,
    toggle,
    recalibrate,
    stop,
  }
}
