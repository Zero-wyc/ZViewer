import { load, type CheerioAPI } from 'cheerio';

/** Only web images are accepted; lazy attributes take precedence over placeholders. */
export function imageUrl(
  value: string | undefined,
  baseUrl: string,
): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim(), baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type ElementInput = Parameters<CheerioAPI>[0];

function posterIn(
  $: CheerioAPI,
  element: ElementInput,
  baseUrl: string,
): string | undefined {
  const scope = $(element);
  const selector =
    'img, [data-original], [data-src], [data-bg], [data-background], [style]';
  const candidates = scope.is(selector)
    ? scope.add(scope.find(selector))
    : scope.find(selector);
  for (const candidate of candidates.toArray()) {
    const item = $(candidate);
    for (const attribute of [
      'data-original',
      'data-src',
      'data-bg',
      'data-background',
      'data-lazy-src',
      'data-url',
      'src',
    ]) {
      const url = imageUrl(item.attr(attribute), baseUrl);
      if (url) return url;
    }
    const background = item
      .attr('style')
      ?.match(
        /background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/i,
      );
    const url = imageUrl(background?.[1], baseUrl);
    if (url) return url;
  }
  return undefined;
}

/** Resolve posters from the matching detail link, including sibling poster links. */
export function createSearchPosterReader(
  html: string,
  baseUrl: string,
): (detailUrl: string) => string | undefined {
  const $ = load(html);
  const links = $('a[href]').toArray();
  return (detailUrl) => {
    for (const link of links) {
      if (imageUrl($(link).attr('href'), baseUrl) !== detailUrl) continue;
      let scope = $(link);
      for (
        let depth = 0;
        depth < 4 && scope.length;
        depth++, scope = scope.parent()
      ) {
        if (scope.is('body, html')) break;
        // Never borrow a neighbouring show's poster from a shared list/container.
        if (
          scope
            .find('a[href]')
            .toArray()
            .some((a) => {
              const href = imageUrl($(a).attr('href'), baseUrl);
              return href && href !== detailUrl;
            })
        )
          break;
        const poster = posterIn($, scope, baseUrl);
        if (poster) return poster;
      }
    }
    return undefined;
  };
}

/** JSONPath subset used by ani-subs indexed subscriptions, without evaluating code. */
export function selectJsonPath(
  document: unknown,
  expression: string,
): unknown[] {
  if (!expression.startsWith('$'))
    throw new Error(`不支持的 JSONPath: ${expression}`);
  let values: unknown[] = [document];
  let remaining = expression.slice(1);
  while (remaining) {
    const match = remaining.match(
      /^(?:\.([\w-]+)|\[(\*|\d+|'[^']+'(?:\s*,\s*'[^']+')*)\])/,
    );
    if (!match) throw new Error(`不支持的 JSONPath: ${expression}`);
    const keys = match[1]
      ? [match[1]]
      : match[2] === '*'
        ? null
        : (match[2].match(/'([^']+)'/g)?.map((key) => key.slice(1, -1)) ?? [
            match[2],
          ]);
    values = values.flatMap((value) => {
      if (!value || typeof value !== 'object') return [undefined];
      if (!keys) return Object.values(value);
      return keys.flatMap((key) => {
        const item = Object.prototype.hasOwnProperty.call(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined;
        return [item];
      });
    });
    remaining = remaining.slice(match[0].length);
  }
  return values;
}
