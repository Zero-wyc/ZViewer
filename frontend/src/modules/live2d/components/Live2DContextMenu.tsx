import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Eye,
  EyeOff,
  Move,
  RotateCcw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/i18n'
import type { Live2DModelEntry } from '../core/model-catalog'
import type { ModelExpressionEntry } from '../core/model-meta'
import type { Live2DLibraryEntry } from '../core/model-library'
import type { Live2DModelKind } from '../types'
import { Live2DModelPicker } from './Live2DModelPicker'

// 右键角色弹出的快捷菜单。
//
// 为什么是右键而不是一个常驻按钮：这套设置只跟「我自己的角色」有关，而角色
// 本身就在画面里——对着它右键是最短的路径，也不必为它长期占一块界面。
//
// 位置与视觉沿用房间页的玻璃语言（glass-strong + --md-sys-color-*），与
// 视频统计菜单同一套写法：portal 到 body、fixed 定位、按视口夹紧。
//
// z-[120] 是算出来的：视频控制条 80、评论浮层 85、一起听面板 100；
// 全屏时宿主自己被抬到 110，菜单必须再高一层。

export interface Live2DContextMenuProps {
  open: boolean
  /** 光标位置（视口坐标） */
  position: { x: number; y: number }
  onClose: () => void
  /** 挂载容器（原生全屏时要进全屏子树，见 Live2DAdvancedSettings 的说明） */
  container?: HTMLElement | null
  builtins: Live2DModelEntry[]
  libraryModels: Live2DLibraryEntry[]
  expressions: ModelExpressionEntry[]
  myKind: Live2DModelKind
  myModelId: string
  myScale: number
  faceTracking: { on: boolean; busy: boolean; error: string }
  /** 房主是否允许成员开动捕 */
  allowFace: boolean
  /** 房主已统一角色：选模型这一段换成说明 */
  unified: boolean
  /**
   * 我在本房间隐藏了自己的角色。
   *
   * 隐藏时右键其实打不到任何模型（画面上没有角色），所以这里大概率恒为
   * false；留着它是为了让菜单永远是"当前真实状态"的投影——占位卡、将来的
   * 名册入口都能复用它，不必各自维护一份"隐藏中"的判断。
   */
  hidden: boolean
  /** 能否在隐藏/显示之间切换（统一角色时不能） */
  canToggleVisibility: boolean
  /** 有角色才能拖（没模型时整个入口置灰） */
  canDrag: boolean
  /** 拖拽模式是否正在进行（决定这个入口是「进入」还是「退出」） */
  dragMode: boolean
  /** 已经挪过位置，才显示「回到原位」 */
  canResetPosition: boolean
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  onScale: (scale: number) => void
  onExpression: (index: number) => void
  onToggleFaceTracking: () => void
  onOpenAdvanced: () => void
  onToggleDrag: () => void
  onResetPosition: () => void
  onHide: () => void
  onShow: () => void
}

const MENU_WIDTH = 272
/** 估算高度只用于「别超出视口下沿」；实际高度由内容决定并可滚动。 */
const MENU_HEIGHT_GUESS = 500

