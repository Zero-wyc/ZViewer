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
import { MetadataTags } from '../metadata.js';
import { Reader } from '../reader.js';
import { OggCodecInfo } from './ogg-misc.js';
import { Page } from './ogg-reader.js';
type LogicalBitstream = {
    serialNumber: number;
    bosPage: Page;
    description: Uint8Array | null;
    numberOfChannels: number;
    sampleRate: number;
    codecInfo: OggCodecInfo;
    lastMetadataPacket: Packet | null;
};
type Packet = {
    data: Uint8Array;
    endPage: Page;
    endSegmentIndex: number;
};
export declare class OggDemuxer extends Demuxer {
    reader: Reader;
    metadataPromise: Promise<void> | null;
    bitstreams: LogicalBitstream[];
    tracks: InputAudioTrack[];
    metadataTags: MetadataTags;
    constructor(input: Input);
    readMetadata(): Promise<void>;
    readVorbisMetadata(firstPacket: Packet, bitstream: LogicalBitstream): Promise<void>;
    readOpusMetadata(firstPacket: Packet, bitstream: LogicalBitstream): Promise<void>;
    readPacket(startPage: Page, startSegmentIndex: number): Promise<Packet | null>;
    findNextPacketStart(lastPacket: Packet): Promise<{
        startPage: Page;
        startSegmentIndex: number;
    } | null>;
    getMimeType(): Promise<string>;
    getTracks(): Promise<InputAudioTrack[]>;
    computeDuration(): Promise<number>;
    getMetadataTags(): Promise<MetadataTags>;
}
export {};
//# sourceMappingURL=ogg-demuxer.d.ts.map