/**
 * 「添加到我的歌单」弹窗（Hydrogen ContextMenu.add-to-playlist 1:1 复刻）。
 *
 * 由底部播放条 / 完整播放器的「加号圆圈」按钮触发（Hydrogen MusicWidget
 * addToPlaylist → otherStore.addPlaylistShow 同范式）：
 * - 数据：GET /user/account 取 uid → GET /user/subcount 取 createdPlaylistCount
 *   → GET /user/playlist?uid&limit=500 → 前 createdPlaylistCount 个为自建歌单
 *   （Hydrogen libraryStore.playlistUserCreated 的切分方式）；
 *   「我喜欢的音乐」统一显示该名称（Hydrogen getPlaylistDisplayName）
 * - 加入：POST /playlist/tracks { op: 'add', pid, tracks: songId }，
 *   成功提示「已添加到{歌单名}」，失败提示「添加至歌单错误」
 * - 创建新歌单并添加：POST /playlist/create { name, privacy? } →
 *   成功后直接对新建歌单执行加入（Hydrogen createAndAdd 同流程）
 *
 * UI（Hydrogen 同款）：居中深色容器（300×500）+ 标题 + 自建歌单滚动列表
 * （45px 封面 + 14px bold 歌单名，hover 灰底）+「创建新歌单并添加」行
 * （展开内联表单：标题输入 + 隐私勾选 + 完成/取消）+ 左上 ADD 大字水印 +
 * 四角装饰块；点蒙层关闭。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Plus } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'

interface AddToPlaylistModalProps {
  open: boolean
  /** 待添加的歌曲（当前播放曲目，只需 songId 与名称） */
  song: { songId: number; name: string } | null
  onClose: () => void
}

/** 用户歌单条目（/user/playlist.playlist[] 子集） */
interface UserPlaylistItem {
  id: number
  name: string
  coverImgUrl?: string
  specialType?: number
}

