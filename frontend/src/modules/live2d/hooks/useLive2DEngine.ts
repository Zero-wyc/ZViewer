import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLive2DEngine } from '../core/cubism-core'
import { Live2DRenderer } from '../core/live2d-renderer'

// 引擎与渲染器的生命周期。
//
// 从 RoomLive2DHost 里拆出来的原因：这套东西的依赖关系是「canvas 节点在 →
// 引擎加载 → 建 Application → 跟随尺寸 → 跟随 socket id」，全是副作用，和
// 宿主的 UI 状态（菜单、弹窗、上传）毫无关系。混在一个 1400 行的组件里时，
// 任何一次 UI 改动都要重新确认它有没有把 WebGL 上下文重建一遍。

export interface UseLive2DEngineOptions {
  /** 本机 socket id。重连会换，本机模型的判定要跟着换。 */
  localSid: string
  /** 本人模型切换了动作（动捕/待机）：宿主负责广播给房间。 */
  onLocalMotion?: (group: string, index: number) => void
  /** 某个模型加载失败 */
  onModelError?: (sid: string, reason: string) => void
  /** 某个模型进入/离开加载态 */
  onLoadingChange?: (sid: string, loading: boolean) => void
}

export interface Live2DEngineState {
  /** 画布容器的 ref 回调。模型画在这里，节点可被整体搬进全屏元素。 */
  setCanvasEl: (el: HTMLDivElement | null) => void
  renderer: Live2DRenderer | null
  /** 引擎初始化失败的原因；空串 = 正常。 */
  error: string
}

export function useLive2DEngine({
  localSid,
  onLocalMotion,
  onModelError,
  onLoadingChange,
}: UseLive2DEngineOptions): Live2DEngineState {
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null)
  const [renderer, setRenderer] = useState<Live2DRenderer | null>(null)
  const [error, setError] = useState('')

  // 渲染器只创建一次（依赖 canvasEl），拿不到最新的闭包。三个回调都从 ref
  // 转发最新值——否则 socket / roomId 一变，渲染器就得重建，WebGL 上下文与
  // 已经解码好的贴图全部重来（画面上就是所有人闪一下）。
  //
  // 每次渲染后覆盖：这是"总是拿最新闭包"最省事也最不容易写错的写法，
  // 写入本身不触发渲染。
  const sinkRef = useRef({
    localSid,
    onLocalMotion,
    onModelError,
    onLoadingChange,
  })
  useEffect(() => {
    sinkRef.current = {
      localSid,
      onLocalMotion,
      onModelError,
      onLoadingChange,
    }
  })

  useEffect(() => {
    if (!canvasEl) return
    let cancelled = false
    let instance: Live2DRenderer | null = null
    void (async () => {
      try {
        const engine = await loadLive2DEngine()
        if (cancelled) return
        instance = await Live2DRenderer.create({
          engine,
          mount: canvasEl,
          localSid: sinkRef.current.localSid,
          onLocalMotion: (group, index) =>
            sinkRef.current.onLocalMotion?.(group, index),
          onModelError: (sid, reason) =>
            sinkRef.current.onModelError?.(sid, reason),
          onLoadingChange: (sid, loading) =>
            sinkRef.current.onLoadingChange?.(sid, loading),
        })
        if (cancelled) {
          instance.destroy()
          return
        }
        instance.resize(canvasEl.clientWidth, canvasEl.clientHeight)
        setRenderer(instance)
      } catch (err) {
        // 这条必须能被界面上看见：这类失败几乎都是环境问题（静态资源
        // 404/502、WebGL 被禁用），只打 console 的话用户只能看到
        // 「房间页没有角色」，而右键又命中不了。
        console.warn('[live2d] 引擎初始化失败', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
      instance?.destroy()
      setRenderer(null)
    }
  }, [canvasEl])

  // 重连后 socket.id 会变：「本机模型」的判定必须跟着换，否则动作同步会断
  // （自己的模型被当成别人的，自动挑 idle 也被关掉）。
  useEffect(() => {
    if (!renderer) return
    renderer.setLocalSid(localSid)
  }, [renderer, localSid])

  // 尺寸跟随：全屏切入切出、窗口缩放都会改容器大小，而模型尺寸是「视口高的
  // 固定比例」，不重算就会在退回小窗后相对变大、贴图被拉糊。
  useEffect(() => {
    if (!renderer || !canvasEl) return
    const observer = new ResizeObserver(() => {
      renderer.resize(canvasEl.clientWidth, canvasEl.clientHeight)
    })
    observer.observe(canvasEl)
    return () => observer.disconnect()
  }, [renderer, canvasEl])

  const attachCanvas = useCallback((el: HTMLDivElement | null) => {
    setCanvasEl(el)
  }, [])

  return { setCanvasEl: attachCanvas, renderer, error }
}
