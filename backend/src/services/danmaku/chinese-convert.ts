import * as OpenCC from 'opencc-js';

/**
 * 简繁中文转换工具。
 * 用于弹幕搜索时将简体关键词转换为繁体（巴哈姆特为繁体平台），
 * 以及将繁体关键词转换为简体（弹弹play 部分场景更友好），
 * 配合双语搜索策略提升命中率。
 */

// 简体 → 繁体（台湾用词习惯）
const s2tConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });
// 繁体 → 简体
const t2sConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });

/** 将简体中文转换为繁体中文（台湾）。 */
export function toTraditional(input: string): string {
  if (!input) return input;
  try {
    return s2tConverter(input);
  } catch {
    return input;
  }
}

/** 将繁体中文转换为简体中文。 */
export function toSimplified(input: string): string {
  if (!input) return input;
  try {
    return t2sConverter(input);
  } catch {
    return input;
  }
}

/**
 * 判断字符串是否包含中文字符。
 */
export function containsChinese(input: string): boolean {
  return /[\u4e00-\u9fff]/.test(input);
}

/**
 * 判断字符串是否为简体中文（含简体独有字）。
 * 通过尝试转换后比较差异来判断。
 */
export function isSimplifiedChinese(input: string): boolean {
  if (!input || !containsChinese(input)) return false;
  return toTraditional(input) !== input;
}

/**
 * 判断字符串是否为繁体中文。
 */
export function isTraditionalChinese(input: string): boolean {
  if (!input || !containsChinese(input)) return false;
  return toSimplified(input) !== input;
}
