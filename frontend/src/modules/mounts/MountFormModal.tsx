// 统一挂载表单：按挂载类型渲染对应模块的表单字段
// 调用各模块独立的 create/update/test API
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { InputNumber } from '@/components/ui/InputNumber'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { message } from '@/components/ui/message'
import {
  createWebDAVMount,
  updateWebDAVMount,
  testWebDAVMount,
} from '@/modules/webdav/webdavApi'
import {
  createOpenListMount,
  updateOpenListMount,
  testOpenListMount,
} from '@/modules/openlist/openlistApi'
import {
  createFTPMount,
  updateFTPMount,
  testFTPMount,
} from '@/modules/ftp/ftpApi'
import type { UnionMount, MountType } from './types'

interface MountFormModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  // 编辑模式时传入的挂载对象；新增模式为 null
  editingMount: UnionMount | null
  // 新增模式时的初始类型
  initialType?: MountType
}

interface FormValues {
  type: MountType
  name: string
  serverUrl: string
  port: string
  path: string
  username: string
  password: string
  directLink: boolean
}

const EMPTY_FORM: FormValues = {
  type: 'webdav',
  name: '',
  serverUrl: '',
  port: '',
  path: '',
  username: '',
  password: '',
  directLink: false,
}

function mountToFormValues(mount: UnionMount): FormValues {
  return {
    type: mount.type,
    name: mount.name,
    serverUrl: mount.serverUrl || '',
    port: mount.port ? String(mount.port) : '',
    path: mount.path || '',
    username: mount.username || '',
    password: '',
    directLink: mount.directLink,
  }
}

function validateForm(values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!values.name.trim()) {
    errors.name = '挂载名称不能为空'
  }
  if (!values.serverUrl.trim()) {
    errors.serverUrl = '服务器地址不能为空'
  }
  if (values.type === 'ftp') {
    if (!values.port.trim()) {
      errors.port = '端口不能为空'
    } else {
      const portNum = Number(values.port.trim())
      if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
        errors.port = '请输入 1-65535 之间的端口'
      }
    }
  }
  return errors
}

const TYPE_OPTIONS = [
  { label: 'WebDAV', value: 'webdav' as MountType },
  { label: 'FTP', value: 'ftp' as MountType },
  { label: 'OpenList', value: 'openlist' as MountType },
]

