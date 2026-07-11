import { useState } from 'react'
import { ChevronDown, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { Slider } from '@/components/ui/Slider'
import { Space } from '@/components/ui/Space'
import { Text } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'
import type {
  DanmakuStyleState,
  DanmakuTypeFilters,
  DanmakuAdvancedStyle,
} from '@/store/danmakuStore'

interface DanmakuStylePanelProps {
  style: DanmakuStyleState
  setStyle: (updates: Partial<DanmakuStyleState>) => void
  setFilters: (updates: Partial<DanmakuTypeFilters>) => void
  setAdvancedStyle: (updates: Partial<DanmakuAdvancedStyle>) => void
  resetStyle: () => void
}

const FILTER_BUTTONS: {
  key: keyof DanmakuTypeFilters
  label: string
}[] = [
  { key: 'scroll', label: '滚动' },
  { key: 'fixed', label: '固定' },
  { key: 'color', label: '彩色' },
  { key: 'advanced', label: '高级' },
]

export function DanmakuStylePanel({
  style,
  setStyle,
  setFilters,
  setAdvancedStyle,
  resetStyle,
}: DanmakuStylePanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-primary)' }}
          />
          <Text className="text-xs font-semibold">弹幕样式</Text>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          icon={<RotateCcw className="h-3 w-3" />}
          onClick={resetStyle}
        >
          重置
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {FILTER_BUTTONS.map(({ key, label }) => {
          const active = style.filters[key]
          return (
            <Button
              key={key}
              variant={active ? 'primary' : 'secondary'}
              size="sm"
              className="h-7 px-1 text-[11px]"
              onClick={() => setFilters({ [key]: !active })}
            >
              {label}
            </Button>
          )
        })}
      </div>

      <Space direction="vertical" className="w-full" size="sm">
        <div className="flex items-center justify-between py-0.5">
          <Text className="text-xs">随屏幕缩放</Text>
          <Switch
            checked={style.scaleWithScreen}
            onChange={(e) => setStyle({ scaleWithScreen: e.target.checked })}
          />
        </div>
        <div className="flex items-center justify-between py-0.5">
          <Text className="text-xs">防挡字幕</Text>
          <Switch
            checked={style.avoidSubtitle}
            onChange={(e) => setStyle({ avoidSubtitle: e.target.checked })}
          />
        </div>
        <div className="flex items-center justify-between py-0.5">
          <Text className="text-xs">智能防挡弹幕</Text>
          <Switch
            checked={style.avoidCollision}
            onChange={(e) => setStyle({ avoidCollision: e.target.checked })}
          />
        </div>
      </Space>

      <Slider
        label="显示区域"
        value={style.displayArea}
        min={0.25}
        max={1}
        step={0.05}
        valueFormatter={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setStyle({ displayArea: v })}
      />

      <Slider
        label="不透明度"
        value={style.opacity}
        min={0.1}
        max={1}
        step={0.05}
        valueFormatter={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setStyle({ opacity: v })}
      />

      <Slider
        label="弹幕字号"
        value={style.fontSize}
        min={12}
        max={36}
        step={1}
        valueFormatter={(v) => `${v}px`}
        onChange={(v) => setStyle({ fontSize: v })}
      />

      <Slider
        label="弹幕速度"
        value={style.speed}
        min={0.5}
        max={2}
        step={0.1}
        valueFormatter={(v) => `${v}x`}
        onChange={(v) => setStyle({ speed: v })}
      />

      <button
        type="button"
        onClick={() => setAdvancedOpen((prev) => !prev)}
        className="flex items-center justify-between rounded-[var(--md-sys-radius-small)] px-1 py-1 text-xs transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
      >
        <span>高级设置</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {advancedOpen && (
        <Space direction="vertical" className="w-full" size="sm">
          <Input
            size="sm"
            label="字体"
            value={style.advanced.fontFamily}
            onChange={(e) => setAdvancedStyle({ fontFamily: e.target.value })}
          />
          <Slider
            label="描边宽度"
            value={style.advanced.strokeWidth}
            min={0}
            max={3}
            step={0.5}
            valueFormatter={(v) => `${v}px`}
            onChange={(v) => setAdvancedStyle({ strokeWidth: v })}
          />
          <Slider
            label="阴影模糊"
            value={style.advanced.shadowBlur}
            min={0}
            max={8}
            step={0.5}
            valueFormatter={(v) => `${v}px`}
            onChange={(v) => setAdvancedStyle({ shadowBlur: v })}
          />
          <Slider
        label="同屏密度"
        value={style.advanced.density}
        min={0.1}
        max={2}
        step={0.05}
        valueFormatter={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setAdvancedStyle({ density: v })}
      />
        </Space>
      )}
    </div>
  )
}
