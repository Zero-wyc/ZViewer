// 房间悬浮层（Live2D）的对外入口。
//
// 只导出宿主组件：场景、渲染器、协议类型都属于模块内部实现，
// 别的模块要读「谁在场」请用 store，而不是直接摸 scene（它是高频可变对象）。

export { RoomLive2DHost } from './components/RoomLive2DHost'
export type { RoomLive2DHostProps } from './components/RoomLive2DHost'
export { useLive2DStore } from './store/live2dStore'
