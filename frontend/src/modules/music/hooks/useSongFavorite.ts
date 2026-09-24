/**
 * 播放页「喜欢 / 收藏」双子红心能力。
 *
 * 网易云与 B站 两套完全不同的红心语义，原先都内联在 ListenTogetherPanel：
 *
 * **网易云喜欢（likeSong）**
 * - 可用条件：已登录 + 有效 songId
 * - 初始态由 `/account` 取 uid 再 `/likelist` 取 ids 判定，失败静默（按钮
 *   仍可点，走乐观更新）
 * - 点击乐观更新，失败回滚
 * - 切歌重置乐观态（render 期派生，替代 effect 内同步 setState）
 *
 * **B站 收藏（歌词页工具栏红心）**
 * - 目标夹来自设置「红心收藏夹」，一键收藏/取消收藏
 * - 回显走官方 fav/folder/created/list-all：任意夹命中即点亮，**不限于设置
 *   的目标夹**（视频可能已被 B站 端收进别的夹 / 夹改名）
 * - 取消收藏时带「实际命中的夹 id」回传，避免按标题解析到别的夹
 * - 本地会话记忆 biliCollectedMark 与官方查询结果对齐
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import {
  useMusicSettingsStore,
  normalizeBiliLikeFavTitle,
} from '../store-settings'
import type { NcmAccountResponse, NcmLikelistResponse } from '../types'

export interface UseSongFavoriteOptions {
  /** 网易云曲目 ID（B站 曲目为 null/undefined） */
  songId: number | undefined
  /** B站 视频 BV 号（无则为 null） */
  biliBvid: string | null
  /** 网易云是否已登录（未登录则整「喜欢」能力不可用） */
  ncmLoggedIn: boolean
}

