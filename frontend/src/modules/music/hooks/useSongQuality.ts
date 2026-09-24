/**
 * 实际音质元数据（Hydrogen song-quality 角标：真实采样率/比特率）。
 *
 * 复用 /stream 同构解析链的后端 /song-quality 端点，按歌曲与设置档位查询
 * 真实采样率/比特率；请求失败静默回退设置档位（角标仅显示 LEVEL 段）。
 * 切歌时清空旧值（render 期派生重置，避免闪显上一首的音质）。
 */
import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '@/lib/api'
import { useMusicSettingsStore } from '../store-settings'

interface SongQuality {
  sr: number
  br: number
  level: string
}

/**
 * @param songId 当前网易云歌曲 id（B站 条目无 songId，不查询仅显示设置档位）
 * @returns qualityLabel 角标文案：`${sr/1000}KHz/${br/1000}Kbps/LEVEL`，
 *          缺失的字段段自动隐藏
 */
export function useSongQuality(songId: number | null | undefined) {
  const level = useMusicSettingsStore((s) => s.level)
  const [songQuality, setSongQuality] = useState<SongQuality | null>(null)
  // 切歌时清空（render 期调整，替代 effect 内同步 setState）
  const [prevQualitySongId, setPrevQualitySongId] = useState<number | null>(
    typeof songId === 'number' ? songId : -1
  )
  if (prevQualitySongId !== songId) {
    setPrevQualitySongId(typeof songId === 'number' ? songId : -1)
    setSongQuality(null)
  }
  useEffect(() => {
    if (songId == null || songId <= 0) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { data } = await apiGet<{
          success?: boolean
          sr?: number
          br?: number
          level?: string
        }>(`/api/music/song-quality?songId=${songId}&level=${level}`)
        if (!cancelled) {
          setSongQuality({
            sr: typeof data?.sr === 'number' ? data.sr : 0,
            br: typeof data?.br === 'number' ? data.br : 0,
            level: typeof data?.level === 'string' ? data.level : '',
          })
        }
      } catch {
        if (!cancelled) setSongQuality(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [songId, level])

  /** 音质角标文案（Hydrogen Lyric.vue：`${sr/1000}KHz/${br/1000}Kbps/LEVEL`，
   *  缺失的字段段自动隐藏；上游解析失败时仅显示设置档位） */
  const qualityLabel = useMemo(() => {
    const parts: string[] = []
    if (songQuality && songQuality.sr > 0)
      parts.push(`${songQuality.sr / 1000}KHz`)
    if (songQuality && songQuality.br > 0)
      parts.push(`${Math.round(songQuality.br / 1000)}Kbps`)
    parts.push((songQuality?.level || level).toUpperCase())
    return parts.join('/')
  }, [songQuality, level])

  return qualityLabel
}
