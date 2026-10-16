import { useEffect } from 'react'
import { setWakeLockEnabled } from '@/utils/wakeLock'

/**
 * 屏幕防息屏 hook：enabled 为 true 且处于移动/平板设备、页面可见时，
 * 持有 Screen Wake Lock 阻止设备息屏；条件不满足或组件卸载时释放。
 *
 * 内部实现见 utils/wakeLock.ts（generation 计数 + pending 标志 +
 * debounce 同步 + visibilitychange/PiP/pagehide 全事件兜底，
 * 移植自 mirotalk wakeLock.js）。
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    setWakeLockEnabled(enabled)
    return () => {
      setWakeLockEnabled(false)
    }
  }, [enabled])
}
