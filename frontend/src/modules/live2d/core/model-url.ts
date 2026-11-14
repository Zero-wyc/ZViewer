import type { Live2DPeer } from '../types'
import { t } from '@/i18n'

// 模型地址的校验与解析。与后端 validateLive2DModelURL 保持同一套规则：
// 前端先拦一遍是为了给即时提示（不用等一次往返），真正的信任边界在服务端。

const MAX_URL_LEN = 512

/** 返回 null 表示合法；否则返回可直接展示给用户的原因。 */
export function validateModelUrl(raw: string): string | null {
  const url = raw.trim()
  if (!url) return t('请填写模型地址')
  if (url.length > MAX_URL_LEN) return t('地址过长')
  if (url.startsWith('//')) return t('不支持协议相对地址')
  if (url.startsWith('/')) {
    return /\.json$/i.test(url) ? null : t('地址必须指向 model3.json')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return t('地址格式无效')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return t('仅支持 http/https 地址')
  }
  if (!/\.json$/i.test(parsed.pathname)) return t('地址必须指向 model3.json')
  return null
}

/**
 * 把 peer 解析成引擎可加载的 model3.json 地址。
 *
 * 三种来源：
 * - builtin：随仓库放的前端静态资源；
 * - room：服务端公共模型库（任何人都能上传，所有房间共用；'room' 是协议里
 *   的历史名字，改动它会让已经持久化的 kind 失效）。服务端把入口统一命名成
 *   model.model3.json，所以地址只跟 modelId 有关，**不带房间号**；
 * - url：房主填的第三方地址（可能被 CORS 拦，加载失败由调用方降级）。
 */
export function resolveModelUrl(
  peer: Pick<Live2DPeer, 'kind' | 'modelId'>
): string {
  switch (peer.kind) {
    case 'url':
      return peer.modelId
    case 'room':
      return `/uploads/live2d/${encodeURIComponent(peer.modelId)}/model.model3.json`
    default:
      return `/live2d/models/${encodeURIComponent(peer.modelId)}/${encodeURIComponent(peer.modelId)}.model3.json`
  }
}
