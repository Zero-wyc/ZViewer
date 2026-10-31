import { useEffect, useRef } from 'react'
import { apiGet } from '@/lib/api'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'

interface HealthResponse {
  status: string
  timestamp: string
  /** 后端进程启动时间戳（毫秒），每次重启后变化 */
  startedAt: number
  /** supervisor 累计重启次数 */
  restartCount: number
}

/**
 * 监听后端自动重启并在网页内提示。
 *
 * 原理：
 * - 后端 /health 返回 startedAt（进程启动时间戳）+ restartCount（重启次数）
 * - socket 断开后重连时，拉取 /health 对比 startedAt
 * - 如果 startedAt 变化，说明后端已重启（崩溃后被 supervisor 自动拉起），显示提示
 *
 * 首次连接不提示（仅记录 startedAt），避免页面刷新时误报。
 * 后续 socket 断开→重连时才检测并提示。
 */
export function useBackendHealth(): void {
  const { socket, connected } = useSocket()
  const lastStartedAtRef = useRef<number | null>(null)
  const wasConnectedRef = useRef(false)

  useEffect(() => {
    if (!socket) return

    const checkHealth = async (notifyOnRestart: boolean) => {
      try {
        const { data, ok } = await apiGet<HealthResponse>('/health')
        if (!ok || !data) return
        if (
          notifyOnRestart &&
          lastStartedAtRef.current !== null &&
          lastStartedAtRef.current !== data.startedAt
        ) {
          message.info(
            t('后端已自动重启（第 {{count}} 次），服务已恢复', {
              count: data.restartCount,
            })
          )
        }
        lastStartedAtRef.current = data.startedAt
      } catch {
        // ignore - 后端可能还在重启中
      }
    }

    if (connected) {
      // 首次连接：wasConnectedRef=false → 只记录 startedAt，不提示
      // 重连：wasConnectedRef=true → startedAt 变化时提示
      void checkHealth(wasConnectedRef.current)
    }
    wasConnectedRef.current = connected
  }, [socket, connected])
}
