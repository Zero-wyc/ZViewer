import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * 鼠标位置感知光效 Hook
 *
 * 为目标元素设置 --mx / --my CSS 变量（百分比 0-100），
 * 配合 .zen-card::after / .zen-btn::before 等使用 radial-gradient 的伪元素，
 * 实现 spotlight 跟随鼠标的华丽光晕效果。
 *
 * 仅在 hover 时更新，鼠标离开自动复位。
 */
export function useSpotlight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    el.style.setProperty('--mx', `${x}%`)
    el.style.setProperty('--my', `${y}%`)
  }, [])

  const handleMouseLeave = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--mx', '50%')
    el.style.setProperty('--my', '50%')
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('mousemove', handleMouseMove)
    el.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      el.removeEventListener('mousemove', handleMouseMove)
      el.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [handleMouseMove, handleMouseLeave])

  return ref
}

/**
 * 3D 倾斜响应 Hook
 *
 * 鼠标在元素上移动时，根据相对位置计算 rotateX / rotateY，
 * 实现 3D 卡片倾斜效果（perspective 由 CSS 控制）。
 * 鼠标离开时平滑回正。
 *
 * @param maxAngle 最大倾斜角度（默认 6 度）
 */
export function useTilt<T extends HTMLElement = HTMLDivElement>(maxAngle = 6) {
  const ref = useRef<T>(null)

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height
      const rotateY = (x - 0.5) * 2 * maxAngle
      const rotateX = -(y - 0.5) * 2 * maxAngle
      el.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`
    },
    [maxAngle]
  )

  const handleMouseLeave = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg)'
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('mousemove', handleMouseMove)
    el.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      el.removeEventListener('mousemove', handleMouseMove)
      el.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [handleMouseMove, handleMouseLeave])

  return ref
}

/**
 * 滚动触发揭示 Hook
 *
 * 配合 .zen-on-scroll 类使用：元素进入视口时添加 is-visible 类，
 * 触发 opacity / transform / filter 过渡动画。
 *
 * @param options IntersectionObserver 选项
 */
export function useScrollReveal<T extends HTMLElement = HTMLDivElement>(
  options: IntersectionObserverInit = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px',
  }
) {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.unobserve(entry.target)
        }
      })
    }, options)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { ref, visible }
}

/**
 * 数值变化高亮 Hook
 *
 * 当目标值变化时，返回一个 key，用作 React 元素的 key 触发重渲染，
 * 配合 .zen-value-flash 类实现数字跳动闪光动画。
 */
export function useValueFlash<T>(value: T): { key: number; className: string } {
  const [key, setKey] = useState(0)
  const prevRef = useRef<T>(value)

  useEffect(() => {
    if (prevRef.current !== value) {
      prevRef.current = value
      setKey((k) => k + 1)
    }
  }, [value])

  return { key, className: key > 0 ? 'zen-value-flash' : '' }
}