export default function MountFormModal({
  open,
  onClose,
  onSuccess,
  editingMount,
  initialType = 'webdav',
}: MountFormModalProps) {
  const [formValues, setFormValues] = useState<FormValues>({
    ...EMPTY_FORM,
    type: initialType,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)

  // 打开时重置表单
  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect -- 打开时根据 editingMount 重置表单 */
      if (editingMount) {
        setFormValues(mountToFormValues(editingMount))
      } else {
        setFormValues({ ...EMPTY_FORM, type: initialType })
      }
      setErrors({})
      setSubmitError('')
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, editingMount, initialType])

  const updateField = <K extends keyof FormValues>(
    key: K,
    value: FormValues[K]
  ) => {
    setFormValues((prev) => {
      const next = { ...prev, [key]: value }
      // 切换类型时清空校验错误
      if (key === 'type') {
        setErrors({})
      }
      return next
    })
  }

  const handleTest = async () => {
    const validationErrors = validateForm(formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setTesting(true)
    try {
      const { type, serverUrl, path, username, password, port } = formValues
      const trimmedUrl = serverUrl.trim()
      const trimmedPath = path.trim() || '/'
      const trimmedUser = username.trim() || undefined
      const trimmedPwd = password || undefined

      if (type === 'webdav') {
        const result = await testWebDAVMount({
          serverUrl: trimmedUrl,
          path: trimmedPath,
          username: trimmedUser,
          password: trimmedPwd,
        })
        message.success(`连接成功，共 ${result.itemCount} 条目`)
      } else if (type === 'openlist') {
        const result = await testOpenListMount({
          serverUrl: trimmedUrl,
          path: trimmedPath,
          username: trimmedUser,
          password: trimmedPwd,
        })
        message.success(`连接成功，共 ${result.itemCount} 条目`)
      } else {
        const portNum = port.trim() ? Number(port.trim()) : undefined
        const result = await testFTPMount({
          serverUrl: trimmedUrl,
          path: trimmedPath,
          port: portNum,
          username: trimmedUser,
          password: trimmedPwd,
        })
        message.success(`连接成功，共 ${result.itemCount} 条目`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async () => {
    const validationErrors = validateForm(formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setSubmitError('')
    setSubmitting(true)
    try {
      const {
        type,
        name,
        serverUrl,
        port,
        path,
        username,
        password,
        directLink,
      } = formValues
      const portNum = port.trim() ? Number(port.trim()) : null

      if (type === 'webdav') {
        const payload = {
          type: 'webdav' as const,
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          port: portNum !== null && Number.isFinite(portNum) ? portNum : null,
          path: path.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        if (editingMount) {
          await updateWebDAVMount(editingMount.id, payload)
          message.success('WebDAV 挂载更新成功')
        } else {
          await createWebDAVMount(payload)
          message.success('WebDAV 挂载添加成功')
        }
      } else if (type === 'openlist') {
        const payload = {
          type: 'openlist' as const,
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          path: path.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        if (editingMount) {
          await updateOpenListMount(editingMount.id, payload)
          message.success('OpenList 挂载更新成功')
        } else {
          await createOpenListMount(payload)
          message.success('OpenList 挂载添加成功')
        }
      } else {
        const payload = {
          type: 'ftp' as const,
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          port: portNum !== null && Number.isFinite(portNum) ? portNum : null,
          path: path.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink: false,
        }
        if (editingMount) {
          await updateFTPMount(editingMount.id, payload)
          message.success('FTP 挂载更新成功')
        } else {
          await createFTPMount(payload)
          message.success('FTP 挂载添加成功')
        }
      }

      onSuccess()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存挂载失败'
      setSubmitError(msg)
      message.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const modalTitle = editingMount ? '编辑挂载' : '添加挂载'
  const isFtp = formValues.type === 'ftp'
  const isWebdav = formValues.type === 'webdav'
  const isOpenlist = formValues.type === 'openlist'
  const showDirectLink = isWebdav || isOpenlist

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={modalTitle}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={testing}
            onClick={handleTest}
          >
            测试连接
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={submitting}
            onClick={handleSubmit}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label="挂载类型"
          options={TYPE_OPTIONS}
          value={formValues.type}
          disabled={!!editingMount}
          onChange={(value) => updateField('type', value as MountType)}
        />
        <Input
          label="挂载名称"
          placeholder="例如：家庭 NAS"
          value={formValues.name}
          onChange={(e) => updateField('name', e.target.value)}
          error={errors.name}
        />
        <Input
          label="服务器地址"
          placeholder={
            isOpenlist
              ? '例如：openlist.example.com（无需填 /dav，自动补全）'
              : isWebdav
                ? '例如：https://dav.example.com'
                : '例如：ftp.example.com'
          }
          value={formValues.serverUrl}
          onChange={(e) => updateField('serverUrl', e.target.value)}
          error={errors.serverUrl}
        />
        {isFtp && (
          <InputNumber
            label="端口"
            placeholder="例如：21"
            min={1}
            max={65535}
            value={formValues.port ? Number(formValues.port) : undefined}
            onChange={(value) =>
              updateField('port', value !== undefined ? String(value) : '')
            }
            error={errors.port}
          />
        )}
        <Input
          label="路径"
          placeholder="例如：/videos"
          value={formValues.path}
          onChange={(e) => updateField('path', e.target.value)}
        />
        <Input
          label="用户名"
          placeholder="可选"
          value={formValues.username}
          onChange={(e) => updateField('username', e.target.value)}
        />
        <InputPassword
          label="密码"
          placeholder={editingMount ? '留空将清空原密码' : '可选'}
          value={formValues.password}
          onChange={(e) => updateField('password', e.target.value)}
        />
        {showDirectLink && (
          <Switch
            label="使用直链播放（不经过服务端转发）"
            checked={formValues.directLink}
            onChange={(e) => updateField('directLink', e.target.checked)}
          />
        )}
        {submitError && (
          <div className="rounded border border-[var(--md-sys-color-error)] bg-[var(--md-sys-color-error-container)] px-3 py-2 text-xs text-[var(--md-sys-color-on-error-container)]">
            {submitError}
          </div>
        )}
      </div>
    </Modal>
  )
}
