/**
 * cloud-add-in 系弹窗统一外壳：遮罩 + 面板 + 进/出动画一处维护。
 *
 * 此前 6 处弹窗（歌词页设置 PlayerSettingsModal、添加到我的歌单
 * AddToPlaylistModal、网易云搜索 NcmSearchModal、B站 收藏夹选择
 * BiliFavCollectModal、B站 页添加栏目/标签规则/屏蔽词三处）各自接线
 * 同一套动画逻辑（遮罩、面板动画、onAnimationEnd、Esc、展开标记），
 * 2026-09-24 起收敛到本组件，后期调行为只改这里。
 *
 * 统一动画行为：
 * - 进入：遮罩压暗渐显（lt-modal-dim-in 0.35s）+ 面板 cloud-add-in
 *   宽→高两段式展开（默认 0.4s 0.1s，Hydrogen .playlist-container-in
 *   复刻；「添加到我的歌单」传 0.6/0.3 保留原节奏）
 * - 退出：遮罩压暗渐隐（lt-modal-dim-out 0.3s）+ 面板 cloud-add-out
 *   反向收起（0.4s）；收起动画结束（onAnimationEnd）才真正回调
 *   onClose 卸载
 * - prefers-reduced-motion：动画类失效，退出由 useModalDismissAnimation
 *   的 450ms 兜底保证（否则弹窗会卡死无法关闭）
 *
 * Backdrop Root 约束（项目已多次踩坑）：遮罩是独立兄弟层级、无
 * backdrop-filter 后代，opacity 动画安全；面板动画只动宽高（cloud-add-in/
 * out），不动 opacity/transform——不破坏自身 backdrop-filter 的采样。
 *
 * 用法（内容延后挂载 + 顶层程序化关闭）：
 *   const modalRef = useRef<CloudModalHandle>(null)
 *   <CloudModal ref={modalRef} open={open}
 *     width="min(340px, calc(100vw - 32px))"
 *     height="min(674px, calc(100vh - 120px))"
 *     onClose={() => setOpen(false)}>
 *     {(unfoldDone) => (
 *       <>
 *         <标题行（常显） />
 *         {unfoldDone && <内容（展开动画结束后才挂载，动画期间零渲染） />}
 *       </>
 *     )}
 *   </CloudModal>
 *   // 顶层逻辑关闭（提交/收藏成功后等）：modalRef.current?.requestClose()
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { useModalDismissAnimation } from '../hooks/useModalDismissAnimation'

/** 命令式句柄：顶层逻辑（提交/收藏成功等）触发带退出动画的关闭 */
export interface CloudModalHandle {
  requestClose: () => void
}

export interface CloudModalProps {
  /** 受控开关：条件渲染可不传（默认 true）；open-prop 常驻弹窗必须传，
   *  重开时组件自动复位退出态与内容挂载闸门 */
  open?: boolean
  /** 面板宽（CSS 值，同时注入 --add-panel-w 供收起动画用） */
  width: string
  /** 面板高（CSS 值，同时注入 --add-panel-h 供展开/收起动画用） */
  height: string
  /** 面板 z-index（遮罩为 zIndex-1）；默认 75（dark 系弹窗既有层级） */
  zIndex?: number
  /** center=屏幕居中（默认）| bottom=底部锚定播放条上方（添加到歌单） */
  anchor?: 'center' | 'bottom'
  /** dark=黑底高斯模糊（SETTING 风，默认）| glass=glass-card 主题自适应 */
  variant?: 'dark' | 'glass'
  /** inner=内沿白色方块（dark 默认）| flash=外沿闪烁方块（glass 默认，
   *  Hydrogen .add-style 复刻）| false 无装饰 */
  corners?: 'inner' | 'flash' | false
  /** 遮罩点击/Esc 关闭守卫（提交中禁关等）；ref.requestClose 不受限。
   *  默认 true */
  canClose?: boolean
  /** 面板展开动画秒数与延迟（默认 0.4/0.1；Hydrogen 添加到歌单 0.6/0.3） */
  unfoldDuration?: number
  unfoldDelay?: number
  /** portal 到 body：祖先带 transform（fixed 变相对定位）或
   *  backdrop-filter（成为 Backdrop Root 使面板模糊失效）时必须
   *  （B站 收藏夹 / 添加到歌单弹窗既有做法的统一化） */
  portal?: boolean
  onClose: () => void
  /** 内容：传函数时以 unfoldDone（展开动画已结束）作内容延后挂载闸门 */
  children?: ReactNode | ((unfoldDone: boolean) => ReactNode)
}

