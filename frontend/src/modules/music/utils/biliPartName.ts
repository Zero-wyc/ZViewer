/**
 * B站 分P（part）命名规则（纯函数，无运行时依赖，供 B站 入队与单测共用）。
 *
 * 背景：一首「歌」在 B站 上常常是一整个多分P视频（合集里每个分P一首），
 * 视频标题是「【Hi-Res无损音质】盘点华语经典100首」这种合集名，分P名才是
 * 真正的歌名（「07 周杰伦 - 夜曲」）。任何把 B站 条目写进一起听播放列表的
 * 路径都必须按分P取名，否则列表里 100 行全是同一句标题。
 *
 * 规则：
 * - 视频只有 1 个分P → 没有更细的名字，保留调用方给的标题；
 * - 多分P → 用目标 cid 对应分P的 part 名；part 为空时退化为「标题 · P<n>」；
 * - album 始终放视频标题（多分P时作为上下文，单行列表里能看出属于哪个合集）。
 */

/** 只声明用得到的字段，避免纯函数依赖 bilibiliApi 的运行时。 */
export interface BiliViewPageLike {
  page: number
  cid: number
  part?: string | null
  duration?: number
}

export interface BiliViewLike {
  title?: string | null
  /** 视频总时长（秒）。仅单 P 时用作该 P 的时长兜底 */
  duration?: number | null
  pages?: BiliViewPageLike[] | null
}

export interface BiliPartMeta {
  /** 队列/播放器展示的曲名 */
  name: string
  /** 专辑位（多分P时是视频标题，单分P为空串） */
  album: string
  /** 分P时长（秒）；0 = 未知 */
  durationSec: number
  /** 视频是否多分P（多分P时 durationSec 不能用视频总时长兜底） */
  multiPart: boolean
}

/**
 * 归一化分P列表：剔除无效 cid、按 cid 去重、按 page 升序。
 *
 * 「挑一首」和「整集展开」都必须基于同一份列表，否则同一个视频在两条路径下
 * 会得到不同的分P集合（历史上 expand 去重、pick 不去重，就是这种漂移的开始）。
 */
export function normalizeBiliPages(
  view: BiliViewLike | null | undefined
): BiliViewPageLike[] {
  const seen = new Set<number>()
  return (view?.pages || [])
    .filter((p) => {
      if (!Number.isSafeInteger(p.cid) || p.cid <= 0 || seen.has(p.cid)) {
        return false
      }
      seen.add(p.cid)
      return true
    })
    .slice()
    .sort((a, b) => a.page - b.page)
}

/**
 * 按 cid 从视频详情里挑分P名。
 *
 * @param view 视频详情（`/api/stream/bilibili/view` 的返回，可为空）
 * @param cid 目标分P的 cid（相关推荐给的是首P；0/缺省时取第一个有效分P）
 * @param fallbackTitle 拿不到分P信息时的兜底标题（一般是视频标题）
 * @param normalized 已经过 `normalizeBiliPages` 的列表（展开整集时复用，
 *   避免对每个分P重复过滤排序）
 */
export function pickBiliPartMeta(
  view: BiliViewLike | null | undefined,
  cid: number | null | undefined,
  fallbackTitle: string,
  normalized?: BiliViewPageLike[]
): BiliPartMeta {
  const title = (view?.title || '').trim()
  const pages = normalized ?? normalizeBiliPages(view)
  // 单P视频：视频标题就是曲名，没有更细的名字可用；总时长此时就是这首的时长
  if (pages.length <= 1) {
    const only = pages[0]
    const durationSec =
      only && typeof only.duration === 'number' && only.duration > 0
        ? only.duration
        : typeof view?.duration === 'number' && view.duration > 0
          ? view.duration
          : 0
    return { name: fallbackTitle, album: '', durationSec, multiPart: false }
  }
  const wanted =
    Number.isSafeInteger(cid) && (cid as number) > 0 ? (cid as number) : 0
  const target = wanted > 0 ? pages.find((p) => p.cid === wanted) : pages[0]
  if (!target) {
    // 多P但 cid 不在分P列表里（up 主删过P / 推荐接口给了个旧 cid）：不猜
    return {
      name: fallbackTitle,
      album: title,
      durationSec: 0,
      multiPart: true,
    }
  }
  const part = (target.part || '').trim()
  return {
    name: part || `${title || fallbackTitle} · P${target.page}`,
    album: title,
    durationSec:
      typeof target.duration === 'number' && target.duration > 0
        ? target.duration
        : 0,
    multiPart: true,
  }
}
