/**
 * 每条连接的用量轮询。
 *
 * 统计面板原先只认「一条 PC」，Piik 链路是多条边，`session.stats()` 才能回答
 * 「每条边现在什么状况」。这里只负责定时取数：窗口速率（帧率、码率、丢包）
 * 由端点在 `stats()` 内部用两条采样做差得出，第一次调用只建立基线，
 * 所以刚开播的两秒内速率还显示 `-`。
 *
 * 会话引用用 ref 而不是 state：会话是在 `start()` 或 effect 里建出来的，
 * 往 state 里塞会在 effect 体内同步 setState（连带两次渲染）。ref 的代价是
 * 「换会话不会自动重跑」，所以由调用方给一个 `active` 开关——开始共享 /
 * 进入房间时置真，停在原地时置假，面板据此清空而不是挂着上一场的数据。
 */
import { useEffect, useState, type RefObject } from 'react'
import type { ShareEdgeStats } from '../screen-sharing/core/edge-stats.ts'
import type { PiikShareSession } from './session.ts'

/** 与 `chrome://webrtc-internals` 的默认窗口接近，便于对照。 */
export const EDGE_STATS_INTERVAL_MS = 2_000

export function usePiikShareStats(
  sessionRef: RefObject<PiikShareSession | null>,
  active: boolean
): ShareEdgeStats[] {
  const [edges, setEdges] = useState<ShareEdgeStats[]>([])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tick = () => {
      const session = sessionRef.current
      if (!session) return
      void session
        .stats()
        .then((list) => {
          if (!cancelled) setEdges(list)
        })
        .catch(() => {
          // 连接正在关闭时 getStats 会抛；保留上一次的值，别把面板清成横线。
        })
    }
    // 首帧排进微任务再取：在 effect 体里同步 setState 会多渲染一轮，
    // 而这里本来就要等 getStats 的异步结果。
    queueMicrotask(tick)
    const timer = window.setInterval(tick, EDGE_STATS_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, sessionRef])

  return active ? edges : []
}
