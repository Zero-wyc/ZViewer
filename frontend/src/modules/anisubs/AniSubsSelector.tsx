import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/anime-browser'
import { getAniSubsSources, searchAniSubs, getAniSubsEpisodes } from './api'
import { t } from '@/i18n'

export function AniSubsSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="anisubs"
      title={t('ani-subs 番剧源')}
      getSources={getAniSubsSources}
      search={searchAniSubs}
      getEpisodes={getAniSubsEpisodes}
    />
  )
}
