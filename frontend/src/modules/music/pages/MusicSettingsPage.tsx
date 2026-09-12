/**
 * 设置页（Hydrogen Settings.vue 的 React 1:1 复刻 + Web 适配）。
 *
 * 结构（Hydrogen .settings-page / .settings-container）：
 * - view-control：返回箭头（32px，实心 chevron，hover 0.7 / active scale 0.9）+
 *   「设置(离开页面以保存设置或 点击 保存)」标题（17px bold，"点击"高亮块）
 * - settings-container：宽 80% 居中、内部滚动（zen-scroll）；
 *   h1 大标题「设置」→ 用户信息行 → 分组列表 → 版本行
 * - 用户信息行（settings-user-info）：100px 高浅色横条，70px 圆形头像 +
 *   20px 加粗昵称 + 右侧「退出」；未登录显示登录入口
 * - 分组（settings-item mt 45px）：20px 分组标题 + 0.5px 分隔线
 *   （mt 8px / mb 25px）+ 设置行（mb 32px，左 16px 名称 / 右 200×34 控件）
 * - 控件复刻：
 *   - toggle：两层结构——底层「已开启/已关闭」（13px bold 居中，浅色底）+
 *     黑色层从左滑入（translateX(-100%)→0，0.1s），开启时底层文字反白
 *   - 数字输入：200×34 透明底 13px bold 居中（blur 时归一化提交）
 *   - Selector：200×34 当前档位按钮 + 点击展开选项列表
 *   - 危险操作确认（Hydrogen dialogOpen）：开启「性能类」功能前弹确认
 *     （背景模糊/歌词模糊/音频可视化 → 性能提示；无缝衔接 → 流量提示）
 * - 与 Hydrogen 的差异（Web 适配）：
 *   - 仅保留「音乐」分组 + 「恢复默认设置」；Electron 专属项
 *     （本地目录/快捷键/窗口行为/自定义字体）不迁移
 *   - 保存：Hydrogen 离开页面保存；此处改动即生效即持久化（zustand persist），
 *     顶部「点击保存」保留为即时保存反馈
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, User } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { Slider } from '@/components/ui/Slider'
import {
  DEFAULT_MUSIC_SETTINGS,
  MUSIC_LEVEL_OPTIONS,
  normalizeNumberSetting,
  normalizeMusicLevel,
  useMusicSettingsStore,
} from '../store-settings'
import { cn } from '@/lib/utils'

/** 开启确认提示（Hydrogen PERFORMANCE / GAPLESS_CONFIRM_MESSAGE 原文） */
const PERFORMANCE_CONFIRM_MESSAGE =
  '开启后此功能会消耗一定性能且可能造成卡顿，确定开启吗？'
const GAPLESS_CONFIRM_MESSAGE =
  '开启后会提前预缓冲下一首音频，可能增加网络流量和内存占用，确定开启吗？'

/** 设置行壳（Hydrogen .option：左名称 16px bold + 右控件 200×34） */
function SettingOption({
  name,
  children,
}: {
  name: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-8 flex items-center justify-between">
      <div className="text-base font-bold text-[var(--md-sys-color-on-surface)]">
        {name}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** toggle 开关（Hydrogen .toggle 复刻：黑色层滑入 + 底层文字反白） */
function SettingToggle({
  on,
  onToggle,
}: {
  on: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="relative block h-[34px] w-[200px] overflow-hidden transition-opacity hover:opacity-90"
      aria-pressed={on}
      title={on ? '点击关闭' : '点击开启'}
    >
      {/* 黑色层：开启时从左滑入盖满（translateX(-100%)→0，0.1s） */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0 transition-transform duration-100',
          on ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
      />
      {/* 底层文字：关闭时 on-surface 8% 浅底 + 常规字；开启时透出黑层 + 反白 */}
      <span
        className={cn(
          'absolute inset-0 z-[1] flex items-center justify-center px-2.5 text-[13px] font-bold transition-colors duration-200',
          on
            ? 'text-[var(--md-sys-color-surface)]'
            : 'text-[var(--md-sys-color-on-surface)]'
        )}
        style={{
          backgroundColor: on
            ? 'transparent'
            : 'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
        }}
      >
        {on ? '已开启' : '已关闭'}
      </span>
    </button>
  )
}

/** 数字输入（Hydrogen option input：200×34 透明底 13px bold 居中；
 * blur 时归一化提交，外部值变化（恢复默认）时同步草稿） */
function SettingNumberInput({
  value,
  onCommit,
}: {
  value: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setDraft(String(value))
  }
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number.parseInt(draft, 10)
        const next = Number.isFinite(n)
          ? normalizeNumberSetting(n, value)
          : value
        onCommit(next)
        setDraft(String(next))
      }}
      inputMode="numeric"
      aria-label="数值设置"
      className="h-[34px] w-[200px] bg-transparent text-center text-[13px] font-bold outline-none transition-opacity hover:opacity-80"
      style={{ color: 'var(--md-sys-color-on-surface)' }}
    />
  )
}

