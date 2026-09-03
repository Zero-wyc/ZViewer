/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { MaybePromise } from './misc.js';
export type ReadResult = {
    bytes: Uint8Array;
    view: DataView;
    /** The offset of the bytes in the file. */
    offset: number;
};
/**
 * The source base class, representing a resource from which bytes can be read.
 * @group Input sources
 * @public
 */
export declare abstract class Source {
    /**
     * Resolves with the total size of the file in bytes. This function is memoized, meaning only the first call
     * will retrieve the size.
     *
     * Returns null if the source is unsized.
     */
    getSizeOrNull(): Promise<number | null>;
    /**
     * Resolves with the total size of the file in bytes. This function is memoized, meaning only the first call
     * will retrieve the size.
     *
     * Throws an error if the source is unsized.
     */
    getSize(): Promise<number>;
    /** Called each time data is retrieved from the source. Will be called with the retrieved range (end exclusive). */
    onread: ((start: number, end: number) => unknown) | null;
}
/**
 * A source backed by an ArrayBuffer or ArrayBufferView, with the entire file held in memory.
 * @group Input sources
 * @public
 */
export declare class BufferSource extends Source {
    /**
     * Creates a new {@link BufferSource} backed by the specified `ArrayBuffer`, `SharedArrayBuffer`,
     * or `ArrayBufferView`.
     */
    constructor(buffer: AllowSharedBufferSource);
}
/**
 * Options for {@link BlobSource}.
 * @group Input sources
 * @public
 */
export type BlobSourceOptions = {
    /** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
    maxCacheSize?: number;
};
/**
 * A source backed by a [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob). Since a
 * [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) is also a `Blob`, this is the source to use when
 * reading files off the disk.
 * @group Input sources
 * @public
 */
export declare class BlobSource extends Source {
    /**
     * Creates a new {@link BlobSource} backed by the specified
     * [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob).
     */
    constructor(blob: Blob, options?: BlobSourceOptions);
}
/**
 * Options for {@link UrlSource}.
 * @group Input sources
 * @public
 */
export type UrlSourceOptions = {
    /**
     * The [`RequestInit`](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit) used by the Fetch API. Can be
     * used to further control the requests, such as setting custom headers.
     *
     * All fields will work except for `signal` and `headers.Range`; these will be overridden by Mediabunny. If you want
     * to cancel ongoing requests, use {@link Input.dispose}.
     */
    requestInit?: RequestInit;
    /**
     * A function that returns the delay (in seconds) before retrying a failed request. The function is called
     * with the number of previous, unsuccessful attempts, as well as with the error with which the previous request
     * failed. If the function returns `null`, no more retries will be made.
     *
     * By default, it uses an exponential backoff algorithm that never gives up unless
     * a CORS error is suspected (`fetch()` did reject, `navigator.onLine` is true and origin is different)
     */
    getRetryDelay?: (previousAttempts: number, error: unknown, url: string | URL | Request) => number | null;
    /** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 64 MiB. */
    maxCacheSize?: number;
    /** The maximum number of parallel requests to use for fetching. Defaults to 2. */
    parallelism?: number;
    /**
     * A WHATWG-compatible fetch function. You can use this field to polyfill the `fetch` function, add missing
     * features, or use a custom implementation.
     */
    fetchFn?: typeof fetch;
};
/**
 * A source backed by a URL. This is useful for reading data from the network. Requests will be made using an optimized
 * reading and prefetching pattern to minimize request count and latency.
 * @group Input sources
 * @public
 */
export declare class UrlSource extends Source {
    /**
     * Creates a new {@link UrlSource} backed by the resource at the specified URL.
     *
     * When passing a `Request` instance, note that the `signal` and `headers.Range` options will be overridden by
     * Mediabunny. If you want to cancel ongoing requests, use {@link Input.dispose}.
     */
    constructor(url: string | URL | Request, options?: UrlSourceOptions);
}
/**
 * Options for {@link FilePathSource}.
 * @group Input sources
 * @public
 */
export type FilePathSourceOptions = {
    /** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
    maxCacheSize?: number;
};
/**
 * A source backed by a path to a file. Intended for server-side usage in Node, Bun, or Deno.
 *
 * Make sure to call `.dispose()` on the corresponding {@link Input} when done to explicitly free the internal file
 * handle acquired by this source.
 * @group Input sources
 * @public
 */
export declare class FilePathSource extends Source {
    /** Creates a new {@link FilePathSource} backed by the file at the specified file path. */
    constructor(filePath: string, options?: FilePathSourceOptions);
}
/**
 * Options for defining a {@link StreamSource}.
 * @group Input sources
 * @public
 */
export type StreamSourceOptions = {
    /**
     * Called when the size of the entire file is requested. Must return or resolve to the size in bytes. This function
     * is guaranteed to be called before `read`.
     */
    getSize: () => MaybePromise<number>;
    /**
     * Called when data is requested. Must return or resolve to the bytes from the specified byte range, or a stream
     * that yields these bytes.
     */
    read: (start: number, end: number) => MaybePromise<Uint8Array | ReadableStream<Uint8Array>>;
    /**
     * Called when the {@link Input} driven by this source is disposed.
     */
    dispose?: () => unknown;
    /** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
    maxCacheSize?: number;
    /**
     * Specifies the prefetch profile that the reader should use with this source. A prefetch profile specifies the
     * pattern with which bytes outside of the requested range are preloaded to reduce latency for future reads.
     *
     * - `'none'` (default): No prefetching; only the data needed in the moment is requested.
     * - `'fileSystem'`: File system-optimized prefetching: a small amount of data is prefetched bidirectionally,
     * aligned with page boundaries.
     * - `'network'`: Network-optimized prefetching, or more generally, prefetching optimized for any high-latency
     * environment: tries to minimize the amount of read calls and aggressively prefetches data when sequential access
     * patterns are detected.
     */
    prefetchProfile?: 'none' | 'fileSystem' | 'network';
};
/**
 * A general-purpose, callback-driven source that can get its data from anywhere.
 * @group Input sources
 * @public
 */
export declare class StreamSource extends Source {
    /** Creates a new {@link StreamSource} whose behavior is specified by `options`.  */
    constructor(options: StreamSourceOptions);
}
/**
 * Options for {@link ReadableStreamSource}.
 * @group Input sources
 * @public
 */
export type ReadableStreamSourceOptions = {
    /** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 16 MiB. */
    maxCacheSize?: number;
};
/**
 * A source backed by a [`ReadableStream`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream) of
 * `Uint8Array`, representing an append-only byte stream of unknown length. This is the source to use for incrementally
 * streaming in input files that are still being constructed and whose size we don't yet know, like for example the
 * output chunks of [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder).
 *
 * This source is *unsized*, meaning calls to `.getSize()` will throw and readers are more limited due to the
 * lack of random file access. You should only use this source with sequential access patterns, such as reading all
 * packets from start to end. This source does not work well with random access patterns unless you increase its
 * max cache size.
 *
 * @group Input sources
 * @public
 */
export declare class ReadableStreamSource extends Source {
    /** Creates a new {@link ReadableStreamSource} backed by the specified `ReadableStream<Uint8Array>`. */
    constructor(stream: ReadableStream<Uint8Array>, options?: ReadableStreamSourceOptions);
}
//# sourceMappingURL=source.d.ts.map