import { type EncodedPacket, EncodedPacketSink, Input, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import type { Source } from '../source.js';
import type { KeyframeIndex, SubtitleTrackInfo } from './types.js';
export interface DemuxResult {
    input: Input;
    duration: number;
    videoTrack: InputVideoTrack;
    audioTrack: InputAudioTrack | null;
    videoCodec: string;
    audioCodec: string | null;
    videoDecoderConfig: VideoDecoderConfig;
    audioDecoderConfig: AudioDecoderConfig | null;
    videoSink: EncodedPacketSink;
    audioSink: EncodedPacketSink | null;
    subtitleTracks: SubtitleTrackInfo[];
    dispose: () => void;
}
export declare function demuxFile(filePath: string): Promise<DemuxResult>;
export declare function demuxBlob(blob: Blob): Promise<DemuxResult>;
export declare function demuxUrl(url: string): Promise<DemuxResult>;
export declare function demuxSource(source: Source): Promise<DemuxResult>;
export declare function getKeyframeIndex(videoSink: EncodedPacketSink, duration: number): Promise<KeyframeIndex>;
export declare function collectPacketsInRange(sink: EncodedPacketSink, startSec: number, endSec: number, opts?: {
    startFromKeyframe?: boolean;
}): Promise<EncodedPacket[]>;
//# sourceMappingURL=demux.d.ts.map