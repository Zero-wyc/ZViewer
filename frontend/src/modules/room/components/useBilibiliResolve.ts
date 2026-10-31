/**
 * B站 源的解析流程 hook（纯搬迁自 MoviePushPanel）：
 * - handleResolve：解析输入/搜索选中的 URL（CLI 代理优先，失败回退服务器），
 *   多 P 自动弹出分集选择；仅 bilibili 来源两步走（解析 → 选清晰度 → 添加）。
 * - handleQualityChange：按选定 qn 重新解析（切换清晰度）。
 * - handlePageSelect：按目标分 P/分集 cid/epId 重新解析。
 * 相关状态（resolvedMovie/CLI 路径标记/三个 loading）一并收敛于此。
 * loading/解析进度条仍由面板统一渲染（通过回调注入）。
 */
import { useRef, useState } from 'react'
import { message } from '@/components/ui/message'
import {
  extractBvid,
  extractBilibiliPage,
  extractBangumiId,
  resolveBilibiliViaCli,
  resolveBangumiViaCli,
} from '@/modules/bilibili/cliApi'
import { resolveBilibili } from '@/modules/movie-source/resolveSource'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { getActiveCliProxyUrl } from '@/modules/movie-source/resolver'
import { resolveBilibiliWithCliFallback } from '@/modules/bilibili/resolveWithCliFallback'
import {
  getHdrSupport,
  hdrUnsupportedMessage,
  isHdrQn,
} from '@/modules/player/hdr-capability'
import type { ResolvedSource } from '@/modules/movie-source/resolveSource'
import { t } from '@/i18n'

interface UseBilibiliResolveParams {
  isHost: boolean
  roomId: string
  /** 当前 URL 输入框内容（quality/page 重解析依赖） */
  url: string
  /** 当前来源类型（handleResolve 仅 bilibili 生效） */
  sourceType: string
  setLoading: (loading: boolean) => void
  setResolveProgress: (text: string) => void
}

