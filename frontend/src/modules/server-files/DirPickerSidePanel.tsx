import { ChevronLeft, HardDrive, Folder, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'

/** 副面板宽度（px） */
export const SIDE_PANEL_WIDTH = 300
/** 动画时长 */
const DURATION = 240

/** 目录条目的通用形态（调用方把 SystemDirEntry / ServerFileEntry 映射过来） */
export interface DirPickerEntry {
  /** 唯一 key（完整路径），onEnter 回传 */
  key: string
  /** 展示名 */
  name: string
}

export interface DirPickerSidePanelProps {
  /** 是否展开 */
  open: boolean
  /** 加载中 */
  loading: boolean
  /** 错误信息 */
  error?: string
  /** 目录条目列表 */
  entries: DirPickerEntry[]
  /** 当前路径 */
  currentPath: string
  /** 路径为空时的占位文案 */
  currentPathPlaceholder?: string
  /** 是否处于根级（根级禁用返回 + 图标用硬盘） */
  isRoot: boolean
  /** 进入子目录（回传条目 key） */
  onEnter: (entryKey: string) => void
  /** 返回上一级 */
  onBack: () => void
  /** 选择当前目录（提供时在底部渲染「选择此目录」按钮） */
  onSelect?: () => void
  /** 关闭面板 */
  onClose: () => void
}

/**
 * 目录选取副面板（flex 子元素，通过 width 动画向右展开）。
 * 作为主面板的 flex 兄弟元素，展开时宽度从 0 过渡到 SIDE_PANEL_WIDTH。
 * 服务器文件管理器与 B站下载弹窗共用。
 */
export function DirPickerSidePanel({
  open,
  loading,
  error,
  entries,
  currentPath,
  currentPathPlaceholder = '服务器根目录',
  isRoot,
  onEnter,
  onBack,
  onSelect,
  onClose,
}: DirPickerSidePanelProps) {
  return (
    <div
      className="flex-shrink-0 overflow-hidden"
      style={{
        width: open ? SIDE_PANEL_WIDTH : 0,
        maxWidth: open ? 'calc(100vw - 2rem)' : 0,
        transition: `width ${DURATION}ms var(--ease-out-expo), max-width ${DURATION}ms var(--ease-out-expo)`,
        willChange: 'width',
      }}
    >
      <div
        className="glass flex h-full max-h-[calc(100vh-160px)] flex-col overflow-hidden border-t border-[var(--glass-border)] p-3 md:border-l md:border-t-0"
        style={{ width: SIDE_PANEL_WIDTH, maxWidth: 'calc(100vw - 2rem)' }}
      >
        {/* 标题栏 */}
        <SectionHeader
          icon={<HardDrive className="h-4 w-4" />}
          title="选择目录"
          className="mb-2 shrink-0"
          extra={
            <button
              onClick={onClose}
              className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
            >
              <Check className="h-4 w-4" />
            </button>
          }
        />

        {/* 路径栏 + 返回 */}
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<ChevronLeft className="h-3.5 w-3.5" />}
            onClick={onBack}
            disabled={isRoot}
          >
            返回
          </Button>
          <Text
            className="min-w-0 flex-1 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]"
            title={currentPath}
          >
            {currentPath || currentPathPlaceholder}
          </Text>
        </div>

        {/* 目录列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner size={20} />
            </div>
          ) : error ? (
            <Text className="py-4 text-center text-xs text-[var(--md-sys-color-error)]">
              {error}
            </Text>
          ) : entries.length === 0 ? (
            <Text className="py-4 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
              无子目录
            </Text>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.key}
                onClick={() => onEnter(entry.key)}
                className="flex cursor-pointer items-center gap-2 rounded p-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
              >
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary-container)',
                    color: 'var(--md-sys-color-on-primary-container)',
                  }}
                >
                  {isRoot ? (
                    <HardDrive className="h-3.5 w-3.5" />
                  ) : (
                    <Folder className="h-3.5 w-3.5" />
                  )}
                </div>
                <span className="truncate text-sm">{entry.name}</span>
              </div>
            ))
          )}
        </div>

        {/* 选择当前目录按钮 */}
        {onSelect && !isRoot && currentPath && !loading && !error && (
          <Button
            variant="primary"
            size="sm"
            block
            className="mt-2 shrink-0"
            onClick={onSelect}
          >
            选择此目录
          </Button>
        )}
      </div>
    </div>
  )
}
