import { useCallback, useEffect, useRef, useState } from 'react'
import { Link2, QrCode, LogOut, FileVideo, User, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
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
  resolveWebDAV,
  resolveFTP,
  resolveOpenList,
  buildOpenListProxyUrl,
  buildBilibiliVideoUrl,
  buildBilibiliImageProxyUrl,
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliLoginStatus,
  getBilibiliUserInfo,
  logoutBilibili,
  type BilibiliUserInfo,
  type ResolvedSource,
  type WebDAVParams,
  type FTPParams,
  type OpenListEntry,
  type AnimeEpisode,
  resolveAnimeEpisode,
} from '@/modules/room/watch-together/resolveSource'
import {
  fetchMounts,
  type MountType,
  type UserMount,
} from '@/modules/profile/mountApi'

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
  const [webdav, setWebdav] = useState<WebDAVParams>({
    serverUrl: '',
    path: '',
    username: '',
    password: '',
  })
  const [ftp, setFtp] = useState<FTPParams>({
    serverUrl: '',
    path: '',
    port: 21,
    username: '',
    password: '',
  })
  const [openlistUrl, setOpenlistUrl] = useState('')
  const [openlistEntries, setOpenlistEntries] = useState<OpenListEntry[]>([])
  const [selectedOpenlistUrl, setSelectedOpenlistUrl] = useState('')
  const [openlistDirectLink, setOpenlistDirectLink] = useState(false)

  // 已保存挂载
  const [mounts, setMounts] = useState<UserMount[]>([])
  const [selectedMountId, setSelectedMountId] = useState<string>('')

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
    setResolvedMovie(null)
    setOpenlistEntries([])
    setSelectedOpenlistUrl('')
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
    fetchMounts()
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
        path: mount.path || '',
        username: mount.username || '',
        password: mount.password || '',
      })
    } else if (sourceType === 'ftp') {
      setFtp({
        serverUrl: mount.serverUrl || '',
        port: mount.port ?? 21,
        path: mount.path || '',
        username: mount.username || '',
        password: mount.password || '',
      })
    } else if (sourceType === 'openlist') {
      setOpenlistUrl(mount.indexUrl || '')
      setOpenlistDirectLink(mount.directLink)
      setOpenlistEntries([])
      setSelectedOpenlistUrl('')
    }
  }

  const resetForm = () => {
    setUrl('')
    setResolvedMovie(null)
    setSelectedMountId('')
    setWebdav({ serverUrl: '', path: '', username: '', password: '' })
    setFtp({ serverUrl: '', path: '', port: 21, username: '', password: '' })
    setOpenlistUrl('')
    setOpenlistEntries([])
    setSelectedOpenlistUrl('')
    setOpenlistDirectLink(false)
  }

  const handleResolve = async () => {
    if (!isHost) {
      message.info('只有房主可以添加影片')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }

    setLoading(true)
    setResolveProgress('正在初始化解析...')
    try {
      if (sourceType === 'bilibili') {
        if (!url.trim()) {
          message.warning('请输入视频地址')
          return
        }
        const resolved = await resolveBilibili(
          url.trim(),
          undefined,
          (_step, msg) => setResolveProgress(msg)
        )
        setResolvedMovie(resolved)
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
        if (!webdav.serverUrl.trim() || !webdav.path.trim()) {
          message.warning('请填写服务器地址与路径')
          return
        }
        const resolved = await resolveWebDAV({
          serverUrl: webdav.serverUrl.trim(),
          path: webdav.path.trim(),
          username: webdav.username || undefined,
          password: webdav.password || undefined,
        })
        setResolvedMovie(resolved)
      } else if (sourceType === 'ftp') {
        if (!ftp.serverUrl.trim() || !ftp.path.trim()) {
          message.warning('请填写服务器地址与路径')
          return
        }
        const resolved = await resolveFTP({
          serverUrl: ftp.serverUrl.trim(),
          path: ftp.path.trim(),
          port: ftp.port,
          username: ftp.username || undefined,
          password: ftp.password || undefined,
        })
        setResolvedMovie(resolved)
      } else if (sourceType === 'openlist') {
        if (!openlistUrl.trim()) {
          message.warning('请输入 OpenList 索引 URL')
          return
        }
        const result = await resolveOpenList(openlistUrl.trim())
        setOpenlistEntries(result.items)
        if (result.items.length > 0) {
          setSelectedOpenlistUrl(result.items[0].url)
        }
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
      const resolved = await resolveBilibili(url.trim(), qn, (_step, msg) =>
        setResolveProgress(msg)
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

  const handleAddMovie = async () => {
    if (!isHost) {
      message.info('只有房主可以添加影片')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }
    if (sourceType === 'bilibili' && !resolvedMovie) {
      message.error('请先解析视频')
      return
    }

    setLoading(true)
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
      } else if (
        (sourceType === 'webdav' || sourceType === 'ftp') &&
        resolvedMovie
      ) {
        const params = sourceType === 'webdav' ? webdav : ftp
        const title = resolvedMovie.title || extractTitleFromUrl(params.path)
        await addMovie(roomId, {
          url: resolvedMovie.videoUrl,
          title,
          source: sourceType,
          format: resolvedMovie.format,
          duration: resolvedMovie.duration,
          serverUrl: params.serverUrl.trim(),
          path: params.path.trim(),
          username: params.username || undefined,
          password: params.password || undefined,
        })
        resetForm()
        message.success('影片已添加')
      } else if (sourceType === 'openlist') {
        if (!selectedOpenlistUrl) {
          message.error('请选择 OpenList 条目')
          return
        }
        const entry = openlistEntries.find(
          (item) => item.url === selectedOpenlistUrl
        )
        const title = entry?.name || extractTitleFromUrl(selectedOpenlistUrl)
        await addMovie(roomId, {
          url: openlistDirectLink
            ? selectedOpenlistUrl
            : buildOpenListProxyUrl(selectedOpenlistUrl),
          title,
          source: 'openlist',
          serverUrl: openlistUrl.trim(),
          directLink: openlistDirectLink,
        })
        resetForm()
        message.success('影片已添加')
      }
    } catch (err) {
      console.error('[MoviePushPanel] add movie error:', err)
      message.error(err instanceof Error ? err.message : '添加影片失败')
    } finally {
      setLoading(false)
    }
  }

  const canAdd =
    sourceType === 'bilibili'
      ? !!resolvedMovie
      : sourceType === 'webdav' || sourceType === 'ftp'
        ? !!resolvedMovie
        : sourceType === 'openlist'
          ? openlistEntries.length > 0
          : sourceType === 'anime'
            ? false
            : true

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
              void handleResolve()
            }
          }}
        />
      )
    }

    if (sourceType === 'webdav') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Select
            label="使用已保存的 WebDAV 挂载"
            value={selectedMountId}
            options={getMountOptions('webdav')}
            onChange={handleMountSelect}
          />
          <Input
            size="sm"
            value={webdav.serverUrl}
            onChange={(e) =>
              setWebdav((prev) => ({ ...prev, serverUrl: e.target.value }))
            }
            placeholder="WebDAV 服务器地址，如 https://example.com/dav"
          />
          <Input
            size="sm"
            value={webdav.path}
            onChange={(e) =>
              setWebdav((prev) => ({ ...prev, path: e.target.value }))
            }
            placeholder="文件路径，如 /movies/video.mp4"
          />
          <Input
            size="sm"
            value={webdav.username}
            onChange={(e) =>
              setWebdav((prev) => ({ ...prev, username: e.target.value }))
            }
            placeholder="用户名（可选）"
          />
          <Input
            size="sm"
            type="password"
            value={webdav.password}
            onChange={(e) =>
              setWebdav((prev) => ({ ...prev, password: e.target.value }))
            }
            placeholder="密码（可选）"
          />
        </Space>
      )
    }

    if (sourceType === 'ftp') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Select
            label="使用已保存的 FTP 挂载"
            value={selectedMountId}
            options={getMountOptions('ftp')}
            onChange={handleMountSelect}
          />
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
              setFtp((prev) => ({ ...prev, path: e.target.value }))
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
          <Select
            label="使用已保存的 OpenList 挂载"
            value={selectedMountId}
            options={getMountOptions('openlist')}
            onChange={handleMountSelect}
          />
          <Input
            size="sm"
            value={openlistUrl}
            onChange={(e) => {
              setOpenlistUrl(e.target.value)
              setOpenlistEntries([])
              setSelectedOpenlistUrl('')
            }}
            placeholder="OpenList 索引 URL"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleResolve()
              }
            }}
          />
          {openlistEntries.length > 0 && (
            <>
              <Select
                value={selectedOpenlistUrl}
                options={openlistEntries.map((item) => ({
                  label: item.name,
                  value: item.url,
                }))}
                onChange={(value) => setSelectedOpenlistUrl(value)}
              />
              <Select
                value={openlistDirectLink ? 'direct' : 'proxy'}
                options={[
                  { value: 'proxy', label: '服务器转发' },
                  { value: 'direct', label: '直链直连' },
                ]}
                onChange={(value) => setOpenlistDirectLink(value === 'direct')}
              />
            </>
          )}
        </Space>
      )
    }

    return null
  }

  return (
    <>
      <Space direction="vertical" className="h-full w-full" size="sm">
        <Text className="text-sm font-medium">添加影片</Text>

        <Select
          value={sourceType}
          options={SOURCE_OPTIONS}
          onChange={(value) => setSourceType(value as SourceType)}
        />

        {renderSourceForm()}

        {sourceType === 'bilibili' && resolvedMovie ? (
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
        ) : sourceType === 'anime' ? (
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
        ) : (
          <Button
            variant="primary"
            size="sm"
            block
            loading={loading}
            icon={<Link2 className="h-4 w-4" />}
            onClick={() => void handleResolve()}
            disabled={!isHost}
          >
            {sourceType === 'bilibili' ||
            sourceType === 'webdav' ||
            sourceType === 'ftp' ||
            sourceType === 'openlist'
              ? '解析'
              : '添加'}
          </Button>
        )}

        {canAdd && sourceType !== 'bilibili' && sourceType !== 'mp4' && (
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
        )}

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
            <Select
              value={String(
                resolvedMovie.currentQn ?? resolvedMovie.acceptQuality[0]?.id
              )}
              options={resolvedMovie.acceptQuality.map((q) => ({
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
    </>
  )
}
