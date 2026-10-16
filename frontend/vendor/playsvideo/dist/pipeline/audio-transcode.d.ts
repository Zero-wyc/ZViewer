import { EncodedPacket } from 'mediabunny';
import type { FfmpegRunner } from './types.js';
export interface TranscodeOptions {
    packets: EncodedPacket[];
    sampleRate: number;
    /** Timestamp of the first original audio packet — used as base for transcoded timestamps */
    audioStartSec: number;
    /** Source audio codec (e.g. 'ac3', 'mp3'). Determines ffmpeg input format. Defaults to 'ac3'. */
    sourceCodec?: string;
}
export type AudioTranscodeExecutor = (opts: TranscodeOptions, signal?: AbortSignal) => Promise<TranscodeResult>;
export interface FfmpegTranscodeMetrics {
    writeMs: number;
    ffmpegMs: number;
    readMs: number;
    cleanupMs: number;
    /** ffmpeg-reported realtime multiplier (e.g. 63 = 63x realtime), null if not parseable */
    ffmpegSpeed: number | null;
    /** ffmpeg-reported output duration in ms, null if not parseable */
    ffmpegTimeMs: number | null;
}
export interface RawAudioTranscodeResult {
    aacData: Uint8Array;
    metrics: FfmpegTranscodeMetrics;
}
export interface TranscodeMetrics {
    inputPackets: number;
    inputBytes: number;
    /** Duration of input audio (last packet end - first packet start) */
    audioDurationSec: number;
    /** Phase timings in milliseconds */
    concatMs: number;
    writeMs: number;
    ffmpegMs: number;
    readMs: number;
    cleanupMs: number;
    parseMs: number;
    totalMs: number;
    outputPackets: number;
    outputBytes: number;
    /** Duration computed from output frame count */
    outputDurationSec: number;
    /** ffmpeg-reported realtime multiplier (e.g. 63 = 63x realtime), null if not parseable */
    ffmpegSpeed: number | null;
    /** ffmpeg-reported output duration in ms, null if not parseable */
    ffmpegTimeMs: number | null;
    /** totalMs / (audioDurationSec * 1000) — values <1 mean faster than realtime */
    realtimeRatio: number;
}
export interface TranscodeResult {
    packets: EncodedPacket[];
    decoderConfig: AudioDecoderConfig;
    metrics: TranscodeMetrics;
}
export declare function makeAacDecoderConfig(sourceConfig: AudioDecoderConfig | null): AudioDecoderConfig;
export declare function createLocalAudioTranscoder(ffmpeg: FfmpegRunner): AudioTranscodeExecutor;
export declare function createEmptyTranscodeResult(sampleRate: number): TranscodeResult;
export declare function concatEncodedPacketData(packets: EncodedPacket[]): {
    data: Uint8Array;
    inputBytes: number;
    audioDurationSec: number;
};
export declare function packetsFromAdtsData(aacData: Uint8Array, sampleRate: number, audioStartSec: number): {
    packets: EncodedPacket[];
    decoderConfig: AudioDecoderConfig;
    parseMs: number;
    outputBytes: number;
    outputDurationSec: number;
};
export declare function buildTranscodeResultFromAdts(params: {
    inputPackets: number;
    inputBytes: number;
    audioDurationSec: number;
    concatMs: number;
    sampleRate: number;
    audioStartSec: number;
    aacData: Uint8Array;
    ffmpegMetrics: FfmpegTranscodeMetrics;
    totalMs: number;
}): TranscodeResult;
export declare function runFfmpegAudioTranscode(opts: {
    ffmpeg: FfmpegRunner;
    inputData: Uint8Array;
    sourceCodec?: string;
}): Promise<RawAudioTranscodeResult>;
export declare function transcodeAudioSegment(opts: TranscodeOptions & {
    ffmpeg: FfmpegRunner;
}): Promise<TranscodeResult>;
//# sourceMappingURL=audio-transcode.d.ts.map