/** 加载/加入状态 */
type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export function AddToPlaylistModal({
  open,
  song,
  onClose,
}: AddToPlaylistModalProps) {
  const [playlists, setPlaylists] = useState<UserPlaylistItem[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  /** 正在加入的歌单 id（行内 busy 态） */
  const [addingId, setAddingId] = useState<number | null>(null)
  /** 「创建新歌单并添加」表单展开态 */
  const [createActive, setCreateActive] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [privacy, setPrivacy] = useState(false)
  const [creating, setCreating] = useState(false)
  /** 弹窗容器引用（点外部关闭） */
  const containerRef = useRef<HTMLDivElement>(null)

  /** 打开时加载用户自建歌单（Hydrogen ensureUserPlaylistsLoaded） */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开驱动的外部数据请求
    setLoadState('loading')
    void (async () => {
      try {
        const acc = await apiGet<{
          account?: { id?: number }
          profile?: { userId?: number }
        }>(`/api/music/ncm/account?timestamp=${Date.now()}`)
        const uid = acc?.data?.account?.id ?? acc?.data?.profile?.userId
        if (!uid) throw new Error('未获取到用户 ID')
        const sub = await apiGet<{ createdPlaylistCount?: number }>(
          `/api/music/ncm/user/subcount?timestamp=${Date.now()}`
        )
        const createdCount = Number(sub?.data?.createdPlaylistCount) || 0
        const list = await apiGet<{ playlist?: UserPlaylistItem[] }>(
          `/api/music/ncm/user/playlist?uid=${uid}&limit=500&offset=0&timestamp=${Date.now()}`
        )
        if (cancelled) return
        const all = Array.isArray(list?.data?.playlist)
          ? list.data.playlist
          : []
        // 前 createdPlaylistCount 个为自建歌单（含「我喜欢的音乐」），其余为收藏
        setPlaylists(all.slice(0, createdCount > 0 ? createdCount : all.length))
        setLoadState('ready')
      } catch (err) {
        console.error('[AddToPlaylistModal] 歌单获取失败:', err)
        if (!cancelled) setLoadState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // 关闭时复位表单/加载态
  useEffect(() => {
    if (open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗关闭复位内部态
    setCreateActive(false)
    setNewTitle('')
    setPrivacy(false)
    setAddingId(null)
    setCreating(false)
  }, [open])

  /** 歌单显示名（Hydrogen getPlaylistDisplayName：喜欢列表统一命名） */
  const getPlaylistDisplayName = useCallback(
    (item: UserPlaylistItem): string =>
      item.specialType === 5 || item.name.includes('喜欢的音乐')
        ? '我喜欢的音乐'
        : item.name,
    []
  )

  /** 加入歌单（Hydrogen addToMyPlaylist：POST /playlist/tracks op=add） */
  const addToPlaylist = useCallback(
    async (pid: number, displayName: string) => {
      if (!song || addingId != null) return
      setAddingId(pid)
      try {
        const { data } = await apiPost<{
          code?: number
          body?: { code?: number }
        }>(`/api/music/ncm/playlist/tracks?timestamp=${Date.now()}`, {
          op: 'add',
          pid,
          tracks: String(song.songId),
        })
        const code = data?.code ?? data?.body?.code
        if (code === 200 || code === 502) {
          // 502 = 已存在于歌单，视为成功
          message.success(
            code === 502 ? `已在${displayName}中` : `已添加到${displayName}`
          )
          onClose()
        } else {
          message.error('添加至歌单错误')
        }
      } catch (err) {
        console.error('[AddToPlaylistModal] 添加到歌单失败:', err)
        message.error('添加至歌单错误')
      } finally {
        setAddingId(null)
      }
    },
    [song, addingId, onClose]
  )

  /** 创建新歌单并添加（Hydrogen createAndAdd：POST /playlist/create → 加入） */
  const createAndAdd = useCallback(async () => {
    const title = newTitle.trim()
    if (!title || !song || creating) return
    setCreating(true)
    try {
      const { data } = await apiPost<{ id?: number; code?: number }>(
        `/api/music/ncm/playlist/create?timestamp=${Date.now()}`,
        privacy ? { name: title, privacy: 10 } : { name: title }
      )
      const newId = data?.id
      if (!newId) {
        message.error('创建歌单失败')
        return
      }
      message.success(`已创建歌单「${title}」`)
      setCreateActive(false)
      setNewTitle('')
      setPrivacy(false)
      await addToPlaylist(newId, title)
    } catch (err) {
      console.error('[AddToPlaylistModal] 创建歌单失败:', err)
      message.error('创建歌单失败')
    } finally {
      setCreating(false)
    }
  }, [newTitle, privacy, song, creating, addToPlaylist])

  if (!open || !song) return null

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.35)' }}
      onClick={onClose}
    >
      {/* 居中容器（Hydrogen .playlist-container：300×500 深色 + ADD 水印） */}
      <div
        ref={containerRef}
        className="zen-modal-content-enter relative flex h-[500px] w-[300px] flex-col overflow-hidden"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-surface-container) 96%, transparent)',
          border:
            '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 70%, transparent)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左上 ADD 大字水印 */}
        <div
          className="pointer-events-none absolute -left-2 -top-3 select-none text-[52px] font-bold leading-none opacity-[0.06]"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        >
          ADD
        </div>
        {/* 四角装饰块（Hydrogen .add-style，浅色小方块） */}
        <span
          className="pointer-events-none absolute left-2 top-2 h-2 w-2"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute right-2 top-2 h-2 w-2"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute bottom-2 right-2 h-2 w-2"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute bottom-2 left-2 h-2 w-2"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />

        {/* 标题 */}
        <span
          className="mt-5 shrink-0 text-center text-sm font-bold"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
        >
          添加到我的歌单
        </span>

        {/* 歌单列表（滚动） */}
        <div className="zen-scroll mt-3 min-h-0 flex-1 overflow-y-auto pb-4">
          {loadState === 'loading' && (
            <div
              className="flex items-center justify-center gap-2 py-8 text-xs"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在获取歌单…
            </div>
          )}
          {loadState === 'error' && (
            <div
              className="py-8 text-center text-xs"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              歌单获取失败，请重试
            </div>
          )}
          {loadState === 'ready' && (
            <>
              {/* 创建新歌单并添加（Hydrogen .create-playlist） */}
              {!createActive ? (
                <button
                  type="button"
                  onClick={() => setCreateActive(true)}
                  className="flex w-full items-center gap-3 px-6 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]"
                >
                  <span
                    className="flex h-[45px] w-[45px] shrink-0 items-center justify-center"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
                      color: 'var(--md-sys-color-on-surface)',
                    }}
                  >
                    <Plus className="h-5 w-5" />
                  </span>
                  <span
                    className="truncate text-sm font-bold"
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                  >
                    创建新歌单并添加
                  </span>
                </button>
              ) : (
                /* 展开的创建表单（标题 + 隐私勾选 + 完成/取消） */
                <div className="flex w-full flex-col gap-2 px-6 py-2.5">
                  <input
                    type="text"
                    value={newTitle}
                    autoFocus
                    placeholder="请输入新歌单标题"
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createAndAdd()
                    }}
                    className="h-8 w-full border-0 px-2 text-xs outline-none"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                      color: 'var(--md-sys-color-on-surface)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setPrivacy((v) => !v)}
                    className="flex items-center gap-1.5 text-xs"
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    <span
                      className="flex h-3.5 w-3.5 items-center justify-center border"
                      style={{
                        borderColor: 'var(--md-sys-color-on-surface)',
                        backgroundColor: privacy
                          ? 'var(--md-sys-color-on-surface)'
                          : 'transparent',
                        color: privacy
                          ? 'var(--md-sys-color-surface)'
                          : 'transparent',
                      }}
                    >
                      {privacy && (
                        <Check className="h-2.5 w-2.5" strokeWidth={3} />
                      )}
                    </span>
                    设置为隐私歌单
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!newTitle.trim() || creating}
                      onClick={() => void createAndAdd()}
                      className="flex flex-1 items-center justify-center gap-1 py-1.5 text-xs font-bold transition-opacity hover:opacity-80 disabled:opacity-40"
                      style={{
                        backgroundColor: 'var(--md-sys-color-primary)',
                        color: 'var(--md-sys-color-on-primary)',
                      }}
                    >
                      {creating && <Loader2 className="h-3 w-3 animate-spin" />}
                      完成
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCreateActive(false)
                        setNewTitle('')
                        setPrivacy(false)
                      }}
                      className="flex-1 py-1.5 text-xs transition-opacity hover:opacity-70"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 自建歌单列表 */}
              {playlists.map((item) => {
                const adding = addingId === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={addingId != null}
                    onClick={() =>
                      void addToPlaylist(item.id, getPlaylistDisplayName(item))
                    }
                    className="flex w-full items-center gap-3 px-6 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)] disabled:opacity-70"
                  >
                    <span
                      className="h-[45px] w-[45px] shrink-0 overflow-hidden"
                      style={{
                        backgroundColor:
                          'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
                      }}
                    >
                      {item.coverImgUrl ? (
                        <img
                          src={`${item.coverImgUrl}?param=90y90`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </span>
                    <span
                      className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-bold"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    >
                      <span className="truncate">
                        {getPlaylistDisplayName(item)}
                      </span>
                      {adding && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      )}
                    </span>
                  </button>
                )
              })}
              {playlists.length === 0 && (
                <div
                  className="py-6 text-center text-xs opacity-60"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  暂无自建歌单
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
