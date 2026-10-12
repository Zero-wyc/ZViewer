import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/room/components/AnimeSourceBrowser'
import { getAniSubsSources, searchAniSubs, getAniSubsEpisodes } from './api'

export function AniSubsSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="anisubs"
      title="ani-subs 番剧源"
      getSources={getAniSubsSources}
      search={searchAniSubs}
      getEpisodes={getAniSubsEpisodes}
    />
  )
}
