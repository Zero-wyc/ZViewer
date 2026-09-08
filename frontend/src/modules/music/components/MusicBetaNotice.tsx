/**
 * Beta 功能未开启时的降级提示页（spec「Beta 门控」）。
 *
 * 应用场景：管理员关闭 Beta 后，用户通过直链/刷新访问 listen-together
 * 房间时，房主端与观众端均渲染此提示页（不渲染任何音乐 UI）。
 * 创建入口已由 RoomPanel 门控隐藏，此处仅防御直接 URL 场景。
 */
import { Music, ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Text } from '@/components/ui/Typography'
import { Button } from '@/components/ui/Button'

export function MusicBetaNotice() {
  const navigate = useNavigate()
  return (
    <div className="glass-card flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full"
        style={{ backgroundColor: 'var(--glass-bg)' }}
      >
        <Music
          className="h-8 w-8 opacity-40"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        />
      </div>
      <Text className="text-sm font-medium">该功能处于 Beta 阶段未开放</Text>
      <Text type="secondary" className="text-xs">
        请等待管理员开启 Beta 功能
      </Text>
      <Button
        variant="ghost"
        icon={<ArrowLeft className="h-4 w-4" />}
        onClick={() => navigate('/')}
        className="glass border"
        style={{
          borderColor: 'var(--md-sys-color-outline-variant)',
          color: 'var(--md-sys-color-on-surface)',
        }}
      >
        返回首页
      </Button>
    </div>
  )
}
