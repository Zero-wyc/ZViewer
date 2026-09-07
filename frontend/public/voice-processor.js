/**
 * Voice Processor — AudioWorklet 处理器
 *
 * 在音频线程中采集 PCM 样本，累积到指定帧数后通过 port.postMessage
 * 发送到主线程，由主线程通过 Socket.IO 发往服务器中转。
 *
 * 参数：
 * - frameSize：每次发送的样本数（默认 960，即 20ms @ 48kHz，匹配 Opus 编码帧）
 *
 * 数据格式：Float32Array（单声道），通过 Transferable ArrayBuffer 传输
 */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const config = (options && options.processorOptions) || {}
    this._frameSize = config.frameSize || 960
    this._buffer = new Float32Array(this._frameSize)
    this._offset = 0
    this._enabled = true

    // 监听主线程指令（启用/禁用采集）
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === 'boolean') {
        this._enabled = e.data.enabled
      }
    }
  }

  process(inputs) {
    // 麦克风禁用时不采集，避免发送静音数据浪费带宽。
    // 同时清空半帧残留：重开麦克风后的第一帧必须是全新样本，
    // 否则会拼接"闭麦前的旧音频尾巴 + 新音频"产生爆音
    if (!this._enabled) {
      this._offset = 0
      return true
    }

    const input = inputs[0]
    if (!input || !input[0]) {
      return true
    }

    const channelData = input[0] // Float32Array, 128 samples

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._offset++] = channelData[i]

      if (this._offset >= this._frameSize) {
        // 缓冲区满，发送数据副本（postMessage 会 transfer ArrayBuffer）
        const copy = new Float32Array(this._frameSize)
        copy.set(this._buffer)
        this.port.postMessage(copy.buffer, [copy.buffer])
        this._offset = 0
      }
    }

    return true
  }
}

registerProcessor('voice-processor', VoiceProcessor)
