/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Muxer } from '../muxer.js';
import { Output, OutputAudioTrack, OutputTrack } from '../output.js';
import { OggOutputFormat } from '../output-format.js';
import { EncodedPacket } from '../packet.js';
import { OggCodecInfo } from './ogg-misc.js';
type OggTrackData = {
    track: OutputAudioTrack;
    serialNumber: number;
    internalSampleRate: number;
    codecInfo: OggCodecInfo & {
        codec: 'vorbis' | 'opus';
    };
    vorbisLastBlocksize: number | null;
    packetQueue: Packet[];
    leadingPackets: Packet[];
    startOffsetInSamples: number;
    currentTimestampInSamples: number | null;
    audioPacketCount: number;
    pagesWritten: number;
    currentGranulePosition: number;
    currentLacingValues: number[];
    currentPageData: Uint8Array[];
    currentPageSize: number;
    currentPageStartsWithFreshPacket: boolean;
    currentPageStartTimestampInSamples: number;
};
type Packet = {
    data: Uint8Array;
    timestampInSamples: number;
    durationInSamples: number;
    forcePageFlush: boolean;
    holdPage: boolean;
    isHeader: boolean;
};
export declare class OggMuxer extends Muxer {
    private format;
    private writer;
    private trackDatas;
    private closedTracks;
    private bosPagesWritten;
    private allTracksKnown;
    private warnedAboutTooNegativeTimestamp;
    private pageBytes;
    private pageView;
    constructor(output: Output, format: OggOutputFormat);
    start(): Promise<void>;
    getMimeType(): Promise<string>;
    addEncodedVideoPacket(): never;
    private getTrackData;
    private queueHeaderPackets;
    addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata): Promise<void>;
    addSubtitleCue(): never;
    allTracksAreKnown(): boolean;
    interleavePages(isFinalCall?: boolean): Promise<void>;
    writePacket(trackData: OggTrackData, packet: Packet, isFinalPacket: boolean): void;
    writePage(trackData: OggTrackData, isEos: boolean): void;
    onTrackClose(track: OutputTrack): Promise<void>;
    finalize(): Promise<void>;
    private warnAboutDiscardedPackets;
}
export {};
//# sourceMappingURL=ogg-muxer.d.ts.map