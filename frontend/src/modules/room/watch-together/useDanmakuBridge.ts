import { useCallback, useEffect, useRef, useState } from 'react'
import { useDanmakuStore } from '@/store/danmakuStore'
import type { DanmakuLayerHandle } from '@/modules/danmaku/components/DanmakuLayer'
import { fetchBilibiliDanmakuByCid } from '@/modules/danmaku/api'
import type { DanmakuItem } from '@/modules/danmaku/types'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { message } from '@/components/ui/message'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'

/**
 * 弹幕桥接：B站 官方弹幕加载、轨道同步、实时弹幕收发与控制栏/设置面板回调。
 *
 * 从 WatchTogetherCore 抽出（纯搬迁）：
 * - 加载 B站 官方弹幕（cid 变化即重载），经 DanmakuLayer 时间轴接口上屏
 * - 弹幕开关重开时按当前时间重载时间轴
 * - store 轨道变化 → 引擎同步（新增/隐藏/删除）
 * - 侧栏屏蔽/删除后的 refreshSignal 强刷（清屏 + 按当前时间补发）
 * - 房间 'danmaku' 实时事件接收上屏；本端发送（本地立即上屏 + send-comment
 *   持久化 + send-danmaku 广播）
 */
export function useDanmakuBridge({
  socket,
  roomId,
  videoRef,
  cid,
  sourceType,
}: {
  socket: Socket | null
  roomId: string
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 当前 B站 视频 cid（非 B站 源为空） */
  cid: number | null | undefined
  /** 当前影片源类型（仅 'bilibili' 加载官方弹幕） */
  sourceType: string
}) {
  const danmakuLayerRef = useRef<DanmakuLayerHandle | null>(null)
  const danmakuItemsRef = useRef<DanmakuItem[]>([])
  const loadedTracksRef = useRef<Set<string>>(new Set())
  const [danmakuEnabled, setDanmakuEnabled] = useState(true)

  const tracks = useDanmakuStore((state) => state.tracks)
  const tracksRef = useRef(tracks)
  useEffect(() => {
    tracksRef.current = tracks
  }, [tracks])
  const style = useDanmakuStore((state) => state.style)
  const blockKeywords = useDanmakuStore((state) => state.blockKeywords)
  const setDefaultTrack = useDanmakuStore((state) => state.setDefaultTrack)
  const setStyle = useDanmakuStore((state) => state.setStyle)
  const setFilters = useDanmakuStore((state) => state.setFilters)
  const setAdvancedStyle = useDanmakuStore((state) => state.setAdvancedStyle)
  const resetStyle = useDanmakuStore((state) => state.resetStyle)
  const addRealtime = useDanmakuStore((state) => state.addRealtime)

  // 加载 B站 官方弹幕：缓存后通过 DanmakuLayer 时间轴弹幕接口加载
  useEffect(() => {
    if (!cid || sourceType !== 'bilibili') {
      danmakuItemsRef.current = []
      setDefaultTrack([])
      danmakuLayerRef.current?.loadDanmakuTrack('default', [])
      danmakuLayerRef.current?.clear()
      return
    }
    // 切换B站视频时立即清空旧弹幕，避免异步加载新弹幕期间
    // 旧弹幕仍保留在 danmaku.js comments 数组中被重新发射
    danmakuLayerRef.current?.loadDanmakuTrack('default', [])
    danmakuLayerRef.current?.clear()
    fetchBilibiliDanmakuByCid(cid)
      .then((items) => {
        danmakuItemsRef.current = items
        setDefaultTrack(items)
        danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
        danmakuLayerRef.current?.seek(videoRef.current?.currentTime ?? 0)
      })
      .catch((err) => {
        console.error('[WatchTogether] load danmaku error:', err)
      })
  }, [cid, sourceType, setDefaultTrack, videoRef])

  // 弹幕开关重新开启时，重新加载当前时间轴弹幕并 seek 到当前时间
  useEffect(() => {
    if (!danmakuEnabled) return
    const items = danmakuItemsRef.current
    if (items.length > 0) {
      danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
      danmakuLayerRef.current?.seek(videoRef.current?.currentTime ?? 0)
    }
  }, [danmakuEnabled, videoRef])

  // 同步 store 中的轨道变化到弹幕引擎
  useEffect(() => {
    const layer = danmakuLayerRef.current
    if (!layer) return
    const current = new Set<string>()
    tracks.forEach((track) => {
      if (track.hidden) {
        return
      }
      layer.loadDanmakuTrack(track.trackId, track.items, track.offset)
      current.add(track.trackId)
    })
    loadedTracksRef.current.forEach((id) => {
      if (!current.has(id)) {
        layer.removeDanmakuTrack(id)
      }
    })
    loadedTracksRef.current = current
  }, [tracks])

  // 侧栏屏蔽 / 删除弹幕后刷新弹幕层：先以最新轨道数据重新加载引擎，
  // 再清屏并按当前时间重载，避免 tracks 与 refreshSignal 效果时序不一致
  // 导致被删除/恢复的弹幕仍被渲染。
  const refreshSignal = useDanmakuStore((state) => state.refreshSignal)
  useEffect(() => {
    const layer = danmakuLayerRef.current
    if (!layer) return
    // 使用 ref 读取最新 tracks，确保清屏前引擎已应用删除/恢复后的数据
    tracksRef.current.forEach((track) => {
      if (track.hidden) return
      layer.loadDanmakuTrack(track.trackId, track.items, track.offset)
    })
    const current = videoRef.current?.currentTime ?? 0
    layer.clear()
    layer.seek(current)
    // 立即按当前时间补发当前窗口内的弹幕，避免等待下一次 timeupdate，
    // 让删除/恢复后的画面立刻呈现剩余弹幕。
    layer.syncTime(current)
  }, [refreshSignal, videoRef, tracksRef])

  // 实时弹幕接收（'danmaku' 事件）：上屏 + 记录到实时弹幕列表
  useEffect(() => {
    if (!socket) return
    const handleDanmaku = (payload: {
      id?: string
      text: string
      sender?: string
    }) => {
      if (!payload?.text) return
      danmakuLayerRef.current?.sendDanmaku(payload.text, {
        sender: payload.sender,
      })
      addRealtime({
        id:
          payload.id ??
          `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: payload.text,
        sender: payload.sender,
        time: videoRef.current?.currentTime ?? 0,
      })
    }
    socket.on('danmaku', handleDanmaku)
    return () => {
      socket.off('danmaku', handleDanmaku)
    }
  }, [socket, addRealtime, videoRef])

  const handleToggleDanmaku = useCallback(() => {
    setDanmakuEnabled((prev) => !prev)
  }, [])

  // 弹幕点击：复制文本到剪贴板
  // 弹幕渲染时可能拼接了 "发送者: 内容" 前缀，复制时去掉前缀只保留内容部分
  const copy = useCopyToClipboard()
  const handleDanmakuClick = useCallback(
    (text: string) => {
      // 提取内容：若文本以 "xxx: " 开头（发送者前缀），则取冒号后内容；否则用原文
      const colonIdx = text.indexOf(': ')
      const content =
        colonIdx >= 0 && colonIdx < 30 ? text.slice(colonIdx + 2) : text
      const textToCopy = content.trim() || text.trim()
      if (!textToCopy) return

      void copy(textToCopy, {
        successMessage: t('已复制弹幕内容'),
        errorMessage: t('复制失败'),
      })
    },
    [copy]
  )

  const handleSendDanmaku = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const item: DanmakuItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: trimmed,
        time: videoRef.current?.currentTime ?? 0,
        mode: 1,
        color: 16777215,
        size: 25,
      }

      // 本地立即上屏（发送者自己看到）
      danmakuLayerRef.current?.sendDanmaku(trimmed, { sender: t('我') })
      addRealtime({ ...item, self: true, sender: t('我') })

      if (!socket) return
      // 发送评论（持久化 + 广播 new-comment）
      socket.emit(
        'send-comment',
        { roomId, content: trimmed, isDanmaku: true },
        (response: { success: boolean; message?: string }) => {
          if (!response.success) {
            message.error(response.message ?? t('弹幕发送失败'))
          }
        }
      )
      // 广播弹幕事件（其他客户端通过 'danmaku' 事件上屏）
      socket.emit('send-danmaku', {
        roomId,
        content: trimmed,
        videoTime: videoRef.current?.currentTime ?? 0,
      })
    },
    [socket, roomId, videoRef, addRealtime]
  )

  return {
    /** 弹幕图层 ref（挂载 DanmakuLayer 用） */
    danmakuLayerRef,
    danmakuEnabled,
    blockKeywords,
    style,
    setStyle,
    setFilters,
    setAdvancedStyle,
    resetStyle,
    handleToggleDanmaku,
    handleDanmakuClick,
    handleSendDanmaku,
  }
}
