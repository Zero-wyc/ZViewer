import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Hand,
  Move,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/i18n'
import type { ModelExpressionEntry } from '../core/model-meta'

// 右键角色弹出的**快捷菜单**。
//
// 它只放"看片时想顺手改一下"的东西：表情、大小、动捕开关、拖拽位置。
// 模型选择不在里面——那是一个带清单、上传、删除、自定义地址的面板，贴在光标
// 上会盖掉半屏画面，而且和设置弹窗里的同一份功能重复投影（以前两边各有一份，
// 状态参数要在两处搬三十多个，改一处忘一处就是 bug）。
//
// 为什么是右键而不是一个常驻按钮：这套设置只跟「我自己的角色」有关，而角色
// 本身就在画面里——对着它右键是最短的路径。右下角另有常驻圆钮兜底（模型加载
// 失败、命中漏判时右键打不中），两者都指向同一个「角色设置」。
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
  /** 挂载容器（原生全屏时要进全屏子树，见 Live2DSettingsModal 的说明） */
  container?: HTMLElement | null
  /** 当前生效模型的显示名（统一角色时是房间定的那个） */
  modelLabel: string
  expressions: ModelExpressionEntry[]
  myScale: number
  faceTracking: { on: boolean; busy: boolean; error: string }
  /** 房主是否允许成员开动捕 */
  allowFace: boolean
  /** 房主已统一角色：模型换不了，这里只说明一句 */
  unified: boolean
  /**
   * 我已删除自己的角色。
   *
   * 删除后右键其实打不到任何模型（画面上没有角色），所以这里大概率恒为
   * false；留着它是为了让菜单永远是"当前真实状态"的投影——占位卡、将来的
   * 名册入口都能复用它，不必各自维护一份"已删除"的判断。
   */
  removed: boolean
  /** 能否删除自己的角色（统一角色时不能；已删除时入口不出现） */
  canRemove: boolean
  /** 有角色才能拖（没模型时整个入口置灰） */
  canDrag: boolean
  /** 拖拽模式是否正在进行（决定这个入口是「进入」还是「退出」） */
  dragMode: boolean
  /** 已经挪过位置，才显示「回到原位」 */
  canResetPosition: boolean
  onScale: (scale: number) => void
  onExpression: (index: number) => void
  onToggleFaceTracking: () => void
  /** 进「角色设置」（换模型、上传、房间策略都在那一处） */
  onOpenSettings: () => void
  onToggleDrag: () => void
  onResetPosition: () => void
  onRemove: () => void
  /**
   * 右键的是**别人的**角色。
   *
   * 菜单随之切成「对他」的形态，只有互动动作。以前不管点到谁都是「我的角色」：
   * 在别人的角色上右键，却看到自己的模型名和自己的大小滑杆。
   */
  peer?: { name: string; onPoke: () => void } | null
}

const MENU_WIDTH = 264
/** 估算高度只用于「别超出视口下沿」；实际高度由内容决定并可滚动。 */
const MENU_HEIGHT_GUESS = 380
/** 「别人的角色」菜单只有标题 + 一个动作，高度估算单独给一个小值。 */
const PEER_MENU_HEIGHT_GUESS = 96

