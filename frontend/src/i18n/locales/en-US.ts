/**
 * 英文词条。
 *
 * key 是**中文原文**（与 `zh-CN.ts` 完全一致），value 是对应英文，例如：
 *
 *   '加入语音': 'Join voice',
 *
 * 现在是空壳：界面文案还在随迭代改动，先不做翻译。往这里补条目即可生效，
 * 没有条目的地方会自动显示中文原文（i18next 找不到就返回 key）。
 * 带变量的词条写成 `'已复制 {{count}} 项': 'Copied {{count}} items'`。
 */
const enUS: Record<string, string> = {}

export default enUS
