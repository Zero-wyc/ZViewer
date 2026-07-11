import { Header } from './Header'

export function Layout({ children }: { children: React.ReactNode }) {
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
      <Header />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  )
}
