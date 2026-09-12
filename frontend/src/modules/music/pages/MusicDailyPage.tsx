/**
 * 每日推荐面板（Hydrogen RecommendSongs.vue 一比一复刻；Hydrogen 的
 * /mymusic/playlist/rec 在 ZViewer 中作为「我的音乐」详情区面板：
 * 见 MusicMyPage 的 rec 详情分支，主页每日推荐卡片跳转打开）。
 *
 * 结构复刻：
 * - 头部：h1「每日推荐歌曲」+ 副标「根据你的音乐口味生成，每天6:00更新」
 *   + 日期下拉（.zrec-date-picker：触发钮 + 绝对定位下拉；键盘导航
 *   ArrowUp/Down/Enter/Space/Escape/Tab，点击外部关闭，选项反色高亮
 *   用 background-position 滑动法）+「播放全部」按钮（::after 中心向
 *   两侧扩展填充）+ 加载态文字
 * - 列表：SongRow（LibrarySongList 范式：hover 序号列播放按钮单击
 *   togglePlay/play，双击行播放，当前行 EQ 频谱）
 *
 * 播放逻辑复刻（Hydrogen play / playAll 的 ZViewer 范式映射）：
 * - 单首歌（hover 播放按钮 / 双击行）：若是当前播放曲目则 togglePlay
 *   暂停/恢复，否则 queue-upsert 入队 → playSong 立即播放
 * - 播放全部：addToList('rec') → addSong 首首 的 ZViewer 语义 =
 *   全量入队 → playSong 首首播放
 *
 * 数据（NRMAPI 端点，经后端 /api/music/ncm/* 通用转发）：
 * - 历史日期：GET /history/recommend/songs（data.dates）
 * - 历史内容：GET /history/recommend/songs/detail?date=（data.songs || dailySongs）
 * - 当日内容：GET /recommend/songs（data.dailySongs）
 * 当天 ≥6 点且历史列表缺今天时在日期下拉首位插入「今天」，Hydrogen 同款。
 * ZViewer 该页面为 store 驱动的多页切换（无独立路由），省略 ?date= 查询串同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import type { NcmSong } from '../types'
import { SongRow } from '../components/SongRow'
import { MusicLoginGate } from './MusicLoginGate'

export interface MusicDailyPanelProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** 通用日期条目（网易云响应的字段子集） */
interface CommonSongItem {
  id: number
  name: string
  ar?: Array<{ name?: string }>
  al?: { picUrl?: string; name?: string }
  dt?: number
  /** 0 免费 / 1 VIP / 4 购买专辑 / 8 低音质免费 */
  fee?: number
}

/** 通用响应（data.dates / data.songs / data.dailySongs 容错） */
interface RecResponse {
  data?: {
    dates?: string[]
    dateList?: string[]
    songs?: CommonSongItem[]
    dailySongs?: CommonSongItem[]
  }
}

