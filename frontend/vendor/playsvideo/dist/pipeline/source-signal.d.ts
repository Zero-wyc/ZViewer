/**
 * Interface for Sources that support per-segment abort signals.
 *
 * The pipeline sets a signal before each segment via setCurrentSignal().
 * Sources that implement this can use it to cancel in-flight async reads
 * (e.g., abort torrent piece downloads on seek).
 *
 * mediabunny's Source._read(start, end) doesn't pass AbortSignal,
 * so this is the mechanism for threading abort to external Sources.
 */
export interface AbortableSource {
    setCurrentSignal(signal: AbortSignal | null): void;
}
export declare function isAbortableSource(source: unknown): source is AbortableSource;
/**
 * Throws AbortError if the signal has been aborted.
 * Call between pipeline stages to bail out early.
 */
export declare function checkAbort(signal?: AbortSignal): void;
//# sourceMappingURL=source-signal.d.ts.map