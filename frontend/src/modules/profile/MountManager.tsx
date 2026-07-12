import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FolderOpen,
  HardDrive,
  Globe,
  Link,
  Pencil,
  Plus,
  Server,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { InputNumber } from '@/components/ui/InputNumber'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import {
  createUserMount,
  deleteUserMount,
  getUserMounts,
  testUserMount,
  updateUserMount,
  type MountFormPayload,
  type MountType,
  type UserMount,
} from './mountApi'
import MountBrowserModal from './MountBrowserModal'

const TYPE_OPTIONS = [
  { label: 'WebDAV', value: 'webdav' },
  { label: 'FTP', value: 'ftp' },
  { label: 'OpenList', value: 'openlist' },
]

const TYPE_LABELS: Record<MountType, string> = {
  webdav: 'WebDAV',
  ftp: 'FTP',
  openlist: 'OpenList',
}

const TYPE_COLORS: Record<MountType, 'primary' | 'warning' | 'success'> = {
  webdav: 'primary',
  ftp: 'warning',
  openlist: 'success',
}

const TYPE_ICONS: Record<MountType, React.ReactNode> = {
  webdav: <Server className="h-4 w-4" />,
  ftp: <HardDrive className="h-4 w-4" />,
  openlist: <Globe className="h-4 w-4" />,
}

interface FormValues {
  type: MountType
  name: string
  serverUrl: string
  port: string
  path: string
  username: string
  password: string
  indexUrl: string
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
  indexUrl: '',
  directLink: false,
}

function mountToFormValues(mount: UserMount): FormValues {
  return {
    type: mount.type,
    name: mount.name,
    serverUrl: mount.serverUrl || '',
    port: mount.port ? String(mount.port) : '',
    path: mount.path || '',
    username: mount.username || '',
    password: '',
    indexUrl: mount.indexUrl || '',
    directLink: mount.directLink,
  }
}

function formValuesToPayload(values: FormValues): MountFormPayload {
  const portNum = values.port.trim() ? Number(values.port.trim()) : null
  return {
    type: values.type,
    name: values.name.trim(),
    serverUrl: values.serverUrl.trim() || null,
    port: portNum !== null && Number.isFinite(portNum) ? portNum : null,
    path: values.path.trim() || null,
    username: values.username.trim() || null,
    password: values.password || null,
    indexUrl: values.indexUrl.trim() || null,
    directLink: values.directLink,
  }
}

function validateForm(values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}

  if (!values.name.trim()) {
    errors.name = '挂载名称不能为空'
  }

  if (values.type === 'webdav' || values.type === 'ftp') {
    if (!values.serverUrl.trim()) {
      errors.serverUrl = '服务器地址不能为空'
    }
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

  if (values.type === 'openlist') {
    if (!values.indexUrl.trim()) {
      errors.indexUrl = '索引 URL 不能为空'
    } else {
      try {
        new URL(values.indexUrl.trim())
      } catch {
        errors.indexUrl = '请输入有效的 URL'
      }
    }
  }

  return errors
}

