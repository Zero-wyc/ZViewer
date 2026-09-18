/**
 * 「添加到我的歌单」弹窗（Hydrogen ContextMenu.add-to-playlist 结构复刻，
 * 视觉采用项目玻璃拟态 UI：glass-card 半透明面板 + MD 主题 token，
 * 深浅色主题自适应）。
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
 * 结构（Hydrogen 同款）：底部锚定播放条上方的面板（300 宽）+ 居中标题 +
 * 左上 ADD 大字水印 + 边缘闪烁装饰块 + 自建歌单滚动列表（45px 方形封面 +
 * 14px 粗体歌单名，hover 浅描边底）+「创建新歌单并添加」行（描边方块加号；
 * 展开内联表单：标题输入 + 隐私歌单勾选 + 完成/取消）；点蒙层关闭；
 * 打开时宽→高依次展开。
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, Plus } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import {
  prefetchUserPlaylists,
  invalidateUserPlaylistCache,
  type UserPlaylistItem,
} from '../userPlaylists'

interface AddToPlaylistModalProps {
  open: boolean
  /** 待添加的歌曲（当前播放曲目，只需 songId 与名称） */
  song: { songId: number; name: string } | null
  onClose: () => void
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
  /** 面板展开动画是否已结束：列表内容延后到此刻挂载，避免数据一到就
   *  在展开动画中途一次性渲染几十行歌单导致掉帧卡顿（Hydrogen 内容
   *  分级浮现的同思路） */
  const [unfoldDone, setUnfoldDone] = useState(false)

  /** 打开时加载用户自建歌单：走模块级缓存（触发按钮 hover 已预取），
   *  命中即零等待（Hydrogen ensureUserPlaylistsLoaded 的 store 预载同思路） */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开驱动的外部数据请求
    setLoadState('loading')
    void (async () => {
      try {
        const list = await prefetchUserPlaylists()
        if (cancelled) return
        setPlaylists(list)
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
    setUnfoldDone(false)
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
      // 新歌单已入列：失效模块缓存，下次打开重新拉取
      invalidateUserPlaylistCache()
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

  // createPortal 到 body：避免被 MusicWidgetBar 的 glass-card（backdrop-filter
  // 祖先）包裹 —— backdrop-filter 祖先会成为后代的 backdrop root，
  // 导致面板模糊无法采样到页面背景而丢失
  return createPortal(
    /* 全屏蒙层（半透明压暗，仅捕捉点击关闭） */
    <div
      className="fixed inset-0 z-[90]"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)' }}
      onClick={onClose}
    >
      {/* 玻璃拟态面板：底部锚定播放条上方居中。展开动画 Hydrogen
          ContextMenu .playlist-container-in 1:1 复刻：0.3s 延迟后先横向
          展开（宽 0→300，0.3s）再纵向展开（高 0→面板高，0.3s）；
          keyframes 只动宽高，transform 水平居中不参与动画；最终高度
          经 --add-panel-h 注入 keyframes */}
      <div
        className="glass-card absolute"
        style={
          {
            left: '50%',
            bottom: 124,
            width: 300,
            height: 'min(500px, calc(100vh - 160px))',
            transform: 'translateX(-50%)',
            '--add-panel-h': 'min(500px, calc(100vh - 160px))',
            animation: 'cloud-add-in 0.6s 0.3s both',
          } as React.CSSProperties
        }
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          // 仅认面板自身的展开动画（子元素的标题/水印/角块 animationend
          // 会冒泡上来，按 target 过滤）
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角装饰块（面板外缘 -4px，Hydrogen .add-style 1:1 的位置与
            0.4s 高频闪烁节奏；置于内容裁剪层之外保证不被裁掉） */}
        <span
          className="pointer-events-none absolute -left-1 -top-1 z-[3] h-[9px] w-[9px]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 85%, transparent)',
            animation: 'cloud-add-flash 0.4s both',
          }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute -right-1 -top-1 z-[3] h-[9px] w-[9px]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 85%, transparent)',
            animation: 'cloud-add-flash 0.4s both',
          }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute -bottom-1 -right-1 z-[3] h-[9px] w-[9px]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 85%, transparent)',
            animation: 'cloud-add-flash 0.4s both',
          }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute -bottom-1 -left-1 z-[3] h-[9px] w-[9px]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 85%, transparent)',
            animation: 'cloud-add-flash 0.4s both',
          }}
          aria-hidden="true"
        />

        {/* 内容层（独立裁剪：宽→高展开期间内容不外溢；水印/标题按
            Hydrogen 节奏延迟淡入——标题 0.5s、水印 0.6s） */}
        <div className="absolute inset-0 flex flex-col overflow-hidden">
          {/* 左上 ADD 大字水印（低透明度入色 + 0.6s 延迟淡入，
              Hydrogen .add-style5-in 同节奏） */}
          <div
            className="pointer-events-none absolute left-5 top-9 select-none text-[64px] font-bold leading-none"
            style={{
              color:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
              animation: 'cloud-add-watermark-in 0.3s 0.6s both',
            }}
            aria-hidden="true"
          >
            ADD
          </div>

          {/* 标题（Hydrogen .add-title-in：0.5s 延迟淡入） */}
          <div
            className="relative z-[1] mt-7 shrink-0 text-center text-[15px] font-bold"
            style={{
              color: 'var(--md-sys-color-on-surface)',
              animation: 'cloud-add-title-in 0.3s 0.5s both',
            }}
          >
            添加到我的歌单
          </div>

          {/* 歌单列表（滚动，隐藏滚动条） */}
          <div
            className="relative z-[1] mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-6 [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: 'none' }}
          >
            {/* 列表内容延后到展开动画结束再挂载（防中途批量渲染掉帧；
              hover 预取通常已就绪，此门只是保证动画期间的确定性流畅） */}
            {unfoldDone && loadState === 'loading' && (
              <div
                className="flex items-center justify-center gap-2 py-10 text-xs"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在获取歌单…
              </div>
            )}
            {unfoldDone && loadState === 'error' && (
              <div
                className="py-10 text-center text-xs"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                歌单获取失败，请重试
              </div>
            )}
            {unfoldDone && loadState === 'ready' && (
              <>
                {/* 创建新歌单并添加（Hydrogen .create-playlist：描边方块加号） */}
                {!createActive ? (
                  <button
                    type="button"
                    onClick={() => setCreateActive(true)}
                    className="flex w-full items-center gap-4 rounded-[var(--md-sys-radius-small)] py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]"
                  >
                    <span
                      className="flex h-[45px] w-[45px] shrink-0 items-center justify-center border-2"
                      style={{
                        borderColor:
                          'color-mix(in srgb, var(--md-sys-color-on-surface) 85%, transparent)',
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
                      className="h-9 w-full border bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)] px-2.5 text-xs outline-none"
                      style={{
                        borderColor:
                          'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
                        color: 'var(--md-sys-color-on-surface)',
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor =
                          'var(--md-sys-color-on-surface)'
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor =
                          'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)'
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setPrivacy((v) => !v)}
                      className="flex items-center gap-1.5 text-xs transition-colors"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
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
                        className="flex flex-1 items-center justify-center gap-1 rounded-[var(--md-sys-radius-small)] py-1.5 text-xs font-bold transition-opacity hover:opacity-85 disabled:opacity-40"
                        style={{
                          backgroundColor: 'var(--md-sys-color-primary)',
                          color: 'var(--md-sys-color-on-primary)',
                        }}
                      >
                        {creating && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        完成
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCreateActive(false)
                          setNewTitle('')
                          setPrivacy(false)
                        }}
                        className="flex-1 rounded-[var(--md-sys-radius-small)] py-1.5 text-xs transition-colors hover:opacity-70"
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
                        void addToPlaylist(
                          item.id,
                          getPlaylistDisplayName(item)
                        )
                      }
                      className="flex w-full items-center gap-4 rounded-[var(--md-sys-radius-small)] py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)] disabled:opacity-70"
                    >
                      <span
                        className="h-[45px] w-[45px] shrink-0 overflow-hidden border"
                        style={{
                          borderColor:
                            'color-mix(in srgb, var(--md-sys-color-on-surface) 25%, transparent)',
                          backgroundColor:
                            'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
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
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-bold">
                        <span
                          className="truncate"
                          style={{ color: 'var(--md-sys-color-on-surface)' }}
                        >
                          {getPlaylistDisplayName(item)}
                        </span>
                        {adding && (
                          <Loader2
                            className="h-3.5 w-3.5 shrink-0 animate-spin"
                            style={{ color: 'var(--md-sys-color-on-surface)' }}
                          />
                        )}
                      </span>
                    </button>
                  )
                })}
                {playlists.length === 0 && (
                  <div
                    className="py-8 text-center text-xs"
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
    </div>,
    document.body
  )
}
