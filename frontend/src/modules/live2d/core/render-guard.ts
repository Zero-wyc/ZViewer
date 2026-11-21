/**
 * 给单个 Live2D 模型的 `renderLive2D` 套一层 try/catch。
 *
 * 为什么需要：pixi 的 Ticker 把「排下一帧」放在监听器**之后**，所以任何一次渲染
 * 异常都会让整条 rAF 链断掉——画面定格在最后一帧，拖拽也不再响应（位置是在
 * update 里应用的），用户看到的就是「Live2D 卡死」，而且只能刷新页面。
 *
 * 单只模型自己画挂了，只该让那只模型丢一帧，不该把整个场景一起带走；错误照样
 * 通过 `onError` 上报，只是不再当成致命错误往上抛。
 */
const GUARD_FLAG = '__zviewerRenderGuarded'

export interface GuardableModel {
  renderLive2D?: (renderer: unknown) => void
}

export function guardModelRender(
  model: GuardableModel,
  onError: (error: unknown) => void
): void {
  const original = model.renderLive2D
  if (typeof original !== 'function') return
  // 已经包过就别再包：重复套壳会让同一个异常被上报多次
  if ((original as unknown as Record<string, unknown>)[GUARD_FLAG]) return
  const guarded = function (this: unknown, renderer: unknown): void {
    try {
      original.call(model, renderer)
    } catch (error) {
      onError(error)
    }
  }
  ;(guarded as unknown as Record<string, unknown>)[GUARD_FLAG] = true
  model.renderLive2D = guarded
}
