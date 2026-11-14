import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import {
  LIVE2D_EVENT,
  LIVE2D_STATE_EPSILON,
  LIVE2D_STATE_INTERVAL_MS,
} from '../constants'
import { normalizePointer, roundCoord } from '../core/pointer-map'
import { setFace, setLocalPointer } from '../core/scene'
import type { FaceTracker } from '../core/face-tracker'

// 本机输入 → 15Hz 上行。
//
// 两个来源：
//   - 鼠标/触摸：默认来源；
//   - 摄像头动捕：开着且有脸时**优先**，鼠标暂时让位（否则人坐着不动、
//     手碰一下鼠标，模型就会从"跟着我转头"跳回鼠标位置）。
//
// 动捕还额外带两个量：张嘴幅度与睁眼程度（blendshape 算出来的）。它们走同一条
// live2d-state，不额外开事件——多一条事件就多一份频率控制与一条可能的乱序路径。
//
// 本地先写场景再发网络：自己的模型立刻响应，不等回包；移动量小于阈值不发，
// 静止时鼠标抖动不值得占带宽（服务端还有 40ms 门限）。

export interface UseLive2DPointerOptions {
  socket: Socket | null
  roomId: string
  sid: string
  active: boolean
  /** 摄像头动捕实例；为 null 时只用鼠标 */
  tracker?: FaceTracker | null
}

/** 上行 live2d-state 的形状（m/e 只在动捕时有）。 */
interface Live2DStatePayload {
  roomId: string
  x: number
  y: number
  a: number
  m?: number
  e?: number
}

export function useLive2DPointer({
  socket,
  roomId,
  sid,
  active,
  tracker = null,
}: UseLive2DPointerOptions): void {
  useEffect(() => {
    if (!active || !socket || !roomId || !sid) return

    let lastAt = 0
    let lastX = -1
    let lastY = -1
    // 是否已经发过面部数据：决定关闭动捕时要不要补一帧「闭嘴、睁眼」
    let sentFace = false

    const send = (
      x: number,
      y: number,
      ar: number,
      face: { mouth: number; eyes: number } | null
    ) => {
      const now = performance.now()
      if (now - lastAt < LIVE2D_STATE_INTERVAL_MS) return
      const pointerMoved =
        Math.abs(x - lastX) >= LIVE2D_STATE_EPSILON ||
        Math.abs(y - lastY) >= LIVE2D_STATE_EPSILON
      // 动捕开着就固定 15Hz 上报，不看变化量：面部数据有 600ms 有效期，
      // 靠"变了才发"会出现「坐着不动的两秒里对方模型突然自己眨眼」
      // ——数据过期、接管权被交还给了引擎。
      if (!pointerMoved && face === null) return

      lastAt = now
      lastX = x
      lastY = y
      setLocalPointer(sid, x, y)
      const payload: Live2DStatePayload = {
        roomId,
        x: roundCoord(x),
        y: roundCoord(y),
        a: roundCoord(ar, 2),
      }
      if (face) {
        sentFace = true
        setFace(sid, face.mouth, face.eyes)
        payload.m = roundCoord(face.mouth)
        payload.e = roundCoord(face.eyes)
      }
      socket.emit(LIVE2D_EVENT.STATE, payload)
    }

    const emitPointer = (clientX: number, clientY: number) => {
      // 动捕在跟踪时，鼠标不再抢控制权
      if (tracker?.hasFace()) return
      const sample = normalizePointer(
        clientX,
        clientY,
        window.innerWidth,
        window.innerHeight
      )
      send(sample.x, sample.y, sample.ar, null)
    }

    // 摄像头采样定时器：取最新注视点与面部姿态，节流交给 send 自己判断。
    // 用 setInterval 而不是 rAF：页面切到后台时 rAF 会停，摄像头其实也没必要
    // 继续上报，但保持 15Hz 的定时器更简单，也不会因为掉帧而出现空档。
    const cameraTimer =
      tracker &&
      window.setInterval(() => {
        const gaze = tracker.getGaze()
        if (!gaze) return
        const ar = window.innerWidth / Math.max(1, window.innerHeight)
        send(gaze.x, gaze.y, ar, tracker.getBlend())
      }, LIVE2D_STATE_INTERVAL_MS)

    const onPointer = (event: PointerEvent) =>
      emitPointer(event.clientX, event.clientY)
    const onTouch = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touch) emitPointer(touch.clientX, touch.clientY)
    }

    // passive：房间里有滚动容器，不能因为这里监听就让滚动变卡
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('touchmove', onTouch, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('touchmove', onTouch)
      if (cameraTimer) window.clearInterval(cameraTimer)
      // 关掉动捕的那一刻补一帧「闭嘴、睁眼」：不发的话对方模型会一直停在
      // 最后一帧的表情上（服务端只在收到面部数据时才转发 m/e）。
      if (sentFace) {
        setFace(sid, 0, 1)
        socket.emit(LIVE2D_EVENT.STATE, {
          roomId,
          x: roundCoord(Math.max(0, lastX)),
          y: roundCoord(Math.max(0, lastY)),
          a: roundCoord(window.innerWidth / Math.max(1, window.innerHeight), 2),
          m: 0,
          e: 1,
        })
      }
    }
  }, [socket, roomId, sid, active, tracker])
}
