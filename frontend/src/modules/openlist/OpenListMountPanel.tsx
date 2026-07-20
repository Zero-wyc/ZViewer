/**
 * OpenList 挂载管理面板
 *
 * OpenList 通过 WebDAV 协议访问（端点默认 `/dav`），表单结构与 WebDAVMountPanel 对齐。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Globe, Link, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import {
  createOpenListMount,
  deleteOpenListMount,
  getOpenListMounts,
  testOpenListMount,
  updateOpenListMount,
} from './openlistApi'
import type { OpenListMount } from './types'
import OpenListBrowser from './OpenListBrowser'

interface FormValues {
  name: string
  serverUrl: string
  path: string
  username: string
  password: string
  directLink: boolean
}

const EMPTY_FORM: FormValues = {
  name: '',
  serverUrl: '',
  path: '',
  username: '',
  password: '',
  directLink: false,
}

function mountToFormValues(mount: OpenListMount): FormValues {
  return {
    name: mount.name,
    serverUrl: mount.serverUrl || '',
    path: mount.path || '',
    username: mount.username || '',
    password: '',
    directLink: mount.directLink,
  }
}

function formValuesToPayload(values: FormValues) {
  return {
    type: 'openlist' as const,
    name: values.name.trim(),
    serverUrl: values.serverUrl.trim() || null,
    path: values.path.trim() || null,
    username: values.username.trim() || null,
    password: values.password || null,
    directLink: values.directLink,
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
  return errors
}

export default function OpenListMountPanel() {
  const [mounts, setMounts] = useState<OpenListMount[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingMount, setEditingMount] = useState<OpenListMount | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formValues, setFormValues] = useState<FormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<OpenListMount | null>(null)
  const [browsingMount, setBrowsingMount] = useState<OpenListMount | null>(null)
  const [testing, setTesting] = useState(false)

  const loadMounts = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getOpenListMounts()
      setMounts(data)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : '获取 OpenList 挂载列表失败'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初始化加载挂载列表
    void loadMounts()
  }, [loadMounts])

  const openAddModal = useCallback(() => {
    setEditingMount(null)
    setFormValues(EMPTY_FORM)
    setErrors({})
    setSubmitError('')
    setModalOpen(true)
  }, [])

  const openEditModal = useCallback((mount: OpenListMount) => {
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
      setFormValues((prev) => ({ ...prev, [key]: value }))
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
        await updateOpenListMount(editingMount.id, payload)
        message.success('OpenList 挂载更新成功')
      } else {
        await createOpenListMount(payload)
        message.success('OpenList 挂载添加成功')
      }
      await loadMounts()
      closeModal()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存 OpenList 挂载失败'
      setSubmitError(msg)
      message.error(msg)
    } finally {
      setSubmitting(false)
    }
  }, [formValues, editingMount, loadMounts, closeModal])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteOpenListMount(deleteTarget.id)
      message.success('OpenList 挂载已删除')
      await loadMounts()
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : '删除 OpenList 挂载失败'
      )
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
      const result = await testOpenListMount({
        serverUrl: formValues.serverUrl.trim(),
        path: formValues.path.trim() || '/',
        username: formValues.username.trim() || undefined,
        password: formValues.password || undefined,
      })
      message.success(`连接成功，共 ${result.itemCount} 条目`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }, [formValues])

  const modalTitle = editingMount ? '编辑 OpenList 挂载' : '添加 OpenList 挂载'

  const renderMountItem = useCallback(
    (mount: OpenListMount) => {
      const subtitle =
        [mount.serverUrl, mount.path].filter(Boolean).join(' / ') || null

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
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Tag color="success">OpenList</Tag>
              <Text className="truncate text-sm font-medium">{mount.name}</Text>
            </div>
            {subtitle && (
              <div className="flex items-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                <Link className="h-3 w-3 shrink-0" />
                <span className="truncate">{subtitle}</span>
              </div>
            )}
            <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              播放模式：{mount.directLink ? '直链' : '转发'}
            </div>
            {mount.username && (
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
            <Globe className="h-4 w-4" />
          </div>
          <Text className="text-sm font-medium">OpenList 挂载</Text>
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
          <Spinner tip="加载 OpenList 挂载列表..." size={28} />
        </div>
      ) : mounts.length === 0 ? (
        <div className="py-6 text-center">
          <Text type="secondary" className="text-sm">
            暂无保存的 OpenList 挂载配置
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
          <Input
            label="挂载名称"
            placeholder="例如：家庭 OpenList"
            value={formValues.name}
            onChange={(e) => updateField('name', e.target.value)}
            error={errors.name}
          />
          <Input
            label="服务器地址"
            placeholder="例如：http://example.com/dav"
            value={formValues.serverUrl}
            onChange={(e) => updateField('serverUrl', e.target.value)}
            error={errors.serverUrl}
          />
          <Input
            label="路径"
            placeholder="可选，例如：/videos"
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
            placeholder={editingMount ? '留空表示不修改原密码' : '可选'}
            value={formValues.password}
            onChange={(e) => updateField('password', e.target.value)}
          />
          <Switch
            label="使用直链播放（不经过服务端转发）"
            checked={formValues.directLink}
            onChange={(e) => updateField('directLink', e.target.checked)}
          />
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
        确定要删除 OpenList 挂载「{deleteTarget?.name}」吗？删除后不可恢复。
      </ConfirmModal>

      <OpenListBrowser
        mountId={browsingMount?.id ?? null}
        open={!!browsingMount}
        onClose={() => setBrowsingMount(null)}
      />
    </div>
  )
}
