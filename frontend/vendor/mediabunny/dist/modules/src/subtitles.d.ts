/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type { SubtitleCodec } from './codec.js.js';
/**
 * Represents a single subtitle cue with timing and text.
 * @group Media sources
 * @public
 */
export type SubtitleCue = {
    /** When the subtitle should appear, in seconds. */
    timestamp: number;
    /** How long the subtitle should be displayed, in seconds. */
    duration: number;
    /** The subtitle text content. */
    text: string;
    /** Optional cue identifier. */
    identifier?: string;
    /** Optional format-specific settings (e.g., VTT positioning). */
    settings?: string;
    /** Optional notes or comments. */
    notes?: string;
};
/**
 * Subtitle configuration data.
 * @group Media sources
 * @public
 */
export type SubtitleConfig = {
    /** Format-specific description (e.g., WebVTT preamble, ASS/SSA header). */
    description: string;
};
/**
 * Metadata associated with subtitle cues.
 * @group Media sources
 * @public
 */
export type SubtitleMetadata = {
    /** Optional subtitle configuration. */
    config?: SubtitleConfig;
};
type SubtitleParserOptions = {
    codec: SubtitleCodec;
    output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};
export declare const inlineTimestampRegex: RegExp;
export declare class SubtitleParser {
    private options;
    private preambleText;
    private preambleEmitted;
    constructor(options: SubtitleParserOptions);
    parse(text: string): void;
    private parseSrt;
    private parseAss;
    private parseWebVTT;
    private parseTx3g;
    private parseTtml;
}
/**
 * Parses an SRT timestamp string (HH:MM:SS,mmm) to seconds.
 * @group Media sources
 * @public
 */
export declare const parseSrtTimestamp: (timeString: string) => number;
/**
 * Formats seconds to SRT timestamp format (HH:MM:SS,mmm).
 * @group Media sources
 * @public
 */
export declare const formatSrtTimestamp: (seconds: number) => string;
/**
 * Splits SRT subtitle text into individual cues.
 * @group Media sources
 * @public
 */
export declare const splitSrtIntoCues: (text: string) => SubtitleCue[];
/**
 * Formats subtitle cues back to SRT text format.
 * @group Media sources
 * @public
 */
export declare const formatCuesToSrt: (cues: SubtitleCue[]) => string;
/**
 * Formats subtitle cues back to WebVTT text format.
 * @group Media sources
 * @public
 */
export declare const formatCuesToWebVTT: (cues: SubtitleCue[], preamble?: string) => string;
/**
 * Parses an ASS/SSA timestamp string (H:MM:SS.cc) to seconds.
 * @group Media sources
 * @public
 */
export declare const parseAssTimestamp: (timeString: string) => number;
/**
 * Formats seconds to ASS/SSA timestamp format (H:MM:SS.cc).
 * @group Media sources
 * @public
 */
export declare const formatAssTimestamp: (seconds: number) => string;
/**
 * Splits ASS/SSA subtitle text into header (styles) and individual cues.
 * Preserves all sections including [Fonts], [Graphics], and Aegisub sections.
 * Aegisub sections are moved to the end to avoid breaking [Events].
 * @group Media sources
 * @public
 */
export declare const splitAssIntoCues: (text: string) => {
    header: string;
    cues: SubtitleCue[];
};
/**
 * Formats subtitle cues back to ASS/SSA text format with header.
 * Properly inserts Dialogue/Comment lines within [Events] section.
 * @group Media sources
 * @public
 */
export declare const formatCuesToAss: (cues: SubtitleCue[], header: string) => string;
export {};
//# sourceMappingURL=subtitles.d.ts.map