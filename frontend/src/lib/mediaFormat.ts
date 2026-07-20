/**
 * 前端媒体格式识别工具（对应后端 services/mediaFormat.ts）。
 *
 * 浏览器 <video> 元素原生支持的容器有限：
 * - mp4/webm/mov：原生支持，可直接设置 video.src
 * - dash：B站 DASH 流，需要 MSE 合并 video+audio
 * - mkv/avi/flv/wmv/ts：不支持，直接赋值给 video.src 会抛 NotSupportedError
 *
 * 对于不支持的容器，应在加载前给出明确提示，而非让浏览器抛出
 * NotSupportedError 导致黑屏无反馈。
 */

export type MediaFormat =
  | 'mp4'
  | 'webm'
  | 'mkv'
  | 'avi'
  | 'flv'
  | 'wmv'
  | 'mov'
  | 'ts'
  | 'dash'
  | 'unknown'

/** 浏览器原生支持的容器格式（可直接设置 video.src） */
export const BROWSER_NATIVE_FORMATS: MediaFormat[] = ['mp4', 'webm', 'mov']

/** 通过 MSE 可播放的格式（B站 DASH 流） */
export const MSE_SUPPORTED_FORMATS: MediaFormat[] = ['dash']

/**
 * 从文件路径或文件名推断媒体格式。
 * @param filename 文件路径或文件名
 * @returns 小写的格式标识符，如 'mp4'、'mkv'
 */
export function detectMediaFormat(filename: string): MediaFormat {
  if (!filename) return 'unknown'
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex < 0 || dotIndex === filename.length - 1) return 'unknown'
  const ext = filename.slice(dotIndex + 1).toLowerCase()
  const formatMap: Record<string, MediaFormat> = {
    mp4: 'mp4',
    m4v: 'mp4',
    webm: 'webm',
    mkv: 'mkv',
    avi: 'avi',
    flv: 'flv',
    wmv: 'wmv',
    mov: 'mov',
    m2ts: 'ts',
    ts: 'ts',
  }
  return formatMap[ext] || 'unknown'
}

/**
 * 判断格式是否被浏览器原生支持（可直接设置 video.src）。
 * 注意：'dash' 不在此列，它需要 MSE 处理。
 */
export function isBrowserNativeFormat(
  format?: MediaFormat | string | null
): boolean {
  if (!format) return false
  return (BROWSER_NATIVE_FORMATS as string[]).includes(format)
}

/**
 * 判断格式是否可在浏览器中播放（原生或通过 MSE）。
 *
 * - mp4/webm/mov：原生支持
 * - dash：通过 MSE 支持
 * - unknown / 未提供：无法从扩展名判断，让浏览器尝试播放（避免误伤无扩展名 URL）
 * - mkv/avi/flv/wmv/ts：明确不支持，应给出提示
 */
export function isBrowserPlayableFormat(
  format?: MediaFormat | string | null
): boolean {
  if (!format || format === 'unknown') return true
  if (isBrowserNativeFormat(format)) return true
  return (MSE_SUPPORTED_FORMATS as string[]).includes(format)
}

/**
 * 生成不支持的格式提示文案。
 */
export function getUnsupportedFormatMessage(
  format?: MediaFormat | string | null
): string {
  if (!format || format === 'unknown') {
    return '该文件格式未知，浏览器无法播放'
  }
  return `该文件格式（${format.toUpperCase()}）不被浏览器原生支持，请选择 MP4/WebM/MOV 文件`
}
