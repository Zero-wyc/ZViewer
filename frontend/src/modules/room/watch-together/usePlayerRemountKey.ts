/**
 * 影片切换时强制重挂载播放器的 key 生成器。
 *
 * 背景：视频列表中切换不同添加方式的影片（如 Bilibili DASH → WebDAV MKV）
 * 意味着跨引擎切换（dashjs → playsvideo 等）。旧引擎的 MSE SourceBuffer /
 * 转码 worker / fetch 流即使经过 cleanup，残留状态仍可能与新引擎冲突导致
 * 播放器卡死。为 WatchTogetherPanel 绑定本 hook 返回的 key，切换影片时
 * 整个播放器（ArtPlayer 实例 + video 元素 + 全部业务 Hook）随 key 重挂载，
 * 实现彻底干净的全量重载。
 *
 * 语义：
 * - 首次观察到的 currentMovieId 不触发 key 变化——首次挂载本来就是全新
 *   attach（无旧引擎残留），避免进房 / 刷新恢复时无谓的双重加载；
 * - 之后的 currentMovieId 变化（切换影片）→ key 跟随影片 id，整个
 *   WatchTogetherPanel 重挂载；
 * - currentMovieId 被清空（删除当前影片）不改 key，沿用现有的
 *   清理 effect 暂停视频即可。
 */
import { useEffect, useRef, useState } from 'react'
import { useRoomStore } from '@/store/roomStore'

export function usePlayerRemountKey(): string | number {
  const currentMovieId = useRoomStore((s) => s.currentMovieId)
  const [remountKey, setRemountKey] = useState<string | number>('init')
  const prevMovieIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (currentMovieId == null) return
    const prev = prevMovieIdRef.current
    prevMovieIdRef.current = currentMovieId
    // 首次观察或重复设置同一影片：不重挂载
    if (prev == null || prev === currentMovieId) return
    setRemountKey(currentMovieId)
  }, [currentMovieId])

  return remountKey
}
