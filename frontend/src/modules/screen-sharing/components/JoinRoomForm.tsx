import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Text } from '@/components/ui/Typography'
import { Form } from '@/components/ui/Form'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { ArrowLeft, Eye, Lock } from 'lucide-react'
import type { JoinStatus, JoinFormValues } from '../types'
import { t } from '@/i18n'

interface JoinRoomFormProps {
  /** 初始房间号（来自 URL） */
  initialRoomId: string
  /** 当前加入状态 */
  joinStatus: JoinStatus
  /** 提交表单（房间号 + 密码） */
  onSubmit: (values: JoinFormValues) => void
  /** 返回上一页 */
  onBack: () => void
  /** 隐藏房间号输入框（从房间列表进入，房间号已确定） */
  hideRoomId?: boolean
  /** 房间名称（hideRoomId 模式下展示） */
  roomName?: string
  /** 强制密码模式：从房间列表进入且房间有密码时，密码框变为必填 */
  passwordRequired?: boolean
}

export function JoinRoomForm(props: JoinRoomFormProps): JSX.Element {
  const {
    initialRoomId,
    joinStatus,
    onSubmit,
    onBack,
    hideRoomId = false,
    roomName,
    passwordRequired = false,
  } = props

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="relative w-full max-w-xl text-center">
        <Button
          variant="ghost"
          size="sm"
          disableAnimation
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={onBack}
          className="absolute left-4 top-4"
        >
          {t('返回')}
        </Button>
        <div
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
            color: 'var(--md-sys-color-on-primary-container)',
          }}
        >
          <Lock className="h-6 w-6" />
        </div>
        <Title level={3}>
          {hideRoomId ? t('输入房间密码') : t('加入房间')}
        </Title>
        {hideRoomId && roomName && (
          <Text type="secondary">正在加入：{roomName}</Text>
        )}
        {(joinStatus === 'rejected' || joinStatus === 'closed') && (
          <div
            className="mb-3 rounded px-3 py-2 text-sm"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-error) 12%, transparent)',
              color: 'var(--md-sys-color-error)',
            }}
          >
            {joinStatus === 'rejected'
              ? t('房主已拒绝您的加入申请，可重新申请或更换房间')
              : t('房间已关闭，可尝试重新加入或更换房间')}
          </div>
        )}
        <Form<JoinFormValues>
          onFinish={onSubmit}
          initialValues={{ roomId: initialRoomId, password: '' }}
          className="mt-4 text-left"
        >
          {!hideRoomId && (
            <Form.Item
              label={t('房间号')}
              name="roomId"
              rules={[{ required: true, message: t('请输入房间号') }]}
            >
              <Input size="lg" placeholder={t('请输入要加入的房间号')} />
            </Form.Item>
          )}
          <Form.Item
            label={passwordRequired ? t('房间密码') : t('房间密码（可选）')}
            name="password"
            rules={
              passwordRequired
                ? [{ required: true, message: t('请输入房间密码') }]
                : undefined
            }
          >
            <InputPassword
              size="lg"
              placeholder={
                passwordRequired
                  ? t('请输入房间密码')
                  : t('如房间未设置密码可留空')
              }
              maxLength={32}
            />
          </Form.Item>
          <Form.Item>
            <Button
              variant="primary"
              type="submit"
              size="lg"
              block
              icon={<Eye className="h-5 w-5" />}
            >
              {joinStatus === 'password-required'
                ? t('重新加入')
                : joinStatus === 'rejected'
                  ? t('重新申请加入')
                  : joinStatus === 'closed'
                    ? t('重新加入')
                    : hideRoomId
                      ? t('确认加入')
                      : t('加入观看')}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
