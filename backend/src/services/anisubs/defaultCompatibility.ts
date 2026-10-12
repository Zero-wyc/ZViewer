import type { AniSubsMediaSource } from './types';

/** Default subscription audit (2026-10-12). Custom subscriptions are not filtered. */
const UNAVAILABLE_DEFAULT_SOURCES = new Set([
  '稀饭动漫', // old endpoint now redirects to an ACG landing page
  'girigiri愛動漫', // all three searches return the same empty template
  'E-ACG',
  '去看吧',
  '新优酷',
  'hanime1_1080p',
  'hanime1_720p', // challenge pages
  '风车影视', // TLS/request failure for all three searches
]);

export function defaultSourceOverride(
  url: string,
  source: AniSubsMediaSource,
): AniSubsMediaSource | null {
  const clean = url.split(/[?#]/)[0];
  if (clean === 'https://sub.creamycake.org/v1/bt1.json') {
    // These RSS subscriptions yield .torrent/magnet entries, not browser video URLs.
    return null;
  }
  if (clean !== 'https://sub.creamycake.org/v1/css1.json') return source;
  if (UNAVAILABLE_DEFAULT_SOURCES.has(source.arguments.name)) return null;
  if (source.arguments.name !== 'TvTFun' || !source.arguments.searchConfig)
    return source;
  return {
    ...source,
    arguments: {
      ...source.arguments,
      searchConfig: {
        ...source.arguments.searchConfig,
        selectorSubjectFormatJsonPathIndexed: {
          ...source.arguments.searchConfig
            .selectorSubjectFormatJsonPathIndexed!,
          selectCovers: '$.data.videos[*].pic',
        },
        channelFormatId: 'no-channel',
        selectorChannelFormatNoChannel: {
          selectEpisodes: 'a[href*="/play?source="]',
          matchEpisodeSortFromName: '第\\s*(?<ep>\\d+)\\s*集',
        },
      },
    },
  };
}
