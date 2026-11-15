// 语音口型：把麦克风响度换算成「张嘴幅度」。
//
// 只驱动嘴，不碰眼、表情和歪头——语音里没有这些东西的对应物，硬造出来
// 只会得到一个"说话时不停挑眉"的模型。整脸动捕仍然优先（见 useLive2DPointer），
// 这条通路只在没有摄像头脸的时候生效。

/**
 * 噪声门：低于这个响度一律闭嘴。
 *
 * 电平口径与语音面板的音量表一致（RMS × 4，已夹到 0~1），房间底噪
 * （风扇、键盘、远端串音）大致落在 0.02~0.06；不定门的话不说话时嘴也在抖。
 */
export const LIVE2D_VOICE_NOISE_GATE = 0.06

/**
 * 响度 → 张嘴幅度（0~1）。
 *
 * 为什么开根号：人对响度的感知是压缩的，而嘴的张开量在画面上是线性的。
 * 直接线性映射的结果是「小声说话几乎不张嘴，一提高音量就瞬间张满」；
 * 开根号把中低音量抬起来，小声说话也有可见的口型。
 */
export function micLevelToMouth(level: number): number {
  if (!Number.isFinite(level) || level <= LIVE2D_VOICE_NOISE_GATE) return 0
  const span = 1 - LIVE2D_VOICE_NOISE_GATE
  const normalized = (level - LIVE2D_VOICE_NOISE_GATE) / span
  return Math.min(1, Math.sqrt(normalized))
}

/**
 * 口型变化小于该值就不上报。
 *
 * 和指针的阈值同一个道理：说话间隙的静音段每帧都在 0~0.01 之间抖，
 * 全发出去只是白占上行。静下来之后嘴会停在上一次的值上，超时（服务端
 * 与客户端的 TTL）自然释放回引擎。
 */
export const LIVE2D_VOICE_EPSILON = 0.03

/**
 * 持续发声的保活间隔。
 *
 * 只靠「变了才发」会有一个真实的坏情况：拖长一个元音时响度几乎不动，
 * 于是连续 600ms 不发 → 服务端 voiceAt 过期、行里不再带 m → 对方那里
 * 嘴在句子中间突然合上。所以发声期间按这个间隔无条件补一帧。
 *
 * 静音（值 = 0）不保活：嘴本来就该是闭的，不需要维持通道。
 */
export const LIVE2D_VOICE_KEEPALIVE_MS = 300
