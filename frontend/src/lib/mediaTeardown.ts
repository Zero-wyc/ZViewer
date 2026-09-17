/**
 * 房间关闭 / 断连时的本机媒体停止广播。
 *
 * 背景：房间被关闭（房主关房 / 管理员删房 / 不活跃房间自动清理）后，
 * 若本机 <video>/<audio> 仍在播放，浏览器会持续向后端请求媒体分片
 * （Range 请求），服务端则持续代理上游流量——这就是"房间关闭后服务端
 * 仍跑流量"的根源。RoomPage 统一监听 socket 的 room-closed / disconnect
 * 事件并 dispatch 本事件；useWatchTogether（一起看视频）与
 * useListenTogether（一起听音频）监听后立即停止拉流。
 */
export const ROOM_MEDIA_TEARDOWN_EVENT = 'zviewer:room-media-teardown'

export interface RoomMediaTeardownDetail {
  /**
   * true  = 彻底停止并释放（房间关闭）：暂停 + 释放引擎 + 清空 src，
   *         终止浏览器网络栈的媒体请求；
   * false = 仅暂停（socket 断连）：保留引擎与进度，重连后由同步流程恢复。
   */
  full: boolean
}

export function dispatchRoomMediaTeardown(full: boolean): void {
  window.dispatchEvent(
    new CustomEvent<RoomMediaTeardownDetail>(ROOM_MEDIA_TEARDOWN_EVENT, {
      detail: { full },
    })
  )
}
