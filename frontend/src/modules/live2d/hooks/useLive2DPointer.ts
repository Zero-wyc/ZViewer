import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import {
  LIVE2D_EVENT,
  LIVE2D_STATE_EPSILON,
  LIVE2D_STATE_INTERVAL_MS,
} from '../constants'
import { normalizePointer, roundCoord } from '../core/pointer-map'
import { setLocalPointer } from '../core/scene'
import type { FaceTracker } from '../core/face-tracker'

// 本机输入 → 15Hz 上行。
//
// 两个来源：
//   - 鼠标/触摸：默认来源；
//   - 摄像头动捕：开着且有脸时**优先**，鼠标暂时让位（否则人坐着不动、
//     手碰一下鼠标，模型就会从"跟着我转头"跳回鼠标位置）。
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

    const send = (x: number, y: number, ar: number) => {
      const now = performance.now()
      if (now - lastAt < LIVE2D_STATE_INTERVAL_MS) return
      if (
        Math.abs(x - lastX) < LIVE2D_STATE_EPSILON &&
        Math.abs(y - lastY) < LIVE2D_STATE_EPSILON
      ) {
        return
      }
      lastAt = now
      lastX = x
      lastY = y
      setLocalPointer(sid, x, y)
      socket.emit(LIVE2D_EVENT.STATE, {
        roomId,
        x: roundCoord(x),
        y: roundCoord(y),
        a: roundCoord(ar, 2),
      })
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
      send(sample.x, sample.y, sample.ar)
    }

    // 摄像头采样定时器：取最新注视点，节流交给 send 自己判断。
    // 用 setInterval 而不是 rAF：页面切到后台时 rAF 会停，摄像头其实也没必要
    // 继续上报，但保持 15Hz 的定时器更简单，也不会因为掉帧而出现空档。
    const cameraTimer =
      tracker &&
      window.setInterval(() => {
        const gaze = tracker.getGaze()
        if (!gaze) return
        const ar = window.innerWidth / Math.max(1, window.innerHeight)
        send(gaze.x, gaze.y, ar)
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
    }
  }, [socket, roomId, sid, active, tracker])
}
