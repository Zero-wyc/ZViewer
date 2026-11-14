import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'
import { Sparkles } from 'lucide-react'
import { loadLive2DEngine } from '../core/cubism-core'
import { loadBuiltinModels, type Live2DModelEntry } from '../core/model-catalog'
import { Live2DRenderer } from '../core/live2d-renderer'
import { slotX } from '../core/scene'
import { LIVE2D_MAX_RENDERED } from '../constants'
import { emitLive2DConfig, useLive2DSync } from '../hooks/useLive2DSync'
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
  const [panelOpen, setPanelOpen] = useState(false)
  const [failed, setFailed] = useState<string[]>([])

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

  // ---- 4. 引擎与渲染器 ----
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
  }, [enabled, canvasEl])

  // ---- 5. 尺寸跟随 ----
  useEffect(() => {
    if (!renderer || !canvasEl) return
    const observer = new ResizeObserver(() => {
      renderer.resize(canvasEl.clientWidth, canvasEl.clientHeight)
    })
    observer.observe(canvasEl)
    return () => observer.disconnect()
  }, [renderer, canvasEl])

  // ---- 6. 默认模型：进房即有角色 ----
  useEffect(() => {
    if (!enabled || myModelId || builtins.length === 0) return
    setMyModel('builtin', builtins[0].id)
  }, [enabled, myModelId, builtins, setMyModel])

  // ---- 7. 声明自己的模型（换模型/改大小才发）----
  useEffect(() => {
    if (!enabled || !socket || !roomId || !myModelId) return
    emitLive2DConfig(socket, roomId, {
      action: 'set',
      kind: myKind,
      modelId: myModelId,
      scale: myScale,
    })
  }, [enabled, socket, roomId, myKind, myModelId, myScale])

  // ---- 8. 收发 ----
  useLive2DSync({ socket, roomId, renderer })
  useLive2DPointer({
    socket,
    roomId,
    sid: socket?.id ?? '',
    active: enabled && Boolean(myModelId),
  })

  const handleSelect = useCallback(
    (kind: 'builtin' | 'url' | 'room', modelId: string) => {
      setFailed([])
      setMyModel(kind, modelId)
    },
    [setMyModel]
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
            myKind={myKind}
            myModelId={myModelId}
            myScale={myScale}
            isHost={isHost}
            onSelect={handleSelect}
            onScale={setMyScale}
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
