/**
 * 根据文件扩展名推断媒体格式。
 *
 * 浏览器 <video> 元素原生支持的容器有限：
 * - mp4/webm：原生支持
 * - mkv/avi/wmv/flv 等：不支持，直接赋值给 video.src 会抛 NotSupportedError
 *
 * 对于不支持的容器，前端应给出明确提示而非黑屏。
 */
export type MediaFormat = 'mp4' | 'webm' | 'mkv' | 'avi' | 'flv' | 'wmv' | 'mov' | 'ts' | 'unknown';

/** 浏览器原生支持的容器格式 */
export const BROWSER_SUPPORTED_FORMATS: MediaFormat[] = ['mp4', 'webm', 'mov'];

/**
 * 从文件路径或文件名推断媒体格式。
 * @param filename 文件路径或文件名
 * @returns 小写的格式标识符，如 'mp4'、'mkv'
 */
export function detectMediaFormat(filename: string): MediaFormat {
  if (!filename) return 'unknown';
  // 取最后一个 . 后的扩展名
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === filename.length - 1) return 'unknown';
  const ext = filename.slice(dotIndex + 1).toLowerCase();
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
  };
  return formatMap[ext] || 'unknown';
}

/**
 * 判断格式是否被浏览器原生支持。
 */
export function isBrowserSupportedFormat(format: MediaFormat): boolean {
  return BROWSER_SUPPORTED_FORMATS.includes(format);
}

/**
 * 返回对应的 Content-Type。
 * 用于 proxy 响应头，确保浏览器能正确识别媒体类型。
 */
export function getContentType(format: MediaFormat): string {
  const typeMap: Record<MediaFormat, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    mov: 'video/quicktime',
    ts: 'video/mp2t',
    unknown: 'application/octet-stream',
  };
  return typeMap[format];
}
