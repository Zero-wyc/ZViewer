/**
 * 云盘页（Hydrogen CloudDisk / CloudFileList 1:1 复刻）。
 *
 * 左栏（55%，max 450px）：
 * - 「我的云盘」标题（黑色小方块 tip + 标题）
 * - 分类卡：文件类型六宫格分类过滤（全部/图片/音乐/视频/压缩包/文档，
 *   选中四角框选动画），背景圆环 + INFO 大水印；内嵌「云盘信息」卡：
 *   黑底白字标签 + 当前用户 / 云盘容量进度条 / 文件数量 / 上次添加，
 *   底部横线 + MUSCICLOUD INFO 灰色角标
 * - 大上传框：虚线框 12s 旋转 + 上箭头 + 「上传」；点击/拖拽上传
 *   （multipart → POST /api/music/cloud/upload → 内部 NCM /cloud 多步封装）；
 *   上传中切换为斜条纹滚动动画 + 转码提示；拖拽遮罩 DROP TO UPLOAD / UNSUPPORTED
 * 右栏：文件列表（封面缩略图点击选中 + 文件名（副标题为原始文件名）+
 *   上传时间 + 文件大小 + 复选框），双击行播放（入队 + 立即播放），
 *   选中后滑入批量操作栏（全部取消 / 删除，两段式确认）
 *
 * 数据：GET /api/music/ncm/user/cloud?limit=500（count/size/maxSize + data[]），
 * simpleSong 缺封面/名称时分批调 /song/detail 补齐（Hydrogen hydrateCloudSongDetails）；
 * 删除：GET /api/music/ncm/user/cloud/del?id=逗号拼接。
 * 云盘歌曲 songId 即 NCM 歌曲 ID，直接走 /api/music/stream 播放。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  CirclePlay,
  FileArchive,
  FileText,
  Image,
  LayoutGrid,
  Loader2,
  Music2,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiFetch, apiGet } from '@/lib/api'
import { cn } from '@/lib/utils'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import type { NcmSong } from '../types'
import { MusicLoginGate } from './MusicLoginGate'

export interface MusicCloudPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

// ==================== 数据类型 ====================

/** /user/cloud 条目（Hydrogen cloudStore 同构：simpleSong 内嵌真实歌曲对象） */
interface CloudItem {
  /** 云盘文件 ID（删除用） */
  songId?: number
  fileName?: string
  /** 字节 */
  fileSize?: number
  /** 上传时间戳（毫秒） */
  addTime?: number
  songName?: string
  simpleSong?: {
    id: number
    name?: string
    ar?: Array<{ name?: string }>
    al?: { name?: string; picUrl?: string }
    dt?: number
    fee?: number
  }
}

interface CloudData {
  /** 文件数量 */
  count: number
  /** 已用容量（GB，1 位小数） */
  sizeGb: number
  /** 总容量（GB） */
  maxSizeGb: number
  items: CloudItem[]
}

const BYTES_PER_GB = 1024 * 1024 * 1024

/** 上传支持的后缀白名单（Hydrogen 同款） */
const UPLOAD_ACCEPT_EXTS = [
  'mp3',
  'aac',
  'wma',
  'wav',
  'ogg',
  'm4a',
  'ape',
  'flac',
  'cue',
]

// ==================== 文件类型分类（Hydrogen CLOUD_CATEGORY_*） ====================

interface CloudCategory {
  key: number
  name: string
  icon: LucideIcon
  exts: ReadonlySet<string> | null
}

