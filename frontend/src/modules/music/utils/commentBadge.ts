/**
 * 评论数徽章几何工具。
 *
 * 从 ListenTogetherPanel 抽出的纯函数层：工具栏评论按钮把「评论总数」画成
 * SVG 胶囊/圆环上的小徽章，宽度按字数线性增长（Hydrogen commentCountBadgeWidth
 * 简化版：首字符 13.8，后续每字符约 +7）。抽出来便于复用与单测。
 */

/** 评论数徽章胶囊宽度（首字符 13.8，后续每字符约 +7） */
export function badgeWidth(text: string): number {
  return 13.8 + Math.max(0, text.length - 1) * 7
}
