import { ALL_FORMATS, BlobSource, EncodedPacketSink, FilePathSource, Input, Source as MBSource, UrlSource, } from 'mediabunny';
import { getSubtitleTrackInfos } from './subtitle.js';
export async function demuxFile(filePath) {
    return demuxInput(new Input({ formats: ALL_FORMATS, source: new FilePathSource(filePath) }));
}
export async function demuxBlob(blob) {
    return demuxInput(new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) }));
}
export async function demuxUrl(url) {
    return demuxInput(new Input({ formats: ALL_FORMATS, source: new UrlSource(url) }));
}
class SourceAdapter extends MBSource {
    _inner;
    constructor(_inner) {
        super();
        this._inner = _inner;
    }
    _retrieveSize() {
        return this._inner._retrieveSize();
    }
    _read(start, end) {
        return this._inner._read(start, end);
    }
    _dispose() {
        this._inner._dispose();
    }
}
export async function demuxSource(source) {
    return demuxInput(new Input({ formats: ALL_FORMATS, source: new SourceAdapter(source) }));
}
/**
 * [本地补丁] playsvideo 管线（fMP4 + MSE，必要时经 wasm ffmpeg 转 AAC）真正
 * 能处理的音频编码白名单。
 *
 * 与两个能力边界严格对齐：
 * - `adapters/wasm-ffmpeg.js` 的 `AUDIO_TIER_CODECS`（ac3/eac3/dts/mp3/flac/opus），
 *   该 tier 之外一律走 `full`，而 `FULL_TIER_ENABLED = false` → 转码必抛
 *   `Full ffmpeg tier is not currently enabled`；
 * - MSE 原生可播的编码（aac/mp3/flac 等）无需转码，直接透传。
 *
 * 白名单而非黑名单的理由：mediabunny 1.66 起把 `truehd` 认定为已知编码并
 * 给出 decoderConfig（codec string 为 `mlpa`），playsvideo 只看
 * `audioCodec !== null` 就判 `doTranscode = true`，结果把 TrueHD 送进没有
 * 对应解码器的 wasm ffmpeg —— 整片播放失败。同类风险还包括 vorbis、PCM
 * （MSE 不支持 fMP4 内的 PCM，wasm 也无解）。新编码默认跳过、退化为静音，
 * 比整片崩掉更可控。
 */
const PIPELINE_AUDIO_CODECS = new Set([
    'aac',
    'opus',
    'mp3',
    'flac',
    'ac3',
    'eac3',
    'dts',
]);

/**
 * [本地补丁] 从一组音轨里挑出「能真正被 muxer 使用」的第一条。
 *
 * 判据是让整条管线能跑通的三个硬条件：`codec` 可识别、`getDecoderConfig()`
 * 能返回非空配置、编码在 PIPELINE_AUDIO_CODECS 内。任一不满足即跳过——
 * 上游把「轨道存在」当成「可用」，对 Dolby TrueHD/Atmos（A_TRUEHD）不成立。
 *
 * 单独导出便于单测：入参是鸭子类型的音轨数组（codec / internalCodecId /
 * getDecoderConfig），不需要真实容器。
 */
