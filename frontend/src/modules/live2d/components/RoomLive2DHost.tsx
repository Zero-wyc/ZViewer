import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'
import { Sparkles } from 'lucide-react'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/authStore'
import { loadLive2DEngine } from '../core/cubism-core'
import { FaceTracker } from '../core/face-tracker'
import { loadBuiltinModels, type Live2DModelEntry } from '../core/model-catalog'
import {
  loadModelExpressions,
  type ModelExpressionEntry,
} from '../core/model-meta'
import { resolveModelUrl } from '../core/model-url'
import {
  LIVE2D_UPLOAD_MAX_BYTES,
  deleteLibraryModel,
  loadLibraryModels,
  uploadLibraryModel,
  type Live2DLibraryEntry,
} from '../core/model-library'
import { Live2DRenderer } from '../core/live2d-renderer'
import { getEntry, listEntries, setLocalDrag, slotX } from '../core/scene'
import { LIVE2D_DRAG_INTERVAL_MS, LIVE2D_MAX_RENDERED } from '../constants'
import {
  emitLive2DAction,
  emitLive2DConfig,
  emitLive2DDrag,
  emitLive2DMotion,
  emitLive2DPolicy,
  useLive2DSync,
} from '../hooks/useLive2DSync'
import { useLive2DPointer } from '../hooks/useLive2DPointer'
import { useLive2DStore } from '../store/live2dStore'
import type { Live2DModelKind, Live2DPolicy } from '../types'
import { Live2DAdvancedSettings } from './Live2DAdvancedSettings'
import { Live2DContextMenu } from './Live2DContextMenu'
import { Live2DDragLayer } from './Live2DDragLayer'

// 房间悬浮层的宿主。
//
// 四件事必须由它负责，缺一个都会出问题：
//   1. **挂载层级**：挂在 RoomPage（而不是 RoomLayout）上，切一起听/换片都不会卸载；
//   2. **节点搬移**：原生全屏是 top layer，body 级 fixed 会被完全遮住，必须把
//      同一个节点 appendChild 到 fullscreenElement 里（换 portal 目标会重建
//      canvas，WebGL 上下文与纹理全部要重来）；
//   3. **引擎生命周期**：卸载就销毁 Application，把 WebGL 上下文还回去；
//   4. **入口**：右键角色呼出设置菜单；右下角另有一个常驻圆钮直通「高级设置」
//      （右键依赖包围盒命中，模型加载失败 / 命中漏判时它是唯一退路）。
//   5. **拖拽模式**：菜单里开启后可把自己的角色拖到任意位置，偏移同步给
//      全房间（各端看到的站位一致）。它会给角色套一层透明抓取层，所以只在
//      用户主动开启时存在。
//
// canvas 是 `pointer-events: none` 的，否则房间的拖拽、双击全屏、视频控件全被
// 吃掉；所以「右键落在哪个角色上」只能由渲染器的包围盒判定（renderer.pick）。

export interface RoomLive2DHostProps {
  roomId: string
  socket: Socket | null
  isHost: boolean
}

