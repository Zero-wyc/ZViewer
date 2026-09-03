/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AacCodecInfo, AudioCodec, MediaCodec, VideoCodec } from '../codec.js';
import { AvcDecoderConfigurationRecord, HevcDecoderConfigurationRecord } from '../codec-data.js';
import { Demuxer } from '../demuxer.js';
import { Input } from '../input.js';
import { InputTrack, InputTrackBacking } from '../input-track.js';
import { PacketRetrievalOptions } from '../media-sink.js';
import { MetadataTags } from '../metadata.js';
import { EncodedPacket } from '../packet.js';
import { Reader } from '../reader.js';
type ElementaryStream = {
    demuxer: MpegTsDemuxer;
    pid: number;
    streamType: number;
    initialized: boolean;
    firstSection: Section | null;
    info: {
        type: 'video';
        codec: VideoCodec;
        avcCodecInfo: AvcDecoderConfigurationRecord | null;
        hevcCodecInfo: HevcDecoderConfigurationRecord | null;
        colorSpace: VideoColorSpaceInit;
        width: number;
        height: number;
        squarePixelWidth: number;
        squarePixelHeight: number;
        reorderSize: number;
    } | {
        type: 'audio';
        codec: AudioCodec;
        aacCodecInfo: AacCodecInfo | null;
        numberOfChannels: number;
        sampleRate: number;
    };
    /**
     * Reference PES packets, spread throughout the file, to be used to speed up repeated random access. Sorted by both
     * byte offset and PTS.
     */
    referencePesPackets: PesPacketHeader[];
};
type TsPacketHeader = {
    payloadUnitStartIndicator: number;
    pid: number;
    adaptationFieldControl: number;
};
type TsPacket = TsPacketHeader & {
    body: Uint8Array<ArrayBufferLike>;
};
type Section = {
    startPos: number;
    endPos: number | null;
    pid: number;
    payload: Uint8Array<ArrayBufferLike>;
    randomAccessIndicator: number;
};
export declare class MpegTsDemuxer extends Demuxer {
    reader: Reader;
    metadataPromise: Promise<void> | null;
    elementaryStreams: ElementaryStream[];
    tracks: InputTrack[];
    packetOffset: number;
    packetStride: number;
    sectionEndPositions: number[];
    seekChunkSize: number;
    minReferencePointByteDistance: number;
    constructor(input: Input);
    readMetadata(): Promise<void>;
    getTracks(): Promise<InputTrack[]>;
    getMetadataTags(): Promise<MetadataTags>;
    computeDuration(): Promise<number>;
    getMimeType(): Promise<string>;
    readSection(startPos: number, full: boolean, contiguous?: boolean): Promise<Section | null>;
    readPacketHeader(pos: number): Promise<TsPacketHeader | null>;
    readPacket(pos: number): Promise<TsPacket | null>;
}
type PesPacketHeader = {
    sectionStartPos: number;
    sectionEndPos: number | null;
    pts: number;
    randomAccessIndicator: number;
};
type PesPacket = PesPacketHeader & {
    data: Uint8Array<ArrayBufferLike>;
};
export declare abstract class MpegTsTrackBacking implements InputTrackBacking {
    elementaryStream: ElementaryStream;
    packetBuffers: WeakMap<EncodedPacket, PacketBuffer>;
    /** Used for recreating PacketBuffers if necessary. */
    packetSectionStarts: WeakMap<EncodedPacket, number>;
    constructor(elementaryStream: ElementaryStream);
    getId(): number;
    getNumber(): number;
    getCodec(): MediaCodec | null;
    getInternalCodecId(): number;
    getName(): null;
    getLanguageCode(): string;
    getDisposition(): import("../metadata.js").TrackDisposition;
    getTimeResolution(): number;
    computeDuration(): Promise<number>;
    getFirstTimestamp(): Promise<number>;
    abstract allPacketsAreKeyPackets(): boolean;
    abstract getReorderSize(): number;
    createEncodedPacket(suppliedPacket: SuppliedPacket, duration: number, options: PacketRetrievalOptions): EncodedPacket;
    getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    /**
     * Searches for the packet with the largest timestamp not larger than `timestamp` in the file, using a combination
     * of chunk-based binary search and linear refinement. The reason the coarse search is done in large chunks is to
     * make it more performant for small files and over high-latency readers such as the network.
     */
    doPacketLookup(timestamp: number, keyframesOnly: boolean, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
}
type SuppliedPacket = {
    pts: number;
    data: Uint8Array;
    sequenceNumber: number;
    sectionStartPos: number;
    randomAccessIndicator: number;
};
/** Stateful context used to extract exact encoded packets from the underlying data stream. */
declare class PacketReadingContext {
    elementaryStream: ElementaryStream;
    pid: number;
    demuxer: MpegTsDemuxer;
    startingPesPacket: PesPacket;
    currentPos: number;
    pesPackets: PesPacket[];
    currentPesPacketIndex: number;
    currentPesPacketPos: number;
    endPos: number;
    nextPts: number;
    suppliedPacket: SuppliedPacket | null;
    constructor(elementaryStream: ElementaryStream, startingPesPacket: PesPacket);
    clone(): PacketReadingContext;
    ensureBuffered(length: number): number | Promise<number>;
    getCurrentPesPacket(): PesPacket;
    bufferData(length: number): Promise<void>;
    readBytes(length: number): Uint8Array<ArrayBufferLike>;
    readU8(): number;
    seekTo(pos: number): void;
    skip(n: number): void;
    advanceCurrentPacket(): void;
    /** Supplies the context with a new encoded packet, beginning at the current position. */
    supplyPacket(packetLength: number, intrinsicDuration: number): void;
}
/**
 * A buffer that simulates decoder frame reordering to compute packet durations. Packets arrive in decode order but
 * durations are based on presentation order.
 */
declare class PacketBuffer {
    backing: MpegTsTrackBacking;
    context: PacketReadingContext;
    decodeOrderPackets: SuppliedPacket[];
    reorderSize: number;
    reorderBuffer: SuppliedPacket[];
    presentationOrderPackets: SuppliedPacket[];
    reachedEnd: boolean;
    lastDuration: number;
    constructor(backing: MpegTsTrackBacking, context: PacketReadingContext);
    readNext(): Promise<{
        packet: SuppliedPacket;
        duration: number;
    } | null>;
    readNextPacket(): Promise<boolean>;
    ensureCurrentPacketHasNext(): Promise<void>;
    processPacketThroughReorderBuffer(packet: SuppliedPacket): void;
    flushReorderBuffer(): void;
}
export {};
//# sourceMappingURL=mpeg-ts-demuxer.d.ts.map