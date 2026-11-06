/**
 * 共享会话交给界面的「视图状态」。
 *
 * 这两个类型原来是 `core/viewer-session.ts` / `core/host-session.ts` 的一部分，
 * 但界面对会话的要求只有这几句话：谁在播、停没停、能不能显示、要不要提示降档。
 * 它们跟怎么建连无关，所以单独放在这里——会话实现换过一茬，界面不用跟着改。
 */

/** 观众侧的状态。页面只用它决定遮罩文案与重试按钮。 */
export interface ViewerSessionState {
  joined: boolean
  /** 房主正在共享。 */
  sharing: boolean
  /** 房主暂停了画面（观众保留最后一帧）。 */
  paused: boolean
  /** 路由已提交，可以显示画面。 */
  active: boolean
  /** 正在自动恢复。 */
  recovering: boolean
  /** 恢复预算耗尽，需要用户点重试。 */
  exhausted: boolean
  hasVideo: boolean
  /** 媒体是否经服务端中继（false = 与房主直连）。 */
  relay: boolean
  error: string | null
}

/** 自动降档后要告诉用户的新档位。 */
export interface AutoDowngradeNotice {
  width: number
  height: number
  frameRate: number
}
