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
 * [本地补丁] 从一组音轨里挑出「能真正被 muxer 使用」的第一条。
 *
 * 判据是让 muxer 能建轨的两个硬条件：`codec` 可识别、`getDecoderConfig()`
 * 能返回非空配置。任一不满足即跳过——上游把「轨道存在」当成「可用」，
 * 对 Dolby TrueHD/Atmos（A_TRUEHD）、MLP、ALAC 等 mediabunny 未登记的
 * 容器 CodecID 不成立，会一路把空配置送进 muxer 触发
 * `TypeError: Audio chunk metadata must be provided.`，整片失败。
 *
 * 单独导出便于单测：入参是鸭子类型的音轨数组（codec / internalCodecId /
 * getDecoderConfig），不需要真实容器。
 */
export async function pickPlayableAudioTrack(tracks) {
    const unsupportedCodecIds = [];
    for (const track of tracks) {
        if (!track.codec) {
            // mediabunny 未登记的容器 CodecID（如 A_TRUEHD）
            unsupportedCodecIds.push(track.internalCodecId ?? null);
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
    // 该假定对 TrueHD/Atmos（A_TRUEHD）、MLP、ALAC、WavPack 等 mediabunny
    // 未登记的 CodecID 不成立：轨道仍会出现在 getAudioTracks() 里，但
    // info.codec 为 null → getDecoderConfig() 返回 null → 上游后续以
    // `audioCodec !== null` 为前置条件的 doTranscode 判定为 false，于是把
    // 「没有 decoderConfig 的音频包」直接送进 fMP4 muxer，mediabunny 在
    // 建轨时抛 `TypeError: Audio chunk metadata must be provided.`，
    // 整部影片随之播放失败（视频本身完好）。
    //
    // 处理：按容器顺序挑选第一条「codec 可识别且能取到 decoderConfig」的音轨。
    // 主音轨不可用时自动退到后续兼容轨（remux 常见 TrueHD 7.1 + AC-3 5.1），
    // 全部不可用则按「无音轨」降级——视频照播，audioDropped 透出原因供上层提示。
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