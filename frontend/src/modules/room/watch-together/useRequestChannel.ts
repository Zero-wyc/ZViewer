/**
 * useRequestChannel —— 一起看「观众申请 → 房主审批」通道。
 *
 * seek / pause / play 三类申请在协议上完全同构：
 * - 观众：emit `{kind}-request` → 等待 `{kind}-response`（15s 超时自动解除 pending）
 * - 房主：监听 `{kind}-request` → 自动通过或弹审批 → emit `{kind}-response`
 *
 * 差异只有三点，通过参数表达：
 * 1. 同意后对本地 <video> 的影响（seek 跳转 / pause / play；观众端 seek 由房主
 *    广播驱动，本地不重复设置 currentTime）
 * 2. 请求体附加字段（seek 带 time）
 * 3. 5s 合并窗口的合并键（seek 需同目标时间才合并，pause/play 直接合并）
 *
 * 本 hook 按 isHost 自行选择注册房主端（request 监听）或观众端（response 监听）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { formatDuration } from '@/lib/utils'
import { t } from '@/i18n'

export type RequestChannelKind = 'seek' | 'pause' | 'play'
export type PlayerNoticeType = 'info' | 'success' | 'error'

/** 申请附加数据：仅 seek 通道携带跳转目标时间 */
export interface RequestChannelDetail {
  time?: number
}

/** 房主端待审批申请（5s 窗口内的同键申请已合并） */
export interface PendingApproval {
  /** 申请者 socket ID 列表 */
  viewerSocketIds: string[]
  /** 申请者用户名列表（用于展示） */
  viewerUsernames: string[]
  /** 合并窗口开始时间戳，用于判断是否在 5s 合并窗口内 */
  windowStart: number
  /** 申请附加数据（seek 的 time） */
  detail: RequestChannelDetail
}

export interface RequestChannelOptions {
  kind: RequestChannelKind
  socket: Socket | null
  roomId: string
  isHost: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  /** 自动通过开关（用 ref 读取最新值，避免监听闭包 stale） */
  autoApproveRef: RefObject<boolean>
  addPlayerNotice: (text: string, type?: PlayerNoticeType) => void
  /** 房主同意（含自动通过）后在房主本地执行 */
  applyOnHostGrant?: (
    video: HTMLVideoElement,
    detail: RequestChannelDetail
  ) => void
  /** 观众收到房主同意后在观众本地执行 */
  applyOnViewerConfirm?: (
    video: HTMLVideoElement,
    detail: RequestChannelDetail
  ) => void
  /** 合并键：5s 窗口内键相同的申请合并为一条（默认全部合并） */
  mergeKeyOf?: (detail: RequestChannelDetail) => string
}

export interface RequestChannel {
  /** 房主端：待审批申请，null 表示无 */
  request: PendingApproval | null
  /** 房主端：同意（对合并列表内每位观众逐一回应） */
  approve: () => void
  /** 房主端：拒绝 */
  reject: () => void
  /** 房主端：关闭通知（等同放弃审批，不回包） */
  clear: () => void
  /** 观众端：是否有等待房主回应的申请 */
  pending: boolean
  /** 观众端：发起申请 */
  sendRequest: (detail?: RequestChannelDetail) => void
}

interface ChannelSpec {
  /** 申请超时后的提示 */
  timeoutText: string
  /** 服务器拒绝申请时的兜底提示（优先用服务器 message） */
  requestFailedText: string
  /** 申请已送达、等待房主确认 */
  waitingText: string
  /** 自动通过模式下申请即刻生效 */
  autoDoneText: string
  /** 房主同意提示 */
  approvedText: (detail: RequestChannelDetail) => string
  /** 房主拒绝提示 */
  rejectedText: string
}

