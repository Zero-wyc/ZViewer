/**
 * 语音组件（内嵌 LiveKit）的可用性与下载状态。
 *
 * LiveKit 二进制随安装包分发，正常安装里一直是 ready；只有被手动删掉时才会缺。
 * 这里负责两件事：
 * 1. 读 /api/voice/status 判断能不能加入语音（缺失时显示下载入口）；
 * 2. 触发 /api/voice/install 并在下载期间轮询进度。
 *
 * 状态机与后端 livekit.State* 一致；`external=true` 表示部署方自带了 LiveKit，
 * 与内嵌组件无关，不显示下载入口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, safeJson } from '@/lib/api'

export type VoiceComponentState =
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'error'
  | 'external'

export interface VoiceComponentStatus {
  available: boolean
  state: VoiceComponentState
  /** 0–100（后端只在已知总大小时给值） */
  progress: number
  received: number
  total: number
  message: string
  version: string
  external: boolean
}

const UNKNOWN: VoiceComponentStatus = {
  // 未知时按「可用」处理：万一是老后端没有这个接口，不要把语音入口拦掉。
  available: true,
  state: 'ready',
  progress: 0,
  received: 0,
  total: 0,
  message: '',
  version: '',
  external: false,
}

/** 下载进行中时的轮询间隔（后端进度按 1% 更新，1s 足够） */
const POLL_INTERVAL_MS = 1000

export function useVoiceComponent(enabled = true) {
  const [status, setStatus] = useState<VoiceComponentStatus>(UNKNOWN)
  const [requesting, setRequesting] = useState(false)
  // 组件卸载后停止轮询（房间页频繁切换）
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/voice/status')
      const data = await safeJson<{
        success: boolean
        status?: Partial<VoiceComponentStatus>
      }>(res, { success: false })
      if (!aliveRef.current) return
      if (data.success && data.status) {
        setStatus({ ...UNKNOWN, ...data.status })
      }
    } catch {
      // 状态查询失败按「可用」处理：让用户照常点加入，真正的失败由
      // /api/voice/token 的 503 文案兜住，不在这里拦。
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    if (enabled) void refresh()
    return () => {
      aliveRef.current = false
    }
  }, [enabled, refresh])

  // 下载中轮询：装完（state=ready）自动停。
  const busy = status.state === 'downloading' || status.state === 'installing'
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const install = useCallback(async () => {
    if (requesting) return
    setRequesting(true)
    try {
      const res = await apiFetch('/api/voice/install', { method: 'POST' })
      const data = await safeJson<{
        success: boolean
        status?: Partial<VoiceComponentStatus>
        message?: string
      }>(res, { success: false })
      if (aliveRef.current && data.status) {
        setStatus({ ...UNKNOWN, ...data.status })
      }
      if (!data.success && data.message && aliveRef.current) {
        setStatus((prev) => ({
          ...prev,
          available: false,
          state: 'error',
          message: data.message ?? '',
        }))
      }
    } catch {
      if (aliveRef.current) {
        setStatus((prev) => ({
          ...prev,
          available: false,
          state: 'error',
          message: '下载请求失败，请检查网络后重试',
        }))
      }
    } finally {
      if (aliveRef.current) setRequesting(false)
    }
  }, [requesting])

  return { status, busy, requesting, install, refresh }
}
