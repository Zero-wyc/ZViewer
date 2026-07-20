import { useLocation } from 'react-router-dom'
import { useThemeStore } from '@/store/themeStore'
import { Header } from './Header'

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const {
    backgroundImage,
    backgroundBlur,
    backgroundOpacity,
    backgroundPositionX,
    backgroundPositionY,
    backgroundScale,
    backgroundRotate,
    reducedMotion,
    isDark,
  } = useThemeStore()

  return (
    <div
      className="relative flex min-h-screen flex-col"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      style={{
        backgroundColor: 'var(--md-sys-color-surface)',
        backgroundImage:
          'radial-gradient(circle at 10% 20%, color-mix(in srgb, var(--md-sys-color-primary) 6%, transparent) 0%, transparent 40%), radial-gradient(circle at 90% 80%, color-mix(in srgb, var(--md-sys-color-tertiary) 6%, transparent) 0%, transparent 40%)',
        color: 'var(--md-sys-color-on-surface)',
      }}
    >
      {/* 自定义背景图片层：缓慢呼吸动画 */}
      {/* 浅色主题且未设置自定义背景时，使用默认背景图片 */}
      {(backgroundImage || (!isDark && '/Nacho3.jpg')) && (
        <div
          className="fixed inset-0 -z-10 pointer-events-none zen-geo-breathe"
          style={{
            backgroundImage: `url(${backgroundImage || '/Nacho3.jpg'})`,
            backgroundSize: 'cover',
            backgroundPosition: `${backgroundPositionX}% ${backgroundPositionY}%`,
            filter: `blur(${backgroundBlur}px)`,
            opacity: backgroundImage
              ? backgroundOpacity
              : Math.min(backgroundOpacity, 0.85),
            transform: `scale(${backgroundScale}) rotate(${backgroundRotate}deg)`,
            animationDuration: '20s',
          }}
        />
      )}
      <Header />
      <main
        key={location.pathname}
        className="flex flex-1 flex-col zen-page-enter"
      >
        {children}
      </main>
    </div>
  )
}
