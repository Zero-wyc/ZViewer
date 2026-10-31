import { useCallback, useEffect, useState } from 'react'
import {
  QrCode,
  LogOut,
  FileVideo,
  User,
  Plus,
  Crown,
  ListVideo,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dropdown } from '@/components/ui/Dropdown'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { Tag } from '@/components/ui/Tag'
import { formatDuration } from '@/lib/utils'
import { hdrUnsupportedLabel, isHdrQn } from '@/modules/player/hdr-capability'

import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import { AniSubsSelector } from '@/modules/anisubs/AniSubsSelector'
import {
  resolveAniSubsEpisode,
  buildAniSubsProxyUrl,
  type AniSubsEpisode,
} from '@/modules/anisubs'
import { KazumiSelector } from '@/modules/kazumi/KazumiSelector'
import {
  resolveKazumiEpisode,
  buildKazumiProxyUrl,
  type KazumiEpisode,
} from '@/modules/kazumi'
import { CmsSelector } from '@/modules/cms/CmsSelector'
import { resolveCmsEpisode, buildCmsProxyUrl } from '@/modules/cms/api'
import type { CmsSourceMeta, CmsPlaybackParams } from '@/modules/cms/types'
import type { AnimeEpisodeSelection } from '@/modules/anime-browser'
import {
  buildBilibiliImageProxyUrl,
  getBilibiliLoginStatus,
  getBilibiliUserInfo,
  type BilibiliUserInfo,
  type FTPParams,
} from '@/modules/movie-source/resolveSource'
import { useBilibiliQrLogin } from '@/modules/bilibili/useBilibiliQrLogin'
import { BiliSearchModal } from './BiliSearchModal'
import {
  resolveOpenList,
  fetchOpenListDirectUrl,
} from '@/modules/openlist/openlistApi'
import { isInternalOpenListServer } from '@/modules/openlist/isInternal'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import {
  resolveEmby,
  browseEmbyMount,
  buildEmbyImageUrl,
  parseEpisodeFromFilePath,
} from '@/modules/emby/embyApi'
import type { EmbyDirectoryEntry } from '@/modules/emby/types'
import {
  resolveJellyfin,
  browseJellyfinMount,
} from '@/modules/jellyfin/jellyfinApi'
import { resolveWebDAV, fetchWebDAVDirectUrl } from '@/modules/webdav/webdavApi'
import MountBrowser from '@/modules/mounts/MountBrowser'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import { resolveFTP as resolveFTPNew } from '@/modules/ftp/ftpApi'
import ServerFilesBrowser from '@/modules/server-files/ServerFilesBrowser'
import {
  resolveServerFile,
  buildServerFileProxyUrl,
} from '@/modules/server-files/serverFilesApi'
import type { MediaFormat } from '@/lib/mediaFormat'
import {
  fetchAllMounts,
  type UnionMount,
  type MountType,
} from '@/modules/mounts'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { cn } from '@/lib/utils'
import {
  BilibiliSourceForm,
  FtpSourceForm,
  MediaServerSourceForm,
  Mp4SourceForm,
  PathMountSourceForm,
  ServerFilesSourceForm,
  SourceActionButton,
  SourceHint,
  normalizeMountPath,
  type SourceType,
} from './source-forms'
import { useBilibiliResolve } from './useBilibiliResolve'
import {
  addBilibiliMovie,
  addFtpMovie,
  addMediaServerMovie,
  addMp4Movie,
  addPathMountMovie,
  addServerFilesMovie,
  extractTitleFromUrl,
  type SubmitMovieContext,
} from './movie-submit'
import { t } from '@/i18n'

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
  { value: 'cms', label: 'TVBox 采集源' },
  { value: 'server-files', label: '服务器文件', rootOnly: true },
]

interface MoviePushPanelProps {
  isHost: boolean
}

