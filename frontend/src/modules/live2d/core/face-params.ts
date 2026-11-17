// 面部参数绑定：候选名 → 句柄 → 模型行程 → 参数值。
//
// 单独成一个文件是为了**可测**：这一层全是纯计算（除了最后交给 core 写值那
// 一步），用假的 im/core 就能验「缺标准名时挑备选」「范围不对称时以默认值为
// 原点」这些真实会踩的坑，不必把 pixi 与 wasm 拉进测试进程。
//
// 设计上有两个不做的事：
//   - 不做语义推断：只按候选名找参数，找不到就不绑。拿语义不同的参数顶替
//     （比如用 ParamBrowLForm 顶 ParamBrowLY）看着"有反应"，实际得到的是一张
//     永远在生气或委屈的脸——比一动不动更像 bug。
//   - 不硬编码量程：±30° / 0~1 只是 Cubism 的**常见**行程，不是每只模型的。

/** 面部驱动的槽位 → 候选 Cubism 参数名（按顺序取第一个存在的）。 */
export const FACE_PARAM_CANDIDATES = {
  /** 张嘴幅度 0~1 */
  mouth: ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthA'],
  /** 嘴形（笑/撇嘴）-1~1 */
  mouthForm: ['ParamMouthForm'],
  eyeL: ['ParamEyeLOpen'],
  eyeR: ['ParamEyeROpen'],
  browL: ['ParamBrowLY'],
  browR: ['ParamBrowRY'],
  /** 头部三轴旋转（度） */
  angleX: ['ParamAngleX'],
  angleY: ['ParamAngleY'],
  /** 滚转/歪头（度） */
  angleZ: ['ParamAngleZ'],
  /** 眼球 -1~1 */
  eyeBallX: ['ParamEyeBallX'],
  eyeBallY: ['ParamEyeBallY'],
} as const satisfies Record<string, readonly string[]>

export type FaceParamSlot = keyof typeof FACE_PARAM_CANDIDATES

/** 固定顺序遍历用（对象键顺序即声明顺序）。 */
export const FACE_PARAM_SLOTS = Object.keys(
  FACE_PARAM_CANDIDATES
) as FaceParamSlot[]

/** 参数在**这只模型**里的行程：最小值 / 默认值 / 最大值。 */
export interface ParamRange {
  min: number
  def: number
  max: number
}

/** 一个绑定好的槽位；模型里没有这个参数时整槽为 null（写入直接跳过）。 */
export interface ParamBinding extends ParamRange {
  /** Cubism 参数 id 句柄（引擎内部是 CubismId，只当作不透明值传递） */
  id: unknown
  /**
   * 开合量「1」落在这个参数上的哪个值（见 `UNIT_END_AT_DEFAULT`）。
   *
   * 绑定期就算好，写入时不必再按槽位分支。
   */
  unitEnd: number
}

export type FaceParamBindings = Record<FaceParamSlot, ParamBinding | null>

/**
 * 读不到模型行程时的兜底（Cubism 标准的常见范围）。
 *
 * 为什么要有兜底：core 没暴露范围接口时（引擎版本差异）如果直接放弃绑定，
 * 整条面部通路会**静默失效**——那是最难查的一类 bug。退回「按标准行程写」
 * 至少与硬编码时代的行为一致。
 */
export const NOMINAL_RANGE: Record<FaceParamSlot, ParamRange> = {
  mouth: { min: 0, def: 0, max: 1 },
  mouthForm: { min: -1, def: 0, max: 1 },
  eyeL: { min: 0, def: 1, max: 1 },
  eyeR: { min: 0, def: 1, max: 1 },
  browL: { min: -1, def: 0, max: 1 },
  browR: { min: -1, def: 0, max: 1 },
  angleX: { min: -30, def: 0, max: 30 },
  angleY: { min: -30, def: 0, max: 30 },
  angleZ: { min: -30, def: 0, max: 30 },
  eyeBallX: { min: -1, def: 0, max: 1 },
  eyeBallY: { min: -1, def: 0, max: 1 },
}

/** 绑定期需要的最小能力（真实对象是引擎的 internalModel）。 */
export interface ParamSource {
  getIdSafe(name: string): unknown
}

/** 读行程需要的最小能力（真实对象是引擎的 coreModel）。 */
export interface ParamCore {
  getParameterIndex?(id: unknown): number
  getParameterMinimumValue?(index: number): number
  getParameterDefaultValue?(index: number): number
  getParameterMaximumValue?(index: number): number
}

