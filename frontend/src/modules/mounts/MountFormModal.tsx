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
import {
  createEmbyMount,
  updateEmbyMount,
  testEmbyMount,
} from '@/modules/emby/embyApi'
import {
  createJellyfinMount,
  updateJellyfinMount,
  testJellyfinMount,
} from '@/modules/jellyfin/jellyfinApi'
import { isInternalOpenListServer } from '@/modules/openlist/isInternal'
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
  apiKey: string
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
  apiKey: '',
  directLink: false,
}

function mountToFormValues(mount: UnionMount): FormValues {
  return {
    type: mount.type,
    name: mount.name,
    serverUrl: mount.serverUrl || '',
    port: 'port' in mount && mount.port ? String(mount.port) : '',
    path: 'path' in mount && mount.path ? mount.path || '' : '',
    username: mount.username || '',
    password: '',
    apiKey: 'apiKey' in mount ? mount.apiKey || '' : '',
    directLink: 'directLink' in mount ? mount.directLink : false,
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
  if (values.type === 'emby') {
    if (
      !values.apiKey.trim() &&
      (!values.username.trim() || !values.password)
    ) {
      errors.apiKey = '请填写 API Key，或用户名与密码'
    }
  }
  return errors
}

const TYPE_OPTIONS = [
  { label: 'WebDAV', value: 'webdav' as MountType },
  { label: 'FTP', value: 'ftp' as MountType },
  { label: 'OpenList', value: 'openlist' as MountType },
  { label: 'Emby', value: 'emby' as MountType },
  { label: 'Jellyfin', value: 'jellyfin' as MountType },
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

      if (type === 'webdav' || type === 'openlist') {
        // WebDAV 与 OpenList 共用同一套协议与表单，仅 API 前缀不同
        const params = {
          serverUrl: trimmedUrl,
          path: trimmedPath,
          username: trimmedUser,
          password: trimmedPwd,
        }
        const result =
          type === 'webdav'
            ? await testWebDAVMount(params)
            : await testOpenListMount(params)
        message.success(`连接成功，共 ${result.itemCount} 条目`)
      } else if (type === 'emby') {
        const result = await testEmbyMount({
          name: formValues.name.trim(),
          serverUrl: trimmedUrl,
          apiKey: formValues.apiKey.trim() || null,
          username: trimmedUser,
          password: trimmedPwd,
          directLink: formValues.directLink,
        })
        message.success(
          `连接成功${result.userName ? `，用户：${result.userName}` : ''}`
        )
      } else if (type === 'jellyfin') {
        const result = await testJellyfinMount({
          name: formValues.name.trim(),
          serverUrl: trimmedUrl,
          apiKey: formValues.apiKey.trim() || null,
          username: trimmedUser,
          password: trimmedPwd,
          directLink: formValues.directLink,
        })
        message.success(
          `连接成功${result.userName ? `，用户：${result.userName}` : ''}`
        )
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
        apiKey,
        directLink,
      } = formValues
      const portNum = port.trim() ? Number(port.trim()) : null

      if (type === 'webdav' || type === 'openlist') {
        // WebDAV 与 OpenList 共用同一套协议与表单，仅 API 前缀与 type 不同
        const payload = {
          type: type as 'webdav' | 'openlist',
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          path: path.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        const label = type === 'webdav' ? 'WebDAV' : 'OpenList'
        if (editingMount) {
          const saved =
            type === 'webdav'
              ? await updateWebDAVMount(editingMount.id, {
                  ...payload,
                  type: 'webdav',
                  port:
                    portNum !== null && Number.isFinite(portNum)
                      ? portNum
                      : null,
                })
              : await updateOpenListMount(editingMount.id, payload)
          message.success(`${label} 挂载更新成功`)
          if (saved.warning) message.warning(saved.warning)
        } else {
          const saved =
            type === 'webdav'
              ? await createWebDAVMount({
                  ...payload,
                  type: 'webdav',
                  port:
                    portNum !== null && Number.isFinite(portNum)
                      ? portNum
                      : null,
                })
              : await createOpenListMount(payload)
          message.success(`${label} 挂载添加成功`)
          if (saved.warning) message.warning(saved.warning)
        }
      } else if (type === 'emby') {
        const payload = {
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          apiKey: apiKey.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        if (editingMount) {
          const saved = await updateEmbyMount(editingMount.id, payload)
          message.success('Emby 挂载更新成功')
          if (saved.warning) message.warning(saved.warning)
        } else {
          const saved = await createEmbyMount(payload)
          message.success('Emby 挂载添加成功')
          if (saved.warning) message.warning(saved.warning)
        }
      } else if (type === 'jellyfin') {
        const payload = {
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          apiKey: apiKey.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        if (editingMount) {
          const saved = await updateJellyfinMount(editingMount.id, payload)
          message.success('Jellyfin 挂载更新成功')
          if (saved.warning) message.warning(saved.warning)
        } else {
          const saved = await createJellyfinMount(payload)
          message.success('Jellyfin 挂载添加成功')
          if (saved.warning) message.warning(saved.warning)
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
  const isEmby = formValues.type === 'emby'
  const showDirectLink = isWebdav || isOpenlist || isEmby
  const isWebdavOrOpenlistInternal =
    (isWebdav || isOpenlist) && isInternalOpenListServer(formValues.serverUrl)

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
            isEmby
              ? '例如：http://192.168.1.100:8096'
              : isOpenlist
                ? '例如：openlist.example.com（无需填 /dav，自动补全）'
                : isWebdav
                  ? '例如：https://dav.example.com'
                  : '例如：ftp.example.com'
          }
          value={formValues.serverUrl}
          onChange={(e) => updateField('serverUrl', e.target.value)}
          error={errors.serverUrl}
        />
        {isEmby && (
          <Input
            label="API Key（推荐）"
            placeholder="Emby 控制台 → 高级 → API 密钥"
            value={formValues.apiKey}
            onChange={(e) => updateField('apiKey', e.target.value)}
            error={errors.apiKey}
          />
        )}
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
        {!isEmby && (
          <Input
            label="路径"
            placeholder="例如：/videos"
            value={formValues.path}
            onChange={(e) => updateField('path', e.target.value)}
          />
        )}
        <Input
          label={isEmby ? '用户名（与 API Key 二选一）' : '用户名'}
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
          <>
            <Switch
              label="使用直链播放（不经过服务端转发）"
              checked={
                isWebdavOrOpenlistInternal ? false : formValues.directLink
              }
              disabled={isWebdavOrOpenlistInternal}
              onChange={(e) => updateField('directLink', e.target.checked)}
            />
            {isWebdavOrOpenlistInternal && (
              <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                检测到内网地址，浏览器无法直连，已强制使用服务器转发模式
              </div>
            )}
          </>
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
