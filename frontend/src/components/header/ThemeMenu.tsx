import { createPortal } from 'react-dom'
import type { CSSProperties, RefObject } from 'react'
import {
  Palette,
  Sun,
  Moon,
  SlidersHorizontal,
  Image,
  Sparkles,
  MousePointerClick,
} from 'lucide-react'
import {
  useThemeStore,
  RADIUS_PRESETS,
  type RadiusPreset,
} from '@/store/themeStore'
import { t } from '@/i18n'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { BackgroundSettingsPanel } from '@/components/BackgroundSettingsPanel'
import { CustomColorPanel } from '@/components/CustomColorPanel'
import { cn } from '@/lib/utils'
import type { DropdownPosition } from './usePortalDropdown'

interface ThemeMenuProps {
  open: boolean
  closing: boolean
  position: DropdownPosition | null
  buttonRef: RefObject<HTMLButtonElement>
  menuRef: RefObject<HTMLDivElement>
  onToggle: () => void
  /** 自定义主题色侧栏（与自定义背景互斥） */
  customColorOpen: boolean
  setCustomColorOpen: (open: boolean) => void
  /** 自定义背景侧栏（展开时需锁定顶栏显隐，故由 Header 持有） */
  backgroundOpen: boolean
  setBackgroundOpen: (open: boolean) => void
}

/**
 * 顶栏「主题设置」下拉：深浅色、圆角预设、玻璃透明度/模糊度、动画开关，
 * 以及「自定义主题 / 自定义背景」两个侧栏。
 *
 * 菜单通过 createPortal 渲染到 body，脱离 Header（fixed + backdrop-filter）
 * 的合成层，使二级菜单的 backdrop-filter 能看到真实页面内容；定位与开合
 * 动画由 usePortalDropdown 统一处理。
 */
