import { useCallback, useRef } from 'react'
import { useMusicStore, musicItemKey, activeQueueOf } from '../store'
import type { MusicQueueItem } from '../types'

/** Fisher-Yates 洗牌（返回打乱后的新数组；元素为曲目 key） */
function shuffleKeys(keys: string[]): string[] {
  const arr = keys.slice()
  for (let i = 0; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

/** 判断两组曲目 key 是否为同一集合（多重集比较，忽略顺序） */
function isSameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((id, i) => id === sb[i])
}

/**
 * 队列推进引擎（从 useListenTogether 抽出，纯搬迁）：位置锚点、
 * 随机洗牌序列、按播放模式计算切歌目标与预载窥探。
 *
 * 全部状态经 useMusicStore.getState() 实时读取，零组件 props 依赖；
 * 对外只暴露消费面：位置锚点 ref（loadAndPlaySong 按引用锚定实例）、
 * 预载窥探（音频引擎无缝衔接用）、切歌目标计算、洗牌序列失效重置。
 */
export function useQueueAdvance() {
  /**
   * 当前播放条目在活动队列中的位置锚点（-1 未知/不在队列）。
   * 队列可含重复条目（同 key 多个位置），currentKey 只能锚定首个出现位置；
   * 以索引锚点记录实际播放实例，切歌按位置推进才能越过重复条目
   * （key 匹配的旧行为会让「下一首」永远回到第一个重复实例）。
   */
  const currentQueueIdxRef = useRef(-1)
  const shuffleListRef = useRef<string[] | null>(null)
  const shufflePosRef = useRef(-1)

  /**
   * 解析当前播放位置：优先信任索引锚点（校验该位置 key 与 currentKey
   * 一致），锚点失效（队列变动/未初始化）时回落 key 首个匹配（与旧逻辑
   * 一致），并把结果写回锚点。
   */
  const resolveCurrentIndex = useCallback((): number => {
    const { currentKey } = useMusicStore.getState()
    const queue = activeQueueOf(useMusicStore.getState())
    const keys = queue.map((item) => musicItemKey(item))
    const anchored = currentQueueIdxRef.current
    if (
      currentKey != null &&
      anchored >= 0 &&
      anchored < keys.length &&
      keys[anchored] === currentKey
    ) {
      return anchored
    }
    const idx = currentKey == null ? -1 : keys.indexOf(currentKey)
    currentQueueIdxRef.current = idx
    return idx
  }, [])

  /**
   * 预载目标窥探（无缝衔接用）：与 computeTargetSong('next') 相同的解析逻辑，
   * 但不推进洗牌指针（避免预载导致真实切歌跳过一首）。一轮洗牌末尾不预载
   * （下一首需重新洗牌，peek 结果不稳定）。
   */
  const peekNextSong = useCallback((): MusicQueueItem | null => {
    const { playMode } = useMusicStore.getState()
    const queue = activeQueueOf(useMusicStore.getState())
    if (queue.length === 0) return null
    if (playMode === 'repeat-one') return null
    if (playMode !== 'shuffle') {
      // 与 computeTargetSong 相同的位置推进语义（重复条目按位置越过）
      if (queue.length === 1) return queue[0]
      const idx = resolveCurrentIndex()
      if (idx === -1) return queue[0]
      // 按顺序播放（不循环）：末尾无下一首，不预载
      if (playMode === 'order') {
        return idx + 1 < queue.length ? queue[idx + 1] : null
      }
      return queue[(idx + 1) % queue.length]
    }
    const list = shuffleListRef.current
    if (!list || list.length === 0) return null
    if (list.length === 1) {
      return queue.find((item) => musicItemKey(item) === list[0]) ?? null
    }
    if (shufflePosRef.current >= list.length - 1) return null
    const nextKey = list[shufflePosRef.current + 1]
    return queue.find((item) => musicItemKey(item) === nextKey) ?? null
  }, [resolveCurrentIndex])

  /**
   * 随机模式：确保洗牌序列与当前队列一致。
   * 队列变化或锚点漂移（房主手动点歌）时重建/重锚，
   * 重建时将当前曲目置于序列头部。
   */
  const ensureShuffleList = useCallback(() => {
    const { currentKey } = useMusicStore.getState()
    // 随机序列基于「当前源的活动播放列表」构建（两源列表独立，跨源自动重建）
    const queueKeys = activeQueueOf(useMusicStore.getState()).map((item) =>
      musicItemKey(item)
    )
    if (queueKeys.length === 0) {
      shuffleListRef.current = null
      shufflePosRef.current = -1
      return
    }
    const list = shuffleListRef.current
    if (list && isSameKeySet(list, queueKeys)) {
      // 队列未变：校验位置仍指向当前曲目（手动切歌会使锚点漂移）
      if (currentKey == null) {
        shufflePosRef.current = -1
        return
      }
      const idx = list.indexOf(currentKey)
      // 当前曲目不在队列（被删除）→ 从序列头部重新开始
      shufflePosRef.current = idx >= 0 ? idx : -1
      return
    }
    // 队列变化或首次进入随机模式：重新洗牌，当前曲目置于头部
    const nextList = shuffleKeys(queueKeys)
    if (currentKey != null) {
      const curIdx = nextList.indexOf(currentKey)
      if (curIdx > 0) {
        nextList.splice(curIdx, 1)
        nextList.unshift(currentKey)
      }
      shufflePosRef.current = curIdx >= 0 ? 0 : -1
    } else {
      shufflePosRef.current = -1
    }
    shuffleListRef.current = nextList
  }, [])

  /**
   * 按播放模式计算切歌目标条目（next/prev 共用）。
   * - sequence / repeat-one：手动切歌按队列顺序循环
   *   （repeat-one 仅影响 ended 自动重播当前曲目）
   * - shuffle：沿洗牌序列推进，一轮结束重新洗牌
   *   （新一轮避免以刚播放的曲目开头，参考 Hydrogen avoidFirstSongId）
   */
  const computeTargetSong = useCallback(
    (direction: 'next' | 'prev'): MusicQueueItem | null => {
      const { currentKey, playMode } = useMusicStore.getState()
      // 切歌在「当前源的活动播放列表」内推进（两源列表完全独立）
      const queue = activeQueueOf(useMusicStore.getState())
      if (queue.length === 0) return null

      const findByKey = (key: string | null): MusicQueueItem | null =>
        key == null
          ? null
          : (queue.find((item) => musicItemKey(item) === key) ?? null)

      // 随机模式路径按 key 解析目标（洗牌序列以 key 为元素），
      // 解析成功后把位置锚点对齐到返回实例
      const anchorTo = (item: MusicQueueItem | null): MusicQueueItem | null => {
        if (item != null) currentQueueIdxRef.current = queue.indexOf(item)
        return item
      }

      if (playMode !== 'shuffle') {
        // 顺序推进按「位置」而非 key：重复条目（同 key 多位置）只有按
        // 位置推进才能越过自身到达后续条目，key 匹配会永远折回首个实例
        if (queue.length === 1) {
          currentQueueIdxRef.current = 0
          return queue[0]
        }
        const idx = resolveCurrentIndex()
        if (idx === -1) {
          currentQueueIdxRef.current = 0
          return queue[0]
        }
        // 按顺序播放（不循环）：到末尾不再前进、到头不再后退
        if (playMode === 'order') {
          if (direction === 'next') {
            if (idx + 1 >= queue.length) return null
            currentQueueIdxRef.current = idx + 1
            return queue[idx + 1]
          }
          if (idx - 1 >= 0) {
            currentQueueIdxRef.current = idx - 1
            return queue[idx - 1]
          }
          currentQueueIdxRef.current = 0
          return queue[0]
        }
        const targetIdx =
          direction === 'next'
            ? (idx + 1) % queue.length
            : (idx - 1 + queue.length) % queue.length
        currentQueueIdxRef.current = targetIdx
        return queue[targetIdx]
      }

      // 随机模式
      ensureShuffleList()
      const list = shuffleListRef.current
      if (!list || list.length === 0) return null
      if (list.length === 1) return anchorTo(findByKey(list[0]))
      if (direction === 'next') {
        if (shufflePosRef.current >= list.length - 1) {
          // 一轮结束：重新洗牌，避免新一轮以刚播放的曲目开头
          const nextList = shuffleKeys(list)
          if (currentKey != null && nextList[0] === currentKey) {
            const swapIdx = nextList.findIndex((k) => k !== currentKey)
            if (swapIdx > 0) {
              const t = nextList[0]
              nextList[0] = nextList[swapIdx]
              nextList[swapIdx] = t
            }
          }
          shuffleListRef.current = nextList
          shufflePosRef.current = 0
          return anchorTo(findByKey(nextList[0]))
        }
        shufflePosRef.current += 1
        return anchorTo(findByKey(list[shufflePosRef.current]))
      }
      // prev：沿序列回退；已在序列头部时回到当前曲目开头
      if (shufflePosRef.current > 0) {
        shufflePosRef.current -= 1
        return anchorTo(findByKey(list[shufflePosRef.current]))
      }
      return anchorTo(findByKey(currentKey))
    },
    [ensureShuffleList, resolveCurrentIndex]
  )

  /** 洗牌序列失效：切播放模式 / 队列变化 / 卸载时调用，下次随机切歌惰性重建
   *  （位置指针仅在序列非空时被读取，且每次重建都会重算，一并复位无副作用） */
  const resetShuffle = useCallback(() => {
    shuffleListRef.current = null
    shufflePosRef.current = -1
  }, [])

  return {
    /** 位置锚点 ref（loadAndPlaySong 按引用在活动队列中定位播放实例） */
    currentQueueIdxRef,
    /** 预载目标窥探（音频引擎无缝衔接配置用） */
    peekNextSong,
    /** 按播放模式计算 next/prev 目标条目 */
    computeTargetSong,
    /** 洗牌序列失效重置 */
    resetShuffle,
  }
}
