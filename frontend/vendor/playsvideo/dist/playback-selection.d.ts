export type PlaybackMode = 'hls' | 'direct-url' | 'direct-bytes';
export interface HlsPlaybackOption {
    mode: 'hls';
    id?: string;
}
export interface DirectPlaybackOption {
    mode: 'direct-url' | 'direct-bytes';
    id?: string;
    url?: string;
    mimeType: string | null;
}
export type PlaybackOption = HlsPlaybackOption | DirectPlaybackOption;
export interface PlaybackMediaMetadata {
    /**
     * Container-level short codec names from demux (e.g. `avc`, `ac3`).
     * These are the inputs used by the remux/HLS pipeline heuristics.
     */
    sourceVideoCodec: string | null;
    sourceAudioCodec: string | null;
    /**
     * Full decoder config codec strings (e.g. `avc1.640028`, `mp4a.40.2`).
     * These are the inputs used for direct/native `canPlayType()` checks.
     */
    videoCodec: string | null;
    audioCodec: string | null;
}
export type CanPlayTypeResult = '' | 'maybe' | 'probably';
export interface PipelinePlaybackProbe {
    canPlayAudio(shortCodec: string, fullCodecString?: string): boolean;
    canPlayVideo(shortCodec: string, fullCodecString?: string): boolean;
}
export interface PlaybackCapabilityContext {
    canPlayType?: (mimeType: string) => CanPlayTypeResult;
    hlsSupported?: boolean;
    pipelineProbe?: PipelinePlaybackProbe;
}
export interface BrowserPlaybackCapabilityOptions {
    hlsSupported?: boolean;
    pipelineProbe?: PipelinePlaybackProbe;
}
export type PlaybackDiagnosticCode = 'direct-missing-capability' | 'direct-missing-mime-type' | 'direct-missing-video-codec' | 'direct-supported' | 'direct-unsupported' | 'hls-missing-capability' | 'hls-runtime-unsupported' | 'hls-missing-video-codec' | 'hls-video-supported' | 'hls-video-unsupported' | 'hls-audio-supported' | 'hls-audio-transcode' | 'hls-no-audio-track' | 'selected-direct' | 'selected-hls' | 'no-supported-option';
export interface PlaybackDiagnostic {
    code: PlaybackDiagnosticCode;
    message: string;
}
export type PlaybackOptionStatus = 'supported' | 'blocked' | 'unknown';
export interface PlaybackOptionEvaluation {
    option: PlaybackOption;
    status: PlaybackOptionStatus;
    selected: boolean;
    diagnostics: PlaybackDiagnostic[];
    directCanPlayType: CanPlayTypeResult | null;
    pipelineVideoSupported: boolean | null;
    pipelineAudioSupported: boolean | null;
    pipelineAudioRequiresTranscode: boolean | null;
}
export interface PlaybackRecommendation {
    option: PlaybackOption;
    reason: PlaybackDiagnostic;
}
export interface EvaluatePlaybackOptionsInput {
    options: PlaybackOption[];
    media: PlaybackMediaMetadata;
    capabilities: PlaybackCapabilityContext;
    preferenceOrder?: PlaybackMode[];
}
export interface PlaybackEvaluationResult {
    recommended: PlaybackRecommendation | null;
    evaluations: PlaybackOptionEvaluation[];
}
/**
 * Convenience helper for browser integrations.
 *
 * The returned object is plain data/functions, so `evaluatePlaybackOptions()`
 * stays pure and testable. The heuristics mirror the current engine split:
 * direct/native uses `canPlayType()`, while remux/HLS uses the pipeline codec
 * probe built on `MediaSource.isTypeSupported()`.
 */
export declare function createBrowserPlaybackCapabilities(video: Pick<HTMLVideoElement, 'canPlayType'>, options?: BrowserPlaybackCapabilityOptions): PlaybackCapabilityContext;
export declare function evaluatePlaybackOptions(input: EvaluatePlaybackOptionsInput): PlaybackEvaluationResult;
export declare function recommendPlaybackOption(input: EvaluatePlaybackOptionsInput): PlaybackRecommendation | null;
//# sourceMappingURL=playback-selection.d.ts.map