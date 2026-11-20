/**
 * 房间功能开关的加载、实时同步与房主修改。
 *
 * 房主页 / 观众页在 RoomPage 里各调用一次：
 * - 进房先 room-features-get 拉一次权威值（后端从 DB 读）；
 * - 之后跟随 socket 广播 room-features 更新（房主改完立刻全员生效）；
 * - 房主通过 updateFeature 修改，服务端校验房主身份后广播。
 *
 * 这些开关决定「语音能不能进、一起听窗口能不能开、画面是否加密」，
 * 属于房间状态而不是本机偏好，因此统一放 roomStore，避免各面板各存一份。
 */
import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { useRoomStore } from '@/store/roomStore'
import type { RoomFeatures } from '@/store/roomStore'

export interface RoomFeaturesPayload extends Partial<RoomFeatures> {
  success?: boolean
  roomId?: string
  message?: string
}

export type VoiceInviteKind = 'livekit' | 'relay'

export function useRoomFeatures(
  socket: Socket | null | undefined,
  roomId: string | undefined
) {
  const setRoomFeatures = useRoomStore((state) => state.setRoomFeatures)

  useEffect(() => {
    if (!roomId) return
    const apply = (payload?: RoomFeaturesPayload) => {
      if (!payload || payload.roomId !== roomId) return
      setRoomFeatures({
        ...(typeof payload.voiceEnabled === 'boolean'
          ? { voiceEnabled: payload.voiceEnabled }
          : {}),
        ...(typeof payload.voiceAutoJoin === 'boolean'
          ? { voiceAutoJoin: payload.voiceAutoJoin }
          : {}),
        ...(typeof payload.musicEnabled === 'boolean'
          ? { musicEnabled: payload.musicEnabled }
          : {}),
        ...(typeof payload.screenE2EEEnabled === 'boolean'
          ? { screenE2EEEnabled: payload.screenE2EEEnabled }
          : {}),
        // 解密密钥随广播一起下发：观众拿到开关的同时就拿到了密钥，
        // 不需要再请求 watch 接口（那条请求会被反代缓存，是黑屏的根因）。
        ...(typeof payload.screenE2EEKey === 'string'
          ? { screenE2EEKey: payload.screenE2EEKey }
          : {}),
      })
    }

    const requestFeatures = () => {
      if (!socket?.connected) return
      socket.emit('room-features-get', { roomId }, (res?: RoomFeaturesPayload) => {
        if (res?.success === false) {
          console.warn('[useRoomFeatures] 获取房间功能开关失败:', res.message)
          return
        }
        apply(res)
      })
    }

    requestFeatures()

    if (!socket) return
    const handleFeatures = (payload?: RoomFeaturesPayload) => apply(payload)
    // 重连后后端 socket.data 丢了房间上下文，重新拉一次
    const handleConnect = () => requestFeatures()
    // 进房瞬间本 hook 可能早于 request-join 的 ack，首次 get 会因「不在房间内」
    // 失败并一直停在默认值；join-approved 之后再补拉一次权威值。
    const handleJoinApproved = () => requestFeatures()
    // 页面在后台时可能错过广播（定时器/网络被节流），回到前台再拉一次，
    // 否则观众会拿旧的「画面端到端加密」开关去连接，表现为永久黑屏。
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') requestFeatures()
    }
    const handleFocus = () => requestFeatures()
    // 兜底轮询：Android/移动端浏览器切后台、弱网丢包时可能整条广播都收不到，
    // 只靠 visibilitychange/focus 补拉不够（页面一直可见却漏了广播）。每 15s
    // 主动拉一次权威值，保证「房主改完开关 → 观众自动重连」最终一定能生效。
    const syncTimer = window.setInterval(requestFeatures, 15000)
    socket.on('room-features', handleFeatures)
    socket.on('connect', handleConnect)
    socket.on('join-approved', handleJoinApproved)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.clearInterval(syncTimer)
      socket.off('room-features', handleFeatures)
      socket.off('connect', handleConnect)
      socket.off('join-approved', handleJoinApproved)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
    }
  }, [roomId, setRoomFeatures, socket])

  return {
    /** 房主修改一个或多个开关（服务端校验房主身份） */
    updateFeature: (patch: Partial<RoomFeatures>) => {
      if (!socket || !roomId) return
      socket.emit(
        'room-features-set',
        { roomId, ...patch },
        (res?: { success?: boolean; message?: string }) => {
          if (res?.success === false) {
            console.warn('[useRoomFeatures] 修改房间功能开关失败:', res.message)
          }
        }
      )
    },
    /**
     * 房主邀请某个成员加入语音。
     * kind=livekit 走 LiveKit，kind=relay 走中继语音（隧道场景兜底）。
     */
    inviteVoice: (targetSocketId: string, kind: VoiceInviteKind) => {
      if (!socket || !roomId || !targetSocketId) return
      socket.emit('voice-invite', { roomId, targetSocketId, kind })
    },
  }
}