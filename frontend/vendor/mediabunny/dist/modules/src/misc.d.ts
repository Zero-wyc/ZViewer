/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Bitstream } from '../shared/bitstream.js';
export declare function assert(x: unknown): asserts x;
/**
 * Represents a clockwise rotation in degrees.
 * @group Miscellaneous
 * @public
 */
export type Rotation = 0 | 90 | 180 | 270;
export declare const normalizeRotation: (rotation: number) => Rotation;
export type TransformationMatrix = [number, number, number, number, number, number, number, number, number];
export declare const last: <T>(arr: T[]) => T | undefined;
export declare const isU32: (value: number) => boolean;
/** Reads an exponential-Golomb universal code from a Bitstream.  */
export declare const readExpGolomb: (bitstream: Bitstream) => number;
/** Reads a signed exponential-Golomb universal code from a Bitstream. */
export declare const readSignedExpGolomb: (bitstream: Bitstream) => number;
export declare const writeBits: (bytes: Uint8Array, start: number, end: number, value: number) => void;
export declare const toUint8Array: (source: AllowSharedBufferSource) => Uint8Array;
export declare const toDataView: (source: AllowSharedBufferSource) => DataView;
export declare const textDecoder: TextDecoder;
export declare const textEncoder: TextEncoder;
export declare const isIso88591Compatible: (text: string) => boolean;
export declare const COLOR_PRIMARIES_MAP: {
    bt709: number;
    bt470bg: number;
    smpte170m: number;
    bt2020: number;
    smpte432: number;
};
export declare const COLOR_PRIMARIES_MAP_INVERSE: Record<number, "bt709" | "bt470bg" | "smpte170m" | "bt2020" | "smpte432">;
export declare const TRANSFER_CHARACTERISTICS_MAP: {
    bt709: number;
    smpte170m: number;
    linear: number;
    'iec61966-2-1': number;
    pq: number;
    hlg: number;
};
export declare const TRANSFER_CHARACTERISTICS_MAP_INVERSE: Record<number, "bt709" | "smpte170m" | "linear" | "iec61966-2-1" | "pq" | "hlg">;
export declare const MATRIX_COEFFICIENTS_MAP: {
    rgb: number;
    bt709: number;
    bt470bg: number;
    smpte170m: number;
    'bt2020-ncl': number;
};
export declare const MATRIX_COEFFICIENTS_MAP_INVERSE: Record<number, "bt709" | "bt470bg" | "smpte170m" | "rgb" | "bt2020-ncl">;
export type RequiredNonNull<T> = {
    [K in keyof T]-?: NonNullable<T[K]>;
};
export declare const colorSpaceIsComplete: (colorSpace: VideoColorSpaceInit | undefined) => colorSpace is RequiredNonNull<VideoColorSpaceInit>;
export declare const isAllowSharedBufferSource: (x: unknown) => boolean;
export declare class AsyncMutex {
    currentPromise: Promise<void>;
    pending: number;
    acquire(): Promise<() => void>;
}
export declare const bytesToHexString: (bytes: Uint8Array) => string;
export declare const reverseBitsU32: (x: number) => number;
/** Returns the smallest index i such that val[i] === key, or -1 if no such index exists. */
export declare const binarySearchExact: <T>(arr: T[], key: number, valueGetter: (x: T) => number) => number;
/** Returns the largest index i such that val[i] <= key, or -1 if no such index exists. */
export declare const binarySearchLessOrEqual: <T>(arr: T[], key: number, valueGetter: (x: T) => number) => number;
/** Assumes the array is already sorted. */
export declare const insertSorted: <T>(arr: T[], item: T, valueGetter: (x: T) => number) => void;
export declare const promiseWithResolvers: <T = void>() => {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
};
export declare const removeItem: <T>(arr: T[], item: T) => void;
export declare const findLast: <T>(arr: T[], predicate: (x: T) => boolean) => T | undefined;
export declare const findLastIndex: <T>(arr: T[], predicate: (x: T) => boolean) => number;
/**
 * Sync or async iterable.
 * @group Miscellaneous
 * @public
 */
