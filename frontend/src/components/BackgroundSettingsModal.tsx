import { useRef, useState } from 'react'
import { Image, Link2, Upload, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Slider } from '@/components/ui/Slider'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useThemeStore } from '@/store/themeStore'
import { cn } from '@/lib/utils'

interface BackgroundSettingsModalProps {
  open: boolean
  onClose: () => void
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

export function BackgroundSettingsModal({
  open,
  onClose,
}: BackgroundSettingsModalProps) {
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

  const handleCancel = () => {
    applyToStore(savedConfigRef.current)
    onClose()
  }

  const handleOk = () => {
    onClose()
  }

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'url', label: '网络图片链接', icon: <Link2 className="w-4 h-4" /> },
    {
      key: 'upload',
      label: '上传本地图片',
      icon: <Upload className="w-4 h-4" />,
    },
  ]

  const previewImage = store.backgroundImage

  return (
    <Modal
      open={open}
      onClose={handleCancel}
      title={
        <div className="flex items-center gap-2">
          <Image className="w-5 h-5" />
          自定义背景图片
        </div>
      }
      footer={
        <>
          <Button
            variant="danger"
            icon={<Trash2 className="w-4 h-4" />}
            onClick={handleClear}
          >
            清除背景
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" onClick={handleCancel}>
            取消
          </Button>
          <Button variant="primary" onClick={handleOk}>
            确定
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 标签页 */}
        <div className="flex p-1 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-[var(--md-sys-shape-corner)] transition-all',
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
          <Input
            placeholder="https://example.com/image.jpg"
            value={urlInput}
            onChange={(e) => handleUrlChange(e.target.value)}
          />
        )}

        {/* 本地上传 */}
        {activeTab === 'upload' && (
          <div className="space-y-2">
            <label className="flex flex-col items-center justify-center gap-2 w-full py-6 rounded-[var(--md-sys-shape-corner)] border border-dashed border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface-variant)] cursor-pointer hover:bg-[var(--md-sys-color-surface-container-highest)] transition-all">
              <Upload className="w-6 h-6" />
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
            className="w-full h-32 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] bg-cover bg-center overflow-hidden"
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
        <div className="space-y-3 pt-1">
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
      </div>
    </Modal>
  )
}
