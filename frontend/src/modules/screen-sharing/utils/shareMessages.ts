/**
 * 共享模块的「语义码 → 界面文案」翻译层。
 *
 * core 里只产生语义码（`share.host.error.capture` 这类），不产生文案：
 * 这样 core 可以完全脱离 i18n 做单测，也避免把 `t()` 的调用点散在各个
 * 深层模块里。文案集中在这里，一律用字面量 `t('中文原文')` 调用，
 * 词条提取才能看见它们。
 */
import { t } from '@/i18n'
import type { ViewerSessionState } from '../core/viewer-session'

/** 房主侧失败原因。未知码返回 `null`，交给调用方决定是否原样展示。 */
export function hostErrorText(code: string | null): string | null {
  if (!code) return null
  switch (code) {
    case 'share.host.error.capture':
      return t('无法开始屏幕采集，请重新选择要共享的画面')
    case 'share.host.error.unsupportedProfile':
      return t('当前分辨率或帧率超出采集能力，请降低档位后重试')
    case 'share.host.error.disconnected':
      return t('与服务器的连接已断开，请刷新页面后重新开始共享')
    case 'share.host.error.noSource':
      return t('没有可用的画面来源，请重新选择要共享的画面')
    case 'share.host.error.codecUnsupported':
      return t('当前浏览器不支持所需的编码格式，请改用 Chrome 或 Edge')
    case 'share.host.error.routeExhausted':
      return t('多次建立观众连接失败，请刷新页面后重试')
    case 'share.host.error.negotiation':
      return t('与观众的连接协商失败，正在重试')
    case 'share.host.error.connection':
      return t('与观众的连接已中断，正在重试')
    case 'share.host.error.candidate':
      return t('网络候选地址处理失败，正在重试')
    case 'share.host.error.replaceSource':
      return t('切换画面来源失败，已保留原画面')
    case 'share.host.error.relay':
      return t('与服务器的转发连接建立失败，请重新开始共享')
    default:
      return null
  }
}

/**
 * 浏览器没有照办的编码参数 → 提示文案。
 *
 * `setParameters` 是请求不是命令：浏览器会按自己的策略改小码率、钉死帧率，
 * 甚至忽略降采样。不回读就等于默认一切照办，用户会以为画质参数生效了。
 */
export function parameterOverrideText(keys: string[] | null): string | null {
  if (!keys || keys.length === 0) return null
  const names = keys.map(parameterLabel)
  return t('浏览器调整了{{names}}，实际发送可能低于设定', {
    names: names.join('、'),
  })
}

/** 单个参数的中文名。未知键原样展示，便于排查新出现的字段。 */
function parameterLabel(key: string): string {
  switch (key) {
    case 'maxBitrate':
      return t('码率')
    case 'maxFramerate':
      return t('帧率')
    case 'scaleResolutionDownBy':
      return t('分辨率缩放')
    case 'degradationPreference':
      return t('降级偏好')
    case 'scalabilityMode':
      return t('分层模式')
    default:
      return key
  }
}

/** 观众侧失败原因。 */
export function viewerErrorText(code: string | null): string | null {
  if (!code) return null
  switch (code) {
    case 'share.viewer.error.routeExhausted':
      return t('与房主的连接多次建立失败，请点击刷新重试')
    case 'share.viewer.error.recoveryExhausted':
      return t('连接已断开，请点击刷新重试')
    case 'share.viewer.error.negotiation':
      return t('与房主的连接协商失败，正在重试')
    case 'share.viewer.error.connection':
      return t('与房主的连接已中断，正在重试')
    case 'share.viewer.error.candidate':
      return t('网络候选地址处理失败，正在重试')
    case 'share.viewer.error.relay':
      return t('转发服务连接已断开，请等房主重新开始共享')
    case 'share.viewer.error.protocol':
      return t('服务端返回的连接信息不完整，请刷新页面重试')
    default:
      return null
  }
}

/**
 * 观众画面上的状态提示。
 *
 * 只在**没有画面**时展示：有画面就说明一切正常，不该再盖文字。
 */
export function viewerStatusText(state: ViewerSessionState): string {
  if (!state.sharing) return t('等待房主开始共享')
  if (state.exhausted)
    return viewerErrorText(state.error) ?? t('连接已断开，请点击刷新重试')
  if (state.recovering) return t('正在重新连接...')
  if (state.paused) return t('房主已暂停共享')
  const failure = viewerErrorText(state.error)
  if (failure) return failure
  return t('正在接收画面...')
}
