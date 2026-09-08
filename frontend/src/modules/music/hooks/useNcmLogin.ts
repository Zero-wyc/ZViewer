import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import type { NcmLoginStatus } from '../types'

/** 二维码扫码状态轮询间隔（毫秒） */
const QR_POLL_INTERVAL_MS = 1500

/** /login/qr/check 状态码（网易云约定） */
const QR_STATUS_CODE = {
  /** 二维码已失效（需重新生成） */
  EXPIRED: 800,
  /** 等待扫码 */
  WAITING: 801,
  /** 已扫码，等待确认 */
  SCANNED: 802,
  /** 扫码确认，登录成功 */
  SUCCESS: 803,
} as const

/** 扫码登录流程状态 */
export type NcmQrStatus =
  'idle' | 'generating' | 'waiting' | 'scanned' | 'success' | 'error'

export interface UseNcmLoginResult {
  /** 二维码图片（base64 data URL；未生成时 null） */
  qrImg: string | null
  /** 扫码流程状态（waiting 待扫码 / scanned 已扫待确认 / success 成功） */
  status: NcmQrStatus
  /** 启动扫码登录：生成 key → 生成二维码 → 开始轮询 */
  startLogin: () => Promise<void>
  /** 停止轮询（关闭登录弹窗时调用） */
  stopPolling: () => void
  /** 登录状态（与 music store 共享） */
  loginStatus: NcmLoginStatus
  /** 主动刷新登录状态（/api/music/login/status） */
  fetchLoginStatus: () => Promise<void>
  /** 退出登录（/api/music/logout）并清空本地登录态 */
  logout: () => Promise<void>
}

/**
 * 网易云扫码登录 Hook（仅房主使用，参考 Hydrogen src/api/login.js 流程）：
 * 1. generateQrKey：GET /api/music/ncm/login/qr/key → unikey
 * 2. createQr：GET /api/music/ncm/login/qr/create?qrimg=true → qrimg base64
 * 3. pollCheck：每 1.5s 轮询 /api/music/ncm/login/qr/check
 *    （800 失效重新生成 / 801 待扫码 / 802 已扫待确认 / 803 成功）
 * 4. 成功后 fetchLoginStatus 刷新登录态；登录过期（301）时提示并清空本地状态
 *
 * 后端响应结构兼容两种形态：透传网易云原始结构（data.xxx）
 * 与包装结构（顶层字段）。
 */
