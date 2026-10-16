import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 格式化秒数为可读时长（mm:ss 或 h:mm:ss）。
 * 用于播放器进度、跳转提示等场景。
 * @param placeholder 无效输入（NaN/负数/0）时返回的占位文案
 */
export function formatDuration(seconds: number, placeholder = '00:00'): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return placeholder
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = m.toString().padStart(2, '0')
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * 格式化毫秒时长（对齐音乐 Hydrogen songTime 语义）：
 * mm:ss，超过 1 小时 → h:mm:ss；无效输入返回占位文案（默认 --:--）。
 */
export function formatDurationMs(ms: number, placeholder = '--:--'): string {
  if (!Number.isFinite(ms) || ms <= 0) return placeholder
  return formatDuration(Math.floor(ms / 1000), placeholder)
}

/**
 * 格式化字节数为人类可读的文件大小。
 */
export function formatFileSize(size?: number | null): string {
  if (size === undefined || size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 格式化 ISO 时间字符串为本地可读时间（HH:mm:ss）。
 */
export function formatIsoTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
