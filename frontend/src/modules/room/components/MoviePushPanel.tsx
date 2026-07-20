import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Link2,
  QrCode,
  LogOut,
  FileVideo,
  User,
  Plus,
  Search,
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
import { useSocket } from '@/hooks/useSocket'
import { BilibiliBangumiSelector } from './BilibiliBangumiSelector'
import { AnimeSourceSelector } from './AnimeSourceSelector'
import {
  resolveBilibili,
  resolveFTP,
  buildBilibiliVideoUrl,
  buildBilibiliImageProxyUrl,
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliLoginStatus,
  getBilibiliUserInfo,
  logoutBilibili,
  type BilibiliUserInfo,
  type ResolvedSource,
  type FTPParams,
  type AnimeEpisode,
  resolveAnimeEpisode,
} from '@/modules/room/watch-together/resolveSource'
import {
  resolveBilibiliWithOptions,
  filterQualitiesByVip,
} from '@/modules/bilibili/bilibiliApi'
import {
  resolveOpenList,
  buildOpenListProxyUrl,
} from '@/modules/openlist/openlistApi'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import { resolveWebDAV, buildWebDAVProxyUrl } from '@/modules/webdav/webdavApi'
import MountBrowser from '@/modules/mounts/MountBrowser'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import { resolveFTP as resolveFTPNew } from '@/modules/ftp/ftpApi'
import type { MediaFormat } from '@/lib/mediaFormat'
import {
  fetchAllMounts,
  type UnionMount,
  type MountType,
} from '@/modules/mounts'

type SourceType = 'bilibili' | 'mp4' | 'webdav' | 'ftp' | 'openlist' | 'anime'

