/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { InputFormat } from './input-format.js';
import { Source } from './source.js';
/**
 * The options for creating an Input object.
 * @group Input files & tracks
 * @public
 */
export type InputOptions<S extends Source = Source> = {
    /** A list of supported formats. If the source file is not of one of these formats, then it cannot be read. */
    formats: InputFormat[];
    /** The source from which data will be read. */
    source: S;
};
/**
 * Represents an input media file. This is the root object from which all media read operations start.
 * @group Input files & tracks
 * @public
 */
export declare class Input<S extends Source = Source> implements Disposable {
    /** True if the input has been disposed. */
    get disposed(): boolean;
    /**
     * Creates a new input file from the specified options. No reading operations will be performed until methods are
     * called on this instance.
     */
    constructor(options: InputOptions<S>);
    /**
     * Returns the source from which this input file reads its data. This is the same source that was passed to the
     * constructor.
     */
    get source(): S;
    /**
     * Returns the format of the input file. You can compare this result directly to the {@link InputFormat} singletons
     * or use `instanceof` checks for subset-aware logic (for example, `format instanceof MatroskaInputFormat` is true
     * for both MKV and WebM).
     */
    getFormat(): Promise<InputFormat>;
    /**
     * Computes the duration of the input file, in seconds. More precisely, returns the largest end timestamp among
     * all tracks.
     */
    computeDuration(): Promise<number>;
    /**
     * Returns the timestamp at which the input file starts. More precisely, returns the smallest starting timestamp
     * among all tracks.
     */
    getFirstTimestamp(): Promise<number>;
    /** Returns the list of all tracks of this input file. */
    getTracks(): Promise<import("./input-track.js").InputTrack[]>;
    /** Returns the list of all video tracks of this input file. */
    getVideoTracks(): Promise<import("./input-track.js").InputVideoTrack[]>;
    /** Returns the list of all audio tracks of this input file. */
    getAudioTracks(): Promise<import("./input-track.js").InputAudioTrack[]>;
    /** Returns the list of all subtitle tracks of this input file. */
    getSubtitleTracks(): Promise<import("./input-track.js").InputSubtitleTrack[]>;
    /** Returns the primary video track of this input file, or null if there are no video tracks. */
    getPrimaryVideoTrack(): Promise<import("./input-track.js").InputVideoTrack | null>;
    /** Returns the primary audio track of this input file, or null if there are no audio tracks. */
    getPrimaryAudioTrack(): Promise<import("./input-track.js").InputAudioTrack | null>;
    /**
     * Returns the list of all subtitle tracks of this input file. This is a convenience property that calls
     * {@link Input.getSubtitleTracks} and caches the result. Note that this property is a promise!
     */
    get subtitleTracks(): Promise<import("./input-track.js").InputSubtitleTrack[]>;
    /**
     * Returns the list of all video tracks of this input file. This is a convenience property that calls
     * {@link Input.getVideoTracks} and caches the result. Note that this property is a promise!
     */
    get videoTracks(): Promise<import("./input-track.js").InputVideoTrack[]>;
    /**
     * Returns the list of all audio tracks of this input file. This is a convenience property that calls
     * {@link Input.getAudioTracks} and caches the result. Note that this property is a promise!
     */
    get audioTracks(): Promise<import("./input-track.js").InputAudioTrack[]>;
    /** Returns the full MIME type of this input file, including track codecs. */
    getMimeType(): Promise<string>;
    /**
     * Returns descriptive metadata tags about the media file, such as title, author, date, cover art, or other
     * attached files.
     */
    getMetadataTags(): Promise<import("./metadata.js").MetadataTags>;
    /**
     * Disposes this input and frees connected resources. When an input is disposed, ongoing read operations will be
     * canceled, all future read operations will fail, any open decoders will be closed, and all ongoing media sink
     * operations will be canceled. Disallowed and canceled operations will throw an {@link InputDisposedError}.
     *
     * You are expected not to use an input after disposing it. While some operations may still work, it is not
     * specified and may change in any future update.
     */
    dispose(): void;
    /**
     * Calls `.dispose()` on the input, implementing the `Disposable` interface for use with
     * JavaScript Explicit Resource Management features.
     */
    [Symbol.dispose](): void;
}
/**
 * Thrown when an operation was prevented because the corresponding {@link Input} has been disposed.
 * @group Input files & tracks
 * @public
 */
export declare class InputDisposedError extends Error {
    /** Creates a new {@link InputDisposedError}. */
    constructor(message?: string);
}
//# sourceMappingURL=input.d.ts.map