export function RoomLive2DHost({
  roomId,
  socket,
  isHost,
}: RoomLive2DHostProps) {
  const myKind = useLive2DStore((s) => s.myKind)
  const myModelId = useLive2DStore((s) => s.myModelId)
  const myScale = useLive2DStore((s) => s.myScale)
  const hidden = useLive2DStore((s) => s.hidden)
  const peers = useLive2DStore((s) => s.peers)
  const policy = useLive2DStore((s) => s.policy)
  const setMyModel = useLive2DStore((s) => s.setMyModel)
  const setMyScale = useLive2DStore((s) => s.setMyScale)
  const setHidden = useLive2DStore((s) => s.setHidden)

  // 房主统一角色时，显示的模型不再是「我选的」而是房间定的；我自己的选择
  // 仍然留在 store 里，关掉统一角色就自动回来。
  //
  // 拆成三个原始值而不是一个对象：这个组合会进 effect 依赖表，每次渲染新建
  // 一个对象会让 effect 每帧都跑（react-hooks 也会警告）。
  const unifiedId = policy.unified && policy.unifiedId ? policy.unifiedId : ''
  const unifiedActive = unifiedId !== ''
  const unifiedKind: Live2DModelKind = policy.unifiedKind ?? 'builtin'
  const effKind = unifiedActive ? unifiedKind : myKind
  const effModelId = unifiedActive ? unifiedId : myModelId
  // 宿主的 DOM 由 React 自己渲染（portal 到 body），我们只在 effect 里
  // 搬动它的父节点。这样 canvas 永远在同一个 div 里：全屏时是「移动」而不是
  // 「重建」，WebGL 上下文与纹理解码结果都保得住。
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null)
  const [renderer, setRenderer] = useState<Live2DRenderer | null>(null)
  // 引擎（pixi + Cubism Core）初始化失败的可见提示。
  //
  // 以前这条只进 console.warn，界面上什么都不发生：模型永远不出现、右键也
  // 没有命中，用户只能看到「房间页没有角色」。而这类失败几乎都是**环境问题**
  // （静态资源 404/502、WebGL 被禁用），必须在界面上说出来。
  const [engineError, setEngineError] = useState('')
  const [builtins, setBuiltins] = useState<Live2DModelEntry[]>([])
  const [libraryModels, setLibraryModels] = useState<Live2DLibraryEntry[]>([])
  const [canUploadModels, setCanUploadModels] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 拖拽模式：只有用户从菜单里主动开启时才存在。它会给自己的角色套一层
  // 透明的抓取层（挡住那块区域的其它点击），所以绝不能常驻。
  const [dragMode, setDragMode] = useState(false)
  // root 是这条菜单的挂载容器，**在打开的那一刻**决定：
  //   - 原生全屏时只有 fullscreenElement 子树会被渲染，必须挂进去；
  //   - 非全屏时挂 body——宿主的 fixed 容器带 z-index:60，会把子节点的层级
  //     整体压到 60 这一层，菜单（哪怕 z-[120]）也会被视频控制条（80）、
  //     一起听面板（100）盖住，而角色恰好站在画面底部。
  // 在事件回调里读 fullscreenElement 而不是存 state：不需要监听全屏切换，
  // 也不会在 effect 里同步 setState。
  const [menu, setMenu] = useState<{
    open: boolean
    x: number
    y: number
    root: HTMLElement | null
    /** 打开那一刻的拖拽偏移，用来决定要不要显示「回到原位」 */
    offsetX: number
    offsetY: number
  }>({ open: false, x: 0, y: 0, root: null, offsetX: 0, offsetY: 0 })

  const mySid = socket?.id ?? ''

  const openMenuAt = useCallback(
    (clientX: number, clientY: number) => {
      const fs = document.fullscreenElement
      // 偏移只在场景里（拖动时不进 React），所以打开菜单时读一次：
      // 菜单是低频交互，取快照足够，也能避免每次拖动都让宿主重渲染。
      const entry = mySid ? getEntry(mySid) : undefined
      setMenu({
        open: true,
        x: clientX,
        y: clientY,
        root: fs instanceof HTMLElement ? fs : null,
        offsetX: entry?.targetDragX ?? 0,
        offsetY: entry?.targetDragY ?? 0,
      })
    },
    [mySid]
  )
  // sid → 加载失败原因。存原因而不是只存 sid：占位卡上那句「可能被跨域限制」
  // 对 4K 素材、moc3 版本、404 一视同仁，用户根本无从下手。
  const [failed, setFailed] = useState<Record<string, string>>({})
  // 连带 url 一起存：换模型时旧清单不能先闪一下
  const [exprState, setExprState] = useState<{
    url: string
    list: ModelExpressionEntry[]
  }>({ url: '', list: [] })
  // 摄像头动捕：实例放 ref（不参与渲染），开关状态在 state 里
  const trackerRef = useRef<FaceTracker | null>(null)
  // 卸载后摄像头还在跑是最糟的泄漏：启停都是异步的，必须在 await 之后复查
  const disposedRef = useRef(false)
  const [tracker, setTracker] = useState<FaceTracker | null>(null)
  const [face, setFace] = useState<{
    on: boolean
    busy: boolean
    error: string
  }>({ on: false, busy: false, error: '' })

  const role = useAuthStore((s) => s.user?.role)
  const isServerAdmin = role === 'root' || role === 'admin'
  // 房主与服务器管理员自己永远看得到角色，否则他也没法再右键改回来；其余人
  // 跟着房间策略走。
  //
  // 注意这里**不能**用「能上传模型」当豁免：模型库改成服务端公共之后，任何
  // 登录用户都能上传，拿它当条件等于「对观众显示角色」这个开关对除游客以外
  // 的所有人失效。
  const canShowLayer = isHost || isServerAdmin || policy.showToViewers

  // ---- 2. 原生全屏时搬进 top layer ----
  useEffect(() => {
    const sync = () => {
      const el = hostRef.current
      if (!el) return
      const fs = document.fullscreenElement
      const target = fs instanceof HTMLElement ? fs : document.body
      if (el.parentElement !== target) target.appendChild(el)
      el.style.position = fs ? 'absolute' : 'fixed'
      el.style.zIndex = fs ? '110' : '60'
    }
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // ---- 3. 内置模型清单 ----
  useEffect(() => {
    let cancelled = false
    void loadBuiltinModels().then((list) => {
      if (!cancelled) setBuiltins(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ---- 4. 公共模型库（服务端级，任何房间共用）----
  //
  // 刷新用「版本号 + effect」而不是在事件里直接 setState：上传/删除之后
  // 只是把版本号加一，真正的取数留在 effect 里，避免多处各写一遍 promise 链，
  // 也满足 react-hooks 对「effect 内不要同步 setState」的要求。
  const [libraryVersion, setLibraryVersion] = useState(0)
  const refreshLibrary = useCallback(() => setLibraryVersion((v) => v + 1), [])

  useEffect(() => {
    let cancelled = false
    void loadLibraryModels().then((list) => {
      if (cancelled) return
      setLibraryModels(list.models)
      setCanUploadModels(list.canManage)
    })
    return () => {
      cancelled = true
    }
  }, [libraryVersion])

  // ---- 4b. 我的模型有哪些表情 ----
  const myModelUrl = effModelId
    ? resolveModelUrl({ kind: effKind, modelId: effModelId })
    : ''
  const myExpressions =
    exprState.url === myModelUrl
      ? exprState.list
      : ([] as ModelExpressionEntry[])

  useEffect(() => {
    if (!myModelUrl) return
    let cancelled = false
    void loadModelExpressions(myModelUrl).then((list) => {
      if (cancelled) return
      setExprState({ url: myModelUrl, list })
    })
    return () => {
      cancelled = true
    }
  }, [myModelUrl])

  // ---- 5. 引擎与渲染器 ----
  //
  // 动作广播的出口走 ref：渲染器一创建就把回调固定下来，用 ref 传值才不会
  // 因为 socket/roomId 变化而重建整个 WebGL 上下文。
  const motionSinkRef = useRef<(group: string, index: number) => void>(() => {})
  useEffect(() => {
    motionSinkRef.current = (group, index) => {
      emitLive2DMotion(socket, roomId, group, index)
    }
  }, [socket, roomId])

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
          localSid: socket?.id ?? '',
          onLocalMotion: (group, index) => motionSinkRef.current(group, index),
          onModelError: (sid, reason) => {
            setFailed((prev) =>
              prev[sid] === reason ? prev : { ...prev, [sid]: reason }
            )
          },
        })
        if (cancelled) {
          instance.destroy()
          return
        }
        instance.resize(canvasEl.clientWidth, canvasEl.clientHeight)
        setRenderer(instance)
      } catch (err) {
        console.warn('[live2d] 引擎初始化失败', err)
        if (!cancelled) {
          setEngineError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
      instance?.destroy()
      setRenderer(null)
    }
    // socket 只用于取初始的本机 id，之后由下面的 effect 跟进（重连会换 id）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasEl])

  // 重连后 socket.id 会变：「本机模型」的判定必须跟着换，否则动作同步会断
  // （自己的模型被当成别人的，自动挑 idle 也被关掉）。
  useEffect(() => {
    if (!renderer) return
    renderer.setLocalSid(mySid)
  }, [renderer, mySid])

  // ---- 6. 尺寸跟随 ----
  useEffect(() => {
    if (!renderer || !canvasEl) return
    const observer = new ResizeObserver(() => {
      renderer.resize(canvasEl.clientWidth, canvasEl.clientHeight)
    })
    observer.observe(canvasEl)
    return () => observer.disconnect()
  }, [renderer, canvasEl])

  // ---- 7. 默认模型：进房即有角色（房主统一了角色就不用挑） ----
  useEffect(() => {
    // hidden：用户主动隐藏，别再自动塞一个回来
    if (effModelId || unifiedActive || hidden || builtins.length === 0) return
    setMyModel('builtin', builtins[0].id)
  }, [effModelId, unifiedActive, hidden, builtins, setMyModel])

  // ---- 8. 声明自己的模型（换模型/改大小才发；没模型时撤回声明）----
  //
  // 用「生效模型」而不是「我选的模型」：房主统一角色时服务端名册也跟着统一，
  // 各端画出来的才是同一个。
  useEffect(() => {
    if (!socket || !roomId) return
    if (!effModelId) {
      // 只在「主动隐藏」时撤回声明：刚进房还没挑模型时不必先 clear 一次，
      // 否则别人那边会先看到角色消失再出现。
      if (hidden) emitLive2DConfig(socket, roomId, { action: 'clear' })
      return
    }
    emitLive2DConfig(socket, roomId, {
      action: 'set',
      kind: effKind,
      modelId: effModelId,
      scale: myScale,
    })
  }, [socket, roomId, effKind, effModelId, myScale, hidden])

  // ---- 8b. 摄像头动捕 ----
  //
  // 只有用户点开关才会申请摄像头（这也是一次用户手势，权限弹窗才不会
  // 被浏览器拦）。关掉、换房、卸载都要停：track 不停会一直亮着摄像头灯。
  const stopFaceTracking = useCallback(() => {
    const current = trackerRef.current
    trackerRef.current = null
    current?.stop()
    setTracker(null)
    setFace({ on: false, busy: false, error: '' })
  }, [])

  const startFaceTracking = useCallback(async () => {
    if (trackerRef.current) return
    setFace({ on: true, busy: true, error: '' })
    try {
      const instance = await FaceTracker.create()
      // 启动期间用户可能已经关掉开关、离开了房间，或者组件已经被卸载
      if (disposedRef.current) {
        instance.stop()
        return
      }
      trackerRef.current = instance
      setTracker(instance)
      setFace({ on: true, busy: false, error: '' })
    } catch (err) {
      setFace({
        on: false,
        busy: false,
        error: err instanceof Error ? err.message : t('摄像头动捕启动失败'),
      })
    }
  }, [])

  const toggleFaceTracking = useCallback(() => {
    if (face.on || face.busy) stopFaceTracking()
    else void startFaceTracking()
  }, [face.on, face.busy, stopFaceTracking, startFaceTracking])

  // 房主关掉「允许成员动捕」时立刻停：不能只是把按钮变灰，摄像头得真的关。
  // 放进 setTimeout 是为了不在 effect 里同步 setState（react-hooks 会判级联渲染）。
  useEffect(() => {
    if (policy.allowFace) return
    const timer = window.setTimeout(stopFaceTracking, 0)
    return () => window.clearTimeout(timer)
  }, [policy.allowFace, stopFaceTracking])

  useEffect(() => {
    return () => {
      disposedRef.current = true
      trackerRef.current?.stop()
      trackerRef.current = null
    }
  }, [])

  // ---- 8c. 右键角色呼出设置 ----
  //
  // 监听 window（capture）而不是宿主 div：div 是 pointer-events:none，收不到
  // 事件。命中角色时 preventDefault + stopPropagation，否则底下的视频/列表会
  // 同时弹出它们自己的右键菜单。
  const closeMenu = useCallback(() => {
    setMenu((prev) => (prev.open ? { ...prev, open: false } : prev))
  }, [])

  useEffect(() => {
    if (!renderer) return
    const onContextMenu = (event: MouseEvent) => {
      // 详细设置是模态的，此时右键角色没有意义（菜单会被蒙层盖住）
      if (advancedOpen) return
      // 菜单自己内部的右键（比如点在滑块上）不要重新定位
      if ((event.target as Element | null)?.closest?.('[data-live2d-menu]')) {
        return
      }
      const sid = renderer.pick(event.clientX, event.clientY)
      if (!sid) return
      event.preventDefault()
      event.stopPropagation()
      openMenuAt(event.clientX, event.clientY)
    }
    window.addEventListener('contextmenu', onContextMenu, true)
    return () => window.removeEventListener('contextmenu', onContextMenu, true)
  }, [renderer, advancedOpen, openMenuAt])

  // ---- 8d. 拖拽模式 ----
  //
  // 偏移只在场景里流转（拖动时 10Hz 级别，不进 React），这里只负责三件事：
  // 开关模式、按节流把偏移发给房间、以及「回到原位」。
  const dragEmitAt = useRef(0)

  const handleDrag = useCallback(
    (x: number, y: number, final: boolean) => {
      const now = performance.now()
      // 拖动中按 60ms 节流；松手那一帧无条件发，终值不能丢
      if (!final && now - dragEmitAt.current < LIVE2D_DRAG_INTERVAL_MS) return
      dragEmitAt.current = now
      emitLive2DDrag(socket, roomId, x, y)
    },
    [socket, roomId]
  )

  const handleResetPosition = useCallback(() => {
    if (mySid) setLocalDrag(mySid, 0, 0)
    emitLive2DDrag(socket, roomId, 0, 0)
    // 从菜单点进来时顺手收起：位置已经回原位，「回到原位」不该还挂在那儿
    closeMenu()
  }, [mySid, socket, roomId, closeMenu])

  const exitDragMode = useCallback(() => setDragMode(false), [])

  const toggleDragMode = useCallback(() => {
    if (dragMode) {
      // 从菜单退出时留着菜单：入口文案会变回「拖拽模式」，这是最直接的反馈
      setDragMode(false)
      return
    }
    if (!effModelId) return
    setDragMode(true)
    // 菜单会挡住角色，进模式就关掉
    closeMenu()
  }, [dragMode, effModelId, closeMenu])

  // ---- 8e. 名字标签跟随拖拽偏移 ----
  //
  // 模型画在 canvas 里，标签与占位卡是 DOM（按槽位定位）。拖拽偏移只在场景
  // 里流转、不进 React，所以这里用一个常驻 rAF 把位移写进 transform：
  // 只在数值真的变了时才写，静止时这个循环几乎不做事。
  const slotRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    let raf = 0
    const last = new Map<string, string>()
    const tick = () => {
      const w = window.innerWidth || 1
      const h = window.innerHeight || 1
      for (const entry of listEntries()) {
        const el = slotRefs.current.get(entry.peer.sid)
        if (!el) continue
        // 偏移与 CSS 的 translate3d 同向（都向下为正），可以直接乘
        const dx = entry.currentDragX * w
        const dy = entry.currentDragY * h
        const key = `${dx.toFixed(1)}|${dy.toFixed(1)}`
        if (last.get(entry.peer.sid) === key) continue
        last.set(entry.peer.sid, key)
        el.style.transform = `translateX(-50%) translate3d(${dx}px, ${dy}px, 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- 9. 收发 ----
  useLive2DSync({ socket, roomId, renderer })
  useLive2DPointer({
    socket,
    roomId,
    sid: mySid,
    active: canShowLayer && Boolean(effModelId),
    tracker,
  })

  // ---- 10. 动作 ----
  const handleSelect = useCallback(
    (kind: Live2DModelKind, modelId: string) => {
      setFailed({})
      setMyModel(kind, modelId)
      setHidden(false)
    },
    [setMyModel, setHidden]
  )

  const handleHide = useCallback(() => {
    setMyModel('builtin', '')
    setHidden(true)
    // 没有角色了，拖拽模式留着只会让下次换模型时突然冒出一个抓取层
    setDragMode(false)
    closeMenu()
    setAdvancedOpen(false)
  }, [setMyModel, setHidden, closeMenu])

  // 表情不本地乐观应用：服务端会把同一条广播发回给自己，
  // 这样「自己看到的」和「别人看到的」永远是同一份事实。
  const handleExpression = useCallback(
    (index: number) => {
      emitLive2DAction(socket, roomId, index)
    },
    [socket, roomId]
  )

  // 上传：成功后立刻切到新模型——这是用户上传时唯一想做的事。
  // 传进公共库的模型所有房间都能选，所以这里不关心 roomId（也不再需要它）。
  const handleUpload = useCallback(
    async (file: File) => {
      if (uploading) return
      if (file.size > LIVE2D_UPLOAD_MAX_BYTES) {
        message.error(
          t('模型包不能超过 {{size}}MB', {
            size: LIVE2D_UPLOAD_MAX_BYTES >> 20,
          })
        )
        return
      }
      setUploading(true)
      const result = await uploadLibraryModel(file)
      setUploading(false)
      if (!result.ok) {
        message.error(result.message)
        return
      }
      message.success(result.message)
      refreshLibrary()
      if (result.model) handleSelect('room', result.model.id)
    },
    [uploading, refreshLibrary, handleSelect]
  )

  const handleDeleteModel = useCallback(
    async (modelId: string) => {
      const result = await deleteLibraryModel(modelId)
      if (!result.ok) {
        message.error(result.message)
        return
      }
      message.success(result.message)
      refreshLibrary()

      // 统一角色用的正是它：先把统一关掉，否则全房间都会加载失败只剩占位卡
      if (policy.unifiedKind === 'room' && policy.unifiedId === modelId) {
        emitLive2DPolicy(socket, roomId, { unified: false })
      }
      // 自己正用着就退回第一个内置模型；连内置模型都没有（未随包模型）时
      // 直接撤回声明，别让别人的名册里留一个永远加载不出来的条目。
      if (effKind === 'room' && effModelId === modelId) {
        setFailed({})
        const fallback = builtins[0]?.id
        setMyModel('builtin', fallback ?? '')
        setHidden(!fallback)
      }
    },
    [
      refreshLibrary,
      policy,
      effKind,
      effModelId,
      builtins,
      setMyModel,
      setHidden,
      socket,
      roomId,
    ]
  )

  // 房间策略：只发要改的字段，等广播回来才落地（不对开关做乐观更新，
  // 免得「先跳一下又弹回来」）
  const handlePolicy = useCallback(
    (patch: Partial<Live2DPolicy>) => {
      // 与后端 requireHost 同口径：会话角色必须是房主，否则请求会被拒
      if (!isHost) return
      emitLive2DPolicy(socket, roomId, patch, (ok, text) => {
        if (!ok && text) message.error(text)
      })
    },
    [isHost, socket, roomId]
  )

  const openAdvanced = useCallback(() => {
    // 右下角按钮和菜单里的「高级设置」都会进来：两条路都得在这里重算挂载点，
    // 否则从按钮直接打开（或全屏切换之后再打开）会把面板挂到全屏子树外面，
    // 表现就是「点了没反应」。
    const fs = document.fullscreenElement
    setMenu((prev) => ({
      ...prev,
      open: false,
      root: fs instanceof HTMLElement ? fs : null,
    }))
    setAdvancedOpen(true)
  }, [])

  const visible = peers.slice(0, LIVE2D_MAX_RENDERED)
  const hiddenCount = peers.length - visible.length
  // 拖拽模式的两个前提：有自己的模型，且模型当前真的在画面上。房主统一角色
  // 时模型是房间定的，但位置仍然是每个成员自己的，所以照拖不误。
  const dragActive = dragMode && Boolean(effModelId) && Boolean(mySid)
  // 入口**常驻**，不再「有模型就收起来」：
  //   - 模型加载失败时画面上只剩占位小方块，`renderer.pick` 打不中，右键就没
  //     任何反应——这正是用户最需要打开设置（换/删模型）的时候，收起来等于
  //     把人锁在外面；
  //   - 画布是 pointer-events:none，右键判定走包围盒，摄像头动捕在动、缩放
  //     拉到很小、或者角色被别的浮层挡住时也会漏判，不能把入口押在命中上。

  if (!canShowLayer) return null

  return createPortal(
    <div
      ref={hostRef}
      data-live2d-host=""
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}
    >
      <div ref={setCanvasEl} style={{ position: 'absolute', inset: 0 }} />

      {visible.map((peer, index) => {
        const failureReason = failed[peer.sid]
        return (
          <div
            key={peer.sid}
            ref={(el) => {
              if (el) slotRefs.current.set(peer.sid, el)
              else slotRefs.current.delete(peer.sid)
            }}
            style={{
              position: 'absolute',
              left: `${slotX(index, visible.length) * 100}%`,
              bottom: 8,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {failureReason && (
              <div
                title={t('模型加载失败：{{reason}}', { reason: failureReason })}
                onContextMenu={(event) => {
                  // 加载失败的占位卡是 DOM，直接自己收右键；否则这个角色
                  // 就成了唯一没有入口的那一格。
                  event.preventDefault()
                  openMenuAt(event.clientX, event.clientY)
                }}
                style={{
                  pointerEvents: 'auto',
                  width: 44,
                  height: 64,
                  borderRadius: 10,
                  border: '1px solid var(--md-sys-color-outline-variant)',
                  background: 'var(--md-sys-color-surface-container)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  opacity: 0.85,
                }}
              >
                {(peer.name || '?').slice(0, 1)}
              </div>
            )}
            <span
              style={{
                maxWidth: 96,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                padding: '1px 6px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.35)',
                color: '#fff',
                fontSize: 10,
              }}
            >
              {peer.name}
            </span>
          </div>
        )
      })}

      {hiddenCount > 0 && (
        // 压在画面上的文字必须自己带底：这层浮在视频/网页上，继承来的
        // on-surface 是深色，浅色画面里等于看不见（与角色名标签同一处理）。
        <div
          className="absolute right-3 bottom-2.5 truncate rounded-md px-1.5 py-px text-[10px] text-white/85"
          style={{ background: 'rgba(0,0,0,0.35)' }}
        >
          {t('另有 {{count}} 个角色未显示', { count: hiddenCount })}
        </div>
      )}

      {/* 角色设置入口：常驻。与右下角语音聊天悬浮按钮同一列、同一规格
          （h-12 w-12 glass-card 圆钮）：语音面板固定在 bottom-6 right-6
          （48px 高）并带 gap-3，所以这里抬到 84px = 24 + 48 + 12，
          两个圆钮才对齐成一条竖列而不是错位。 */}
      {engineError && (
        <div
          className="absolute right-6 bottom-[140px] max-w-[50vw] truncate rounded-md px-2 py-1 text-[10px] text-white/90"
          style={{ background: 'rgba(0,0,0,0.55)', pointerEvents: 'auto' }}
          title={t('Live2D 引擎加载失败：{{reason}}', { reason: engineError })}
        >
          {t('Live2D 引擎加载失败')}
        </div>
      )}

      <div
        className="absolute right-6 bottom-[84px]"
        style={{ pointerEvents: 'auto' }}
      >
        <button
          type="button"
          onClick={openAdvanced}
          aria-label={t('角色设置')}
          title={t('角色设置')}
          className={cn(
            'glass-card flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200',
            'hover:scale-105 hover:shadow-xl active:scale-95'
          )}
          style={{
            backgroundColor: 'var(--glass-bg)',
            color: 'var(--md-sys-color-on-surface)',
          }}
        >
          <Sparkles className="h-5 w-5" />
        </button>
      </div>

      {/* 拖拽模式：套在自己角色身上的抓取层 + 底部提示条。
          提示条的门禁交给它自己：模型还没加载出来时框是隐藏的，但「完成 /
          回到原位」仍然可点，用户不会被卡在模式里出不来。 */}
      {dragActive && (
        <Live2DDragLayer
          renderer={renderer}
          sid={mySid}
          container={menu.root}
          onDrag={handleDrag}
          onReset={handleResetPosition}
          onExit={exitDragMode}
        />
      )}

      <Live2DContextMenu
        open={menu.open}
        position={{ x: menu.x, y: menu.y }}
        onClose={closeMenu}
        container={menu.root}
        builtins={builtins}
        libraryModels={libraryModels}
        expressions={myExpressions}
        myKind={effKind}
        myModelId={effModelId}
        myScale={myScale}
        faceTracking={face}
        allowFace={policy.allowFace}
        unified={unifiedActive}
        canHide={!unifiedActive && Boolean(myModelId)}
        canDrag={Boolean(effModelId)}
        dragMode={dragMode}
        canResetPosition={
          Math.abs(menu.offsetX) > 0.005 || Math.abs(menu.offsetY) > 0.005
        }
        onSelect={handleSelect}
        onScale={setMyScale}
        onExpression={handleExpression}
        onToggleFaceTracking={toggleFaceTracking}
        onOpenAdvanced={openAdvanced}
        onToggleDrag={toggleDragMode}
        onResetPosition={handleResetPosition}
        onHide={handleHide}
      />

      <Live2DAdvancedSettings
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        container={menu.root}
        isHost={isHost}
        canUploadModels={canUploadModels}
        builtins={builtins}
        libraryModels={libraryModels}
        expressions={myExpressions}
        myKind={effKind}
        myModelId={effModelId}
        myScale={myScale}
        faceTracking={face}
        policy={policy}
        uploading={uploading}
        onSelect={handleSelect}
        onScale={setMyScale}
        onExpression={handleExpression}
        onToggleFaceTracking={toggleFaceTracking}
        onHide={handleHide}
        onPolicy={handlePolicy}
        onUpload={handleUpload}
        onDeleteModel={handleDeleteModel}
      />
    </div>,
    document.body
  )
}
