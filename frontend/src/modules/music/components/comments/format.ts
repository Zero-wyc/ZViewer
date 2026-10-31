import { t } from '@/i18n'
/**
 * 评论相对时间格式化（网易云毫秒 / B站 秒级 Unix 两种入参）。
 *
 * 两个面板原本各有一份逐行相同的实现，这里统一（语义与 Hydrogen
 * commentFormat.formatCommentTime 一致）。
 */

/** 相对时间（入参：毫秒时间戳） */
export function formatCommentTime(timestampMs: number): string {
  const ts = Number(timestampMs)
  if (!Number.isFinite(ts) || ts <= 0) return t('刚刚')
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day
  if (diff < minute) return t('刚刚')
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  if (diff < month) return `${Math.floor(diff / day)}天前`
  if (diff < year) return `${Math.floor(diff / month)}个月前`
  return `${Math.floor(diff / year)}年前`
}

/** 相对时间（入参：秒级 Unix 时间戳，B站 评论字段） */
export function formatCommentTimeFromSeconds(sec: number): string {
  return formatCommentTime(Number(sec) * 1000)
}
