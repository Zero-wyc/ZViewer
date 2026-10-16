import { type CodecProber } from './codec-probe.js';
import type { FfmpegRunner } from './types.js';
export interface PipelineOptions {
    filePath: string;
    ffmpeg: FfmpegRunner;
    targetSegmentDuration?: number;
    codecProber?: CodecProber;
}
export interface PipelineSegment {
    index: number;
    data: Uint8Array;
    durationSec: number;
    startSec: number;
}
export interface PipelineResult {
    init: Uint8Array;
    segments: PipelineSegment[];
    playlist: string;
    totalDurationSec: number;
}
export declare function runPipeline(opts: PipelineOptions): Promise<PipelineResult>;
//# sourceMappingURL=pipeline.d.ts.map