export function useBilibiliResolve({
  isHost,
  roomId,
  url,
  sourceType,
  setLoading,
  setResolveProgress,
}: UseBilibiliResolveParams) {
  const [resolvedMovie, setResolvedMovie] = useState<ResolvedSource | null>(
    null
  )
  // 最近一次 B站 解析实际使用的路径（true=CLI 代理，false=服务器端）。
  // 添加影片后据此持久化新影片的解析偏好，对齐预览与正式播放的解析语义，
  // 消除「预览 DASH（videojs10-dash）→ 正式播放 MP4（videojs10）」的引擎翻转。
  const resolvedViaCliRef = useRef(false)
  const [qualityLoading, setQualityLoading] = useState(false)
  // 多 P 视频分集选择弹窗
  const [showPageSelector, setShowPageSelector] = useState(false)
  const [pageSelectLoading, setPageSelectLoading] = useState(false)

  // 仅 bilibili 需要 handleResolve：解析后显示清晰度选择器，再点"添加"
  // webdav/ftp/openlist/mp4 的 resolve+add 已合并到 handleAddMovie
  const handleResolve = async (urlOverride?: string) => {
    if (!isHost) {
      message.info(t('只有房主可以添加影片'))
      return
    }
    if (!roomId) {
      message.error(t('未连接房间'))
      return
    }
    if (sourceType !== 'bilibili') return
    // urlOverride：搜索弹窗选中后直接传入目标链接（state 更新时序先于解析）
    const targetUrl = (urlOverride ?? url).trim()
    if (!targetUrl) {
      message.warning(t('请输入视频地址'))
      return
    }

    setLoading(true)
    setResolveProgress(t('正在初始化解析...'))
    try {
      const bvid = extractBvid(targetUrl)
      // PGC（番剧 ep/ss 链接）：CLI 分支按 epId 走番剧解析
      const bangumiId = extractBangumiId(targetUrl)
      // 链接里已带 ?p=N（搜索弹窗选过集、或外部链接指定了分 P）：
      // 解析直接取该 P，且不再二次弹分集选择，否则用户要选两遍
      const pinnedPage = extractBilibiliPage(targetUrl)

      // CLI 已连接时优先使用本地 CLI 代理解析（使用用户自己的 B站 Cookie，可获取高画质）
      const cliProxyUrl = getActiveCliProxyUrl()
      const epId = bangumiId?.epId
      const { resolved, viaCli } = await resolveBilibiliWithCliFallback({
        viaCli:
          cliProxyUrl && epId
            ? () =>
                resolveBangumiViaCli(
                  cliProxyUrl,
                  epId,
                  undefined,
                  undefined,
                  false,
                  true
                )
            : cliProxyUrl && bvid
              ? () =>
                  resolveBilibiliViaCli(
                    cliProxyUrl,
                    bvid,
                    undefined,
                    undefined,
                    false,
                    true,
                    pinnedPage
                  )
              : undefined,
        viaServer: () =>
          resolveBilibili(
            targetUrl,
            undefined,
            (_step, msg) => setResolveProgress(msg),
            pinnedPage != null ? { page: pinnedPage } : undefined
          ),
        cliProgress: epId
          ? t('正在通过 CLI 代理解析番剧...')
          : t('正在通过 CLI 代理解析...'),
        serverProgress: t('正在通过服务器解析...'),
        setProgress: setResolveProgress,
      })
      resolvedViaCliRef.current = viaCli

      // 链接钉死了分 P 时以链接为准：CLI 分支按 cid 解析、可能不回填 currentPage，
      // 这里对齐一下，避免添加后影片记成第一 P
      const resolvedPinned =
        pinnedPage != null && !epId && resolved.currentPage !== pinnedPage
          ? { ...resolved, currentPage: pinnedPage }
          : resolved

      setResolvedMovie(resolvedPinned)
      // PGC 试看提示：会员专享集 + 非大会员账号时后端只返回试看片段
      if (resolvedPinned.preview) {
        message.info(
          t(
            '该集为会员专享，当前为试看片段（约 {{value}} 分钟），使用大会员账号后可看完整内容',
            { value: Math.round((resolvedPinned.duration || 0) / 60) }
          )
        )
      }
      // 自动检测多 P 视频：链接未指定分 P 时才弹分集选择
      // （搜索弹窗选过 P 的链接已带 ?p=，再弹一次等于让用户选两遍）
      if (
        pinnedPage == null &&
        resolvedPinned.pages &&
        resolvedPinned.pages.length > 1
      ) {
        setShowPageSelector(true)
      }
    } catch (err) {
      console.error('[MoviePushPanel] resolve error:', err)
      message.error(err instanceof Error ? err.message : t('解析失败'))
    } finally {
      setLoading(false)
      setResolveProgress('')
    }
  }

  const handleQualityChange = async (selectedQn: string) => {
    if (!resolvedMovie || !url.trim()) return
    const qn = Number(selectedQn)
    if (!Number.isFinite(qn)) return

    // HDR 档位需要 HEVC Main10 解码能力，本机不支持时保持原档位并提示
    if (isHdrQn(qn) && getHdrSupport() === 'none') {
      message.warning(hdrUnsupportedMessage())
      return
    }

    setQualityLoading(true)
    setResolveProgress(t('正在切换清晰度...'))
    try {
      const bvid = extractBvid(url.trim())
      const bangumiId = extractBangumiId(url.trim())

      // CLI 已连接时通过本地 CLI 代理切换清晰度（使用用户自己的 B站 Cookie）
      const cliProxyUrl = getActiveCliProxyUrl()
      const epId = bangumiId?.epId
      const { resolved, viaCli } = await resolveBilibiliWithCliFallback({
        viaCli:
          cliProxyUrl && epId
            ? () =>
                resolveBangumiViaCli(
                  cliProxyUrl,
                  epId,
                  resolvedMovie.cid,
                  qn,
                  false,
                  true
                )
            : cliProxyUrl && bvid
              ? () =>
                  resolveBilibiliViaCli(
                    cliProxyUrl,
                    bvid,
                    resolvedMovie.cid,
                    qn,
                    false,
                    true
                  )
              : undefined,
        viaServer: () =>
          resolveBilibiliWithOptions(url.trim(), qn, (_step, msg) =>
            setResolveProgress(msg)
          ),
        cliProgress: t('正在通过 CLI 代理切换清晰度...'),
        serverProgress: t('正在通过服务器切换清晰度...'),
        setProgress: setResolveProgress,
      })
      resolvedViaCliRef.current = viaCli

      setResolvedMovie(resolved)
    } catch (err) {
      console.error('[MoviePushPanel] switch quality error:', err)
      message.error(err instanceof Error ? err.message : t('切换清晰度失败'))
    } finally {
      setQualityLoading(false)
      setResolveProgress('')
    }
  }

  // 选择分 P：用目标 page 的 cid 重新解析视频流
  const handlePageSelect = async (page: number) => {
    if (!url.trim() || !resolvedMovie) return
    const targetPage = resolvedMovie.pages?.find((p) => p.page === page)
    if (!targetPage) return

    setShowPageSelector(false)
    setPageSelectLoading(true)

    // PGC（番剧分集，page 带 epId）：按目标集 ep 链接/epId 重解析
    if (targetPage.epId) {
      const epUrl = `https://www.bilibili.com/bangumi/play/ep${targetPage.epId}`
      setResolveProgress(
        t('正在解析第 {{page}} 集 {{part}}...', { page, part: targetPage.part })
      )
      try {
        const cliProxyUrl = getActiveCliProxyUrl()
        const { resolved, viaCli } = await resolveBilibiliWithCliFallback({
          viaCli: cliProxyUrl
            ? () =>
                resolveBangumiViaCli(
                  cliProxyUrl,
                  targetPage.epId as number,
                  targetPage.cid,
                  resolvedMovie.currentQn,
                  false,
                  true
                )
            : undefined,
          viaServer: () =>
            resolveBilibiliWithOptions(
              epUrl,
              resolvedMovie.currentQn,
              (_step, msg) => setResolveProgress(msg)
            ),
          cliProgress: t('正在通过 CLI 代理解析第 {{page}} 集...', { page }),
          serverProgress: t('正在通过服务器解析第 {{page}} 集...', { page }),
          setProgress: setResolveProgress,
        })
        resolvedViaCliRef.current = viaCli

        setResolvedMovie(resolved)
        if (resolved.preview) {
          message.info(
            t(
              '该集为会员专享，当前为试看片段（约 {{value}} 分钟），使用大会员账号后可看完整内容',
              { value: Math.round((resolved.duration || 0) / 60) }
            )
          )
        }
      } catch (err) {
        console.error('[MoviePushPanel] page select error:', err)
        message.error(err instanceof Error ? err.message : t('切换分集失败'))
      } finally {
        setPageSelectLoading(false)
        setResolveProgress('')
      }
      return
    }

    setResolveProgress(
      t('正在解析 P{{page}} {{part}}...', { page, part: targetPage.part })
    )
    try {
      const bvid = extractBvid(url.trim())

      // CLI 已连接时通过本地 CLI 代理切换分P（使用用户自己的 B站 Cookie）
      const cliProxyUrl = getActiveCliProxyUrl()
      const { resolved, viaCli } = await resolveBilibiliWithCliFallback({
        viaCli:
          cliProxyUrl && bvid
            ? () =>
                resolveBilibiliViaCli(
                  cliProxyUrl,
                  bvid,
                  targetPage.cid,
                  resolvedMovie.currentQn,
                  false,
                  true
                )
            : undefined,
        viaServer: () =>
          resolveBilibiliWithOptions(
            url.trim(),
            resolvedMovie.currentQn,
            (_step, msg) => setResolveProgress(msg),
            { page }
          ),
        cliProgress: t('正在通过 CLI 代理解析 P{{page}}...', { page }),
        serverProgress: t('正在通过服务器解析 P{{page}}...', { page }),
        setProgress: setResolveProgress,
      })
      resolvedViaCliRef.current = viaCli
      setResolvedMovie(resolved)
    } catch (err) {
      console.error('[MoviePushPanel] page select error:', err)
      message.error(err instanceof Error ? err.message : t('切换分P失败'))
    } finally {
      setPageSelectLoading(false)
      setResolveProgress('')
    }
  }

  return {
    resolvedMovie,
    setResolvedMovie,
    resolvedViaCliRef,
    qualityLoading,
    showPageSelector,
    setShowPageSelector,
    pageSelectLoading,
    handleResolve,
    handleQualityChange,
    handlePageSelect,
  }
}
