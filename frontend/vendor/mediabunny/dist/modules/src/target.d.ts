/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Base class for targets, specifying where output files are written.
 * @group Output targets
 * @public
 */
export declare abstract class Target {
    /**
     * Called each time data is written to the target. Will be called with the byte range into which data was written.
     *
     * Use this callback to track the size of the output file as it grows. But be warned, this function is chatty and
     * gets called *extremely* often.
     */
    onwrite: ((start: number, end: number) => unknown) | null;
}
/**
 * A target that writes data directly into an ArrayBuffer in memory. Great for performance, but not suitable for very
 * large files. The buffer will be available once the output has been finalized.
 * @group Output targets
 * @public
 */
export declare class BufferTarget extends Target {
    /** Stores the final output buffer. Until the output is finalized, this will be `null`. */
    buffer: ArrayBuffer | null;
}
/**
 * A data chunk for {@link StreamTarget}.
 * @group Output targets
 * @public
 */
export type StreamTargetChunk = {
    /** The operation type. */
    type: 'write';
    /** The data to write. */
    data: Uint8Array<ArrayBuffer>;
    /** The byte offset in the output file at which to write the data. */
    position: number;
};
/**
 * Options for {@link StreamTarget}.
 * @group Output targets
 * @public
 */
export type StreamTargetOptions = {
    /**
     * When setting this to true, data created by the output will first be accumulated and only written out
     * once it has reached sufficient size, using a default chunk size of 16 MiB. This is useful for reducing the total
     * amount of writes, at the cost of latency.
     */
    chunked?: boolean;
    /** When using `chunked: true`, this specifies the maximum size of each chunk. Defaults to 16 MiB. */
    chunkSize?: number;
};
/**
 * This target writes data to a [`WritableStream`](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream),
 * making it a general-purpose target for writing data anywhere. It is also compatible with
 * [`FileSystemWritableFileStream`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream) for
 * use with the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). The
 * `WritableStream` can also apply backpressure, which will propagate to the output and throttle the encoders.
 * @group Output targets
 * @public
 */
export declare class StreamTarget extends Target {
    /** Creates a new {@link StreamTarget} which writes to the specified `writable`. */
    constructor(writable: WritableStream<StreamTargetChunk>, options?: StreamTargetOptions);
}
/**
 * Options for {@link FilePathTarget}.
 * @group Output targets
 * @public
 */
export type FilePathTargetOptions = StreamTargetOptions;
/**
 * A target that writes to a file at the specified path. Intended for server-side usage in Node, Bun, or Deno.
 *
 * Writing is chunked by default. The internally held file handle will be closed when `.finalize()` or `.cancel()` are
 * called on the corresponding {@link Output}.
 * @group Output targets
 * @public
 */
export declare class FilePathTarget extends Target {
    /** Creates a new {@link FilePathTarget} that writes to the file at the specified file path. */
    constructor(filePath: string, options?: FilePathTargetOptions);
}
/**
 * This target just discards all incoming data. It is useful for when you need an {@link Output} but extract data from
 * it differently, for example through format-specific callbacks (`onMoof`, `onMdat`, ...) or encoder events.
 * @group Output targets
 * @public
 */
export declare class NullTarget extends Target {
}
//# sourceMappingURL=target.d.ts.map