export function useNcmLogin(): UseNcmLoginResult {
  const [qrImg, setQrImg] = useState<string | null>(null)
  const [status, setStatus] = useState<NcmQrStatus>('idle')
  const loginStatus = useMusicStore((s) => s.loginStatus)

  /** 轮询定时器 */
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 当前轮询中的扫码 key（key 变更后旧轮询自动失效） */
  const qrKeyRef = useRef<string | null>(null)
  /** startLogin 并发保护 */
  const startingRef = useRef(false)
  /** startLogin 自引用（二维码失效自动重建时调用，断开循环依赖） */
  const startLoginRef = useRef<() => Promise<void>>(async () => {})

  /** 生成扫码 key（/api/music/ncm/login/qr/key → unikey） */
  const generateQrKey = useCallback(async (): Promise<string | null> => {
    const { data } = await apiGet<{
      code?: number
      data?: { unikey?: string }
      unikey?: string
    }>(`/api/music/ncm/login/qr/key?timestamp=${Date.now()}`)
    return data?.data?.unikey ?? data?.unikey ?? null
  }, [])

  /** 生成二维码图片（/login/qr/create?qrimg=true → qrimg base64） */
  const createQr = useCallback(async (key: string): Promise<string | null> => {
    const { data } = await apiGet<{
      code?: number
      data?: { qrimg?: string }
      qrimg?: string
    }>(
      `/api/music/ncm/login/qr/create?key=${encodeURIComponent(
        key
      )}&qrimg=true&timestamp=${Date.now()}`
    )
    return data?.data?.qrimg ?? data?.qrimg ?? null
  }, [])

  /**
   * 查询登录状态（/api/music/login/status）。
   * 网易云 301（未登录/登录过期）：提示"登录已过期"并清空本地登录态
   * （仅此前已登录时提示，避免匿名状态检查的噪音）。
   */
  const fetchLoginStatus = useCallback(async () => {
    try {
      const { data, ok } = await apiGet<{
        code?: number
        loggedIn?: boolean
        nickname?: string
        avatarUrl?: string
        profile?: { nickname?: string; avatarUrl?: string }
      }>(`/api/music/login/status?timestamp=${Date.now()}`)
      if (!ok || !data) return
      if (data.code === 301) {
        const wasLoggedIn = useMusicStore.getState().loginStatus.loggedIn
        if (wasLoggedIn) {
          message.info('网易云登录已过期，请重新扫码登录')
        }
        useMusicStore.getState().setLoginStatus({ loggedIn: false })
        return
      }
      useMusicStore.getState().setLoginStatus({
        loggedIn: data.loggedIn ?? false,
        nickname: data.profile?.nickname ?? data.nickname,
        avatarUrl: data.profile?.avatarUrl ?? data.avatarUrl,
      })
    } catch (err) {
      console.error('[useNcmLogin] 查询登录状态失败:', err)
    }
  }, [])

  /** 退出登录（/api/music/logout）并清空本地登录态 */
  const logout = useCallback(async () => {
    try {
      await apiPost('/api/music/logout')
    } catch (err) {
      console.error('[useNcmLogin] 退出登录失败:', err)
    } finally {
      useMusicStore.getState().setLoginStatus({ loggedIn: false })
    }
  }, [])

  /** 停止扫码状态轮询（关闭登录弹窗时调用） */
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    qrKeyRef.current = null
  }, [])

  /** 开始轮询扫码状态（800 失效自动重新生成 / 803 成功停止并刷新登录态） */
  const startPolling = useCallback(
    (key: string) => {
      stopPolling()
      qrKeyRef.current = key
      pollTimerRef.current = setInterval(() => {
        // key 已更换或已停止：本轮跳过
        if (qrKeyRef.current !== key) return
        void (async () => {
          try {
            const { data } = await apiGet<{
              code?: number
              data?: { code?: number }
            }>(
              `/api/music/ncm/login/qr/check?key=${encodeURIComponent(
                key
              )}&timestamp=${Date.now()}`
            )
            if (qrKeyRef.current !== key) return
            const code = data?.data?.code ?? data?.code
            switch (code) {
              case QR_STATUS_CODE.WAITING:
                setStatus((prev) => (prev === 'waiting' ? prev : 'waiting'))
                break
              case QR_STATUS_CODE.SCANNED:
                setStatus((prev) => (prev === 'scanned' ? prev : 'scanned'))
                break
              case QR_STATUS_CODE.SUCCESS:
                // 登录成功：停止轮询并刷新登录状态
                stopPolling()
                setStatus('success')
                await fetchLoginStatus()
                break
              case QR_STATUS_CODE.EXPIRED:
                // 二维码失效：停止当前轮询并重新生成
                stopPolling()
                await startLoginRef.current()
                break
              default:
                // 未知状态码：跳过本轮
                break
            }
          } catch {
            // 网络错误：跳过本轮，等待下次轮询
          }
        })()
      }, QR_POLL_INTERVAL_MS)
    },
    [stopPolling, fetchLoginStatus]
  )

  /** 启动扫码登录：生成 key → 生成二维码 → 开始轮询 */
  const startLogin = useCallback(async () => {
    if (startingRef.current) return
    startingRef.current = true
    try {
      stopPolling()
      setStatus('generating')
      setQrImg(null)
      const key = await generateQrKey()
      if (!key) {
        setStatus('error')
        message.error('生成登录二维码失败，请重试')
        return
      }
      const img = await createQr(key)
      if (!img) {
        setStatus('error')
        message.error('生成登录二维码失败，请重试')
        return
      }
      setQrImg(img)
      setStatus('waiting')
      startPolling(key)
    } catch (err) {
      console.error('[useNcmLogin] 启动扫码登录失败:', err)
      setStatus('error')
      message.error('启动扫码登录失败，请重试')
    } finally {
      startingRef.current = false
    }
  }, [generateQrKey, createQr, startPolling, stopPolling])

  // 同步自引用：二维码失效（800）时轮询回调经 ref 调用最新 startLogin 重建
  useEffect(() => {
    startLoginRef.current = startLogin
  }, [startLogin])

  // 挂载时主动查询一次登录状态（面板展示已登录昵称/头像）
  useEffect(() => {
    void fetchLoginStatus()
  }, [fetchLoginStatus])

  // 卸载时停止轮询，避免组件销毁后仍发起请求
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  return {
    qrImg,
    status,
    startLogin,
    stopPolling,
    loginStatus,
    fetchLoginStatus,
    logout,
  }
}
