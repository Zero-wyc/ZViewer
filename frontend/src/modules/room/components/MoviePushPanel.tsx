import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Link2,
  QrCode,
  LogOut,
  FileVideo,
  User,
  Plus,
  Search,
  Crown,
  FolderOpen,
  Clapperboard,
  ListVideo,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Dropdown } from '@/components/ui/Dropdown'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { Tag } from '@/components/ui/Tag'

import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import { AniSubsSelector } from '@/modules/anisubs/AniSubsSelector'
import {
  resolveAniSubsEpisode,
  buildAniSubsProxyUrl,
  needsAniSubsProxy,
  type AniSubsEpisode,
} from '@/modules/anisubs'
import { KazumiSelector } from '@/modules/kazumi/KazumiSelector'
import {
  resolveKazumiEpisode,
  buildKazumiProxyUrl,
  needsKazumiProxy,
  type KazumiEpisode,
} from '@/modules/kazumi'
import {
  resolveBilibili,
  resolveFTP,
  buildBilibiliImageProxyUrl,
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliLoginStatus,
  getBilibiliUserInfo,
  logoutBilibili,
  type BilibiliUserInfo,
  type ResolvedSource,
  type FTPParams,
} from '@/modules/room/watch-together/resolveSource'
import {
  resolveBilibiliWithOptions,
  filterQualitiesByVip,
} from '@/modules/bilibili/bilibiliApi'
import {
  extractBvid,
  resolveBilibiliViaCli,
  CliConnectionError,
  CliResolveError,
} from '@/modules/bilibili/cliApi'
import { getActiveCliProxyUrl } from '@/modules/room/watch-together/movie-source-resolver'
import {
  resolveOpenList,
  fetchOpenListDirectUrl,
} from '@/modules/openlist/openlistApi'
import { isInternalOpenListServer } from '@/modules/openlist/isInternal'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import { resolveEmby } from '@/modules/emby/embyApi'
import { resolveJellyfin } from '@/modules/jellyfin/jellyfinApi'
import { resolveWebDAV, fetchWebDAVDirectUrl } from '@/modules/webdav/webdavApi'
import MountBrowser from '@/modules/mounts/MountBrowser'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import { resolveFTP as resolveFTPNew } from '@/modules/ftp/ftpApi'
import ServerFilesBrowser from '@/modules/server-files/ServerFilesBrowser'
import {
  resolveServerFile,
  buildServerFileProxyUrl,
} from '@/modules/server-files/serverFilesApi'
import { detectMediaFormat, type MediaFormat } from '@/lib/mediaFormat'
import {
  fetchAllMounts,
  type UnionMount,
  type MountType,
} from '@/modules/mounts'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { cn } from '@/lib/utils'

type SourceType =
  | 'bilibili'
  | 'mp4'
  | 'webdav'
  | 'ftp'
  | 'openlist'
  | 'emby'
  | 'jellyfin'
  | 'anime'
  | 'kazumi'
  | 'server-files'

const ALL_SOURCE_OPTIONS: {
  value: string
  label: string
  rootOnly?: boolean
}[] = [
  { value: 'bilibili', label: '哔哩哔哩' },
  { value: 'mp4', label: '视频直链' },
  { value: 'webdav', label: 'WebDAV' },
  { value: 'ftp', label: 'FTP' },
  { value: 'openlist', label: 'OpenList' },
  { value: 'emby', label: 'Emby' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'anime', label: 'ani-subs 番剧源' },
  { value: 'kazumi', label: 'Kazumi 番剧源' },
  { value: 'server-files', label: '服务器文件', rootOnly: true },
]

function extractTitleFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname
    const filename = pathname.split('/').pop() || url
    return decodeURIComponent(filename)
  } catch {
    return url
  }
}

