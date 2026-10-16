export interface KeyframeEntry {
    timestamp: number;
    sequenceNumber: number;
}
export interface KeyframeIndex {
    duration: number;
    keyframes: KeyframeEntry[];
}
export interface PlannedSegment {
    sequence: number;
    uri: string;
    startSec: number;
    durationSec: number;
}
export interface PlaylistEntry {
    uri: string;
    durationSec: number;
    discontinuity?: boolean;
}
export interface PlaylistSpec {
    targetDuration: number;
    mediaSequence: number;
    entries: PlaylistEntry[];
    endList: boolean;
    mapUri?: string;
}
export interface FfmpegRunner {
    run(args: string[]): Promise<{
        exitCode: number;
        stderr: string;
    }>;
    writeInput(name: string, data: Uint8Array): Promise<void>;
    readOutput(name: string): Promise<Uint8Array>;
    deleteFile?(name: string): Promise<void>;
}
export interface ProbeStream {
    index: number;
    codecType: 'video' | 'audio' | 'subtitle' | 'data';
    codecName: string;
    width?: number;
    height?: number;
    sampleRate?: number;
    channels?: number;
    duration?: number;
}
export interface ProbeResult {
    format: string;
    duration: number;
    bitRate?: number;
    streams: ProbeStream[];
}
export interface AdtsFrame {
    data: Uint8Array;
    frameSize: number;
    sampleRate: number;
    channels: number;
}
/** Metadata for a discovered subtitle track (sent to main thread before extraction). */
export interface SubtitleTrackInfo {
    /** Index within the subtitle tracks array (0-based). */
    index: number;
    /** Original codec in the container. */
    codec: string;
    /** ISO 639-2/T language code (e.g. 'eng', 'spa', 'und'). */
    language: string;
    /** User-visible track name, if any. */
    name: string | null;
    /** Container disposition flags — use to decide <track kind>. */
    disposition: {
        default: boolean;
        forced: boolean;
        hearingImpaired: boolean;
    };
}
/**
 * Source of a subtitle track — either embedded in the file or imported by the user.
 * This is the internal representation; the renderer decides what to do with it.
 */
export interface SubtitleData {
    /** The cue list (format-agnostic). */
    cues: SubtitleCueEntry[];
    /** Original codec so the renderer can choose strategy. */
    codec: string;
    /** Format-specific header (ASS [V4+ Styles] section, WebVTT preamble, etc). */
    header?: string;
}
/** Single subtitle cue — mirrors mediabunny's SubtitleCue but cleaned up for our use. */
export interface SubtitleCueEntry {
    /** Start time in seconds. */
    startSec: number;
    /** End time in seconds. */
    endSec: number;
    /** Cue text content (may contain format-specific markup like ASS override tags). */
    text: string;
    /** Optional VTT positioning/settings string. */
    settings?: string;
}
//# sourceMappingURL=types.d.ts.map