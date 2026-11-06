/**
 * 共享模块的界面文案。
 *
 * 旧链路在 core 里产语义码、由这里翻成文案；Piik 链路的会话本身就产出文案，
 * 只有「没有画面时该说什么」还需要页面级判断，所以这里只剩状态提示与
 * 编码参数提示。
 */
import { t } from '@/i18n'
import type { ViewerSessionState } from '../core/view-state'

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

/**
 * 观众画面上的状态提示。
 *
 * 只在**没有画面**时展示：有画面就说明一切正常，不该再盖文字。
 */
export function viewerStatusText(state: ViewerSessionState): string {
  // 顺序有讲究：**错误优先于「等待房主」**。
  //
  // 先报 `等待房主开始共享` 的话，任何在进入共享之前发生的错误都会被这句盖住，
  // 现场表现就是「观众一直等房主」，而真正的原因一个字都看不到。共享没开始
  // 是常态，错误不是，所以先把错误说出来。
  if (state.exhausted) return state.error || t('连接已断开，请点击刷新重试')
  if (state.recovering) return t('正在重新连接...')
  if (state.error) return state.error
  if (!state.sharing) return t('等待房主开始共享')
  if (state.paused) return t('房主已暂停共享')
  return t('正在接收画面...')
}
