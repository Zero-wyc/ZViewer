/**
 * Lightweight source base class for reading bytes from a file-like resource.
 * Consumers extend this to provide custom byte sources (e.g. torrent streams).
 * Adapted to mediabunny's Source via SourceAdapter at the pipeline boundary.
 */
export class Source {
    _sizePromise = null;
    async getSizeOrNull() {
        if (!this._sizePromise) {
            this._sizePromise = Promise.resolve(this._retrieveSize());
        }
        return this._sizePromise;
    }
    async getSize() {
        const result = await this.getSizeOrNull();
        if (result === null)
            throw new Error('Cannot determine the size of an unsized source.');
        return result;
    }
}
//# sourceMappingURL=source.js.map