/** 保存过的本地音量优先；无效值使用服务器默认百分比（缺省 50%）。 */
export function initialMusicVolume(
  saved: string | null,
  defaultPercent = 50
): number {
  const fallback =
    Number.isFinite(defaultPercent) &&
    defaultPercent >= 0 &&
    defaultPercent <= 100
      ? defaultPercent / 100
      : 0.5
  if (saved == null || saved.trim() === '') return fallback
  const value = Number(saved)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}
