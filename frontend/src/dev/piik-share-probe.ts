/**
 * 共享探针页（仅开发用，不进构建产物）。
 *
 * 目的不是做 UI，而是在真实浏览器里验证 `modules/piik-share`：
 * 房主在这条链路上开播、观众收到画面，整条 SDP 交换都走 `/signal` 的
 * `signal` 帧，不碰 socket.io 的 `share` 事件。
 *
 * 用法：`/piik-share-probe.html?room=<roomId>&role=host` 与 `?room=<roomId>`。
 */
import { io, type Socket } from 'socket.io-client'
import { buildSocketAuth } from '@/lib/authTransport'
import { PiikShareSession } from '../modules/piik-share/session.ts'

// 记录 /signal 上收发的每一帧：探针页的唯一价值就是看清协议往返。
const signalFrames: { dir: 'in' | 'out'; data: unknown }[] = []
const RawWebSocket = window.WebSocket
class TracedWebSocket extends RawWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols)
    if (!String(url).includes('/signal')) return
    this.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          type?: string
          phase?: string
          revision?: number
          candidate?: { childPeerId?: string; connectionId?: string }
          assignment?: {
            upstream?: { kind?: string; peerId?: string }
            childPeerIds?: string[]
          }
        }
        signalFrames.push({ dir: 'in', data })
        let detail = ''
        if (data.phase) detail += ` ${data.phase} r${data.revision}`
        if (data.candidate) detail += ` cand=${data.candidate.connectionId}`
        if (data.assignment) {
          detail += ` up=${data.assignment.upstream?.kind ?? '?'}:${data.assignment.upstream?.peerId ?? ''}`
          detail += ` children=${(data.assignment.childPeerIds ?? []).length}`
        }
        log(`<- ${data.type ?? '?'}${detail}`)
      } catch {
        /* 非 JSON */
      }
    })
    const send = this.send.bind(this)
    this.send = (
      payload: string | ArrayBufferLike | Blob | ArrayBufferView
    ) => {
      try {
        const data = JSON.parse(String(payload)) as {
          type?: string
          targetPeerId?: string
          payload?: { kind?: string }
        }
        signalFrames.push({ dir: 'out', data })
        log(
          `-> ${data.type ?? '?'}${data.targetPeerId ? ' → ' + data.targetPeerId : ''}${data.payload?.kind ? ' (' + data.payload.kind + ')' : ''}`
        )
      } catch {
        /* 非 JSON */
      }
      return send(payload)
    }
  }
}
window.WebSocket = TracedWebSocket as unknown as typeof WebSocket

const params = new URLSearchParams(location.search)
const roomId = params.get('room') ?? ''
const isHost = params.get('role') === 'host'

const logEl = document.getElementById('log') as HTMLDivElement
const stateEl = document.getElementById('state') as HTMLSpanElement
const videoEl = document.getElementById('video') as HTMLVideoElement
const startButton = document.getElementById('start') as HTMLButtonElement

function log(line: string): void {
  const time = new Date().toTimeString().slice(0, 8)
  logEl.textContent += `${time} ${line}\n`
  logEl.scrollTop = logEl.scrollHeight
}

function setState(value: string): void {
  stateEl.textContent = value
  log(`状态: ${value}`)
}

if (!roomId) {
  log('缺少 ?room=')
} else {
  void main()
}

async function main(): Promise<void> {
  log(`房间 ${roomId}，角色 ${isHost ? '房主' : '观众'}`)

  // 先过房间准入：REST 那一步按 session 表的活跃角色签发凭证。
  // socket 必须一直挂着——断线会把 session 行的 endedAt 写上，之后换凭证就是 403。
  const socket = await joinRoom()
  if (!socket) return

  const session = new PiikShareSession(roomId, {
    onStatus: (status) => setState(status),
    onStream: (connectionId, stream) => {
      log(
        `边 ${connectionId} 收到媒体，轨道 ${stream
          .getTracks()
          .map((t) => t.kind)
          .join(',')}`
      )
      videoEl.srcObject = stream
      void videoEl.play().catch(() => {
        log('自动播放被拦，需要点击')
      })
    },
    onStateChange: (connectionId, state) =>
      log(`边 ${connectionId} → ${state}`),
    onError: (message) => log(`错误: ${message}`),
    onSharingStarted: (message) =>
      log(
        `开播确认，代际 ${message.shareGeneration}，下游 ${message.routeAssignment.childPeerIds.length}`
      ),
  })

  const start = async (): Promise<void> => {
    startButton.disabled = true
    let stream: MediaStream | undefined
    if (isHost) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: true,
        })
      } catch (error) {
        log(
          `采集失败: ${error instanceof Error ? error.message : String(error)}`
        )
        startButton.disabled = false
        return
      }
      videoEl.srcObject = stream
      videoEl.muted = true
      log(
        `采集到 ${stream.getVideoTracks().length} 视频轨 / ${stream.getAudioTracks().length} 音频轨`
      )
    }
    await session.start(stream)
  }

  if (isHost) {
    startButton.hidden = false
    startButton.addEventListener('click', () => void start())
  } else {
    startButton.hidden = true
    await start()
  }

  window.addEventListener('beforeunload', () => {
    session.stop()
    socket.disconnect()
  })
}

function joinRoom(): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = io({
      transports: ['websocket'],
      withCredentials: true,
      // HTTP 环境下 cookie 不参与握手，业务 socket 与主应用一样走 auth.token。
      auth: (cb: (data: Record<string, string>) => void) =>
        cb(buildSocketAuth()),
    })
    const timer = setTimeout(() => {
      log('进房超时')
      socket.disconnect()
      resolve(null)
    }, 10000)
    socket.on('connect_error', (error) => {
      clearTimeout(timer)
      log(`socket 连接失败: ${error.message}`)
      socket.disconnect()
      resolve(null)
    })
    socket.on('connect', () => {
      socket.emit(
        'request-join',
        { roomId, password: '' },
        (response: { success?: boolean; message?: string }) => {
          clearTimeout(timer)
          const ok = Boolean(response?.success)
          log(`进房: ${ok ? 'ok' : (response?.message ?? '失败')}`)
          if (!ok) socket.disconnect()
          resolve(ok ? socket : null)
        }
      )
    })
  })
}
