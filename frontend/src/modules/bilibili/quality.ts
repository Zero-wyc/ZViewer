/**
 * B站 清晰度：VIP 专属档位 qn 列表。
 *
 * 用途仅限前端 UI 标记（如「需要大会员」提示），**不用于权限判定**。
 * 权限与过滤的唯一事实源是后端 `services/bilibili/permission.ts` 的
 * `filterQualitiesByVip`——UGC / PGC / MP4 三条解析路径在返回前均已按
 * 「未登录 / 非会员 / 会员」三态过滤 acceptQuality，前端直接消费即可。
 */
export const VIP_ONLY_QNS = [112, 116, 120, 125, 126, 127]
