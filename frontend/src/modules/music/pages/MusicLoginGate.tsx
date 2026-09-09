/**
 * 未登录提示卡（NCM 需登录的页面共用：每日推荐 / 私人漫游 / 我的音乐 / 云盘）。
 *
 * Hydrogen 登录门范式：居中图标 + 提示文案 + 扫码登录按钮
 * （按钮经 store.loginModalOpen 打开 MusicAppShell 的共享登录弹窗）。
 */
import { UserRound } from 'lucide-react'
import { useMusicStore } from '../store'

export function MusicLoginGate({ hint }: { hint?: string }) {
  const setLoginModalOpen = useMusicStore((s) => s.setLoginModalOpen)
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
        }}
      >
        <UserRound
          className="h-7 w-7 opacity-50"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        />
      </div>
      <span className="text-base font-medium text-[var(--md-sys-color-on-surface)]">
        请先登录网易云音乐
      </span>
      {hint && (
        <span className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
          {hint}
        </span>
      )}
      <button
        type="button"
        className="mt-1 px-4 py-1.5 text-sm font-medium text-[var(--md-sys-color-surface)] transition-opacity hover:opacity-80"
        style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
        onClick={() => setLoginModalOpen(true)}
      >
        扫码登录
      </button>
    </div>
  )
}

/** 页面区块头（黑底白字 EN 小标 + 灰色延伸线，与首页 RecBlock 同范式） */
export function PageBlockHeader({
  titleEN,
  titleCN,
  children,
}: {
  titleEN: string
  titleCN: string
  /** 头部右侧附加内容（如刷新按钮） */
  children?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center">
        <span
          className="mr-1.5 w-[20vw] min-w-[140px] shrink-0 py-px pl-1 text-[10px] font-bold uppercase tracking-widest"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            color: 'var(--md-sys-color-surface)',
            whiteSpace: 'nowrap',
          }}
        >
          {titleEN}
        </span>
        <span
          className="h-px flex-1"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 30%, transparent)',
          }}
        />
        {children}
      </div>
      <h3 className="mt-1 text-2xl font-bold leading-relaxed text-[var(--md-sys-color-on-surface)]">
        {titleCN}
      </h3>
    </div>
  )
}
