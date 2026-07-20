import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useRoomStore } from '@/store/roomStore'
import type { RoomMode } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import type {
  JoinStatus,
  JoinApprovedPayload,
  JoinRejectedPayload,
  RoomClosedPayload,
  RoomModeChangedPayload,
  RequestJoinResponse,
} from '../types'

interface UseJoinRoomOptions {
  socket: Socket | null
  /** 当前 URL 中的 roomId */
  roomId: string | undefined
  /** 是否已连接 */
  connected: boolean
  /** 当 join-approved 且 mode === 'screen-share' 时调用（用于创建 PC） */
  onApprovedScreenShare?: () => void
  /** 当 join-approved 且 mode === 'watch-together' 时调用 */
  onApprovedWatchTogether?: () => void
  /** room-closed 事件回调 */
  onRoomClosed?: (data: RoomClosedPayload) => void
  /** room-mode-changed 事件回调（含切换到 screen-share 时需要创建 PC） */
  onRoomModeChanged?: (data: RoomModeChangedPayload) => void
  /** 房间名称更新回调 */
  onRoomNameUpdated?: (data: { roomId: string; name: string }) => void
  /** 是否在 roomId 变化时自动 requestJoin（默认 true）。
   *  从房间列表进入有密码的房间时传 false，避免空密码触发"密码错误"提示，
   *  等待用户输入密码后手动调用 requestJoin。 */
  autoJoin?: boolean
}

interface UseJoinRoomResult {
  /** 当前加入状态 */
  joinStatus: JoinStatus
  /** 当前房间模式（由后端返回） */
  roomMode: RoomMode | null
  /** 请求加入房间 */
  requestJoin: (targetRoomId: string, password: string) => void
  /** 手动重置 joinStatus（用于切换房间时清空状态） */
  resetJoinState: () => void
}

/**
 * 观众端加入房间流程 hook：
 * - 维护 joinStatus / roomMode 状态机
 * - 自动监听 roomId 变化触发 requestJoin
 * - 处理 socket 重连后重新加入
 * - 订阅 join-approved / join-rejected / room-closed / room-name-updated / room-mode-changed 事件
 *
 * 不包含 WebRTC / video srcObject 逻辑，相关副作用由调用方在回调中处理。
 */
