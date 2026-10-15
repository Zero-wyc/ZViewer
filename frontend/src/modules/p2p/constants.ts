/**
 * P2P 直连模块常量
 *
 * ICE 服务器配置：STUN 用于公网候选地址发现，TURN 用于对称型 NAT 环境下的中继回退。
 * 当前仅配置公共 STUN，对称 NAT 下会触发超时回退到服务器中转。
 *
 * STUN 顺序（2026-10-15 UDP Binding Request 实测，本机网络）：
 * 1. stun.miwifi.com:3478 —— 小米，两轮实测 46-56ms 稳定可达，国内首选；
 * 2. stun.cdnbye.com:3478 —— CDNbye，国内但实测不稳定（一轮通过一轮超时），
 *    作为第二候选无额外代价（失败只是该候选缺席）；
 * 3. Google 19302 —— 国内部分网络可达（实测 182ms），海外部署/访问时有效，保留兜底。
 * 被剔除：stun.qq.com:3478（实测持续超时）、stun.cloudflare.com（超时）、
 * rustdesk（域名已失效）。
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.cdnbye.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** ICE 协商超时（毫秒），超时后判定 P2P 失败并回退服务器中转 */
export const ICE_TIMEOUT_MS = 10000

/** P2P 信令标记，用于区分 P2P 隧道信令与服务器中转 WebRTC 信令 */
export const P2P_SIGNAL_MARK = '__p2pTunnel' as const