export async function pickPlayableAudioTrack(tracks) {
    const unsupportedCodecIds = [];
    for (const track of tracks) {
        if (!track.codec) {
            // mediabunny 未登记的容器 CodecID（旧版对 A_TRUEHD 即如此）
            unsupportedCodecIds.push(track.internalCodecId ?? null);
            continue;
        }
        if (!PIPELINE_AUDIO_CODECS.has(track.codec)) {
            // 能 demux 但既不能直传 MSE、也没有对应 ffmpeg 解码器（truehd / vorbis / pcm…）
            unsupportedCodecIds.push(track.internalCodecId ?? track.codec);
            continue;
        }
        let config = null;
        try {
            config = await track.getDecoderConfig();
        }
        catch {
            config = null;
        }
        if (!config) {
            unsupportedCodecIds.push(track.internalCodecId ?? track.codec);
            continue;
        }
        return { track, config, unsupportedCodecIds };
    }
    return { track: null, config: null, unsupportedCodecIds };
}
async function demuxInput(input) {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
        throw new Error('No video track found');
    }
    // [本地补丁] 音轨择优 + 不可处理音轨的显式降级。
    //
    // 上游只取 primary 音轨，并假定「轨道存在 ⇒ codec 与 decoderConfig 可用」。
    // 两种失败形态：
    // 1. mediabunny 1.38 及更早不认的 CodecID（当时含 A_TRUEHD）→ info.codec
    //    为 null → getDecoderConfig() 返回 null → 上游以 `audioCodec !== null`
    //    为前置条件的 doTranscode 判为 false → 把没有 decoderConfig 的音频包
    //    送进 fMP4 muxer → `TypeError: Audio chunk metadata must be provided.`
    // 2. mediabunny 1.66 起认了 truehd（decoderConfig codec 为 `mlpa`），配置
    //    非空 ⇒ doTranscode = true ⇒ 送进只有 audio tier 的 wasm ffmpeg ⇒
    //    `Full ffmpeg tier is not currently enabled`，同样整片失败。
    // 两者都让「视频完好、只有音轨不认识」变成全片报错。
    //
    // 处理：按容器顺序挑选第一条「codec 可识别 + 有 decoderConfig + 在
    // PIPELINE_AUDIO_CODECS 内」的音轨。主音轨不可用时自动退到后续兼容轨
    // （remux 常见 TrueHD 7.1 + AC-3 5.1），全部不可用则按「无音轨」降级——
    // 视频照播，audioDropped 透出原因供上层提示。
    let audioTracks = [];
    try {
        audioTracks = await input.getAudioTracks();
    }
    catch {
        // 音轨枚举失败按无音轨处理，不能拖垮视频
        audioTracks = [];
    }
    const picked = await pickPlayableAudioTrack(audioTracks);
    const audioTrack = picked.track;
    const audioDecoderConfig = picked.config;
    const audioDropped = audioTracks.length > 0 && !audioTrack
        ? {
            reason: 'unsupported-codec',
            trackCount: audioTracks.length,
            codecIds: picked.unsupportedCodecIds,
        }
        : null;
    const videoCodec = videoTrack.codec;
    if (!videoCodec) {
        throw new Error('Could not determine video codec');
    }
    const videoSink = new EncodedPacketSink(videoTrack);
    const audioSink = audioTrack ? new EncodedPacketSink(audioTrack) : null;
    const duration = Number(await videoTrack.computeDuration());
    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    if (!videoDecoderConfig) {
        throw new Error('Could not get video decoder config');
    }
    let subtitleTracks = [];
    try {
        subtitleTracks = await getSubtitleTrackInfos(input);
    } catch {
        // 上游 mediabunny（>=1.40）的 Input 不再暴露字幕轨（getSubtitleTracks
        // 是 kzahel fork 的私有 API）。字幕探测失败绝不能拖垮整个 demux——
        // 否则这里抛错会让 DemuxResult 连同 audioSink 一起丢失，视频变成
        // 无声播放。降级为无字幕轨。
    }
    return {
        input,
        duration,
        videoTrack,
        audioTrack,
        videoCodec,
        audioCodec: audioTrack?.codec ?? null,
        videoDecoderConfig,
        audioDecoderConfig,
        videoSink,
        audioSink,
        audioTrackCount: audioTracks.length,
        audioDropped,
        subtitleTracks,
        dispose: () => input.dispose(),
    };
}
export async function getKeyframeIndex(videoSink, duration) {
    const keyframes = [];
    // getKeyPacket(0) returns null if the first keyframe has PTS > 0 (non-zero
    // initial offset). Fall back to getFirstPacket() which always works.
    let packet = await videoSink.getKeyPacket(0, { metadataOnly: true });
    if (!packet) {
        const first = await videoSink.getFirstPacket();
        if (first?.type === 'key')
            packet = first;
    }
    while (packet) {
        const ts = packet.timestamp;
        if (Number.isFinite(ts) && ts >= 0) {
            keyframes.push({ timestamp: ts, sequenceNumber: packet.sequenceNumber });
        }
        const next = await videoSink.getNextKeyPacket(packet, {
            metadataOnly: true,
        });
        if (!next || next.sequenceNumber === packet.sequenceNumber)
            break;
        packet = next;
    }
    return { duration, keyframes };
}
export async function collectPacketsInRange(sink, startSec, endSec, opts) {
    const packets = [];
    let packet = null;
    if (opts?.startFromKeyframe) {
        packet = await sink.getKeyPacket(startSec);
    }
    else {
        packet = await sink.getPacket(startSec);
    }
    if (!packet) {
        packet = await sink.getFirstPacket();
    }
    if (!packet)
        return packets;
    // Collect packets until we reach endSec
    while (packet) {
        if (packet.timestamp >= endSec)
            break;
        if (!packet.isMetadataOnly && packet.timestamp >= 0) {
            packets.push(packet);
        }
        const next = await sink.getNextPacket(packet);
        if (!next || next.sequenceNumber === packet.sequenceNumber)
            break;
        packet = next;
    }
    return packets;
}
//# sourceMappingURL=demux.js.map