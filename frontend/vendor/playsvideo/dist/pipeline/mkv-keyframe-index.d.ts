import type { Source } from '../source.js';
import type { KeyframeIndex } from './types.js';
export interface MkvCuePoint {
    timestampMs: number;
}
export interface ParsedMkvCueIndex {
    cuePoints: MkvCuePoint[];
    durationSec: number | null;
}
export declare function buildMkvKeyframeIndexFromSource(source: Source): Promise<KeyframeIndex | null>;
export declare function buildMkvKeyframeIndexFromBlob(blob: Blob): Promise<KeyframeIndex | null>;
export declare function buildMkvKeyframeIndexFromUrl(url: string): Promise<KeyframeIndex | null>;
export declare function parseMkvCues(read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>, fileSize: number): Promise<MkvCuePoint[]>;
export declare function parseMkvCueIndex(read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>, fileSize: number): Promise<ParsedMkvCueIndex>;
//# sourceMappingURL=mkv-keyframe-index.d.ts.map