/**
 * 顶部导航（Hydrogen Home.vue header 范式）。
 *
 * 结构：左搜索框 + 中导航链接组 + 右账户菜单
 * - 搜索框（widget-search 式）：圆角输入，回车 → page='search' 并存关键词到 store
 * - 导航链接：首页/私人漫游/云盘/我的音乐/塞壬唱片；当前页 on-surface、
 *   其余 on-surface-variant/60，18px font-medium，间距 clamp(37px,3vw,40px)，
 *   hover opacity-0.7
 * - 账户（app-option 范式）：已登录显示头像圆图，未登录显示 User 图标；
 *   点击弹出深色小菜单（M3 适配：on-surface 底 + surface 字 + 四角白点装饰），
 *   选项：账号信息（昵称）/ 退出登录或账号登录 / 房主可见的 VIP 提示
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Search, User } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { useMusicStore } from '../store'
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
  { key: 'siren', label: '塞壬唱片' },
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

  // 账户菜单打开时点击外部关闭（透明捕获层，同 Hydrogen app-option 交互）
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])

  /** 回车搜索：写入关键词并切到搜索页 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    const kw = keyword.trim()
    if (!kw) return
    setSearchKeywords(kw)
    setPage('search')
  }

  return (
    <header className="flex shrink-0 items-center gap-4 px-6 pt-4 pb-2 md:px-8">
      {/* ===== 左：搜索框（widget-search 式圆角输入） ===== */}
      <div
        className="flex h-8 w-44 shrink-0 items-center gap-1.5 rounded-full px-3"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
        }}
      >
        <Search
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        />
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="搜索音乐"
          aria-label="搜索音乐"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[color:color-mix(in_srgb,var(--md-sys-color-on-surface-variant)_70%,transparent)]"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
        />
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
                'shrink-0 text-lg font-medium transition-opacity hover:opacity-70',
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
          className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full transition-opacity hover:opacity-80"
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
              className="h-4 w-4 translate-y-[1px]"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            />
          )}
        </button>

        {/* app-option 小菜单（深色底 + 四角白点装饰，M3 适配 on-surface 底） */}
        {menuOpen && (
          <div
            className="zen-dropdown-enter absolute right-0 top-9 z-[2001] w-[104px]"
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
