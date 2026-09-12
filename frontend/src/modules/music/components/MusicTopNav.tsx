/**
 * 顶部导航（Hydrogen Home.vue header 范式）。
 *
 * 结构：左搜索框（含联想下拉，外层定宽 224px 与右区对称） + 中导航链接组
 * （flex-1 居中） + 右账户菜单（定宽 224px）
 * - 搜索框（项目玻璃拟态语言）：glass 半透明底 + 主题模糊度 + 圆角描边，
 *   聚焦加宽并高亮描边；聚焦空输入展示热搜榜（/search/hot/detail，单次
 *   缓存），输入 220ms 防抖后并发三源建议合并去重（/search/suggest
 *   mobile + /search/suggest/pc + web，条目数 = 设置「搜索下拉条目数量」）；
 *   键盘 ↑↓ 循环高亮、Enter 选中高亮项或直接搜索，中文输入法组合态忽略；
 *   点击建议 → 写入关键词并跳搜索页；回车 → page='search' 并存关键词
 * - 导航链接：首页/私人漫游/云盘/我的音乐；当前页 on-surface、
 *   其余 on-surface-variant/60，20px font-medium，间距 clamp(18px,3vw,40px)，
 *   hover opacity-0.7
 * - 账户菜单（玻璃拟态 glass-card）：半透明底 + 主题模糊度 backdrop-filter +
 *   细描边 + 四角点装饰；账号信息行（头像+昵称）→ 分隔线 → 房间模式分组
 *   （一起看/投屏/一起听，当前项实心方块指示，房主可切换、观众只读展示）→
 *   分隔线 → 设置 → 退出登录 / 账号登录；房主未登录时底部
 *   追加「登录网易云后全房间可播 VIP」辅助提示
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { User } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { useMusicStore } from '../store'
import { useMusicSettingsStore } from '../store-settings'
import type { MusicPage } from '../store'
import { useRoomStore, type RoomMode } from '@/store/roomStore'
import {
  MODE_LABELS,
  MODE_ORDER,
} from '@/modules/room/components/useRoomModeSwitch'
import { cn } from '@/lib/utils'

/** 菜单内「房间模式」分组的注入状态（由 MusicAppShell 透传） */
export interface RoomModeMenuState {
  /** 房主可切换模式；观众只读展示当前模式 */
  isHost: boolean
  /** 模式切换回调（页面级 useRoomModeSwitch 提供） */
  onSwitch?: (mode: RoomMode) => void
  /** 切换进行中：模式选项禁用 */
  isSwitching?: boolean
}

export interface MusicTopNavProps {
  /** 是否为房主（房主侧菜单显示「登录网易云后全房间可播 VIP」提示） */
  isHost: boolean
  /** 房间模式切换分组（房间内提供；独立音乐页不传则隐藏该分组） */
  roomModeMenu?: RoomModeMenuState
}

/** 菜单内房间模式项的实心方块指示尺寸（Hydrogen 选中标记语言） */
const MODE_MARKER = 'h-1 w-1'

/** app-option 菜单四角白点位置（Hydrogen option-style 装饰） */
const CORNER_DOTS = [
  'left-1 top-1',
  'right-1 top-1',
  'right-1 bottom-1',
  'left-1 bottom-1',
] as const

/** 导航链接定义（顺序与 Hydrogen primary-nav + header-router-right 一致） */
const NAV_ITEMS: Array<{ key: MusicPage; label: string }> = [
  { key: 'home', label: '首页' },
  { key: 'fm', label: '私人漫游' },
  { key: 'cloud', label: '云盘' },
  { key: 'mymusic', label: '我的音乐' },
]

/** 下拉面板四角框线（Hydrogen .assist-corner1~4：7px 见方、1px 边） */
const PANEL_CORNERS = [
  'left-[3px] top-[3px] border-l border-t',
  'right-[3px] top-[3px] border-r border-t',
  'right-[3px] bottom-[3px] border-r border-b',
  'left-[3px] bottom-[3px] border-l border-b',
] as const