export default function MountManager() {
  const [mounts, setMounts] = useState<UserMount[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingMount, setEditingMount] = useState<UserMount | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formValues, setFormValues] = useState<FormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<UserMount | null>(null)
  const [browsingMount, setBrowsingMount] = useState<UserMount | null>(null)
  const [testing, setTesting] = useState(false)

  const loadMounts = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getUserMounts()
      setMounts(data)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取挂载列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMounts()
  }, [loadMounts])

  const openAddModal = useCallback(() => {
    setEditingMount(null)
    setFormValues(EMPTY_FORM)
    setErrors({})
    setSubmitError('')
    setModalOpen(true)
  }, [])

  const openEditModal = useCallback((mount: UserMount) => {
    setEditingMount(mount)
    setFormValues(mountToFormValues(mount))
    setErrors({})
    setSubmitError('')
    setModalOpen(true)
  }, [])

  const closeModal = useCallback(() => {
    setModalOpen(false)
  }, [])

  const updateField = useCallback(
    <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
      setFormValues((prev) => {
        const next = { ...prev, [key]: value }
        // 切换类型时清空该类型无关字段的校验错误
        if (key === 'type') {
          setErrors({})
        }
        return next
      })
    },
    []
  )

  const handleSubmit = useCallback(async () => {
    const validationErrors = validateForm(formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setSubmitError('')
    setSubmitting(true)
    try {
      const payload = formValuesToPayload(formValues)
      if (editingMount) {
        await updateUserMount(editingMount.id, payload)
        message.success('挂载更新成功')
      } else {
        await createUserMount(payload)
        message.success('挂载添加成功')
      }
      await loadMounts()
      closeModal()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存挂载失败'
      setSubmitError(msg)
      message.error(msg)
    } finally {
      setSubmitting(false)
    }
  }, [formValues, editingMount, loadMounts, closeModal])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteUserMount(deleteTarget.id)
      message.success('挂载已删除')
      await loadMounts()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除挂载失败')
    } finally {
      setDeleteTarget(null)
    }
  }, [deleteTarget, loadMounts])

  const handleTest = useCallback(async () => {
    const validationErrors = validateForm(formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setTesting(true)
    try {
      const payload = formValuesToPayload(formValues)
      await testUserMount(payload, editingMount?.id)
      message.success('连接成功')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }, [formValues, editingMount])

  const showServerFields =
    formValues.type === 'webdav' || formValues.type === 'ftp'
  const showOpenListFields = formValues.type === 'openlist'
  const isFtp = formValues.type === 'ftp'

  const modalTitle = editingMount ? '编辑挂载' : '添加挂载'

  const renderMountItem = useCallback(
    (mount: UserMount) => {
      const subtitle =
        mount.type === 'openlist'
          ? mount.indexUrl
          : [mount.serverUrl, mount.path].filter(Boolean).join(' / ') || null

      return (
        <div
          key={mount.id}
          className="flex items-start gap-3 rounded-[var(--md-sys-shape-corner)] border p-3 transition-colors"
          style={{
            borderColor: 'var(--md-sys-color-outline)',
            backgroundColor: 'var(--md-sys-color-surface-container)',
          }}
        >
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            {TYPE_ICONS[mount.type]}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Tag color={TYPE_COLORS[mount.type]}>
                {TYPE_LABELS[mount.type]}
              </Tag>
              <Text className="truncate text-sm font-medium">{mount.name}</Text>
            </div>
            {subtitle && (
              <div className="flex items-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                <Link className="h-3 w-3 shrink-0" />
                <span className="truncate">{subtitle}</span>
              </div>
            )}
            {mount.type === 'openlist' && (
              <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                播放模式：{mount.directLink ? '直链' : '转发'}
              </div>
            )}
            {mount.username && mount.type !== 'openlist' && (
              <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                用户：{mount.username}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderOpen className="h-4 w-4" />}
              onClick={() => setBrowsingMount(mount)}
            >
              浏览
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => openEditModal(mount)}
            >
              编辑
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => setDeleteTarget(mount)}
            >
              删除
            </Button>
          </div>
        </div>
      )
    },
    [openEditModal]
  )

  const footer = useMemo(
    () => (
      <>
        <Button variant="secondary" size="sm" onClick={closeModal}>
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
    ),
    [closeModal, handleSubmit, submitting, handleTest, testing]
  )

  return (
    <div
      className="rounded-[var(--md-sys-shape-corner)] border p-4"
      style={{
        borderColor: 'var(--md-sys-color-outline)',
        backgroundColor: 'var(--md-sys-color-surface-container-high)',
      }}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-secondary-container)',
              color: 'var(--md-sys-color-on-secondary-container)',
            }}
          >
            <Server className="h-4 w-4" />
          </div>
          <Text className="text-sm font-medium">我的挂载</Text>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={openAddModal}
        >
          添加挂载
        </Button>
      </div>

      {loading && mounts.length === 0 ? (
        <div className="py-6">
          <Spinner tip="加载挂载列表..." size={28} />
        </div>
      ) : mounts.length === 0 ? (
        <div className="py-6 text-center">
          <Text type="secondary" className="text-sm">
            暂无保存的挂载配置
          </Text>
        </div>
      ) : (
        <div className="space-y-3">{mounts.map(renderMountItem)}</div>
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={modalTitle}
        footer={footer}
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

          {showServerFields && (
            <>
              <Input
                label="服务器地址"
                placeholder={
                  formValues.type === 'webdav'
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
                    updateField(
                      'port',
                      value !== undefined ? String(value) : ''
                    )
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
            </>
          )}

          {showOpenListFields && (
            <>
              <Input
                label="索引 URL"
                placeholder="例如：https://example.com/openlist.json"
                value={formValues.indexUrl}
                onChange={(e) => updateField('indexUrl', e.target.value)}
                error={errors.indexUrl}
              />
              <Switch
                label="使用直链播放（不经过服务端转发）"
                checked={formValues.directLink}
                onChange={(e) => updateField('directLink', e.target.checked)}
              />
            </>
          )}
          {submitError && (
            <div className="rounded border border-[var(--md-sys-color-error)] bg-[var(--md-sys-color-error-container)] px-3 py-2 text-xs text-[var(--md-sys-color-on-error-container)]">
              {submitError}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
        onOk={handleDelete}
        okText="删除"
        cancelText="取消"
      >
        确定要删除挂载「{deleteTarget?.name}」吗？删除后不可恢复。
      </ConfirmModal>

      <MountBrowserModal
        mount={browsingMount}
        open={!!browsingMount}
        onClose={() => setBrowsingMount(null)}
      />
    </div>
  )
}