export function ThemeMenu({
  open,
  closing,
  position,
  buttonRef,
  menuRef,
  onToggle,
  customColorOpen,
  setCustomColorOpen,
  backgroundOpen,
  setBackgroundOpen,
}: ThemeMenuProps) {
  const {
    isDark,
    setDark,
    radius,
    setRadius,
    glassStrength,
    setGlassStrength,
    glassBlur,
    setGlassBlur,
    reducedMotion,
    setReducedMotion,
    disableHoverTransform,
    setDisableHoverTransform,
  } = useThemeStore()

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={onToggle}
        className={cn(
          'p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
          open
            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
            : 'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
        )}
        style={{
          border: '1px solid var(--md-sys-color-outline)',
        }}
        title={t('主题设置')}
      >
        <Palette className="w-4 h-4" />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            className={cn(
              'glass fixed flex overflow-hidden rounded-[var(--md-sys-shape-corner)] shadow-lg',
              closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
            )}
            style={{
              top: `${position.top}px`,
              right: `${position.right}px`,
              zIndex: 50,
              height: 'min(590px, calc(100vh - 32px))',
              // 容器宽度由子元素决定，不单独动画 width，避免与侧面板的 width 动画不同步导致抖动
              backdropFilter: 'blur(var(--glass-blur-strong))',
              WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
              boxShadow:
                '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
            }}
          >
            {/* 侧面板位槽：宽度承载「自定义背景/自定义主题」任一展开
                （二者互斥），0↔300px 动画并裁剪内部。两个面板绝对
                定位叠加于槽内右缘，各自 translateX 滑动（收起右移藏
                到主面板后方）——切换时新旧面板同步左移、在槽内无缝
                推挤：新面板从主面板一侧向左滑入，旧面板向左滑出被
                裁剪，无淡入淡出 */}
            <div
              className="relative h-full flex-shrink-0 overflow-hidden"
              style={{
                width: backgroundOpen || customColorOpen ? 300 : 0,
                transition: 'width 240ms var(--ease-out-expo)',
                willChange: 'width',
              }}
            >
              <BackgroundSettingsPanel
                open={backgroundOpen}
                onClose={() => setBackgroundOpen(false)}
              />
              <CustomColorPanel open={customColorOpen} />
            </div>
            <div className="h-full w-72 flex-shrink-0 overflow-y-auto px-4 pt-4 pb-2">
              {/* 深浅色切换 */}
              <button
                onClick={() => setDark(!isDark)}
                className="zen-dropdown-item w-full flex items-center justify-between p-3 rounded-[var(--md-sys-shape-corner)] text-left transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] hover:translate-x-0.5"
                style={{ '--item-delay': '0ms' } as CSSProperties}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm"
                    style={{
                      backgroundColor: 'var(--glass-bg)',
                      border: '1px solid var(--md-sys-color-outline)',
                    }}
                  >
                    {isDark ? (
                      <Moon
                        className="w-4 h-4"
                        style={{
                          color: 'var(--md-sys-color-on-surface)',
                        }}
                      />
                    ) : (
                      <Sun
                        className="w-4 h-4"
                        style={{ color: 'var(--md-sys-color-primary)' }}
                      />
                    )}
                  </span>
                  <div>
                    <span className="font-medium text-sm text-[var(--md-sys-color-on-surface)]">
                      {isDark ? t('深色模式') : t('浅色模式')}
                    </span>
                    <p className="text-xs mt-0.5 text-[var(--md-sys-color-on-surface-variant)]">
                      {t('点击切换明暗主题')}
                    </p>
                  </div>
                </div>
                <div
                  className="w-9 h-5 rounded-full relative transition-colors"
                  style={{
                    backgroundColor: isDark
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  <span
                    className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                    style={{
                      backgroundColor: 'var(--md-sys-color-surface)',
                      left: isDark ? '18px' : '2px',
                    }}
                  />
                </div>
              </button>

              <div
                className="h-px mx-1 my-3"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                }}
              />

              {/* 圆角预设 */}
              <div
                className="zen-dropdown-item space-y-2"
                style={{ '--item-delay': '120ms' } as CSSProperties}
              >
                <span className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  {t('圆角')}
                </span>
                <div className="grid grid-cols-4 gap-2">
                  {RADIUS_PRESETS.map((preset) => {
                    const active = radius === preset.value
                    return (
                      <button
                        key={preset.value}
                        onClick={() => setRadius(preset.value as RadiusPreset)}
                        className={cn(
                          'flex flex-col items-center gap-1 rounded-[var(--md-sys-shape-corner)] p-1.5 text-xs transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]',
                          active &&
                            'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                        )}
                      >
                        <span
                          className="h-5 w-8 border-2 border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)]"
                          style={{ borderRadius: `${preset.px}px` }}
                        />
                        <span>{t(preset.label)}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 玻璃透明度 + 模糊度滑块 */}
              <div
                className="zen-dropdown-item space-y-2 mt-3"
                style={{ '--item-delay': '180ms' } as CSSProperties}
              >
                <Slider
                  label={t('玻璃透明度')}
                  value={Math.round(glassStrength * 100)}
                  min={0}
                  max={100}
                  step={1}
                  valueFormatter={(v) => `${v}%`}
                  onChange={(v) => setGlassStrength(v / 100)}
                  disabled={reducedMotion}
                />
                <Slider
                  label={t('卡片模糊度')}
                  value={glassBlur}
                  min={0}
                  max={40}
                  step={1}
                  valueFormatter={(v) => `${v}px`}
                  onChange={(v) => setGlassBlur(v)}
                  disabled={reducedMotion}
                />
              </div>

              {/* 精简动画开关 */}
              <div
                className="zen-dropdown-item mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)]"
                style={
                  {
                    border: '1px solid var(--md-sys-color-outline)',
                    '--item-delay': '220ms',
                  } as CSSProperties
                }
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="w-4 h-4 text-[var(--md-sys-color-primary)] shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--md-sys-color-on-surface)] truncate">
                      {t('精简动画')}
                    </p>
                    <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)] truncate">
                      {t('关闭后启用华丽效果')}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={reducedMotion}
                  onChange={(e) => setReducedMotion(e.target.checked)}
                />
              </div>

              {/* 禁用全局 hover 位移开关 */}
              <div
                className="zen-dropdown-item mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)]"
                style={
                  {
                    border: '1px solid var(--md-sys-color-outline)',
                    '--item-delay': '260ms',
                  } as CSSProperties
                }
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MousePointerClick className="w-4 h-4 text-[var(--md-sys-color-primary)] shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--md-sys-color-on-surface)] truncate">
                      {t('禁用 hover 位移')}
                    </p>
                    <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)] truncate">
                      {t('关闭悬浮上浮/缩放效果')}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={disableHoverTransform}
                  onChange={(e) => setDisableHoverTransform(e.target.checked)}
                />
              </div>

              {/* 自定义主题入口：展开/收起左侧主题色编辑栏 */}
              <button
                onClick={() => {
                  const next = !customColorOpen
                  setCustomColorOpen(next)
                  // 显式互斥：展开主题色栏时收起自定义背景面板
                  if (next) setBackgroundOpen(false)
                }}
                className={cn(
                  'zen-dropdown-item mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)] text-sm transition-all hover:translate-x-0.5',
                  customColorOpen
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]'
                    : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
                style={
                  {
                    border: '1px solid var(--md-sys-color-outline)',
                    '--item-delay': '280ms',
                  } as CSSProperties
                }
              >
                <Palette className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
                <span className="flex-1 text-left">{t('自定义主题')}</span>
              </button>

              {/* 自定义背景入口 */}
              <button
                onClick={() => {
                  const next = !backgroundOpen
                  setBackgroundOpen(next)
                  // 显式互斥：展开背景面板时收起主题色栏
                  if (next) setCustomColorOpen(false)
                }}
                className={cn(
                  'zen-dropdown-item mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)] text-sm transition-all hover:translate-x-0.5',
                  backgroundOpen
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]'
                    : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
                style={
                  {
                    border: '1px solid var(--md-sys-color-outline)',
                    '--item-delay': '300ms',
                  } as CSSProperties
                }
              >
                <Image className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
                <span className="flex-1 text-left">{t('自定义背景')}</span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