export function MusicTopNav({ isHost, roomModeMenu }: MusicTopNavProps) {
  const page = useMusicStore((s) => s.page)
  const setPage = useMusicStore((s) => s.setPage)
  const setSearchKeywords = useMusicStore((s) => s.setSearchKeywords)
  const setLoginModalOpen = useMusicStore((s) => s.setLoginModalOpen)
  const loginStatus = useMusicStore((s) => s.loginStatus)
  /** 当前房间模式（菜单内「房间模式」分组展示/切换） */
  const roomMode = useRoomStore((s) => s.mode)

  /** 菜单内切换房间模式（房主；观众项只读） */
  const handleMenuModeSwitch = (mode: RoomMode) => {
    if (!roomModeMenu?.isHost || roomModeMenu.isSwitching) return
    setMenuOpen(false)
    if (mode === roomMode) return
    roomModeMenu.onSwitch?.(mode)
  }

  /** 搜索框本地输入（回车才写入 store，避免每次击键切页） */
  const [keyword, setKeyword] = useState('')
  /** 账户菜单展开态 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** 搜索联想条数上限（设置「搜索下拉条目数量」；Hydrogen searchAssistLimit 同名配置） */
  const searchAssistLimit = useMusicSettingsStore((s) => s.searchAssistLimit)
  /** 聚焦态（驱动容器加宽动画，Hydrogen searchShow 同语义） */
  const [focused, setFocused] = useState(false)
  /** 悬停可见态：默认隐藏，鼠标移入左侧悬停区才显示搜索框 */
  const [searchVisible, setSearchVisible] = useState(false)
  /** 下拉条目（热榜/建议共用关键词列表） */
  const [assistItems, setAssistItems] = useState<string[]>([])
  /** 面板模式：空输入 = 热搜榜 / 有输入 = 建议（Hydrogen currentTitle 数据源） */
  const [assistMode, setAssistMode] = useState<'hot' | 'suggest'>('hot')
  const [assistLoading, setAssistLoading] = useState(false)
  /** 键盘/鼠标共用的高亮条目下标（-1 无） */
  const [activeIndex, setActiveIndex] = useState(-1)
  /** 中文输入法组合态（期间忽略方向键/回车） */
  const [isComposing, setIsComposing] = useState(false)
  /** 热榜单次加载缓存（Hydrogen hotLoaded 同语义，不重复请求） */
  const hotCacheRef = useRef<string[] | null>(null)
  /** 建议请求竞态序号（过期响应丢弃） */
  const requestSeqRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const assistBodyRef = useRef<HTMLDivElement | null>(null)

  // 账户菜单打开时点击外部关闭（透明捕获层，同 Hydrogen app-option 交互）
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])

  /** 热搜榜拉取（Hydrogen fetchHotList：/search/hot/detail，单次缓存） */
  const loadHotList = useCallback(async () => {
    if (hotCacheRef.current) {
      setAssistMode('hot')
      setAssistItems(hotCacheRef.current.slice(0, searchAssistLimit))
      setAssistLoading(false)
      return
    }
    setAssistLoading(true)
    try {
      const { data } = await apiGet<{
        data?: Array<{ searchWord?: string }>
      }>(`/api/music/ncm/search/hot/detail?timestamp=${Date.now()}`)
      const words = (Array.isArray(data?.data) ? data.data : [])
        .map((item) =>
          typeof item.searchWord === 'string' ? item.searchWord.trim() : ''
        )
        .filter(Boolean)
      hotCacheRef.current = words
      setAssistItems(words.slice(0, searchAssistLimit))
      setAssistMode('hot')
    } catch {
      setAssistItems([])
    } finally {
      setAssistLoading(false)
    }
  }, [searchAssistLimit])

  /** 建议三源并发合并（Hydrogen fetchSuggestList：mobile → pc → web 顺序去重） */
  const loadSuggestList = useCallback(
    async (kw: string) => {
      const seq = ++requestSeqRef.current
      setAssistLoading(true)
      const encoded = encodeURIComponent(kw)
      const [mobile, pc, web] = await Promise.allSettled([
        apiGet<{ result?: { allMatch?: Array<{ keyword?: string }> } }>(
          `/api/music/ncm/search/suggest?keywords=${encoded}&type=mobile&timestamp=${Date.now()}`
        ),
        apiGet<{ data?: { suggests?: Array<{ keyword?: string }> } }>(
          `/api/music/ncm/search/suggest/pc?keyword=${encoded}&timestamp=${Date.now()}`
        ),
        apiGet<{ result?: { allMatch?: Array<{ keyword?: string }> } }>(
          `/api/music/ncm/search/suggest?keywords=${encoded}&type=web&timestamp=${Date.now()}`
        ),
      ])
      // 竞态保护：只接受最新一次请求的结果
      if (seq !== requestSeqRef.current) return
      const merged: string[] = []
      const seen = new Set<string>()
      const push = (item: { keyword?: string } | undefined) => {
        const word = item?.keyword?.trim()
        if (!word || merged.length >= searchAssistLimit) return
        const key = word.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        merged.push(word)
      }
      if (mobile.status === 'fulfilled')
        (mobile.value.data?.result?.allMatch ?? []).forEach(push)
      if (pc.status === 'fulfilled')
        (pc.value.data?.data?.suggests ?? []).forEach(push)
      if (web.status === 'fulfilled')
        (web.value.data?.result?.allMatch ?? []).forEach(push)
      setAssistItems(merged)
      setAssistMode('suggest')
      setAssistLoading(false)
    },
    [searchAssistLimit]
  )

  // 建议防抖：输入 220ms 后拉建议；清空输入即取消在途请求（Hydrogen
  // SUGGEST_DEBOUNCE_MS 同值；空输入回退热榜由 focus/onChange 处理）
  useEffect(() => {
    const kw = keyword.trim()
    if (!kw) {
      requestSeqRef.current++
      return
    }
    const timer = setTimeout(() => {
      void loadSuggestList(kw)
    }, 220)
    return () => clearTimeout(timer)
  }, [keyword, loadSuggestList])

  // 键盘高亮项滚动跟随（Hydrogen setActiveAssistIndex 的 scrollIntoView）
  useEffect(() => {
    if (activeIndex < 0) return
    assistBodyRef.current
      ?.querySelector<HTMLElement>(`[data-assist-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  /** 聚焦：展示面板；空输入拉热榜、有输入刷新建议 */
  const handleSearchFocus = () => {
    setFocused(true)
    setActiveIndex(-1)
    const kw = keyword.trim()
    if (kw) void loadSuggestList(kw)
    else void loadHotList()
  }

  /** 失焦：收起面板与高亮；鼠标已划出悬停区则一并隐藏搜索框 */
  const handleSearchBlur = () => {
    setFocused(false)
    setActiveIndex(-1)
    setSearchVisible(false)
  }

  /** 执行搜索：写入关键词并跳搜索页（Hydrogen searchInfo 同语义） */
  const runSearch = (kw: string) => {
    const value = kw.trim()
    if (!value) return
    setKeyword(value)
    setSearchKeywords(value)
    setPage('search')
    searchInputRef.current?.blur()
  }

  /** 键盘导航：↑↓ 循环高亮，Enter 选中高亮项或直接搜索；输入法组合态忽略 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposing || e.nativeEvent.isComposing) return
    const count = assistItems.length
    if (e.key === 'ArrowDown' && count > 0) {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % count)
    } else if (e.key === 'ArrowUp' && count > 0) {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + count) % count)
    } else if (e.key === 'Enter') {
      const target =
        activeIndex >= 0 && activeIndex < count
          ? assistItems[activeIndex]
          : keyword
      runSearch(target)
    }
  }

  return (
    <header className="flex shrink-0 items-center gap-4 px-6 pt-4 pb-2 md:px-8">
      {/* ===== 左：搜索框（项目玻璃拟态语言）：glass 底 + 主题模糊度 +
          圆角描边，聚焦 220→260px 加宽；居中输入。默认隐藏，鼠标移入
          悬停区（w-56 定宽与右区对称，保证中间导航组真正水平居中）才
          淡入显示。下拉面板（热榜/建议）毛玻璃 + 四角框线 + 序号条目 ===== */}
      <div
        className="group relative h-10 w-56 shrink-0"
        onMouseEnter={() => setSearchVisible(true)}
        onMouseLeave={() => {
          // 未聚焦（或已失焦）时才收起，避免鼠标短暂划出打断输入
          if (
            !searchInputRef.current ||
            document.activeElement !== searchInputRef.current
          ) {
            setSearchVisible(false)
          }
        }}
      >
        <div
          className={cn(
            'glass absolute left-0 top-1/2 flex h-9 -translate-y-1/2 items-center overflow-hidden transition-[width,border-color,opacity] duration-300 ease-[cubic-bezier(0.24,0.97,0.59,1)]',
            focused ? 'w-[260px]' : 'w-[220px]',
            !searchVisible && 'pointer-events-none opacity-0'
          )}
          style={{
            borderRadius: 'calc(var(--md-sys-shape-corner) / 2)',
            borderColor: focused
              ? 'var(--md-sys-color-primary)'
              : 'var(--glass-border)',
          }}
        >
          <input
            ref={searchInputRef}
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              // 清空输入时立即回退热榜（Hydrogen handleSearchInput 同语义）
              if (!e.target.value.trim()) {
                requestSeqRef.current++
                if (focused) void loadHotList()
              }
            }}
            onKeyDown={handleSearchKeyDown}
            onFocus={handleSearchFocus}
            onBlur={handleSearchBlur}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            placeholder="SEARCH"
            aria-label="搜索音乐"
            spellCheck={false}
            className="h-full w-full bg-transparent px-[10px] text-center text-[13px] font-bold outline-none placeholder:text-[11px] placeholder:font-normal placeholder:tracking-[2px]"
            style={{
              color: 'var(--md-sys-color-on-surface)',
              caretColor: 'var(--md-sys-color-on-surface)',
            }}
          />
        </div>

        {/* 搜索辅助面板（Hydrogen .search-assist：热榜/建议） */}
        {focused && (
          <div
            className="zen-dropdown-enter absolute left-0 top-[34px] z-[2001] w-[260px] px-3 pb-2 pt-[10px]"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-surface-container) 82%, transparent)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border:
                '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 70%, transparent)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
            }}
          >
            {/* 面板四角框线（Hydrogen .assist-corner1~4） */}
            {PANEL_CORNERS.map((pos) => (
              <span
                key={`panel-corner-${pos}`}
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute h-[7px] w-[7px]',
                  pos
                )}
                style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
              />
            ))}
            {/* 头部：标题 + [数量] + 分隔线（Hydrogen .assist-header） */}
            <div className="flex items-center gap-1">
              <span
                className="font-mono text-[11px] font-bold tracking-[1.2px]"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                {assistMode === 'hot' ? 'HOT SEARCH' : 'SUGGESTIONS'}
              </span>
              {assistItems.length > 0 && (
                <span
                  className="font-mono text-[11px] tracking-[1px]"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  [{assistItems.length}]
                </span>
              )}
              <div
                className="ml-1 h-px flex-1"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 70%, transparent)',
                }}
              />
            </div>
            {/* 条目区（Hydrogen .assist-body） */}
            <div
              ref={assistBodyRef}
              className="mt-1 max-h-[300px] overflow-y-auto"
            >
              {assistLoading ? (
                <div
                  className="py-2 font-mono text-[10px] tracking-[1px]"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  LOADING...
                </div>
              ) : assistItems.length === 0 ? (
                <div
                  className="py-2 font-mono text-[10px] tracking-[1px]"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  {assistMode === 'hot' ? 'NO HOT SEARCH' : 'NO SUGGESTION'}
                </div>
              ) : (
                assistItems.map((word, index) => {
                  const active = index === activeIndex
                  return (
                    <button
                      key={`${word}-${index}`}
                      type="button"
                      data-assist-index={index}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runSearch(word)}
                      className="grid w-full grid-cols-[34px_1fr] items-center bg-no-repeat text-left"
                      style={{
                        minHeight: '32px',
                        backgroundImage:
                          'linear-gradient(90deg, color-mix(in srgb, var(--md-sys-color-on-surface) 92%, transparent) 0%, color-mix(in srgb, var(--md-sys-color-on-surface) 92%, transparent) 100%)',
                        backgroundSize: active ? '100% 100%' : '0% 100%',
                        transition:
                          'background-size .68s cubic-bezier(0.08, 0.88, 0.18, 1), color .28s ease',
                      }}
                    >
                      <span
                        className="px-2 text-right font-mono text-[10px] tracking-[1px]"
                        style={{
                          color: active
                            ? 'var(--md-sys-color-surface)'
                            : 'var(--md-sys-color-on-surface-variant)',
                        }}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span
                        className="min-w-0 truncate pr-3 text-[13px] font-bold"
                        style={{
                          color: active
                            ? 'var(--md-sys-color-surface)'
                            : 'var(--md-sys-color-on-surface)',
                        }}
                      >
                        {word}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* ===== 中：导航链接组 ===== */}
      <nav
        className="flex min-w-0 flex-1 items-center justify-center gap-[clamp(18px,3vw,40px)]"
        aria-label="音乐页面导航"
      >
        {NAV_ITEMS.map((item) => {
          const active = page === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setPage(item.key)}
              className={cn(
                'shrink-0 text-xl font-medium transition-opacity hover:opacity-70',
                active ? 'opacity-100' : 'opacity-60'
              )}
              style={{
                color: active
                  ? 'var(--md-sys-color-on-surface)'
                  : 'var(--md-sys-color-on-surface-variant)',
              }}
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* ===== 右：账户菜单（房间模式切换已收入菜单内分组）；定宽 224px
          与左区搜索框对称，头像靠右对齐，保证中间导航组真正水平居中 ===== */}
      <div className="relative flex w-56 shrink-0 items-center justify-end">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full transition-opacity hover:opacity-80"
          style={{
            border:
              '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
          }}
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-label={loginStatus.loggedIn ? '账号菜单' : '账号登录'}
          title={loginStatus.loggedIn ? '账号菜单' : '账号登录'}
        >
          {loginStatus.loggedIn && loginStatus.avatarUrl ? (
            <img
              src={loginStatus.avatarUrl}
              alt={loginStatus.nickname ?? '网易云账号'}
              className="h-full w-full object-cover"
            />
          ) : (
            <User
              className="h-5 w-5 translate-y-[1px]"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            />
          )}
        </button>

        {/* app-option 菜单（玻璃拟态 glass-card + 四角点装饰）：
            账号信息行 → 房间模式分组 → 设置 → 退出登录/账号登录 */}
        {menuOpen && (
          <div
            className="zen-dropdown-enter glass-card absolute right-0 top-11 z-[2001] w-[168px] origin-top-right"
            style={{ boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)' }}
            role="menu"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* 四角点装饰（Hydrogen option-style 标志元素） */}
            {CORNER_DOTS.map((pos) => (
              <span
                key={pos}
                className={cn('absolute h-1 w-1', pos)}
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 65%, transparent)',
                }}
                aria-hidden="true"
              />
            ))}
            <div className="py-2">
              {/* 账号信息行（头像 + 昵称，非操作项） */}
              <div
                className="flex items-center gap-2 px-3.5 pb-2 pt-1"
                title={loginStatus.nickname ?? '未登录'}
              >
                {loginStatus.loggedIn && loginStatus.avatarUrl ? (
                  <img
                    src={loginStatus.avatarUrl}
                    alt={loginStatus.nickname ?? '网易云账号'}
                    className="h-[22px] w-[22px] shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <User
                    className="h-4 w-4 shrink-0"
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                  />
                )}
                <span
                  className="min-w-0 flex-1 truncate text-xs font-medium"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                >
                  {loginStatus.loggedIn
                    ? (loginStatus.nickname ?? '已登录')
                    : '未登录'}
                </span>
              </div>
              <div
                className="mx-2 my-1 h-px"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 14%, transparent)',
                }}
              />

              {/* 房间模式分组（房间内提供 roomModeMenu 时渲染） */}
              {roomModeMenu && (
                <>
                  <div
                    className="px-3.5 pb-1 text-[10px] font-medium tracking-wide"
                    style={{
                      color:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 60%, transparent)',
                    }}
                  >
                    房间模式
                  </div>
                  {roomModeMenu.isHost ? (
                    MODE_ORDER.map((m) => {
                      const active = m === roomMode
                      return (
                        <button
                          key={m}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          disabled={roomModeMenu.isSwitching}
                          onClick={() => handleMenuModeSwitch(m)}
                          className={cn(
                            'flex h-8 w-full items-center gap-2 px-3.5 text-left text-xs font-medium transition-colors',
                            !active &&
                              'hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]',
                            roomModeMenu.isSwitching &&
                              'cursor-not-allowed opacity-60'
                          )}
                          style={{
                            color: active
                              ? 'var(--md-sys-color-on-surface)'
                              : 'color-mix(in srgb, var(--md-sys-color-on-surface) 62%, transparent)',
                          }}
                        >
                          {/* 当前模式实心小方块指示（Hydrogen 选中标记语言） */}
                          <span
                            className={cn(MODE_MARKER, 'shrink-0')}
                            style={{
                              backgroundColor: active
                                ? 'var(--md-sys-color-on-surface)'
                                : 'transparent',
                            }}
                            aria-hidden="true"
                          />
                          <span className="flex-1 truncate">
                            {MODE_LABELS[m]}
                          </span>
                        </button>
                      )
                    })
                  ) : (
                    <div
                      className="flex h-8 items-center gap-2 px-3.5 text-xs font-medium"
                      style={{
                        color:
                          'color-mix(in srgb, var(--md-sys-color-on-surface) 80%, transparent)',
                      }}
                      title="由房主控制模式切换"
                    >
                      <span
                        className={cn(MODE_MARKER, 'shrink-0')}
                        style={{
                          backgroundColor: 'var(--md-sys-color-on-surface)',
                        }}
                        aria-hidden="true"
                      />
                      <span className="flex-1 truncate">
                        {MODE_LABELS[roomMode]}
                      </span>
                    </div>
                  )}
                  <div
                    className="mx-2 my-1 h-px"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 14%, transparent)',
                    }}
                  />
                </>
              )}

              {/* 设置（Hydrogen app-option 菜单同名入口） */}
              <button
                type="button"
                className="flex h-8 w-full items-center px-3.5 text-left text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                onClick={() => {
                  setMenuOpen(false)
                  setPage('settings')
                }}
              >
                设置
              </button>
              {/* 退出登录 / 账号登录 */}
              {loginStatus.loggedIn ? (
                <button
                  type="button"
                  className="flex h-8 w-full items-center px-3.5 text-left text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  onClick={() => {
                    setMenuOpen(false)
                    // 退出登录：删除后端持久化凭证并清空本地登录态
                    void apiPost('/api/music/logout').catch(() => {
                      // 网络失败也清空本地态（与 useNcmLogin.logout 行为一致）
                    })
                    useMusicStore.getState().setLoginStatus({ loggedIn: false })
                  }}
                >
                  退出登录
                </button>
              ) : (
                <button
                  type="button"
                  className="flex h-8 w-full items-center px-3.5 text-left text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  onClick={() => {
                    setMenuOpen(false)
                    setLoginModalOpen(true)
                  }}
                >
                  账号登录
                </button>
              )}
              {/* 仅房主可见辅助提示 */}
              {isHost && !loginStatus.loggedIn && (
                <div
                  className="px-3.5 pb-1 pt-1.5 text-[10px] leading-snug"
                  style={{
                    color:
                      'color-mix(in srgb, var(--md-sys-color-on-surface) 55%, transparent)',
                  }}
                >
                  登录网易云后全房间可播 VIP
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
