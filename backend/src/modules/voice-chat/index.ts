/**
 * 语音聊天模块（LiveKit 版）。
 *
 * 实时音频由独立 LiveKit 服务承载；本模块仅保留 REST 路由
 * （签发接入凭证 / 管理员禁言 / 踢出），见 routes/voice.routes.ts。
 */
export { default as voiceRoutes } from '../../routes/voice.routes';