export type AnyIterable<T> = Iterable<T> | AsyncIterable<T>;
export declare const toAsyncIterator: <T>(source: AnyIterable<T>) => AsyncGenerator<T, void, unknown>;
export declare const validateAnyIterable: (iterable: AnyIterable<unknown>) => void;
export declare const assertNever: (x: never) => never;
export declare const getUint24: (view: DataView, byteOffset: number, littleEndian: boolean) => number;
export declare const getInt24: (view: DataView, byteOffset: number, littleEndian: boolean) => number;
export declare const setUint24: (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => void;
export declare const setInt24: (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => void;
export declare const setInt64: (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => void;
/**
 * Calls a function on each value spat out by an async generator. The reason for writing this manually instead of
 * using a generator function is that the generator function queues return() calls - here, we forward them immediately.
 */
export declare const mapAsyncGenerator: <T, U>(generator: AsyncGenerator<T, void, unknown>, map: (t: T) => U) => AsyncGenerator<U, void, unknown>;
export declare const clamp: (value: number, min: number, max: number) => number;
export declare const UNDETERMINED_LANGUAGE = "und";
export declare const roundIfAlmostInteger: (value: number) => number;
export declare const roundToMultiple: (value: number, multiple: number) => number;
export declare const floorToMultiple: (value: number, multiple: number) => number;
export declare const ilog: (x: number) => number;
export declare const isIso639Dash2LanguageCode: (x: string) => boolean;
export declare const SECOND_TO_MICROSECOND_FACTOR: number;
/**
 * Sets all keys K of T to be required.
 * @group Miscellaneous
 * @public
 */
export type SetRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;
/**
 * Merges two RequestInit objects with special handling for headers.
 * Headers are merged case-insensitively, but original casing is preserved.
 * init2 headers take precedence and will override case-insensitive matches from init1.
 */
export declare const mergeRequestInit: (init1: RequestInit, init2: RequestInit) => RequestInit;
export declare const retriedFetch: (fetchFn: typeof fetch, url: string | URL | Request, requestInit: RequestInit, getRetryDelay: (previousAttempts: number, error: unknown, url: string | URL | Request) => number | null, shouldStop: () => boolean) => Promise<Response>;
export declare const computeRationalApproximation: (x: number, maxDenominator: number) => {
    numerator: number;
    denominator: number;
};
export declare class CallSerializer {
    currentPromise: Promise<void>;
    call(fn: () => Promise<void> | void): Promise<void>;
}
export declare const isWebKit: () => boolean;
export declare const isFirefox: () => boolean;
export declare const isChromium: () => boolean;
export declare const getChromiumVersion: () => number | null;
/**
 * T or a promise that resolves to T.
 * @group Miscellaneous
 * @public
 */
export type MaybePromise<T> = T | Promise<T>;
/** Acts like `??` except the condition is -1 and not null/undefined. */
export declare const coalesceIndex: (a: number, b: number) => number;
export declare const closedIntervalsOverlap: (startA: number, endA: number, startB: number, endB: number) => boolean;
type KeyValuePair<T extends Record<string, unknown>> = {
    [K in keyof T]-?: {
        key: K;
        value: T[K] extends infer R | undefined ? R : T[K];
    };
}[keyof T];
export declare const keyValueIterator: <T extends Record<string, unknown>>(object: T) => Generator<KeyValuePair<T>, void, unknown>;
export declare const imageMimeTypeToExtension: (mimeType: string) => ".jpg" | ".png" | ".gif" | ".webp" | ".bmp" | ".svg" | ".tiff" | ".avif" | ".ico" | null;
export declare const base64ToBytes: (base64: string) => Uint8Array<ArrayBuffer>;
export declare const bytesToBase64: (bytes: Uint8Array) => string;
export declare const uint8ArraysAreEqual: (a: Uint8Array, b: Uint8Array) => boolean;
export declare const polyfillSymbolDispose: () => void;
export declare const isNumber: (x: unknown) => boolean;
/**
 * A rational number; a ratio of two integers.
 * @group Miscellaneous
 * @public
 */
export type Rational = {
    /** The numerator of the rational number. */
    num: number;
    /** The denominator of the rational number. */
    den: number;
};
export declare const simplifyRational: (rational: Rational) => Rational;
/**
 * Specifies a rectangular region where all quantities must be non-negative integers.
 * @group Miscellaneous
 * @public
 */
export type Rectangle = {
    /** The distance in pixels to the left edge of the rectangle . */
    left: number;
    /** The distance in pixels to the top edge of the rectangle. */
    top: number;
    /** The width in pixels of the rectangle. */
    width: number;
    /** The height in pixels of the rectangle. */
    height: number;
};
export declare const validateRectangle: (rect: Rectangle, propertyPath: string) => void;
export type UnthrottledTimerHandle = {
    id: ReturnType<typeof setTimeout> | number;
};
export declare const setTimeoutUnthrottled: (callback: Function, delay: number) => UnthrottledTimerHandle;
export declare const clearTimeoutUnthrottled: (timer: UnthrottledTimerHandle) => void;
export declare const setIntervalUnthrottled: (callback: Function, delay: number) => UnthrottledTimerHandle;
export declare const clearIntervalUnthrottled: (timer: UnthrottledTimerHandle) => void;
export {};
//# sourceMappingURL=misc.d.ts.map