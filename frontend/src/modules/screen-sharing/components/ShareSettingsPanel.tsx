/**
 * 「共享设置」卡片（房主侧，共享中常驻在下方控制卡片区）。
 *
 * 之前它是控制栏上一个按钮拉起的浮层，盖在画面上。浮层会同时挡住预览与批注，
 * 而共享中最常调的就是档位/声音，所以改成与「房间状态」「评论区」并列的卡片：
 * 常驻、可滚动、不遮挡画面。
 *
 * 卡片本身不持有任何设置状态——`settings` 与全部动作都来自共享页经
 * `useShareSettingsBridge` 发布的绑定，避免两处 UI 各存一份真相。
 */
import { SlidersHorizontal } from 'lucide-react'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { t } from '@/i18n'
import { ShareSettingsCard } from './ShareSettingsCard'
import { useShareSettingsBridge } from '../store/shareSettingsBridge'

export function ShareSettingsPanel(): JSX.Element | null {
  const binding = useShareSettingsBridge((state) => state.binding)
  // 共享页没挂载（观众端 / 一起看 / 一起听）时没有可调的会话，整张卡片不出现。
  if (!binding) return null

  const { settings, isSharing, switchingResolution, switchingSource, cameras } =
    binding
  const summary = `${settings.resolutionPreset.toUpperCase()} · ${
    settings.frameRate
  }fps · ${settings.maxBitrateMbps}Mbps`

  return (
    <div className="glass-card zen-card flex h-full w-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* 卡片头部：与「房间状态」同构（图标块 + 标题 + 副标题 + 右侧状态） */}
      <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{ backgroundColor: 'var(--md-sys-color-primary-container)' }}
        >
          <SlidersHorizontal
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-on-primary-container)' }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Text className="text-sm font-semibold leading-tight">
            {t('共享设置')}
          </Text>
          <Text
            type="secondary"
            className="truncate text-[10px] tabular-nums tracking-wide"
            title={summary}
          >
            {summary}
          </Text>
        </div>
        {isSharing && <Tag color="primary">{t('共享中')}</Tag>}
      </div>

      {/* 内容区独立滚动：卡片被压在 clamp(340px,42vh,420px) 的等高行里，
          不自己滚就会把「声音」那组挤出可视区。 */}
      <div className="zen-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
        <ShareSettingsCard
          compact
          settings={settings}
          isSharing={isSharing}
          switchingResolution={switchingResolution}
          switchingSource={switchingSource}
          cameras={cameras}
          {...binding.actions}
        />
      </div>
    </div>
  )
}