export function useJoinRoom(options: UseJoinRoomOptions): UseJoinRoomResult {
  const {
    socket,
    roomId,
    connected,
    onApprovedScreenShare,
    onApprovedWatchTogether,
    onRoomClosed,
    onRoomModeChanged,
    onRoomNameUpdated,
    autoJoin = true,
  } = options

  const setStoreMode = useRoomStore((state) => state.setMode)
  const resetRoomStore = useRoomStore((state) => state.reset)

  const [joinStatus, setJoinStatus] = useState<JoinStatus>('idle')
  const [roomMode, setRoomMode] = useState<RoomMode | null>(null)

  const requestedRoomIdRef = useRef<string | null>(null)
  const hasJoinedRef = useRef(false)
  const pendingPasswordRef = useRef<string>('')

  // 用 ref 保存最新回调，避免回调变化导致事件订阅重建
  const callbacksRef = useRef({
    onApprovedScreenShare,
    onApprovedWatchTogether,
    onRoomClosed,
    onRoomModeChanged,
    onRoomNameUpdated,
  })
  useEffect(() => {
    callbacksRef.current = {
      onApprovedScreenShare,
      onApprovedWatchTogether,
      onRoomClosed,
      onRoomModeChanged,
      onRoomNameUpdated,
    }
  }, [
    onApprovedScreenShare,
    onApprovedWatchTogether,
    onRoomClosed,
    onRoomModeChanged,
    onRoomNameUpdated,
  ])

  const resetJoinState = useCallback(() => {
    setJoinStatus('idle')
    setRoomMode(null)
    requestedRoomIdRef.current = null
    hasJoinedRef.current = false
  }, [])

  const requestJoin = useCallback(
    (targetRoomId: string, password: string) => {
      if (!socket || !connected) {
        message.warning('Socket 尚未连接，请稍后重试')
        setJoinStatus('idle')
        return
      }

      hasJoinedRef.current = false
      setJoinStatus('joining')
      socket.emit(
        'request-join',
        { roomId: targetRoomId, password },
        (response: RequestJoinResponse) => {
          if (response.success) {
            const mode = response.mode ?? 'screen-share'
            setRoomMode(mode)
            setStoreMode(mode)
            if (mode === 'watch-together') {
              if (response.message === '已加入房间') {
                hasJoinedRef.current = true
                setJoinStatus('approved')
                message.success(response.message)
                callbacksRef.current.onApprovedWatchTogether?.()
              } else {
                message.info(response.message ?? '等待房主确认')
              }
              return
            }
            if (response.message === '已加入房间') {
              hasJoinedRef.current = true
              setJoinStatus('approved')
              message.success(response.message)
              callbacksRef.current.onApprovedScreenShare?.()
            } else {
              message.info(response.message ?? '等待分享端确认')
            }
          } else {
            const isPasswordError = response.message === '密码错误'
            if (isPasswordError) {
              setJoinStatus('password-required')
              requestedRoomIdRef.current = null
              message.error('密码错误，请重新输入')
            } else {
              setJoinStatus('idle')
              message.error(response.message ?? '加入房间失败')
            }
          }
        }
      )
    },
    [socket, connected, setStoreMode]
  )

  // roomId 变化时自动加入房间（autoJoin=false 时跳过，等待手动 requestJoin）
  useEffect(() => {
    if (!socket || !connected || !roomId) return
    if (requestedRoomIdRef.current === roomId) return

    // Bug #15 修复：roomId 变化（切换房间）时重置 roomStore 与本地状态，
    // 避免上一个房间的 watchTogether.sourceUrl / movies 残留导致短暂黑屏
    if (
      requestedRoomIdRef.current !== null &&
      requestedRoomIdRef.current !== roomId
    ) {
      resetRoomStore()
      hasJoinedRef.current = false
    }
    requestedRoomIdRef.current = roomId
    if (!autoJoin) return
    const password = pendingPasswordRef.current
    pendingPasswordRef.current = ''
    requestJoin(roomId, password)
  }, [socket, connected, roomId, requestJoin, resetRoomStore, autoJoin])

  // Bug #3 修复：socket 断线重连后服务端分配新 socket.id，新 socket 不在任何房间内。
  // 监听 'connect' 事件重置 requestedRoomIdRef，触发上面的 effect 重新 requestJoin。
  // 同时重置 hasJoinedRef，让 join-approved 流程重新走完整。
  useEffect(() => {
    if (!socket) return
    const handleReconnect = () => {
      console.log('[useJoinRoom] socket reconnected, re-join room:', roomId)
      requestedRoomIdRef.current = null
      hasJoinedRef.current = false
      setJoinStatus('idle')
    }
    socket.on('connect', handleReconnect)
    return () => {
      socket.off('connect', handleReconnect)
    }
  }, [socket, roomId])

  // 事件订阅
  useEffect(() => {
    if (!socket) return

    const handleJoinApproved = (data: JoinApprovedPayload) => {
      if (data.name) {
        callbacksRef.current.onRoomNameUpdated?.({
          roomId: data.roomId,
          name: data.name,
        })
      }
      const mode = data.mode ?? roomMode ?? 'screen-share'
      setRoomMode(mode)
      setStoreMode(mode)
      if (mode === 'watch-together') {
        if (hasJoinedRef.current) {
          setJoinStatus('approved')
          return
        }
        hasJoinedRef.current = true
        setJoinStatus('approved')
        message.success(`已获准加入房间 ${data.roomId}`)
        callbacksRef.current.onApprovedWatchTogether?.()
        return
      }
      if (hasJoinedRef.current) {
        setJoinStatus('approved')
        return
      }
      hasJoinedRef.current = true
      setJoinStatus('approved')
      message.success(`已获准加入房间 ${data.roomId}`)
      callbacksRef.current.onApprovedScreenShare?.()
    }

    const handleJoinRejected = (data: JoinRejectedPayload) => {
      setJoinStatus('rejected')
      message.warning(`加入房间 ${data.roomId} 被拒绝`)
    }

    const handleRoomClosed = (data: RoomClosedPayload) => {
      callbacksRef.current.onRoomClosed?.(data)
    }

    const handleRoomNameUpdated = (data: { roomId: string; name: string }) => {
      callbacksRef.current.onRoomNameUpdated?.(data)
    }

    const handleRoomModeChanged = (data: RoomModeChangedPayload) => {
      setRoomMode(data.mode)
      setStoreMode(data.mode)
      callbacksRef.current.onRoomModeChanged?.(data)
    }

    socket.on('join-approved', handleJoinApproved)
    socket.on('join-rejected', handleJoinRejected)
    socket.on('room-closed', handleRoomClosed)
    socket.on('room-name-updated', handleRoomNameUpdated)
    socket.on('room-mode-changed', handleRoomModeChanged)

    return () => {
      socket.off('join-approved', handleJoinApproved)
      socket.off('join-rejected', handleJoinRejected)
      socket.off('room-closed', handleRoomClosed)
      socket.off('room-name-updated', handleRoomNameUpdated)
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [socket, roomMode, joinStatus, setStoreMode])

  return {
    joinStatus,
    roomMode,
    requestJoin,
    resetJoinState,
  }
}
