import { matchEmbyTrackToMkvTrack } from '../emby-mkv-match.ts'

const test = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: string) => {
        test: (name: string, fn: () => void) => void
      }
    }
  }
).process.getBuiltinModule('node:test').test

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected)
    throw new Error(`${message}: expected identity match`)
}

const tracks = [
  {
    trackNumber: 1,
    codecId: 'S_HDMV/PGS',
    language: 'chi',
    title: '中文',
    supported: false,
  },
  {
    trackNumber: 2,
    codecId: 'S_TEXT/ASS',
    language: 'chi',
    title: '中文（简体）',
    supported: true,
  },
  {
    trackNumber: 3,
    codecId: 'S_TEXT/UTF8',
    language: 'eng',
    title: 'English',
    supported: true,
  },
]

test('embedded ordinal indexes the unfiltered subtitle list', () => {
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 8, codecName: 'ass', embeddedOrdinal: 1 },
      tracks
    ),
    tracks[1],
    'ordinal includes unsupported tracks'
  )
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 8, codecName: 'pgs', embeddedOrdinal: 0 },
      tracks
    ),
    null,
    'unsupported ordinal is not remapped'
  )
})

test('external and codec-incompatible ordinal tracks are not remapped', () => {
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 1, codecName: 'ass', isExternal: true },
      tracks
    ),
    null,
    'external track is excluded'
  )
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 8, codecName: 'pgs', embeddedOrdinal: 1 },
      tracks
    ),
    null,
    'incompatible ordinal is not remapped'
  )
})

test('normalized title, language, and codec match a specific version', () => {
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 20, codecName: 'ass', title: ' 中文（简体） ', language: 'chi' },
      tracks
    ),
    tracks[1],
    'normalized version metadata matches'
  )
})

test('track number, sole track, and language plus codec are fallback tiers', () => {
  equal(
    matchEmbyTrackToMkvTrack({ index: 2, codecName: 'subrip' }, tracks),
    tracks[2],
    'track number fallback'
  )
  equal(
    matchEmbyTrackToMkvTrack({ index: 99, codecName: 'unknown' }, [tracks[2]]),
    tracks[2],
    'sole track fallback'
  )
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 0, codecName: 'subrip', language: 'eng' },
      tracks
    ),
    tracks[2],
    'language and codec fallback'
  )
  equal(
    matchEmbyTrackToMkvTrack(
      { index: 0, codecName: 'ass', language: 'und' },
      tracks
    ),
    null,
    'und does not match'
  )
})

test('ordinal yields to conflicting title or language but accepts missing metadata', () => {
  const first = {
    ...tracks[1],
    trackNumber: 4,
    title: 'Traditional',
    language: 'chi',
  }
  const second = { ...first, trackNumber: 5, title: 'Simplified' }
  const emby = {
    index: 99,
    codecName: 'ass',
    embeddedOrdinal: 0,
    title: 'Simplified',
    language: 'chi',
  }
  equal(
    matchEmbyTrackToMkvTrack(emby, [first, second]),
    second,
    'reordered ASS titles'
  )
  const english = { ...first, language: 'eng' }
  equal(
    matchEmbyTrackToMkvTrack({ ...emby, title: first.title }, [english, first]),
    first,
    'conflicting ordinal language'
  )
  const unnamed = { ...first, title: null, language: 'und' }
  equal(
    matchEmbyTrackToMkvTrack(emby, [unnamed, second]),
    unnamed,
    'missing title and unknown language'
  )
})
