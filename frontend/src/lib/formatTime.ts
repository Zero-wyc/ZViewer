/**
 * 时间格式化工具。
 */

/**
 * 格式化创建时间：<24h 显示相对时间（刚刚 / X分钟前 / X小时X分钟前），
 * ≥24h 显示准确本地时间。用于房间列表、管理后台房间卡片等
 * 「新鲜度优先」的展示场景。
 *
 * @param iso ISO 时间字符串
 */
export function formatRecentTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs >= 24 * 60 * 60 * 1000) {
    return new Date(iso).toLocaleString('zh-CN')
  }
  const totalMinutes = Math.floor(diffMs / 60000)
  if (totalMinutes < 1) return '刚刚'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}分钟前`
  return minutes > 0 ? `${hours}小时${minutes}分钟前` : `${hours}小时前`
}
