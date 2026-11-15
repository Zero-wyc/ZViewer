// 本人模型的「本地缩放覆盖」。
//
// 大小是走服务端名册的（所有人看到的同一个人一样大），但滑杆是连续手势：
// 每个中间值都上行一次会让服务端把此人反复标成「新成员」并全房间广播。所以
// 拖动期间只在本机屏幕上跟手，停手后再提交一次终值。
//
// 覆盖只在本人身上生效，并且**服务端回声一到就让位**——否则本地夹取/回声和
// 别人的画面会长期差一档。

export interface LocalScaleOverride {
  /** 本地想显示的缩放 */
  value: number
  /**
   * 设置覆盖那一刻名册里的缩放（0 = 名册里还没有我）。
   *
   * 名册值一变就说明回声（或服务端夹取后的值）到了，覆盖完成使命。
   */
  base: number
}

export interface ResolvedScale {
  /** 这一帧实际该用的缩放 */
  scale: number
  /** 交还给渲染器的覆盖状态；null = 已经释放 */
  override: LocalScaleOverride | null
}

/**
 * 解析本人模型这一刻该用的缩放。
 *
 * 传 `override = null` 或 `peerScale` 不可用时原样返回名册值。
 */
export function resolveLocalScale(
  peerScale: number,
  override: LocalScaleOverride | null
): ResolvedScale {
  if (!override) return { scale: peerScale, override: null }
  // 名册里刚出现我（进房/重连后的第一行）：把服务端的值记成基准，
  // 之后它一变就让位。
  if (override.base <= 0) {
    return {
      scale: override.value,
      override: { value: override.value, base: peerScale },
    }
  }
  if (peerScale !== override.base) {
    return { scale: peerScale, override: null }
  }
  return { scale: override.value, override }
}
