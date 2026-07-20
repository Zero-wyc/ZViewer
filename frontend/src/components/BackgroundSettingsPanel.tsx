import { useRef, useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Image, Link2, Upload, Trash2, Check } from 'lucide-react'
import { Slider } from '@/components/ui/Slider'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useThemeStore } from '@/store/themeStore'
import { cn } from '@/lib/utils'

interface BackgroundSettingsPanelProps {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}

type TabKey = 'url' | 'upload'

interface BackgroundConfig {
  backgroundImage: string | null
  backgroundBlur: number
  backgroundOpacity: number
  backgroundPositionX: number
  backgroundPositionY: number
  backgroundScale: number
  backgroundRotate: number
}

const DEFAULT_CONFIG: BackgroundConfig = {
  backgroundImage: null,
  backgroundBlur: 0,
  backgroundOpacity: 1,
  backgroundPositionX: 0,
  backgroundPositionY: 0,
  backgroundScale: 1,
  backgroundRotate: 0,
}

export function BackgroundSettingsPanel({
  open,
  onClose,
  anchorRef,
}: BackgroundSettingsPanelProps) {
  const store = useThemeStore()
  const isSavedUpload = store.backgroundImage?.startsWith('data:') ?? false
  const [activeTab, setActiveTab] = useState<TabKey>(
    isSavedUpload ? 'upload' : 'url'
  )
  const [urlInput, setUrlInput] = useState(
    isSavedUpload ? '' : (store.backgroundImage ?? '')
  )
  const [uploadImage, setUploadImage] = useState<string | null>(
    isSavedUpload ? store.backgroundImage : null
  )
  const savedConfigRef = useRef<BackgroundConfig>({
    backgroundImage: store.backgroundImage,
    backgroundBlur: store.backgroundBlur,
    backgroundOpacity: store.backgroundOpacity,
    backgroundPositionX: store.backgroundPositionX,
    backgroundPositionY: store.backgroundPositionY,
    backgroundScale: store.backgroundScale,
    backgroundRotate: store.backgroundRotate,
  })

  const [position, setPosition] = useState<{
    top: number
    right: number
  } | null>(null)
  const [isClosing, setIsClosing] = useState(false)

  const computePosition = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    setPosition({
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    })
  }, [anchorRef])

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 面板关闭时清理定位与动画状态
      setPosition(null)
      setIsClosing(false)
      return
    }
    computePosition()
    const handler = () => computePosition()
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [open, computePosition])

  useEffect(() => {
    if (!open) return
    savedConfigRef.current = {
      backgroundImage: store.backgroundImage,
      backgroundBlur: store.backgroundBlur,
      backgroundOpacity: store.backgroundOpacity,
      backgroundPositionX: store.backgroundPositionX,
      backgroundPositionY: store.backgroundPositionY,
      backgroundScale: store.backgroundScale,
      backgroundRotate: store.backgroundRotate,
    }
    const nextIsUpload = store.backgroundImage?.startsWith('data:') ?? false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开面板时同步当前背景配置到表单
    setActiveTab(nextIsUpload ? 'upload' : 'url')
    setUrlInput(nextIsUpload ? '' : (store.backgroundImage ?? ''))
    setUploadImage(nextIsUpload ? store.backgroundImage : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const applyToStore = (config: BackgroundConfig) => {
    store.setBackgroundImage(config.backgroundImage)
    store.setBackgroundBlur(config.backgroundBlur)
    store.setBackgroundOpacity(config.backgroundOpacity)
    store.setBackgroundPositionX(config.backgroundPositionX)
    store.setBackgroundPositionY(config.backgroundPositionY)
    store.setBackgroundScale(config.backgroundScale)
    store.setBackgroundRotate(config.backgroundRotate)
  }

  const switchTab = (tab: TabKey) => {
    setActiveTab(tab)
    if (tab === 'url') {
      store.setBackgroundImage(urlInput.trim() || null)
    } else {
      store.setBackgroundImage(uploadImage)
    }
  }

  const handleUrlChange = (value: string) => {
    setUrlInput(value)
    if (value.trim()) {
      store.setBackgroundImage(value.trim())
    } else {
      store.setBackgroundImage(null)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      setUploadImage(result)
      store.setBackgroundImage(result)
    }
    reader.readAsDataURL(file)
  }

  const handleClear = () => {
    applyToStore(DEFAULT_CONFIG)
    onClose()
  }

  const handleClose = () => {
    setIsClosing(true)
    setTimeout(() => {
      onClose()
      setIsClosing(false)
    }, 180)
  }

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'url', label: '网络链接', icon: <Link2 className="w-3.5 h-3.5" /> },
    {
      key: 'upload',
      label: '本地上传',
      icon: <Upload className="w-3.5 h-3.5" />,
    },
  ]

  const previewImage = store.backgroundImage

  if (!open || !position) return null

  return createPortal(
    <div
      className={cn(
        'glass-strong fixed w-80 rounded-[var(--md-sys-shape-corner)] p-4 shadow-lg',
        isClosing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
      )}
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`,
        zIndex: 60,
        boxShadow:
          '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
      }}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Image className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
          <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            自定义背景
          </span>
        </div>
        <button
          onClick={handleClose}
          className="p-1 rounded-[var(--md-sys-shape-corner)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)] transition-colors"
        >
          <Check className="w-4 h-4" />
        </button>
      </div>

      {/* 标签页 */}
      <div className="flex p-1 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)]">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => switchTab(tab.key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-[var(--md-sys-shape-corner)] transition-all',
              activeTab === tab.key
                ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* 网络图片 */}
      {activeTab === 'url' && (
        <div className="mt-3">
          <Input
            size="sm"
            placeholder="https://example.com/image.jpg"
            value={urlInput}
            onChange={(e) => handleUrlChange(e.target.value)}
          />
        </div>
      )}

      {/* 本地上传 */}
      {activeTab === 'upload' && (
        <div className="mt-3">
          <label className="flex flex-col items-center justify-center gap-2 w-full py-4 rounded-[var(--md-sys-shape-corner)] border border-dashed border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface-variant)] cursor-pointer hover:bg-[var(--md-sys-color-surface-container-highest)] transition-all">
            <Upload className="w-5 h-5" />
            <span className="text-xs">点击选择图片文件</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </label>
        </div>
      )}

      {/* 预览 */}
      {previewImage && (
        <div
          className="mt-3 w-full h-24 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] bg-cover bg-center overflow-hidden"
          style={{
            backgroundImage: `url(${previewImage})`,
            filter: `blur(${store.backgroundBlur}px)`,
            opacity: store.backgroundOpacity,
            backgroundPosition: `${store.backgroundPositionX}% ${store.backgroundPositionY}%`,
            transform: `scale(${store.backgroundScale}) rotate(${store.backgroundRotate}deg)`,
          }}
        />
      )}

      {/* 参数滑块 */}
      <div className="mt-3 space-y-2">
        <Slider
          label="模糊度"
          value={store.backgroundBlur}
          min={0}
          max={20}
          step={1}
          valueFormatter={(v) => `${v}px`}
          onChange={store.setBackgroundBlur}
        />
        <Slider
          label="透明度"
          value={Math.round(store.backgroundOpacity * 100)}
          min={0}
          max={100}
          step={1}
          valueFormatter={(v) => `${v}%`}
          onChange={(v) => store.setBackgroundOpacity(v / 100)}
        />
        <Slider
          label="水平位置"
          value={store.backgroundPositionX}
          min={-100}
          max={100}
          step={1}
          valueFormatter={(v) => `${v}%`}
          onChange={store.setBackgroundPositionX}
        />
        <Slider
          label="垂直位置"
          value={store.backgroundPositionY}
          min={-100}
          max={100}
          step={1}
          valueFormatter={(v) => `${v}%`}
          onChange={store.setBackgroundPositionY}
        />
        <Slider
          label="缩放比例"
          value={Math.round(store.backgroundScale * 100)}
          min={50}
          max={200}
          step={1}
          valueFormatter={(v) => `${v}%`}
          onChange={(v) => store.setBackgroundScale(v / 100)}
        />
        <Slider
          label="旋转角度"
          value={store.backgroundRotate}
          min={0}
          max={360}
          step={1}
          valueFormatter={(v) => `${v}°`}
          onChange={store.setBackgroundRotate}
        />
      </div>

      {/* 清除背景 */}
      <Button
        variant="danger"
        size="sm"
        block
        className="mt-3"
        icon={<Trash2 className="w-3.5 h-3.5" />}
        onClick={handleClear}
      >
        清除背景
      </Button>
    </div>,
    document.body
  )
}
