// 贴图引用计数。
//
// 为什么需要：Live2D 引擎的贴图加载走 Pixi 的 `Assets.load`，而 Pixi 按**绝对
// URL** 缓存 promise —— 同一个 model3.json 被两个人加载时，拿到的是同一个
// Texture 实例、同一份 GPU 纹理。也就是说"同 URL 复用纹理"是引擎与 Pixi 已经
// 做好的事，我们唯一要补的是**释放**：`model.destroy({ texture: true })` 会把
// Texture 和它的 source 一起销毁，一个人换模型，另一个人当场变白。
//
// 这里只做计数与判定，具体怎么释放（Assets.unload / texture.destroy）留给
// 调用方 —— 那是渲染器的知识，也不该让这个文件依赖 pixi，否则跑不进单测。

/** 只需要 destroyed 这一个字段：pixi 的 Texture 与任何贴图对象都满足。 */
export interface RefCountedTexture {
  destroyed: boolean
}

/** 登记一次使用。已销毁的贴图直接跳过（销毁的复原不了，计数也没意义）。 */
export function retainTextureRefs<T extends RefCountedTexture>(
  refs: Map<T, number>,
  textures: readonly T[]
): void {
  for (const texture of textures) {
    if (!texture || texture.destroyed) continue
    refs.set(texture, (refs.get(texture) ?? 0) + 1)
  }
}

/**
 * 撤销一次使用，返回**真正该释放**的贴图。
 *
 * registered 是这件事的关键，写错就是"释放了别人的贴图"或"永远不释放"：
 *   - true：这份模型登记过，计数减一，减到 0 才该释放；
 *   - false：这份模型从没登记过（加载超时之后迟到的那一份），贴图所有权
 *     完全可能在别人手里，所以只在「谁都没登记过」时才释放。
 */
export function releaseTextureRefs<T extends RefCountedTexture>(
  refs: Map<T, number>,
  textures: readonly T[],
  registered: boolean
): T[] {
  const free: T[] = []
  for (const texture of textures) {
    if (!texture || texture.destroyed) continue
    const count = refs.get(texture) ?? 0
    if (registered) {
      if (count > 1) {
        refs.set(texture, count - 1)
        continue
      }
      refs.delete(texture)
      free.push(texture)
      continue
    }
    if (count === 0) free.push(texture)
  }
  return free
}
