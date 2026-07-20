import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface PageBackButtonProps {
  /** 返回目标，默认 '/'；可传数字表示 navigate(-n) */
  to?: string | number
  /** 自定义文案，默认"返回" */
  label?: string
  /** 额外 className */
  className?: string
}

/**
 * 统一的页面返回按钮
 * - 固定使用带边框的 secondary 风格，提升可见性
 * - 绝对定位在父容器左上角（要求父容器 relative）
 * - 所有页面的返回按钮统一使用此组件
 */
export function PageBackButton({
  to = '/',
  label = '返回',
  className = '',
}: PageBackButtonProps) {
  const navigate = useNavigate()

  const handleClick = () => {
    if (typeof to === 'number') {
      navigate(to)
    } else {
      navigate(to)
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      disableAnimation
      icon={<ArrowLeft className="h-4 w-4" />}
      onClick={handleClick}
      className={`absolute left-4 top-4 z-10 ${className}`}
    >
      {label}
    </Button>
  )
}
