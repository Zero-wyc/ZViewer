import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'
import { Sparkles } from 'lucide-react'
import { message } from '@/components/ui/message'
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
  deleteRoomModel,
  loadRoomModels,
  uploadRoomModel,
  type RoomModelEntry,
} from '../core/room-models'
import { Live2DRenderer } from '../core/live2d-renderer'
import { slotX } from '../core/scene'
import { LIVE2D_MAX_RENDERED } from '../constants'
import {
  emitLive2DAction,
  emitLive2DConfig,
  emitLive2DMotion,
  emitLive2DPolicy,
  useLive2DSync,
} from '../hooks/useLive2DSync'
import { useLive2DPointer } from '../hooks/useLive2DPointer'
import { useLive2DStore } from '../store/live2dStore'
import type { Live2DModelKind, Live2DPolicy } from '../types'
import { Live2DAdvancedSettings } from './Live2DAdvancedSettings'
import { Live2DContextMenu } from './Live2DContextMenu'

// 房间悬浮层的宿主。
//
// 四件事必须由它负责，缺一个都会出问题：
//   1. **挂载层级**：挂在 RoomPage（而不是 RoomLayout）上，切一起听/换片都不会卸载；
//   2. **节点搬移**：原生全屏是 top layer，body 级 fixed 会被完全遮住，必须把
//      同一个节点 appendChild 到 fullscreenElement 里（换 portal 目标会重建
//      canvas，WebGL 上下文与纹理全部要重来）；
//   3. **引擎生命周期**：卸载就销毁 Application，把 WebGL 上下文还回去；
//   4. **入口**：设置界面对角色右键呼出（自己还没角色时退化成右下角一个按钮）。
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
  const [builtins, setBuiltins] = useState<Live2DModelEntry[]>([])
  const [roomModels, setRoomModels] = useState<RoomModelEntry[]>([])
  const [roomCanManage, setRoomCanManage] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
  }>({ open: false, x: 0, y: 0, root: null })

  const openMenuAt = useCallback((clientX: number, clientY: number) => {
    const fs = document.fullscreenElement
    setMenu({
      open: true,
      x: clientX,
      y: clientY,
      root: fs instanceof HTMLElement ? fs : null,
    })
  }, [])
  const [failed, setFailed] = useState<string[]>([])
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

  const mySid = socket?.id ?? ''
  // 能管理房间的人（房主 / root）自己永远看得到角色，否则他也没法再右键改回来。
  // roomCanManage 来自模型库接口（root 也算），所以只能在 state 之后算。
  const canShowLayer = isHost || roomCanManage || policy.showToViewers

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

  // ---- 4. 房间模型库（房主上传，全房间共用）----
  //
  // 刷新用「版本号 + effect」而不是在事件里直接 setState：上传/删除之后
  // 只是把版本号加一，真正的取数留在 effect 里，避免多处各写一遍 promise 链，
  // 也满足 react-hooks 对「effect 内不要同步 setState」的要求。
  const [roomModelsVersion, setRoomModelsVersion] = useState(0)
  const refreshRoomModels = useCallback(
    () => setRoomModelsVersion((v) => v + 1),
    []
  )

  useEffect(() => {
    if (!roomId) return
    let cancelled = false
    void loadRoomModels(roomId).then((list) => {
      if (cancelled) return
      setRoomModels(list.models)
      setRoomCanManage(list.canManage)
    })
    return () => {
      cancelled = true
    }
  }, [roomId, roomModelsVersion])

  // ---- 4b. 我的模型有哪些表情 ----
  const myModelUrl = effModelId
    ? resolveModelUrl({ kind: effKind, modelId: effModelId }, roomId)
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
          onModelError: (sid) => {
            setFailed((prev) => (prev.includes(sid) ? prev : [...prev, sid]))
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
      setFailed([])
      setMyModel(kind, modelId)
      setHidden(false)
    },
    [setMyModel, setHidden]
  )

  const handleHide = useCallback(() => {
    setMyModel('builtin', '')
    setHidden(true)
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

  // 上传：成功后立刻切到新模型——这是房主上传时唯一想做的事。
  const handleUpload = useCallback(
    async (file: File) => {
      if (uploading || !roomId) return
      if (file.size > LIVE2D_UPLOAD_MAX_BYTES) {
        message.error(
          t('模型包不能超过 {{size}}MB', {
            size: LIVE2D_UPLOAD_MAX_BYTES >> 20,
          })
        )
        return
      }
      setUploading(true)
      const result = await uploadRoomModel(roomId, file)
      setUploading(false)
      if (!result.ok) {
        message.error(result.message)
        return
      }
      message.success(result.message)
      refreshRoomModels()
      if (result.model) handleSelect('room', result.model.id)
    },
    [uploading, roomId, refreshRoomModels, handleSelect]
  )

  const handleDeleteRoomModel = useCallback(
    async (modelId: string) => {
      if (!roomId) return
      const result = await deleteRoomModel(roomId, modelId)
      if (!result.ok) {
        message.error(result.message)
        return
      }
      message.success(result.message)
      refreshRoomModels()

      // 统一角色用的正是它：先把统一关掉，否则全房间都会加载失败只剩占位卡
      if (policy.unifiedKind === 'room' && policy.unifiedId === modelId) {
        emitLive2DPolicy(socket, roomId, { unified: false })
      }
      // 自己正用着就退回第一个内置模型；连内置模型都没有（未随包模型）时
      // 直接撤回声明，别让别人的名册里留一个永远加载不出来的条目。
      if (effKind === 'room' && effModelId === modelId) {
        setFailed([])
        const fallback = builtins[0]?.id
        setMyModel('builtin', fallback ?? '')
        setHidden(!fallback)
      }
    },
    [
      roomId,
      refreshRoomModels,
      policy,
      effKind,
      effModelId,
      builtins,
      setMyModel,
      setHidden,
      socket,
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
  // 没有角色时才给一个常驻入口：此时画面上没有东西可右键，否则用户会被
  // 永久锁在外面（这也是取消「整个悬浮层开关」的原因）。
  const showFab = !effModelId

  if (!canShowLayer) return null

  return createPortal(
    <div
      ref={hostRef}
      data-live2d-host=""
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}
    >
      <div ref={setCanvasEl} style={{ position: 'absolute', inset: 0 }} />

      {visible.map((peer, index) => {
        const isFailed = failed.includes(peer.sid)
        return (
          <div
            key={peer.sid}
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
            {isFailed && (
              <div
                title={t('自定义模型未能加载（可能被跨域限制）')}
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
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            right: 12,
            fontSize: 10,
            opacity: 0.7,
          }}
        >
          {t('另有 {{count}} 个角色未显示', { count: hiddenCount })}
        </div>
      )}

      {showFab && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 'calc(96px + env(safe-area-inset-bottom))',
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            onClick={openAdvanced}
            aria-label={t('角色设置')}
            title={t('角色设置')}
            className="flex h-9 w-9 items-center justify-center rounded-full border shadow-md"
            style={{
              background: 'var(--glass-bg)',
              borderColor: 'var(--glass-border)',
              color: 'var(--md-sys-color-on-surface)',
              opacity: 0.9,
            }}
          >
            <Sparkles size={16} />
          </button>
        </div>
      )}

      <Live2DContextMenu
        open={menu.open}
        position={{ x: menu.x, y: menu.y }}
        onClose={closeMenu}
        container={menu.root}
        builtins={builtins}
        roomModels={roomModels}
        expressions={myExpressions}
        myKind={effKind}
        myModelId={effModelId}
        myScale={myScale}
        faceTracking={face}
        allowFace={policy.allowFace}
        unified={unifiedActive}
        canHide={!unifiedActive && Boolean(myModelId)}
        onSelect={handleSelect}
        onScale={setMyScale}
        onExpression={handleExpression}
        onToggleFaceTracking={toggleFaceTracking}
        onOpenAdvanced={openAdvanced}
        onHide={handleHide}
      />

      <Live2DAdvancedSettings
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        container={menu.root}
        isHost={isHost}
        canUploadModels={roomCanManage}
        builtins={builtins}
        roomModels={roomModels}
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
        onDeleteRoomModel={handleDeleteRoomModel}
      />
    </div>,
    document.body
  )
}