/** 下拉选择（Hydrogen Selector 简化版：200×34 档位按钮 + 下方选项列表） */
function SettingSelector({
  value,
  options,
  onChange,
}: {
  value: string
  options: ReadonlyArray<{ label: string; value: string }>
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  const current = options.find((o) => o.value === value)
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] w-[200px] items-center justify-center gap-1 text-[13px] font-bold transition-opacity hover:opacity-80"
        style={{ color: 'var(--md-sys-color-on-surface)' }}
        title={current?.label ?? value}
        aria-expanded={open}
      >
        {current?.label ?? value}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </button>
      {open && (
        <div
          className="zen-dropdown-enter absolute right-0 top-[38px] z-[2100] max-h-[280px] w-[200px] overflow-y-auto rounded-md py-1"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-surface-container) 97%, transparent)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
            border:
              '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center px-3 py-1.5 text-left text-[13px] font-bold transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]',
                o.value === value
                  ? 'text-[var(--md-sys-color-primary)]'
                  : 'text-[var(--md-sys-color-on-surface)]'
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 开启确认弹窗（Hydrogen dialogOpen 复刻：黑色玻璃小卡片 + 确定/取消） */
function ConfirmDialog({
  text,
  onConfirm,
  onCancel,
}: {
  text: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/30"
      onClick={onCancel}
    >
      <div
        className="zen-dropdown-enter w-[360px] p-5"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.66)',
          backdropFilter: 'blur(18px) saturate(120%)',
          WebkitBackdropFilter: 'blur(18px) saturate(120%)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="确认开启"
      >
        <div className="text-sm font-bold text-white">确定开启</div>
        <p className="mt-2 text-xs leading-relaxed text-white/80">{text}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-xs font-bold text-white/80 transition-opacity hover:opacity-70"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-white px-4 py-1.5 text-xs font-bold text-black transition-opacity hover:opacity-85"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

export function MusicSettingsPage() {
  const setPage = useMusicStore((s) => s.setPage)
  const loginStatus = useMusicStore((s) => s.loginStatus)
  const setLoginModalOpen = useMusicStore((s) => s.setLoginModalOpen)
  const settings = useMusicSettingsStore()
  const setSettings = settings.set
  /** 待确认的开启操作（Hydrogen dialogOpen） */
  const [pendingConfirm, setPendingConfirm] = useState<{
    text: string
    apply: () => void
  } | null>(null)

  /** toggle 通用切换（Hydrogen setConfirmedPlayerFlag：已开启直接关；
   * 关闭 → 性能/流量类需确认后才开启） */
  const toggleWithConfirm = (key: keyof typeof settings, text: string) => {
    if (settings[key] === true) {
      setSettings({ [key]: false } as never)
      return
    }
    setPendingConfirm({
      text,
      apply: () => setSettings({ [key]: true } as never),
    })
  }

  /** 退出网易云账号（与顶栏菜单退出同逻辑） */
  const handleLogout = () => {
    void apiPost('/api/music/logout').catch(() => {
      // 网络失败也清空本地态（与 useNcmLogin.logout 行为一致）
    })
    useMusicStore.getState().setLoginStatus({ loggedIn: false })
    message.success('已退出网易云账号')
  }

  const avatarUrl = loginStatus.avatarUrl
    ? `${loginStatus.avatarUrl.replace('http://', 'https://')}?param=100y100`
    : null

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-6 md:px-8">
      {/* ===== view-control：返回箭头 + 标题（Hydrogen 同款） ===== */}
      <div className="ml-[-8px] mb-[15px] flex h-8 shrink-0 items-center">
        <button
          type="button"
          onClick={() => setPage('home')}
          className="flex h-8 w-8 items-center justify-center p-2 text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
          title="返回"
          aria-label="返回"
        >
          <svg viewBox="0 0 1024 1024" className="h-4 w-4" aria-hidden="true">
            <path
              d="M716.608 1010.112L218.88 512.384 717.376 13.888l45.248 45.248-453.248 453.248 452.48 452.48z"
              fill="currentColor"
            />
          </svg>
        </button>
        <span className="ml-1 text-[17px] font-bold text-[var(--md-sys-color-on-surface)]">
          设置(离开页面以保存设置或{' '}
          <button
            type="button"
            className="px-1.5 py-1 text-[15px] transition-opacity hover:opacity-80 active:opacity-60"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
            }}
            onClick={() => message.success('设置已保存')}
          >
            点击
          </button>{' '}
          保存)
        </span>
      </div>

      {/* ===== settings-container（80% 居中，内滚） ===== */}
      <div className="zen-scroll mx-auto min-h-0 w-[80%] min-w-[560px] flex-1 overflow-y-auto pb-14">
        <h1 className="m-0 text-[32px] font-bold leading-tight text-[var(--md-sys-color-on-surface)]">
          设置
        </h1>

        {/* ===== 用户信息行（settings-user-info 复刻） ===== */}
        <div
          className="mt-3 flex h-[100px] w-full items-center justify-between px-10"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
          }}
        >
          {loginStatus.loggedIn ? (
            <>
              <div className="flex items-center">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={loginStatus.nickname ?? '网易云账号'}
                    className="mr-[15px] h-[70px] w-[70px] rounded-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div
                    className="mr-[15px] flex h-[70px] w-[70px] items-center justify-center rounded-full"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
                    }}
                  >
                    <User
                      className="h-7 w-7"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    />
                  </div>
                )}
                <div className="text-xl font-bold text-[var(--md-sys-color-on-surface)]">
                  {loginStatus.nickname ?? '网易云用户'}
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="text-sm font-bold text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-80 active:scale-95"
                title="退出网易云账号"
              >
                退出
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center">
                <div
                  className="mr-[15px] flex h-[70px] w-[70px] items-center justify-center rounded-full"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
                  }}
                >
                  <User
                    className="h-7 w-7"
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                  />
                </div>
                <div className="text-xl font-bold text-[var(--md-sys-color-on-surface)]">
                  未登录网易云账号
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLoginModalOpen(true)}
                className="text-sm font-bold text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-80 active:scale-95"
              >
                登录
              </button>
            </>
          )}
        </div>

        {/* ===== 音乐分组（settings-item） ===== */}
        <div className="mt-[45px] w-full">
          <h2 className="m-0 text-xl font-bold text-[var(--md-sys-color-on-surface)]">
            音乐
          </h2>
          <div
            className="mb-[25px] mt-2 h-[0.5px] w-full"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 20%, transparent)',
            }}
          />
          {/* 音质选择（Selector 9 档） */}
          <SettingOption name="音质选择">
            <SettingSelector
              value={normalizeMusicLevel(settings.level)}
              options={MUSIC_LEVEL_OPTIONS}
              onChange={(v) => setSettings({ level: v })}
            />
          </SettingOption>
          {/* 背景封面模糊（性能类：开启需确认） */}
          <SettingOption name="开启背景封面模糊">
            <SettingToggle
              on={settings.coverBlur}
              onToggle={() =>
                toggleWithConfirm('coverBlur', PERFORMANCE_CONFIRM_MESSAGE)
              }
            />
          </SettingOption>
          {/* 歌词模糊（性能类） */}
          <SettingOption name="开启歌词模糊">
            <SettingToggle
              on={settings.lyricBlur}
              onToggle={() =>
                toggleWithConfirm('lyricBlur', PERFORMANCE_CONFIRM_MESSAGE)
              }
            />
          </SettingOption>
          {/* 当前歌词行遮罩透明度 / 模糊度（滑块） */}
          <SettingOption name="歌词遮罩透明度">
            <Slider
              value={settings.lyricMaskOpacity}
              min={0}
              max={100}
              step={1}
              className="w-[200px]"
              valueFormatter={(v) => `${v}%`}
              onChange={(v) => setSettings({ lyricMaskOpacity: v })}
            />
          </SettingOption>
          <SettingOption name="歌词遮罩模糊度">
            <Slider
              value={settings.lyricMaskBlur}
              min={0}
              max={20}
              step={1}
              className="w-[200px]"
              valueFormatter={(v) => `${v}px`}
              onChange={(v) => setSettings({ lyricMaskBlur: v })}
            />
          </SettingOption>
          {/* 显示歌曲翻译（直接切换） */}
          <SettingOption name="显示歌曲翻译">
            <SettingToggle
              on={settings.showSongTranslation}
              onToggle={() =>
                setSettings({
                  showSongTranslation: !settings.showSongTranslation,
                })
              }
            />
          </SettingOption>
          {/* 歌曲无缝衔接（流量类：开启需确认） */}
          <SettingOption name="歌曲无缝衔接">
            <SettingToggle
              on={settings.gaplessPlayback}
              onToggle={() =>
                toggleWithConfirm('gaplessPlayback', GAPLESS_CONFIRM_MESSAGE)
              }
            />
          </SettingOption>
          {/* 音频可视化（性能类） */}
          <SettingOption name="音频可视化">
            <SettingToggle
              on={settings.audioVisualizer}
              onToggle={() =>
                toggleWithConfirm(
                  'audioVisualizer',
                  PERFORMANCE_CONFIRM_MESSAGE
                )
              }
            />
          </SettingOption>
          {/* 数字输入组 */}
          <SettingOption name="搜索下拉条目数量">
            <SettingNumberInput
              value={settings.searchAssistLimit}
              onCommit={(v) =>
                setSettings({
                  searchAssistLimit: normalizeNumberSetting(
                    v,
                    DEFAULT_MUSIC_SETTINGS.searchAssistLimit
                  ),
                })
              }
            />
          </SettingOption>
          <SettingOption name="歌词字体大小">
            <SettingNumberInput
              value={settings.lyricSize}
              onCommit={(v) =>
                setSettings({
                  lyricSize: normalizeNumberSetting(
                    v,
                    DEFAULT_MUSIC_SETTINGS.lyricSize
                  ),
                })
              }
            />
          </SettingOption>
          <SettingOption name="歌词翻译字体大小">
            <SettingNumberInput
              value={settings.tlyricSize}
              onCommit={(v) =>
                setSettings({
                  tlyricSize: normalizeNumberSetting(
                    v,
                    DEFAULT_MUSIC_SETTINGS.tlyricSize
                  ),
                })
              }
            />
          </SettingOption>
          <SettingOption name="罗马歌词字体大小">
            <SettingNumberInput
              value={settings.rlyricSize}
              onCommit={(v) =>
                setSettings({
                  rlyricSize: normalizeNumberSetting(
                    v,
                    DEFAULT_MUSIC_SETTINGS.rlyricSize
                  ),
                })
              }
            />
          </SettingOption>
          <SettingOption name="歌词间奏等待时间(单位：秒)">
            <SettingNumberInput
              value={settings.lyricInterlude}
              onCommit={(v) =>
                setSettings({
                  lyricInterlude: normalizeNumberSetting(
                    v,
                    DEFAULT_MUSIC_SETTINGS.lyricInterlude
                  ),
                })
              }
            />
          </SettingOption>
        </div>

        {/* ===== 其他分组（Web 适配：恢复默认设置） ===== */}
        <div className="mt-[45px] w-full">
          <h2 className="m-0 text-xl font-bold text-[var(--md-sys-color-on-surface)]">
            其他
          </h2>
          <div
            className="mb-[25px] mt-2 h-[0.5px] w-full"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 20%, transparent)',
            }}
          />
          <SettingOption name="恢复默认设置">
            <button
              type="button"
              onClick={() => {
                settings.reset()
                message.success('已恢复默认设置')
              }}
              className="h-[34px] w-[200px] text-[13px] font-bold transition-opacity hover:opacity-80"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                color: 'var(--md-sys-color-on-surface)',
              }}
            >
              恢复默认
            </button>
          </SettingOption>
        </div>

        {/* ===== 版本行（Hydrogen app-version 适配） ===== */}
        <div className="mt-10 flex flex-col items-center">
          <div className="text-sm font-bold tracking-widest text-[var(--md-sys-color-on-surface)]">
            ZVIEWER MUSIC
          </div>
          <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            设置改动即时生效并保存至本地 · Hydrogen Music 风格复刻
          </p>
        </div>
      </div>

      {/* 开启确认弹窗（Hydrogen dialogOpen） */}
      {pendingConfirm && (
        <ConfirmDialog
          text={pendingConfirm.text}
          onConfirm={() => {
            pendingConfirm.apply()
            setPendingConfirm(null)
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  )
}