/** 各类申请的文案（与重构前逐字一致） */
const CHANNEL_SPECS: Record<RequestChannelKind, ChannelSpec> = {
  seek: {
    timeoutText: '跳转申请已超时，房主未回应',
    requestFailedText: '申请跳转失败',
    waitingText: '已发送跳转申请，等待房主确认',
    autoDoneText: '已跳转',
    approvedText: (detail) =>
      t('房主已同意跳转到 {{value}}', {
        value: formatDuration(detail.time ?? 0),
      }),
    rejectedText: '房主拒绝了您的跳转申请',
  },
  pause: {
    timeoutText: '暂停申请已超时，房主未回应',
    requestFailedText: '申请暂停失败',
    waitingText: '已发送暂停申请，等待房主确认',
    autoDoneText: '已暂停',
    approvedText: () => t('房主已同意暂停'),
    rejectedText: '房主拒绝了您的暂停申请',
  },
  play: {
    timeoutText: '继续播放申请已超时，房主未回应',
    requestFailedText: '申请继续播放失败',
    waitingText: '已发送继续播放申请，等待房主确认',
    autoDoneText: '继续播放',
    approvedText: () => t('房主已同意继续播放'),
    rejectedText: '房主拒绝了您的继续播放申请',
  },
}

/** 5s 内同键申请合并窗口 */
const MERGE_WINDOW_MS = 5000
/** 房主 15s 未回应则解除 pending，允许再次申请 */
const PENDING_TIMEOUT_MS = 15000

/** 审批回包体：仅 seek 通道携带 time，保持与协议原有形态一致 */
function buildResponsePayload(
  roomId: string,
  viewerSocketId: string,
  accept: boolean,
  detail: RequestChannelDetail
) {
  const { time } = detail
  return typeof time === 'number'
    ? { roomId, viewerSocketId, accept, time }
    : { roomId, viewerSocketId, accept }
}

