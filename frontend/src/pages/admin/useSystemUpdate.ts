import { useRef, useState, type ChangeEvent, type Dispatch } from 'react'
import type { SetStateAction } from 'react'
import { message } from '@/components/ui/message'
import { apiFetch, getApiUrl } from '@/lib/api'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import type {
  UpdateInfo,
  UpdateProgress,
  UpdateStageEventPayload,
} from './shared'
import { t } from '@/i18n'

/** 桌面 GUI 托管时的统一提示（与后端 DESKTOP_UPDATE_HINT 同文案） */
const DESKTOP_UPDATE_HINT =
  '当前由 ZViewer Desktop 桌面端管理，请去 GUI 的更新功能中更新'

/** 当前是否由桌面端托管（读取时机取调用瞬间，避免闭包拿到旧值） */
function isDesktopManaged(): boolean {
  return useSystemSettingsStore.getState().desktopManaged
}

interface UseSystemUpdateOptions {
  /** 请求鉴权头（与 AdminPage 其余管理端请求保持一致） */
  authHeaders: Record<string, string>
}

/** SSE 增量解析的游标状态（原 AdminPage 两处相同的局部变量合并于此） */
interface SseParseState {
  buffer: string
  lastStage: UpdateProgress['stage'] | null
  doneMessage: string
  errorMessage: string
}

/**
 * 处理一段增量 SSE 文本：按 `\n\n` 分割事件，每条事件 `data: <json>`，
 * 解析后推进更新进度状态。
 *
 * 原 AdminPage 中「一键更新」（fetch 流式读取）与「手动上传更新包」
 * （XHR responseText 增量读取）存在两遍相同的解析/分发代码，合并为本函数；
 * `withDownloadingStage` 为 false 时忽略 downloading 阶段事件（上传场景的
 * 进度由 XHR upload.onprogress 推送），与原 XHR 路径行为完全一致。
 */
function processUpdateSseChunk(
  state: SseParseState,
  chunk: string,
  setUpdateProgress: Dispatch<SetStateAction<UpdateProgress | null>>,
  withDownloadingStage: boolean
): void {
  state.buffer += chunk
  const events = state.buffer.split('\n\n')
  state.buffer = events.pop() ?? ''
  for (const evt of events) {
    const line = evt.trim()
    if (!line.startsWith('data: ')) continue
    const jsonStr = line.slice(6).trim()
    if (!jsonStr) continue
    try {
      const data = JSON.parse(jsonStr) as UpdateStageEventPayload
      if (data.stage === 'downloading' && withDownloadingStage) {
        setUpdateProgress({
          stage: 'downloading',
          received: data.received ?? 0,
          total: data.total ?? 0,
          message: '',
        })
      } else if (data.stage === 'extracting') {
        setUpdateProgress({
          stage: 'extracting',
          received: 0,
          total: 0,
          message: t('正在解压更新包…'),
        })
      } else if (data.stage === 'starting') {
        setUpdateProgress({
          stage: 'starting',
          received: 0,
          total: 0,
          message: t('正在启动更新脚本…'),
        })
      } else if (data.stage === 'done') {
        state.doneMessage = data.message ?? t('更新已触发')
        setUpdateProgress({
          stage: 'done',
          received: 0,
          total: 0,
          message: state.doneMessage,
        })
      } else if (data.stage === 'error') {
        state.errorMessage = data.message ?? t('更新失败')
        setUpdateProgress({
          stage: 'error',
          received: 0,
          total: 0,
          message: state.errorMessage,
        })
      }
      state.lastStage = data.stage
    } catch {
      // 忽略解析错误
    }
  }
}

/**
 * 系统更新（检查更新 / 一键更新 / 手动上传更新包）的状态与动作。
 * 从 AdminPage 原样抽出：状态由调用方持有以在 Tab 切换间保持不变。
 */