export function Live2DContextMenu({
  open,
  position,
  onClose,
  container,
  builtins,
  libraryModels,
  expressions,
  myKind,
  myModelId,
  myScale,
  faceTracking,
  allowFace,
  unified,
  hidden,
  canToggleVisibility,
  canDrag,
  dragMode,
  canResetPosition,
  onSelect,
  onScale,
  onExpression,
  onToggleFaceTracking,
  onOpenAdvanced,
  onToggleDrag,
  onResetPosition,
  onHide,
  onShow,
}: Live2DContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 关闭时机：点到菜单外面、按 ESC、窗口尺寸/滚动变化（位置会跟内容脱节）。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // capture：房间里的按钮普遍 stopPropagation，冒泡阶段收不到
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [open, onClose])

  if (!open) return null

  const left = Math.min(
    Math.max(8, position.x),
    Math.max(8, window.innerWidth - MENU_WIDTH - 8)
  )
  const top = Math.min(
    Math.max(8, position.y),
    Math.max(8, window.innerHeight - MENU_HEIGHT_GUESS - 8)
  )

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('角色设置')}
      data-live2d-menu=""
      className="glass-strong pointer-events-auto fixed z-[120] overflow-y-auto rounded-[var(--md-sys-shape-corner)] p-2.5 hide-scrollbar"
      style={{
        left,
        top,
        width: MENU_WIDTH,
        maxHeight: `min(70vh, ${window.innerHeight - 16}px)`,
        color: 'var(--md-sys-color-on-surface)',
        boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.45)',
      }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Sparkles
            size={13}
            style={{ color: 'var(--md-sys-color-primary)' }}
          />
          {t('我的角色')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('关闭')}
          className="rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          <X size={13} />
        </button>
      </div>

      {unified ? (
        <p className="mb-2 text-[11px] leading-relaxed opacity-60">
          {t('房主已统一角色，全房间使用同一个模型')}
        </p>
      ) : (
        <div className="mb-2">
          <Live2DModelPicker
            builtins={builtins}
            libraryModels={libraryModels}
            value={{ kind: myKind, id: myModelId }}
            onSelect={onSelect}
            allowUrl={false}
            compact
          />
        </div>
      )}

      <Divider />

      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide opacity-55">
        <span>{t('大小')}</span>
        <span className="tabular-nums">{Math.round(myScale * 100)}%</span>
      </div>
      <Slider
        min={0.5}
        max={2}
        step={0.05}
        value={myScale}
        showValue={false}
        onChange={onScale}
        size="sm"
        disabled={unified}
        aria-label={t('模型大小')}
      />

      {expressions.length > 0 && (
        <>
          <Divider />
          <p className="mb-1 text-[10px] uppercase tracking-wide opacity-55">
            {t('表情')}
          </p>
          <div className="flex flex-wrap gap-1">
            {expressions.map((item) => (
              <button
                key={item.index}
                type="button"
                onClick={() => onExpression(item.index)}
                title={t('所有人都会看到')}
                className="max-w-full truncate rounded-md border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80"
                style={{
                  background: 'var(--md-sys-color-surface)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                {item.name || t('表情 {{index}}', { index: item.index + 1 })}
              </button>
            ))}
          </div>
        </>
      )}

      <Divider />

      <div className="flex items-center justify-between gap-2 py-0.5">
        <span className="flex min-w-0 flex-col">
          <span className="text-[11px]">{t('摄像头动捕')}</span>
          <span className="truncate text-[10px] opacity-50">
            {faceTracking.busy
              ? t('正在启动…')
              : allowFace
                ? t('画面只在本机处理，不会上传')
                : t('房主已关闭成员动捕')}
          </span>
        </span>
        <Switch
          checked={faceTracking.on}
          disabled={!allowFace || faceTracking.busy}
          onChange={onToggleFaceTracking}
          aria-label={t('摄像头动捕')}
        />
      </div>
      {faceTracking.error && (
        <p
          className="mt-1 text-[10px] leading-snug"
          style={{ color: 'var(--md-sys-color-error)' }}
        >
          {faceTracking.error}
        </p>
      )}

      <Divider />

      {/* 拖拽模式：拖完不会自己退出（用户往往要来回调），所以入口与退出
          分开放——这里只负责「进入」，退出交给拖拽层上的「完成」/ ESC。 */}
      <div className="mb-1 flex items-center gap-1">
        <MenuAction
          onClick={onToggleDrag}
          disabled={!canDrag && !dragMode}
          icon={<Move size={13} />}
          title={t('开启后可直接拖动角色调整位置')}
        >
          {dragMode ? t('退出拖拽模式') : t('拖拽模式')}
        </MenuAction>
        {canResetPosition && (
          <MenuAction
            onClick={onResetPosition}
            icon={<RotateCcw size={13} />}
            title={t('回到默认站位')}
          >
            {t('回到原位')}
          </MenuAction>
        )}
      </div>

      <Divider />

      <div className="flex items-center gap-1">
        <MenuAction onClick={onOpenAdvanced} icon={<Settings2 size={13} />}>
          {t('高级设置')}
        </MenuAction>
        {/* 一个入口，两个方向：隐藏之后同一处就是「显示角色」。以前隐藏会把
            模型选择清空，这个入口随即整条消失，用户只能去模型列表里"换一个"
            才能让角色回来。 */}
        {canToggleVisibility && (
          <MenuAction
            onClick={hidden ? onShow : onHide}
            icon={hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            title={hidden ? t('重新显示角色') : t('隐藏角色')}
          >
            {hidden ? t('显示角色') : t('隐藏角色')}
          </MenuAction>
        )}
      </div>
    </div>,
    container ?? document.body
  )
}

function Divider() {
  return (
    <div
      className="my-2 h-px w-full"
      style={{
        background: 'var(--md-sys-color-outline-variant)',
        opacity: 0.6,
      }}
    />
  )
}

function MenuAction({
  onClick,
  icon,
  title,
  disabled,
  children,
}: {
  onClick: () => void
  icon: React.ReactNode
  title?: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: 'var(--md-sys-color-surface)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}