/**
 * 开合量「1」落在**默认值**而不是最大值的槽位。
 *
 * 嘴和眼的语义不一样，不能一视同仁：
 *   - 嘴：协议 1 = 张嘴到最大 → 落 max；
 *   - 眼：协议 1 = **正常睁开** → 落 def。真实模型里 `ParamEyeLOpen` 常见是
 *     0~2、默认 1（2 是「瞪大」），一律落 max 会让所有人看起来永远吃惊，
 *     而且这个错误肉眼一眼就能看出来，属于必须挡住的类别。
 *
 * 依据：官方样例 Haru 就是 min=0 / def=1 / max=2。
 */
const UNIT_END_AT_DEFAULT = new Set<FaceParamSlot>(['eyeL', 'eyeR'])

/** 按候选名找一个参数并读出它的行程；一个都没有就是 null（整槽跳过）。 */
export function resolveFaceParam(
  im: ParamSource,
  core: ParamCore,
  slot: FaceParamSlot
): ParamBinding | null {
  for (const name of FACE_PARAM_CANDIDATES[slot]) {
    const id = im.getIdSafe(name)
    if (id === undefined || id === null) continue
    const range = readParamRange(core, id, slot)
    // 默认值恰好等于下界（例如某个模型把「睁眼」的默认值做成 0）时，
    // 按默认值映射会让眼睛永远睁不开——这种退化数据退回最大值，与
    // 硬编码时代一致。
    const atDefault =
      UNIT_END_AT_DEFAULT.has(slot) && range.def > range.min ? range.def : null
    return { id, ...range, unitEnd: atDefault ?? range.max }
  }
  return null
}

/**
 * 读参数在模型里的真实行程。
 *
 * 为什么非读不可：Cubism 的参数范围就是**这只模型的行程边界**。给只有
 * ±10 的 `ParamAngleX` 写 ±30 不会报错，但头转到 15° 就顶到边界，后一半
 * 角度完全没有反应——用户看到的是「头转不动」，而换一个模型幅度又变了。
 * 读一次范围，语义量才能铺满每个模型自己的行程。
 *
 * 有符号量用**默认值**当原点，而不是 (min+max)/2：范围不对称的模型不少
 * （把 `ParamMouthForm` 做成 0~1、默认 0.5），取中点会把「中性」判成半个笑。
 *
 * 注意不能把方法解构出来再调：这些实现里都有 `this._model`，脱离 core
 * 调用会拿到 undefined。
 */
export function readParamRange(
  core: ParamCore,
  id: unknown,
  slot: FaceParamSlot
): ParamRange {
  const nominal = NOMINAL_RANGE[slot]
  if (
    typeof core.getParameterIndex !== 'function' ||
    typeof core.getParameterMinimumValue !== 'function' ||
    typeof core.getParameterDefaultValue !== 'function' ||
    typeof core.getParameterMaximumValue !== 'function'
  ) {
    return nominal
  }
  let index: number
  try {
    index = core.getParameterIndex(id)
  } catch {
    // 坏模型：读不出来就按标准行程走，一个槽位失败不影响其它槽位
    return nominal
  }
  if (!(index >= 0)) return nominal
  const min = finiteOr(core.getParameterMinimumValue(index), nominal.min)
  const def = finiteOr(core.getParameterDefaultValue(index), nominal.def)
  const max = finiteOr(core.getParameterMaximumValue(index), nominal.max)
  // min >= max 只可能来自坏数据；退回标准行程比按退化范围线性映射安全
  if (!(max > min)) return nominal
  return { min, def: clampRange(def, min, max), max }
}

/**
 * 0~1（开合程度）→ 参数行程。
 *
 * 0 落 min（对这两类参数，min 天然就是「闭合」），1 落 `unitEnd`——
 * 嘴是 max，眼是 def，理由见 `UNIT_END_AT_DEFAULT`。
 */
export function unitToParam(binding: ParamBinding, value: number): number {
  const t = clampUnit(value)
  return binding.min + (binding.unitEnd - binding.min) * t
}

/** -1~1（有符号量）→ 参数行程，以默认值为原点向两侧分段铺开。 */
export function signedToParam(binding: ParamBinding, value: number): number {
  const t = clampSignedUnit(value)
  const span = t >= 0 ? binding.max - binding.def : binding.def - binding.min
  return binding.def + span * t
}

/** 夹到 0~1；NaN 归 0（没有有效值，按「闭合」处理）。 */
export function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** 夹到 -1~1；NaN 归 0（中性）。 */
export function clampSignedUnit(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < -1) return -1
  if (v > 1) return 1
  return v
}

function clampRange(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  if (v < min) return min
  if (v > max) return max
  return v
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback
}
