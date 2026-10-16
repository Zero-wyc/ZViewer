// 统一挂载管理组件（个人中心使用）
// 聚合展示 webdav/openlist/ftp 三种挂载，添加/编辑/浏览分别委托给各模块独立组件
import { useCallback, useEffect, useState } from 'react'
import {
  FolderOpen,
  Globe,
  HardDrive,
  Link,
  Pencil,
  Plus,
  Server,
  Trash2,
  Clapperboard,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { deleteWebDAVMount } from '@/modules/webdav/webdavApi'
import { deleteOpenListMount } from '@/modules/openlist/openlistApi'
import { deleteFTPMount } from '@/modules/ftp/ftpApi'
import { deleteEmbyMount } from '@/modules/emby/embyApi'
import { deleteJellyfinMount } from '@/modules/jellyfin/jellyfinApi'
import { fetchAllMounts } from './mountsApi'
import MountFormModal from './MountFormModal'
import MountBrowser from './MountBrowser'
import type { UnionMount, MountType } from './types'

const TYPE_LABELS: Record<MountType, string> = {
  webdav: 'WebDAV',
  ftp: 'FTP',
  openlist: 'OpenList',
  emby: 'Emby',
  jellyfin: 'Jellyfin',
}

const TYPE_COLORS: Record<MountType, 'primary' | 'warning' | 'success'> = {
  webdav: 'primary',
  ftp: 'warning',
  openlist: 'success',
  emby: 'primary',
  jellyfin: 'primary',
}

const TYPE_ICONS: Record<MountType, React.ReactNode> = {
  webdav: <Server className="h-4 w-4" />,
  ftp: <HardDrive className="h-4 w-4" />,
  openlist: <Globe className="h-4 w-4" />,
  emby: <Clapperboard className="h-4 w-4" />,
  jellyfin: <Clapperboard className="h-4 w-4" />,
}

export default function MountManager() {
  const [mounts, setMounts] = useState<UnionMount[]>([])
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editingMount, setEditingMount] = useState<UnionMount | null>(null)
  const [initialType, setInitialType] = useState<MountType>('webdav')
  const [deleteTarget, setDeleteTarget] = useState<UnionMount | null>(null)
  const [browsingMount, setBrowsingMount] = useState<UnionMount | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadMounts = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAllMounts()
      setMounts(data)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取挂载列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初始化加载挂载列表
    void loadMounts()
  }, [loadMounts])

  const openAddModal = (type: MountType = 'webdav') => {
    setEditingMount(null)
    setInitialType(type)
    setFormOpen(true)
  }

  const openEditModal = (mount: UnionMount) => {
    setEditingMount(mount)
    setFormOpen(true)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.type === 'webdav') {
        await deleteWebDAVMount(deleteTarget.id)
      } else if (deleteTarget.type === 'openlist') {
        await deleteOpenListMount(deleteTarget.id)
      } else if (deleteTarget.type === 'emby') {
        await deleteEmbyMount(deleteTarget.id)
      } else if (deleteTarget.type === 'jellyfin') {
        await deleteJellyfinMount(deleteTarget.id)
      } else {
        await deleteFTPMount(deleteTarget.id)
      }
      message.success('挂载已删除')
      await loadMounts()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除挂载失败')
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div className="glass-card p-4">
      <SectionHeader
        icon={<Server className="h-4 w-4" />}
        title="我的挂载"
        tone="secondary"
        className="mb-4"
        extra={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => openAddModal('webdav')}
          >
            添加挂载
          </Button>
        }
      />

      {loading && mounts.length === 0 ? (
        <div className="py-6">
          <Spinner tip="加载挂载列表..." size={28} />
        </div>
      ) : mounts.length === 0 ? (
        <EmptyState text="暂无保存的挂载配置" />
      ) : (
        <div className="space-y-3">
          {mounts.map((mount) => {
            const subtitle =
              [mount.serverUrl, 'path' in mount ? mount.path : null]
                .filter(Boolean)
                .join(' / ') || null
            return (
              <div
                key={`${mount.type}-${mount.id}`}
                className="glass flex items-start gap-3 rounded-[var(--md-sys-shape-corner)] p-3 transition-colors"
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
                    <Text className="truncate text-sm font-medium">
                      {mount.name}
                    </Text>
                  </div>
                  {subtitle && (
                    <div className="flex items-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      <Link className="h-3 w-3 shrink-0" />
                      <span className="truncate">{subtitle}</span>
                    </div>
                  )}
                  {'port' in mount && mount.port && (
                    <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      端口：{mount.port}
                    </div>
                  )}
                  {(mount.type === 'openlist' ||
                    mount.type === 'webdav' ||
                    mount.type === 'emby' ||
                    mount.type === 'jellyfin') && (
                    <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      播放模式：{mount.directLink ? '直链' : '转发'}
                    </div>
                  )}
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
          })}
        </div>
      )}

      <MountFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={loadMounts}
        editingMount={editingMount}
        initialType={initialType}
      />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
        onOk={handleDelete}
        okText={deleting ? '删除中...' : '删除'}
        cancelText="取消"
      >
        确定要删除挂载「{deleteTarget?.name}」吗？删除后不可恢复。
      </ConfirmModal>

      <MountBrowser
        mount={browsingMount}
        open={!!browsingMount}
        onClose={() => setBrowsingMount(null)}
      />
    </div>
  )
}
