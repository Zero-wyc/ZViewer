import { useEffect, useRef, useCallback } from 'react'
import { useSocket } from './useSocket'
import { useCliAgentStore } from '@/store/cliAgentStore'

/** 本地 CLI 默认端口 */
export const CLI_DEFAULT_PORT = 9333
/** 本地 CLI 健康检查地址 */
export const CLI_HEALTH_URL = `http://127.0.0.1:${CLI_DEFAULT_PORT}/health`
/** 健康检查轮询间隔（毫秒） */
const HEALTH_POLL_INTERVAL_MS = 5000

/**
 * 当前页面是否运行在浏览器本地环境。
 *
 * 127.0.0.1 指向的是「访问者自己的设备」：远程/公网访问（https 页面或
 * 非本机地址）时轮询无意义——手机等设备上必然连接拒绝，只会刷屏报错。
 * 仅 http 本地页面（localhost / 私网 IP）才执行本地 CLI 健康检查。
 */
function isLocalPage(): boolean {
  if (typeof window === 'undefined') return false
  const { protocol, hostname } = window.location
  if (protocol === 'https:') return false
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '[::1]' || h.endsWith('.local')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}

interface CliAgentAvailablePayload {
  socketId: string
  proxyUrl: string
  agent?: string
  version?: string
}

interface CliAgentsPayload {
  roomId: string
  agents: CliAgentAvailablePayload[]
}

/**
 * 检测本地 CLI 代理是否可用，并订阅房间内 CLI 代理注册事件。
 *
 * 设计原则：
 * - 仅通过 roomId 信任：只要本地 CLI 已连接同一房间，即可使用其代理。
 * - 手动开关：本 hook 只负责「检测并返回可用代理」，不决定是否启用。
 * - 健康检查：轮询 127.0.0.1:9333/health，同时监听 socket 事件获取后端广播的代理列表。
 *
 * @param roomId 当前房间 ID
 * @returns 当前可用的 CLI 代理信息
 */
export function useCliAgent(roomId: string | undefined) {
  const { socket, connected } = useSocket()
  const {
    localOnline,
    agents,
    localError,
    isLoadingAgents,
    setLocalOnline,
    setAgents,
    addAgent,
    removeAgent,
    setIsLoadingAgents,
    reset,
  } = useCliAgentStore()

  const healthAbortRef = useRef<AbortController | null>(null)
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** 执行一次本地健康检查 */
  const checkHealth = useCallback(async () => {
    if (healthAbortRef.current) {
      healthAbortRef.current.abort()
    }
    const controller = new AbortController()
    healthAbortRef.current = controller

    try {
      const res = await fetch(CLI_HEALTH_URL, {
        method: 'GET',
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as { ok?: boolean; agent?: string }
      if (data.ok) {
        setLocalOnline(true, null)
      } else {
        setLocalOnline(false, '本地 CLI 响应异常')
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? '健康检查已取消'
            : err.message
          : '本地 CLI 连接失败'
      setLocalOnline(false, message)
    }
  }, [setLocalOnline])

  /** 向后端请求当前房间的 CLI 代理列表 */
  const listAgents = useCallback(() => {
    if (!socket || !connected || !roomId) return
    setIsLoadingAgents(true)
    socket.emit('cli-list-agents', roomId)
  }, [socket, connected, roomId, setIsLoadingAgents])

  // 1. 本地健康检查轮询（仅浏览器本地页面；远程访问时 127.0.0.1 指向
  //    访问者自己的设备，轮询必然失败且刷屏报错，直接跳过）
  useEffect(() => {
    if (!roomId) {
      reset()
      return
    }
    if (!isLocalPage()) {
      setLocalOnline(false, null)
      return
    }

    // 立即检查一次，再启动轮询
    void checkHealth()
    healthTimerRef.current = setInterval(() => {
      void checkHealth()
    }, HEALTH_POLL_INTERVAL_MS)

    return () => {
      if (healthTimerRef.current) {
        clearInterval(healthTimerRef.current)
        healthTimerRef.current = null
      }
      if (healthAbortRef.current) {
        healthAbortRef.current.abort()
        healthAbortRef.current = null
      }
    }
  }, [roomId, checkHealth, reset, setLocalOnline])

  // 1b. 定期向后端刷新代理列表，避免 CLI 重连或前端挂载时机导致 agents 为空。
  // 同时用户启用 CLI 后也能更快感知到代理上线。
  const agentsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!socket || !connected || !roomId) return

    // 立即拉取一次，再启动 3 秒轮询
    listAgents()
    agentsTimerRef.current = setInterval(() => {
      listAgents()
    }, 3000)

    return () => {
      if (agentsTimerRef.current) {
        clearInterval(agentsTimerRef.current)
        agentsTimerRef.current = null
      }
    }
  }, [socket, connected, roomId, listAgents])

  // 2. socket 事件监听：代理上线/下线/列表
  useEffect(() => {
    if (!socket || !roomId) return

    const handleAvailable = (payload: CliAgentAvailablePayload) => {
      addAgent(payload)
    }

    const handleUnavailable = (payload: { socketId: string }) => {
      removeAgent(payload.socketId)
    }

    const handleAgents = (payload: CliAgentsPayload) => {
      if (payload.roomId !== roomId) return
      setAgents(payload.agents)
      setIsLoadingAgents(false)
    }

    socket.on('cli-agent-available', handleAvailable)
    socket.on('cli-agent-unavailable', handleUnavailable)
    socket.on('cli-agents', handleAgents)

    // 连接成功后立即拉取一次代理列表
    if (connected) {
      listAgents()
    }

    return () => {
      socket.off('cli-agent-available', handleAvailable)
      socket.off('cli-agent-unavailable', handleUnavailable)
      socket.off('cli-agents', handleAgents)
    }
  }, [
    socket,
    roomId,
    connected,
    addAgent,
    removeAgent,
    setAgents,
    setIsLoadingAgents,
    listAgents,
  ])

  // 3. socket 重连后重新拉取代理列表
  useEffect(() => {
    if (connected && roomId) {
      listAgents()
    }
  }, [connected, roomId, listAgents])

  // 房间内有已注册的 CLI 代理即视为可用。
  // 不再强制要求 localOnline：健康检查可能因 CORS/浏览器策略暂时失败，
  // 但 CLI HTTP 服务实际可用。实际不可用时 fetch 会自然报错。
  const selectedAgent = agents[0] ?? null
  const available = agents.length > 0

  return {
    /** 本地 CLI 是否在线 */
    localOnline,
    /** 房间内是否有已注册的 CLI 代理 */
    hasAgent: agents.length > 0,
    /** 房间内有代理即可投入使用（不再强制要求本地健康检查通过） */
    available,
    /** 推荐使用的代理 URL（取第一个可用代理） */
    proxyUrl: selectedAgent?.proxyUrl ?? null,
    /** 代理元信息 */
    agentInfo: selectedAgent,
    /** 最近一次本地健康检查错误 */
    localError,
    /** 是否正在从后端拉取代理列表 */
    isLoadingAgents,
    /** 手动刷新代理列表 */
    refreshAgents: listAgents,
  }
}
