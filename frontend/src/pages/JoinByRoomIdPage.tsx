import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'

export default function JoinByRoomIdPage() {
  const navigate = useNavigate()
  const [roomIdInput, setRoomIdInput] = useState('')

  const handleJoin = () => {
    const trimmed = roomIdInput.trim()
    if (!trimmed) return
    navigate(`/room/${trimmed}`)
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="relative w-full max-w-md text-center">
        <PageBackButton to="/" />

        {/* 顶部留白，避免内容与返回按钮重叠 */}
        <div className="pt-8">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            <LogIn className="h-6 w-6" />
          </div>
          <Title level={3} className="m-0">
            加入房间
          </Title>
          <Paragraph type="secondary" className="mt-2">
            输入房主分享的房间号
          </Paragraph>

          <div className="mt-6 flex w-full gap-2">
            <Input
              size="lg"
              placeholder="输入房间号"
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJoin()
              }}
              maxLength={64}
              autoFocus
            />
            <Button
              variant="secondary"
              size="lg"
              icon={<LogIn className="h-5 w-5 shrink-0" />}
              onClick={handleJoin}
              disabled={!roomIdInput.trim()}
              className="shrink-0 whitespace-nowrap"
            >
              加入
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
