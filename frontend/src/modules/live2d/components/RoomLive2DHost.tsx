import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'
import { Sparkles } from 'lucide-react'
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
  useLive2DSync,
} from '../hooks/useLive2DSync'
import { useLive2DPointer } from '../hooks/useLive2DPointer'
import { useLive2DStore } from '../store/live2dStore'
import { Live2DControlPanel } from './Live2DControlPanel'

// 房间悬浮层的宿主。
//
// 三件事必须由它负责，缺一个都会出问题：
//   1. **挂载层级**：挂在 RoomPage（而不是 RoomLayout）上，切一起听/换片都不会卸载；
//   2. **节点搬移**：原生全屏是 top layer，body 级 fixed 会被完全遮住，必须把
//      同一个节点 appendChild 到 fullscreenElement 里（换 portal 目标会重建
//      canvas，WebGL 上下文与纹理全部要重来）；
//   3. **引擎生命周期**：enabled 关掉就销毁 Application，把 WebGL 上下文还回去。

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
  const enabled = useLive2DStore((s) => s.enabled)
  const myKind = useLive2DStore((s) => s.myKind)
  const myModelId = useLive2DStore((s) => s.myModelId)
  const myScale = useLive2DStore((s) => s.myScale)
  const peers = useLive2DStore((s) => s.peers)
  const setEnabled = useLive2DStore((s) => s.setEnabled)
  const setMyModel = useLive2DStore((s) => s.setMyModel)
  const setMyScale = useLive2DStore((s) => s.setMyScale)

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
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
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
  const myModelUrl = myModelId
    ? resolveModelUrl({ kind: myKind, modelId: myModelId }, roomId)
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
    if (!enabled || !canvasEl) return
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
  }, [enabled, canvasEl])

  // 重连后 socket.id 会变：「本机模型」的判定必须跟着换，否则动作同步会断
  // （自己的模型被当成别人的，自动挑 idle 也被关掉）。
  useEffect(() => {
    if (!renderer) return
    renderer.setLocalSid(socket?.id ?? '')
  }, [renderer, socket?.id])

  // ---- 6. 尺寸跟随 ----
  useEffect(() => {
    if (!renderer || !canvasEl) return
    const observer = new ResizeObserver(() => {
      renderer.resize(canvasEl.clientWidth, canvasEl.clientHeight)
    })
    observer.observe(canvasEl)
    return () => observer.disconnect()
  }, [renderer, canvasEl])

  // ---- 7. 默认模型：进房即有角色 ----
  useEffect(() => {
    if (!enabled || myModelId || builtins.length === 0) return
    setMyModel('builtin', builtins[0].id)
  }, [enabled, myModelId, builtins, setMyModel])

  // ---- 8. 声明自己的模型（换模型/改大小才发）----
  useEffect(() => {
    if (!enabled || !socket || !roomId || !myModelId) return
    emitLive2DConfig(socket, roomId, {
      action: 'set',
      kind: myKind,
      modelId: myModelId,
      scale: myScale,
    })
  }, [enabled, socket, roomId, myKind, myModelId, myScale])

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
      if (!enabled || disposedRef.current) {
        instance.stop()
        if (!disposedRef.current) setFace({ on: false, busy: false, error: '' })
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
  }, [enabled])

  const toggleFaceTracking = useCallback(() => {
    if (face.on || face.busy) stopFaceTracking()
    else void startFaceTracking()
  }, [face.on, face.busy, stopFaceTracking, startFaceTracking])

  // 悬浮层被关掉时顺手关摄像头。放进 setTimeout 是为了不在 effect 里同步
  // setState（react-hooks 会判"级联渲染"）——这里晚一个宏任务没有任何影响。
  useEffect(() => {
    if (enabled) return
    const timer = window.setTimeout(stopFaceTracking, 0)
    return () => window.clearTimeout(timer)
  }, [enabled, stopFaceTracking])

  useEffect(() => {
    return () => {
      disposedRef.current = true
      trackerRef.current?.stop()
      trackerRef.current = null
    }
  }, [])

  // ---- 9. 收发 ----
  useLive2DSync({ socket, roomId, renderer })
  useLive2DPointer({
    socket,
    roomId,
    sid: socket?.id ?? '',
    active: enabled && Boolean(myModelId),
    tracker,
  })

  const handleSelect = useCallback(
    (kind: 'builtin' | 'url' | 'room', modelId: string) => {
      setFailed([])
      setMyModel(kind, modelId)
    },
    [setMyModel]
  )

  // 上传：成功后立刻切到新模型——这是房主上传时唯一想做的事。
  const handleUpload = useCallback(
    async (file: File) => {
      if (uploading || !roomId) return
      if (file.size > LIVE2D_UPLOAD_MAX_BYTES) {
        setNotice(
          t('模型包不能超过 {{size}}MB', {
            size: LIVE2D_UPLOAD_MAX_BYTES >> 20,
          })
        )
        setNoticeError(true)
        return
      }
      setUploading(true)
      setNotice('')
      const result = await uploadRoomModel(roomId, file)
      setUploading(false)
      setNotice(result.message)
      setNoticeError(!result.ok)
      if (!result.ok) return
      refreshRoomModels()
      if (result.model) handleSelect('room', result.model.id)
    },
    [uploading, roomId, refreshRoomModels, handleSelect]
  )

  // 表情不本地乐观应用：服务端会把同一条广播发回给自己，
  // 这样「自己看到的」和「别人看到的」永远是同一份事实。
  const handleExpression = useCallback(
    (index: number) => {
      emitLive2DAction(socket, roomId, index)
    },
    [socket, roomId]
  )

  const handleDeleteRoomModel = useCallback(
    async (modelId: string) => {
      if (!roomId) return
      const result = await deleteRoomModel(roomId, modelId)
      setNotice(result.message)
      setNoticeError(!result.ok)
      if (!result.ok) return
      refreshRoomModels()
      // 正用着这个模型就退回第一个内置模型，否则自己和别人都会看到占位卡。
      // 连内置模型都没有（未随包模型）时直接撤回声明，别让别人的名册里
      // 留着一个永远加载不出来的条目。
      if (myKind === 'room' && myModelId === modelId) {
        setFailed([])
        const fallback = builtins[0]?.id
        if (fallback) {
          setMyModel('builtin', fallback)
        } else {
          setMyModel('builtin', '')
          emitLive2DConfig(socket, roomId, { action: 'clear' })
        }
      }
    },
    [roomId, refreshRoomModels, myKind, myModelId, builtins, setMyModel, socket]
  )

  const visible = peers.slice(0, LIVE2D_MAX_RENDERED)
  const hiddenCount = peers.length - visible.length

  return createPortal(
    <div
      ref={hostRef}
      data-live2d-host=""
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}
    >
      {enabled && (
        <div ref={setCanvasEl} style={{ position: 'absolute', inset: 0 }} />
      )}

      {enabled &&
        visible.map((peer, index) => {
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
                  style={{
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

      <div
        style={{
          position: 'absolute',
          right: 16,
          bottom: 'calc(96px + env(safe-area-inset-bottom))',
          pointerEvents: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        {panelOpen && enabled && (
          <Live2DControlPanel
            builtins={builtins}
            roomModels={roomModels}
            canManageRoom={roomCanManage}
            uploading={uploading}
            notice={notice}
            noticeError={noticeError}
            myKind={myKind}
            myModelId={myModelId}
            myScale={myScale}
            isHost={isHost}
            onSelect={handleSelect}
            onScale={setMyScale}
            onUpload={handleUpload}
            onDeleteRoomModel={handleDeleteRoomModel}
            expressions={myExpressions}
            onExpression={handleExpression}
            faceTracking={face}
            onToggleFaceTracking={toggleFaceTracking}
            onClose={() => setPanelOpen(false)}
          />
        )}
        <button
          type="button"
          onClick={() => {
            if (!enabled) {
              setEnabled(true)
              setPanelOpen(true)
              return
            }
            // 打开面板时顺手刷新一次：别人新传的模型能立刻看到。
            if (!panelOpen) refreshRoomModels()
            setPanelOpen((prev) => !prev)
          }}
          aria-label={enabled ? t('角色设置') : t('显示角色')}
          title={enabled ? t('角色设置') : t('显示角色')}
          className="flex h-9 w-9 items-center justify-center rounded-full border shadow-md"
          style={{
            background: 'var(--glass-bg)',
            borderColor: 'var(--glass-border)',
            color: 'var(--md-sys-color-on-surface)',
            opacity: enabled ? 0.9 : 0.65,
          }}
        >
          <Sparkles size={16} />
        </button>
      </div>

      {!enabled && (
        <div
          style={{
            position: 'absolute',
            right: 64,
            bottom: 'calc(102px + env(safe-area-inset-bottom))',
            fontSize: 10,
            color: 'var(--md-sys-color-on-surface-variant)',
            background: 'var(--glass-bg)',
            border: '1px solid var(--glass-border)',
            borderRadius: 8,
            padding: '2px 8px',
            opacity: 0.85,
          }}
        >
          {t('角色已隐藏')}
        </div>
      )}
    </div>,
    document.body
  )
}
