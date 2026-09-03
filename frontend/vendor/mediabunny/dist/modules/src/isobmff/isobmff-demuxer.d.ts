/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AacCodecInfo, AudioCodec, SubtitleCodec, VideoCodec } from '../codec.js';
import { Av1CodecInfo, AvcDecoderConfigurationRecord, HevcDecoderConfigurationRecord, Vp9CodecInfo } from '../codec-data.js';
import { Demuxer } from '../demuxer.js';
import { Input } from '../input.js';
import { InputTrack } from '../input-track.js';
import { Rotation } from '../misc.js';
import { FileSlice, Reader } from '../reader.js';
import { MetadataTags, TrackDisposition } from '../metadata.js';
type InternalTrack = {
    id: number;
    demuxer: IsobmffDemuxer;
    inputTrack: InputTrack | null;
    disposition: TrackDisposition;
    timescale: number;
    durationInMovieTimescale: number;
    durationInMediaTimescale: number;
    rotation: Rotation;
    internalCodecId: string | null;
    name: string | null;
    languageCode: string;
    sampleTableByteOffset: number;
    sampleTable: SampleTable | null;
    fragmentLookupTable: FragmentLookupTableEntry[];
    currentFragmentState: FragmentTrackState | null;
    /**
     * List of all encountered fragment offsets alongside their timestamps. This list never gets truncated, but memory
     * consumption should be negligible.
     */
    fragmentPositionCache: {
        moofOffset: number;
        startTimestamp: number;
        endTimestamp: number;
    }[];
    /** The segment durations of all edit list entries leading up to the main one (from which the offset is taken.) */
    editListPreviousSegmentDurations: number;
    /** The media time offset of the main edit list entry (with media time !== -1) */
    editListOffset: number;
} & ({
    info: null;
} | {
    info: {
        type: 'video';
        width: number;
        height: number;
        squarePixelWidth: number;
        squarePixelHeight: number;
        codec: VideoCodec | null;
        codecDescription: Uint8Array | null;
        colorSpace: VideoColorSpaceInit | null;
        avcType: 1 | 3 | null;
        avcCodecInfo: AvcDecoderConfigurationRecord | null;
        hevcCodecInfo: HevcDecoderConfigurationRecord | null;
        vp9CodecInfo: Vp9CodecInfo | null;
        av1CodecInfo: Av1CodecInfo | null;
    };
} | {
    info: {
        type: 'audio';
        numberOfChannels: number;
        sampleRate: number;
        codec: AudioCodec | null;
        codecDescription: Uint8Array | null;
        aacCodecInfo: AacCodecInfo | null;
    };
} | {
    info: {
        type: 'subtitle';
        codec: SubtitleCodec | null;
        codecPrivateText: string | null;
    };
});
type SampleTable = {
    sampleTimingEntries: SampleTimingEntry[];
    sampleCompositionTimeOffsets: SampleCompositionTimeOffsetEntry[];
    sampleSizes: number[];
    keySampleIndices: number[] | null;
    chunkOffsets: number[];
    sampleToChunk: SampleToChunkEntry[];
    presentationTimestamps: {
        presentationTimestamp: number;
        sampleIndex: number;
    }[] | null;
    /**
     * Provides a fast map from sample index to index in the sorted presentation timestamps array - so, a fast map from
     * decode order to presentation order.
     */
    presentationTimestampIndexMap: number[] | null;
};
type SampleTimingEntry = {
    startIndex: number;
    startDecodeTimestamp: number;
    count: number;
    delta: number;
};
type SampleCompositionTimeOffsetEntry = {
    startIndex: number;
    count: number;
    offset: number;
};
type SampleToChunkEntry = {
    startSampleIndex: number;
    startChunkIndex: number;
    samplesPerChunk: number;
    sampleDescriptionIndex: number;
};
type FragmentTrackDefaults = {
    trackId: number;
    defaultSampleDescriptionIndex: number;
    defaultSampleDuration: number;
    defaultSampleSize: number;
    defaultSampleFlags: number;
};
type FragmentLookupTableEntry = {
    timestamp: number;
    moofOffset: number;
};
type FragmentTrackState = {
    baseDataOffset: number;
    sampleDescriptionIndex: number | null;
    defaultSampleDuration: number | null;
    defaultSampleSize: number | null;
    defaultSampleFlags: number | null;
    startTimestamp: number | null;
};
type FragmentTrackData = {
    track: InternalTrack;
    startTimestamp: number;
    endTimestamp: number;
    firstKeyFrameTimestamp: number | null;
    samples: FragmentTrackSample[];
    presentationTimestamps: {
        presentationTimestamp: number;
        sampleIndex: number;
    }[];
    startTimestampIsFinal: boolean;
};
type FragmentTrackSample = {
    presentationTimestamp: number;
    duration: number;
    byteOffset: number;
    byteSize: number;
    isKeyFrame: boolean;
};
type Fragment = {
    moofOffset: number;
    moofSize: number;
    implicitBaseDataOffset: number;
    trackData: Map<InternalTrack['id'], FragmentTrackData>;
};
export declare class IsobmffDemuxer extends Demuxer {
    reader: Reader;
    moovSlice: FileSlice | null;
    currentTrack: InternalTrack | null;
    tracks: InternalTrack[];
    metadataPromise: Promise<void> | null;
    movieTimescale: number;
    movieDurationInTimescale: number;
    isQuickTime: boolean;
    metadataTags: MetadataTags;
    currentMetadataKeys: Map<number, string> | null;
    isFragmented: boolean;
    fragmentTrackDefaults: FragmentTrackDefaults[];
    currentFragment: Fragment | null;
    /**
     * Caches the last fragment that was read. Based on the assumption that there will be multiple reads to the
     * same fragment in quick succession.
     */
    lastReadFragment: Fragment | null;
    constructor(input: Input);
    computeDuration(): Promise<number>;
    getTracks(): Promise<InputTrack[]>;
    getMimeType(): Promise<string>;
    getMetadataTags(): Promise<MetadataTags>;
    readMetadata(): Promise<void>;
    getSampleTableForTrack(internalTrack: InternalTrack): SampleTable;
    readFragment(startPos: number): Promise<Fragment>;
    readContiguousBoxes(slice: FileSlice): void;
    iterateContiguousBoxes(slice: FileSlice): Generator<{
        boxInfo: {
            name: string;
            totalSize: number;
            headerSize: number;
            contentSize: number;
        };
        slice: FileSlice;
    }, void, unknown>;
    traverseBox(slice: FileSlice): boolean;
}
export {};
//# sourceMappingURL=isobmff-demuxer.d.ts.map