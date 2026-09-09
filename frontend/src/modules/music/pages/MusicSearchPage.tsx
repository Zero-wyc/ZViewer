/**
 * 搜索页（Hydrogen SearchResult view-control 范式）。
 *
 * - 顶部区块头 + 大标题「搜索内容：xxx」（关键词来自顶部导航写入的 store）
 * - 关键词变化自动触发搜索：GET /api/music/ncm/search?keywords=&limit=30
 *   （cloudsearch 结构；老端点 /cloudsearch 兜底，逻辑迁移自 MusicSearchPanel）
 * - SongRow 裸列表：canManage hover Plus 添加，「已添加」2s 态（useQueueAdd）
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, Music, Plus, SearchX } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import type { NcmSong } from '../types'
import { SongRow } from '../components/SongRow'
import { PageBlockHeader } from './MusicLoginGate'

export interface MusicSearchPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** 网易云 cloudsearch 原始响应（后端透传结构） */
interface CloudsearchSong {
  id: number
  name: string
  ar?: Array<{ name?: string }>
  al?: { name?: string; picUrl?: string }
  dt?: number
  /** 0 免费 / 1 VIP / 4 购买专辑 / 8 低音质免费 */
  fee?: number
}

interface NcmCloudsearchResponse {
  code?: number
  result?: {
    songs?: CloudsearchSong[]
  }
}

/** 搜索结果条数上限 */
const SEARCH_LIMIT = 30

/** cloudsearch 条目 → NcmSong */
function mapSong(song: CloudsearchSong): NcmSong {
  return {
    songId: song.id,
    name: song.name,
    artist: (song.ar ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: song.al?.name ?? '',
    cover: song.al?.picUrl ?? '',
    durationMs: song.dt ?? 0,
    // fee=1（VIP 曲目）与 fee=4（购买专辑）未登录时不可播
    vip: song.fee === 1 || song.fee === 4,
  }
}

/** 毫秒时长格式化为 m:ss */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function MusicSearchPage({
  socket,
  roomId,
  canManage,
}: MusicSearchPageProps) {
  const keywords = useMusicStore((s) => s.searchKeywords)
  const loginStatus = useMusicStore((s) => s.loginStatus)

  const [results, setResults] = useState<NcmSong[]>([])
  const [searching, setSearching] = useState(false)
  /** 是否已发起过搜索（区分初始空态与无结果空态） */
  const [searched, setSearched] = useState(false)

  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)

  // 关键词变化自动搜索（顶部导航回车写入 store；/search 失败时 /cloudsearch 兜底）
  useEffect(() => {
    const kw = keywords.trim()
    if (!kw) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 关键词驱动的外部搜索请求，loading 置位与请求同步发起
    setSearching(true)
    void (async () => {
      try {
        const { data, ok } = await apiGet<NcmCloudsearchResponse>(
          `/api/music/ncm/search?keywords=${encodeURIComponent(kw)}&limit=${SEARCH_LIMIT}`
        )
        let songs = data?.result?.songs
        if (!ok || !Array.isArray(songs)) {
          // 兜底：老版 NCM API 的 cloudsearch 端点
          const fb = await apiGet<NcmCloudsearchResponse>(
            `/api/music/ncm/cloudsearch?keywords=${encodeURIComponent(kw)}&limit=${SEARCH_LIMIT}`
          )
          songs = fb.data?.result?.songs
        }
        if (cancelled) return
        if (!Array.isArray(songs)) {
          throw new Error('搜索失败，请稍后重试')
        }
        setResults(songs.map(mapSong))
        setSearched(true)
      } catch (err) {
        console.error('[MusicSearchPage] 搜索失败:', err)
        if (!cancelled) {
          message.error(
            err instanceof Error ? err.message : '搜索失败，请稍后重试'
          )
          setResults([])
          setSearched(true)
        }
      } finally {
        if (!cancelled) setSearching(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [keywords])

  return (
    <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
      {/* 顶部：view-control 范式标题 */}
      <PageBlockHeader
        titleEN="SEARCH RESULT"
        titleCN={`搜索内容：${keywords || '—'}`}
      />

      {/* 结果区：SongRow 裸列表（无卡片行包裹，靠行 hover 背景区分） */}
      <div className="mt-4 flex min-h-[240px] flex-1 flex-col">
        {searching && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在搜索…
          </div>
        )}
        {!searching && results.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
              }}
            >
              {searched ? (
                <SearchX
                  className="h-5 w-5 opacity-40"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                />
              ) : (
                <Music
                  className="h-5 w-5 opacity-40"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                />
              )}
            </div>
            <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {searched
                ? '未找到相关歌曲，换个关键词试试'
                : '在顶部搜索框输入关键词搜索网易云歌曲'}
            </span>
          </div>
        )}
        {results.map((song, idx) => {
          const added = addedKeys.has(`ncm:${song.songId}`)
          return (
            <SongRow
              key={song.songId}
              index={idx + 1}
              cover={song.cover}
              name={song.name}
              artist={song.artist}
              duration={formatDurationMs(song.durationMs)}
              vip={song.vip}
              disabled={song.vip && !loginStatus.loggedIn}
              hoverAction={
                added ? (
                  <Check className="h-[18px] w-[18px] text-[var(--md-sys-color-primary)]" />
                ) : (
                  <Plus className="h-[18px] w-[18px]" />
                )
              }
              hoverActionLabel={added ? '已添加' : '添加到队列'}
              onHoverAction={() => add(songToUpsertItem(song))}
            />
          )
        })}
      </div>
    </div>
  )
}
