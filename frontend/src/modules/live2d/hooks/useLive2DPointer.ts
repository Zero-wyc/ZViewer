import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import {
  LIVE2D_EVENT,
  LIVE2D_STATE_EPSILON,
  LIVE2D_STATE_INTERVAL_MS,
} from '../constants'
import { normalizePointer, roundCoord } from '../core/pointer-map'
import { setFace, setLocalPointer, setVoiceMouth } from '../core/scene'
import {
  LIVE2D_VOICE_EPSILON,
  LIVE2D_VOICE_KEEPALIVE_MS,
  micLevelToMouth,
} from '../core/lip-sync'
import { hasMicLevel, readMicLevel } from '@/modules/voice-chat/lib/mic-level'
import type { FaceTracker } from '../core/face-tracker'

// 本机输入 → 15Hz 上行。
//
// 三个来源，优先级从上到下：
//   - 摄像头动捕：开着且有脸时**最高**，鼠标与语音都让位（否则人坐着不动、
//     手碰一下鼠标，模型就会从"跟着我转头"跳回鼠标位置）；
//   - 语音口型：开着语音、且没有摄像头脸时驱动**嘴**（只驱动嘴，眼/表情
//     仍归引擎，见下方 send 的注释）；
//   - 鼠标/触摸：视线来源，任何时刻都在用。
//
// 动捕还额外带两个量：张嘴幅度与睁眼程度（blendshape 算出来的）。它们走同一条
// live2d-state，不额外开事件——多一条事件就多一份频率控制与一条可能的乱序路径。
//
// 本地先写场景再发网络：自己的模型立刻响应，不等回包；移动量小于阈值不发，
// 静止时鼠标抖动不值得占带宽（服务端还有 40ms 门限）。

export interface UseLive2DPointerOptions {
  socket: Socket | null
  roomId: string
  sid: string
  active: boolean
  /** 摄像头动捕实例；为 null 时只用鼠标 */
  tracker?: FaceTracker | null
  /**
   * 语音口型：说话时用本机麦克风响度推动嘴型。
   *
   * 只在**没有摄像头脸**时生效（动捕优先）：摄像头测出来的嘴比响度推测准，
   * 而且那时人就在镜头前。麦克风电平来自语音模块已建好的 AnalyserNode，
   * 这条通路不额外开设备、也不上传任何音频（见 voice-chat/lib/mic-level）。
   */
  lipSync?: boolean
}

/** 上行 live2d-state 的形状（m/e/p 只在动捕时有）。 */
interface Live2DStatePayload {
  roomId: string
  x: number
  y: number
  a: number
  m?: number
  e?: number
  /** [嘴形, 眉毛, 歪头]，0~1 编码（0.5 = 中性） */
  p?: number[]
}

/** 一帧面部采样，全部 0~1（与协议同口径，本地场景也直接吃这个）。 */
interface Live2DFaceSample {
  mouth: number
  eyes: number
  form: number
  brow: number
  roll: number
}

/**
 * -1~1 → 0~1。
 *
 * 本地算出来的是「带方向的偏离量」（-1 撇嘴 / +1 笑），而协议统一用 0~1
 * 编码：服务端只需要一条 clamp(0,1)，不用为每个字段记住中位在哪。
 */
function encodeSigned(v: number): number {
  const n = Number.isFinite(v) ? v : 0
  return Math.min(1, Math.max(0, n / 2 + 0.5))
}

