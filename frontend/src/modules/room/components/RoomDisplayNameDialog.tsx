import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { t } from '@/i18n'
import { DISPLAY_NAME_MAX, isValidDisplayName } from '@/modules/room/lib/displayName'
import { useRoomDisplayName } from '@/modules/room/hooks/useRoomDisplayName'

interface RoomDisplayNameDialogProps {
  roomId: string
  /** 房间还没进入/已离开时禁用，避免在错误的房间弹框 */
  disabled?: boolean
}

/**
 * 游客首次进入房间时的昵称设置框。
 *
 * 默认填好「游客XXXX」，可以直接点「使用默认」或改完保存；
 * 保存后本房间内所有展示（成员列表 / 评论 / 语音）都用这个名字。
 * 登录账号默认用账号名，不弹此框。
 */
export function RoomDisplayNameDialog({ roomId, disabled = false }: RoomDisplayNameDialogProps) {
  const { name, fresh, isGuest, rename, markSeen } = useRoomDisplayName(roomId)
  const [value, setValue] = useState(name)
  const [error, setError] = useState('')

  const open = !disabled && Boolean(roomId) && isGuest && fresh

  useEffect(() => {
    if (!open) return
    setValue(name)
    setError('')
    // eslint-disable-next-line react-hooks/set-state-in-effect
  }, [open, name])

  const handleSave = () => {
    const trimmed = value.trim()
    if (!isValidDisplayName(trimmed)) {
      setError(t('昵称需为 1~20 个字符'))
      return
    }
    if (!rename(trimmed)) {
      setError(t('昵称需为 1~20 个字符'))
      return
    }
    markSeen()
  }

  return (
    <Modal open={open} onClose={markSeen} title={t('设置本房间昵称')}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
          {t('昵称会显示在成员列表、评论区与语音中，仅对当前房间生效。')}
        </p>
        <Input
          value={value}
          maxLength={DISPLAY_NAME_MAX}
          autoFocus
          placeholder={t('请输入昵称')}
          error={error}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              handleSave()
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={markSeen}>
            {t('使用默认昵称')}
          </Button>
          <Button variant="primary" onClick={handleSave}>
            {t('保存')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
