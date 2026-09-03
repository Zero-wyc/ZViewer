/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Base class representing an input media file format.
 * @group Input formats
 * @public
 */
export declare abstract class InputFormat {
    /** Returns the name of the input format. */
    abstract get name(): string;
    /** Returns the typical base MIME type of the input format. */
    abstract get mimeType(): string;
}
/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @group Input formats
 * @public
 */
export declare abstract class IsobmffInputFormat extends InputFormat {
}
/**
 * MPEG-4 Part 14 (MP4) file format.
 *
 * Do not instantiate this class; use the {@link MP4} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class Mp4InputFormat extends IsobmffInputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * QuickTime File Format (QTFF), often called MOV.
 *
 * Do not instantiate this class; use the {@link QTFF} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class QuickTimeInputFormat extends IsobmffInputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * Matroska file format.
 *
 * Do not instantiate this class; use the {@link MATROSKA} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class MatroskaInputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * WebM file format, based on Matroska.
 *
 * Do not instantiate this class; use the {@link WEBM} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class WebMInputFormat extends MatroskaInputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * MP3 file format.
 *
 * Do not instantiate this class; use the {@link MP3} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class Mp3InputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * WAVE file format, based on RIFF.
 *
 * Do not instantiate this class; use the {@link WAVE} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class WaveInputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * Ogg file format.
 *
 * Do not instantiate this class; use the {@link OGG} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class OggInputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * FLAC file format.
 *
 * Do not instantiate this class; use the {@link FLAC} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class FlacInputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * ADTS file format.
 *
 * Do not instantiate this class; use the {@link ADTS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class AdtsInputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * MPEG Transport Stream (MPEG-TS) file format.
 *
 * Do not instantiate this class; use the {@link MPEG_TS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export declare class MpegTsInputFormat extends InputFormat {
    get name(): string;
    get mimeType(): string;
}
/**
 * MP4 input format singleton.
 * @group Input formats
 * @public
 */
export declare const MP4: Mp4InputFormat;
/**
 * QuickTime File Format input format singleton.
 * @group Input formats
 * @public
 */
export declare const QTFF: QuickTimeInputFormat;
/**
 * Matroska input format singleton.
 * @group Input formats
 * @public
 */
export declare const MATROSKA: MatroskaInputFormat;
/**
 * WebM input format singleton.
 * @group Input formats
 * @public
 */
export declare const WEBM: WebMInputFormat;
/**
 * MP3 input format singleton.
 * @group Input formats
 * @public
 */
export declare const MP3: Mp3InputFormat;
/**
 * WAVE input format singleton.
 * @group Input formats
 * @public
 */
export declare const WAVE: WaveInputFormat;
/**
 * Ogg input format singleton.
 * @group Input formats
 * @public
 */
export declare const OGG: OggInputFormat;
/**
 * ADTS input format singleton.
 * @group Input formats
 * @public
 */
export declare const ADTS: AdtsInputFormat;
/**
 * FLAC input format singleton.
 * @group Input formats
 * @public
 */
export declare const FLAC: FlacInputFormat;
/**
 * MPEG-TS input format singleton.
 * @group Input formats
 * @public
 */
export declare const MPEG_TS: MpegTsInputFormat;
/**
 * List of all input format singletons. If you don't need to support all input formats, you should specify the
 * formats individually for better tree shaking.
 * @group Input formats
 * @public
 */
export declare const ALL_FORMATS: InputFormat[];
//# sourceMappingURL=input-format.d.ts.map