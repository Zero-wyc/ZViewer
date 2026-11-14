import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import {
  LIVE2D_EVENT,
  LIVE2D_STATE_EPSILON,
  LIVE2D_STATE_INTERVAL_MS,
} from '../constants'
import { normalizePointer, roundCoord } from '../core/pointer-map'
import { setLocalPointer } from '../core/scene'

// 本机指针 → 15Hz 上行。
//
// 两个细节：
//   - 本地先写场景，再发网络：自己的模型立刻响应，不等回包；
//   - 移动量小于阈值不发：静止时鼠标的抖动不值得占带宽（服务端还有 40ms 门限）。

export interface UseLive2DPointerOptions {
  socket: Socket | null
  roomId: string
  sid: string
  active: boolean
}

export function useLive2DPointer({
  socket,
  roomId,
  sid,
  active,
}: UseLive2DPointerOptions): void {
  useEffect(() => {
    if (!active || !socket || !roomId || !sid) return

    let lastAt = 0
    let lastX = -1
    let lastY = -1

    const handle = (clientX: number, clientY: number) => {
      const now = performance.now()
      if (now - lastAt < LIVE2D_STATE_INTERVAL_MS) return
      const sample = normalizePointer(
        clientX,
        clientY,
        window.innerWidth,
        window.innerHeight
      )
      if (
        Math.abs(sample.x - lastX) < LIVE2D_STATE_EPSILON &&
        Math.abs(sample.y - lastY) < LIVE2D_STATE_EPSILON
      ) {
        return
      }
      lastAt = now
      lastX = sample.x
      lastY = sample.y

      setLocalPointer(sid, sample.x, sample.y)
      socket.emit(LIVE2D_EVENT.STATE, {
        roomId,
        x: roundCoord(sample.x),
        y: roundCoord(sample.y),
        a: roundCoord(sample.ar, 2),
      })
    }

    const onPointer = (event: PointerEvent) =>
      handle(event.clientX, event.clientY)
    const onTouch = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touch) handle(touch.clientX, touch.clientY)
    }

    // passive：房间里有滚动容器，不能因为这里监听就让滚动变卡
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('touchmove', onTouch, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('touchmove', onTouch)
    }
  }, [socket, roomId, sid, active])
}
