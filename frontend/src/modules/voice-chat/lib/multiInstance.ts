/**
 * 语音多实例（仅供测试）：
 * 允许同一登录用户在多个浏览器标签页中同时加入同一房间的语音。
 *
 * 是否生效完全由服务端系统设置 roomMultiInstanceLogin 门控（管理端
 * 「权限管理 → 基础设置」开关）——客户端恒生成并上报本标签页的
 * instanceId（sessionStorage：同一标签页刷新/重连保持稳定，跨标签页
 * 天然隔离）。服务端开关关闭时忽略该字段，行为与多实例开启前一致；
 * 开启时以 user:{userId}#{instanceId} 作为语音成员键，多个页面互不
 * 顶替、作为独立语音成员存在。游客本就按连接区分，不受影响。
 */
const INSTANCE_KEY = 'zviewer-voice-instance-id'

/**
 * 当前标签页的语音实例 ID（恒返回）。
 * 惰性生成并写入 sessionStorage：同一标签页刷新保持稳定（服务端
 * 重连顶替语义正确——同标签页的新连接顶替旧连接），不同标签页互异。
 * 存储不可用（隐私模式等）时退化为每次页面加载随机生成——刷新后
 * 会以新实例身份顶替旧条目，语义仍正确。
 */
export function getVoiceInstanceId(): string {
  try {
    let id = sessionStorage.getItem(INSTANCE_KEY)
    if (!id) {
      id = Math.random().toString(36).slice(2, 10)
      sessionStorage.setItem(INSTANCE_KEY, id)
    }
    return id
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}
