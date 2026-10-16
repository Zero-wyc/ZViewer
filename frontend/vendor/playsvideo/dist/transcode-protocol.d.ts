import type { FfmpegTranscodeMetrics } from './pipeline/audio-transcode.js';
export interface ConnectTranscodeWorkerMessage {
    type: 'connect';
}
export type TranscodeWorkerPhase = 'starting' | 'idle' | 'loading-codec' | 'transcoding' | 'error';
export interface TranscodeWorkerSnapshot {
    phase: TranscodeWorkerPhase;
    sourceCodec: string | null;
    jobId: number | null;
    inputBytes: number | null;
    outputBytes: number | null;
    totalMs: number | null;
    ffmpegMs: number | null;
    jobsCompleted: number;
    lastError: string | null;
}
export interface TranscodePortMessage {
    type: 'transcode-port';
    id: number;
}
export interface TranscodeJobRequest {
    type: 'transcode-job';
    jobId: number;
    inputData: ArrayBuffer;
    sourceCodec?: string;
}
export interface TranscodeJobSuccess {
    type: 'transcode-result';
    jobId: number;
    ok: true;
    outputData: ArrayBuffer;
    metrics: FfmpegTranscodeMetrics;
}
export interface TranscodeJobFailure {
    type: 'transcode-result';
    jobId: number;
    ok: false;
    error: string;
}
export type TranscodeJobResponse = TranscodeJobSuccess | TranscodeJobFailure;
export interface TranscodeWorkerStateMessage {
    type: 'worker-state';
    state: TranscodeWorkerSnapshot;
}
//# sourceMappingURL=transcode-protocol.d.ts.map