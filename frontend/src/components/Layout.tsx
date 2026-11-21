import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useThemeStore } from '@/store/themeStore'
import { useRoomStore } from '@/store/roomStore'
import { Header } from './Header'
import { InsecureContextBanner } from './InsecureContextBanner'
import { CommentFloatingWindow } from './CommentFloatingWindow'

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const {
    backgroundImage,
    backgroundBlur,
    listenTogetherBlur,
    backgroundOpacity,
    backgroundWhiteOverlay,
    backgroundBlackOverlay,
    backgroundPositionX,
    backgroundPositionY,
    backgroundScale,
    backgroundRotate,
    reducedMotion,
    disableHoverTransform,
  } = useThemeStore()
  // 一起听模式的背景模糊独立调节：仅听模式用 listenTogetherBlur，
  // 其余（一起看 / 投屏 / 普通页面）用通用 backgroundBlur
  const roomMode = useRoomStore((s) => s.mode)
  const effectiveBlur =
    roomMode === 'listen-together' ? listenTogetherBlur : backgroundBlur

  /**
   * 桌面端独立评论窗（壳用 iframe 加载 /room/:roomId/comments-window?desktopWindow=1）：
   * 整页要透出桌面，所以不画壁纸/遮罩层，body 的 surface 底色也临时设为透明，
   * 否则壳里的「背景不透明度」滑杆完全没效果。
   */
  const desktopCommentsShell =
    location.pathname.endsWith('/comments-window') &&
    new URLSearchParams(location.search).get('desktopWindow') === '1'

  useEffect(() => {
    if (!desktopCommentsShell) return undefined
    const prevColor = document.body.style.backgroundColor
    document.body.style.backgroundColor = 'transparent'
    return () => {
      document.body.style.backgroundColor = prevColor
    }
  }, [desktopCommentsShell])

  // 将禁用 hover 位移的开关挂到 document.body，使通过 portal 渲染的
  // 组件（下拉、弹窗等）同样受控，实现全局生效。
  useEffect(() => {
    document.body.dataset.noHoverTransform = disableHoverTransform
      ? 'true'
      : 'false'
    return () => {
      delete document.body.dataset.noHoverTransform
    }
  }, [disableHoverTransform])

  return (
    <div
      className="relative flex min-h-screen flex-col"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      style={{
        // 始终透明：由 body 的 surface 色作为最终底色，背景图 div 绘制在 body 之上。
        // 若此容器不透明，背景图 div 会被同色背景压住，glass-card 的 backdrop-filter
        // 只能模糊到 surface 纯色，视觉上"只有透明度没有模糊"。
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        color: 'var(--md-sys-color-on-surface)',
      }}
    >
      {/* 背景图片层：自定义背景或默认背景图，浅色/深色模式均显示；
          桌面端评论窗要透出桌面，整层不绘制 */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          display: desktopCommentsShell ? 'none' : undefined,
          zIndex: 0,
          backgroundImage: `url(${backgroundImage || '/Nacho3.jpg'})`,
          backgroundSize: 'cover',
          // 位置固定居中，偏移由 transform: translate 控制
          // （background-position 百分比在 cover 下当某方向无溢出时完全无效）
          backgroundPosition: 'center',
          filter: `blur(${effectiveBlur}px)`,
          opacity: backgroundImage
            ? backgroundOpacity
            : Math.min(backgroundOpacity, 0.85),
          // translate 在 scale/rotate 之前，避免缩放中心扩张吃掉偏移
          // 百分比除以 2 限制最大偏移为 ±50%，防止图片完全移出视口
          transform: `translate(${backgroundPositionX / 2}%, ${backgroundPositionY / 2}%) scale(${backgroundScale}) rotate(${backgroundRotate}deg)`,
        }}
      />

      {/* 白遮罩层：盖在背景图之上、内容层之下（玻璃卡片会采样到遮罩，
          视觉语义为「背景变亮」而非整页变亮）；强度 0 时不渲染 */}
      {!desktopCommentsShell && backgroundWhiteOverlay > 0 && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            zIndex: 0,
            backgroundColor: `rgba(255, 255, 255, ${backgroundWhiteOverlay})`,
          }}
        />
      )}
      {/* 黑遮罩层：同白遮罩，视觉语义为「背景变暗」；强度 0 时不渲染。
          两层同时开启时按文档顺序叠加（白在下、黑在上） */}
      {!desktopCommentsShell && backgroundBlackOverlay > 0 && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            zIndex: 0,
            backgroundColor: `rgba(0, 0, 0, ${backgroundBlackOverlay})`,
          }}
        />
      )}

      {/* 内容层：z-auto 不创建层叠上下文，允许后代 glass-card 的
          backdrop-filter 跨层采样到背景图（z-index: 0）。
          文档顺序保证内容仍在背景图之上，无需显式 z-index。 */}
      <div className="relative z-auto flex flex-1 flex-col">
        {/* 评论独立窗口不显示全局 Header:小窗空间宝贵,面板完整占满 */}
        {!location.pathname.endsWith('/comments-window') && <Header />}
        <main key={location.pathname} className="flex flex-1 flex-col">
          {children}
        </main>
      </div>

      {/* HTTP 非安全上下文提示横幅：仅在生产环境 HTTP 访问时显示 */}
      <InsecureContextBanner />

      {/* 评论悬浮窗：全局只挂一次，按 store 里的 roomId 显示 */}
      {!location.pathname.endsWith('/comments-window') && (
        <CommentFloatingWindow />
      )}
    </div>
  )
}
