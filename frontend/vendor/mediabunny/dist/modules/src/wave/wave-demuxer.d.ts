/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AudioCodec } from '../codec.js';
import { Demuxer } from '../demuxer.js';
import { Input } from '../input.js';
import { InputAudioTrack } from '../input-track.js';
import { MetadataTags } from '../metadata.js';
import { Reader } from '../reader.js';
export declare enum WaveFormat {
    PCM = 1,
    IEEE_FLOAT = 3,
    ALAW = 6,
    MULAW = 7,
    EXTENSIBLE = 65534
}
export declare class WaveDemuxer extends Demuxer {
    reader: Reader;
    metadataPromise: Promise<void> | null;
    dataStart: number;
    dataSize: number;
    audioInfo: {
        format: number;
        numberOfChannels: number;
        sampleRate: number;
        sampleSizeInBytes: number;
        blockSizeInBytes: number;
    } | null;
    tracks: InputAudioTrack[];
    lastKnownPacketIndex: number;
    metadataTags: MetadataTags;
    constructor(input: Input);
    readMetadata(): Promise<void>;
    private parseFmtChunk;
    private parseListChunk;
    private parseId3Chunk;
    getCodec(): AudioCodec | null;
    getMimeType(): Promise<string>;
    computeDuration(): Promise<number>;
    getTracks(): Promise<InputAudioTrack[]>;
    getMetadataTags(): Promise<MetadataTags>;
}
//# sourceMappingURL=wave-demuxer.d.ts.map