/** 网易云歌曲 → NcmSong */
function mapSong(song: CommonSongItem): NcmSong {
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

/** 日期下拉交互与反色高亮样式（Hydrogen RecommendSongs scoped SCSS 平替，
    类名前缀 zrec 避免污染全局） */
const REC_STYLE = `
.zrec-container {
  --rec-text: var(--md-sys-color-on-surface);
  --rec-muted: var(--md-sys-color-on-surface-variant);
  --rec-border: var(--md-sys-color-outline-variant);
  --rec-select-bg: rgba(255, 255, 255, 0.35);
  --rec-select-dropdown-bg: #e4f0f0;
  --rec-select-text: #000000;
  --rec-select-active-bg: #000000;
  --rec-select-active-text: #ffffff;
}
html.dark .zrec-container {
  --rec-select-bg: #000000;
  --rec-select-dropdown-bg: #000000;
  --rec-select-text: #ffffff;
  --rec-select-active-bg: #ffffff;
  --rec-select-active-text: #000000;
}
.zrec-container h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  color: var(--rec-text);
}
.zrec-subtitle {
  margin-top: 4px;
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: var(--rec-text);
}
.zrec-option-date {
  margin-top: 16px;
  margin-bottom: 10px;
}
.zrec-option-action {
  margin-bottom: 20px;
}
.zrec-play-all {
  position: relative;
  z-index: 0;
  padding: 8px 10px;
  border: none;
  outline: none;
  box-shadow: none;
  background: transparent;
  color: var(--rec-text);
  font-size: 16px;
  font-weight: 700;
  transition: 0.1s;
  -webkit-appearance: none;
  appearance: none;
}
.zrec-play-all::after {
  content: '';
  width: 0;
  height: 100%;
  background-color: var(--rec-text);
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  transition: 0.2s;
  z-index: -1;
  opacity: 0;
}
.zrec-play-all:hover {
  cursor: pointer;
  color: var(--md-sys-color-surface);
}
.zrec-play-all:hover::after {
  width: 100%;
  opacity: 1;
}
.zrec-date-picker {
  display: inline-block;
  position: relative;
  min-width: 220px;
  font-size: 14px;
  font-weight: 700;
}
.zrec-date-trigger {
  width: 100%;
  min-width: 220px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--rec-border);
  background-color: var(--rec-select-bg);
  font-size: 13px;
  font-weight: 700;
  color: var(--rec-select-text);
  outline: none;
  border-radius: 0;
  box-shadow: none;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  transition: border-color 0.16s ease;
  -webkit-appearance: none;
  appearance: none;
}
.zrec-date-trigger:focus,
.zrec-date-trigger:focus-visible {
  border-color: var(--rec-text);
}
.zrec-date-trigger.is-open {
  border-color: var(--rec-text);
}
.zrec-date-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.zrec-date-trigger-label {
  flex: 1 1 auto;
  min-width: 0;
  text-align: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: inherit;
}
.zrec-date-trigger-arrow {
  flex: 0 0 auto;
  transition: transform 0.2s ease;
  color: inherit;
}
.zrec-date-trigger.is-open .zrec-date-trigger-arrow {
  transform: rotate(180deg);
}
.zrec-date-dropdown {
  width: 100%;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--rec-border);
  border-top: none;
  background-color: var(--rec-select-dropdown-bg);
  position: absolute;
  left: 0;
  top: calc(100% + 1px);
  z-index: 5;
  border-radius: 0;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.15);
}
.zrec-date-option {
  width: 100%;
  min-height: 34px;
  border: none;
  padding: 0 10px;
  background-color: var(--rec-select-dropdown-bg);
  background-image: linear-gradient(90deg, var(--rec-select-active-bg), var(--rec-select-active-bg));
  background-repeat: repeat-y;
  background-position: -220px 0;
  color: var(--rec-select-text);
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  outline: none;
  border-radius: 0;
  box-shadow: none;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  transition: background-position 0.2s, color 0.2s;
  -webkit-appearance: none;
  appearance: none;
}
.zrec-date-option:hover,
.zrec-date-option:focus-visible,
.zrec-date-option.is-active,
.zrec-date-option.is-selected {
  background-position: 0 0;
  color: var(--rec-select-active-text);
}
.zrec-date-enter-active,
.zrec-date-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
  transform-origin: top;
}
.zrec-date-enter-from,
.zrec-date-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.zrec-status {
  margin-top: 6px;
  margin-bottom: 14px;
  display: block;
  font-size: 13px;
  font-weight: 700;
  color: var(--rec-muted);
}
`

/** 每日推荐内容面板（嵌入「我的音乐」右侧详情区；
    Hydrogen 路由 /mymusic/playlist/rec 的等价形态） */
export function MusicDailyPanel({
  socket,
  roomId,
  canManage,
}: MusicDailyPanelProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)
  const currentKey = useMusicStore((s) => s.currentKey)
  const { add } = useQueueAdd(socket, roomId, canManage)
  const { playSong, togglePlay, canControl } = useMusicPlayer()

  const [historyDates, setHistoryDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [loadingDates, setLoadingDates] = useState(false)
  const [loadingSongs, setLoadingSongs] = useState(false)
  const [songs, setSongs] = useState<NcmSong[]>([])
  const [dateDropdownOpen, setDateDropdownOpen] = useState(false)
  const [activeOptionIndex, setActiveOptionIndex] = useState(-1)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const dateOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const initialized = useRef(false)

  // ===== 日期选项（Hydrogen computed 同款：当天≥6 点且历史缺今天时插入「今天」） =====
  const todayDate = (() => {
    const now = new Date()
    const month = `${now.getMonth() + 1}`.padStart(2, '0')
    const day = `${now.getDate()}`.padStart(2, '0')
    return `${now.getFullYear()}-${month}-${day}`
  })()
  const reachedDailyUpdateTime = new Date().getHours() >= 6
  const shouldInsertTodayOption =
    reachedDailyUpdateTime && !historyDates.includes(todayDate)
  const dateOptions = shouldInsertTodayOption
    ? [todayDate, ...historyDates]
    : historyDates
  const dateDropdownDisabled =
    loadingDates || loadingSongs || dateOptions.length === 0

  /** 日期显示文案（今天 (YYYY-MM-DD) / 原始日期） */
  const formatDateLabel = (date: string) =>
    date === todayDate ? `今天 (${date})` : date

  const selectedDateLabel = !dateOptions.length
    ? '暂无可选日期'
    : !selectedDate
      ? '请选择日期'
      : formatDateLabel(selectedDate)

  const getDateOptionId = (date: string) =>
    `zrec-date-option-${date.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  const getDateIndex = (date: string) => dateOptions.indexOf(date)

  // ===== 下拉开合（Hydrogen openDateDropdown / scrollIntoView 同款） =====
  const scrollActiveOptionIntoView = () => {
    const opt = dateOptionRefs.current[activeOptionIndex]
    opt?.scrollIntoView({ block: 'nearest' })
  }

  const openDateDropdown = () => {
    if (dateDropdownDisabled) return
    setDateDropdownOpen(true)
    const idx = getDateIndex(selectedDate)
    setActiveOptionIndex(idx >= 0 ? idx : 0)
    requestAnimationFrame(scrollActiveOptionIntoView)
  }

  const closeDateDropdown = () => setDateDropdownOpen(false)

  const toggleDateDropdown = () =>
    dateDropdownOpen ? closeDateDropdown() : openDateDropdown()

  const selectDateOption = (date: string) => {
    if (!dateOptions.includes(date) || dateDropdownDisabled) return
    setSelectedDate(date)
    setActiveOptionIndex(getDateIndex(date))
    closeDateDropdown()
  }

  // 点击外部关闭（Hydrogen handleClickOutside 同款）
  useEffect(() => {
    if (!dateDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        closeDateDropdown()
      }
    }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [dateDropdownOpen])

  // 键盘导航（Hydrogen handleDateDropdownKeydown 同款）
  const handleDateDropdownKeydown = (e: React.KeyboardEvent) => {
    const options = dateOptions
    if (dateDropdownDisabled || !options.length) return
    if (e.key === 'Tab') {
      closeDateDropdown()
      return
    }
    if (e.key === 'Escape') {
      if (!dateDropdownOpen) return
      e.preventDefault()
      closeDateDropdown()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!dateDropdownOpen) {
        openDateDropdown()
        return
      }
      const next =
        activeOptionIndex + 1 >= options.length ? 0 : activeOptionIndex + 1
      setActiveOptionIndex(next)
      requestAnimationFrame(() =>
        dateOptionRefs.current[next]?.scrollIntoView({ block: 'nearest' })
      )
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!dateDropdownOpen) {
        openDateDropdown()
        return
      }
      const next =
        activeOptionIndex - 1 < 0 ? options.length - 1 : activeOptionIndex - 1
      setActiveOptionIndex(next)
      requestAnimationFrame(() =>
        dateOptionRefs.current[next]?.scrollIntoView({ block: 'nearest' })
      )
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!dateDropdownOpen) {
        openDateDropdown()
        return
      }
      const target = options[activeOptionIndex] || options[0]
      if (target) selectDateOption(target)
    }
  }

  // ===== 数据加载 =====
  /** 按日期加载日推（Hydrogen updateRecommendSongs 等价：今天走 /recommend/songs，
      历史走 /history/recommend/songs/detail，字段 data.songs || dailySongs） */
  const loadRecommendSongs = useCallback(async (date: string) => {
    if (!date) {
      setSongs([])
      return
    }
    setLoadingSongs(true)
    try {
      let list: CommonSongItem[]
      if (date === todayDate && shouldInsertTodayOption) {
        const res = await apiGet<RecResponse>('/api/music/ncm/recommend/songs')
        list = res.data?.data?.dailySongs ?? []
      } else {
        const res = await apiGet<RecResponse>(
          `/api/music/ncm/history/recommend/songs/detail?date=${date}`
        )
        list = res.data?.data?.songs ?? res.data?.data?.dailySongs ?? []
      }
      setSongs(list.map(mapSong))
    } catch (err) {
      console.error('[MusicDailyPage] 获取推荐歌曲失败:', err)
      setSongs([])
      message.error('获取推荐歌曲失败')
    } finally {
      setLoadingSongs(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 与 Hydrogen watch(selectedDate) 同语义，随日期刷新
  }, [])

  // 拉取历史日推日期列表（Hydrogen loadHistoryDates 同款：去重降序）
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，loading 置位与请求同步发起
    setLoadingDates(true)
    void (async () => {
      try {
        const res = await apiGet<RecResponse>(
          '/api/music/ncm/history/recommend/songs'
        )
        const source = res.data?.data?.dates ?? res.data?.data?.dateList ?? []
        if (cancelled) return
        const list = Array.isArray(source)
          ? Array.from(
              new Set(source.filter((d) => typeof d === 'string'))
            ).sort((a, b) => b.localeCompare(a))
          : []
        setHistoryDates(list)
        if (list.length > 0) setSelectedDate((prev) => prev || list[0])
      } catch (err) {
        console.error('[MusicDailyPage] 获取历史日推日期失败:', err)
        if (!cancelled) message.error('获取历史日推日期失败')
      } finally {
        if (!cancelled) setLoadingDates(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loginStatus.loggedIn])

  // 选中日期变化 → 加载对应内容（console 与 Hydrogen watch(selectedDate) 语义一致）
  useEffect(() => {
    if (!initialized.current) return
    void loadRecommendSongs(selectedDate)
  }, [selectedDate, loadRecommendSongs])

  useEffect(() => {
    if (loginStatus.loggedIn && selectedDate) {
      initialized.current = true
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，与 Hydrogen watch 语义一致
      void loadRecommendSongs(selectedDate)
    }
  }, [loginStatus.loggedIn, selectedDate, loadRecommendSongs])

  // ===== 播放逻辑（Hydrogen LibrarySongList play 同范式） =====
  /** 播放指定曲目：当前曲目则 togglePlay；否则入队后立即播放
      （shouldBlockRestrictedPlayback VIP 拦截语义） */
  const handlePlayRow = (song: NcmSong) => {
    if (song.vip && !loginStatus.loggedIn) {
      message.info('VIP 歌曲需登录后播放')
      return
    }
    if (`ncm:${song.songId}` === currentKey) {
      if (canControl) togglePlay()
      else message.info('由房主控制播放')
      return
    }
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
  }

  /** 播放全部（Hydrogen playAll('rec') 的 ZViewer 语义：全量入队 → 首首播放） */
  const handlePlayAll = () => {
    if (!canManage) {
      message.info('仅房主 / 房管可添加队列')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }
    if (songs.length === 0) return
    songs.forEach((s) => add(songToUpsertItem(s)))
    handlePlayRow(songs[0])
  }

  if (!loginStatus.loggedIn) {
    return (
      <div className="zrec-container flex min-w-0 flex-1 flex-col">
        <h1>每日推荐歌曲</h1>
        <span className="zrec-subtitle">
          根据你的音乐口味生成，每天6:00更新
        </span>
        <MusicLoginGate hint="登录后查看专属每日推荐歌曲" />
      </div>
    )
  }

  return (
    <div className="zrec-container flex min-w-0 flex-1 flex-col">
      <style>{REC_STYLE}</style>
      {/* ===== 头部（Hydrogen .rec-header 结构） ===== */}
      <h1>每日推荐歌曲</h1>
      <span className="zrec-subtitle">根据你的音乐口味生成，每天6:00更新</span>

      {/* 日期下拉（Hydrogen .rec-date-picker） */}
      <div className="zrec-option-date">
        <div
          ref={dropdownRef}
          className="zrec-date-picker"
          onKeyDown={handleDateDropdownKeydown}
        >
          <button
            type="button"
            className={`zrec-date-trigger${dateDropdownOpen ? ' is-open' : ''}`}
            disabled={dateDropdownDisabled}
            aria-haspopup="listbox"
            aria-expanded={dateDropdownOpen ? 'true' : 'false'}
            onClick={toggleDateDropdown}
          >
            <span className="zrec-date-trigger-label">{selectedDateLabel}</span>
            <span className="zrec-date-trigger-arrow" aria-hidden="true">
              ▾
            </span>
          </button>
          {dateDropdownOpen && (
            <div
              className="zrec-date-dropdown zrec-date-enter-active"
              role="listbox"
              aria-activedescendant={
                dateOptions[activeOptionIndex]
                  ? getDateOptionId(dateOptions[activeOptionIndex])
                  : undefined
              }
            >
              {dateOptions.map((date, index) => (
                <button
                  key={date}
                  id={getDateOptionId(date)}
                  ref={(el) => {
                    dateOptionRefs.current[index] = el
                  }}
                  type="button"
                  role="option"
                  aria-selected={date === selectedDate ? 'true' : 'false'}
                  className={`zrec-date-option${
                    index === activeOptionIndex ? ' is-active' : ''
                  }${date === selectedDate ? ' is-selected' : ''}`}
                  onMouseEnter={() => setActiveOptionIndex(index)}
                  onClick={() => selectDateOption(date)}
                >
                  {formatDateLabel(date)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 播放全部（Hydrogen .play-all，中心扩展填充 hover） */}
      <div className="zrec-option-action">
        <button type="button" className="zrec-play-all" onClick={handlePlayAll}>
          播放全部
        </button>
      </div>

      {/* 状态行（Hydrogen .rec-status） */}
      {loadingSongs && <span className="zrec-status">正在加载推荐歌曲...</span>}
      {!loadingSongs && !dateOptions.length && (
        <span className="zrec-status">暂无可用日推日期</span>
      )}

      {/* ===== 歌曲列表（LibrarySongList 范式：hover 播放 / 双击播放 / 当前行 EQ） ===== */}
      <div className="mt-2 flex min-h-[240px] flex-1 flex-col">
        {songs.map((song, idx) => (
          <SongRow
            key={song.songId}
            index={idx + 1}
            cover={song.cover}
            name={song.name}
            artist={song.artist}
            duration={formatDurationMs(song.durationMs)}
            vip={song.vip}
            disabled={song.vip && !loginStatus.loggedIn}
            active={`ncm:${song.songId}` === currentKey}
            onPlayNow={() => handlePlayRow(song)}
            onRowDoubleClick={() => handlePlayRow(song)}
            rowTitle="单击序号按钮播放，双击行播放"
          />
        ))}
        {!loadingSongs && songs.length === 0 && dateOptions.length > 0 && (
          <div className="flex flex-1 items-center justify-center py-12 text-sm text-[var(--md-sys-color-on-surface-variant)]">
            该日期没有推荐歌曲
          </div>
        )}
      </div>
    </div>
  )
}
