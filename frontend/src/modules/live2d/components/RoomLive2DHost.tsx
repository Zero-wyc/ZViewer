import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'
import { Camera, Sparkles } from 'lucide-react'
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
import { clearDragPref, loadDragPref, saveDragPref } from '../core/drag-prefs'
import { getEntry, listEntries, setLocalDrag, slotX } from '../core/scene'
import { pickVisiblePeers, resolveEffectiveModel } from '../core/visibility'
import {
  LIVE2D_DRAG_INTERVAL_MS,
  LIVE2D_DRAG_PREF_APPLY_DELAY_MS,
  LIVE2D_MAX_RENDERED,
} from '../constants'
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
import { Live2DContextMenu } from './Live2DContextMenu'
import { Live2DDragLayer } from './Live2DDragLayer'
import { Live2DFaceMonitor } from './Live2DFaceMonitor'
import { Live2DSettingsModal } from './Live2DSettingsModal'

// 房间悬浮层的宿主。
//
// 四件事必须由它负责，缺一个都会出问题：
//   1. **挂载层级**：挂在 RoomPage（而不是 RoomLayout）上，切一起听/换片都不会卸载；
//   2. **节点搬移**：原生全屏是 top layer，body 级 fixed 会被完全遮住，必须把
//      同一个节点 appendChild 到 fullscreenElement 里（换 portal 目标会重建
//      canvas，WebGL 上下文与纹理全部要重来）；
//   3. **引擎生命周期**：卸载就销毁 Application，把 WebGL 上下文还回去；
//   4. **入口**：右键角色呼出快捷菜单（表情/大小/动捕/拖拽/删除），换模型与
//      房间设置统一走「角色设置」弹窗；右下角另有一个常驻圆钮直通后者
//      （右键依赖包围盒命中，模型加载失败 / 命中漏判时它是唯一退路）。
//   5. **拖拽模式**：菜单里开启后可把自己的角色拖到任意位置，偏移同步给
//      全房间（各端看到的站位一致）。它会给角色套一层透明抓取层，所以只在
//      用户主动开启时存在。
//
// canvas 是 `pointer-events: none` 的，否则房间的拖拽、双击全屏、视频控件全被
// 吃掉；所以「右键落在哪个角色上」只能由渲染器的包围盒判定（renderer.pick）。

/**
 * 模型的显示名。
 *
 * 三个来源的名字不在同一个结构里（内置清单、服务端库、自定义地址），而界面
 * 上只需要一句"我现在用的是哪个"。查不到时退回 id：宁可显示一串标识，也别
 * 显示空白让人以为没选模型。
 */
