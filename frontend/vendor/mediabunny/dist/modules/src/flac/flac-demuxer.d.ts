/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Demuxer } from '../demuxer.js';
import { Input } from '../input.js';
import { InputAudioTrack } from '../input-track.js';
import { AsyncMutex } from '../misc.js';
import { FileSlice, Reader } from '../reader.js';
import { MetadataTags } from '../metadata.js';
type FlacAudioInfo = {
    numberOfChannels: number;
    sampleRate: number;
    totalSamples: number;
    minimumBlockSize: number;
    maximumBlockSize: number;
    minimumFrameSize: number;
    maximumFrameSize: number;
    description: Uint8Array;
};
type Sample = {
    blockOffset: number;
    blockSize: number;
    byteOffset: number;
    byteSize: number;
};
type NextFlacFrameResult = {
    num: number;
    blockSize: number;
    sampleRate: number;
    size: number;
    isLastFrame: boolean;
};
export declare class FlacDemuxer extends Demuxer {
    reader: Reader;
    loadedSamples: Sample[];
    metadataPromise: Promise<void> | null;
    track: InputAudioTrack | null;
    metadataTags: MetadataTags;
    audioInfo: FlacAudioInfo | null;
    lastLoadedPos: number | null;
    blockingBit: number | null;
    readingMutex: AsyncMutex;
    lastSampleLoaded: boolean;
    constructor(input: Input);
    computeDuration(): Promise<number>;
    getMetadataTags(): Promise<MetadataTags>;
    getTracks(): Promise<InputAudioTrack[]>;
    getMimeType(): Promise<string>;
    readMetadata(): Promise<void>;
    readNextFlacFrame({ startPos, isFirstPacket, }: {
        startPos: number;
        isFirstPacket: boolean;
    }): Promise<NextFlacFrameResult | null>;
    readFlacFrameHeader({ slice, isFirstPacket, }: {
        slice: FileSlice;
        isFirstPacket: boolean;
    }): {
        num: number;
        blockSize: number;
        sampleRate: number;
    } | null;
    advanceReader(): Promise<void>;
}
export {};
//# sourceMappingURL=flac-demuxer.d.ts.map