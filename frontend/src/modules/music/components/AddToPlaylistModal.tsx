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
 * UI（Hydrogen 同款，固定深黑配色）：底部锚定播放条上方的深黑面板
 * （rgb(15,15,15)，300×500）+ 居中标题 + 左上 ADD 大字水印 + 边缘白色
 * 闪烁装饰块 + 自建歌单滚动列表（45px 方形封面 + 14px 粗体白字歌单名，
 * hover 灰底）+「创建新歌单并添加」行（白色描边方块加号；展开内联表单：
 * 标题输入 + 隐私歌单勾选 + 完成/取消）；点蒙层关闭；打开时宽→高依次展开。
 */
import { useCallback, useEffect, useState } from 'react'
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
    /* 全屏蒙层（Hydrogen rgba(0,0,0,0.05)，极淡，仅捕捉点击关闭） */
    <div
      className="fixed inset-0 z-[90]"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.05)' }}
      onClick={onClose}
    >
      {/* 深黑面板：底部锚定播放条上方，居中 300 宽，宽→高依次展开 */}
      <div
        className="absolute flex flex-col overflow-hidden"
        style={{
          left: '50%',
          bottom: 124,
          width: 300,
          height: 'min(500px, calc(100vh - 160px))',
          backgroundColor: 'rgb(15, 15, 15)',
          animation: 'cloud-add-in 0.4s cubic-bezier(0.34, 1.2, 0.4, 1) both',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 边缘白色装饰块（闪烁，Hydrogen .add-style） */}
        <span
          className="pointer-events-none absolute left-3 top-3 z-[2] h-[9px] w-[9px] bg-white"
          style={{ animation: 'cloud-add-flash 2.2s ease-in-out infinite' }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute right-3 top-3 z-[2] h-[9px] w-[9px] bg-white"
          style={{
            animation: 'cloud-add-flash 2.2s ease-in-out 0.4s infinite',
          }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute bottom-2 left-1/2 z-[2] h-[9px] w-[9px] -translate-x-1/2 bg-white"
          style={{
            animation: 'cloud-add-flash 2.2s ease-in-out 0.8s infinite',
          }}
          aria-hidden="true"
        />

        {/* 左上 ADD 大字水印 */}
        <div
          className="pointer-events-none absolute left-5 top-9 select-none text-[64px] font-bold leading-none text-white opacity-[0.07]"
          aria-hidden="true"
        >
          ADD
        </div>

        {/* 标题 */}
        <div className="relative z-[1] mt-7 shrink-0 text-center text-[15px] font-bold text-white">
          添加到我的歌单
        </div>

        {/* 歌单列表（滚动，隐藏滚动条） */}
        <div
          className="relative z-[1] mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-6 [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: 'none' }}
        >
          {loadState === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-white/60">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在获取歌单…
            </div>
          )}
          {loadState === 'error' && (
            <div className="py-10 text-center text-xs text-white/60">
              歌单获取失败，请重试
            </div>
          )}
          {loadState === 'ready' && (
            <>
              {/* 创建新歌单并添加（Hydrogen .create-playlist：白色描边方块加号） */}
              {!createActive ? (
                <button
                  type="button"
                  onClick={() => setCreateActive(true)}
                  className="flex w-full items-center gap-4 py-2 text-left transition-colors hover:bg-[rgba(53,53,53,0.7)]"
                >
                  <span className="flex h-[45px] w-[45px] shrink-0 items-center justify-center border-2 border-white/90">
                    <Plus className="h-5 w-5 text-white" />
                  </span>
                  <span className="truncate text-sm font-bold text-white">
                    创建新歌单并添加
                  </span>
                </button>
              ) : (
                /* 展开的创建表单（标题 + 隐私勾选 + 完成/取消） */
                <div className="flex flex-col gap-2.5 py-2">
                  <input
                    type="text"
                    value={newTitle}
                    autoFocus
                    placeholder="请输入新歌单标题"
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createAndAdd()
                    }}
                    className="h-9 w-full border border-white/60 bg-[rgba(255,255,255,0.08)] px-2.5 text-xs text-white outline-none placeholder:text-white/40 focus:border-white"
                  />
                  <button
                    type="button"
                    onClick={() => setPrivacy((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-white/80 transition-colors hover:text-white"
                  >
                    <span
                      className="flex h-3.5 w-3.5 items-center justify-center border"
                      style={{
                        borderColor: 'rgba(255, 255, 255, 0.85)',
                        backgroundColor: privacy ? '#ffffff' : 'transparent',
                      }}
                    >
                      {privacy && (
                        <Check
                          className="h-2.5 w-2.5 text-black"
                          strokeWidth={3}
                        />
                      )}
                    </span>
                    设置为隐私歌单
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!newTitle.trim() || creating}
                      onClick={() => void createAndAdd()}
                      className="flex flex-1 items-center justify-center gap-1 bg-white py-1.5 text-xs font-bold text-black transition-opacity hover:opacity-85 disabled:opacity-40"
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
                      className="flex-1 py-1.5 text-xs text-white/60 transition-colors hover:text-white"
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
                    className="flex w-full items-center gap-4 py-2.5 text-left transition-colors hover:bg-[rgba(53,53,53,0.7)] disabled:opacity-70"
                  >
                    <span className="h-[45px] w-[45px] shrink-0 overflow-hidden border border-white/25 bg-[rgba(255,255,255,0.06)]">
                      {item.coverImgUrl ? (
                        <img
                          src={`${item.coverImgUrl}?param=90y90`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-bold text-white">
                      <span className="truncate">
                        {getPlaylistDisplayName(item)}
                      </span>
                      {adding && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white" />
                      )}
                    </span>
                  </button>
                )
              })}
              {playlists.length === 0 && (
                <div className="py-8 text-center text-xs text-white/50">
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