export const CloudModal = forwardRef<CloudModalHandle, CloudModalProps>(
  function CloudModal(
    {
      open = true,
      width,
      height,
      zIndex = 75,
      anchor = 'center',
      variant = 'dark',
      corners,
      canClose = true,
      unfoldDuration = 0.4,
      unfoldDelay = 0.1,
      portal = false,
      onClose,
      children,
    },
    ref
  ) {
    // 退出动画中间态：requestClose 置 closing → 遮罩压暗淡出 + 面板
    // cloud-add-out 反向收起，收起结束（onAnimationEnd）才真正 onClose
    // 卸载；450ms 兜底防 reduced-motion 卡死（见 hook 注释）。幂等。
    const { closing, requestClose, resetClose } =
      useModalDismissAnimation(onClose)
    /** 面板展开动画是否已结束（children 函数的内容挂载闸门） */
    const [unfoldDone, setUnfoldDone] = useState(false)

    // open-prop 常驻弹窗（open=false 仅 return null、组件不卸载）重开时
    // 复位退出态与内容闸门；setTimeout(0) 规避 effect 内同步 setState
    // （react-hooks/set-state-in-effect，各弹窗既有复位同模式）
    useEffect(() => {
      if (!open) return
      const timer = window.setTimeout(() => {
        resetClose()
        setUnfoldDone(false)
      }, 0)
      return () => window.clearTimeout(timer)
    }, [open, resetClose])

    useImperativeHandle(ref, () => ({ requestClose }), [requestClose])

    // Esc 关闭（统一行为；提交中等 canClose=false 场景忽略）
    useEffect(() => {
      if (!open) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && canClose) requestClose()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [open, canClose, requestClose])

    if (!open) return null

    // corners 未显式指定时随 variant 取默认装饰
    const cornerFlash =
      corners === undefined
        ? variant === 'glass'
          ? 'flash'
          : 'inner'
        : corners

    // CSS 变量（--add-panel-*）不在 CSSProperties 键集内，整体断言注入
    const panelStyle = {
      ...(anchor === 'bottom'
        ? {
            left: '50%',
            bottom: 124,
            transform: 'translateX(-50%)',
          }
        : {
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }),
      zIndex,
      width,
      height,
      '--add-panel-w': width,
      '--add-panel-h': height,
      animation: closing
        ? 'cloud-add-out 0.4s forwards'
        : `cloud-add-in ${unfoldDuration}s ${unfoldDelay}s both`,
      ...(variant === 'dark'
        ? {
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          }
        : {}),
    } as unknown as React.CSSProperties

    const panel = (
      <>
        {/* 遮罩（黑半透明压暗，点击关闭；打开渐进压暗、关闭渐进退出压暗）。
            独立兄弟层级、无 backdrop-filter 后代，opacity 动画安全 */}
        <button
          type="button"
          aria-label="关闭"
          className={cn(
            'fixed inset-0 cursor-default bg-black/40',
            closing ? 'lt-modal-dim-out' : 'lt-modal-dim-in'
          )}
          style={{ zIndex: zIndex - 1 }}
          onClick={() => {
            if (canClose) requestClose()
          }}
        />
        {/* 面板：cloud-add-in 宽→高展开 / cloud-add-out 反向收起；动画
            只动宽高（不动 opacity/transform/filter），自身 backdrop-filter
            采样不受 Backdrop Root 影响 */}
        <div
          className={cn(
            'fixed flex flex-col',
            variant === 'dark' && 'overflow-hidden',
            variant === 'glass' && 'glass-card',
            closing && 'pointer-events-none'
          )}
          style={panelStyle}
          onAnimationEnd={(e) => {
            // 仅认面板自身的展开/收起动画（子元素动画 end 会冒泡上来，
            // 按 target 过滤）
            if (e.target !== e.currentTarget) return
            if (e.animationName === 'cloud-add-in') {
              setUnfoldDone(true)
            } else if (e.animationName === 'cloud-add-out') {
              onClose()
            }
          }}
        >
          {cornerFlash === 'inner' && (
            <>
              {/* 四角白色方块点缀（Hydrogen 弹窗同款装饰） */}
              <span
                aria-hidden="true"
                className="absolute left-2 top-2 z-[2] h-2 w-2 bg-white"
              />
              <span
                aria-hidden="true"
                className="absolute right-2 top-2 z-[2] h-2 w-2 bg-white"
              />
              <span
                aria-hidden="true"
                className="absolute bottom-2 left-2 z-[2] h-2 w-2 bg-white"
              />
              <span
                aria-hidden="true"
                className="absolute bottom-2 right-2 z-[2] h-2 w-2 bg-white"
              />
            </>
          )}
          {cornerFlash === 'flash' && (
            <>
              {/* 四角闪烁方块（Hydrogen .add-style 复刻：0.4s 高频闪烁后
                  常显，一次性；面板外缘 -4px——glass 面板不设
                  overflow-hidden，置于内容裁剪层之外不被裁掉） */}
              {(
                [
                  '-left-1 -top-1',
                  '-right-1 -top-1',
                  '-bottom-1 -left-1',
                  '-bottom-1 -right-1',
                ] as const
              ).map((pos) => (
                <span
                  key={pos}
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute z-[3] h-[9px] w-[9px]',
                    pos
                  )}
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--md-sys-color-on-surface) 85%, transparent)',
                    animation: closing
                      ? 'lt-modal-dim-out 0.3s forwards'
                      : 'cloud-add-flash 0.4s both',
                  }}
                />
              ))}
            </>
          )}
          {typeof children === 'function' ? children(unfoldDone) : children}
        </div>
      </>
    )

    return portal ? createPortal(panel, document.body) : panel
  }
)
