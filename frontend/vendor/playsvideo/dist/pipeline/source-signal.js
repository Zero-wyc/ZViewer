export function isAbortableSource(source) {
    return (source !== null &&
        typeof source === 'object' &&
        typeof source.setCurrentSignal === 'function');
}
/**
 * Throws AbortError if the signal has been aborted.
 * Call between pipeline stages to bail out early.
 */
export function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Segment processing aborted', 'AbortError');
    }
}
//# sourceMappingURL=source-signal.js.map