import { useThemeStore } from '@/store/themeStore'
import { Header } from './Header'

export function Layout({ children }: { children: React.ReactNode }) {
  const {
    backgroundImage,
    backgroundBlur,
    backgroundOpacity,
    backgroundPositionX,
    backgroundPositionY,
    backgroundScale,
    backgroundRotate,
  } = useThemeStore()

  return (
    <div
      className="relative flex min-h-screen flex-col"
      style={{
        backgroundColor: 'var(--md-sys-color-surface)',
        backgroundImage:
          'radial-gradient(circle at 10% 20%, color-mix(in srgb, var(--md-sys-color-primary) 6%, transparent) 0%, transparent 40%), radial-gradient(circle at 90% 80%, color-mix(in srgb, var(--md-sys-color-tertiary) 6%, transparent) 0%, transparent 40%)',
        color: 'var(--md-sys-color-on-surface)',
      }}
    >
      {/* 自定义背景图片层 */}
      {backgroundImage && (
        <div
          className="fixed inset-0 -z-10 pointer-events-none"
          style={{
            backgroundImage: `url(${backgroundImage})`,
            backgroundSize: 'cover',
            backgroundPosition: `${backgroundPositionX}% ${backgroundPositionY}%`,
            filter: `blur(${backgroundBlur}px)`,
            opacity: backgroundOpacity,
            transform: `scale(${backgroundScale}) rotate(${backgroundRotate}deg)`,
          }}
        />
      )}
      <Header />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  )
}
