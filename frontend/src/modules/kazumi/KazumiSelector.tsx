import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/room/components/AnimeSourceBrowser'
import { getKazumiSources, searchKazumi, getKazumiEpisodes } from './api'

export function KazumiSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="kazumi"
      title="Kazumi 番剧源"
      getSources={getKazumiSources}
      search={searchKazumi}
      getEpisodes={getKazumiEpisodes}
    />
  )
}
