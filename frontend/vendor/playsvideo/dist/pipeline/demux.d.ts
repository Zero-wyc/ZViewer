import { type EncodedPacket, EncodedPacketSink, Input, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import type { Source } from '../source.js';
import type { KeyframeIndex, SubtitleTrackInfo } from './types.js';
export interface DemuxResult {
    input: Input;
    duration: number;
    /** [本地补丁] 纯音频容器没有视频轨，以下五项可能为 null */
    videoTrack: InputVideoTrack | null;
    audioTrack: InputAudioTrack | null;
    videoCodec: string | null;
    audioCodec: string | null;
    videoDecoderConfig: VideoDecoderConfig | null;
    audioDecoderConfig: AudioDecoderConfig | null;
    videoSink: EncodedPacketSink | null;
    audioSink: EncodedPacketSink | null;
    /** [本地补丁] 容器内音轨总数（含被丢弃的） */
    audioTrackCount?: number;
    /** [本地补丁] 全部音轨都不可用时的丢弃原因，见 engine.d.ts 的 AudioDroppedInfo */
    audioDropped?: {
        reason: 'unsupported-codec';
        trackCount: number;
        codecIds: (string | null)[];
    } | null;
    subtitleTracks: SubtitleTrackInfo[];
    dispose: () => void;
}
export declare function demuxFile(filePath: string): Promise<DemuxResult>;
export declare function demuxBlob(blob: Blob): Promise<DemuxResult>;
export declare function demuxUrl(url: string): Promise<DemuxResult>;
export declare function demuxSource(source: Source): Promise<DemuxResult>;
export declare function getKeyframeIndex(videoSink: EncodedPacketSink | null, duration: number): Promise<KeyframeIndex>;
export declare function collectPacketsInRange(sink: EncodedPacketSink | null, startSec: number, endSec: number, opts?: {
    startFromKeyframe?: boolean;
}): Promise<EncodedPacket[]>;
/** [本地补丁] 挑出第一条 codec 可识别且能取到 decoderConfig 的音轨（不可用则返回 null） */
export declare function pickPlayableAudioTrack<T extends {
    codec: string | null;
    internalCodecId?: string | null;
    getDecoderConfig: () => Promise<unknown>;
}>(tracks: T[]): Promise<{
    track: T | null;
    config: AudioDecoderConfig | null;
    unsupportedCodecIds: (string | null)[];
}>;
//# sourceMappingURL=demux.d.ts.map