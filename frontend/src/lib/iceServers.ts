/**
 * 浏览器侧 ICE 配置。
 *
 * 只配公共 STUN（用于发现公网候选地址），不配 TURN：ZViewer 的中继由服务端
 * SFU 承担，客户端不需要 TURN 凭据。对称 NAT 下直连失败时由服务端路由接管。
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

/**
 * NAT 端口预测的「survey 目的地」。
 *
 * 照 Piik `internal/app/config/public_stun.go` 的 `stunURLs[1:3]` 口径：普通
 * 列表里的**第二、第三**个。必须**恰好两个**，预测才会启用
 * （`natPredictionSurveyUrls` 的硬要求），基准取第一个 :3478 的（miwifi）。
 *
 * 这三个目的地会被同一个本地 socket 各打一次 Binding Request，用同一公网 IP
 * 上出现的端口序列推断对称 NAT 的分配步长。**任一不可达只是少一个观测点**，
 * 凑不满等差数列就不预测，正常 ICE 完全不受影响——所以这里可以放心挑国内
 * 实测能通的那几个，不必为预测单独加服务器。
 */
export const NAT_PREDICTION_AUX_STUN_URLS: readonly string[] = [
  'stun:stun.cdnbye.com:3478',
  'stun:stun.l.google.com:19302',
]
