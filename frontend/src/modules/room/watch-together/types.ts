/**
 * 一起看（Watch Together）跨组件共享类型。
 *
 * 单独成文件是为了打断 WatchTogetherCore ↔ WatchTogetherPanel 的类型互引：
 * Panel 创建 slots、Core 消费 slots，契约放中立位置，两个组件只需单向依赖本文件。
 */

/** ArtPlayer 插槽集合：Core 通过 createPortal 向其中渲染组件 */
export interface ArtSlots {
  /** 弹幕图层根（art layer） */
  danmakuRoot: HTMLDivElement
  /** 覆盖层根（加载动画，art layer） */
  overlayRoot: HTMLDivElement
  /** 浮动面板根（设置 / 空源占位，append 到 $player） */
  panelRoot: HTMLDivElement
}
