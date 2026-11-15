// 本机麦克风电平的共享读数口。
//
// 为什么需要这一层：语音控制器（`useVoiceChat`）活在语音面板里，而 Live2D
// 角色在房间页的另一棵子树——拿不到 hook 的返回值。唯一体面的共享点是
// **已经建好的那个 AnalyserNode**：再开一次 getUserMedia 会亮第二盏麦克风灯、
// 部分系统上还会抢占设备，代价远大于共享一个节点引用。
//
// 谁发布：两条语音实现（Piik / SFU）在采集建好 analyser 时发布，停止采集、
// 或者把麦克风静音时发布 null。**静音必须发布 null**——静音的含义就是
// 「别人听不到我」，如果这时角色还在按嘴型说话，等于把静音这件事卖了。
//
// 谁消费：Live2D 的语音口型（15Hz 读一次）。

let node: AnalyserNode | null = null
// 缓冲区复用：15Hz 读一次，每帧新建一个 Uint8Array 是白白的垃圾。
// 类型靠初始化推断（new Uint8Array 是 ArrayBuffer 背书的定长视图），
// 显式写成 Uint8Array 会被放宽成 ArrayBufferLike，getByteTimeDomainData 不收。
let buffer = new Uint8Array(0)

/** 发布/清除本机麦克风的观测节点。传 null 表示「现在没有可用的麦克风电平」。 */
export function publishMicAnalyser(analyser: AnalyserNode | null): void {
  node = analyser
  // 缓冲区随节点作废：不同节点的 fftSize 可能不同，复用会拿到半截数据
  buffer = new Uint8Array(0)
}

/** 当前是否有可用的麦克风电平（已加入语音、未静音、采集成功）。 */
export function hasMicLevel(): boolean {
  return node !== null
}

/**
 * 读一次本机麦克风电平（0~1）。
 *
 * 口径与语音面板的音量表一致（时域 RMS × 4，夹到 0~1）：同一个麦克风在
 * 两个地方显示不同的"响度"只会让人怀疑其中一个是错的。
 */
export function readMicLevel(): number {
  const analyser = node
  if (!analyser) return 0
  const size = analyser.fftSize
  if (size <= 0) return 0
  if (buffer.length !== size) buffer = new Uint8Array(size)
  analyser.getByteTimeDomainData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const v = (buffer[i] - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4)
}