export function useLive2DPointer({
  socket,
  roomId,
  sid,
  active,
  tracker = null,
  lipSync = false,
}: UseLive2DPointerOptions): void {
  useEffect(() => {
    if (!active || !socket || !roomId || !sid) return

    let lastAt = 0
    let lastX = -1
    let lastY = -1
    // 是否已经发过面部数据：决定关闭动捕时要不要补一帧「闭嘴、睁眼」
    let sentFace = false
    // 是否发过语音嘴型：卸载时要补一帧闭嘴，否则别人那边角色会一直张着嘴
    let sentVoice = false
    // 上一次上报的语音嘴型；-1 表示还没发过（0 也是合法值，不能用 0 当哨兵）
    let lastVoice = -1
    // 上一次发语音帧的时刻：拖长元音时响度几乎不动，靠「变了才发」会让嘴
    // 在句子中间合上（服务端的 voiceAt 600ms 就过期了）
    let lastVoiceAt = 0

    const send = (
      x: number,
      y: number,
      ar: number,
      face: Live2DFaceSample | null,
      voice: number | null
    ) => {
      const now = performance.now()
      if (now - lastAt < LIVE2D_STATE_INTERVAL_MS) return
      const pointerMoved =
        Math.abs(x - lastX) >= LIVE2D_STATE_EPSILON ||
        Math.abs(y - lastY) >= LIVE2D_STATE_EPSILON
      // 语音是"变了才发"：静音段每帧都在 0~0.01 之间抖，全发只是白占上行。
      // 动捕开着就固定 15Hz 上报，不看变化量：面部数据有 600ms 有效期，
      // 靠"变了才发"会出现「坐着不动的两秒里对方模型突然自己眨眼」
      // ——数据过期、接管权被交还给了引擎。
      const voiceChanged =
        voice !== null && Math.abs(voice - lastVoice) >= LIVE2D_VOICE_EPSILON
      // 正在发声就按保活间隔补帧；静音（0）不补——嘴本来就该闭着
      const voiceDue =
        voice !== null &&
        voice > 0 &&
        now - lastVoiceAt >= LIVE2D_VOICE_KEEPALIVE_MS
      if (!pointerMoved && face === null && !voiceChanged && !voiceDue) return

      lastAt = now
      lastX = x
      lastY = y
      setLocalPointer(sid, x, y)
      const payload: Live2DStatePayload = {
        roomId,
        x: roundCoord(x),
        y: roundCoord(y),
        a: roundCoord(ar, 2),
      }
      if (face) {
        sentFace = true
        setFace(sid, face.mouth, face.eyes, {
          form: face.form,
          brow: face.brow,
          roll: face.roll,
        })
        payload.m = roundCoord(face.mouth)
        payload.e = roundCoord(face.eyes)
        payload.p = [
          roundCoord(face.form),
          roundCoord(face.brow),
          roundCoord(face.roll),
        ]
      } else if (voice !== null) {
        // 只带 m、不带 e/p：服务端据此把它归到「语音口型」而不是「整脸动捕」
        // 那条通道（见后端 live2dVoiceMouth）。给了 e 就等于宣称对方的眼睛
        // 也归我管，模型在整段说话里都不会眨眼。
        sentVoice = true
        lastVoice = voice
        lastVoiceAt = now
        setVoiceMouth(sid, voice)
        payload.m = roundCoord(voice)
      }
      socket.emit(LIVE2D_EVENT.STATE, payload)
    }

    const emitPointer = (clientX: number, clientY: number) => {
      // 动捕在跟踪时，鼠标不再抢控制权
      if (tracker?.hasFace()) return
      const sample = normalizePointer(
        clientX,
        clientY,
        window.innerWidth,
        window.innerHeight
      )
      send(sample.x, sample.y, sample.ar, null, null)
    }

    // 摄像头/语音采样定时器：取最新注视点与面部姿态，节流交给 send 自己判断。
    // 用 setInterval 而不是 rAF：页面切到后台时 rAF 会停，摄像头其实也没必要
    // 继续上报，但保持 15Hz 的定时器更简单，也不会因为掉帧而出现空档。
    const sampler =
      (tracker || lipSync) &&
      window.setInterval(() => {
        const pose = tracker?.getPose() ?? null
        if (pose) {
          const ar = window.innerWidth / Math.max(1, window.innerHeight)
          send(
            pose.gaze.x,
            pose.gaze.y,
            ar,
            {
              mouth: pose.mouth,
              eyes: pose.eyes,
              form: encodeSigned(pose.form),
              brow: encodeSigned(pose.brow),
              roll: encodeSigned(pose.roll),
            },
            null
          )
          return
        }
        // 动捕开着但这一刻没有脸（人走开了、光线太暗）：退回语音口型，
        // 而不是让嘴僵在最后一帧。两个都没开时这条分支不会进来。
        if (!lipSync || !hasMicLevel()) return
        const ar = window.innerWidth / Math.max(1, window.innerHeight)
        // 还没收到过指针时用画面中心当注视点：发 0.5 而不是 -1，
        // 否则服务端钳制后模型会盯着左下角看。
        send(
          lastX >= 0 ? lastX : 0.5,
          lastY >= 0 ? lastY : 0.5,
          ar,
          null,
          micLevelToMouth(readMicLevel())
        )
      }, LIVE2D_STATE_INTERVAL_MS)

    const onPointer = (event: PointerEvent) =>
      emitPointer(event.clientX, event.clientY)
    const onTouch = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touch) emitPointer(touch.clientX, touch.clientY)
    }

    // passive：房间里有滚动容器，不能因为这里监听就让滚动变卡
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('touchmove', onTouch, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('touchmove', onTouch)
      if (sampler) window.clearInterval(sampler)
      // 关掉动捕的那一刻补一帧「闭嘴、睁眼、中性表情」：不发的话对方模型
      // 会一直停在最后一帧的表情上（服务端只在收到面部数据时才转发 m/e/p）。
      if (sentFace) {
        setFace(sid, 0, 1, { form: 0.5, brow: 0.5, roll: 0.5 })
        socket.emit(LIVE2D_EVENT.STATE, {
          roomId,
          x: roundCoord(Math.max(0, lastX)),
          y: roundCoord(Math.max(0, lastY)),
          a: roundCoord(window.innerWidth / Math.max(1, window.innerHeight), 2),
          m: 0,
          e: 1,
          p: [0.5, 0.5, 0.5],
        })
      } else if (sentVoice) {
        // 只发过语音嘴型的（没开过摄像头）：补一帧闭嘴，只带 m。
        setVoiceMouth(sid, 0)
        socket.emit(LIVE2D_EVENT.STATE, {
          roomId,
          x: roundCoord(Math.max(0, lastX)),
          y: roundCoord(Math.max(0, lastY)),
          a: roundCoord(window.innerWidth / Math.max(1, window.innerHeight), 2),
          m: 0,
        })
      }
    }
  }, [socket, roomId, sid, active, tracker, lipSync])
}
