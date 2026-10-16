import type { Source } from './source.js';
import { type PlaybackEvaluationResult, type PlaybackMediaMetadata, type PlaybackMode, type PlaybackOption } from './playback-selection.js';
import type { FfmpegRunner, KeyframeIndex, SubtitleTrackInfo } from './pipeline/types.js';
import type { TranscodeWorkerSnapshot } from './transcode-protocol.js';
export type EnginePhase = 'idle' | 'demuxing' | 'ready' | 'error';
export interface ReadyDetail {
    totalSegments: number;
    durationSec: number;
    subtitleTracks: SubtitleTrackInfo[];
    passthrough?: boolean;
    codecPath: CodecPath;
}
export interface ErrorDetail {
    message: string;
}
/** [本地补丁] worker 长耗时阶段心跳（probe/index/ffmpeg/seg0） */
export interface ProgressDetail {
    stage: string;
}
export interface LoadingDetail {
    file?: File;
    url?: string;
}
export interface SubtitleStatusDetail {
    message: string;
}
export interface WasmWorkerState extends TranscodeWorkerSnapshot {
    id: number;
}
export interface WorkerStateDetail {
    workers: WasmWorkerState[];
}
export interface PlaybackDecisionDetail {
    media: PlaybackMediaMetadata;
    evaluation: PlaybackEvaluationResult;
    playbackPolicy: PlaybackPolicy;
}
export type PlaybackPolicy = 'auto' | 'force-hls';
export type SegmentPhase = 'requested' | 'queued' | 'prefetching' | 'processing' | 'ready' | 'cache-hit' | 'delivered' | 'canceled' | 'aborted' | 'error';
export interface SegmentTimelineEvent {
    phase: SegmentPhase;
    atMs: number;
    sizeBytes: number | null;
    message: string | null;
}
export interface SegmentState {
    index: number;
    phase: SegmentPhase;
    requestCount: number;
    sizeBytes: number | null;
    latencyMs: number | null;
    error: string | null;
    prefetched: boolean;
    events: SegmentTimelineEvent[];
}
export interface SegmentStateDetail {
    segments: SegmentState[];
}
export type EmbeddedSubtitlePolicy = 'auto' | 'off';
export interface EngineOptions {
    /**
     * Number of internal audio transcode workers to create for worker-mode playback.
     * Use 0 to disable the pool and keep all transcode work inside the coordinator worker.
     */
    transcodeWorkers?: number;
    embeddedSubtitlePolicy?: EmbeddedSubtitlePolicy;
}
export interface LoadWithOptionsInput {
    source: Source;
    options: PlaybackOption[];
    ffmpeg?: FfmpegRunner;
    targetSegmentDuration?: number;
    preferenceOrder?: PlaybackMode[];
    playbackPolicy?: PlaybackPolicy;
}
export interface ExternalSubtitleOptions {
    label?: string;
    language?: string;
    kind?: 'subtitles' | 'captions';
}
export interface CodecDescriptor {
    short: string | null;
    full: string | null;
}
export interface CodecPath {
    mode: 'passthrough' | 'pipeline';
    sourceVideo: CodecDescriptor;
    sourceAudio: CodecDescriptor;
    outputVideo: CodecDescriptor;
    outputAudio: CodecDescriptor;
}
interface EngineEventMap {
    ready: CustomEvent<ReadyDetail>;
    error: CustomEvent<ErrorDetail>;
    progress: CustomEvent<ProgressDetail>;
    loading: CustomEvent<LoadingDetail>;
    'subtitle-status': CustomEvent<SubtitleStatusDetail>;
    workerstatechange: CustomEvent<WorkerStateDetail>;
    segmentstatechange: CustomEvent<SegmentStateDetail>;
    playbackdecision: CustomEvent<PlaybackDecisionDetail>;
}
export declare class PlaysVideoEngine extends EventTarget {
    readonly video: HTMLVideoElement;
    readonly options: Required<EngineOptions>;
    private worker;
    private transcodeWorkers;
    private _transcodeWorkerStates;
    private _segmentStates;
    private hls;
    private pendingSegments;
    private playlist;
    private initData;
    private pendingInit;
    private pendingPlaylist;
    private segmentRequestTimes;
    private subtitleRequestTimes;
    private attachedSubtitleTracks;
    private _subtitleTracks;
    private _phase;
    private _totalSegments;
    private _durationSec;
    private _passthrough;
    private _blobUrl;
    private _pendingFileType;
    private _codecPath;
    private _keyframeIndex;
    private _source;
    private _sourceDemux;
    private _sourcePlan;
    private _sourceDoTranscode;
    private _sourceAudioDecoderConfig;
    private _sourceInitSegment;
    private _sourceFfmpeg;
    private _sourceTargetSegDuration;
    private _sourceSegmentAbort;
    private _sourcePlaybackOptions;
    private _sourcePreferenceOrder;
    private _sourcePlaybackPolicy;
    private _lastInternalErrorMessage;
    private _lastInternalErrorAt;
    get phase(): EnginePhase;
    get loading(): boolean;
    get totalSegments(): number;
    get durationSec(): number;
    get subtitleTracks(): SubtitleTrackInfo[];
    get passthrough(): boolean;
    get codecPath(): CodecPath;
    get transcodeWorkerStates(): WasmWorkerState[];
    get segmentStates(): SegmentState[];
    /** [本地补丁] 最近一次 pipeline 本地构建的关键帧索引（prebuilt 传入时为 null），供上层复用缓存 */
    get builtKeyframeIndex(): KeyframeIndex | null;
    constructor(video: HTMLVideoElement, options?: EngineOptions);
    loadFile(file: File, opts?: {
        keyframeIndex?: KeyframeIndex;
    }): void;
    loadUrl(url: string, opts?: {
        keyframeIndex?: KeyframeIndex;
    }): void;
    loadExternalSubtitle(file: File, options?: ExternalSubtitleOptions): Promise<void>;
    clearExternalSubtitles(): void;
    /**
     * Load from an external Source (e.g. TorrentSource).
     *
     * Runs the pipeline on the main thread (no worker) because external Sources
     * typically need access to objects on the main thread.
     *
     * If the Source implements AbortableSource, the pipeline will call
     * setCurrentSignal() before each segment so the Source can abort in-flight
     * reads on seek.
     */
    loadSource(source: Source, opts?: {
        keyframeIndex?: KeyframeIndex;
        ffmpeg?: FfmpegRunner;
        targetSegmentDuration?: number;
    }): void;
    loadWithOptions(input: LoadWithOptionsInput): void;
    private reset;
    private createWorker;
    private ensureTranscodeWorkers;
    private destroyTranscodeWorkers;
    destroy(): void;
    addEventListener<K extends keyof EngineEventMap>(type: K, listener: (ev: EngineEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    private dispatchWorkerStateChange;
    private dispatchSegmentStateChange;
    private handleTranscodeWorkerMessage;
    private updateTranscodeWorkerState;
    private noteSegmentState;
    private handleWorkerSegmentState;
    private recordInternalError;
    private getRecentInternalError;
    private failPlayback;
    private createPlaybackCapabilities;
    private evaluateInitialPlayback;
    private evaluateHlsPlayback;
    private evaluateSourcePlayback;
    private getSourcePlaybackOptions;
    private logPlaybackDiagnostics;
    private dispatchPlaybackDecision;
    private throwPlaybackSelectionError;
    private failPlaybackSelection;
    private makeCodecPathFromSource;
    private startPassthrough;
    private handleWorkerMessage;
    private requestSegment;
    private cancelSegment;
    private startSourcePipeline;
    private makeSourceProcessorConfig;
    private requestSourceSegment;
    private startHls;
    private addSubtitleTrack;
    private removeSubtitleTracks;
    private showTextTrack;
    private dispatchSubtitleStatus;
    private requestEmbeddedSubtitleTrack;
    private handleWorkerSubtitleProgress;
    private formatSubtitleProgress;
    private extractEmbeddedSubtitlesFromDemux;
    private restoreDefaultTextTrack;
    private shouldAutoSelectEmbeddedSubtitle;
}
export {};
//# sourceMappingURL=engine.d.ts.map