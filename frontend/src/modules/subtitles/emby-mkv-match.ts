export interface EmbyTrackCandidate {
  index: number
  codecName: string
  title?: string | null
  language?: string | null
  isExternal?: boolean
  embeddedOrdinal?: number
}

export interface MkvTrackCandidate {
  trackNumber: number
  codecId: string
  title?: string | null
  language?: string | null
  supported: boolean
}

const normalize = (value?: string | null) =>
  (value ?? '').normalize('NFKC').trim().toLowerCase()

const codecFamily = (codec: string) => {
  switch (normalize(codec).replace(/^s_(text|hdmv|image)\//, '')) {
    case 'subrip':
    case 'srt':
    case 'utf8':
      return 'srt'
    case 'ass':
    case 'ssa':
      return 'ass'
    case 'webvtt':
    case 'vtt':
      return 'vtt'
    case 'pgs':
    case 'pgssub':
    case 'hdmv_pgs_subtitle':
      return 'pgs'
    case 'vobsub':
    case 'dvd_subtitle':
      return 'vobsub'
    case 'dvbsub':
    case 'dvb_subtitle':
      return 'dvbsub'
    default:
      return null
  }
}

export function matchEmbyTrackToMkvTrack<T extends MkvTrackCandidate>(
  track: EmbyTrackCandidate,
  mkvTracks: readonly T[]
): T | null {
  if (track.isExternal) return null
  const family = codecFamily(track.codecName)
  const compatible = (candidate: T) => {
    const mkvFamily = codecFamily(candidate.codecId)
    return !family || !mkvFamily || family === mkvFamily
  }
  // 先查未过滤的列表，不支持的轨道也占用一个内嵌序号。
  const ordinal =
    track.embeddedOrdinal != null ? mkvTracks[track.embeddedOrdinal] : undefined
  const title = normalize(track.title)
  const language = normalize(track.language)
  if (ordinal && compatible(ordinal)) {
    const ordinalTitle = normalize(ordinal.title)
    const ordinalLanguage = normalize(ordinal.language)
    const titleConflict = title && ordinalTitle && title !== ordinalTitle
    const languageConflict =
      language &&
      language !== 'und' &&
      ordinalLanguage &&
      ordinalLanguage !== 'und' &&
      language !== ordinalLanguage
    if (!titleConflict && !languageConflict)
      return ordinal.supported ? ordinal : null
  }

  const supported = mkvTracks.filter((candidate) => candidate.supported)
  const matchesLanguageAndCodec = (candidate: T) => {
    const candidateFamily = codecFamily(candidate.codecId)
    return (
      normalize(candidate.language) === language &&
      (!family || !candidateFamily || candidateFamily === family)
    )
  }
  const exact = title
    ? supported.find(
        (candidate) =>
          normalize(candidate.title) === title &&
          matchesLanguageAndCodec(candidate)
      )
    : undefined
  if (exact) return exact

  const numbered = supported.find(
    (candidate) =>
      candidate.trackNumber === track.index + 1 && compatible(candidate)
  )
  if (numbered) return numbered
  if (mkvTracks.length === 1)
    return mkvTracks[0]?.supported ? mkvTracks[0] : null
  return language && language !== 'und'
    ? (supported.find(matchesLanguageAndCodec) ?? null)
    : null
}
