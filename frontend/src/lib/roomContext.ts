/**
 * 当前房间上下文（供底层 fetch 封装读取）。
 *
 * 一起听 / 一起看的账号（网易云、B站）改为「房间共享账号」：任意成员在房间内
 * 登录后，服务端把账号绑定到房间，房间内其他成员的所有账号类请求都复用同一份
 * 凭证（解析与搜索全部在服务端完成，前端只播直链）。
 *
 * 为了不改每个调用点，api.ts 会从本模块读取当前房间 id 并自动附加
 * `X-Room-Id` 请求头；后端据此把请求解析到房间绑定账号。
 *
 * 为什么不直接 import roomStore：api.ts 是最底层模块，roomStore 反过来依赖
 * 它（房间内的电影/权限接口都要走 apiFetch），直接互相 import 会形成循环依赖。
 * 用一个只存字符串的中间模块即可打破循环，且写入点只有 roomStore。
 */
let currentRoomId: string | null = null

/** 设置当前房间上下文；传入 null / 空串表示离开房间。 */
export function setApiRoomContext(roomId: string | null | undefined): void {
  const trimmed = typeof roomId === 'string' ? roomId.trim() : ''
  currentRoomId = trimmed ? trimmed : null
}

/** 读取当前房间上下文（未进房间时为 null）。 */
export function getApiRoomContext(): string | null {
  return currentRoomId
}