export function useRequestChannel({
  kind,
  socket,
  roomId,
  isHost,
  videoRef,
  autoApproveRef,
  addPlayerNotice,
  applyOnHostGrant,
  applyOnViewerConfirm,
  mergeKeyOf,
}: RequestChannelOptions): RequestChannel {
  const spec = CHANNEL_SPECS[kind]
  const requestEvent = `${kind}-request`
  const responseEvent = `${kind}-response`

  const [request, setRequest] = useState<PendingApproval | null>(null)
  const [pending, setPending] = useState(false)

  // 回调与 pending 镜像到 ref：监听 effect 仅依赖 socket/isHost/roomId，
  // 避免每次渲染都重新订阅 socket 事件（也避免闭包读到旧值）
  const applyOnHostGrantRef = useRef(applyOnHostGrant)
  const applyOnViewerConfirmRef = useRef(applyOnViewerConfirm)
  const addPlayerNoticeRef = useRef(addPlayerNotice)
  const mergeKeyOfRef = useRef(mergeKeyOf)
  useEffect(() => {
    applyOnHostGrantRef.current = applyOnHostGrant
    applyOnViewerConfirmRef.current = applyOnViewerConfirm
    addPlayerNoticeRef.current = addPlayerNotice
    mergeKeyOfRef.current = mergeKeyOf
  }, [applyOnHostGrant, applyOnViewerConfirm, addPlayerNotice, mergeKeyOf])

  const pendingRef = useRef(false)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearPendingTimeout = useCallback(() => {
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current)
      pendingTimeoutRef.current = null
    }
  }, [])

  // ── 房主端：接收申请 ──────────────────────────────────
  useEffect(() => {
    if (!socket || !isHost) return

    const handleRequest = (data: {
      viewerSocketId: string
      viewerUsername?: string
      time?: number
    }) => {
      if (!data?.viewerSocketId) return
      const detail: RequestChannelDetail = { time: data.time }

      // 自动通过：房主本地立即生效 + 直接回包
      if (autoApproveRef.current) {
        const video = videoRef.current
        if (video) applyOnHostGrantRef.current?.(video, detail)
        socket.emit(
          responseEvent,
          buildResponsePayload(roomId, data.viewerSocketId, true, detail),
          () => {
            /* ack */
          }
        )
        return
      }

      const keyOf = mergeKeyOfRef.current
      const key = keyOf ? keyOf(detail) : ''
      setRequest((prev) => {
        const canMerge =
          prev != null &&
          Date.now() - prev.windowStart < MERGE_WINDOW_MS &&
          (!keyOf || keyOf(prev.detail) === key)
        if (canMerge) {
          return {
            ...prev,
            viewerSocketIds: [...prev.viewerSocketIds, data.viewerSocketId],
            viewerUsernames: data.viewerUsername
              ? [...prev.viewerUsernames, data.viewerUsername]
              : prev.viewerUsernames,
          }
        }
        return {
          viewerSocketIds: [data.viewerSocketId],
          viewerUsernames: data.viewerUsername ? [data.viewerUsername] : [],
          windowStart: Date.now(),
          detail,
        }
      })
    }

    socket.on(requestEvent, handleRequest)
    return () => {
      socket.off(requestEvent, handleRequest)
    }
  }, [
    socket,
    isHost,
    roomId,
    videoRef,
    autoApproveRef,
    requestEvent,
    responseEvent,
  ])

  // ── 房主端：审批操作 ──────────────────────────────────
  const approve = useCallback(() => {
    if (!request) return
    const { viewerSocketIds, detail } = request
    if (!socket || viewerSocketIds.length === 0) return
    const video = videoRef.current
    if (video) applyOnHostGrantRef.current?.(video, detail)
    for (const sid of viewerSocketIds) {
      socket.emit(
        responseEvent,
        buildResponsePayload(roomId, sid, true, detail),
        () => {
          /* ack */
        }
      )
    }
    setRequest(null)
  }, [request, socket, videoRef, roomId, responseEvent])

  const reject = useCallback(() => {
    if (!request) return
    const { viewerSocketIds } = request
    if (!socket || viewerSocketIds.length === 0) return
    for (const sid of viewerSocketIds) {
      socket.emit(
        responseEvent,
        { roomId, viewerSocketId: sid, accept: false },
        () => {
          /* ack */
        }
      )
    }
    setRequest(null)
  }, [request, socket, roomId, responseEvent])

  const clear = useCallback(() => {
    setRequest(null)
  }, [])

  // ── 观众端：监听房主回应 ──────────────────────────────
  useEffect(() => {
    if (!socket || isHost) return

    const handleResponse = (data: { accept: boolean; time?: number }) => {
      if (!pendingRef.current) return
      setPending(false)
      clearPendingTimeout()
      if (data?.accept) {
        const video = videoRef.current
        if (video) {
          applyOnViewerConfirmRef.current?.(video, { time: data?.time })
        }
        // 自动通过模式下申请时已提示，此处不再重复提示
        if (!autoApproveRef.current) {
          addPlayerNoticeRef.current(
            spec.approvedText({ time: data?.time }),
            'success'
          )
        }
      } else {
        addPlayerNoticeRef.current(spec.rejectedText, 'info')
      }
    }

    socket.on(responseEvent, handleResponse)
    return () => {
      socket.off(responseEvent, handleResponse)
      // 组件卸载时清理 pending timeout，避免定时器残留
      clearPendingTimeout()
    }
  }, [
    socket,
    isHost,
    responseEvent,
    videoRef,
    autoApproveRef,
    spec,
    clearPendingTimeout,
  ])

  // ── 观众端：发起申请 ──────────────────────────────────
  const sendRequest = useCallback(
    (detail: RequestChannelDetail = {}) => {
      if (!socket || isHost || pending) return
      setPending(true)
      clearPendingTimeout()
      pendingTimeoutRef.current = setTimeout(() => {
        setPending(false)
        pendingTimeoutRef.current = null
        addPlayerNotice(spec.timeoutText, 'info')
      }, PENDING_TIMEOUT_MS)
      socket.emit(
        requestEvent,
        // 只透传已知字段：sendRequest 可能被直接当作无参 onClick 回调使用，
        // 避免把事件对象摊进请求体
        typeof detail?.time === 'number'
          ? { roomId, time: detail.time }
          : { roomId },
        (response: { success: boolean; message?: string }) => {
          if (!response.success) {
            // 服务器拒绝（如房间非直播模式）：清除 pending 和 timeout
            clearPendingTimeout()
            setPending(false)
            addPlayerNotice(response.message || spec.requestFailedText, 'error')
          } else {
            // 服务器已转发给房主，timeout 保留（由 response 事件或超时回退清除）
            addPlayerNotice(
              autoApproveRef.current ? spec.autoDoneText : spec.waitingText,
              'info'
            )
          }
        }
      )
    },
    [
      socket,
      isHost,
      pending,
      roomId,
      requestEvent,
      autoApproveRef,
      addPlayerNotice,
      spec,
      clearPendingTimeout,
    ]
  )

  return { request, approve, reject, clear, pending, sendRequest }
}