export function MoviePushPanel({ isHost }: MoviePushPanelProps) {
  const userRole = useAuthStore((state) => state.user?.role)
  const { betaFeaturesEnabled, fetchSettings } = useSystemSettingsStore()
  const addMovieStore = useRoomStore((state) => state.addMovie)
  const fetchMovies = useRoomStore((state) => state.fetchMovies)
  const setPendingPreviewPlay = useRoomStore(
    (state) => state.setPendingPreviewPlay
  )
  const roomId = useRoomStore((state) => state.roomId)
  const [sourceType, setSourceType] = useState<SourceType>('bilibili')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  // 影片级浏览器播放引擎（playsvideo）开关：默认关闭——强制原生直连播放
  // （不兼容编码将无声），需要 MKV/DTS 等非常规格式重封装/转码时手动开启。
  // 与系统级开关两级门控。
  const [playsvideoEnabled, setPlaysvideoEnabled] = useState(false)
  // 包装 store 的 addMovie：为本面板全部添加路径统一注入 playsvideoEnabled，
  // 调用点无需逐个传参。roomId 已在闭包内固定，保持原调用签名不变。
  // B站 源保持启用：开关本就不显示（解析出的 MP4/DASH 必定原生可播），
  // 且保留原生失败时的 playsvideo 管线回退保险；其余源跟随面板开关。
  const addMovie = useCallback(
    (
      _roomId: string,
      payload: Omit<Parameters<typeof addMovieStore>[1], 'playsvideoEnabled'>
    ) =>
      addMovieStore(_roomId, {
        ...payload,
        playsvideoEnabled:
          payload.source === 'bilibili' ? true : playsvideoEnabled,
      }),
    [addMovieStore, playsvideoEnabled]
  )
  // B站 解析进度：在推送面板也展示后台解析过程
  const [resolveProgress, setResolveProgress] = useState<string>('')
  // B站 源解析流程（解析/切清晰度/切分P）与相关状态收敛在专用 hook
  const {
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
  } = useBilibiliResolve({
    isHost,
    roomId,
    url,
    sourceType,
    setLoading,
    setResolveProgress,
  })

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
  // 直链模式的媒体传输方式：false（默认）强制直链直连，true 一律经服务器中转
  // 数据源影片（ani/kazumi/cms）服务器中转模式：true 时媒体流一律经服务器
  const [serverProxy, setServerProxy] = useState(false)
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
  const [cmsOpen, setCmsOpen] = useState(false)
  const [serverFilesBrowserOpen, setServerFilesBrowserOpen] = useState(false)
  const [serverFilePath, setServerFilePath] = useState('')
  const {
    qrModalOpen,
    qrDataUrl,
    qrStatus,
    qrMessage,
    handleOpenQrModal,
    handleCloseQrModal,
    handleLogoutBilibili,
  } = useBilibiliQrLogin({
    onLoginSuccess: async () => {
      setBilibiliLoggedIn(true)
      const info = await getBilibiliUserInfo()
      if (info) setBilibiliUser(info)
    },
    onLogoutSuccess: () => {
      setBilibiliLoggedIn(false)
      setBilibiliUser(null)
    },
    logTag: 'MoviePushPanel',
  })
  const [biliSearchOpen, setBiliSearchOpen] = useState(false)

  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])

  useEffect(() => {
    if (
      !betaFeaturesEnabled &&
      (sourceType === 'anime' ||
        sourceType === 'kazumi' ||
        sourceType === 'cms')
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 仅在 betaFeaturesEnabled 切换时回退一次，非每次渲染触发
      setSourceType('bilibili')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betaFeaturesEnabled])

  useEffect(() => {
    setResolvedMovie(null)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sourceType 变化时重置状态（历史行为保留）
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setResolvedMovie 为稳定 setter
  }, [sourceType])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 头像变化时重置错误状态
    setAvatarError(false)
  }, [bilibiliUser?.avatar])

  const handleSelectAnimeEpisodes = useCallback(
    async (
      kind: 'anime' | 'kazumi',
      items: { sourceId: string; episode: AniSubsEpisode; title: string }[]
    ): Promise<string[]> => {
      if (!isHost || !roomId) {
        message.error(!isHost ? t('只有房主可以添加影片') : t('未连接房间'))
        return []
      }
      const added: string[] = []
      setLoading(true)
      try {
        for (const [index, item] of items.entries()) {
          setResolveProgress(
            t('正在添加 {{value}}/{{length}} 集...', {
              value: index + 1,
              length: items.length,
            })
          )
          try {
            if (kind === 'anime') {
              await addMovie(roomId, {
                url: `anisubs://${item.sourceId}/${item.episode.id}`,
                title: item.title,
                source: 'anime',
                sourceMeta: {
                  sourceId: item.sourceId,
                  episode: item.episode,
                  originalTitle: item.title,
                },
                serverProxy,
              })
            } else {
              const resolved = await resolveKazumiEpisode(
                item.sourceId,
                item.episode
              )
              // 代理决策：仅由服务器中转模式（serverProxy）决定，不自动兜底
              const url = serverProxy
                ? buildKazumiProxyUrl(resolved.url, resolved.headers, true)
                : resolved.url
              await addMovie(roomId, {
                url,
                title: item.title,
                source: 'kazumi',
                format: resolved.format,
                serverProxy,
                // 落元数据：播放时据此重新解析（服务器中转开关切换、
                // 直链过期自愈都依赖它），结构与 ani-subs 元数据一致
                sourceMeta: {
                  kind: 'kazumi',
                  sourceId: item.sourceId,
                  episode: item.episode,
                  originalTitle: item.title,
                },
              })
            }
            added.push(item.episode.id)
          } catch (err) {
            console.error(
              '[MoviePushPanel] batch add anime episode failed:',
              item.title,
              err
            )
          }
        }
        if (added.length === items.length) {
          message.success(t('已添加 {{length}} 集', { length: added.length }))
        } else {
          message.warning(
            t('已添加 {{length}} 集，{{value}} 集失败，可重试', {
              length: added.length,
              value: items.length - added.length,
            })
          )
        }
        await fetchMovies(roomId)
      } catch (err) {
        message.error(
          err instanceof Error ? err.message : t('刷新影片列表失败')
        )
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
      return added
    },
    [isHost, roomId, addMovie, fetchMovies, serverProxy]
  )

  const handleSelectAnimeEpisode = useCallback(
    async (sourceId: string, episode: AniSubsEpisode, title: string) => {
      if (!isHost) {
        message.info(t('只有房主可以播放影片'))
        return
      }
      if (!roomId) {
        message.error(t('未连接房间'))
        return
      }

      setLoading(true)
      try {
        const resolved = await resolveAniSubsEpisode(sourceId, episode)

        // 防盗链处理：是否走服务器代理仅由服务器中转模式（serverProxy）
        // 决定——开启时包装为代理 URL（携带 Referer/UA 等参数），关闭时
        // 一律直连（浏览器无法为 video.src 设置 Referer/UA，带防盗链的
        // 源不开中转无法播放）
        const finalUrl = serverProxy
          ? buildAniSubsProxyUrl(resolved.url, resolved.headers, true)
          : resolved.url

        // 1. 触发实时预览播放（通过 store 解耦 useWatchTogether）
        //    代理 URL 已包含防盗链信息，无需再传 headers
        setPendingPreviewPlay({
          url: finalUrl,
          title,
          sourceType: 'anime',
          format: resolved.format,
          playsvideoEnabled,
          noProxyFallback: !serverProxy,
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
          serverProxy,
        })
          .then(() => fetchMovies(roomId))
          .catch((err) => {
            console.error(
              '[MoviePushPanel] addMovie/fetchMovies after preview failed:',
              err
            )
          })

        message.success(t('已开始播放并加入列表'))
      } catch (err) {
        console.error('[MoviePushPanel] select anime episode error:', err)
        message.error(
          err instanceof Error ? err.message : t('加载番剧集数失败')
        )
      } finally {
        setLoading(false)
      }
    },
    [
      isHost,
      roomId,
      addMovie,
      fetchMovies,
      setPendingPreviewPlay,
      playsvideoEnabled,
      serverProxy,
    ]
  )

  const handleSelectKazumiEpisode = useCallback(
    async (sourceId: string, episode: KazumiEpisode, title: string) => {
      if (!isHost) {
        message.info(t('只有房主可以播放影片'))
        return
      }
      if (!roomId) {
        message.error(t('未连接房间'))
        return
      }

      setLoading(true)
      try {
        const resolved = await resolveKazumiEpisode(sourceId, episode)

        // 代理决策：仅由服务器中转模式（serverProxy）决定，不自动兜底
        const finalUrl = serverProxy
          ? buildKazumiProxyUrl(resolved.url, resolved.headers, true)
          : resolved.url

        setPendingPreviewPlay({
          url: finalUrl,
          title,
          sourceType: 'kazumi',
          format: resolved.format,
          playsvideoEnabled,
          noProxyFallback: !serverProxy,
        })

        void addMovie(roomId, {
          url: finalUrl,
          title,
          source: 'kazumi',
          format: resolved.format,
          serverProxy,
          // 落元数据供播放时实时重解析（中转开关 / 直链过期自愈）
          sourceMeta: {
            kind: 'kazumi',
            sourceId,
            episode,
            originalTitle: title,
          },
        })
          .then(() => fetchMovies(roomId))
          .catch((err) => {
            console.error(
              '[MoviePushPanel] addMovie/fetchMovies after kazumi preview failed:',
              err
            )
          })

        message.success(t('已开始播放并加入列表'))
      } catch (err) {
        console.error('[MoviePushPanel] select kazumi episode error:', err)
        message.error(
          err instanceof Error ? err.message : t('加载番剧集数失败')
        )
      } finally {
        setLoading(false)
      }
    },
    [
      isHost,
      roomId,
      addMovie,
      fetchMovies,
      setPendingPreviewPlay,
      playsvideoEnabled,
      serverProxy,
    ]
  )

  // --- CMS 采集源（TVBox） ---

  /** 从剧集 id 反解 CMS 播放定位参数（id = vodId|playFromIndex|episodeIndex） */
  const parseCmsParams = (
    episode: AniSubsEpisode
  ): CmsPlaybackParams | null => {
    const params = episode.playbackParams as Partial<CmsPlaybackParams> | null
    if (
      !params ||
      typeof params.vodId !== 'string' ||
      !params.vodId ||
      typeof params.playFromIndex !== 'number' ||
      typeof params.episodeIndex !== 'number'
    ) {
      return null
    }
    return {
      vodId: params.vodId,
      playFromIndex: params.playFromIndex,
      episodeIndex: params.episodeIndex,
    }
  }

  const buildCmsMoviePayload = useCallback(
    (
      sourceId: string,
      params: CmsPlaybackParams,
      title: string,
      episodeTitle: string,
      serverProxy = false
    ) => ({
      url: `cms://${sourceId}/${params.vodId}|${params.playFromIndex}|${params.episodeIndex}`,
      title,
      source: 'cms',
      // CMS 直链短时效/防盗链：只落 sourceMeta 元数据，播放时实时重解析
      sourceMeta: {
        sourceId,
        vodId: params.vodId,
        vodTitle: title,
        playFromIndex: params.playFromIndex,
        episodeIndex: params.episodeIndex,
        episodeTitle,
      } satisfies CmsSourceMeta,
      // 服务器中转模式：播放时实时重解析路径消费（resolveCmsOnline）
      serverProxy,
    }),
    []
  )

  const handleSelectCmsEpisodes = useCallback(
    async (items: AnimeEpisodeSelection[]): Promise<string[]> => {
      // 批量添加：不做逐集解析（CMS resolve 每次都是一次源站请求），
      // 仅落 sourceMeta，播放时实时解析
      if (!isHost || !roomId) {
        message.error(!isHost ? t('只有房主可以添加影片') : t('未连接房间'))
        return []
      }
      const added: string[] = []
      setLoading(true)
      try {
        for (const [index, item] of items.entries()) {
          setResolveProgress(
            t('正在添加 {{value}}/{{length}} 集...', {
              value: index + 1,
              length: items.length,
            })
          )
          try {
            const params = parseCmsParams(item.episode)
            if (!params) throw new Error(t('剧集定位参数无效'))
            await addMovie(
              roomId,
              buildCmsMoviePayload(
                item.sourceId,
                params,
                item.title,
                item.episode.title,
                serverProxy
              )
            )
            added.push(item.episode.id)
          } catch (err) {
            console.error(
              '[MoviePushPanel] batch add cms episode failed:',
              item.title,
              err
            )
          }
        }
        if (added.length === items.length) {
          message.success(t('已添加 {{length}} 集', { length: added.length }))
        } else {
          message.warning(
            t('已添加 {{length}} 集，{{value}} 集失败，可重试', {
              length: added.length,
              value: items.length - added.length,
            })
          )
        }
        await fetchMovies(roomId)
      } catch (err) {
        message.error(
          err instanceof Error ? err.message : t('刷新影片列表失败')
        )
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
      return added
    },
    [isHost, roomId, addMovie, fetchMovies, buildCmsMoviePayload, serverProxy]
  )

  const handleSelectCmsEpisode = useCallback(
    async (sourceId: string, episode: AniSubsEpisode, title: string) => {
      if (!isHost) {
        message.info(t('只有房主可以播放影片'))
        return
      }
      if (!roomId) {
        message.error(t('未连接房间'))
        return
      }

      const params = parseCmsParams(episode)
      if (!params) {
        message.error(t('剧集定位参数无效，请重新搜索'))
        return
      }

      setLoading(true)
      try {
        // 预览：实时解析直链；是否走服务器代理仅由服务器中转模式
        // （serverProxy）决定，不自动兜底
        const resolved = await resolveCmsEpisode(sourceId, params)

        const finalUrl = serverProxy
          ? buildCmsProxyUrl(resolved.url, resolved.headers, true)
          : resolved.url

        setPendingPreviewPlay({
          url: finalUrl,
          title,
          sourceType: 'cms',
          format: resolved.format,
          playsvideoEnabled,
          noProxyFallback: !serverProxy,
        })

        // 落库：sourceMeta 元数据（直链短时效），播放时实时重解析
        void addMovie(
          roomId,
          buildCmsMoviePayload(
            sourceId,
            params,
            title,
            episode.title,
            serverProxy
          )
        )
          .then(() => fetchMovies(roomId))
          .catch((err) => {
            console.error(
              '[MoviePushPanel] addMovie/fetchMovies after cms preview failed:',
              err
            )
          })

        message.success(t('已开始播放并加入列表'))
      } catch (err) {
        console.error('[MoviePushPanel] select cms episode error:', err)
        message.error(
          err instanceof Error ? err.message : t('加载影片集数失败')
        )
      } finally {
        setLoading(false)
      }
    },
    [
      isHost,
      roomId,
      addMovie,
      fetchMovies,
      setPendingPreviewPlay,
      playsvideoEnabled,
      buildCmsMoviePayload,
      serverProxy,
    ]
  )

  useEffect(() => {
    fetchAllMounts()
      .then((data) => setMounts(data))
      .catch((err) => {
        console.error('[MoviePushPanel] fetch mounts error:', err)
      })
  }, [])

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
          : false
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
          : false
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
      // React Compiler 严格规则误报：预选挂载需同步多个关联 state（表单回填）
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 类型切换时的挂载预选
      handleMountSelect(String(first.id))
    } else if (selectedMountId) {
      setSelectedMountId('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, mounts])

  /**
   * 剧集整卡添加：枚举剧集全部分集（逐季 browse），解析第一集作为初始播放源，
   * 生成单张剧集卡——pages 存分集列表（{page, part, path, mountId, duration}），
   * 播放列表卡片内切换分集时按 path 重新解析并更新 movie.path。
   * 传入 Season 条目时等价于「添加整季」（该目录下枚举到的 Episode 全部入列）。
   */
  const addEmbySeriesCard = useCallback(
    async (
      api: 'emby' | 'jellyfin',
      seriesMountId: number,
      series: EmbyDirectoryEntry
    ) => {
      const browse = api === 'emby' ? browseEmbyMount : browseJellyfinMount
      const resolveFn = api === 'emby' ? resolveEmby : resolveJellyfin
      const directLink = api === 'emby' ? embyDirectLink : jellyfinDirectLink

      setResolveProgress(
        t('正在枚举《{{name}}》的分集...', { name: series.name })
      )
      // 逐季枚举分集：Series 下为 Season（目录），Season 下为 Episode（file）
      const seasons = await browse(seriesMountId, series.path)
      const seasonDirs = seasons.filter(
        (s) => s.type === 'directory' && s.embyType === 'Season'
      )
      const episodeSources =
        seasonDirs.length > 0
          ? seasonDirs
          : // 无季结构的剧集（分集直接挂在 Series 下）：整组当作单季
            [series]
      const episodes: {
        page: number
        cid: number
        part: string
        duration: number
        path: string
        mountId: number
      }[] = []
      for (const season of episodeSources) {
        const eps = await browse(seriesMountId, season.path)
        eps
          // Episode = 刮削库分集；Video = 非刮削库的普通视频文件（无 IndexNumber）
          .filter(
            (e) =>
              e.type === 'file' &&
              (e.embyType === 'Episode' || e.embyType === 'Video')
          )
          .forEach((ep) => {
            // 集号标签：优先 Emby IndexNumber（SxEy），缺失时从文件名解析集号兜底
            let label: string
            if (ep.indexNumber != null) {
              label = `S${ep.parentIndexNumber ?? '?'}E${ep.indexNumber}`
            } else {
              const parsed = ep.filePath
                ? parseEpisodeFromFilePath(ep.filePath)
                : null
              label = parsed ? `EP${parsed.episode}` : ''
            }
            if (!label && season !== series) label = season.name
            episodes.push({
              page: episodes.length + 1,
              cid: 0,
              part: label ? `${label} · ${ep.name}` : ep.name,
              duration: ep.duration ?? 0,
              path: ep.path,
              mountId: seriesMountId,
            })
          })
      }
      if (episodes.length === 0) {
        throw new Error(
          t('《{{name}}》下没有可播放的分集', { name: series.name })
        )
      }

      // 解析第一集作为初始播放源（代理模式 url 会被后端重写为 stream URL）
      setResolveProgress(
        t('正在解析《{{name}}》第 1 集（共 {{length}} 集）...', {
          name: series.name,
          length: episodes.length,
        })
      )
      const first = await resolveFn(seriesMountId, episodes[0].path)
      const mount = mounts.find((m) => m.id === seriesMountId)
      await addMovie(roomId!, {
        url: directLink && first.directUrl ? first.directUrl : first.videoUrl,
        title: series.name,
        cover: buildEmbyImageUrl(
          api,
          seriesMountId,
          series.path,
          series.imageTag,
          300
        ),
        source: api,
        format: first.format,
        duration: first.duration,
        serverUrl: mount?.serverUrl,
        path: episodes[0].path,
        directLink,
        multiVersion: first.multiVersion,
        pages: episodes,
        currentPage: 1,
      })
    },
    [embyDirectLink, jellyfinDirectLink, mounts, roomId, addMovie]
  )

  /** 一键添加整部影片（海报墙/列表条目快捷按钮）：Series=整部剧，Season=整季 */
  const handleQuickAddSeries = useCallback(
    async (entry: EmbyDirectoryEntry) => {
      if (!isHost) {
        message.info(t('只有房主可以添加影片'))
        return
      }
      if (!roomId) {
        message.error(t('未连接房间'))
        return
      }
      const mountId = Number(selectedMountId)
      if (!mountId) {
        message.warning(t('请选择已保存的挂载'))
        return
      }
      if (sourceType !== 'emby' && sourceType !== 'jellyfin') return
      setLoading(true)
      try {
        await addEmbySeriesCard(sourceType, mountId, entry)
        message.success(t('已添加《{{name}}》', { name: entry.name }))
      } catch (err) {
        console.error('[MoviePushPanel] quick add series error:', err)
        message.error(
          err instanceof Error ? err.message : t('添加整部影片失败')
        )
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
    },
    [isHost, roomId, selectedMountId, sourceType, addEmbySeriesCard]
  )

  const handleSelectFilesFromMount = useCallback(
    async (paths: string[], entries?: EmbyDirectoryEntry[]) => {
      if (!isHost) {
        message.info(t('只有房主可以添加影片'))
        return
      }
      if (!roomId) {
        message.error(t('未连接房间'))
        return
      }

      const mountId = Number(selectedMountId)
      if (!mountId) {
        message.warning(t('请选择已保存的挂载'))
        return
      }

      setLoading(true)
      setResolveProgress(
        t('正在批量解析 {{length}} 个文件...', { length: paths.length })
      )
      try {
        let added = 0
        for (const path of paths) {
          const normalizedPath = normalizeMountPath(path)
          if (sourceType === 'webdav' || sourceType === 'openlist') {
            // WebDAV 与 OpenList 共用同一套协议逻辑，仅 API 前缀与直链获取不同
            // 内网地址强制使用服务器转发（浏览器无法直连内网服务器）
            const isDirect =
              sourceType === 'webdav'
                ? isWebdavInternal
                  ? false
                  : webdavDirectLink
                : isOpenlistInternal
                  ? false
                  : openlistDirectLink
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
            const entry = entries?.find((e) => e.path === normalizedPath)
            if (entry?.embyType === 'Series') {
              // 剧集整卡添加：枚举全部分集 → 一张剧集卡（pages 装分集列表）
              await addEmbySeriesCard('emby', mountId, entry)
            } else {
              // Emby：解析播放信息，支持服务器转发（默认）或直链直连
              const resolved = await resolveEmby(mountId, normalizedPath)
              const title =
                resolved.title || extractTitleFromUrl(normalizedPath)
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
                multiVersion: resolved.multiVersion,
              })
            }
            added++
          } else if (sourceType === 'jellyfin') {
            const entry = entries?.find((e) => e.path === normalizedPath)
            if (entry?.embyType === 'Series') {
              await addEmbySeriesCard('jellyfin', mountId, entry)
            } else {
              const resolved = await resolveJellyfin(mountId, normalizedPath)
              const title =
                resolved.title || extractTitleFromUrl(normalizedPath)
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
                multiVersion: resolved.multiVersion,
              })
            }
            added++
          }
        }
        message.success(t('已添加 {{added}} 部影片', { added }))
      } catch (err) {
        console.error('[MoviePushPanel] batch add error:', err)
        message.error(err instanceof Error ? err.message : t('批量添加失败'))
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
      addEmbySeriesCard,
      webdav.serverUrl,
      webdavDirectLink,
      isWebdavInternal,
      ftp.serverUrl,
      ftp.username,
      ftp.password,
      openlist.serverUrl,
      openlistDirectLink,
      isOpenlistInternal,
      embyDirectLink,
      jellyfinDirectLink,
      mounts,
      addMovie,
    ]
  )

  // 本地服务器文件批量添加：与挂载浏览（handleSelectFilesFromMount）行为对齐，
  // 浏览选中后直接逐个 resolve + addMovie，不再回填路径输入框
  const handleSelectFilesFromServer = useCallback(
    async (paths: string[]) => {
      if (!isHost) {
        message.info(t('只有房主可以添加影片'))
        return
      }
      if (!roomId) {
        message.error(t('未连接房间'))
        return
      }

      setLoading(true)
      setResolveProgress(
        t('正在批量解析 {{length}} 个文件...', { length: paths.length })
      )
      try {
        let added = 0
        for (const path of paths) {
          const normalizedPath = path.trim()
          const resolved = await resolveServerFile(normalizedPath)
          const movieUrl = buildServerFileProxyUrl(normalizedPath)
          await addMovie(roomId, {
            url: movieUrl,
            title: resolved.title,
            source: 'server-files',
            format: resolved.format as MediaFormat,
            path: normalizedPath,
            duration: resolved.duration ?? undefined,
            audioCodec: resolved.audioCodec ?? undefined,
          })
          added++
        }
        message.success(t('已添加 {{added}} 部影片', { added }))
      } catch (err) {
        console.error('[MoviePushPanel] batch add server files error:', err)
        message.error(err instanceof Error ? err.message : t('批量添加失败'))
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
    },
    [isHost, roomId, addMovie]
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

  // 统一添加影片：对 webdav/ftp/openlist/mp4 合并 resolve+add 为单步操作
  // bilibili 仍走两步：先 handleResolve 解析 → 选清晰度 → handleAddMovie 添加
  // 各来源的添加流程拆为独立提交器（见 ./movie-submit），此处只做分发。
  const handleAddMovie = async () => {
    if (!isHost) {
      message.info(t('只有房主可以添加影片'))
      return
    }
    if (!roomId) {
      message.error(t('未连接房间'))
      return
    }

    setLoading(true)
    setResolveProgress(t('正在添加影片...'))
    try {
      const ctx: SubmitMovieContext = {
        roomId,
        addMovie,
        resetForm,
        setResolveProgress,
        sourceType,
        url,
        resolvedMovie,
        resolvedViaCli: resolvedViaCliRef.current,
        webdav,
        openlist,
        ftp,
        serverFilePath,
        selectedMountId,
        mounts,
        webdavDirectLink,
        openlistDirectLink,
        embyDirectLink,
        jellyfinDirectLink,
        isWebdavInternal,
        isOpenlistInternal,
      }
      if (sourceType === 'bilibili' && resolvedMovie) {
        await addBilibiliMovie({ ...ctx, resolvedMovie })
      } else if (sourceType === 'mp4') {
        await addMp4Movie(ctx)
      } else if (sourceType === 'webdav' || sourceType === 'openlist') {
        await addPathMountMovie(ctx)
      } else if (sourceType === 'ftp') {
        await addFtpMovie(ctx)
      } else if (sourceType === 'emby') {
        await addMediaServerMovie(ctx, 'Emby')
      } else if (sourceType === 'jellyfin') {
        await addMediaServerMovie(ctx, 'Jellyfin')
      } else if (sourceType === 'server-files') {
        await addServerFilesMovie(ctx)
      }
    } catch (err) {
      console.error('[MoviePushPanel] add movie error:', err)
      message.error(err instanceof Error ? err.message : t('添加影片失败'))
    } finally {
      setLoading(false)
      setResolveProgress('')
    }
  }

  // bilibili 需要先解析再选清晰度；anime 有独立搜索弹窗；其他源点击"添加"直接 resolve+add
  const renderActionButton = () => (
    <SourceActionButton
      sourceType={sourceType}
      loading={loading}
      disabled={!isHost}
      resolved={Boolean(resolvedMovie)}
      onOpenAnimeSource={() => setAnimeOpen(true)}
      onOpenKazumiSource={() => setKazumiOpen(true)}
      onOpenCmsSource={() => setCmsOpen(true)}
      onAdd={() => void handleAddMovie()}
      onResolve={() => void handleResolve()}
    />
  )

  const renderSourceForm = () => {
    switch (sourceType) {
      case 'bilibili':
        return (
          <BilibiliSourceForm
            url={url}
            onChangeUrl={setUrl}
            disabled={!isHost}
            onResolve={() => void handleResolve()}
            onOpenSearch={() => setBiliSearchOpen(true)}
          />
        )
      case 'mp4':
        return (
          <Mp4SourceForm
            url={url}
            onChangeUrl={setUrl}
            onAdd={() => void handleAddMovie()}
          />
        )
      case 'webdav':
        return (
          <PathMountSourceForm
            key="webdav"
            mountType="webdav"
            mountLabel={t('使用已保存的 WebDAV 挂载')}
            serverPlaceholder={t(
              'WebDAV 服务器地址，如 https://example.com/dav（直链模式必填）'
            )}
            mounts={mounts}
            selectedMountId={selectedMountId}
            onMountSelect={handleMountSelect}
            onBrowseMount={setBrowsingMount}
            value={webdav}
            onPatch={(patch) => setWebdav((prev) => ({ ...prev, ...patch }))}
            directLink={webdavDirectLink}
            onChangeDirectLink={setWebdavDirectLink}
            isInternal={isWebdavInternal}
          />
        )
      case 'openlist':
        return (
          <PathMountSourceForm
            key="openlist"
            mountType="openlist"
            mountLabel={t('使用已保存的 OpenList 挂载')}
            serverPlaceholder={t(
              'OpenList 服务器地址（直链模式必填，已选挂载自动填充）'
            )}
            mounts={mounts}
            selectedMountId={selectedMountId}
            onMountSelect={handleMountSelect}
            onBrowseMount={setBrowsingMount}
            value={openlist}
            onPatch={(patch) => setOpenlist((prev) => ({ ...prev, ...patch }))}
            onSubmitPath={() => void handleAddMovie()}
            directLink={openlistDirectLink}
            onChangeDirectLink={setOpenlistDirectLink}
            isInternal={isOpenlistInternal}
          />
        )
      case 'ftp':
        return (
          <FtpSourceForm
            mounts={mounts}
            selectedMountId={selectedMountId}
            onMountSelect={handleMountSelect}
            onBrowseMount={setBrowsingMount}
            value={ftp}
            onPatch={(patch) => setFtp((prev) => ({ ...prev, ...patch }))}
          />
        )
      case 'emby':
        return (
          <MediaServerSourceForm
            key="emby"
            name="Emby"
            mounts={mounts}
            selectedMountId={selectedMountId}
            onMountSelect={handleMountSelect}
            onBrowseMount={setBrowsingMount}
            url={url}
            onChangeUrl={setUrl}
            onAdd={() => void handleAddMovie()}
            directLink={embyDirectLink}
            onChangeDirectLink={setEmbyDirectLink}
          />
        )
      case 'jellyfin':
        return (
          <MediaServerSourceForm
            key="jellyfin"
            name="Jellyfin"
            mounts={mounts}
            selectedMountId={selectedMountId}
            onMountSelect={handleMountSelect}
            onBrowseMount={setBrowsingMount}
            url={url}
            onChangeUrl={setUrl}
            onAdd={() => void handleAddMovie()}
            directLink={jellyfinDirectLink}
            onChangeDirectLink={setJellyfinDirectLink}
          />
        )
      case 'anime':
        return (
          <SourceHint>
            {t('从 ani-subs 订阅源搜索番剧并选择集数播放。')}
          </SourceHint>
        )
      case 'kazumi':
        return (
          <SourceHint>
            {t('从 Kazumi XPath 规则源搜索番剧并选择集数播放。')}
          </SourceHint>
        )
      case 'server-files':
        return (
          <ServerFilesSourceForm
            path={serverFilePath}
            onChangePath={setServerFilePath}
            onOpenBrowser={() => setServerFilesBrowserOpen(true)}
            onAdd={() => void handleAddMovie()}
          />
        )
      default:
        return null
    }
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
              {t('添加影片')}
            </Text>
            <Text
              type="secondary"
              className="text-[10px] uppercase tracking-wide"
            >
              {t('选择来源并添加')}
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
                  (opt.value !== 'anime' &&
                    opt.value !== 'kazumi' &&
                    opt.value !== 'cms')) &&
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

          {/* 服务器中转开关：仅数据源类（ani/kazumi/cms）显示。默认关闭——
              一律直连源站，服务器零媒体流量（带防盗链的源不开中转无法播放，
              浏览器无法设置 Referer/UA）；开启后媒体流一律经服务器中转。
              ani/cms 播放时实时重解析消费，kazumi 添加时物化为代理 URL。 */}
          {(sourceType === 'anime' ||
            sourceType === 'kazumi' ||
            sourceType === 'cms') && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)]">
              <div className="min-w-0">
                <Text className="block text-xs font-medium">
                  {t('服务器中转')}
                </Text>
                <Text
                  type="secondary"
                  className="block text-[11px] leading-snug mt-0.5"
                >
                  {t(
                    '关闭（默认）：一律直连源站，服务器零媒体流量，带防盗链的源需开启才能播放。开启：媒体流一律经服务器中转，兼容性最好但占用服务器流量。'
                  )}
                </Text>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={serverProxy}
                disabled={!isHost}
                onClick={() => setServerProxy((prev) => !prev)}
                className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: serverProxy
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline)',
                }}
              >
                <span
                  className="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                  style={{
                    transform: serverProxy
                      ? 'translateX(18px)'
                      : 'translateX(2px)',
                  }}
                />
              </button>
            </div>
          )}

          {/* 浏览器转码引擎开关：仅挂载/文件类源显示。B站 源解析出的
              MP4/DASH 浏览器必定原生可播，无转码需求，隐藏开关避免困惑。 */}
          {sourceType !== 'bilibili' && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)]">
              <div className="min-w-0">
                <Text className="block text-xs font-medium">
                  {t('浏览器转码引擎')}
                </Text>
                <Text
                  type="secondary"
                  className="block text-[11px] leading-snug mt-0.5"
                >
                  {t(
                    '开启：MKV/DTS 等非常规格式由浏览器端重封装/转码播放。关闭：强制原生直连，不兼容编码将无声。'
                  )}
                </Text>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={playsvideoEnabled}
                disabled={!isHost}
                onClick={() => setPlaysvideoEnabled((prev) => !prev)}
                className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: playsvideoEnabled
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline)',
                }}
              >
                <span
                  className="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                  style={{
                    transform: playsvideoEnabled
                      ? 'translateX(18px)'
                      : 'translateX(2px)',
                  }}
                />
              </button>
            </div>
          )}

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
                  options={resolvedMovie.acceptQuality.map((q) => {
                    const base = q.resolution
                      ? `${q.label} · ${q.resolution}`
                      : q.label
                    const hdrLabel = hdrUnsupportedLabel()
                    return {
                      label:
                        hdrLabel && isHdrQn(q.id)
                          ? `${base}（${hdrLabel}）`
                          : base,
                      value: String(q.id),
                    }
                  })}
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
                  ? t('P{{currentPage}} {{value}} · 点击切换', {
                      currentPage: resolvedMovie.currentPage,
                      value:
                        resolvedMovie.pages.find(
                          (p) => p.page === resolvedMovie.currentPage
                        )?.part ?? '',
                    })
                  : t('共 {{length}} P · 点击选择', {
                      length: resolvedMovie.pages.length,
                    })}
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
                  {t('B站 登录状态')}
                </Text>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--md-sys-shape-corner)] p-1">
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
                        {t('普通账号')}
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
                      {t('退出')}
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
                    {t('扫码登录 B站')}
                  </Button>
                )}
              </div>
              <Paragraph type="secondary" className="m-0 mt-1.5 text-[11px]">
                {bilibiliLoggedIn
                  ? bilibiliUser?.vipStatus === 1
                    ? t('大会员账号，可解析 4K / 1080P 高码率等专属画质')
                    : t('已登录，可解析高画质视频')
                  : t('未登录时只能解析低画质或试看片段')}
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
          onSelectEpisodes={(items) =>
            handleSelectAnimeEpisodes('anime', items)
          }
          disabled={!isHost || loading}
        />
      )}

      {sourceType === 'kazumi' && (
        <KazumiSelector
          open={kazumiOpen}
          onOpenChange={setKazumiOpen}
          onSelectEpisode={handleSelectKazumiEpisode}
          onSelectEpisodes={(items) =>
            handleSelectAnimeEpisodes('kazumi', items)
          }
          disabled={!isHost || loading}
        />
      )}

      {sourceType === 'cms' && (
        <CmsSelector
          open={cmsOpen}
          onOpenChange={setCmsOpen}
          onSelectEpisode={handleSelectCmsEpisode}
          onSelectEpisodes={handleSelectCmsEpisodes}
          disabled={!isHost || loading}
        />
      )}

      <Modal
        open={qrModalOpen}
        onClose={handleCloseQrModal}
        title={t('扫码登录哔哩哔哩')}
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseQrModal}>
            {t('关闭')}
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('哔哩哔哩登录二维码')}
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
              <Text>{t('正在生成二维码…')}</Text>
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
              {t('重新获取二维码')}
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
          onQuickAddSeries={handleQuickAddSeries}
          selectable
        />
      )}

      <ServerFilesBrowser
        open={serverFilesBrowserOpen}
        onClose={() => setServerFilesBrowserOpen(false)}
        onConfirm={handleSelectFilesFromServer}
      />

      {sourceType === 'bilibili' && (
        <BiliSearchModal
          open={biliSearchOpen}
          onClose={() => setBiliSearchOpen(false)}
          onSelect={(videoUrl) => {
            setUrl(videoUrl)
            setBiliSearchOpen(false)
            void handleResolve(videoUrl)
          }}
        />
      )}

      {sourceType === 'bilibili' && resolvedMovie?.pages && (
        <Modal
          open={showPageSelector}
          onClose={() => setShowPageSelector(false)}
          title={t('选择分集')}
          footer={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowPageSelector(false)}
            >
              {t('取消（使用当前分集）')}
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
                        {formatDuration(page.duration, '')}
                        {page.badge ? ` · ${page.badge}` : ''}
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