const CLOUD_CATEGORIES: CloudCategory[] = [
  { key: 1, name: '全部', icon: LayoutGrid, exts: null },
  {
    key: 2,
    name: '图片',
    icon: Image,
    exts: new Set([
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'bmp',
      'svg',
      'heic',
      'heif',
      'avif',
    ]),
  },
  {
    key: 3,
    name: '音乐',
    icon: Music2,
    exts: new Set([
      'mp3',
      'aac',
      'wma',
      'wav',
      'ogg',
      'm4a',
      'ape',
      'flac',
      'cue',
      'aiff',
      'aif',
      'alac',
      'dsf',
    ]),
  },
  {
    key: 4,
    name: '视频',
    icon: CirclePlay,
    exts: new Set([
      'mp4',
      'm4v',
      'mov',
      'avi',
      'mkv',
      'webm',
      'flv',
      'wmv',
      'mpeg',
      'mpg',
    ]),
  },
  {
    key: 5,
    name: '压缩包',
    icon: FileArchive,
    exts: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso']),
  },
  {
    key: 6,
    name: '文档',
    icon: FileText,
    exts: new Set([
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'txt',
      'md',
      'rtf',
      'csv',
      'epub',
    ]),
  },
]

/** fileName 最后一个 . 后的后缀（小写；无后缀返回空串） */
function getFileExt(fileName: string | undefined): string {
  if (!fileName) return ''
  const dot = fileName.lastIndexOf('.')
  if (dot < 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

/** 分类过滤（Hydrogen matchesCategory：音乐类特殊处理——无后缀但有歌曲 ID 也归音乐） */
function matchesCategory(item: CloudItem, categoryKey: number): boolean {
  if (categoryKey === 1) return true
  const ext = getFileExt(item.fileName)
  if (!ext) return categoryKey === 3 && !!item.simpleSong?.id
  const category = CLOUD_CATEGORIES.find((c) => c.key === categoryKey)
  return category?.exts?.has(ext) ?? false
}

// ==================== 工具函数 ====================

/** 云盘文件展示标题（Hydrogen getItemTitle：songName > simpleSong.name > fileName） */
function getItemTitle(item: CloudItem): string {
  return item.songName || item.simpleSong?.name || item.fileName || '未知文件'
}

/** 副标题：原始文件名与标题不同时展示（Hydrogen getItemSecondaryName） */
function getItemSecondaryName(item: CloudItem): string {
  const fileName = item.fileName || ''
  return fileName && fileName !== getItemTitle(item) ? `(${fileName})` : ''
}

/** 封面（simpleSong.al.picUrl） */
function getItemCover(item: CloudItem): string {
  return item.simpleSong?.al?.picUrl || ''
}

/** 文件大小 MB（1 位小数） */
function getItemFileSizeMb(item: CloudItem): string {
  const bytes = Number(item.fileSize) || 0
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 上传时间 YYYY-MM-DD HH:mm:ss（无则 NONE，Hydrogen addTime 格式） */
function formatAddTime(ts: number | undefined): string {
  if (!ts) return 'NONE'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'NONE'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 云盘条目 → 可播放歌曲（simpleSong.id 即 NCM 歌曲 ID，云盘标记无需持久化：
 *  播放 URL 直接走 /api/music/stream 代理的 /song/url/v1） */
function itemToSong(item: CloudItem): NcmSong | null {
  const s = item.simpleSong
  if (!s || !s.id || s.id <= 0) return null
  return {
    songId: s.id,
    name: getItemTitle(item),
    artist:
      (s.ar ?? [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(' / ') || '未知歌手',
    album: s.al?.name ?? '',
    cover: s.al?.picUrl ?? '',
    durationMs: s.dt ?? 0,
    vip: s.fee === 1 || s.fee === 4,
  }
}

/** /user/cloud 响应 → 页面数据（Hydrogen buildCloudDataSnapshot：字节 → GB） */
function buildCloudData(result: {
  data?: CloudItem[]
  count?: number
  size?: number
  maxSize?: number
}): CloudData {
  const items = Array.isArray(result?.data) ? result.data : []
  return {
    count: Number(result?.count || 0),
    sizeGb: Number(((Number(result?.size) || 0) / BYTES_PER_GB).toFixed(1)),
    maxSizeGb: Number(
      ((Number(result?.maxSize) || 0) / BYTES_PER_GB).toFixed(0)
    ),
    items,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ==================== 页面组件 ====================

export function MusicCloudPage({
  socket,
  roomId,
  canManage,
}: MusicCloudPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)

  const [cloudData, setCloudData] = useState<CloudData | null>(null)
  const [loading, setLoading] = useState(false)
  /** 分类过滤（Hydrogen typeSelect，默认「全部」） */
  const [typeSelect, setTypeSelect] = useState(1)
  /** 勾选的云盘文件 key 集合（simpleSong.id / songId） */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropSupported, setDropSupported] = useState(true)
  /** 删除按钮两段式确认（点击一次进入确认态，再点执行；3s 无操作自动复位） */
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const confirmResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  const { add } = useQueueAdd(socket, roomId, canManage)
  const { playSong } = useMusicPlayer()

  // ==================== 数据获取 ====================

  const fetchCloud = useCallback(async (): Promise<CloudData | null> => {
    const { data } = await apiGet<{
      data?: CloudItem[]
      count?: number
      size?: number
      maxSize?: number
    }>('/api/music/ncm/user/cloud?limit=500&offset=0')
    const snapshot = buildCloudData(data ?? {})
    // simpleSong 缺封面/名称时分批补齐（Hydrogen hydrateCloudSongDetails：
    // /song/detail 每批 100 个 id）
    const needDetail = snapshot.items.filter(
      (item) =>
        item.simpleSong?.id &&
        (!item.simpleSong.al?.picUrl || !item.simpleSong.name)
    )
    if (needDetail.length > 0) {
      const detailMap = new Map<number, NonNullable<CloudItem['simpleSong']>>()
      for (let i = 0; i < needDetail.length; i += 100) {
        const ids = needDetail
          .slice(i, i + 100)
          .map((item) => item.simpleSong?.id)
          .filter((id): id is number => !!id)
        if (ids.length === 0) continue
        try {
          const { data: detail } = await apiGet<{
            songs?: Array<NonNullable<CloudItem['simpleSong']>>
          }>(`/api/music/ncm/song/detail?ids=${ids.join(',')}`)
          for (const song of detail?.songs ?? []) {
            if (song?.id) detailMap.set(song.id, song)
          }
        } catch (err) {
          console.warn('[MusicCloudPage] 歌曲详情补齐失败:', err)
        }
      }
      if (detailMap.size > 0) {
        snapshot.items = snapshot.items.map((item) => {
          const detail = detailMap.get(item.simpleSong?.id ?? 0)
          if (!detail) return item
          return {
            ...item,
            simpleSong: {
              ...detail,
              // 已有字段优先保留（detail 主要补 al.picUrl / name）
              ...item.simpleSong,
              al: item.simpleSong?.al?.picUrl ? item.simpleSong.al : detail.al,
              name: item.simpleSong?.name || detail.name,
            },
          }
        })
      }
    }
    setCloudData(snapshot)
    return snapshot
  }, [])

  // 登录后拉取云盘数据
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，loading 置位与请求同步发起
    setLoading(true)
    void (async () => {
      try {
        await fetchCloud()
      } catch (err) {
        console.error('[MusicCloudPage] 云盘获取失败:', err)
        if (!cancelled) message.error('云盘获取失败，请稍后重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loginStatus.loggedIn, fetchCloud])

  /** 上传后轮询刷新（Hydrogen refreshCloudDataAfterUpload：转码登记异步，
   *  按 [1000, 2500, 5000] 重试直到 count 变化或次数用尽） */
  const pollRefreshAfterUpload = useCallback(async () => {
    const baseCount = cloudData?.count ?? 0
    for (const delay of [1000, 2500, 5000]) {
      await sleep(delay)
      try {
        const snapshot = await fetchCloud()
        if (snapshot && snapshot.count !== baseCount) return
      } catch {
        return
      }
    }
  }, [cloudData?.count, fetchCloud])

  // ==================== 上传 ====================

  /** 逐个上传（Hydrogen uploadFilesSequentially：单文件最多重试 3 次，
   *  线性退避 800ms × attempt） */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || isUploading) return

      setIsUploading(true)
      let successCount = 0
      try {
        for (const file of files) {
          let uploaded = false
          for (let attempt = 1; attempt <= 3 && !uploaded; attempt += 1) {
            try {
              const formData = new FormData()
              // 字段名固定 songFile（neteasecloudmusicapi /cloud 契约）
              formData.append('songFile', file)
              const res = await apiFetch('/api/music/cloud/upload', {
                method: 'POST',
                body: formData,
              })
              const data = (await res.json().catch(() => null)) as {
                code?: number
                message?: string
                msg?: string
              } | null
              if (res.ok && data?.code === 200) {
                uploaded = true
                successCount += 1
                message.success(`${file.name} 上传成功`)
              } else {
                throw new Error(
                  data?.message || data?.msg || `HTTP ${res.status}`
                )
              }
            } catch (err) {
              console.warn(
                `[MusicCloudPage] ${file.name} 上传失败（第 ${attempt} 次）:`,
                err
              )
              if (attempt === 3) {
                message.error(`${file.name} 上传失败`)
              } else {
                await sleep(800 * attempt)
              }
            }
          }
        }
        if (successCount > 0) {
          message.success('上传完毕，上传完成后可能需要转码，请稍后刷新查看')
        }
      } finally {
        setIsUploading(false)
      }
      if (successCount > 0) void pollRefreshAfterUpload()
    },
    [isUploading, pollRefreshAfterUpload]
  )

  /** 拖拽文件是否支持（按后缀白名单） */
  const analyzeDragItems = useCallback(
    (items: DataTransferItemList): boolean => {
      for (let i = 0; i < items.length; i += 1) {
        const file = items[i]?.getAsFile()
        if (!file) continue
        const ext = getFileExt(file.name)
        if (!UPLOAD_ACCEPT_EXTS.includes(ext)) return false
      }
      return true
    },
    []
  )

  // ==================== 选择 / 删除 ====================

  /** 勾选 key（优先云盘文件 ID，缺省用歌曲 ID） */
  const getItemKey = useCallback((item: CloudItem): string => {
    return String(item.songId ?? item.simpleSong?.id ?? item.fileName ?? '')
  }, [])

  // ==================== 派生数据 ====================

  const visibleItems = useMemo(
    () =>
      (cloudData?.items ?? []).filter((item) =>
        matchesCategory(item, typeSelect)
      ),
    [cloudData, typeSelect]
  )

  /** 选中集合的渲染期派生过滤（Hydrogen「分类切换清空不可见选中」的等价实现：
   *  不可见项不参与展示与删除，切回原分类时选择自动恢复，无需 effect 清理） */
  const visibleItemKeys = useMemo(
    () => new Set(visibleItems.map(getItemKey)),
    [visibleItems, getItemKey]
  )
  const effectiveSelectedIds = useMemo(
    () => selectedIds.filter((id) => visibleItemKeys.has(id)),
    [selectedIds, visibleItemKeys]
  )

  const selectedCategoryName = useMemo(
    () => CLOUD_CATEGORIES.find((c) => c.key === typeSelect)?.name ?? '全部',
    [typeSelect]
  )

  const toggleSelect = useCallback(
    (item: CloudItem) => {
      const key = getItemKey(item)
      if (!key) return
      setSelectedIds((prev) =>
        prev.includes(key) ? prev.filter((id) => id !== key) : [...prev, key]
      )
    },
    [getItemKey]
  )

  const clearSelect = useCallback(() => setSelectedIds([]), [])

  /** 批量删除（两段式确认：首次点击进入确认态，再次点击执行；
   *  Hydrogen 为 dialogOpen 确认弹窗，此处以内联两段按钮等价实现） */
  const deleteSelected = useCallback(async () => {
    if (effectiveSelectedIds.length === 0) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      if (confirmResetTimerRef.current)
        clearTimeout(confirmResetTimerRef.current)
      confirmResetTimerRef.current = setTimeout(() => {
        setConfirmingDelete(false)
      }, 3000)
      return
    }
    if (confirmResetTimerRef.current) {
      clearTimeout(confirmResetTimerRef.current)
      confirmResetTimerRef.current = null
    }
    setConfirmingDelete(false)
    try {
      const { data } = await apiGet<{ code?: number }>(
        `/api/music/ncm/user/cloud/del?id=${effectiveSelectedIds.join(',')}`
      )
      if (data?.code === 200) {
        message.success('删除成功')
        setSelectedIds([])
        await fetchCloud()
      } else {
        message.error('删除失败')
      }
    } catch (err) {
      console.error('[MusicCloudPage] 云盘删除失败:', err)
      message.error('删除失败')
    }
  }, [effectiveSelectedIds, confirmingDelete, fetchCloud])

  // 卸载时清理确认复位定时器
  useEffect(() => {
    const timer = confirmResetTimerRef
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  // ==================== 播放 ====================

  /** 双击行播放（与我的音乐页同范式：queue-upsert 入队 → playSong 立即播放） */
  const handleRowDoubleClick = useCallback(
    (item: CloudItem) => {
      const song = itemToSong(item)
      if (!song) {
        message.error('该文件暂无法播放')
        return
      }
      if (song.vip && !loginStatus.loggedIn) return
      if (!roomId) {
        message.error('未连接房间')
        return
      }
      add(songToUpsertItem(song))
      playSong({
        id: -1,
        roomId,
        songId: song.songId,
        name: song.name,
        artist: song.artist,
        album: song.album,
        cover: song.cover,
        durationMs: song.durationMs,
        vip: song.vip,
        order: 0,
        addedBy: '',
      })
    },
    [loginStatus.loggedIn, roomId, add, playSong]
  )

  // ==================== 派生数据（续） ====================

  /** 上次添加：遍历全部条目取最大 addTime（Hydrogen lastAddedTime） */
  const lastAddedTime = useMemo(() => {
    let max = 0
    for (const item of cloudData?.items ?? []) {
      const ts = Number(item.addTime) || 0
      if (ts > max) max = ts
    }
    return max > 0 ? formatAddTime(max) : 'NONE'
  }, [cloudData])

  /** 容量进度百分比（防御性：maxSize 为 0 或小于 size 时收敛到 [2, 100]） */
  const capacityPercent = useMemo(() => {
    const size = cloudData?.sizeGb ?? 0
    const max = cloudData?.maxSizeGb ?? 0
    if (max <= 0 || size > max) return 100
    return Math.max(2, Math.round((size / max) * 100))
  }, [cloudData])

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <MusicLoginGate hint="登录后查看网易云云盘歌曲" />
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-190px)] min-h-[540px] w-full gap-8 px-6 pt-6 md:px-8">
      {/* ==================== 左栏 ==================== */}
      <div className="flex w-[55%] min-w-[320px] max-w-[450px] shrink-0 flex-col">
        {/* 「我的云盘」标题（黑色小方块 tip + 标题） */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="h-[6px] w-[6px]"
            style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          />
          <span
            className="text-base font-bold"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            我的云盘
          </span>
        </div>

        {/* 分类卡：六宫格 + 云盘信息 + 水印 */}
        <div className="glass-card relative mt-4 flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          {/* 左上圆环水印（Hydrogen tab-back1） */}
          <svg
            className="pointer-events-none absolute left-3 top-3 z-0 h-5 w-5 opacity-40"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="10"
              cy="10"
              r="7"
              stroke="var(--md-sys-color-on-surface)"
              strokeWidth="1.5"
            />
            <circle
              cx="10"
              cy="10"
              r="3"
              stroke="var(--md-sys-color-on-surface)"
              strokeWidth="1.5"
            />
          </svg>
          {/* 右上大号 INFO 水印（Hydrogen tab-back2） */}
          <div
            className="pointer-events-none absolute right-3 top-1 z-0 select-none text-[38px] font-bold leading-none opacity-[0.08]"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            aria-hidden="true"
          >
            INFO
          </div>

          {/* 文件类型六宫格（分类过滤器，选中四角框选动画） */}
          <div className="relative z-[1] grid flex-[3] grid-cols-3 content-evenly">
            {CLOUD_CATEGORIES.map((category) => {
              const selected = typeSelect === category.key
              const Icon = category.icon
              return (
                <button
                  key={category.key}
                  type="button"
                  onClick={() => setTypeSelect(category.key)}
                  className="relative flex flex-col items-center gap-1.5 rounded-[var(--md-sys-radius-small)] py-2 transition-opacity hover:opacity-80"
                >
                  {/* 选中四角框（Hydrogen .type-selected 四角） */}
                  {selected && (
                    <>
                      <span
                        className="pointer-events-none absolute left-1 top-1 h-3 w-3 border-l-2 border-t-2"
                        style={{
                          borderColor: 'var(--md-sys-color-on-surface)',
                          animation:
                            'cloud-corner-in 0.3s cubic-bezier(0.4, 0, 0.12, 1) both',
                        }}
                      />
                      <span
                        className="pointer-events-none absolute right-1 top-1 h-3 w-3 border-r-2 border-t-2"
                        style={{
                          borderColor: 'var(--md-sys-color-on-surface)',
                          animation:
                            'cloud-corner-in 0.3s cubic-bezier(0.4, 0, 0.12, 1) both',
                        }}
                      />
                      <span
                        className="pointer-events-none absolute bottom-1 right-1 h-3 w-3 border-b-2 border-r-2"
                        style={{
                          borderColor: 'var(--md-sys-color-on-surface)',
                          animation:
                            'cloud-corner-in 0.3s cubic-bezier(0.4, 0, 0.12, 1) both',
                        }}
                      />
                      <span
                        className="pointer-events-none absolute bottom-1 left-1 h-3 w-3 border-b-2 border-l-2"
                        style={{
                          borderColor: 'var(--md-sys-color-on-surface)',
                          animation:
                            'cloud-corner-in 0.3s cubic-bezier(0.4, 0, 0.12, 1) both',
                        }}
                      />
                    </>
                  )}
                  <Icon
                    className="h-8 w-8"
                    strokeWidth={1.5}
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                  />
                  <span
                    className="text-xs font-bold"
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                  >
                    {category.name}
                  </span>
                </button>
              )
            })}
          </div>

          {/* 云盘信息卡（黑底白字标签 + 四行信息 + MUSCICLOUD INFO 角标） */}
          <div
            className="relative z-[1] mt-2 shrink-0 p-3 pt-4"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-surface-container-highest) 55%, transparent)',
            }}
          >
            {/* 黑底白字「云盘信息」标签 */}
            <span
              className="absolute -top-2 left-0 px-1.5 py-0.5 text-[9px] font-bold"
              style={{
                backgroundColor: 'var(--md-sys-color-on-surface)',
                color: 'var(--md-sys-color-surface)',
              }}
            >
              云盘信息
            </span>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center text-xs font-bold">
                <span className="w-16 shrink-0">当前用户</span>
                <span className="truncate font-normal opacity-80">
                  {loginStatus.nickname || '未知用户'}
                </span>
              </div>
              <div className="flex items-center text-xs font-bold">
                <span className="w-16 shrink-0">云盘容量</span>
                {/* 容量进度条（on-surface 进度 + 描边轨道） */}
                <div
                  className="mx-2 h-[7px] flex-1"
                  style={{
                    border: '0.5px solid var(--md-sys-color-on-surface)',
                  }}
                >
                  <div
                    className="h-full transition-[width] duration-500"
                    style={{
                      width: `${capacityPercent}%`,
                      backgroundColor: 'var(--md-sys-color-on-surface)',
                    }}
                  />
                </div>
                <span className="shrink-0 font-normal opacity-80">
                  {(cloudData?.sizeGb ?? 0).toFixed(1)}G /{' '}
                  {cloudData?.maxSizeGb ?? 0}G
                </span>
              </div>
              <div className="flex items-center text-xs font-bold">
                <span className="w-16 shrink-0">文件数量</span>
                <span className="font-normal opacity-80">
                  {cloudData?.count ?? 0} 个
                </span>
              </div>
              <div className="flex items-center text-xs font-bold">
                <span className="w-16 shrink-0">上次添加</span>
                <span className="truncate font-normal opacity-80">
                  {lastAddedTime}
                </span>
              </div>
            </div>
            {/* 底部横线 + MUSCICLOUD INFO 灰色角标（保留 Hydrogen 拼写） */}
            <div className="mt-2.5 flex items-center gap-2">
              <div
                className="h-px flex-1"
                style={{
                  backgroundColor: 'var(--md-sys-color-outline-variant)',
                }}
              />
              <span
                className="shrink-0 text-[9px] opacity-60"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                MUSCICLOUD INFO
              </span>
            </div>
          </div>
        </div>

        {/* 大上传框（点击 + 拖拽；上传中切换为斜条纹动画） */}
        <div
          className="glass-card relative mt-3 h-[150px] shrink-0 cursor-pointer select-none transition-colors hover:opacity-90"
          onClick={() => {
            if (!isUploading) uploadInputRef.current?.click()
          }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isUploading) return
            setIsDragOver(true)
            setDropSupported(analyzeDragItems(e.dataTransfer.items))
          }}
          onDragLeave={(e) => {
            e.preventDefault()
            setIsDragOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setIsDragOver(false)
            if (isUploading) return
            const files = Array.from(e.dataTransfer.files).filter((file) =>
              UPLOAD_ACCEPT_EXTS.includes(getFileExt(file.name))
            )
            if (files.length === 0) {
              message.error('不支持的文件类型')
              return
            }
            void uploadFiles(files)
          }}
        >
          {isUploading ? (
            /* 上传中：斜条纹滚动动画 + 转码提示（Hydrogen .upload-animation） */
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(-45deg, transparent 0 10px, color-mix(in srgb, var(--md-sys-color-on-surface) 7%, transparent) 10px 20px)',
                animation: 'cloud-upload-stripes 0.8s linear infinite',
              }}
            >
              <span
                className="text-sm font-bold"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                上传中...
              </span>
              <span
                className="text-center text-xs opacity-70"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                上传完成后可能需要转码，请稍后刷新查看
              </span>
            </div>
          ) : (
            /* 默认态：虚线框 12s 旋转 + 上箭头 + 「上传」 */
            <div className="flex h-full flex-col items-center justify-center gap-1.5">
              <div className="relative flex h-11 w-11 items-center justify-center">
                <svg
                  viewBox="0 0 44 44"
                  className="h-11 w-11 animate-[spin_12s_linear_infinite]"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect
                    x="5"
                    y="5"
                    width="34"
                    height="34"
                    rx="5"
                    stroke="var(--md-sys-color-on-surface-variant)"
                    strokeWidth="2"
                    strokeDasharray="6 5"
                  />
                </svg>
                <ArrowUp
                  className="absolute h-4 w-4"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                />
              </div>
              <span
                className="text-xl font-light"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                上传
              </span>
            </div>
          )}
          {/* 拖拽遮罩（DROP TO UPLOAD / UNSUPPORTED） */}
          {isDragOver && (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-surface-container) 80%, transparent)',
                outline: '1px dashed var(--md-sys-color-on-surface)',
                outlineOffset: '-6px',
              }}
            >
              <span
                className="text-sm font-bold"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                {dropSupported ? 'DROP TO UPLOAD' : 'UNSUPPORTED'}
              </span>
              {!dropSupported && (
                <span
                  className="text-xs opacity-70"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  仅支持 {UPLOAD_ACCEPT_EXTS.join(' / ')}
                </span>
              )}
            </div>
          )}
          <input
            ref={uploadInputRef}
            type="file"
            className="hidden"
            accept={UPLOAD_ACCEPT_EXTS.map((ext) => `.${ext}`).join(',')}
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              void uploadFiles(files)
            }}
          />
        </div>
      </div>

      {/* ==================== 右栏：文件列表 ==================== */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 批量操作栏（选中后从右滑入；Hydrogen .item-check-bar） */}
        <div
          className={cn(
            'glass-card absolute right-0 top-0 z-20 flex items-center gap-1 rounded-[var(--md-sys-shape-corner)] p-1.5 transition-all duration-300',
            effectiveSelectedIds.length > 0
              ? 'translate-x-0 opacity-100'
              : 'pointer-events-none translate-x-6 opacity-0'
          )}
        >
          <button
            type="button"
            onClick={clearSelect}
            className="flex items-center gap-1 rounded-[var(--md-sys-radius-small)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            <X className="h-3.5 w-3.5" />
            全部取消
          </button>
          <button
            type="button"
            onClick={() => void deleteSelected()}
            className={cn(
              'flex items-center gap-1 rounded-[var(--md-sys-radius-small)] px-2.5 py-1.5 text-xs font-medium transition-colors',
              confirmingDelete && 'animate-pulse'
            )}
            style={{
              color: confirmingDelete
                ? 'var(--md-sys-color-error)'
                : 'var(--md-sys-color-on-surface)',
              backgroundColor: confirmingDelete
                ? 'color-mix(in srgb, var(--md-sys-color-error) 12%, transparent)'
                : undefined,
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmingDelete
              ? '确认删除？'
              : `删除（${effectiveSelectedIds.length}）`}
          </button>
        </div>

        {/* 列表（滚动；行：封面 + 文件名 + 时间/大小 + 复选框，双击播放） */}
        <div className="zen-scroll min-h-0 flex-1 overflow-y-auto pt-1">
          {loading && (
            <div
              className="flex items-center gap-2 px-2 py-3 text-sm"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在获取云盘文件…
            </div>
          )}
          {!loading && visibleItems.length === 0 && (
            <div
              className="flex h-full items-center justify-center text-sm opacity-60"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {selectedCategoryName}暂无文件
            </div>
          )}
          {!loading &&
            visibleItems.map((item, idx) => {
              const key = getItemKey(item)
              const selected = effectiveSelectedIds.includes(key)
              const cover = getItemCover(item)
              return (
                <div
                  key={`${key}-${idx}`}
                  className="group flex cursor-pointer items-center gap-3 border-b px-2 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_6%,transparent)]"
                  style={{
                    borderColor:
                      'color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
                  }}
                  onDoubleClick={() => handleRowDoubleClick(item)}
                  title="双击播放，点击封面或右侧勾选框选中"
                >
                  {/* 封面缩略图（点击选中；无封面 NO COVER 占位） */}
                  <div
                    className="relative h-12 w-12 shrink-0 overflow-hidden"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-surface-container-highest) 70%, transparent)',
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSelect(item)
                    }}
                  >
                    {cover ? (
                      <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span
                        className="flex h-full w-full items-center justify-center text-[8px] font-bold tracking-wider opacity-50"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      >
                        NO COVER
                      </span>
                    )}
                  </div>
                  {/* 文件名（副标题为原始文件名）+ 时间 / 大小 */}
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-sm font-medium"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    >
                      {getItemTitle(item)}
                      {getItemSecondaryName(item) && (
                        <span
                          className="ml-1 text-xs font-normal opacity-60"
                          style={{
                            color: 'var(--md-sys-color-on-surface-variant)',
                          }}
                        >
                          {getItemSecondaryName(item)}
                        </span>
                      )}
                    </div>
                    <div
                      className="mt-0.5 flex gap-3 text-xs"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      <span>{formatAddTime(item.addTime)}</span>
                      <span>{getItemFileSizeMb(item)}</span>
                    </div>
                  </div>
                  {/* 复选框（选中 on-surface 底 + 反色对勾） */}
                  <button
                    type="button"
                    aria-label={selected ? '取消选中' : '选中'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSelect(item)
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center border transition-colors"
                    style={{
                      borderColor: 'var(--md-sys-color-on-surface)',
                      backgroundColor: selected
                        ? 'var(--md-sys-color-on-surface)'
                        : 'transparent',
                      color: selected
                        ? 'var(--md-sys-color-surface)'
                        : 'var(--md-sys-color-on-surface)',
                    }}
                  >
                    {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                  </button>
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