export function Live2DContextMenu({
  open,
  position,
  onClose,
  container,
  modelLabel,
  expressions,
  myScale,
  faceTracking,
  allowFace,
  unified,
  removed,
  canRemove,
  canDrag,
  dragMode,
  canResetPosition,
  onScale,
  onExpression,
  onToggleFaceTracking,
  onOpenSettings,
  onToggleDrag,
  onResetPosition,
  onRemove,
  peer = null,
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

  // 「别人的角色」只有一行，位置按小面板夹紧；早返回而不是在同一個 JSX 里分支，
  // 是为了让「我的角色」那份菜单保持原样（分支会让整段代码重新缩进，
  // 每次改一行都变成几百行的 diff）。
  if (peer) {
    const peerLeft = Math.min(
      Math.max(8, position.x),
      Math.max(8, window.innerWidth - MENU_WIDTH - 8)
    )
    const peerTop = Math.min(
      Math.max(8, position.y),
      Math.max(8, window.innerHeight - PEER_MENU_HEIGHT_GUESS - 8)
    )
    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('角色互动')}
        data-live2d-menu=""
        className="glass-strong pointer-events-auto fixed z-[120] rounded-[var(--md-sys-shape-corner)] p-2.5"
        style={{
          left: peerLeft,
          top: peerTop,
          width: MENU_WIDTH,
          color: 'var(--md-sys-color-on-surface)',
          boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.45)',
        }}
      >
        <div className="mb-1.5 flex items-center justify-between">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
            <Sparkles
              size={13}
              className="shrink-0"
              style={{ color: 'var(--md-sys-color-primary)' }}
            />
            <span className="truncate">{peer.name || t('对方的角色')}</span>
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
        <MenuAction onClick={peer.onPoke} icon={<Hand size={13} />}>
          {t('戳一下')}
        </MenuAction>
      </div>,
      container ?? document.body
    )
  }

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

      {/* 当前模型只显示名字 + 一个入口：选模型需要清单、上传、删除，属于
          设置面板的活。把"我现在是什么"留在菜单里，是为了改表情/大小时
          知道自己改的是哪个角色。 */}
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] opacity-70">
          {unified
            ? t('模型由房主统一：{{name}}', {
                name: modelLabel || t('未知模型'),
              })
            : modelLabel || t('还没有选模型')}
        </span>
        {!unified && (
          // 用小的文字按钮而不是 MenuAction：后者是 flex-1 的（底部那一排
          // 平分宽度），放在这一行会把模型名挤成一半。
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80"
            style={{
              background: 'var(--md-sys-color-surface)',
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
          >
            {t('更换')}
          </button>
        )}
      </div>

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
                disabled={removed && !unified}
                title={t('所有人都会看到')}
                className="max-w-full truncate rounded-md border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
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
        aria-label={t('模型大小')}
      />

      <Divider />

      <div className="flex items-center justify-between gap-2 py-0.5">
        <span className="flex min-w-0 flex-col">
          <span className="text-[11px]">{t('摄像头动捕')}</span>
          <span className="truncate text-[10px] opacity-50">
            {faceTracking.busy
              ? t('正在启动…')
              : !allowFace
                ? t('房主已关闭成员动捕')
                : faceTracking.on
                  ? t('画面只在本机处理，不会上传')
                  : t('开启后角色会跟着你的头部转动')}
          </span>
        </span>
        <Switch
          checked={faceTracking.on}
          disabled={!allowFace || faceTracking.busy || (removed && !unified)}
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
        <MenuAction onClick={onOpenSettings} icon={<Settings2 size={13} />}>
          {t('角色设置')}
        </MenuAction>
        {/* 只有「删除」一个方向：删除后画面上没有角色，右键也打不到它；
            想再要有角色就从设置里的模型列表重新选一个（选中即恢复）。 */}
        {canRemove && (
          <MenuAction
            onClick={onRemove}
            icon={<Trash2 size={13} />}
            danger
            title={t('删除后房间里所有人（包括你）都看不到你的角色')}
          >
            {t('删除角色')}
          </MenuAction>
        )}
      </div>
      {removed && (
        <p className="mt-1.5 text-[10px] leading-snug opacity-50">
          {t('角色已删除，在角色设置里选一个模型即可恢复')}
        </p>
      )}
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
  danger,
  children,
}: {
  onClick: () => void
  icon: React.ReactNode
  title?: string
  disabled?: boolean
  /** 破坏性动作（删除角色）：用错误色，和普通入口区分开 */
  danger?: boolean
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
        color: danger ? 'var(--md-sys-color-error)' : undefined,
      }}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}
