/**
 * 顶部导航（Hydrogen Home.vue header 范式）。
 *
 * 结构：左搜索框（含联想下拉） + 中导航链接组 + 右账户菜单
 * - 搜索框（widget-search 式）：描边圆角输入；输入时防抖 350ms 调
 *   /cloudsearch 拉取联想建议（条目数 = 设置「搜索下拉条目数量」），
 *   点击建议 → 写入关键词并跳搜索页；回车 → page='search' 并存关键词
 * - 导航链接：首页/私人漫游/云盘/我的音乐；当前页 on-surface、
 *   其余 on-surface-variant/60，20px font-medium，间距 clamp(18px,3vw,40px)，
 *   hover opacity-0.7
 * - 账户（app-option 范式）：已登录显示头像圆图，未登录显示 User 图标；
 *   点击弹出深色小菜单（M3 适配：on-surface 底 + surface 字 + 四角白点装饰），
 *   选项：账号信息（昵称）/ 设置 / 退出登录或账号登录 / 房主可见的 VIP 提示
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Search, User } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { useMusicStore } from '../store'
import { useMusicSettingsStore } from '../store-settings'
import type { MusicPage } from '../store'
import { cn } from '@/lib/utils'

export interface MusicTopNavProps {
  /** 是否为房主（房主侧菜单显示「登录网易云后全房间可播 VIP」提示） */
  isHost: boolean
  /** 右侧额外插槽（如房间模式切换滑块/标签）：渲染在账户按钮左侧 */
  modeSwitchSlot?: ReactNode
}

/** 导航链接定义（顺序与 Hydrogen primary-nav + header-router-right 一致） */
const NAV_ITEMS: Array<{ key: MusicPage; label: string }> = [
  { key: 'home', label: '首页' },
  { key: 'fm', label: '私人漫游' },
  { key: 'cloud', label: '云盘' },
  { key: 'mymusic', label: '我的音乐' },
]

/** app-option 菜单四角白点位置（Hydrogen option-style 装饰） */
const CORNER_DOTS = [
  'left-1 top-1',
  'right-1 top-1',
  'right-1 bottom-1',
  'left-1 bottom-1',
] as const