function labelOf(
  kind: Live2DModelKind,
  id: string,
  builtins: Live2DModelEntry[],
  libraryModels: Live2DLibraryEntry[]
): string {
  if (!id) return ''
  if (kind === 'builtin') {
    return builtins.find((item) => item.id === id)?.label || id
  }
  if (kind === 'room') {
    return libraryModels.find((item) => item.id === id)?.label || id
  }
  return t('自定义模型地址')
}

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
  const removed = useLive2DStore((s) => s.removed)
  const peers = useLive2DStore((s) => s.peers)
  const policy = useLive2DStore((s) => s.policy)
  const setMyModel = useLive2DStore((s) => s.setMyModel)
  const setMyScale = useLive2DStore((s) => s.setMyScale)
  const setRemoved = useLive2DStore((s) => s.setRemoved)
  const voiceLipSync = useLive2DStore((s) => s.voiceLipSync)
  const setVoiceLipSync = useLive2DStore((s) => s.setVoiceLipSync)

  // 房主统一角色时，显示的模型不再是「我选的」而是房间定的；我自己的选择
  // 仍然留在 store 里，关掉统一角色就自动回来。
  //
  // 解算逻辑在 core/visibility.ts：这三个量（生效模型 / 是否统一 / 是否已删除）
  // 会被 effect 依赖表和 UI 同时用到，散着写必然出现「面板说删了、实际上
  // 还在发声明」这类不一致。
  //
  // 必须包在 useMemo 里，**不能裸调**：React Compiler 遇到组件体里对未知
  // 外部函数的直接调用会推导出"可能修改任何值"，进而放弃保留所有 useCallback，
  // 整个文件报一片 react-hooks/preserve-manual-memoization。useMemo 把"这是
  // 纯计算"这件事显式告诉编译器，问题就消失了。
  const eff = useMemo(
    () =>
      resolveEffectiveModel({
        unified: policy.unified,
        unifiedKind: policy.unifiedKind,
        unifiedId: policy.unifiedId,
        myKind,
        myModelId,
        removed,
      }),
    [
      policy.unified,
      policy.unifiedKind,
      policy.unifiedId,
      myKind,
      myModelId,
      removed,
    ]
  )
  const unifiedActive = eff.unified
  const effKind = eff.kind
  const effModelId = eff.modelId
  const removedNow = eff.removed
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
  const [settingsOpen, setSettingsOpen] = useState(false)

  // 模型名同时用在右键菜单（「当前模型」）和设置页（统一角色的只读展示），
  // 算一次就够。必须包 useMemo：组件体里裸调外部函数会让 React Compiler
  // 放弃保留整个组件的 memo（详见 eff 那段注释）。
  const effLabel = useMemo(
    () => labelOf(effKind, effModelId, builtins, libraryModels),
    [effKind, effModelId, builtins, libraryModels]
  )
  const unifiedLabel = useMemo(
    () =>
      labelOf(
        policy.unifiedKind ?? 'builtin',
        policy.unifiedId ?? '',
        builtins,
        libraryModels
      ),
    [policy.unifiedKind, policy.unifiedId, builtins, libraryModels]
  )
  // 有权删的模型：设置页在「管理」态下给这些条目加删除按钮。服务端已经算好
  // deletable（本人上传的 / 管理员看到的全部），前端不再自己推权限。
  const removableIds = useMemo(
    () => libraryModels.filter((item) => item.deletable).map((item) => item.id),
    [libraryModels]
  )
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
  // 监视窗是否展开。开启动捕时自动展开一次：用户刚点完开关，最想知道的是
  // 「摄像头到底拍到我没有」，而不是先看到一个抽象的成功提示。
  const [faceMonitor, setFaceMonitor] = useState(false)
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

  // 「对观众显示角色」被关掉时，这一层以前是**静默消失**：观众看不到角色，
  // 也不知道是房主关的，只会以为功能坏了（尤其是刚进房就看到一片空白）。
  // 这里在隐藏期间说一次状态——不渲染任何东西，只解释「为什么没有」。
  // 房主与服务器管理员不受影响（他们永远看得见），所以不会走到这条分支。
  const hiddenNoticeRef = useRef(false)
  useEffect(() => {
    if (canShowLayer) {
      hiddenNoticeRef.current = false
      return
    }
    if (hiddenNoticeRef.current) return
    hiddenNoticeRef.current = true
    message.info(t('房主已关闭角色显示'))
  }, [canShowLayer])

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
  //
  // 判断用 `myModelId` 而不是生效模型：统一角色时生效模型是房间定的，这里若
  // 拿它做判断就永远不会补默认值，房主一关统一自己反而没角色了。
  //
  // `removedNow` 必须进依赖：角色被删除期间不补默认模型（否则「删除」会被
  // 这条 effect 立刻撤销——这正是以前"藏了又自己冒出来"的来源）。
  useEffect(() => {
    if (removedNow || unifiedActive || myModelId || builtins.length === 0)
      return
    setMyModel('builtin', builtins[0].id)
  }, [removedNow, unifiedActive, myModelId, builtins, setMyModel])

  // ---- 8. 声明自己的模型（换模型/改大小才发；没模型时撤回声明）----
  //
  // 用「生效模型」而不是「我选的模型」：房主统一角色时服务端名册也跟着统一，
  // 各端画出来的才是同一个。
  //
  // ack 是唯一能知道「服务端有没有收下这个模型」的地方，必须接住：房间满 12 个、
  // 模型已被别人删掉、模型标识不合法、自定义地址只有房主能设——这几种以前全是
  // 静默失败，用户看到的只是「选了模型却没有角色」。
  // 同一条错误只提示一次：这条 effect 会在重连等情况下重跑，重复弹窗只是噪音。
  const declareErrorRef = useRef('')
  useEffect(() => {
    if (!socket || !roomId) return
    if (!effModelId) {
      // 只在「已删除」时撤回声明：刚进房还没挑模型时不必先 clear 一次，
      // 否则别人那边会先看到角色消失再出现。
      if (removedNow) emitLive2DConfig(socket, roomId, { action: 'clear' })
      return
    }
    emitLive2DConfig(
      socket,
      roomId,
      {
        action: 'set',
        kind: effKind,
        modelId: effModelId,
        scale: myScale,
      },
      (ack) => {
        // 没有回执（断线）不当成失败：那种情况下重连会自己重发一次。
        if (!ack || ack.success) {
          declareErrorRef.current = ''
          return
        }
        const text = ack.message || t('角色模型应用失败')
        if (declareErrorRef.current === text) return
        declareErrorRef.current = text
        message.error(text)
      }
    )
  }, [socket, roomId, effKind, effModelId, myScale, removedNow])

  // ---- 8b. 摄像头动捕 ----
  //
  // 只有用户点开关才会申请摄像头（这也是一次用户手势，权限弹窗才不会
  // 被浏览器拦）。关掉、换房、卸载都要停：track 不停会一直亮着摄像头灯。
  const stopFaceTracking = useCallback(() => {
    const current = trackerRef.current
    trackerRef.current = null
    current?.stop()
    setTracker(null)
    setFaceMonitor(false)
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
      setFaceMonitor(true)
      setFace({ on: true, busy: false, error: '' })
    } catch (err) {
      setFace({
        on: false,
        busy: false,
        error: err instanceof Error ? err.message : t('摄像头动捕启动失败'),
      })
    }
  }, [])

  /** 重新标定：换坐姿/挪了电脑之后不必关掉动捕重开。 */
  const recalibrateFace = useCallback(() => {
    trackerRef.current?.recalibrate()
  }, [])

  const toggleFaceTracking = useCallback(() => {
    if (face.on || face.busy) stopFaceTracking()
    else void startFaceTracking()
  }, [face.on, face.busy, stopFaceTracking, startFaceTracking])

  const toggleVoiceLipSync = useCallback(() => {
    setVoiceLipSync(!voiceLipSync)
  }, [setVoiceLipSync, voiceLipSync])

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
      if (settingsOpen) return
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
  }, [renderer, settingsOpen, openMenuAt])

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
      // 松手即落本机偏好：下次进房 / 换回来时自动站回这个位置。
      // 拖动中不写（每帧一次 localStorage 写太重，而且中间值没有意义）。
      if (final && effModelId) saveDragPref(effKind, effModelId, x, y)
    },
    [socket, roomId, effKind, effModelId]
  )

  const handleResetPosition = useCallback(() => {
    if (mySid) setLocalDrag(mySid, 0, 0)
    emitLive2DDrag(socket, roomId, 0, 0)
    // 「回到原位」也要把本机偏好清掉：否则下次进房又被挪回旧位置，
    // 用户会觉得这个按钮没生效。
    if (effModelId) clearDragPref(effKind, effModelId)
    // 从菜单点进来时顺手收起：位置已经回原位，「回到原位」不该还挂在那儿
    closeMenu()
  }, [mySid, socket, roomId, effKind, effModelId, closeMenu])

  // ---- 8e. 进房 / 换模型后应用本机的拖拽偏好 ----
  //
  // 为什么延迟 800ms：刚声明完模型时 join 快照可能还没到，名册里没有我，
  // 这时候写场景会被随后的 upsert 覆盖掉。代价是角色先出现在默认槽位、
  // 再平滑滑到记忆里的位置——比"每次都回默认、人人重拖一遍"好得多。
  //
  // 每个 (sid, 模型) 只应用一次：否则用户手动拖到别处后，任何一次重连之外的
  // 重渲染都会把他拽回记忆里的位置。
  const dragPrefAppliedRef = useRef('')
  useEffect(() => {
    if (!mySid || !effModelId) return
    const key = `${mySid}|${effKind}:${effModelId}`
    if (dragPrefAppliedRef.current === key) return
    const timer = window.setTimeout(() => {
      const pref = loadDragPref(effKind, effModelId)
      if (!pref) {
        // 没记过（或原点）也要标记，免得每次依赖抖动都白等 800ms 再查一遍
        dragPrefAppliedRef.current = key
        return
      }
      // 名册里还没有我：不标记，等下一次依赖变化（快照到达/重连）再试
      if (!getEntry(mySid)) return
      setLocalDrag(mySid, pref.x, pref.y)
      emitLive2DDrag(socket, roomId, pref.x, pref.y)
      dragPrefAppliedRef.current = key
    }, LIVE2D_DRAG_PREF_APPLY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [mySid, effKind, effModelId, socket, roomId])

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
        // 用渲染器里的**实际**偏移：模型贴到画面边界后会被夹住，标签再按
        // 场景里的原始偏移走就会自己飘出屏幕。
        const eff = renderer?.dragOf(entry.peer.sid)
        // 偏移与 CSS 的 translate3d 同向（都向下为正），可以直接乘
        const dx = (eff?.x ?? entry.currentDragX) * w
        const dy = (eff?.y ?? entry.currentDragY) * h
        const key = `${dx.toFixed(1)}|${dy.toFixed(1)}`
        if (last.get(entry.peer.sid) === key) continue
        last.set(entry.peer.sid, key)
        el.style.transform = `translateX(-50%) translate3d(${dx}px, ${dy}px, 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [renderer])

  // ---- 8f. 别人删掉了我在用的模型 ----
  //
  // 公共库是全服的，删的人可能根本不在这个房间（甚至不在线）。服务端已经把
  // 我的角色从名册里摘掉了，这里负责把**本地选择**也换掉：否则 store 会一直
  // 指着一个不存在的模型，下次进房只会得到「该模型已不存在」的 ack 失败，
  // 或者一张永远加载不出来的占位卡。
  const handleModelRemoved = useCallback(
    (modelId: string) => {
      if (myKind === 'room' && myModelId === modelId) {
        const wasRemoved = removedNow
        const fallback = builtins[0]?.id ?? ''
        setFailed({})
        setMyModel('builtin', fallback)
        // setMyModel 会顺手清掉「已删除」：但这次换模型不是为了恢复角色，
        // 用户明确删掉的角色不该因为别人删了一个模型又自己冒出来。
        if (wasRemoved) setRemoved(true)
        else {
          message.warning(
            fallback
              ? t('你用的模型已被删除，已换成默认模型')
              : t('你用的模型已被删除')
          )
        }
      }
      // 统一角色指向它：服务端已关掉统一并广播了新策略，这里只说清原因。
      if (policy.unifiedKind === 'room' && policy.unifiedId === modelId) {
        message.warning(t('房间统一使用的模型已被删除'))
      }
    },
    [
      myKind,
      myModelId,
      removedNow,
      builtins,
      setMyModel,
      setRemoved,
      policy.unifiedKind,
      policy.unifiedId,
    ]
  )

  // ---- 9. 收发 ----
  useLive2DSync({
    socket,
    roomId,
    renderer,
    onModelRemoved: handleModelRemoved,
  })
  useLive2DPointer({
    socket,
    roomId,
    sid: mySid,
    active: canShowLayer && Boolean(effModelId),
    tracker,
    // 语音口型是本机偏好：只影响"我的嘴怎么动"，不需要房间级开关
    // （房主那边的 allowFace 管的是摄像头，麦克风电平不出本机）。
    lipSync: voiceLipSync,
  })

  // ---- 10. 动作 ----
  //
  // 注意这里**不能**写 `useLive2DStore.getState()`：编译器把手势回调里任何
  // 以 use 开头的调用都当成 hook（"hook inside callback"），一旦出现就会
  // 放弃编译整个组件，然后每个 useCallback 都被报成
  // preserve-manual-memoization。所以本机状态一律通过依赖表拿。
  const handleSelect = useCallback(
    (kind: Live2DModelKind, modelId: string) => {
      setFailed({})
      // setMyModel 会顺手清掉 removed：选模型就是"我要有角色"的动作，
      // 否则用户点了列表却什么都没发生。
      setMyModel(kind, modelId)
    },
    [setMyModel]
  )

  /**
   * 删除角色：从房间里撤掉自己的模型，并且**不再自动恢复**。
   *
   * 与旧的「隐藏」相比只有一点不同，但正是问题所在：删除是一种状态
   * （`removed = true`），不是一条"临时记录"。它不需要房间号、不需要在
   * 统一角色时被清理、也不会被默认模型 effect 撤销——恢复只有一条路：
   * 从模型列表里重新选一个（见 handleSelect）。
   *
   * `myModelId` 保持不动：这样选择器仍然高亮"上次用的那个"，点一下就能回来。
   */
  const handleRemove = useCallback(() => {
    // 统一角色期间没有"删掉自己"这回事：全房间同一个模型，删了只会变成
    // "我不在画面里"。UI 已经不给入口，这里再挡一道。
    if (unifiedActive) return
    setRemoved(true)
    // 没有角色了，拖拽模式留着只会让下次选模型时突然冒出一个抓取层
    setDragMode(false)
    closeMenu()
    setSettingsOpen(false)
  }, [unifiedActive, setRemoved, closeMenu])

  // 表情不本地乐观应用：服务端会把同一条广播发回给自己，
  // 这样「自己看到的」和「别人看到的」永远是同一份事实。
  const handleExpression = useCallback(
    (index: number) => {
      emitLive2DAction(socket, roomId, index)
    },
    [socket, roomId]
  )

  // 上传本身只做一件事：把文件传进公共库（所有房间都能选），成功后返回新
  // 模型的 id。**传完拿它干什么由调用方决定**——「我的角色」页是切到自己
  // 身上，「房间设置」页是设为统一模型。以前写死成前者，于是房主开着统一
  // 角色时两边都没有上传入口（我的角色页在统一时不渲染选择器）。
  const doUpload = useCallback(
    async (file: File): Promise<string> => {
      if (uploading) return ''
      if (file.size > LIVE2D_UPLOAD_MAX_BYTES) {
        message.error(
          t('模型包不能超过 {{size}}MB', {
            size: LIVE2D_UPLOAD_MAX_BYTES >> 20,
          })
        )
        return ''
      }
      setUploading(true)
      const result = await uploadLibraryModel(file)
      setUploading(false)
      if (!result.ok) {
        message.error(result.message)
        return ''
      }
      message.success(result.message)
      refreshLibrary()
      return result.model?.id ?? ''
    },
    [uploading, refreshLibrary]
  )

  const handleUpload = useCallback(
    async (file: File) => {
      const modelId = await doUpload(file)
      if (modelId) handleSelect('room', modelId)
    },
    [doUpload, handleSelect]
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
      // 我选中的正是它（哪怕角色此刻是删除状态，选择器里仍指着它）：退回
      // 第一个内置模型；连内置模型都没有（未随包模型）时直接清空，别让
      // 名册里留一个永远加载不出来的条目。
      if (myKind === 'room' && myModelId === modelId) {
        setFailed({})
        const fallback = builtins[0]?.id
        // setMyModel 会把 removed 清掉——但用户是"删了角色"而不是"要换一个
        // 角色"，这里手动把删除状态还回去。
        setMyModel('builtin', fallback ?? '')
        if (removed) setRemoved(true)
      }
    },
    [
      refreshLibrary,
      policy,
      myKind,
      myModelId,
      builtins,
      removed,
      setMyModel,
      setRemoved,
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

  /**
   * 在「房间设置」里上传：房主点这个按钮的意图就是"用这个当统一模型"。
   *
   * 走 handlePolicy 而不是自己 emit，是为了和那三个开关共用同一条回执路径
   * （失败会弹 message）；统一模型是一次完整写入——三个字段要么都对，要么
   * 都不对，不能只改 id 留下旧的 kind。
   */
  const handleUploadUnified = useCallback(
    async (file: File) => {
      const modelId = await doUpload(file)
      if (!modelId) return
      handlePolicy({ unified: true, unifiedKind: 'room', unifiedId: modelId })
    },
    [doUpload, handlePolicy]
  )

  const openSettings = useCallback(() => {
    // 右下角圆钮和右键菜单里的「角色设置」都会进来：两条路都得在这里重算
    // 挂载点，否则从按钮直接打开（或全屏切换之后再打开）会把面板挂到全屏
    // 子树外面，表现就是「点了没反应」。
    const fs = document.fullscreenElement
    setMenu((prev) => ({
      ...prev,
      open: false,
      root: fs instanceof HTMLElement ? fs : null,
    }))
    setSettingsOpen(true)
  }, [])

  // 自己一定在 visible 里：人一多，按 ord 排到第 7 位的人就再也不会被画出来，
  // 而画面上没有任何东西能说明"你的角色在，只是没画"
  const visible = pickVisiblePeers(
    peers,
    mySid,
    LIVE2D_MAX_RENDERED,
    (p) => p.sid
  )
  const hiddenCount = peers.length - visible.length
  // 拖拽模式的两个前提：有自己的模型，且模型当前真的在画面上。房主统一角色
  // 时模型是房间定的，但位置仍然是每个成员自己的，所以照拖不误。
  const dragActive =
    canShowLayer && dragMode && Boolean(effModelId) && Boolean(mySid)
  // 入口**常驻**，不再「有模型就收起来」：
  //   - 模型加载失败时画面上只剩占位小方块，`renderer.pick` 打不中，右键就没
  //     任何反应——这正是用户最需要打开设置（换/删模型）的时候，收起来等于
  //     把人锁在外面；
  //   - 画布是 pointer-events:none，右键判定走包围盒，摄像头动捕在动、缩放
  //     拉到很小、或者角色被别的浮层挡住时也会漏判，不能把入口押在命中上；
  //   - 房主关掉「对观众显示角色」时，观众这一层是空的，但入口照样要在：
  //     整层消失的话，被关的最惨的那个人反而连"这是被关了"都没处看。
  //     所以这里只条件渲染**画面**，圆钮与设置弹窗始终存在。

  return createPortal(
    <div
      ref={hostRef}
      data-live2d-host=""
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}
    >
      {/* 房主关掉「对观众显示角色」时，只关画面，不关入口（见上面的说明）。
          canvas 不挂载 → 引擎也不会加载，隐藏期间没有额外的显存开销。 */}
      {canShowLayer && (
        <div ref={setCanvasEl} style={{ position: 'absolute', inset: 0 }} />
      )}

      {canShowLayer &&
        visible.map((peer, index) => {
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
                  title={t('模型加载失败：{{reason}}（右键可以换一个模型）', {
                    reason: failureReason,
                  })}
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

      {canShowLayer && hiddenCount > 0 && (
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
      {canShowLayer && engineError && (
        // 挪到左下角：右下角是「角色设置 / 动捕监视窗」的竖列，引擎失败时
        // 监视窗仍然可能被打开（动捕与渲染是两条独立的链路），压在它下面
        // 等于把这条唯一的线索藏起来。
        <div
          className="absolute bottom-16 left-3 max-w-[50vw] truncate rounded-md px-2 py-1 text-[10px] text-white/90"
          style={{ background: 'rgba(0,0,0,0.55)', pointerEvents: 'auto' }}
          title={t('Live2D 引擎加载失败：{{reason}}', { reason: engineError })}
        >
          {t('Live2D 引擎加载失败')}
        </div>
      )}

      {/* 动捕监视窗 / 收起后的入口。与角色按钮同一列（bottom-6 语音 → 84
          角色设置 → 这里 144），展开时向上生长，不会盖住下面两个圆钮。 */}
      {canShowLayer && tracker && (
        <div
          className="absolute right-6 bottom-[144px]"
          style={{ pointerEvents: 'auto' }}
        >
          {faceMonitor ? (
            <Live2DFaceMonitor
              tracker={tracker}
              onRecalibrate={recalibrateFace}
              onClose={() => setFaceMonitor(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setFaceMonitor(true)}
              aria-label={t('动捕预览')}
              title={t('动捕预览')}
              className={cn(
                'glass-card relative flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200',
                'hover:scale-105 hover:shadow-xl active:scale-95'
              )}
              style={{
                backgroundColor: 'var(--glass-bg)',
                color: 'var(--md-sys-color-on-surface)',
              }}
            >
              <Camera className="h-5 w-5" />
              {/* 绿点：动捕还在跑，只是预览收起来了 */}
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-400" />
            </button>
          )}
        </div>
      )}

      <div
        className="absolute right-6 bottom-[84px]"
        style={{ pointerEvents: 'auto' }}
      >
        <button
          type="button"
          onClick={openSettings}
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
        modelLabel={effLabel}
        expressions={myExpressions}
        removed={removedNow}
        canRemove={!unifiedActive && !removedNow && Boolean(myModelId)}
        onRemove={handleRemove}
        myScale={myScale}
        faceTracking={face}
        allowFace={policy.allowFace}
        unified={unifiedActive}
        canDrag={Boolean(effModelId)}
        dragMode={dragMode}
        canResetPosition={
          Math.abs(menu.offsetX) > 0.005 || Math.abs(menu.offsetY) > 0.005
        }
        onScale={setMyScale}
        onExpression={handleExpression}
        onToggleFaceTracking={toggleFaceTracking}
        onOpenSettings={openSettings}
        onToggleDrag={toggleDragMode}
        onResetPosition={handleResetPosition}
      />

      <Live2DSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        container={menu.root}
        isHost={isHost}
        canUploadModels={canUploadModels}
        builtins={builtins}
        libraryModels={libraryModels}
        removableIds={removableIds}
        expressions={myExpressions}
        selectedKind={myKind}
        selectedModelId={myModelId}
        removed={removedNow}
        canRemove={!unifiedActive && !removedNow && Boolean(myModelId)}
        myScale={myScale}
        faceTracking={face}
        voiceLipSync={voiceLipSync}
        policy={policy}
        unifiedLabel={unifiedLabel}
        hiddenByHost={!canShowLayer}
        uploading={uploading}
        onSelect={handleSelect}
        onScale={setMyScale}
        onExpression={handleExpression}
        onToggleFaceTracking={toggleFaceTracking}
        onToggleVoiceLipSync={toggleVoiceLipSync}
        onRemove={handleRemove}
        onPolicy={handlePolicy}
        onUpload={handleUpload}
        onUploadUnified={handleUploadUnified}
        onDeleteModel={handleDeleteModel}
      />
    </div>,
    document.body
  )
}
