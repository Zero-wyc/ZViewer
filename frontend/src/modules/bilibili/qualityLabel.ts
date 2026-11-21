/**
 * B站 清晰度（qn）展示标签与下拉选项构建工具。
 *
 * 背景：影片在 DB 里保存的 currentQn 可能高于 acceptQuality 里实际可用的
 * 档位（例如账号无大会员时存过 1080P=80，后续只解析出 720P/480P/360P），
 * 直接用 currentQn 作为 Select 的 value 会匹配不到任何 option，下拉框显示
 * 占位「请选择」，用户既看不到当前画质也无法切换。这里统一把 currentQn
 * 补成一条兜底选项，保证 value 恒有匹配项。
 */
import type { QualityOption } from './types'

/** B站 qn → 展示标签（仅技术档位名，不带 i18n 文案） */
const QN_LABELS: Record<number, string> = {
  127: '8K',
  126: 'Dolby',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}

/** 单条下拉选项（与 ui/Select、ui/Dropdown 的选项结构兼容） */
export interface QualitySelectOption {
  label: string
  value: string
}

/** qn 对应的展示标签；未知档位退回 Q<qn>，便于排查 */
export function bilibiliQnLabel(qn: number | null | undefined): string {
  if (qn == null) return ''
  return QN_LABELS[qn] ?? `Q${qn}`
}

/**
 * 构建清晰度下拉选项：acceptQuality 为主，缺失 currentQn 时补一条兜底选项。
 *
 * @param qualities 服务端/CLI 返回的可选清晰度列表
 * @param currentQn 影片记录的当前清晰度（可能不在 qualities 内）
 * @param decorate  可选的条目文案装饰（追加分辨率、HDR 后缀等）
 */
export function buildQualityOptions(
  qualities: QualityOption[] | null | undefined,
  currentQn: number | null | undefined,
  decorate?: (q: QualityOption) => string
): QualitySelectOption[] {
  const options: QualitySelectOption[] = (qualities ?? []).map((q) => ({
    label: decorate ? decorate(q) : q.resolution ? `${q.label} · ${q.resolution}` : q.label,
    value: String(q.id),
  }))
  if (currentQn != null) {
    const value = String(currentQn)
    if (!options.some((o) => o.value === value)) {
      options.unshift({ label: bilibiliQnLabel(currentQn), value })
    }
  }
  return options
}

/**
 * 计算下拉框的当前值：优先显式选中值，其次影片 currentQn，最后取首个选项。
 * 与 buildQualityOptions 配合，保证返回值一定存在于 options 中。
 */
export function resolveQualitySelectValue(
  options: QualitySelectOption[],
  selectedQn?: number | null,
  currentQn?: number | null
): string {
  const candidate = selectedQn ?? currentQn
  if (candidate != null && options.some((o) => o.value === String(candidate))) {
    return String(candidate)
  }
  return options[0]?.value ?? ''
}
