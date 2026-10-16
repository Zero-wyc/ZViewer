import type { Input } from 'mediabunny';
import type { SubtitleData, SubtitleTrackInfo } from './types.js';
export type SubtitleExtractionPhase = 'starting' | 'reading-cues' | 'exporting-text' | 'done';
export interface SubtitleExtractionProgress {
    trackIndex: number;
    codec: string;
    phase: SubtitleExtractionPhase;
    cuesRead: number;
    elapsedMs: number;
}
export interface ExtractSubtitleDataOptions {
    onProgress?: (progress: SubtitleExtractionProgress) => void;
}
/** Discover subtitle tracks from a demuxed input. Cheap — reads only metadata, no cue extraction. */
export declare function getSubtitleTrackInfos(input: Input): Promise<SubtitleTrackInfo[]>;
/** Extract all cues from a subtitle track and return cleaned SubtitleData. */
export declare function extractSubtitleData(input: Input, trackIndex: number, options?: ExtractSubtitleDataOptions): Promise<SubtitleData>;
/**
 * Convert SubtitleData to a WebVTT string suitable for a Blob URL.
 * Works for any source codec — ASS override tags are stripped to plain text.
 */
export declare function subtitleDataToWebVTT(data: SubtitleData): string;
/**
 * Parse a user-imported subtitle file into SubtitleData.
 * Supports .srt, .vtt, .ass/.ssa files.
 */
export declare function parseSubtitleFile(text: string, filename: string): SubtitleData;
//# sourceMappingURL=subtitle.d.ts.map