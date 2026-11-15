// 画布超采样倍率。
//
// 为什么不跟 devicePixelRatio 走：Live2D 本质是「把一张贴图用网格变形后画
// 出来」，模型被放大到 42% 视口高之后，边缘质量完全取决于采样密度。dpr=1 的
// 显示器上按 1x 渲染，4096 的贴图会被压成一层柔光——用户看到的就是「精度
// 太低」。所以按「总像素预算」给倍率：小窗口多采一点，大窗口少采一点，显存
// 与填充率的开销基本恒定。
//
// 上限 2x 兜住大视口，免得 4K 窗口把填充率吃穿；下限 1x 保证不比按点对点渲染
// 更糊。

/** 预算：约 400 万像素（1440×900 → 1.8x，1080p → 1.4x）。 */
export const LIVE2D_RENDER_PIXEL_BUDGET = 4_200_000
/** 倍率上限：再高只是白烧填充率。 */
export const LIVE2D_RENDER_MAX_RESOLUTION = 2

export function resolutionForViewport(
  width: number,
  height: number,
  budget = LIVE2D_RENDER_PIXEL_BUDGET
): number {
  // 尺寸取不到（0 / NaN）时按 720p 算：宁可给一个中等的倍率，也不要算出
  // Infinity 把 canvas 撑爆。
  const w = Number.isFinite(width) && width > 0 ? width : 1280
  const h = Number.isFinite(height) && height > 0 ? height : 720
  const ratio = Math.sqrt(budget / Math.max(1, w * h))
  return Math.min(LIVE2D_RENDER_MAX_RESOLUTION, Math.max(1, ratio))
}

/**
 * 倍率变了要不要真的重设。
 *
 * 改倍率会重建 framebuffer（清空 + 重新分配），窗口拖动时每像素改一次等于
 * 每秒重建几十次。跨过这个档位才动。
 */
export const LIVE2D_RESOLUTION_STEP = 0.25

export function shouldUpdateResolution(current: number, next: number): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(next)) return false
  return Math.abs(current - next) >= LIVE2D_RESOLUTION_STEP
}