const SOURCE_OPTIONS = [
  { value: 'bilibili', label: '哔哩哔哩' },
  { value: 'mp4', label: 'MP4 直链' },
  { value: 'webdav', label: 'WebDAV' },
  { value: 'ftp', label: 'FTP' },
  { value: 'openlist', label: 'OpenList' },
  { value: 'anime', label: 'ani-subs 番剧源' },
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

interface MoviePushPanelProps {
  isHost: boolean
}

export function MoviePushPanel({ isHost }: MoviePushPanelProps) {
  const { socket } = useSocket()
  const addMovie = useRoomStore((state) => state.addMovie)
  const fetchMovies = useRoomStore((state) => state.fetchMovies)
  const setCurrentMovieId = useRoomStore((state) => state.setCurrentMovieId)
  const roomId = useRoomStore((state) => state.roomId)
  const [sourceType, setSourceType] = useState<SourceType>('bilibili')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [qualityLoading, setQualityLoading] = useState(false)
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

  // 已保存挂载
  const [mounts, setMounts] = useState<UnionMount[]>([])
  const [selectedMountId, setSelectedMountId] = useState<string>('')
  const [browsingMount, setBrowsingMount] = useState<UnionMount | null>(null)

  const [bilibiliLoggedIn, setBilibiliLoggedIn] = useState(false)
  const [bilibiliUser, setBilibiliUser] = useState<BilibiliUserInfo | null>(
    null
  )
  const [avatarError, setAvatarError] = useState(false)
  const [bangumiOpen, setBangumiOpen] = useState(false)
  const [animeOpen, setAnimeOpen] = useState(false)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrStatus, setQrStatus] = useState(0)
  const [qrMessage, setQrMessage] = useState('请使用哔哩哔哩 App 扫码登录')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPollingRef = useRef(false)
  const qrRetryCountRef = useRef(0)

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

  const handleSelectBangumiEpisode = useCallback(
    async (bvid: string, cid: number, title: string) => {
      if (!isHost) {
        message.info('只有房主可以播放影片')
        return
      }
      if (!roomId) {
        message.error('未连接房间')
        return
      }

      const videoUrl = buildBilibiliVideoUrl(bvid)
      setLoading(true)
      try {
        const resolved = await resolveBilibili(videoUrl)
        await addMovie(roomId, {
          url: videoUrl,
          title: title || resolved.title || videoUrl,
          source: 'bilibili',
          audioUrl: resolved.audioUrl,
          format: resolved.format,
          videoCodec: resolved.videoCodec,
          audioCodec: resolved.audioCodec,
          duration: resolved.duration,
          cid: cid || resolved.cid,
          currentQn: resolved.currentQn,
          acceptQuality: resolved.acceptQuality,
        })
        await fetchMovies(roomId)
        const movie = useRoomStore
          .getState()
          .movies.find((m) => m.url === videoUrl)
        if (movie) {
          setCurrentMovieId(movie.id)
          socket?.emit('play-movie', { roomId, movieId: movie.id })
        }
        message.success('已加载番剧集数')
      } catch (err) {
        console.error('[MoviePushPanel] select bangumi episode error:', err)
        message.error(err instanceof Error ? err.message : '加载番剧集数失败')
      } finally {
        setLoading(false)
      }
    },
    [isHost, roomId, addMovie, fetchMovies, setCurrentMovieId, socket]
  )

  const handleSelectAnimeEpisode = useCallback(
    async (sourceId: string, episode: AnimeEpisode, title: string) => {
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
        const resolved = await resolveAnimeEpisode(sourceId, episode)
        const movieUrl = resolved.url
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: 'anime',
        })
        await fetchMovies(roomId)
        const movie = useRoomStore
          .getState()
          .movies.find((m) => m.url === movieUrl)
        if (movie) {
          setCurrentMovieId(movie.id)
          socket?.emit('play-movie', { roomId, movieId: movie.id })
        }
        message.success('已加载番剧集数')
      } catch (err) {
        console.error('[MoviePushPanel] select anime episode error:', err)
        message.error(err instanceof Error ? err.message : '加载番剧集数失败')
      } finally {
        setLoading(false)
      }
    },
    [isHost, roomId, addMovie, fetchMovies, setCurrentMovieId, socket]
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
        path: normalizeMountPath(mount.path || ''),
      })
      setWebdavDirectLink(mount.directLink)
    } else if (sourceType === 'ftp') {
      setFtp((prev) => ({
        ...prev,
        serverUrl: mount.serverUrl || '',
        port: mount.port ?? 21,
        path: normalizeMountPath(mount.path || ''),
        username: mount.username || '',
        // 密码由后端挂载配置内部管理，列表接口不返回密码
        password: '',
      }))
    } else if (sourceType === 'openlist') {
      setOpenlist({
        serverUrl: mount.serverUrl || '',
        path: normalizeMountPath(mount.path || ''),
      })
    }
  }

  const handleSelectFileFromMount = useCallback(
    (path: string) => {
      const normalizedPath = normalizeMountPath(path)
      if (sourceType === 'webdav') {
        setWebdav((prev) => ({ ...prev, path: normalizedPath }))
      } else if (sourceType === 'ftp') {
        setFtp((prev) => ({ ...prev, path: normalizedPath }))
      } else if (sourceType === 'openlist') {
        setOpenlist((prev) => ({ ...prev, path: normalizedPath }))
      }
    },
    [sourceType]
  )

  const resetForm = () => {
    setUrl('')
    setResolvedMovie(null)
    setSelectedMountId('')
    setWebdav({ serverUrl: '', path: '' })
    setWebdavDirectLink(false)
    setFtp({ serverUrl: '', path: '', port: 21, username: '', password: '' })
    setOpenlist({ serverUrl: '', path: '' })
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
      const resolved = await resolveBilibili(
        url.trim(),
        undefined,
        (_step, msg) => setResolveProgress(msg)
      )
      setResolvedMovie(resolved)
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
      const resolved = await resolveBilibiliWithOptions(
        url.trim(),
        qn,
        (_step, msg) => setResolveProgress(msg)
      )
      setResolvedMovie(resolved)
    } catch (err) {
      console.error('[MoviePushPanel] switch quality error:', err)
      message.error(err instanceof Error ? err.message : '切换清晰度失败')
    } finally {
      setQualityLoading(false)
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
        await addMovie(roomId, { url: movieUrl, title, source: 'mp4' })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'webdav') {
        if (!webdav.path.trim()) {
          message.warning('请填写文件路径')
          return
        }
        let title: string
        let movieUrl: string
        let format: MediaFormat = 'mp4'
        let duration: number | undefined

        if (webdavDirectLink) {
          if (!webdav.serverUrl.trim()) {
            message.warning('请填写服务器地址')
            return
          }
          movieUrl = `${webdav.serverUrl.trim()}${webdav.path.trim()}`
          title = extractTitleFromUrl(webdav.path.trim())
        } else {
          const mountId = Number(selectedMountId)
          if (!mountId) {
            message.warning('请选择已保存的 WebDAV 挂载')
            return
          }
          setResolveProgress('正在解析 WebDAV 文件...')
          const resolved = await resolveWebDAV(mountId, webdav.path.trim())
          title = resolved.title || extractTitleFromUrl(webdav.path.trim())
          movieUrl = buildWebDAVProxyUrl(mountId, webdav.path.trim())
          format = resolved.format
          duration = resolved.duration
        }
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: 'webdav',
          format,
          duration,
          serverUrl: webdav.serverUrl.trim() || undefined,
          path: webdav.path.trim(),
          directLink: webdavDirectLink,
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
      } else if (sourceType === 'openlist') {
        if (!openlist.path.trim()) {
          message.warning('请填写文件路径')
          return
        }
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning('请选择已保存的 OpenList 挂载')
          return
        }
        setResolveProgress('正在解析 OpenList 文件...')
        const resolved = await resolveOpenList(mountId, openlist.path.trim())
        const title =
          resolved.title || extractTitleFromUrl(openlist.path.trim())
        const movieUrl = buildOpenListProxyUrl(mountId, openlist.path.trim())
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: 'openlist',
          format: resolved.format,
          duration: resolved.duration,
          serverUrl: openlist.serverUrl.trim() || undefined,
          path: openlist.path.trim(),
          directLink: false,
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
          size="sm"
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

    if (sourceType === 'bilibili') {
      if (resolvedMovie) {
        return (
          <Button
            variant="primary"
            size="sm"
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
          size="sm"
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
        size="sm"
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
          <Input
            size="sm"
            value={webdav.serverUrl}
            onChange={(e) =>
              setWebdav((prev) => ({ ...prev, serverUrl: e.target.value }))
            }
            placeholder="WebDAV 服务器地址，如 https://example.com/dav（直链模式必填）"
          />
          <Input
            size="sm"
            value={webdav.path}
            onChange={(e) =>
              setWebdav((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder="文件路径，如 /movies/video.mp4"
          />
          <Dropdown
            value={webdavDirectLink ? 'direct' : 'proxy'}
            options={[
              { value: 'proxy', label: '服务器转发' },
              { value: 'direct', label: '直链直连' },
            ]}
            onChange={(value) => setWebdavDirectLink(value === 'direct')}
          />
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
            value={ftp.path}
            onChange={(e) =>
              setFtp((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder="文件路径，如 /movies/video.mp4"
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
        </Space>
      )
    }

    if (sourceType === 'anime') {
      return (
        <div className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] p-3">
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            从 ani-subs 订阅源搜索番剧并选择集数播放。
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
          <Input
            size="sm"
            value={openlist.serverUrl}
            onChange={(e) =>
              setOpenlist((prev) => ({ ...prev, serverUrl: e.target.value }))
            }
            placeholder="OpenList 服务器地址（仅手动填写时需要，已选挂载自动填充）"
          />
          <Input
            size="sm"
            value={openlist.path}
            onChange={(e) =>
              setOpenlist((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder="文件路径，如 /movies/video.mp4"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAddMovie()
              }
            }}
          />
          {/* OpenList 始终使用服务器转发模式：WebDAV 路径不是可播放直链，
              直连会被浏览器 ORB 策略阻止，必须通过后端代理处理认证与 CORS */}
        </Space>
      )
    }

    return null
  }

  return (
    <>
      <Space direction="vertical" className="h-full w-full" size="sm">
        <Text className="text-sm font-medium">添加影片</Text>

        <Dropdown
          value={sourceType}
          options={SOURCE_OPTIONS}
          onChange={(value) => setSourceType(value as SourceType)}
        />

        {renderSourceForm()}

        {renderActionButton()}

        {resolveProgress && (
          <div
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              borderColor: 'var(--md-sys-color-outline-variant)',
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
            <Dropdown
              value={String(
                resolvedMovie.currentQn ?? resolvedMovie.acceptQuality[0]?.id
              )}
              options={filterQualitiesByVip(
                resolvedMovie.acceptQuality,
                bilibiliUser?.vipStatus === 1
              ).map((q) => ({
                label: q.resolution ? `${q.label} · ${q.resolution}` : q.label,
                value: String(q.id),
              }))}
              onChange={(value) => void handleQualityChange(value)}
              disabled={qualityLoading || !isHost}
            />
          )}

        {sourceType === 'bilibili' && (
          <div className="glass rounded-lg p-2">
            <div className="flex items-center gap-2">
              <FileVideo
                className="h-4 w-4"
                style={{ color: 'var(--md-sys-color-primary)' }}
              />
              <Text className="text-xs">B站 登录状态</Text>
            </div>
            <div
              className="mt-2 flex flex-wrap items-center gap-2 rounded-md p-1 transition-colors hover:cursor-pointer hover:bg-[var(--md-sys-color-surface-container-high)]"
              role="button"
              tabIndex={0}
              onClick={() => {
                if (bilibiliLoggedIn && bilibiliUser) {
                  setBangumiOpen(true)
                } else {
                  handleOpenQrModal()
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (bilibiliLoggedIn && bilibiliUser) {
                    setBangumiOpen(true)
                  } else {
                    handleOpenQrModal()
                  }
                }
              }}
            >
              {bilibiliLoggedIn && bilibiliUser ? (
                <>
                  {avatarError || !bilibiliUser.avatar ? (
                    <div
                      className="flex h-6 w-6 items-center justify-center rounded-full"
                      style={{
                        backgroundColor:
                          'var(--md-sys-color-surface-container-high)',
                        border: '1px solid var(--md-sys-color-outline)',
                      }}
                    >
                      <User className="h-4 w-4" />
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
                  {bilibiliUser.vipStatus === 1 && (
                    <Tag color="warning" className="px-1.5 py-0 text-[10px]">
                      大会员
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
            <Paragraph type="secondary" className="m-0 mt-2 text-xs">
              {bilibiliLoggedIn
                ? '已登录，可解析高画质视频'
                : '未登录时只能解析低画质或试看片段'}
            </Paragraph>
          </div>
        )}

        {sourceType === 'bilibili' && (
          <BilibiliBangumiSelector
            open={bangumiOpen}
            onOpenChange={setBangumiOpen}
            onSelectEpisode={handleSelectBangumiEpisode}
            disabled={!isHost}
          />
        )}

        {sourceType === 'anime' && (
          <AnimeSourceSelector
            open={animeOpen}
            onOpenChange={setAnimeOpen}
            onSelectEpisode={handleSelectAnimeEpisode}
            disabled={!isHost}
          />
        )}
      </Space>

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
          onSelectFile={handleSelectFileFromMount}
          selectable
        />
      ) : browsingMount?.type === 'openlist' ? (
        <OpenListBrowser
          mountId={browsingMount.id}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFile={handleSelectFileFromMount}
          selectable
        />
      ) : (
        <MountBrowser
          mount={browsingMount}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFile={handleSelectFileFromMount}
          selectable
        />
      )}
    </>
  )
}
