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
async function demuxInput(input) {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
        throw new Error('No video track found');
    }
    let audioTrack = null;
    try {
        audioTrack = await input.getPrimaryAudioTrack();
    }
    catch {
        // No audio track — that's fine
    }
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
    let audioDecoderConfig = null;
    if (audioTrack) {
        audioDecoderConfig = await audioTrack.getDecoderConfig();
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