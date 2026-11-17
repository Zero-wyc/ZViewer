import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FACE_PARAM_SLOTS,
  NOMINAL_RANGE,
  resolveFaceParam,
  signedToParam,
  unitToParam,
  type ParamBinding,
  type ParamCore,
  type ParamSource,
} from '../core/face-params.ts'

// 参数绑定是「免费模型为什么不动」的核心：这里全部用假对象验，
// 不需要 pixi、不需要 moc3、不需要 wasm。

/** 只认识给定参数名的假模型。 */
function fakeModel(names: string[]): ParamSource {
  const set = new Set(names)
  return { getIdSafe: (name) => (set.has(name) ? `id:${name}` : undefined) }
}

/**
 * 按参数名给出行程的假 core。
 *
 * 三个取值方法只能拿到**下标**，所以这里记住最近一次 `getParameterIndex`
 * 的入参，模拟「同一个下标对应同一个参数」。
 */
function fakeCore(
  ranges: Record<string, { min: number; def: number; max: number }>
): ParamCore {
  let current: { min: number; def: number; max: number } | undefined
  return {
    getParameterIndex: (id) => {
      const name = String(id).replace('id:', '')
      current = ranges[name]
      return current ? 0 : -1
    },
    getParameterMinimumValue: () => current?.min ?? Number.NaN,
    getParameterDefaultValue: () => current?.def ?? Number.NaN,
    getParameterMaximumValue: () => current?.max ?? Number.NaN,
  }
}

test('首选名存在时直接绑它', () => {
  const binding = resolveFaceParam(
    fakeModel(['ParamAngleX']),
    fakeCore({ ParamAngleX: { min: -30, def: 0, max: 30 } }),
    'angleX'
  )
  assert.ok(binding)
  assert.equal(binding.id, 'id:ParamAngleX')
  assert.deepEqual(
    { min: binding.min, def: binding.def, max: binding.max },
    {
      min: -30,
      def: 0,
      max: 30,
    }
  )
})

test('首选名缺失时按候选顺序挑备选', () => {
  // 早期工程导出的模型只有 ParamMouthOpen
  const binding = resolveFaceParam(
    fakeModel(['ParamMouthOpen']),
    fakeCore({ ParamMouthOpen: { min: 0, def: 0, max: 1 } }),
    'mouth'
  )
  assert.ok(binding)
  assert.equal(binding.id, 'id:ParamMouthOpen')
})

test('候选全缺时返回 null，调用方静默跳过而不是写不存在的参数', () => {
  const binding = resolveFaceParam(fakeModel([]), fakeCore({}), 'browL')
  assert.equal(binding, null)
})

test('core 没有范围接口时退回标准行程，而不是干脆不绑', () => {
  const binding = resolveFaceParam(fakeModel(['ParamAngleX']), {}, 'angleX')
  assert.ok(binding)
  assert.equal(binding.min, NOMINAL_RANGE.angleX.min)
  assert.equal(binding.max, NOMINAL_RANGE.angleX.max)
})

test('getParameterIndex 返回 -1 或抛错时退回标准行程', () => {
  const minusOne = resolveFaceParam(
    fakeModel(['ParamEyeBallX']),
    { getParameterIndex: () => -1 },
    'eyeBallX'
  )
  assert.ok(minusOne)
  assert.equal(minusOne.max, 1)

  const throwing = resolveFaceParam(
    fakeModel(['ParamEyeBallX']),
    {
      getParameterIndex: () => {
        throw new Error('bad moc3')
      },
    },
    'eyeBallX'
  )
  assert.ok(throwing)
  assert.equal(throwing.min, -1)
})

test('行程反了（min >= max）时退回标准行程', () => {
  const binding = resolveFaceParam(
    fakeModel(['ParamAngleY']),
    fakeCore({ ParamAngleY: { min: 30, def: 0, max: -30 } }),
    'angleY'
  )
  assert.ok(binding)
  assert.equal(binding.max, 30)
})

/** 手搓一个绑定：unitEnd 默认落 max（嘴的语义）。 */
function bind(
  min: number,
  def: number,
  max: number,
  unitEnd = max
): ParamBinding {
  return { id: 'x', min, def, max, unitEnd }
}

test('有符号量以默认值为原点，而不是量程中点', () => {
  // 范围 0~1、默认 0.5 的 ParamMouthForm：中性必须落在 0.5
  const asymmetric = bind(0, 0.5, 1)
  assert.equal(signedToParam(asymmetric, 0), 0.5)
  assert.equal(signedToParam(asymmetric, 1), 1)
  assert.equal(signedToParam(asymmetric, -1), 0)
})

test('默认值等于最大值时（Haru 的 ParamMouthForm 就是 -1/1/1），正方向不再更用力', () => {
  const haru = bind(-1, 1, 1)
  assert.equal(signedToParam(haru, 0), 1)
  assert.equal(signedToParam(haru, 1), 1)
  assert.equal(signedToParam(haru, -1), -1)
})

test('有符号量铺满模型自己的行程（±10 的模型也能转到底）', () => {
  const narrow = bind(-10, 0, 10)
  assert.equal(signedToParam(narrow, 1), 10)
  assert.equal(signedToParam(narrow, -1), -10)
  assert.equal(signedToParam(narrow, 0.5), 5)
  // 超出语义范围按边界写，不把 15 直接灌进去
  assert.equal(signedToParam(narrow, 3), 10)
})

test('开合程度映射到 min~unitEnd，且越界被夹住', () => {
  const mouth = bind(0, 0, 1.2)
  assert.equal(unitToParam(mouth, 0), 0)
  assert.equal(unitToParam(mouth, 1), 1.2)
  assert.equal(unitToParam(mouth, 0.5), 0.6)
  assert.equal(unitToParam(mouth, 1.4), 1.2)
  assert.equal(unitToParam(mouth, -0.4), 0)
  // NaN 按闭合处理：断流时不该把嘴撑开
  assert.equal(unitToParam(mouth, Number.NaN), 0)
})

test('眼睛的「1」落在默认值：Haru 的 0~2 模型不会一直瞪眼', () => {
  const haruEye = bind(0, 1, 2, 1)
  assert.equal(unitToParam(haruEye, 1), 1)
  assert.equal(unitToParam(haruEye, 0), 0)
  assert.equal(unitToParam(haruEye, 0.5), 0.5)
})

test('绑定眼参数时 unitEnd 取默认值而不是最大值', () => {
  const binding = resolveFaceParam(
    fakeModel(['ParamEyeLOpen']),
    fakeCore({ ParamEyeLOpen: { min: 0, def: 1, max: 2 } }),
    'eyeL'
  )
  assert.ok(binding)
  assert.equal(binding.unitEnd, 1)
  assert.equal(binding.max, 2)
})

test('绑定嘴参数时 unitEnd 取最大值（张嘴是超出常态的动作）', () => {
  const binding = resolveFaceParam(
    fakeModel(['ParamMouthOpenY']),
    fakeCore({ ParamMouthOpenY: { min: 0, def: 0, max: 1 } }),
    'mouth'
  )
  assert.ok(binding)
  assert.equal(binding.unitEnd, 1)
})

test('槽位清单与候选表一一对应（新增槽位时不会漏绑）', () => {
  const keys = Object.keys(NOMINAL_RANGE).sort()
  assert.deepEqual([...FACE_PARAM_SLOTS].sort(), keys)
  // 每个槽位至少有一个候选名，否则 resolve 永远返回 null
  for (const slot of FACE_PARAM_SLOTS) {
    assert.ok(NOMINAL_RANGE[slot], `${slot} 缺标准行程`)
  }
})
