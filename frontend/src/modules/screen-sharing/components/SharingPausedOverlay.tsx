import { Paragraph } from '@/components/ui/Typography'

interface SharingPausedOverlayProps {
  visible: boolean
}

export function SharingPausedOverlay({
  visible,
}: SharingPausedOverlayProps): JSX.Element | null {
  if (!visible) return null

  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
      <Paragraph className="m-0 text-white">
        共享已暂停，观众画面将冻结
      </Paragraph>
    </div>
  )
}
