import { useEffect, useRef } from 'react'
import type { Live2DModelKind, Live2DPeer } from '../types'
import { legacyDragKey, loadDragPref } from '../core/drag-prefs'
import { setLocalDrag } from '../core/scene'

// 进房 / 有人加入后，把本机给**每个角色**记的位置套回去。
//
// 位置是本机偏好、不同步给任何人，所以这里没有网络动作：只读 localStorage
// 再写场景。以前「我的站位」还要上行一次，那是位置同步时代的遗留。
//
// 触发点是名册里出现这个人（不是固定延时）：以前等 800ms 赌 join 快照一定
// 会到，网络慢时快照还没来就被随后的 upsert 覆盖成默认位置，网络快时又白等
// 0.8 秒（角色先从默认槽位滑到记忆位置，看起来像自己动了一下）。
//
// 每人只应用一次：否则用户手动拖到别处后，任何一次重新渲染都会把他拽回记忆
// 里的位置。键里带 sid + 显示名——重连换了 sid 就重新套一次，同一个人换模型
// 则不该被搬走（位置跟人走，不跟模型走）。
//
// 场景被整份重建（快照重放）时不需要重套：`restoreSmooth` 会把偏移一起恢复。

export interface UseDragPrefsOptions {
  /** 当前名册（谁在场、叫什么） */
  peers: Live2DPeer[]
  /** 本机 socket id（空 = 还没连接） */
  sid: string
  /** 本人生效模型的来源与 id，只用来迁移老版本按模型记账的位置 */
  kind: Live2DModelKind
  modelId: string
}

export function useDragPrefs({
  peers,
  sid,
  kind,
  modelId,
}: UseDragPrefsOptions): void {
  // 已经处理过的 `sid|名字`。用 ref 而不是 state：套位置是纯副作用，
  // 进 React 状态只会让宿主多渲染一轮。
  const doneRef = useRef(new Set<string>())

  useEffect(() => {
    if (!sid) return
    for (const peer of peers) {
      if (!peer.sid) continue
      const key = `${peer.sid}|${peer.name}`
      if (doneRef.current.has(key)) continue
      const legacy = peer.sid === sid ? legacyDragKey(kind, modelId) : ''
      const pref = loadDragPref(peer.name, peer.sid, legacy)
      if (pref) {
        // 目标与当前一起写：名册刚建出来，再平滑过去反而像"飘"
        setLocalDrag(peer.sid, pref.x, pref.y)
        doneRef.current.add(key)
        continue
      }
      // 本人还没选模型时 legacy 为空：留到下一轮再查一次旧记录，
      // 别把「没查过」记成「查过了」（否则老用户的位置会静默丢失）。
      if (legacy || peer.sid !== sid) doneRef.current.add(key)
    }
  }, [peers, sid, kind, modelId])
}
