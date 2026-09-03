/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AacCodecInfo, AudioCodec, SubtitleCodec, VideoCodec } from '../codec.js';
import { Demuxer } from '../demuxer.js';
import { Input } from '../input.js';
import { InputTrack } from '../input-track.js';
import { MetadataTags, TrackDisposition } from '../metadata.js';
import { Rotation } from '../misc.js';
import { FileSlice, Reader } from '../reader.js';
type Segment = {
    seekHeadSeen: boolean;
    infoSeen: boolean;
    tracksSeen: boolean;
    cuesSeen: boolean;
    attachmentsSeen: boolean;
    tagsSeen: boolean;
    timestampScale: number;
    timestampFactor: number;
    duration: number;
    seekEntries: SeekEntry[];
    tracks: InternalTrack[];
    cuePoints: CuePoint[];
    dataStartPos: number;
    elementEndPos: number | null;
    clusterSeekStartPos: number;
    /**
     * Caches the last cluster that was read. Based on the assumption that there will be multiple reads to the
     * same cluster in quick succession.
     */
    lastReadCluster: Cluster | null;
    metadataTags: MetadataTags;
    metadataTagsCollected: boolean;
};
type SeekEntry = {
    id: number;
    segmentPosition: number;
};
type Cluster = {
    segment: Segment;
    elementStartPos: number;
    elementEndPos: number;
    dataStartPos: number;
    timestamp: number;
    trackData: Map<number, ClusterTrackData>;
};
type ClusterTrackData = {
    track: InternalTrack;
    startTimestamp: number;
    endTimestamp: number;
    firstKeyFrameTimestamp: number | null;
    blocks: ClusterBlock[];
    presentationTimestamps: {
        timestamp: number;
        blockIndex: number;
    }[];
};
declare enum BlockLacing {
    None = 0,
    Xiph = 1,
    FixedSize = 2,
    Ebml = 3
}
type ClusterBlock = {
    timestamp: number;
    duration: number;
    isKeyFrame: boolean;
    data: Uint8Array;
    lacing: BlockLacing;
    decoded: boolean;
    mainAdditional: Uint8Array | null;
    referencedTimestamps: number[];
};
type CuePoint = {
    time: number;
    trackId: number;
    clusterPosition: number;
};
declare enum ContentEncodingScope {
    Block = 1,
    Private = 2,
    Next = 4
}
declare enum ContentCompAlgo {
    Zlib = 0,
    Bzlib = 1,
    lzo1x = 2,
    HeaderStripping = 3
}
type DecodingInstruction = {
    order: number;
    scope: ContentEncodingScope;
    data: {
        type: 'decompress';
        algorithm: ContentCompAlgo | null;
        settings: Uint8Array | null;
    } | {
        type: 'decrypt';
    } | null;
};
type InternalTrack = {
    id: number;
    demuxer: MatroskaDemuxer;
    segment: Segment;
    /**
     * List of all encountered cluster offsets alongside their timestamps. This list never gets truncated, but memory
     * consumption should be negligible.
     */
    clusterPositionCache: {
        elementStartPos: number;
        startTimestamp: number;
    }[];
    cuePoints: CuePoint[];
    disposition: TrackDisposition;
    inputTrack: InputTrack | null;
    codecId: string | null;
    codecPrivate: Uint8Array | null;
    defaultDuration: number | null;
    defaultDurationNs: number | null;
    name: string | null;
    languageCode: string;
    decodingInstructions: DecodingInstruction[];
    info: null | {
        type: 'video';
        width: number;
        height: number;
        displayWidth: number | null;
        displayHeight: number | null;
        displayUnit: number | null;
        squarePixelWidth: number;
        squarePixelHeight: number;
        rotation: Rotation;
        codec: VideoCodec | null;
        codecDescription: Uint8Array | null;
        colorSpace: VideoColorSpaceInit | null;
        alphaMode: boolean;
    } | {
        type: 'audio';
        numberOfChannels: number;
        sampleRate: number;
        bitDepth: number;
        codec: AudioCodec | null;
        codecDescription: Uint8Array | null;
        aacCodecInfo: AacCodecInfo | null;
    } | {
        type: 'subtitle';
        codec: SubtitleCodec | null;
        codecPrivateText: string | null;
    };
};
export declare class MatroskaDemuxer extends Demuxer {
    reader: Reader;
    readMetadataPromise: Promise<void> | null;
    segments: Segment[];
    currentSegment: Segment | null;
    currentTrack: InternalTrack | null;
    currentCluster: Cluster | null;
    currentBlock: ClusterBlock | null;
    currentBlockAdditional: {
        addId: number;
        data: Uint8Array | null;
    } | null;
    currentCueTime: number | null;
    currentDecodingInstruction: DecodingInstruction | null;
    currentTagTargetIsMovie: boolean;
    currentSimpleTagName: string | null;
    currentAttachedFile: {
        fileUid: bigint | null;
        fileName: string | null;
        fileMediaType: string | null;
        fileData: Uint8Array | null;
        fileDescription: string | null;
    } | null;
    isWebM: boolean;
    constructor(input: Input);
    computeDuration(): Promise<number>;
    getTracks(): Promise<InputTrack[]>;
    getMimeType(): Promise<string>;
    getMetadataTags(): Promise<MetadataTags>;
    readMetadata(): Promise<void>;
    readSegment(segmentDataStart: number, dataSize: number | undefined): Promise<void>;
    readCluster(startPos: number, segment: Segment): Promise<Cluster>;
    getTrackDataInCluster(cluster: Cluster, trackNumber: number): ClusterTrackData | null;
    expandLacedBlocks(blocks: ClusterBlock[], track: InternalTrack): void;
    loadSegmentMetadata(segment: Segment): Promise<void>;
    readContiguousElements(slice: FileSlice, stopIds?: number[]): number;
    traverseElement(slice: FileSlice, stopIds?: number[]): boolean;
    decodeBlockData(track: InternalTrack, rawData: Uint8Array): Uint8Array<ArrayBufferLike>;
    processTagValue(name: string, value: string | Uint8Array): void;
}
export {};
//# sourceMappingURL=matroska-demuxer.d.ts.map