/**
 * 服务器文件管理面板（个人中心使用，仅 root 可见）。
 *
 * 功能：
 * - 支持多个根目录：默认 uploads 空间 + root 自定义挂载的服务器真实目录
 * - 浏览目录、上传文件、新建文件夹、重命名、删除
 * - 添加/删除自定义根目录
 *
 * 文件播放通过房间内 MoviePushPanel 的「服务器文件」源类型完成。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  File,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
  HardDrive,
  RefreshCw,
  Plus,
  Lock,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { EmptyState } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import {
  browseServerFiles,
  uploadServerFiles,
  createFolder,
  renameServerFile,
  deleteServerFile,
  listServerRoots,
  addServerRoot,
  deleteServerRoot,
  browseSystemDirs,
  extractRootKey,
} from './serverFilesApi'
import type { ServerFileEntry, ServerFileRoot, SystemDirEntry } from './types'
import { DirPickerSidePanel } from './DirPickerSidePanel'
import { formatFileSize } from '@/lib/utils'

export default function ServerFileManager() {
  const [entries, setEntries] = useState<ServerFileEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string>('uploads:/')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 根目录列表
  const [roots, setRoots] = useState<ServerFileRoot[]>([])
  const [rootsLoading, setRootsLoading] = useState(false)
  const [rootsMenuOpen, setRootsMenuOpen] = useState(false)
  const [addRootModalOpen, setAddRootModalOpen] = useState(false)
  const [newRootName, setNewRootName] = useState('')
  const [newRootPath, setNewRootPath] = useState('')
  const [newRootReadonly, setNewRootReadonly] = useState(false)
  const [addingRoot, setAddingRoot] = useState(false)
  const [deleteRootTarget, setDeleteRootTarget] =
    useState<ServerFileRoot | null>(null)
  const [deletingRoot, setDeletingRoot] = useState(false)

  // 目录选取器（添加根目录时浏览服务器文件系统）
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  const [dirPickerEntries, setDirPickerEntries] = useState<SystemDirEntry[]>([])
  const [dirPickerPath, setDirPickerPath] = useState('')
  const [dirPickerParent, setDirPickerParent] = useState('')
  const [dirPickerIsRoot, setDirPickerIsRoot] = useState(false)
  const [dirPickerLoading, setDirPickerLoading] = useState(false)
  const [dirPickerError, setDirPickerError] = useState('')

  // 当前根的只读状态（来自 browse 返回）
  const [currentReadonly, setCurrentReadonly] = useState(false)

  // 上传状态
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 新建文件夹
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderCreating, setFolderCreating] = useState(false)

  // 重命名
  const [renameTarget, setRenameTarget] = useState<ServerFileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)

  // 删除
  const [deleteTarget, setDeleteTarget] = useState<ServerFileEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const currentRootKey = extractRootKey(currentPath)
  const currentRoot = roots.find((r) => r.key === currentRootKey)

  const loadRoots = useCallback(async () => {
    setRootsLoading(true)
    try {
      const list = await listServerRoots()
      setRoots(list)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载根目录失败')
    } finally {
      setRootsLoading(false)
    }
  }, [])

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError('')
    try {
      const data = await browseServerFiles(path)
      setEntries(data.entries)
      setCurrentPath(data.currentPath)
      setCurrentReadonly(!!data.readonly)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // React Compiler 严格规则误报：组件挂载时一次性加载服务器文件根目录。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void loadRoots()
  }, [loadRoots])

  // React Compiler 严格规则误报：组件挂载时一次性加载默认 uploads 目录。
  useEffect(() => {
    void load('uploads:/')
  }, [load])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 根目录变化时关闭下拉
  useEffect(() => {
    if (!rootsMenuOpen) return
    const onClick = () => setRootsMenuOpen(false)
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [rootsMenuOpen])

  const handleEntryClick = (entry: ServerFileEntry) => {
    if (entry.type === 'directory') {
      void load(entry.path)
    }
  }

  const handleBack = () => {
    // 在当前根内回退：去掉 'rootKey:/' 后的最后一层
    const match = currentPath.match(/^(uploads|custom:\d+):(.*)$/)
    if (!match) return
    const rootKey = match[1]
    const rel = match[2].replace(/^\/+/, '')
    if (!rel) return
    const parent = rel.split('/').slice(0, -1).join('/')
    void load(`${rootKey}:/${parent}`)
  }

  const handleSwitchRoot = (root: ServerFileRoot) => {
    setRootsMenuOpen(false)
    if (root.key === currentRootKey) return
    if (!root.exists) {
      message.warning('该目录在服务器上不存在')
      return
    }
    void load(`${root.key}:/`)
  }

  // ============ 添加根目录 ============
  const openAddRootModal = () => {
    setNewRootName('')
    setNewRootPath('')
    setNewRootReadonly(false)
    setDirPickerOpen(false)
    setDirPickerError('')
    setAddRootModalOpen(true)
  }

  // 目录选取器：加载指定路径下的子目录
  const loadDirPicker = useCallback(async (absPath?: string) => {
    setDirPickerLoading(true)
    setDirPickerError('')
    try {
      const result = await browseSystemDirs(absPath)
      setDirPickerEntries(result.entries)
      setDirPickerPath(result.currentPath)
      setDirPickerParent(result.parentPath)
      setDirPickerIsRoot(result.isRoot)
    } catch (err) {
      setDirPickerError(err instanceof Error ? err.message : '加载失败')
      setDirPickerEntries([])
    } finally {
      setDirPickerLoading(false)
    }
  }, [])

  // 目录选取器：进入子目录
  const handleDirPickerEnter = (entry: SystemDirEntry) => {
    void loadDirPicker(entry.absPath)
  }

  // 目录选取器：返回上一级
  const handleDirPickerBack = () => {
    if (dirPickerParent) {
      void loadDirPicker(dirPickerParent)
    } else if (!dirPickerIsRoot) {
      // 无父目录但不是系统根，回到系统根
      void loadDirPicker(undefined)
    }
  }

  // 目录选取器：选中当前目录作为根目录路径
  const handleDirPickerSelect = () => {
    if (dirPickerPath) {
      setNewRootPath(dirPickerPath)
      setDirPickerOpen(false)
      // 自动填充名称（如果名称为空）
      if (!newRootName.trim()) {
        const parts = dirPickerPath
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
        const lastPart = parts[parts.length - 1] || dirPickerPath
        setNewRootName(lastPart)
      }
    }
  }

  // 目录选取器：展开/折叠
  const handleDirPickerToggle = () => {
    if (!dirPickerOpen) {
      setDirPickerOpen(true)
      void loadDirPicker(undefined)
    } else {
      setDirPickerOpen(false)
    }
  }

  const handleAddRoot = async () => {
    const name = newRootName.trim()
    const absPath = newRootPath.trim()
    if (!name) {
      message.warning('请输入名称')
      return
    }
    if (!absPath) {
      message.warning('请选择服务器目录')
      return
    }
    setAddingRoot(true)
    try {
      const added = await addServerRoot(name, absPath, newRootReadonly)
      message.success(`已添加根目录「${added.name}」`)
      setAddRootModalOpen(false)
      await loadRoots()
      // 自动切换到新添加的根
      void load(`${added.key}:/`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '添加失败')
    } finally {
      setAddingRoot(false)
    }
  }

  // ============ 删除根目录 ============
  const handleDeleteRoot = async () => {
    if (!deleteRootTarget) return
    setDeletingRoot(true)
    try {
      await deleteServerRoot(deleteRootTarget.key)
      message.success('已移除根目录挂载')
      setDeleteRootTarget(null)
      await loadRoots()
      // 若删除的是当前根，回到 uploads
      if (deleteRootTarget.key === currentRootKey) {
        void load('uploads:/')
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingRoot(false)
    }
  }

  // ============ 上传 ============
  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setUploading(true)
    setUploadProgress(0)
    try {
      await uploadServerFiles(files, currentPath, (loaded, total) => {
        setUploadProgress(total > 0 ? Math.round((loaded / total) * 100) : 0)
      })
      message.success(`已上传 ${files.length} 个文件`)
      void load(currentPath)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
      setUploadProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ============ 新建文件夹 ============
  const openFolderModal = () => {
    setFolderName('')
    setFolderModalOpen(true)
  }

  const handleCreateFolder = async () => {
    const name = folderName.trim()
    if (!name) {
      message.warning('请输入文件夹名称')
      return
    }
    setFolderCreating(true)
    try {
      await createFolder(currentPath, name)
      message.success('文件夹已创建')
      setFolderModalOpen(false)
      void load(currentPath)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '新建文件夹失败')
    } finally {
      setFolderCreating(false)
    }
  }

  // ============ 重命名 ============
  const openRenameModal = (entry: ServerFileEntry) => {
    setRenameTarget(entry)
    setRenameValue(entry.name)
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const newName = renameValue.trim()
    if (!newName || newName === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      await renameServerFile(renameTarget.path, newName)
      message.success('已重命名')
      setRenameTarget(null)
      void load(currentPath)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setRenaming(false)
    }
  }

  // ============ 删除 ============
  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteServerFile(deleteTarget.path)
      message.success('已删除')
      setDeleteTarget(null)
      void load(currentPath)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const readonly = currentReadonly || !!currentRoot?.readonly

  return (
    <div className="glass-card p-4">
      {/* 头部 */}
      <div className="mb-4 flex flex-col gap-3">
        <SectionHeader
          icon={<HardDrive className="h-4 w-4" />}
          title="服务器文件"
          subtitle="SERVER FILES"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => {
              void loadRoots()
              void load(currentPath)
            }}
            disabled={loading || rootsLoading}
          >
            刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="h-4 w-4" />}
            onClick={openAddRootModal}
          >
            添加目录
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderPlus className="h-4 w-4" />}
            onClick={openFolderModal}
            disabled={readonly}
          >
            新建文件夹
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Upload className="h-4 w-4" />}
            onClick={handleUploadClick}
            disabled={uploading || readonly}
          >
            {uploading ? `上传中 ${uploadProgress}%` : '上传文件'}
          </Button>
        </div>
      </div>

      {/* 上传进度条 */}
      {uploading && (
        <div className="mb-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${uploadProgress}%`,
                backgroundColor: 'var(--md-sys-color-primary)',
              }}
            />
          </div>
        </div>
      )}

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {/* 根目录切换器 + 路径栏 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative shrink-0">
          <Button
            variant="secondary"
            size="sm"
            icon={<HardDrive className="h-4 w-4" />}
            onClick={(e) => {
              e.stopPropagation()
              setRootsMenuOpen((v) => !v)
            }}
            disabled={rootsLoading}
          >
            {currentRoot?.name ?? '选择根目录'}
          </Button>
          {rootsMenuOpen && (
            <div
              className="glass absolute left-0 top-full z-30 mt-1 min-w-[260px] max-w-[calc(100vw-2rem)] rounded-[var(--md-sys-shape-corner)] p-1 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2 py-1.5">
                <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  根目录
                </Text>
              </div>
              {roots.map((r) => (
                <div
                  key={r.key}
                  className="group flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                >
                  <button
                    type="button"
                    onClick={() => handleSwitchRoot(r)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={!r.exists}
                  >
                    <HardDrive
                      className="h-3.5 w-3.5 shrink-0"
                      style={{
                        color:
                          r.key === currentRootKey
                            ? 'var(--md-sys-color-primary)'
                            : 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <Text
                        className={
                          'truncate text-xs font-medium ' +
                          (r.key === currentRootKey
                            ? 'text-[var(--md-sys-color-primary)]'
                            : '')
                        }
                      >
                        {r.name}
                        {r.readonly && (
                          <Lock className="ml-1 inline-block h-3 w-3 align-text-bottom" />
                        )}
                      </Text>
                      <Text
                        type="secondary"
                        className="truncate text-[10px]"
                        title={r.absPath}
                      >
                        {r.absPath}
                      </Text>
                    </div>
                    {!r.exists && (
                      <span className="shrink-0 text-[10px] text-[var(--md-sys-color-error)]">
                        不存在
                      </span>
                    )}
                  </button>
                  {r.key !== 'uploads' && (
                    <button
                      type="button"
                      onClick={() => setDeleteRootTarget(r)}
                      className="shrink-0 rounded p-1 text-[var(--md-sys-color-on-surface-variant)] opacity-0 transition-opacity hover:text-[var(--md-sys-color-error)] group-hover:opacity-100"
                      title="移除挂载"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <div className="mt-1 border-t border-[var(--glass-border)] pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setRootsMenuOpen(false)
                    openAddRootModal()
                  }}
                  className="flex w-full items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加服务器目录
                </button>
              </div>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          icon={<ChevronLeft className="h-4 w-4" />}
          onClick={handleBack}
          disabled={
            currentPath === 'uploads:/' ||
            currentPath === 'custom:/' ||
            !currentPath
          }
        >
          返回
        </Button>
        <Text
          className="min-w-0 flex-1 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]"
          title={currentPath}
        >
          {currentPath}
        </Text>
        {readonly && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 15%, transparent)',
              color: 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            <Lock className="h-3 w-3" />
            只读
          </span>
        )}
      </div>

      {/* 文件列表 */}
      {error ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <Text className="text-sm text-[var(--md-sys-color-error)]">
            {error}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load(currentPath)}
          >
            重试
          </Button>
        </div>
      ) : loading && entries.length === 0 ? (
        <div className="py-6">
          <Spinner tip="加载中..." size={28} />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          text={
            readonly ? '当前目录为空' : '当前目录为空，点击上方「上传文件」添加'
          }
        />
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div
              key={entry.path}
              className="glass group flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] p-2.5 transition-all hover:-translate-y-0.5 hover:shadow-sm"
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                onClick={() => handleEntryClick(entry)}
                style={{
                  backgroundColor:
                    entry.type === 'directory'
                      ? 'var(--md-sys-color-primary-container)'
                      : 'var(--md-sys-color-surface-container-high)',
                  color:
                    entry.type === 'directory'
                      ? 'var(--md-sys-color-on-primary-container)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  cursor: entry.type === 'directory' ? 'pointer' : 'default',
                }}
              >
                {entry.type === 'directory' ? (
                  <Folder className="h-4 w-4" />
                ) : (
                  <File className="h-4 w-4" />
                )}
              </div>
              <div
                className="min-w-0 flex-1"
                onClick={() => handleEntryClick(entry)}
                style={{
                  cursor: entry.type === 'directory' ? 'pointer' : 'default',
                }}
              >
                <Text className="block truncate text-sm font-medium">
                  {entry.name}
                </Text>
                {entry.type === 'file' && entry.size !== undefined && (
                  <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                    {formatFileSize(entry.size)}
                  </Text>
                )}
              </div>
              {!readonly && (
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    onClick={() => openRenameModal(entry)}
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={() => setDeleteTarget(entry)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 添加根目录 Popup（主面板 + 副面板 flex 布局，向右延伸） */}
      {addRootModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 flex items-start justify-center px-4"
            style={{
              zIndex: 999,
              paddingTop: '80px',
            }}
          >
            {/* 轻量遮罩（点击关闭） */}
            <div
              className="absolute inset-0 bg-black/20"
              style={{
                backdropFilter: 'blur(var(--glass-blur-mask))',
                WebkitBackdropFilter: 'blur(var(--glass-blur-mask))',
              }}
              onClick={() => setAddRootModalOpen(false)}
            />
            {/* 主面板 + 副面板 flex 容器 */}
            <div
              className="glass-strong relative z-10 flex max-h-[calc(100vh-160px)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)] shadow-lg md:flex-row"
              style={{
                boxShadow:
                  '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
              }}
            >
              {/* 主面板 */}
              <div className="glass w-full flex-shrink-0 flex-col p-5 md:w-[360px] md:flex">
                {/* 标题栏 */}
                <SectionHeader
                  icon={<HardDrive className="h-4 w-4" />}
                  title="添加服务器目录"
                  className="mb-4"
                  titleClassName="text-base font-semibold"
                  extra={
                    <button
                      onClick={() => setAddRootModalOpen(false)}
                      className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  }
                />

                {/* 表单内容 */}
                <div className="flex flex-col gap-3">
                  <Input
                    label="名称"
                    value={newRootName}
                    onChange={(e) => setNewRootName(e.target.value)}
                    placeholder="如：影视库、下载目录"
                    autoFocus
                  />
                  {/* 服务器目录选取 */}
                  <div className="flex flex-col gap-1.5">
                    <Text className="text-sm font-medium">服务器目录</Text>
                    <div className="flex gap-2">
                      <Input
                        value={newRootPath}
                        onChange={(e) => setNewRootPath(e.target.value)}
                        placeholder="点击右侧按钮浏览选取目录"
                        className="flex-1"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<HardDrive className="h-3.5 w-3.5" />}
                        onClick={handleDirPickerToggle}
                      >
                        {dirPickerOpen ? '收起' : '浏览'}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <Text className="text-sm font-medium">只读模式</Text>
                      <Text
                        type="secondary"
                        className="text-[10px] uppercase tracking-wide"
                      >
                        禁止上传/新建/重命名/删除
                      </Text>
                    </div>
                    <Switch
                      checked={newRootReadonly}
                      onChange={(e) => setNewRootReadonly(e.target.checked)}
                    />
                  </div>
                  <Text
                    type="secondary"
                    className="text-[10px] leading-relaxed"
                  >
                    点击「浏览」在服务器文件系统中导航选取目录，也可手动输入路径。
                    目录必须存在且服务器进程有访问权限。
                  </Text>
                </div>

                {/* 底部按钮 */}
                <div className="mt-5 flex items-center justify-end gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setAddRootModalOpen(false)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleAddRoot()}
                    disabled={addingRoot}
                  >
                    {addingRoot ? '添加中...' : '添加'}
                  </Button>
                </div>
              </div>

              {/* 副面板：目录浏览（向右延伸，width 动画） */}
              <DirPickerSidePanel
                open={dirPickerOpen}
                loading={dirPickerLoading}
                error={dirPickerError}
                entries={dirPickerEntries}
                currentPath={dirPickerPath}
                isRoot={dirPickerIsRoot}
                onEnter={handleDirPickerEnter}
                onBack={handleDirPickerBack}
                onSelect={handleDirPickerSelect}
                onClose={() => setDirPickerOpen(false)}
              />
            </div>
          </div>,
          document.body
        )}

      {/* 新建文件夹 Modal */}
      <Modal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        title="新建文件夹"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setFolderModalOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleCreateFolder()}
              disabled={folderCreating}
            >
              {folderCreating ? '创建中...' : '创建'}
            </Button>
          </>
        }
      >
        <Input
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder="文件夹名称"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreateFolder()
          }}
        />
      </Modal>

      {/* 重命名 Modal */}
      <Modal
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title="重命名"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRenameTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleRename()}
              disabled={renaming}
            >
              {renaming ? '重命名中...' : '确认'}
            </Button>
          </>
        }
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="新名称"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleRename()
          }}
        />
      </Modal>

      {/* 删除文件确认 */}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
        onOk={() => void handleDelete()}
        okText={deleting ? '删除中...' : '删除'}
        cancelText="取消"
      >
        确定要删除「{deleteTarget?.name}」吗？
        {deleteTarget?.type === 'directory' &&
          ' 该文件夹内所有内容将被一并删除，且不可恢复。'}
      </ConfirmModal>

      {/* 删除根目录确认 */}
      <ConfirmModal
        open={!!deleteRootTarget}
        onClose={() => setDeleteRootTarget(null)}
        title="移除根目录挂载"
        onOk={() => void handleDeleteRoot()}
        okText={deletingRoot ? '移除中...' : '移除'}
        cancelText="取消"
      >
        确定要移除「{deleteRootTarget?.name}」的挂载吗？
        服务器上的真实文件不会被删除，仅取消在本面板的访问入口。
      </ConfirmModal>
    </div>
  )
}
