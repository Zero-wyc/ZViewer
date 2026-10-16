import type { EncodedPacketSink } from 'mediabunny';
import type { AudioTranscodeExecutor } from './audio-transcode.js';
import type { PlannedSegment } from './types.js';
export interface SegmentProcessorConfig {
    videoSink: EncodedPacketSink;
    audioSink: EncodedPacketSink | null;
    videoCodec: string;
    audioCodec: string | null;
    videoDecoderConfig: VideoDecoderConfig;
    audioDecoderConfig: AudioDecoderConfig | null;
    plan: PlannedSegment[];
    doTranscode: boolean;
    transcodeAudio: AudioTranscodeExecutor;
    sourceCodec?: string;
    log?: (msg: string) => void;
}
export interface SegmentProcessorResult {
    mediaData: Uint8Array;
    initSegment: Uint8Array | null;
    /** Updated audioDecoderConfig if transcode changed it */
    audioDecoderConfig: AudioDecoderConfig | null;
}
/**
 * Processes a single segment through the pipeline: collect packets → transcode → mux.
 *
 * Accepts an AbortSignal and checks it between stages. If aborted, throws AbortError.
 * Does NOT modify any shared mutable state — returns all results.
 */
export declare function processSegmentWithAbort(config: SegmentProcessorConfig, index: number, signal?: AbortSignal): Promise<SegmentProcessorResult>;
//# sourceMappingURL=segment-processor.d.ts.map