// 指针坐标的纯函数（单测覆盖）。
//
// 为什么不直接把 clientX/clientY 发过去：各端窗口比例不同，16:9 的客户端
// 收到 4:3 客户端的 (0.9, 0.5)，如果原样用会让模型朝「屏幕右上角」而不是
// 「对方的右前方」。这里按宽高比压缩偏移量，保证**视线方向角**一致。

export interface PointerSample {
  x: number
  y: number
  /** 发送端视口宽高比 width / height */
  ar: number
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** 视口坐标 → 归一化 + 宽高比。 */
export function normalizePointer(
  clientX: number,
  clientY: number,
  width: number,
  height: number
): PointerSample {
  const w = Number.isFinite(width) && width > 0 ? width : 1
  const h = Number.isFinite(height) && height > 0 ? height : 1
  return {
    x: clamp01(clientX / w),
    y: clamp01(clientY / h),
    ar: w / h,
  }
}

/**
 * 把发送端的归一化坐标映射到本端归一化坐标。
 *
 * 规则：以画面中心为原点，按「本端/发送端」较窄的那个方向等比缩放，
 * 这样同一个方向角在两种比例下都指向同一个角度（而不是同一个像素）。
 */
export function mapPointerToAspect(
  p: PointerSample,
  targetAr: number
): { x: number; y: number } {
  const srcAr = Number.isFinite(p.ar) && p.ar > 0 ? p.ar : 1
  const dstAr = Number.isFinite(targetAr) && targetAr > 0 ? targetAr : srcAr
  let x = clamp01(p.x)
  let y = clamp01(p.y)
  if (srcAr >= dstAr) {
    // 对方更宽：横向偏移按比例压缩
    x = 0.5 + (x - 0.5) * (dstAr / srcAr)
  } else {
    // 对方更高：纵向偏移按比例压缩
    y = 0.5 + (y - 0.5) * (srcAr / dstAr)
  }
  return { x: clamp01(x), y: clamp01(y) }
}

/**
 * 指数平滑：把 10Hz 的台阶磨成连续运动。
 *
 * alpha 与帧率相关，调用方按 delta 归一（见 renderer 里的 alphaForDelta）。
 */
export function smooth(current: number, target: number, alpha: number): number {
  const a = clamp01(alpha)
  if (!Number.isFinite(current)) return target
  if (!Number.isFinite(target)) return current
  return current + (target - current) * a
}

/** 把与帧率无关的 alpha 折算成本帧可用的值。 */
export function alphaForDelta(alpha60: number, deltaMS: number): number {
  const frames = Math.max(0.2, Math.min(4, deltaMS / (1000 / 60)))
  return clamp01(1 - Math.pow(1 - clamp01(alpha60), frames))
}

/** 发送前压缩精度：3 位小数足够（1/1000 屏宽约 1px），能显著缩小载荷。 */
export function roundCoord(v: number, digits = 3): number {
  const p = Math.pow(10, digits)
  return Math.round(clamp01(v) * p) / p
}
