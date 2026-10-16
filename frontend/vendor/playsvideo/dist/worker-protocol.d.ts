export type WorkerSegmentPhase = 'queued' | 'prefetching' | 'processing' | 'ready' | 'cache-hit' | 'aborted' | 'error';
export interface WorkerSegmentStateMessage {
    type: 'segment-state';
    index: number;
    phase: WorkerSegmentPhase;
    sizeBytes?: number;
    message?: string;
}
export type WorkerSubtitlePhase = 'starting' | 'reading-cues' | 'exporting-text';
export interface WorkerSubtitleProgressMessage {
    type: 'subtitle-progress';
    trackIndex: number;
    phase: WorkerSubtitlePhase;
    codec: string;
    cuesRead: number;
    elapsedMs: number;
    queueDelayMs?: number;
}
//# sourceMappingURL=worker-protocol.d.ts.map