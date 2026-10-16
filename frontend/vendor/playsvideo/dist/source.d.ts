export interface ReadResult {
    bytes: Uint8Array;
    view: DataView;
    offset: number;
}
/**
 * Lightweight source base class for reading bytes from a file-like resource.
 * Consumers extend this to provide custom byte sources (e.g. torrent streams).
 * Adapted to mediabunny's Source via SourceAdapter at the pipeline boundary.
 */
export declare abstract class Source {
    abstract _retrieveSize(): number | null | Promise<number | null>;
    abstract _read(start: number, end: number): ReadResult | Promise<ReadResult | null> | null;
    abstract _dispose(): void;
    private _sizePromise;
    getSizeOrNull(): Promise<number | null>;
    getSize(): Promise<number>;
}
//# sourceMappingURL=source.d.ts.map