export function useSongFavorite({
  songId,
  biliBvid,
  ncmLoggedIn,
}: UseSongFavoriteOptions) {
  // ===== 网易云喜欢：可用条件 = 已登录 + 有效 songId =====
  const canLike = ncmLoggedIn && songId != null && songId > 0
  /** 喜欢（乐观状态） */
  const [liked, setLiked] = useState(false)
  const [likeBusy, setLikeBusy] = useState(false)

  // 切歌重置乐观态（render 期派生）
  const [prevSongId, setPrevSongId] = useState<number | null | undefined>(
    songId
  )
  if (prevSongId !== songId) {
    setPrevSongId(songId)
    setLiked(false)
  }

  // 查询当前喜欢状态（/account 取 uid → /likelist 取 ids）
  useEffect(() => {
    if (!canLike || songId == null) return
    let cancelled = false
    const query = async () => {
      try {
        const acc = await apiGet<NcmAccountResponse>(
          `/api/music/ncm/user/account?timestamp=${Date.now()}`
        )
        if (cancelled) return
        const uid = acc?.data?.account?.id ?? acc?.data?.profile?.userId
        if (!uid) return
        const list = await apiGet<NcmLikelistResponse>(
          `/api/music/ncm/likelist?uid=${uid}&timestamp=${Date.now()}`
        )
        if (cancelled) return
        const ids = list?.data?.ids ?? []
        if (Array.isArray(ids)) setLiked(ids.includes(songId))
      } catch {
        // 静默失败：按钮仍可点（乐观更新），仅初始状态未知
      }
    }
    void query()
    return () => {
      cancelled = true
    }
  }, [canLike, songId])

  /** 点击红心：乐观更新 + 失败回滚 */
  const toggleLike = useCallback(async () => {
    if (!canLike || songId == null || likeBusy) return
    const nextLiked = !liked
    setLiked(nextLiked)
    setLikeBusy(true)
    try {
      await apiGet(
        `/api/music/ncm/like?id=${songId}&like=${nextLiked}&timestamp=${Date.now()}`
      )
    } catch {
      // 失败回滚乐观状态
      setLiked(!nextLiked)
    } finally {
      setLikeBusy(false)
    }
  }, [canLike, songId, liked, likeBusy])

  // ===== B站 收藏：直接收藏到「红心收藏夹」+ 打开收藏夹选择弹窗 =====
  const biliLikeFavTitle = normalizeBiliLikeFavTitle(
    useMusicSettingsStore((s) => s.biliLikeFavTitle)
  )
  const [biliFavModalOpen, setBiliFavModalOpen] = useState(false)
  const [biliCollecting, setBiliCollecting] = useState(false)
  /** 红心收藏标记：folder/folderId 为**实际命中**的收藏夹（官方接口查得，
   *  可能不是设置的目标夹——视频可能被在 B站 端收进别的夹/夹改名） */
  const [biliCollectedMark, setBiliCollectedMark] = useState<{
    bvid: string
    folder: string
    folderId?: number
  } | null>(null)
  const biliCollected = biliBvid != null && biliCollectedMark?.bvid === biliBvid

  /** 收藏/取消收藏开关：已收藏（该视频在任意收藏夹中）时点击即取消收藏
   *  （后端 resource/deal del_media_ids，定向到实际命中的收藏夹 id），
   *  否则一键收藏到设置的目标夹 */
  const toggleBiliCollect = useCallback(async () => {
    if (!biliBvid || biliCollecting) return
    const collected = biliCollectedMark?.bvid === biliBvid
    setBiliCollecting(true)
    try {
      const { data, ok } = await apiPost<{
        success?: boolean
        message?: string
        folderTitle?: string
        folderId?: number
      }>('/api/stream/bilibili/fav/collect', {
        bvid: biliBvid,
        folderTitle: biliLikeFavTitle,
        action: collected ? 'remove' : 'add',
        // 取消收藏时带实际命中夹的 id，避免按标题解析到别的夹
        ...(collected && biliCollectedMark?.folderId
          ? { mediaId: biliCollectedMark.folderId }
          : {}),
      })
      if (!ok || data?.success === false) {
        throw new Error(
          data?.message || (collected ? '取消收藏失败' : '收藏失败')
        )
      }
      if (collected) {
        setBiliCollectedMark(null)
        message.success(
          `已取消收藏「${
            data?.folderTitle || biliCollectedMark?.folder || biliLikeFavTitle
          }」`
        )
      } else {
        setBiliCollectedMark({
          bvid: biliBvid,
          folder: data?.folderTitle || biliLikeFavTitle,
          folderId: data?.folderId,
        })
        message.success(`已收藏到「${data?.folderTitle || biliLikeFavTitle}」`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBiliCollecting(false)
    }
  }, [biliBvid, biliCollecting, biliCollectedMark, biliLikeFavTitle])

  // 红心回显：切到 B站 歌曲时用 B站 官方接口查询该视频是否已在收藏夹里
  // （fav/folder/created/list-all 带 rid → fav_state，任意夹命中即点亮，
  //  不限于设置的目标夹；未登录/失败静默，回显是辅助能力不弹错误——
  //  本地会话内的 mark 仍以此查询结果对齐）
  useEffect(() => {
    if (!biliBvid) return
    let cancelled = false
    void (async () => {
      try {
        const { data, ok } = await apiGet<{
          success?: boolean
          collected?: boolean
          folderId?: number
          folderTitle?: string
        }>(
          `/api/stream/bilibili/fav/status?bvid=${biliBvid}&timestamp=${Date.now()}`
        )
        if (cancelled || !ok || data?.success === false) return
        setBiliCollectedMark(
          data?.collected
            ? {
                bvid: biliBvid,
                folder: data.folderTitle ?? biliLikeFavTitle,
                folderId: data.folderId,
              }
            : null
        )
      } catch (err) {
        console.error('[useSongFavorite] B站 收藏状态查询失败:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [biliBvid, biliLikeFavTitle])

  return {
    /** 网易云喜欢能力是否可用 */
    canLike,
    /** 当前是否已喜欢（乐观状态） */
    liked,
    /** 喜欢请求进行中 */
    likeBusy,
    /** 点击网易云红心 */
    toggleLike,
    /** 设置的 B站 红心收藏夹名 */
    biliLikeFavTitle,
    /** 收藏夹选择弹窗开关 */
    biliFavModalOpen,
    setBiliFavModalOpen,
    /** 当前 B站 视频是否已在收藏夹中 */
    biliCollected,
    /** 本地会话收藏标记（含实际命中的收藏夹名/id；弹窗收藏成功后回写） */
    biliCollectedMark,
    setBiliCollectedMark,
    /** 收藏请求进行中 */
    biliCollecting,
    /** 点击 B站 红心（收藏/取消收藏） */
    toggleBiliCollect,
  }
}
