/**
 * CLI 客户端专用路由。
 *
 * 这些端点供本地运行的 ZViewer CLI 调用，允许用户用自己的 B站 Cookie
 * 解析高画质视频流，再由 CLI 代理给浏览器。
 */

import { Router } from 'express'
import { resolveBilibiliVideo, normalizeResolveError } from '../services/bilibili/resolver'

const router = Router()

/**
 * GET /api/cli/resolve
 *
 * 参数：
 *   bvid: BV 号
 *   cid:  视频分 P 的 cid（可选，未指定时使用第一 P）
 *   qn:   清晰度 qn（可选）
 *   preferMp4: 是否优先 MP4（可选，默认 false）
 *   forceDash: 是否强制 DASH 并禁用 MP4 降级（可选，默认 false）
 *
 * 请求头：
 *   Cookie: 用户自己的 B站 Cookie（需含 SESSDATA）
 *
 * 返回：
 *   与 /api/stream/resolve-bilibili 的 done 消息格式一致。
 */
router.get('/resolve', async (req, res) => {
  const bvid = req.query.bvid
  const cid = req.query.cid
  const qnRaw = req.query.qn
  const preferMp4 = req.query.preferMp4 === 'true' || req.query.preferMp4 === '1'
  const forceDash = req.query.forceDash === 'true' || req.query.forceDash === '1'

  if (typeof bvid !== 'string' || !bvid.trim()) {
    res.status(400).json({ success: false, message: '缺少 bvid 参数' })
    return
  }

  // cid 是可选的：未指定时后端自动使用第一 P
  let cidNum: number | undefined
  if (typeof cid === 'string' && cid.trim()) {
    cidNum = Number(cid)
    if (!Number.isFinite(cidNum)) {
      res.status(400).json({ success: false, message: 'cid 格式错误' })
      return
    }
  }

  const qn =
    typeof qnRaw === 'string' && qnRaw.trim() ? Number(qnRaw.trim()) : undefined

  const cookie = req.headers.cookie || undefined

  try {
    const result = await resolveBilibiliVideo({
      url: `https://www.bilibili.com/video/${bvid}`,
      cookie,
      qn,
      preferMp4,
      forceDash,
      cid: cidNum,
      page: undefined,
      // CLI 使用本地代理播放，实际视频流由用户本机浏览器→CLI 拉取，
      // 后端无需校验 B站 CDN 可达性，避免远程服务器网络差异导致错误降级为 MP4。
      skipCdnCheck: true,
      onProgress: () => {
        // CLI 解析不需要进度推送，静默处理
      },
    })

    res.json({
      success: true,
      title: result.title,
      duration: result.duration,
      cid: result.cid,
      videoUrl: result.videoUrl,
      audioUrl: result.audioUrl,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      format: result.format,
      loggedIn: result.loggedIn,
      vipStatus: result.vipStatus,
      currentQn: result.currentQn,
      acceptQuality: result.acceptQuality,
      pages: result.pages,
      currentPage: result.currentPage,
    })
  } catch (err) {
    console.error('[cli] resolve error:', err)
    const normalized = normalizeResolveError(err)
    res.status(500).json({
      success: false,
      message: normalized.message,
      code: normalized.code,
    })
  }
})

export default router