export function useSystemUpdate({ authHeaders }: UseSystemUpdateOptions) {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateLoading, setUpdateLoading] = useState(false)
  const [applyLoading, setApplyLoading] = useState(false)
  const [uploadLoading, setUploadLoading] = useState(false)
  // 更新进度：应用更新时由 SSE 流式接口实时推送
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(
    null
  )
  const [includePrerelease, setIncludePrerelease] = useState(
    () => localStorage.getItem('update-include-prerelease') === 'true'
  )
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const checkUpdate = async () => {
    // 桌面端托管时更新入口整体禁用（后端也返回 409）：静默跳过自动检测，
    // 避免进入设置页就弹「检查更新失败」
    if (isDesktopManaged()) return
    setUpdateLoading(true)
    try {
      const res = await apiFetch(
        `/api/system/update/check?includePrerelease=${includePrerelease}`,
        {
          headers: authHeaders,
        }
      )
      const data = (await res.json()) as {
        success: boolean
        info?: UpdateInfo
        message?: string
        /** 后端 409：运行在桌面 GUI 托管环境 */
        desktopManaged?: boolean
      }
      if (data.desktopManaged === true) {
        // 公开设置未及时拉到时的兜底：以后端返回为准，静默收起更新入口
        useSystemSettingsStore.setState({ desktopManaged: true })
        return
      }
      if (data.success && data.info) {
        setUpdateInfo(data.info)
        if (data.info.hasUpdate) {
          message.info(
            data.info.isPrerelease ? t('发现新预发布版本') : t('发现新版本')
          )
        } else {
          message.success(t('当前已是最新版本'))
        }
      } else {
        message.error(data.message ?? t('检查更新失败'))
      }
    } catch (err) {
      console.error('[AdminPage] check update error:', err)
      message.error(t('检查更新失败'))
    } finally {
      setUpdateLoading(false)
    }
  }

  const handleApplyUpdate = async () => {
    if (isDesktopManaged()) {
      message.info(DESKTOP_UPDATE_HINT)
      return
    }
    setApplyLoading(true)
    setUpdateProgress({
      stage: 'downloading',
      received: 0,
      total: 0,
      message: '',
    })
    try {
      // 使用 SSE 流式接口，实时推送下载/解压/启动进度
      const res = await apiFetch(
        `/api/system/update/apply-stream?includePrerelease=${includePrerelease}`,
        {
          method: 'POST',
          headers: authHeaders,
        }
      )

      if (!res.ok || !res.body) {
        // 非流式错误响应（如 401/403/500）
        const errData = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        message.error(errData.message ?? t('更新失败'))
        setUpdateProgress(null)
        return
      }

      // 读取 SSE 流：按 `\n\n` 分割事件，每条事件 `data: <json>`
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const sse: SseParseState = {
        buffer: '',
        lastStage: null,
        doneMessage: '',
        errorMessage: '',
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        processUpdateSseChunk(
          sse,
          decoder.decode(value, { stream: true }),
          setUpdateProgress,
          true
        )
      }

      if (sse.lastStage === 'done') {
        message.success(sse.doneMessage || t('更新已触发'))
      } else if (sse.lastStage === 'error') {
        message.error(sse.errorMessage || t('更新失败'))
      } else {
        // 流意外中断，未收到 done/error
        message.error(t('更新中断，请重试'))
      }
    } catch (err) {
      console.error('[AdminPage] apply update error:', err)
      message.error(t('更新失败'))
    } finally {
      setApplyLoading(false)
      // 保留进度状态显示最终结果，3 秒后清除
      setTimeout(() => setUpdateProgress(null), 3000)
    }
  }

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (isDesktopManaged()) {
      message.info(DESKTOP_UPDATE_HINT)
      event.target.value = ''
      return
    }
    const file = event.target.files?.[0]
    if (!file) return

    // 验证文件类型
    const lowerName = file.name.toLowerCase()
    if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.tar.gz')) {
      message.error(t('仅支持 .zip 或 .tar.gz 格式的压缩包'))
      event.target.value = ''
      return
    }

    setUploadLoading(true)
    setUpdateProgress({
      stage: 'downloading',
      received: 0,
      total: file.size,
      message: t('正在上传更新包…'),
    })

    try {
      // 使用 XHR 上传：可跟踪上传进度，响应体为 SSE 流
      const apiUrl = getApiUrl()
      const uploadUrl = `${apiUrl}/api/system/update/upload-stream?filename=${encodeURIComponent(file.name)}`

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', uploadUrl)
        xhr.withCredentials = true
        xhr.responseType = 'text'
        xhr.setRequestHeader(
          'Content-Type',
          lowerName.endsWith('.tar.gz') ? 'application/gzip' : 'application/zip'
        )

        // 上传进度跟踪
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUpdateProgress({
              stage: 'downloading',
              received: e.loaded,
              total: e.total,
              message: t('正在上传更新包…'),
            })
          }
        }

        // 上传完成 → 开始接收 SSE 响应流
        // xhr.onprogress 在响应数据到达时触发，可读取增量 responseText
        let lastProcessedLen = 0
        const sse: SseParseState = {
          buffer: '',
          lastStage: null,
          doneMessage: '',
          errorMessage: '',
        }

        const processSSEChunk = () => {
          const fullText = xhr.responseText || ''
          const chunk = fullText.slice(lastProcessedLen)
          lastProcessedLen = fullText.length
          // 上传路径不处理 downloading 阶段（进度来自 upload.onprogress）
          processUpdateSseChunk(sse, chunk, setUpdateProgress, false)
        }

        xhr.onprogress = processSSEChunk

        xhr.onload = () => {
          // 处理流中剩余数据
          processSSEChunk()
          if (xhr.status >= 200 && xhr.status < 300) {
            if (sse.lastStage === 'done') {
              message.success(sse.doneMessage || t('更新已触发'))
            } else if (sse.lastStage === 'error') {
              message.error(sse.errorMessage || t('上传更新失败'))
            } else if (sse.lastStage === null) {
              // 未收到 SSE 事件，可能是普通 JSON 响应（错误场景）
              try {
                const data = JSON.parse(xhr.responseText) as {
                  success?: boolean
                  message?: string
                }
                if (data.success) {
                  message.success(data.message ?? t('更新已触发'))
                } else {
                  message.error(data.message ?? t('上传更新失败'))
                }
              } catch {
                message.error(t('上传更新失败'))
              }
            }
            resolve()
          } else if (xhr.status === 401 || xhr.status === 403) {
            message.error(t('登录已过期，请重新登录后再试'))
            reject(new Error('auth expired'))
          } else {
            // 非 SSE 错误响应
            try {
              const data = JSON.parse(xhr.responseText) as {
                message?: string
              }
              message.error(data.message ?? t('上传更新失败'))
            } catch {
              message.error(t('上传更新失败'))
            }
            reject(new Error(`HTTP ${xhr.status}`))
          }
        }

        xhr.onerror = () => {
          message.error(t('网络错误，上传更新失败'))
          reject(new Error('network error'))
        }

        xhr.send(file)
      })
    } catch (err) {
      console.error('[AdminPage] upload update error:', err)
      if (
        err instanceof Error &&
        err.message !== 'network error' &&
        err.message !== 'auth expired' &&
        !err.message.startsWith('HTTP')
      ) {
        message.error(t('上传更新失败'))
      }
    } finally {
      setUploadLoading(false)
      event.target.value = ''
      // 保留进度状态显示最终结果，3 秒后清除
      setTimeout(() => setUpdateProgress(null), 3000)
    }
  }

  return {
    updateInfo,
    updateLoading,
    applyLoading,
    uploadLoading,
    updateProgress,
    includePrerelease,
    setIncludePrerelease,
    fileInputRef,
    checkUpdate,
    handleApplyUpdate,
    handleFileUpload,
  }
}

export type SystemUpdateApi = ReturnType<typeof useSystemUpdate>