export function MusicTopNav({ isHost, modeSwitchSlot }: MusicTopNavProps) {
  const page = useMusicStore((s) => s.page)
  const setPage = useMusicStore((s) => s.setPage)
  const setSearchKeywords = useMusicStore((s) => s.setSearchKeywords)
  const setLoginModalOpen = useMusicStore((s) => s.setLoginModalOpen)
  const loginStatus = useMusicStore((s) => s.loginStatus)

  /** 搜索框本地输入（回车才写入 store，避免每次击键切页） */
  const [keyword, setKeyword] = useState('')
  /** 账户菜单展开态 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** 搜索联想（设置：搜索下拉条目数量；Hydrogen search-assist） */
  const searchAssistLimit = useMusicSettingsStore((s) => s.searchAssistLimit)
  const [assistItems, setAssistItems] = useState<
    Array<{ id: number; name: string; artist: string }>
  >([])
  const [assistOpen, setAssistOpen] = useState(false)

  // 账户菜单打开时点击外部关闭（透明捕获层，同 Hydrogen app-option 交互）
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])

  // 搜索联想：输入防抖 350ms → /cloudsearch 联想建议（数量随设置）。
  // 空关键词的清空在 onChange 事件内完成（render 期/effect 体内不做同步 setState）
  useEffect(() => {
    let cancelled = false
    const kw = keyword.trim()
    if (!kw) return
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { data } = await apiGet<{
            result?: {
              songs?: Array<{
                id: number
                name: string
                artists?: Array<{ name?: string }>
              }>
            }
          }>(
            `/api/music/ncm/cloudsearch?keywords=${encodeURIComponent(kw)}&limit=${searchAssistLimit}`
          )
          if (cancelled) return
          const songs = Array.isArray(data?.result?.songs)
            ? data.result.songs
            : []
          setAssistItems(
            songs.slice(0, searchAssistLimit).map((s) => ({
              id: s.id,
              name: s.name,
              artist: (s.artists ?? [])
                .map((a) => a.name)
                .filter(Boolean)
                .join(' / '),
            }))
          )
          setAssistOpen(songs.length > 0)
        } catch {
          // 联想失败静默（不阻塞手动回车搜索）
        }
      })()
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [keyword, searchAssistLimit])

  /** 点击联想建议：写入关键词并跳搜索页 */
  const pickAssist = (name: string) => {
    setAssistOpen(false)
    setSearchKeywords(name)
    setPage('search')
  }

  /** 回车搜索：写入关键词并切到搜索页 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    const kw = keyword.trim()
    if (!kw) return
    setAssistOpen(false)
    setSearchKeywords(kw)
    setPage('search')
  }

  return (
    <header className="flex shrink-0 items-center gap-4 px-6 pt-4 pb-2 md:px-8">
      {/* ===== 左：搜索框（widget-search 式描边圆角输入 + 联想下拉） ===== */}
      <div className="relative shrink-0">
        <div
          className="flex h-9 w-56 items-center gap-1.5 rounded-full border px-3"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
            borderColor: 'var(--md-sys-color-outline-variant)',
          }}
        >
          <Search
            className="h-4 w-4 shrink-0"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              // 清空输入时同步收起联想（事件内 setState 合规）
              if (!e.target.value.trim()) {
                setAssistItems([])
                setAssistOpen(false)
              }
            }}
            onKeyDown={handleSearchKeyDown}
            onBlur={() => setAssistOpen(false)}
            placeholder="搜索音乐"
            aria-label="搜索音乐"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[color:color-mix(in_srgb,var(--md-sys-color-on-surface-variant)_70%,transparent)]"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          />
        </div>
        {/* 搜索联想下拉（Hydrogen search-assist；条目数随设置） */}
        {assistOpen && assistItems.length > 0 && (
          <div
            className="zen-dropdown-enter absolute left-0 top-11 z-[2001] w-72 overflow-hidden rounded-lg py-1"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-surface-container) 96%, transparent)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
              border:
                '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
            }}
          >
            {assistItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickAssist(item.name)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--md-sys-color-on-surface)]">
                  {item.name}
                </span>
                <span className="max-w-[40%] truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  {item.artist}
                </span>
              </button>
            ))}
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

      {/* ===== 右：模式切换插槽（一起听时由调用方注入滑块/标签）+ 账户 ===== */}
      {modeSwitchSlot}
      <div className="relative shrink-0">
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

        {/* app-option 小菜单（深色底 + 四角白点装饰，M3 适配 on-surface 底） */}
        {menuOpen && (
          <div
            className="zen-dropdown-enter absolute right-0 top-11 z-[2001] w-[104px]"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 92%, transparent)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* 四角白点装饰 */}
            {CORNER_DOTS.map((pos) => (
              <span
                key={pos}
                className={cn('absolute h-1 w-1', pos)}
                style={{
                  backgroundColor: 'var(--md-sys-color-surface)',
                }}
                aria-hidden="true"
              />
            ))}
            <div className="py-2">
              {/* 账号信息（昵称，非操作项） */}
              <div
                className="truncate px-3.5 py-1.5 text-xs font-medium"
                style={{ color: 'var(--md-sys-color-surface)' }}
                title={loginStatus.nickname ?? '未登录'}
              >
                {loginStatus.loggedIn
                  ? (loginStatus.nickname ?? '已登录')
                  : '未登录'}
              </div>
              {/* 设置（Hydrogen app-option 菜单同名入口） */}
              <button
                type="button"
                className="w-full px-3.5 py-1.5 text-left text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-surface)_14%,transparent)]"
                style={{ color: 'var(--md-sys-color-surface)' }}
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
                  className="w-full px-3.5 py-1.5 text-left text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-surface)_14%,transparent)]"
                  style={{ color: 'var(--md-sys-color-surface)' }}
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
                  className="w-full px-3.5 py-1.5 text-left text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-surface)_14%,transparent)]"
                  style={{ color: 'var(--md-sys-color-surface)' }}
                  onClick={() => {
                    setMenuOpen(false)
                    setLoginModalOpen(true)
                  }}
                >
                  账号登录
                </button>
              )}
              {/* 仅房主可见提示 */}
              {isHost && !loginStatus.loggedIn && (
                <div
                  className="px-3.5 pb-1 pt-1 text-[10px] leading-snug opacity-70"
                  style={{ color: 'var(--md-sys-color-surface)' }}
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
