import { create } from 'zustand'
import type { NcmSong } from './types'

type Update<T> = T | ((prev: T) => T)
const resolve = <T>(value: Update<T>, prev: T): T =>
  typeof value === 'function' ? (value as (prev: T) => T)(prev) : value

const initial = {
  pool: [] as NcmSong[],
  history: [] as NcmSong[],
  current: null as NcmSong | null,
  mode: 'DEFAULT',
  submode: 'FOCUS',
  activeRoomId: null as string | null,
  activeKey: null as string | null,
}

/** FM 会话由房间播放器持有，切换音乐页面不会丢失候选或停止续播。 */
export const usePersonalFmStore = create<
  typeof initial & {
    generation: number
    setPool: (value: Update<NcmSong[]>) => void
    setHistory: (value: Update<NcmSong[]>) => void
    setCurrent: (value: Update<NcmSong | null>) => void
    setMode: (mode: string) => void
    setSubmode: (submode: string) => void
    activate: (roomId: string, song: NcmSong) => void
    deactivate: () => void
    invalidate: () => void
    reset: () => void
  }
>((set) => ({
  ...initial,
  generation: 0,
  setPool: (value) => set((s) => ({ pool: resolve(value, s.pool) })),
  setHistory: (value) => set((s) => ({ history: resolve(value, s.history) })),
  setCurrent: (value) => set((s) => ({ current: resolve(value, s.current) })),
  setMode: (mode) =>
    set((s) => ({ mode, pool: [], generation: s.generation + 1 })),
  setSubmode: (submode) =>
    set((s) => ({ submode, pool: [], generation: s.generation + 1 })),
  activate: (roomId, song) =>
    set((s) => ({
      activeRoomId: roomId,
      activeKey: `ncm:${song.songId}`,
      current: song,
      pool: s.pool.filter(
        (item) =>
          item.songId !== song.songId && item.songId !== s.current?.songId
      ),
      generation: s.generation + 1,
    })),
  deactivate: () =>
    set((s) => ({
      activeRoomId: null,
      activeKey: null,
      generation: s.generation + 1,
    })),
  invalidate: () => set((s) => ({ generation: s.generation + 1 })),
  reset: () => set((s) => ({ ...initial, generation: s.generation + 1 })),
}))

export interface FmSongItem {
  id: number
  name: string
  artists?: Array<{ name?: string }>
  album?: { name?: string; picUrl?: string }
  duration?: number
}

export function mapFmSong(item: FmSongItem): NcmSong {
  return {
    songId: item.id,
    name: item.name,
    artist: (item.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: item.album?.name ?? '',
    cover: item.album?.picUrl
      ? `${item.album.picUrl.replace('http://', 'https://')}?param=300y300`
      : '',
    durationMs: item.duration ?? 0,
    vip: false,
  }
}

/** 请求按代次去重；切模式、换曲、离房后的旧响应不能覆盖新候选。 */
let pending: { generation: number; promise: Promise<void> } | null = null
export function fetchPersonalFmPool(
  request: (url: string) => Promise<FmSongItem[]>
): Promise<void> {
  const state = usePersonalFmStore.getState()
  const generation = state.generation
  if (pending?.generation === generation) return pending.promise
  const promise = (async () => {
    const params = new URLSearchParams({ mode: state.mode, limit: '6' })
    if (state.mode === 'SCENE_RCMD') params.set('submode', state.submode)
    let list = await request(
      state.mode === 'DEFAULT'
        ? '/api/music/ncm/personal_fm'
        : `/api/music/ncm/personal/fm/mode?${params}`
    )
    if (list.length === 0 && state.mode !== 'DEFAULT') {
      list = await request('/api/music/ncm/personal_fm')
    }
    if (usePersonalFmStore.getState().generation !== generation) return
    const mapped = list.map(mapFmSong).filter((song) => song.songId > 0)
    usePersonalFmStore.setState((s) => {
      const seen = new Set(
        [...s.pool, ...s.history, ...(s.current ? [s.current] : [])].map(
          (song) => song.songId
        )
      )
      const fresh = mapped.filter((song) => {
        if (seen.has(song.songId)) return false
        seen.add(song.songId)
        return true
      })
      return {
        pool: [...s.pool, ...fresh],
        current: s.current ?? fresh[0] ?? null,
      }
    })
  })().finally(() => {
    if (pending?.promise === promise) pending = null
  })
  pending = { generation, promise }
  return promise
}

/** 自动续播先等待服务端确认入队，再播放并广播，异步期间持续校验会话。 */
export async function advancePersonalFm(
  roomId: string,
  currentKey: string | null,
  deps: {
    refill: () => Promise<void>
    enqueue: (song: NcmSong) => Promise<void>
    play: (song: NcmSong) => void
    isCurrent: () => boolean
  }
): Promise<void> {
  const snapshot = usePersonalFmStore.getState()
  const valid = () => {
    const state = usePersonalFmStore.getState()
    return (
      state.generation === snapshot.generation &&
      state.activeRoomId === roomId &&
      state.activeKey === currentKey &&
      deps.isCurrent()
    )
  }
  if (!valid()) return
  let next = snapshot.pool.find((song) => `ncm:${song.songId}` !== currentKey)
  if (!next) {
    await deps.refill()
    if (!valid()) return
    next = usePersonalFmStore
      .getState()
      .pool.find((song) => `ncm:${song.songId}` !== currentKey)
  }
  if (!next) throw new Error('暂时没有新的漫游歌曲，请稍后重试')
  if (!valid()) return
  await deps.enqueue(next)
  if (!valid()) return
  const current = usePersonalFmStore.getState().current
  usePersonalFmStore
    .getState()
    .setHistory((history) =>
      current ? [...history, current].slice(-100) : history
    )
  usePersonalFmStore.getState().activate(roomId, next)
  deps.play(next)
}