function normalizeMountPath(path: string): string {
  if (!path) return path
  return path.trim().replace(/^\/+/, '/')
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

interface MoviePushPanelProps {
  isHost: boolean
}

export function MoviePushPanel({ isHost }: MoviePushPanelProps) {
  const userRole = useAuthStore((state) => state.user?.role)
  const { betaFeaturesEnabled, fetchSettings } = useSystemSettingsStore()
  const addMovie = useRoomStore((state) => state.addMovie)
  const fetchMovies = useRoomStore((state) => state.fetchMovies)
  const setPendingPreviewPlay = useRoomStore(
    (state) => state.setPendingPreviewPlay
  )
  const roomId = useRoomStore((state) => state.roomId)
  const [sourceType, setSourceType] = useState<SourceType>('bilibili')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [qualityLoading, setQualityLoading] = useState(false)
  // 「启用转码引擎」勾选项已移除：playsvideo 的启用现由播放时的
  // shouldUsePlaysVideo 依据容器与音轨编码自动判定，无需添加影片时勾选。
  const [resolvedMovie, setResolvedMovie] = useState<ResolvedSource | null>(
    null
  )
  // B站 解析进度：在推送面板也展示后台解析过程
  const [resolveProgress, setResolveProgress] = useState<string>('')

  // WebDAV / FTP / OpenList 表单状态
  const [webdav, setWebdav] = useState<{
    serverUrl: string
    path: string
  }>({
    serverUrl: '',
    path: '',
  })
  const [webdavDirectLink, setWebdavDirectLink] = useState(false)
  const [openlistDirectLink, setOpenlistDirectLink] = useState(false)
  const [embyDirectLink, setEmbyDirectLink] = useState(false)
  const [jellyfinDirectLink, setJellyfinDirectLink] = useState(false)
  const [ftp, setFtp] = useState<FTPParams>({
    serverUrl: '',
    path: '',
    port: 21,
    username: '',
    password: '',
  })
  const [openlist, setOpenlist] = useState<{
    serverUrl: string
    path: string
  }>({
    serverUrl: '',
    path: '',
  })
  // OpenList 内网地址检测：浏览器无法直连内网 raw_url，必须强制使用服务器转发
  const isOpenlistInternal = isInternalOpenListServer(openlist.serverUrl)
  // WebDAV 内网地址检测：浏览器无法直连内网服务器，必须强制使用服务器转发
  const isWebdavInternal = isInternalOpenListServer(webdav.serverUrl)

  // 已保存挂载
  const [mounts, setMounts] = useState<UnionMount[]>([])
  const [selectedMountId, setSelectedMountId] = useState<string>('')
  const [browsingMount, setBrowsingMount] = useState<UnionMount | null>(null)

  const [bilibiliLoggedIn, setBilibiliLoggedIn] = useState(false)
  const [bilibiliUser, setBilibiliUser] = useState<BilibiliUserInfo | null>(
    null
  )
  const [avatarError, setAvatarError] = useState(false)
  const [animeOpen, setAnimeOpen] = useState(false)
  const [kazumiOpen, setKazumiOpen] = useState(false)
  const [serverFilesBrowserOpen, setServerFilesBrowserOpen] = useState(false)
  const [serverFilePath, setServerFilePath] = useState('')
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrStatus, setQrStatus] = useState(0)
  const [qrMessage, setQrMessage] = useState('请使用哔哩哔哩 App 扫码登录')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPollingRef = useRef(false)
  const qrRetryCountRef = useRef(0)
  // 多 P 视频分集选择弹窗
  const [showPageSelector, setShowPageSelector] = useState(false)
  const [pageSelectLoading, setPageSelectLoading] = useState(false)

  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])

  useEffect(() => {
    if (
      !betaFeaturesEnabled &&
      (sourceType === 'anime' || sourceType === 'kazumi')
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 仅在 betaFeaturesEnabled 切换时回退一次，非每次渲染触发
      setSourceType('bilibili')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betaFeaturesEnabled])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sourceType 变化时重置状态
    setResolvedMovie(null)
    setOpenlist({ serverUrl: '', path: '' })
    setSelectedMountId('')
    if (sourceType !== 'bilibili') return
    getBilibiliLoginStatus().then((loggedIn) => {
      setBilibiliLoggedIn(loggedIn)
      if (loggedIn) {
        getBilibiliUserInfo().then((info) => {
          if (info) setBilibiliUser(info)
        })
      } else {
        setBilibiliUser(null)
      }
    })
  }, [sourceType])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 头像变化时重置错误状态
    setAvatarError(false)
  }, [bilibiliUser?.avatar])

  const stopQrPolling = useCallback(() => {
    isPollingRef.current = false
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const startQrPolling = useCallback(
    (key: string) => {
      if (isPollingRef.current) return
      isPollingRef.current = true
      qrRetryCountRef.current = 0

      const poll = async () => {
        if (!isPollingRef.current) return
        try {
          const result = await pollBilibiliQrCode(key)
          qrRetryCountRef.current = 0
          setQrStatus(result.status)
          if (result.status === 0) {
            setQrMessage('请使用哔哩哔哩 App 扫码登录')
          } else if (result.status === 1) {
            setQrMessage('已扫码，请在 App 中确认登录')
          } else if (result.status === 2) {
            setQrMessage('登录成功')
            setBilibiliLoggedIn(true)
            const info = await getBilibiliUserInfo()
            if (info) setBilibiliUser(info)
            setQrModalOpen(false)
            message.success('B站 登录成功')
            stopQrPolling()
            return
          } else if (result.status === 3) {
            setQrMessage('二维码已过期，请重新获取')
            stopQrPolling()
            return
          }
          pollTimerRef.current = setTimeout(poll, 2000)
        } catch (err) {
          console.error('[MoviePushPanel] QR poll error:', err)
          qrRetryCountRef.current += 1
          if (qrRetryCountRef.current <= 2) {
            setQrMessage('轮询状态失败，正在重试…')
            pollTimerRef.current = setTimeout(poll, 2000)
          } else {
            setQrMessage('轮询状态失败，请重新获取')
            stopQrPolling()
          }
        }
      }

      void poll()
    },
    [stopQrPolling]
  )

  const handleOpenQrModal = useCallback(async () => {
    stopQrPolling()
    setQrStatus(0)
    setQrMessage('请使用哔哩哔哩 App 扫码登录')
    setQrModalOpen(true)
    try {
      const data = await getBilibiliQrCode()
      setQrDataUrl(data.qrDataUrl)
      startQrPolling(data.qrcodeKey)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取二维码失败')
      setQrModalOpen(false)
    }
  }, [stopQrPolling, startQrPolling])

  const handleCloseQrModal = useCallback(() => {
    stopQrPolling()
    setQrModalOpen(false)
  }, [stopQrPolling])

  const handleLogoutBilibili = useCallback(async () => {
    try {
      await logoutBilibili()
      setBilibiliLoggedIn(false)
      setBilibiliUser(null)
      message.success('已退出 B站 登录')
    } catch {
      message.error('退出登录失败')
    }
  }, [])

  const handleSelectAnimeEpisode = useCallback(
    async (sourceId: string, episode: AniSubsEpisode, title: string) => {
      if (!isHost) {
        message.info('只有房主可以播放影片')
        return
      }
      if (!roomId) {
        message.error('未连接房间')
        return
      }

      setLoading(true)
      try {
        const resolved = await resolveAniSubsEpisode(sourceId, episode)

        // 防盗链处理：若返回 headers（Referer/UA 等），走后端代理 URL
        // 浏览器无法为 video.src 设置 Referer/UA，必须代理
        const finalUrl = needsAniSubsProxy(resolved.url, resolved.headers)
          ? buildAniSubsProxyUrl(resolved.url, resolved.headers)
          : resolved.url

        // 1. 触发实时预览播放（通过 store 解耦 useWatchTogether）
        //    代理 URL 已包含防盗链信息，无需再传 headers
        setPendingPreviewPlay({
          url: finalUrl,
          title,
          sourceType: 'anime',
          format: resolved.format,
        })

        // 2. 同时异步加入影片列表（不阻塞预览播放）
        //    ani-subs 的视频地址带 token/signature，短期有效，
        //    因此存储 sourceMeta 元数据而非解析后的 URL。
        //    播放时（含刷新恢复）通过 sourceMeta 重新解析获取最新地址。
        //    url 字段存储 sourceId 作为标识，便于调试和日志追踪。
        void addMovie(roomId, {
          url: `anisubs://${sourceId}/${episode.id}`,
          title,
          source: 'anime',
          format: resolved.format,
          sourceMeta: {
            sourceId,
            episode,
            originalTitle: title,
          },
        })
          .then(() => fetchMovies(roomId))
          .catch((err) => {
            console.error(
              '[MoviePushPanel] addMovie/fetchMovies after preview failed:',
              err
            )
          })

        message.success('已开始播放并加入列表')
      } catch (err) {
        console.error('[MoviePushPanel] select anime episode error:', err)
        message.error(err instanceof Error ? err.message : '加载番剧集数失败')
      } finally {
        setLoading(false)
      }
    },
    [isHost, roomId, addMovie, fetchMovies, setPendingPreviewPlay]
  )

  const handleSelectKazumiEpisode = useCallback(
    async (sourceId: string, episode: KazumiEpisode, title: string) => {
      if (!isHost) {
        message.info('只有房主可以播放影片')
        return
      }
      if (!roomId) {
        message.error('未连接房间')
        return
      }

      setLoading(true)
      try {
        const resolved = await resolveKazumiEpisode(sourceId, episode)

        const finalUrl = needsKazumiProxy(resolved.url, resolved.headers)
          ? buildKazumiProxyUrl(resolved.url, resolved.headers)
          : resolved.url

        setPendingPreviewPlay({
          url: finalUrl,
          title,
          sourceType: 'kazumi',
          format: resolved.format,
        })

        void addMovie(roomId, {
          url: finalUrl,
          title,
          source: 'kazumi',
          format: resolved.format,
        })
          .then(() => fetchMovies(roomId))
          .catch((err) => {
            console.error(
              '[MoviePushPanel] addMovie/fetchMovies after kazumi preview failed:',
              err
            )
          })

        message.success('已开始播放并加入列表')
      } catch (err) {
        console.error('[MoviePushPanel] select kazumi episode error:', err)
        message.error(err instanceof Error ? err.message : '加载番剧集数失败')
      } finally {
        setLoading(false)
      }
    },
    [isHost, roomId, addMovie, fetchMovies, setPendingPreviewPlay]
  )

  useEffect(() => {
    fetchAllMounts()
      .then((data) => setMounts(data))
      .catch((err) => {
        console.error('[MoviePushPanel] fetch mounts error:', err)
      })
  }, [])

  useEffect(() => {
    return () => {
      stopQrPolling()
    }
  }, [stopQrPolling])

  const handleMountSelect = (value: string) => {
    setSelectedMountId(value)
    const id = Number(value)
    if (!id) return
    const mount = mounts.find((m) => m.id === id)
    if (!mount) return
    if (sourceType === 'webdav') {
      setWebdav({
        serverUrl: mount.serverUrl || '',
        path: normalizeMountPath('path' in mount ? mount.path || '' : ''),
      })
      // 内网挂载强制使用服务器转发（后端已保证 directLink=false，前端双重保险）
      const rawDirectLink = 'directLink' in mount ? mount.directLink : false
      setWebdavDirectLink(
        rawDirectLink && !isInternalOpenListServer(mount.serverUrl || '')
          ? true
          : false,
      )
    } else if (sourceType === 'ftp') {
      setFtp((prev) => ({
        ...prev,
        serverUrl: mount.serverUrl || '',
        port: 'port' in mount && mount.port ? mount.port : 21,
        path: normalizeMountPath('path' in mount ? mount.path || '' : ''),
        username: mount.username || '',
        // 密码由后端挂载配置内部管理，列表接口不返回密码
        password: '',
      }))
    } else if (sourceType === 'openlist') {
      setOpenlist({
        serverUrl: mount.serverUrl || '',
        path: normalizeMountPath('path' in mount ? mount.path || '' : ''),
      })
      // 内网挂载强制使用服务器转发（后端已保证 directLink=false，前端双重保险）
      const rawDirectLink = 'directLink' in mount ? mount.directLink : false
      setOpenlistDirectLink(
        rawDirectLink && !isInternalOpenListServer(mount.serverUrl || '')
          ? true
          : false,
      )
    } else if (sourceType === 'emby') {
      // emby 使用挂载自带的 API Key / 账号配置，无需回填表单字段
      setEmbyDirectLink('directLink' in mount ? mount.directLink : false)
    } else if (sourceType === 'jellyfin') {
      setJellyfinDirectLink('directLink' in mount ? mount.directLink : false)
    }
  }

  // 切换到挂载型来源（或挂载列表加载完成）时，自动预选该类型的第一个挂载；
  // 当前选中项不属于该类型时同样重选，避免下拉框显示空值。
  // 选「手动填写」后不强制回弹（selectedMountId 不在依赖里，仅随类型/列表变化触发）
  useEffect(() => {
    const mountTypes: SourceType[] = [
      'webdav',
      'ftp',
      'openlist',
      'emby',
      'jellyfin',
    ]
    if (!mountTypes.includes(sourceType)) return
    const current = mounts.find((m) => String(m.id) === selectedMountId)
    if (current && current.type === sourceType) return
    const first = mounts.find((m) => m.type === (sourceType as MountType))
    if (first) {
      handleMountSelect(String(first.id))
    } else if (selectedMountId) {
      setSelectedMountId('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, mounts])

  const handleSelectFilesFromMount = useCallback(
    async (paths: string[]) => {
      if (!isHost) {
        message.info('只有房主可以添加影片')
        return
      }
      if (!roomId) {
        message.error('未连接房间')
        return
      }

      const mountId = Number(selectedMountId)
      if (!mountId) {
        message.warning('请选择已保存的挂载')
        return
      }

      setLoading(true)
      setResolveProgress(`正在批量解析 ${paths.length} 个文件...`)
      try {
        let added = 0
        for (const path of paths) {
          const normalizedPath = normalizeMountPath(path)
          if (sourceType === 'webdav' || sourceType === 'openlist') {
            // WebDAV 与 OpenList 共用同一套协议逻辑，仅 API 前缀与直链获取不同
            // 内网地址强制使用服务器转发（浏览器无法直连内网服务器）
            const isDirect =
              sourceType === 'webdav'
                ? (isWebdavInternal ? false : webdavDirectLink)
                : (isOpenlistInternal ? false : openlistDirectLink)
            const serverUrl =
              (sourceType === 'webdav'
                ? webdav.serverUrl
                : openlist.serverUrl
              ).trim() || undefined
            const resolveMount =
              sourceType === 'webdav' ? resolveWebDAV : resolveOpenList
            const fetchDirect =
              sourceType === 'webdav'
                ? fetchWebDAVDirectUrl
                : fetchOpenListDirectUrl

            if (isDirect) {
              // 直链模式：后端通过挂载凭证获取直链 URL（OpenList 为 AList 签名直链，WebDAV 为拼接）
              const movieUrl = await fetchDirect(mountId, normalizedPath)
              const title = extractTitleFromUrl(normalizedPath)
              await addMovie(roomId, {
                url: movieUrl,
                title,
                source: sourceType,
                serverUrl,
                path: normalizedPath,
                directLink: true,
              })
            } else {
              // 代理模式：resolve 返回相对 proxy URL，后端随后用 movieId 重写为 stream URL
              const resolved = await resolveMount(mountId, normalizedPath)
              const title =
                resolved.title || extractTitleFromUrl(normalizedPath)
              await addMovie(roomId, {
                url: resolved.videoUrl,
                title,
                source: sourceType,
                format: resolved.format,
                duration: resolved.duration,
                serverUrl,
                path: normalizedPath,
                directLink: false,
              })
            }
            added++
          } else if (sourceType === 'ftp') {
            const resolved = await resolveFTPNew(mountId, normalizedPath)
            const title = resolved.title || extractTitleFromUrl(normalizedPath)
            await addMovie(roomId, {
              url: resolved.videoUrl,
              title,
              source: 'ftp',
              format: resolved.format,
              serverUrl: ftp.serverUrl.trim(),
              path: normalizedPath,
              username: ftp.username || undefined,
              password: ftp.password || undefined,
            })
            added++
          } else if (sourceType === 'emby') {
            // Emby：解析播放信息，支持服务器转发（默认）或直链直连
            const resolved = await resolveEmby(mountId, normalizedPath)
            const title = resolved.title || extractTitleFromUrl(normalizedPath)
            const mount = mounts.find((m) => m.id === mountId)
            await addMovie(roomId, {
              url:
                embyDirectLink && resolved.directUrl
                  ? resolved.directUrl
                  : resolved.videoUrl,
              title,
              source: 'emby',
              format: resolved.format,
              duration: resolved.duration,
              serverUrl: mount?.serverUrl,
              path: normalizedPath,
              directLink: embyDirectLink,
            })
            added++
          } else if (sourceType === 'jellyfin') {
            const resolved = await resolveJellyfin(mountId, normalizedPath)
            const title = resolved.title || extractTitleFromUrl(normalizedPath)
            const mount = mounts.find((m) => m.id === mountId)
            await addMovie(roomId, {
              url:
                jellyfinDirectLink && resolved.directUrl
                  ? resolved.directUrl
                  : resolved.videoUrl,
              title,
              source: 'jellyfin',
              format: resolved.format,
              duration: resolved.duration,
              serverUrl: mount?.serverUrl,
              path: normalizedPath,
              directLink: jellyfinDirectLink,
            })
            added++
          }
        }
        message.success(`已添加 ${added} 部影片`)
      } catch (err) {
        console.error('[MoviePushPanel] batch add error:', err)
        message.error(err instanceof Error ? err.message : '批量添加失败')
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
    },
    [
      isHost,
      roomId,
      selectedMountId,
      sourceType,
      webdav.serverUrl,
      webdavDirectLink,
      ftp.serverUrl,
      ftp.username,
      ftp.password,
      openlist.serverUrl,
      openlistDirectLink,
      embyDirectLink,
      jellyfinDirectLink,
      mounts,
      addMovie,
    ]
  )

  const resetForm = () => {
    setUrl('')
    setResolvedMovie(null)
    setSelectedMountId('')
    setWebdav({ serverUrl: '', path: '' })
    setWebdavDirectLink(false)
    setOpenlistDirectLink(false)
    setEmbyDirectLink(false)
    setJellyfinDirectLink(false)
    setFtp({ serverUrl: '', path: '', port: 21, username: '', password: '' })
    setOpenlist({ serverUrl: '', path: '' })
    setServerFilePath('')
  }

  // 仅 bilibili 需要 handleResolve：解析后显示清晰度选择器，再点"添加"
  // webdav/ftp/openlist/mp4 的 resolve+add 已合并到 handleAddMovie
  const handleResolve = async () => {
    if (!isHost) {
      message.info('只有房主可以添加影片')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }
    if (sourceType !== 'bilibili') return
    if (!url.trim()) {
      message.warning('请输入视频地址')
      return
    }

    setLoading(true)
    setResolveProgress('正在初始化解析...')
    try {
      const bvid = extractBvid(url.trim())

      let resolved: ResolvedSource | undefined
      // CLI 已连接时优先使用本地 CLI 代理解析（使用用户自己的 B站 Cookie，可获取高画质）
      const cliProxyUrl = getActiveCliProxyUrl()
      if (cliProxyUrl && bvid) {
        try {
          setResolveProgress('正在通过 CLI 代理解析...')
          resolved = await resolveBilibiliViaCli(
            cliProxyUrl,
            bvid,
            undefined,
            undefined,
            false,
            true
          )
        } catch (cliErr) {
          // CLI 代理解析失败：连接失败或后端返回错误，自动回退到服务器端解析
          if (cliErr instanceof CliConnectionError) {
            console.warn('[MoviePushPanel] CLI 代理连接失败，回退到服务器端解析')
          } else if (cliErr instanceof CliResolveError) {
            message.warning(`${cliErr.message}，已回退到服务器端解析`)
          }
          // resolved 保持 undefined，下方走服务器端解析
        }
      }

      if (!resolved) {
        setResolveProgress('正在通过服务器解析...')
        resolved = await resolveBilibili(url.trim(), undefined, (_step, msg) =>
          setResolveProgress(msg)
        )
      }

      setResolvedMovie(resolved)
      // 自动检测多 P 视频：若有多 P，弹出分集选择界面
      if (resolved.pages && resolved.pages.length > 1) {
        setShowPageSelector(true)
      }
    } catch (err) {
      console.error('[MoviePushPanel] resolve error:', err)
      message.error(err instanceof Error ? err.message : '解析失败')
    } finally {
      setLoading(false)
      setResolveProgress('')
    }
  }

  const handleQualityChange = async (selectedQn: string) => {
    if (!resolvedMovie || !url.trim()) return
    const qn = Number(selectedQn)
    if (!Number.isFinite(qn)) return

    setQualityLoading(true)
    setResolveProgress('正在切换清晰度...')
    try {
      const bvid = extractBvid(url.trim())

      let resolved: ResolvedSource | undefined
      // CLI 已连接时通过本地 CLI 代理切换清晰度（使用用户自己的 B站 Cookie）
      const cliProxyUrl = getActiveCliProxyUrl()
      if (cliProxyUrl && bvid) {
        try {
          setResolveProgress('正在通过 CLI 代理切换清晰度...')
          resolved = await resolveBilibiliViaCli(
            cliProxyUrl,
            bvid,
            resolvedMovie.cid,
            qn,
            false,
            true
          )
        } catch (cliErr) {
          if (cliErr instanceof CliConnectionError) {
            console.warn('[MoviePushPanel] CLI 代理连接失败，回退到服务器端解析')
          } else if (cliErr instanceof CliResolveError) {
            message.warning(`${cliErr.message}，已回退到服务器端解析`)
          }
        }
      }

      if (!resolved) {
        setResolveProgress('正在通过服务器切换清晰度...')
        resolved = await resolveBilibiliWithOptions(
          url.trim(),
          qn,
          (_step, msg) => setResolveProgress(msg)
        )
      }
      setResolvedMovie(resolved)
    } catch (err) {
      console.error('[MoviePushPanel] switch quality error:', err)
      message.error(err instanceof Error ? err.message : '切换清晰度失败')
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
    setResolveProgress(`正在解析 P${page} ${targetPage.part}...`)
    try {
      const bvid = extractBvid(url.trim())

      let resolved: ResolvedSource | undefined
      // CLI 已连接时通过本地 CLI 代理切换分P（使用用户自己的 B站 Cookie）
      const cliProxyUrl = getActiveCliProxyUrl()
      if (cliProxyUrl && bvid) {
        try {
          setResolveProgress(`正在通过 CLI 代理解析 P${page}...`)
          resolved = await resolveBilibiliViaCli(
            cliProxyUrl,
            bvid,
            targetPage.cid,
            resolvedMovie.currentQn,
            false,
            true
          )
        } catch (cliErr) {
          if (cliErr instanceof CliConnectionError) {
            console.warn('[MoviePushPanel] CLI 代理连接失败，回退到服务器端解析')
          } else if (cliErr instanceof CliResolveError) {
            message.warning(`${cliErr.message}，已回退到服务器端解析`)
          }
        }
      }

      if (!resolved) {
        setResolveProgress(`正在通过服务器解析 P${page}...`)
        resolved = await resolveBilibiliWithOptions(
          url.trim(),
          resolvedMovie.currentQn,
          (_step, msg) => setResolveProgress(msg),
          { page }
        )
      }
      setResolvedMovie(resolved)
    } catch (err) {
      console.error('[MoviePushPanel] page select error:', err)
      message.error(err instanceof Error ? err.message : '切换分P失败')
    } finally {
      setPageSelectLoading(false)
      setResolveProgress('')
    }
  }

  // 统一添加影片：对 webdav/ftp/openlist/mp4 合并 resolve+add 为单步操作
  // bilibili 仍走两步：先 handleResolve 解析 → 选清晰度 → handleAddMovie 添加
  const handleAddMovie = async () => {
    if (!isHost) {
      message.info('只有房主可以添加影片')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }

    setLoading(true)
    setResolveProgress('正在添加影片...')
    try {
      if (sourceType === 'bilibili' && resolvedMovie) {
        const title = resolvedMovie.title || url.trim()
        await addMovie(roomId, {
          url: url.trim(),
          title,
          source: 'bilibili',
          audioUrl: resolvedMovie.audioUrl,
          format: resolvedMovie.format,
          videoCodec: resolvedMovie.videoCodec,
          audioCodec: resolvedMovie.audioCodec,
          duration: resolvedMovie.duration,
          cid: resolvedMovie.cid,
          currentQn: resolvedMovie.currentQn,
          acceptQuality: resolvedMovie.acceptQuality,
          pages: resolvedMovie.pages,
          currentPage: resolvedMovie.currentPage ?? 1,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'mp4') {
        if (!url.trim()) {
          message.warning('请输入视频地址')
          return
        }
        const movieUrl = url.trim()
        const title = extractTitleFromUrl(movieUrl)
        // 自动检测媒体格式：m3u8 -> hls，mp4/mkv/webm -> 对应格式
        // 后端存储 format 字段，播放时据此选择 HLS/Direct 引擎
        const detectedFormat = detectMediaFormat(movieUrl)
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: 'mp4',
          format: detectedFormat !== 'unknown' ? detectedFormat : undefined,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'webdav' || sourceType === 'openlist') {
        // WebDAV 与 OpenList 共用同一套协议逻辑，仅 API 前缀与直链获取不同
        // 内网地址强制使用服务器转发（浏览器无法直连内网服务器）
        const isDirect =
          sourceType === 'webdav'
            ? (isWebdavInternal ? false : webdavDirectLink)
            : (isOpenlistInternal ? false : openlistDirectLink)
        const mountPath = (
          sourceType === 'webdav' ? webdav.path : openlist.path
        ).trim()
        const mountServerUrl =
          (sourceType === 'webdav'
            ? webdav.serverUrl
            : openlist.serverUrl
          ).trim() || undefined
        const label = sourceType === 'webdav' ? 'WebDAV' : 'OpenList'
        const resolveMount =
          sourceType === 'webdav' ? resolveWebDAV : resolveOpenList
        const fetchDirect =
          sourceType === 'webdav'
            ? fetchWebDAVDirectUrl
            : fetchOpenListDirectUrl

        if (!mountPath) {
          message.warning('请填写文件路径')
          return
        }
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning(`请选择已保存的 ${label} 挂载`)
          return
        }
        let title: string
        let movieUrl: string
        let format: MediaFormat = 'mp4'
        let duration: number | undefined

        if (isDirect) {
          // 直链模式：后端通过挂载凭证获取直链 URL（OpenList 为 AList 签名直链，WebDAV 为拼接）
          setResolveProgress(`正在获取 ${label} 直链...`)
          movieUrl = await fetchDirect(mountId, mountPath)
          title = extractTitleFromUrl(mountPath)
        } else {
          // 代理模式：resolve 返回相对 proxy URL，后端随后用 movieId 重写为 stream URL
          setResolveProgress(`正在解析 ${label} 文件...`)
          const resolved = await resolveMount(mountId, mountPath)
          title = resolved.title || extractTitleFromUrl(mountPath)
          movieUrl = resolved.videoUrl
          format = resolved.format
          duration = resolved.duration
        }
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: sourceType,
          format,
          duration,
          serverUrl: mountServerUrl,
          path: mountPath,
          directLink: isDirect,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'ftp') {
        if (!ftp.serverUrl.trim() || !ftp.path.trim()) {
          message.warning('请填写服务器地址与路径')
          return
        }
        setResolveProgress('正在解析 FTP 文件...')
        // 优先使用已保存挂载的新 API；手动填写时回退到旧 API
        const mountId = Number(selectedMountId)
        let title: string
        let movieUrl: string
        let format: MediaFormat = 'mp4'

        if (mountId) {
          const resolved = await resolveFTPNew(mountId, ftp.path.trim())
          title = resolved.title || extractTitleFromUrl(ftp.path.trim())
          movieUrl = resolved.videoUrl
          format = resolved.format
        } else {
          const resolved = await resolveFTP({
            serverUrl: ftp.serverUrl.trim(),
            path: ftp.path.trim(),
            port: ftp.port,
            username: ftp.username || undefined,
            password: ftp.password || undefined,
          })
          title = resolved.title || extractTitleFromUrl(ftp.path.trim())
          movieUrl = resolved.videoUrl
          format = resolved.format
        }
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: 'ftp',
          format,
          serverUrl: ftp.serverUrl.trim(),
          path: ftp.path.trim(),
          username: ftp.username || undefined,
          password: ftp.password || undefined,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'emby') {
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning('请选择已保存的 Emby 挂载')
          return
        }
        // Emby 是媒体库型，需通过浏览选择条目（itemId）
        // 手动输入场景仅支持已复制的 itemId 直加
        const itemId = url.trim()
        if (!itemId) {
          message.warning('请通过「浏览 Emby 媒体库」选择条目，或粘贴 itemId')
          return
        }
        setResolveProgress('正在解析 Emby 条目...')
        const resolved = await resolveEmby(mountId, itemId)
        const mount = mounts.find((m) => m.id === mountId)
        await addMovie(roomId, {
          url:
            embyDirectLink && resolved.directUrl
              ? resolved.directUrl
              : resolved.videoUrl,
          title: resolved.title || extractTitleFromUrl(itemId),
          source: 'emby',
          format: resolved.format,
          duration: resolved.duration,
          serverUrl: mount?.serverUrl,
          path: itemId,
          directLink: embyDirectLink,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'jellyfin') {
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning('请选择已保存的 Jellyfin 挂载')
          return
        }
        const itemId = url.trim()
        if (!itemId) {
          message.warning(
            '请通过「浏览 Jellyfin 媒体库」选择条目，或粘贴 itemId'
          )
          return
        }
        setResolveProgress('正在解析 Jellyfin 条目...')
        const resolved = await resolveJellyfin(mountId, itemId)
        const mount = mounts.find((m) => m.id === mountId)
        await addMovie(roomId, {
          url:
            jellyfinDirectLink && resolved.directUrl
              ? resolved.directUrl
              : resolved.videoUrl,
          title: resolved.title || extractTitleFromUrl(itemId),
          source: 'jellyfin',
          format: resolved.format,
          duration: resolved.duration,
          serverUrl: mount?.serverUrl,
          path: itemId,
          directLink: jellyfinDirectLink,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'server-files') {
        if (!serverFilePath.trim()) {
          message.warning('请选择服务器文件')
          return
        }
        setResolveProgress('正在解析服务器文件...')
        const resolved = await resolveServerFile(serverFilePath.trim())
        const movieUrl = buildServerFileProxyUrl(serverFilePath.trim())
        // 音轨编码来自后端 resolve（ffprobe），仅作元数据存储：playsvideo
        // 的启用由播放时的 shouldUsePlaysVideo 依据容器与音轨自行判定，
        // 添加影片时不再需要前端补探测。
        await addMovie(roomId, {
          url: movieUrl,
          title: resolved.title,
          source: 'server-files',
          format: resolved.format as MediaFormat,
          path: serverFilePath.trim(),
          duration: resolved.duration ?? undefined,
          audioCodec: resolved.audioCodec ?? undefined,
        })
        resetForm()
        message.success('影片已添加')
      }
    } catch (err) {
      console.error('[MoviePushPanel] add movie error:', err)
      message.error(err instanceof Error ? err.message : '添加影片失败')
    } finally {
      setLoading(false)
      setResolveProgress('')
    }
  }

  // bilibili 需要先解析再选清晰度；anime 有独立搜索弹窗；其他源点击"添加"直接 resolve+add
  const renderActionButton = () => {
    if (sourceType === 'anime') {
      return (
        <Button
          variant="primary"
          size="md"
          block
          loading={loading}
          icon={<Search className="h-4 w-4" />}
          onClick={() => setAnimeOpen(true)}
          disabled={!isHost}
        >
          搜索番剧
        </Button>
      )
    }

    if (sourceType === 'kazumi') {
      return (
        <Button
          variant="primary"
          size="md"
          block
          loading={loading}
          icon={<Search className="h-4 w-4" />}
          onClick={() => setKazumiOpen(true)}
          disabled={!isHost}
        >
          搜索番剧
        </Button>
      )
    }

    if (sourceType === 'bilibili') {
      if (resolvedMovie) {
        return (
          <Button
            variant="primary"
            size="md"
            block
            loading={loading}
            icon={<Plus className="h-4 w-4" />}
            onClick={handleAddMovie}
            disabled={!isHost}
          >
            添加
          </Button>
        )
      }
      return (
        <Button
          variant="primary"
          size="md"
          block
          loading={loading}
          icon={<Link2 className="h-4 w-4" />}
          onClick={() => void handleResolve()}
          disabled={!isHost}
        >
          解析
        </Button>
      )
    }

    // mp4 / webdav / ftp / openlist：单步"添加"
    return (
      <Button
        variant="primary"
        size="md"
        block
        loading={loading}
        icon={<Plus className="h-4 w-4" />}
        onClick={() => void handleAddMovie()}
        disabled={!isHost}
      >
        添加
      </Button>
    )
  }

  const renderSourceForm = () => {
    const getMountOptions = (type: MountType) => [
      { value: '', label: '手动填写' },
      ...mounts
        .filter((m) => m.type === type)
        .map((m) => ({ value: String(m.id), label: m.name })),
    ]

    if (sourceType === 'bilibili' || sourceType === 'mp4') {
      return (
        <Input
          size="sm"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={
            sourceType === 'bilibili'
              ? '视频 Url 或 bv 号'
              : 'MP4/WebM 等视频直链'
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // bilibili 走解析流程，mp4 直接添加
              void (sourceType === 'bilibili'
                ? handleResolve()
                : handleAddMovie())
            }
          }}
        />
      )
    }

    if (sourceType === 'webdav') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label="使用已保存的 WebDAV 挂载"
            value={selectedMountId}
            options={getMountOptions('webdav')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              浏览文件
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={webdav.serverUrl}
              onChange={(e) =>
                setWebdav((prev) => ({ ...prev, serverUrl: e.target.value }))
              }
              placeholder="WebDAV 服务器地址，如 https://example.com/dav（直链模式必填）"
            />
          )}
          <Input
            size="sm"
            value={webdav.path}
            onChange={(e) =>
              setWebdav((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder={
              selectedMountId
                ? '文件路径（已选挂载，留空可从挂载根目录浏览）'
                : '文件路径，如 /movies/video.mp4'
            }
          />
          {!selectedMountId && (
            <Dropdown
              value={isWebdavInternal ? 'proxy' : webdavDirectLink ? 'direct' : 'proxy'}
              options={[
                { value: 'proxy', label: '服务器转发' },
                { value: 'direct', label: '直链直连', disabled: isWebdavInternal },
              ]}
              onChange={(value) => setWebdavDirectLink(value === 'direct')}
            />
          )}
          {isWebdavInternal && (
            <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              检测到内网地址，浏览器无法直连，已强制使用服务器转发模式
            </div>
          )}
        </Space>
      )
    }

    if (sourceType === 'ftp') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label="使用已保存的 FTP 挂载"
            value={selectedMountId}
            options={getMountOptions('ftp')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              浏览文件
            </Button>
          )}
          {!selectedMountId && (
            <>
              <Input
                size="sm"
                value={ftp.serverUrl}
                onChange={(e) =>
                  setFtp((prev) => ({ ...prev, serverUrl: e.target.value }))
                }
                placeholder="FTP 服务器地址，如 ftp.example.com"
              />
              <Input
                size="sm"
                type="number"
                value={String(ftp.port)}
                onChange={(e) =>
                  setFtp((prev) => ({
                    ...prev,
                    port: Number(e.target.value) || 21,
                  }))
                }
                placeholder="端口，默认 21"
              />
              <Input
                size="sm"
                value={ftp.username}
                onChange={(e) =>
                  setFtp((prev) => ({ ...prev, username: e.target.value }))
                }
                placeholder="用户名（可选）"
              />
              <Input
                size="sm"
                type="password"
                value={ftp.password}
                onChange={(e) =>
                  setFtp((prev) => ({ ...prev, password: e.target.value }))
                }
                placeholder="密码（可选）"
              />
            </>
          )}
          <Input
            size="sm"
            value={ftp.path}
            onChange={(e) =>
              setFtp((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder={
              selectedMountId
                ? '文件路径（已选挂载，留空可从挂载根目录浏览）'
                : '文件路径，如 /movies/video.mp4'
            }
          />
        </Space>
      )
    }

    if (sourceType === 'anime') {
      return (
        <div className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] p-3">
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            从 ani-subs 订阅源搜索番剧并选择集数播放。
          </Text>
        </div>
      )
    }

    if (sourceType === 'kazumi') {
      return (
        <div className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] p-3">
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            从 Kazumi XPath 规则源搜索番剧并选择集数播放。
          </Text>
        </div>
      )
    }

    if (sourceType === 'openlist') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label="使用已保存的 OpenList 挂载"
            value={selectedMountId}
            options={getMountOptions('openlist')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              浏览文件
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={openlist.serverUrl}
              onChange={(e) =>
                setOpenlist((prev) => ({ ...prev, serverUrl: e.target.value }))
              }
              placeholder="OpenList 服务器地址（直链模式必填，已选挂载自动填充）"
            />
          )}
          <Input
            size="sm"
            value={openlist.path}
            onChange={(e) =>
              setOpenlist((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder={
              selectedMountId
                ? '文件路径（已选挂载，留空可从挂载根目录浏览）'
                : '文件路径，如 /movies/video.mp4'
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAddMovie()
              }
            }}
          />
          {!selectedMountId && (
            <Dropdown
              value={isOpenlistInternal ? 'proxy' : openlistDirectLink ? 'direct' : 'proxy'}
              options={[
                { value: 'proxy', label: '服务器转发' },
                { value: 'direct', label: '直链直连', disabled: isOpenlistInternal },
              ]}
              onChange={(value) => setOpenlistDirectLink(value === 'direct')}
            />
          )}
          {isOpenlistInternal && (
            <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              检测到内网地址，浏览器无法直连，已强制使用服务器转发模式
            </div>
          )}
        </Space>
      )
    }

    if (sourceType === 'emby') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label="使用已保存的 Emby 挂载"
            value={selectedMountId}
            options={getMountOptions('emby')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Clapperboard className="h-4 w-4" />}
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              浏览 Emby 媒体库
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="粘贴 Emby itemId（可选，一般通过浏览选择）"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleAddMovie()
                }
              }}
            />
          )}
          {!selectedMountId && (
            <Dropdown
              label="播放方式"
              value={embyDirectLink ? 'direct' : 'proxy'}
              options={[
                { value: 'proxy', label: '服务器转发' },
                { value: 'direct', label: '直链直连' },
              ]}
              onChange={(value) => setEmbyDirectLink(value === 'direct')}
            />
          )}
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {selectedMountId
              ? '已选择挂载，点击「浏览 Emby 媒体库」逐级选择电影 / 剧集，多选模式可批量添加。'
              : '选择挂载后点击「浏览 Emby 媒体库」逐级选择电影 / 剧集，多选模式可批量添加。服务器转发由本服务中转（跨域/防盗链友好）；直链直连由浏览器直接访问 Emby 服务器。'}
          </Text>
        </Space>
      )
    }

    if (sourceType === 'jellyfin') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label="使用已保存的 Jellyfin 挂载"
            value={selectedMountId}
            options={getMountOptions('jellyfin')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Clapperboard className="h-4 w-4" />}
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              浏览 Jellyfin 媒体库
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="粘贴 Jellyfin itemId（可选，一般通过浏览选择）"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleAddMovie()
                }
              }}
            />
          )}
          {!selectedMountId && (
            <Dropdown
              label="播放方式"
              value={jellyfinDirectLink ? 'direct' : 'proxy'}
              options={[
                { value: 'proxy', label: '服务器转发' },
                { value: 'direct', label: '直链直连' },
              ]}
              onChange={(value) => setJellyfinDirectLink(value === 'direct')}
            />
          )}
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {selectedMountId
              ? '已选择挂载，点击「浏览 Jellyfin 媒体库」逐级选择电影 / 剧集，多选模式可批量添加。'
              : '选择挂载后点击「浏览 Jellyfin 媒体库」逐级选择电影 / 剧集，多选模式可批量添加。服务器转发由本服务中转（跨域/防盗链友好）；直链直连由浏览器直接访问 Jellyfin 服务器。'}
          </Text>
        </Space>
      )
    }

    if (sourceType === 'server-files') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Button
            variant="secondary"
            size="sm"
            icon={<FolderOpen className="h-4 w-4" />}
            onClick={() => setServerFilesBrowserOpen(true)}
          >
            浏览服务器文件
          </Button>
          <Input
            size="sm"
            value={serverFilePath}
            onChange={(e) => setServerFilePath(e.target.value)}
            placeholder="文件路径，如 /movies/video.mp4（可点击上方按钮选择）"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAddMovie()
              }
            }}
          />
        </Space>
      )
    }

    return null
  }

  return (
    <>
      <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
        {/* 卡片头部：图标 + 标题 */}
        <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-secondary-container)',
            }}
          >
            <Plus
              className="h-4 w-4"
              style={{ color: 'var(--md-sys-color-on-secondary-container)' }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <Text className="text-sm font-semibold leading-tight">
              添加影片
            </Text>
            <Text
              type="secondary"
              className="text-[10px] uppercase tracking-wide"
            >
              选择来源并添加
            </Text>
          </div>
        </div>

        {/* 卡片内容 */}
        <div className="zen-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
          <Dropdown
            value={sourceType}
            options={ALL_SOURCE_OPTIONS.filter(
              (opt) =>
                (!opt.rootOnly || userRole === 'root') &&
                (betaFeaturesEnabled ||
                  (opt.value !== 'anime' && opt.value !== 'kazumi')) &&
                // 挂载类型需有对应挂载才显示
                !(
                  ['webdav', 'ftp', 'openlist', 'emby', 'jellyfin'].includes(
                    opt.value
                  ) && mounts.filter((m) => m.type === opt.value).length === 0
                )
            )}
            onChange={(value) => setSourceType(value as SourceType)}
          />

          {renderSourceForm()}

          {renderActionButton()}

          {resolveProgress && (
            <div
              className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
            >
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <Text className="text-xs">{resolveProgress}</Text>
            </div>
          )}

          {sourceType === 'bilibili' &&
            resolvedMovie?.acceptQuality &&
            resolvedMovie.acceptQuality.length > 0 && (
              <>
                <Dropdown
                  value={String(
                    resolvedMovie.currentQn ??
                      resolvedMovie.acceptQuality[0]?.id
                  )}
                  options={filterQualitiesByVip(
                    resolvedMovie.acceptQuality,
                    bilibiliUser?.vipStatus === 1 ||
                      resolvedMovie.vipStatus === 1
                  ).map((q) => ({
                    label: q.resolution
                      ? `${q.label} · ${q.resolution}`
                      : q.label,
                    value: String(q.id),
                  }))}
                  onChange={(value) => void handleQualityChange(value)}
                  disabled={qualityLoading || !isHost}
                />
              </>
            )}

          {sourceType === 'bilibili' &&
            resolvedMovie?.pages &&
            resolvedMovie.pages.length > 1 && (
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<ListVideo className="h-4 w-4" />}
                onClick={() => setShowPageSelector(true)}
                disabled={pageSelectLoading || !isHost}
              >
                {resolvedMovie.currentPage
                  ? `P${resolvedMovie.currentPage} ${resolvedMovie.pages.find((p) => p.page === resolvedMovie.currentPage)?.part ?? ''} · 点击切换`
                  : `共 ${resolvedMovie.pages.length} P · 点击选择`}
              </Button>
            )}

          {sourceType === 'bilibili' && (
            <div
              className="rounded-[var(--md-sys-shape-corner)] p-2.5"
              style={{
                backgroundColor: 'var(--glass-bg)',
              }}
            >
              <div className="flex items-center gap-2">
                <FileVideo
                  className="h-3.5 w-3.5"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                />
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  B站 登录状态
                </Text>
              </div>
              <div
                className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--md-sys-shape-corner)] p-1"
              >
                {bilibiliLoggedIn && bilibiliUser ? (
                  <>
                    {avatarError || !bilibiliUser.avatar ? (
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-full"
                        style={{
                          backgroundColor: 'var(--glass-bg)',
                          border:
                            '1px solid var(--md-sys-color-outline-variant)',
                        }}
                      >
                        <User className="h-3.5 w-3.5" />
                      </div>
                    ) : (
                      <img
                        src={buildBilibiliImageProxyUrl(bilibiliUser.avatar)}
                        alt={bilibiliUser.name}
                        className="h-6 w-6 rounded-full object-cover"
                        onError={() => setAvatarError(true)}
                      />
                    )}
                    <Text className="text-xs">{bilibiliUser.name}</Text>
                    {bilibiliUser.vipStatus === 1 ? (
                      <Tag
                        color="warning"
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        <Crown className="mr-0.5 h-3 w-3" />
                        大会员
                      </Tag>
                    ) : (
                      <Tag
                        color="default"
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        普通账号
                      </Tag>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      icon={<LogOut className="h-3 w-3" />}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleLogoutBilibili()
                      }}
                    >
                      退出
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    icon={<QrCode className="h-3 w-3" />}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleOpenQrModal()
                    }}
                  >
                    扫码登录 B站
                  </Button>
                )}
              </div>
              <Paragraph type="secondary" className="m-0 mt-1.5 text-[11px]">
                {bilibiliLoggedIn
                  ? bilibiliUser?.vipStatus === 1
                    ? '大会员账号，可解析 4K / 1080P 高码率等专属画质'
                    : '已登录，可解析高画质视频'
                  : '未登录时只能解析低画质或试看片段'}
              </Paragraph>
            </div>
          )}
        </div>
      </div>

      {sourceType === 'anime' && (
        <AniSubsSelector
          open={animeOpen}
          onOpenChange={setAnimeOpen}
          onSelectEpisode={handleSelectAnimeEpisode}
          disabled={!isHost}
        />
      )}

      {sourceType === 'kazumi' && (
        <KazumiSelector
          open={kazumiOpen}
          onOpenChange={setKazumiOpen}
          onSelectEpisode={handleSelectKazumiEpisode}
          disabled={!isHost}
        />
      )}

      <Modal
        open={qrModalOpen}
        onClose={handleCloseQrModal}
        title="扫码登录哔哩哔哩"
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseQrModal}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="哔哩哔哩登录二维码"
              className="rounded-lg border"
              style={{
                width: 200,
                height: 200,
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            />
          ) : (
            <div
              className="glass flex items-center justify-center rounded-lg"
              style={{
                width: 200,
                height: 200,
              }}
            >
              <Text>正在生成二维码…</Text>
            </div>
          )}
          <Paragraph
            type={
              qrStatus === 2
                ? 'success'
                : qrStatus === 3
                  ? 'danger'
                  : 'secondary'
            }
            className="m-0 text-sm"
          >
            {qrMessage}
          </Paragraph>
          {qrStatus === 3 && (
            <Button variant="primary" size="sm" onClick={handleOpenQrModal}>
              重新获取二维码
            </Button>
          )}
        </div>
      </Modal>

      {browsingMount?.type === 'webdav' ? (
        <WebDAVBrowser
          mountId={browsingMount.id}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFiles={handleSelectFilesFromMount}
          selectable
        />
      ) : browsingMount?.type === 'openlist' ? (
        <OpenListBrowser
          mountId={browsingMount.id}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFiles={handleSelectFilesFromMount}
          selectable
        />
      ) : (
        <MountBrowser
          mount={browsingMount}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFiles={handleSelectFilesFromMount}
          selectable
        />
      )}

      <ServerFilesBrowser
        open={serverFilesBrowserOpen}
        onClose={() => setServerFilesBrowserOpen(false)}
        onSelectFile={(path) => setServerFilePath(path)}
        selectable
      />

      {sourceType === 'bilibili' && resolvedMovie?.pages && (
        <Modal
          open={showPageSelector}
          onClose={() => setShowPageSelector(false)}
          title={
            <div className="flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                style={{
                  backgroundColor: 'var(--md-sys-color-primary-container)',
                }}
              >
                <ListVideo
                  className="h-4 w-4"
                  style={{
                    color: 'var(--md-sys-color-on-primary-container)',
                  }}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <Text className="text-sm font-semibold leading-tight">
                  选择分集
                </Text>
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  {resolvedMovie.pages.length} P · 点击选择要添加的章节
                </Text>
              </div>
            </div>
          }
          footer={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowPageSelector(false)}
            >
              取消（使用当前分集）
            </Button>
          }
        >
          <div className="flex max-h-[400px] flex-col gap-1.5 overflow-y-auto">
            {resolvedMovie.pages.map((page) => {
              const isSelected = page.page === (resolvedMovie.currentPage ?? 1)
              return (
                <div
                  key={page.page}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-[var(--md-sys-shape-corner)] border p-3 transition-all hover:-translate-y-0.5 hover:shadow-md',
                    isSelected
                      ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                      : 'glass border-transparent hover:border-[var(--md-sys-color-outline-variant)]'
                  )}
                  onClick={() => void handlePageSelect(page.page)}
                >
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)] text-xs font-medium"
                    style={{
                      backgroundColor: isSelected
                        ? 'var(--md-sys-color-primary)'
                        : 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                      color: isSelected
                        ? 'var(--md-sys-color-on-primary)'
                        : 'var(--md-sys-color-primary)',
                    }}
                  >
                    {page.page}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Paragraph
                      className={cn(
                        'm-0 truncate text-sm font-medium',
                        isSelected &&
                          'text-[var(--md-sys-color-on-primary-container)]'
                      )}
                      title={page.part}
                    >
                      {page.part}
                    </Paragraph>
                    {page.duration > 0 && (
                      <Text
                        type="secondary"
                        className={cn(
                          'text-[10px] uppercase tracking-wide',
                          isSelected &&
                            'text-[var(--md-sys-color-on-primary-container)]'
                        )}
                      >
                        {formatDuration(page.duration)}
                      </Text>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Modal>
      )}
    </>
  )
}
