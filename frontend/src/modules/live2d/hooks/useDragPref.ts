import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { loadDragPref } from '../core/drag-prefs'
import { setLocalDrag } from '../core/scene'
import type { Live2DModelKind } from '../types'
import { emitLive2DDrag } from './useLive2DSync'

// 进房 / 换模型后把本机记住的站位套回去。
//
// 触发点是「我出现在名册里」，不是固定延时：以前等 800ms 赌服务端的 join
// 快照一定会到，网络慢时快照还没来就被随后的 upsert 覆盖成默认位置，网络快
// 时又白等 0.8 秒（角色先从默认槽位滑到记忆位置，看起来像自己动了一下）。
//
// 每个 (sid, 模型) 只应用一次：否则用户手动拖到别处后，任何一次重新渲染都会
// 把他拽回记忆里的位置。

export interface UseDragPrefOptions {
  /** 本机 socket id（空 = 还没连接） */
  sid: string
  /** 生效模型的来源与 id */
  kind: Live2DModelKind
  modelId: string
  /** 我是否已经出现在名册里 */
  inRoster: boolean
  socket: Socket | null
  roomId: string
}

export function useDragPref({
  sid,
  kind,
  modelId,
  inRoster,
  socket,
  roomId,
}: UseDragPrefOptions): void {
  const appliedRef = useRef('')
  useEffect(() => {
    if (!sid || !modelId || !inRoster) return
    const key = `${sid}|${kind}:${modelId}`
    if (appliedRef.current === key) return
    // 没记过（或记的是原点）也要标记，免得依赖抖动时反复查一遍
    appliedRef.current = key
    const pref = loadDragPref(kind, modelId)
    if (!pref) return
    // 目标与当前一起写：名册刚建出来，再平滑过去反而像"飘"
    setLocalDrag(sid, pref.x, pref.y)
    // 别人那边也站到这个位置：服务端名册里的偏移可能还是上一次会话的残留
    emitLive2DDrag(socket, roomId, pref.x, pref.y)
  }, [sid, kind, modelId, inRoster, socket, roomId])
}
