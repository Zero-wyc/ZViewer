import { useEffect, useState } from 'react'
import { LIVE2D_FACE_TTL_MS, LIVE2D_SPEAKING_POLL_MS } from '../constants'
import { isVoiceSpeaking, listEntries } from '../core/scene'

/**
 * 「现在谁在说话」的 sid 集合。
 *
 * 数据源是场景里的语音嘴型——也就是驱动角色嘴部的那一批数据，所以标签高亮
 * 和嘴的动作永远不会互相矛盾（不会出现"嘴在动但标签没亮"）。
 *
 * 为什么不用 React 状态直接接语音电平：电平是 5Hz 的连续值，接进来等于让
 * 整个角色层每秒重渲染五次（六个人、六个标签、外加一堆内联样式）。这里只在
 * **成员进出说话状态**时返回新集合，说话期间引用不变，React 一次都不重渲染。
 */
export function useSpeakingSids(): ReadonlySet<string> {
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = new Set<string>()
      for (const entry of listEntries()) {
        if (isVoiceSpeaking(entry, LIVE2D_FACE_TTL_MS)) next.add(entry.peer.sid)
      }
      setSpeaking((prev) => (sameSet(prev, next) ? prev : next))
    }, LIVE2D_SPEAKING_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  return speaking
}

/** 集合等价判断：人数少，直接比元素即可，比排序/序列化便宜也更直观。 */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}
