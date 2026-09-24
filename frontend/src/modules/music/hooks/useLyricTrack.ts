/**
 * 歌词轨道 Hook：从「切歌重置」到「三态判定」的一整条链路。
 *
 * 原先内联在 ListenTogetherPanel 约 140 行，涵盖：
 *
 * - **切歌驱动的同步重置**：走 render 期派生（React 官方 props 变化调 state
 *   模式），规避 effect 内同步 setState。清空歌词走防闪烁隐藏、切歌黑块
 *   滑入；连带重置由 `onSongSwitch` 回调交给调用方（如「喜欢」乐观态）
 * - **网易云歌词请求**：`/api/music/ncm/lyric` → 合并原词/翻译/罗马音；
 *   无歌词 → `emptyMode='none'`，纯音乐 → `'pure'`（Lyric-Area 占位装饰）
 * - **B站 本地插播曲目**：歌词改用 AI 字幕（conclusion/get）转换成行
 * - **反闪烁**：等字体就绪（1.5s/0.8s 超时兜底）+ 双帧布局稳定后才揭示
 *   歌词区，避免字体替换时的宽度跳动
 * - **切歌黑块滑出**：700ms 后滑出露出新歌名
 */
import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import type { NcmLyricResponse } from '../types'
import { mergeLyrics, type LyricLine } from '../utils/lrc'

/** 歌词缺失态：none = 无歌词（Lyric-Area 占位），pure = 纯音乐（单行占位） */
export type LyricEmptyMode = 'none' | 'pure' | null

export interface UseLyricTrackOptions {
  /** 网易云曲目 ID（B站 曲目为 null/undefined） */
  songId: number | undefined
  /** 当前曲目 key（`ncm:<id>` / `bili:<bvid>:<cid>`） */
  currentKey: string | null | undefined
  /** B站 视频 BV 号（B站 曲目走 AI 字幕链路） */
  biliBvid?: string | null
  /** B站 分 P cid */
  biliCid?: number
  /** B站 视频时长（毫秒）：AI 字幕带内校验用 */
  biliDurationMs?: number
  /**
   * 切歌瞬间的连带重置回调（在 render 期被调用）——如重置「喜欢」乐观态。
   * 注意：此处只能调用**同一组件**的 setState，语义等价于原本内联的
   * render 期派生更新。
   */
  onSongSwitch?: () => void
}

export function useLyricTrack({
  songId,
  currentKey,
  biliBvid,
  biliCid,
  biliDurationMs,
  onSongSwitch,
}: UseLyricTrackOptions) {
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const [emptyMode, setEmptyMode] = useState<LyricEmptyMode>(null)
  const [lyricRevealed, setLyricRevealed] = useState(false)
  // 切歌动画（歌名黑块滑入遮字）
  const [songSwitching, setSongSwitching] = useState(false)

  // ===== 切歌驱动的同步重置（render 期调整状态）：歌词清空走防闪烁隐藏
  //      （Hydrogen 切歌 lyricShow=false 同语义）、黑块滑入 =====
  const [prevSongId, setPrevSongId] = useState<number | null | undefined>(
    songId
  )
  if (prevSongId !== songId) {
    setPrevSongId(songId)
    setLyricLines([])
    const noLyricSong = songId == null || songId <= 0
    setEmptyMode(noLyricSong ? 'none' : null)
    setLyricRevealed(noLyricSong)
    setSongSwitching(songId != null)
    onSongSwitch?.()
  }

  // ===== 歌词请求（异步回调内 setState；重置已在 render 期完成） =====
  useEffect(() => {
    if (songId == null || songId <= 0) return
    let cancelled = false
    const loadLyric = async () => {
      try {
        const { data } = await apiGet<NcmLyricResponse>(
          `/api/music/ncm/lyric?id=${songId}`
        )
        if (cancelled) return
        const raw = data?.lrc?.lyric ?? ''
        if (!raw.trim()) {
          // 接口无歌词 → Lyric-Area 占位装饰
          setLyricLines([])
          setEmptyMode('none')
        } else if (raw.includes('纯音乐')) {
          // 纯音乐 → 单行占位（Hydrogen buildPureMusicRows）
          setLyricLines([])
          setEmptyMode('pure')
        } else {
          setLyricLines(
            mergeLyrics(
              raw,
              data?.tlyric?.lyric ?? '',
              data?.romalrc?.lyric ?? data?.rlyric?.lyric
            )
          )
          setEmptyMode(null)
        }
      } catch (err) {
        console.error('[useLyricTrack] 获取歌词失败:', err)
        if (!cancelled) {
          setLyricLines([])
          setEmptyMode('none')
        }
      }
      if (!cancelled) {
        // 反闪烁（Hydrogen prepareLyricReveal）：等字体加载完成 + 双帧布局
        // 稳定后再显示歌词区（字体就绪超时 1.5s 兜底，避免阻塞展示）
        const fontsReady = document.fonts?.ready ?? Promise.resolve()
        const timeout = new Promise((resolve) => setTimeout(resolve, 1500))
        Promise.race([fontsReady, timeout]).then(() => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!cancelled) setLyricRevealed(true)
            })
          )
        })
      }
    }
    void loadLyric()
    return () => {
      cancelled = true
    }
  }, [songId])

  // ===== B站 本地插播曲目：歌词用 AI 字幕（conclusion/get）转换 =====
  useEffect(() => {
    if (!currentKey?.startsWith('bili:')) return
    const bvid = biliBvid
    const cid = biliCid
    if (!bvid || !cid) return
    let cancelled = false
    void (async () => {
      try {
        const { data } = await apiGet<{
          lines?: Array<{ from: number; to: number; content: string }>
        }>(
          `/api/stream/bilibili/ai-subtitle?bvid=${bvid}&cid=${cid}&duration=${Math.round(
            (biliDurationMs ?? 0) / 1000
          )}`
        )
        if (cancelled) return
        const lines: LyricLine[] = (data?.lines ?? [])
          .filter((l) => l.content.trim() !== '')
          .map((l, i) => ({
            time: l.from,
            text: l.content,
            lyricLineKey: `bili:${bvid}:${cid}:${i}`,
          }))
        setLyricLines(lines)
        setEmptyMode(lines.length > 0 ? null : 'none')
      } catch {
        if (!cancelled) {
          // AI 字幕不可用（未登录 B站/视频无字幕）：显示无歌词占位
          setLyricLines([])
          setEmptyMode('none')
        }
      }
      const fontsReady = document.fonts?.ready ?? Promise.resolve()
      const timeout = new Promise((resolve) => setTimeout(resolve, 800))
      Promise.race([fontsReady, timeout]).then(() => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!cancelled) setLyricRevealed(true)
          })
        )
      })
    })()
    return () => {
      cancelled = true
    }
  }, [currentKey, biliBvid, biliCid, biliDurationMs])

  // ===== 切歌黑块滑出定时（700ms 后滑出露出新歌名） =====
  useEffect(() => {
    if (!songSwitching) return
    const timer = setTimeout(() => setSongSwitching(false), 700)
    return () => clearTimeout(timer)
  }, [songSwitching])

  return { lyricLines, emptyMode, lyricRevealed, songSwitching }
}
