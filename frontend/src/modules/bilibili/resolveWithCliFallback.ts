import { message } from '@/components/ui/message'
import type { ResolvedSource } from '@/modules/movie-source/resolveSource'
import { CliConnectionError, CliPrecheckError, CliResolveError } from './cliApi'
import { t } from '@/i18n'

export interface BilibiliCliFallbackParams {
  /**
   * CLI 已连接且目标可走 CLI 时的解析调用。
   * 传 undefined 表示本次直接走服务器端解析（CLI 未连接 / 无 bvid）。
   */
  viaCli?: () => Promise<ResolvedSource>
  /** 服务器端（后端）解析调用 */
  viaServer: () => Promise<ResolvedSource>
  /** CLI 解析中的进度文案 */
  cliProgress: string
  /** 服务器回退时的进度文案 */
  serverProgress: string
  /** 进度上报（通常为 setResolveProgress） */
  setProgress: (message: string) => void
  /** 日志前缀，默认 [MoviePushPanel] */
  logTag?: string
}

export interface BilibiliCliFallbackResult {
  resolved: ResolvedSource
  /** 结果是否来自 CLI（调用方据此维护 resolvedViaCliRef，决定添加影片时是否强制走 CLI） */
  viaCli: boolean
}

/**
 * B站 解析的「CLI 优先 → 失败回退服务器端」统一流程。
 *
 * 原 MoviePushPanel 中 handleResolve / handleQualityChange / handlePageSelect
 * 四处逐字相同的 try-catch 模板合并于此：
 *   - CLI 连接失败：仅 warn 日志（不回显，避免打扰用户）
 *   - CLI 解析失败：warning 提示原因后回退
 *   - 无论哪种失败都继续走服务器端解析，不中断用户操作
 */
export async function resolveBilibiliWithCliFallback({
  viaCli,
  viaServer,
  cliProgress,
  serverProgress,
  setProgress,
  logTag = '[MoviePushPanel]',
}: BilibiliCliFallbackParams): Promise<BilibiliCliFallbackResult> {
  let resolved: ResolvedSource | undefined
  let viaCliUsed = false

  if (viaCli) {
    try {
      setProgress(cliProgress)
      resolved = await viaCli()
      viaCliUsed = true
    } catch (cliErr) {
      if (cliErr instanceof CliConnectionError) {
        console.warn(`${logTag} CLI 代理连接失败，回退到服务器端解析`)
      } else if (cliErr instanceof CliPrecheckError) {
        // 前置查询失败（如拿不到分 P cid）与 CLI 是否可用无关，静默回退即可
        console.warn(`${logTag} ${cliErr.message}`)
      } else if (cliErr instanceof CliResolveError) {
        message.warning(
          t('{{message}}，已回退到服务器端解析', { message: cliErr.message })
        )
      }
    }
  }

  if (!resolved) {
    setProgress(serverProgress)
    resolved = await viaServer()
  }

  return { resolved, viaCli: viaCliUsed }
}
