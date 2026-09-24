/**
 * B站 音源弹幕 Hook（歌词播放页 / 一起听专用）。
 *
 * 从 ListenTogetherPanel 剥离的完整链路：B站 曲目（含本地插播）按 cid 拉官方
 * 弹幕 → 本地缓存 → 弹幕层挂载/样式变更后重载并 seek 对齐 → 250ms 时间轴驱动。
 * 时间轴走 positionSec 命令式读取（音频 timeupdate 驱动），不依赖视频元素，
 * 也不把高频进度更新带进 React 渲染。
 *
 * 弹幕样式与「一起看」共用 danmakuStore 持久化，层级开关（是否压在 UI 之上）
 * 来自音乐设置 store，因此本 hook 直接订阅这两个 store，调用方只负责把
 * 返回的 layerRef 挂到 <DanmakuLayer> 上、用 active 控制其是否渲染。
 *
 * 注意：弹幕层「挂载 / 开关重开 / 样式或层级变更」时必须重载再对齐——
 * 样式变更会清空引擎已渲染弹幕与已发射集合，引擎重建时轨道也会丢失，
 * 不重载会导致当前窗口再也补不出弹幕。
 */
import { useEffect, useRef } from 'react'
import { fetchBilibiliDanmakuByCid } from '@/modules/danmaku/api'
import type { DanmakuItem } from '@/modules/danmaku/types'
import type { DanmakuLayerHandle } from '@/components/DanmakuLayer'
import { useDanmakuStore } from '@/store/danmakuStore'
import { useMusicSettingsStore } from '../store-settings'
import { getPositionSec } from './usePlaybackPosition'

export interface UseBilibiliDanmakuParams {
  /** 当前曲目是否为 B站 音源（含本地插播） */
  isBiliSong: boolean
  /** 当前曲目的 B站 分 P cid（0 = 无） */
  biliCid: number
  /** 弹幕总开关（音乐设置项；false 时本 hook 全部逻辑停摆） */
  enabled: boolean
}

export function useBilibiliDanmaku({
  isBiliSong,
  biliCid,
  enabled,
}: UseBilibiliDanmakuParams) {
  /** 弹幕层级：开启「弹幕压 UI」时置于 UI 之上 */
  const aboveUi = useMusicSettingsStore((s) => s.biliDanmakuAboveUi)
  const danmakuStyle = useDanmakuStore((s) => s.style)
  const active = isBiliSong && enabled

  const layerRef = useRef<DanmakuLayerHandle | null>(null)
  const itemsRef = useRef<DanmakuItem[]>([])
  /** 最近一次同步的播放进度（秒）：弹幕（重）挂载 / 加载完成后 seek 对齐用 */
  const timeRef = useRef(0)

  // cid 变化 → 清旧轨道 → 拉新弹幕（与一起看 WatchTogetherCore 同模式；
  // 弹幕层未挂载时仅更新缓存，挂载后由下方 effect 重载）
  useEffect(() => {
    if (!isBiliSong || !biliCid) return
    let cancelled = false
    itemsRef.current = []
    layerRef.current?.loadDanmakuTrack('default', [])
    layerRef.current?.clear()
    fetchBilibiliDanmakuByCid(biliCid)
      .then((items) => {
        if (cancelled) return
        itemsRef.current = items
        layerRef.current?.loadDanmakuTrack('default', items, 0)
        layerRef.current?.seek(timeRef.current)
      })
      .catch((err) => {
        console.error('[ListenTogether] load danmaku error:', err)
      })
    return () => {
      cancelled = true
    }
  }, [isBiliSong, biliCid])

  // 弹幕层（重）挂载 / 开关重开 / 弹幕设置或层级变更 → 用缓存弹幕重载并
  // 对齐当前进度：样式/速度/密度等变更会清空已渲染弹幕与已发射集合，
  // 引擎若同时重建（层级切换等）则轨道也丢失——不重载会让当前窗口再也
  // 不补发，表现为"调完弹幕设置后弹幕永远出不来"
  useEffect(() => {
    if (!active) return
    const items = itemsRef.current
    if (items.length > 0) {
      layerRef.current?.loadDanmakuTrack('default', items, 0)
      layerRef.current?.seek(timeRef.current)
    }
  }, [active, aboveUi, danmakuStyle])

  // 时间轴驱动：interval 250ms 命令式读取 store 进度 → syncTime（绕开
  // React 渲染——positionSec 高频更新不再触发本组件重渲染；引擎内部对
  // >3s 跳变自动清已发射集合并补发当前窗口，拖进度条 seek 兼容）
  useEffect(() => {
    timeRef.current = getPositionSec()
    if (!active) return
    const timer = setInterval(() => {
      const t = getPositionSec()
      timeRef.current = t
      layerRef.current?.syncTime(t)
    }, 250)
    return () => clearInterval(timer)
  }, [active])

  return {
    /** 弹幕层句柄（挂到 <DanmakuLayer ref={...}>） */
    layerRef,
    /** 是否处于「B站 曲目 + 弹幕开启」激活态（弹幕层渲染门控） */
    active,
    /** 层级：开启「弹幕压 UI」时置于 UI 之上 */
    aboveUi,
    /** 当前弹幕样式快照（供弹幕层 props 透传） */
    style: danmakuStyle,
  }
}
