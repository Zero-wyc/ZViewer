/**
 * 网易云自建歌单的预取与模块级缓存（Hydrogen libraryStore 预载同思路）。
 *
 * 「添加到我的歌单」面板的数据源：触发按钮 hover 即预取，面板打开命中
 * 缓存零等待，列表挂载不与展开动画抢帧；TTL 5 分钟，新建歌单后失效。
 */
import { apiGet } from '@/lib/api'

/** 用户歌单条目（/user/playlist.playlist[] 子集） */
export interface UserPlaylistItem {
  id: number
  name: string
  coverImgUrl?: string
  specialType?: number
}

const USER_PLAYLIST_TTL_MS = 5 * 60 * 1000
let userPlaylistCache: {
  list: UserPlaylistItem[]
  fetchedAt: number
} | null = null
let userPlaylistInflight: Promise<UserPlaylistItem[]> | null = null

/** 预取/获取自建歌单（缓存命中直接返回；并发调用共享同一 in-flight 请求） */
export function prefetchUserPlaylists(): Promise<UserPlaylistItem[]> {
  if (
    userPlaylistCache &&
    Date.now() - userPlaylistCache.fetchedAt < USER_PLAYLIST_TTL_MS
  ) {
    return Promise.resolve(userPlaylistCache.list)
  }
  if (userPlaylistInflight) return userPlaylistInflight
  userPlaylistInflight = (async () => {
    // 注意端点是 /user/account（Hydrogen getUserProfile 同款），
    // 新版 NCM API 包的 /account 端点已被移除（返回 404）
    const acc = await apiGet<{
      account?: { id?: number }
      profile?: { userId?: number }
    }>(`/api/music/ncm/user/account?timestamp=${Date.now()}`)
    const uid = acc?.data?.account?.id ?? acc?.data?.profile?.userId
    if (!uid) throw new Error('未获取到用户 ID')
    const sub = await apiGet<{ createdPlaylistCount?: number }>(
      `/api/music/ncm/user/subcount?timestamp=${Date.now()}`
    )
    const createdCount = Number(sub?.data?.createdPlaylistCount) || 0
    const list = await apiGet<{ playlist?: UserPlaylistItem[] }>(
      `/api/music/ncm/user/playlist?uid=${uid}&limit=500&offset=0&timestamp=${Date.now()}`
    )
    const all = Array.isArray(list?.data?.playlist) ? list.data.playlist : []
    // 前 createdPlaylistCount 个为自建歌单（含「我喜欢的音乐」），其余为收藏
    const created = all.slice(0, createdCount > 0 ? createdCount : all.length)
    userPlaylistCache = { list: created, fetchedAt: Date.now() }
    return created
  })()
  // in-flight 槽位清理（挂在吞错分支上，不干扰调用方持有的原 Promise）
  void userPlaylistInflight
    .catch(() => {})
    .finally(() => {
      userPlaylistInflight = null
    })
  return userPlaylistInflight
}

/** 使歌单缓存失效（新建歌单后调用，下次打开重新拉取） */
export function invalidateUserPlaylistCache() {
  userPlaylistCache = null
}
