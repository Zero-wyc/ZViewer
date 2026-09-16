/**
 * 歌曲自定义视频背景的本地关联仓库（Hydrogen playerStore.currentMusicVideo
 * 的 Web 适配）。
 *
 * Hydrogen 为 Electron 本地文件 + 主进程存储；ZViewer Web 环境改为
 * localStorage 按歌曲 songId 保存 B站 视频关联（BV 号 + 分 P cid + 元信息）。
 * 视频背景是纯视觉增强（各自客户端独立），不经房间同步——与 Hydrogen
 * 的本地 MV 语义一致。
 *
 * 存储结构：`zcontrol:music-video-map` → `{ [songId]: MusicVideoBinding }`
 * 跨组件同步：写入后派发自定义事件（与 bilibili/parseOptions.ts 同范式），
 * 订阅方（useMusicVideoBackground）据此重新解析背景视频。
 */

export interface MusicVideoBinding {
  /** B站 视频 BV 号 */
  bvid: string
  /** 选定的分 P cid（单 P 视频为该视频 cid） */
  cid: number
  /** 视频标题（元信息展示用） */
  title?: string
  /** 封面 URL */
  cover?: string
  /** UP 主 */
  upName?: string
}

const STORAGE_KEY = 'zcontrol:music-video-map'
const CHANGE_EVENT = 'zcontrol:music-video-map-change'

/** 解析结果缓存（保证 getMusicVideo 快照引用稳定，供 useSyncExternalStore 使用） */
let cachedMap: Record<string, MusicVideoBinding> | null = null

function readAll(): Record<string, MusicVideoBinding> {
  if (cachedMap) return cachedMap
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        cachedMap = parsed as Record<string, MusicVideoBinding>
        return cachedMap
      }
    }
  } catch {
    // 忽略 localStorage 读取异常
  }
  cachedMap = {}
  return cachedMap
}

function writeAll(map: Record<string, MusicVideoBinding>): void {
  cachedMap = map
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 忽略写入异常（隐私模式等）
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** 读取某首歌曲的视频关联（无关联时 null） */
export function getMusicVideo(songId: number): MusicVideoBinding | null {
  return readAll()[String(songId)] ?? null
}

/** 写入/更新某首歌曲的视频关联 */
export function setMusicVideo(
  songId: number,
  binding: MusicVideoBinding
): void {
  const map = readAll()
  map[String(songId)] = binding
  writeAll(map)
}

/** 解除某首歌曲的视频关联 */
export function removeMusicVideo(songId: number): void {
  const map = readAll()
  if (map[String(songId)] === undefined) return
  delete map[String(songId)]
  writeAll(map)
}

/** 订阅关联变化（写入时触发；返回退订函数） */
export function subscribeMusicVideo(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}
