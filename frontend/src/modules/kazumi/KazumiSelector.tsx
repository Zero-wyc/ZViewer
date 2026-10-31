import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/anime-browser'
import { getKazumiSources, searchKazumi, getKazumiEpisodes } from './api'
import { t } from '@/i18n'

export function KazumiSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="kazumi"
      title={t('Kazumi 番剧源')}
      getSources={getKazumiSources}
      search={searchKazumi}
      getEpisodes={getKazumiEpisodes}
    />
  )
}
