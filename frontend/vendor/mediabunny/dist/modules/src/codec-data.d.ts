/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { VideoCodec } from './codec.js';
import { Rational } from './misc.js';
import { PacketType } from './packet.js';
import { MetadataTags } from './metadata.js';
export declare enum AvcNalUnitType {
    NON_IDR_SLICE = 1,
    SLICE_DPA = 2,
    SLICE_DPB = 3,
    SLICE_DPC = 4,
    IDR = 5,
    SEI = 6,
    SPS = 7,
    PPS = 8,
    AUD = 9,
    SPS_EXT = 13
}
export declare enum HevcNalUnitType {
    RASL_N = 8,
    RASL_R = 9,
    BLA_W_LP = 16,
    RSV_IRAP_VCL23 = 23,
    VPS_NUT = 32,
    SPS_NUT = 33,
    PPS_NUT = 34,
    AUD_NUT = 35,
    PREFIX_SEI_NUT = 39,
    SUFFIX_SEI_NUT = 40
}
export type NalUnitLocation = {
    offset: number;
    length: number;
};
export declare const iterateNalUnitsInAnnexB: (packetData: Uint8Array) => Generator<NalUnitLocation>;
export declare const iterateNalUnitsInLengthPrefixed: (packetData: Uint8Array, lengthSize: 1 | 2 | 3 | 4) => Generator<NalUnitLocation>;
export declare const iterateAvcNalUnits: (packetData: Uint8Array, decoderConfig: VideoDecoderConfig) => Generator<NalUnitLocation, any, any>;
export declare const extractNalUnitTypeForAvc: (byte: number) => number;
export declare const concatNalUnitsInAnnexB: (nalUnits: Uint8Array[]) => Uint8Array<ArrayBuffer>;
export declare const concatNalUnitsInLengthPrefixed: (nalUnits: Uint8Array[], lengthSize: 1 | 2 | 3 | 4) => Uint8Array<ArrayBuffer>;
export type AvcDecoderConfigurationRecord = {
    configurationVersion: number;
    avcProfileIndication: number;
    profileCompatibility: number;
    avcLevelIndication: number;
    lengthSizeMinusOne: number;
    sequenceParameterSets: Uint8Array[];
    pictureParameterSets: Uint8Array[];
    chromaFormat: number | null;
    bitDepthLumaMinus8: number | null;
    bitDepthChromaMinus8: number | null;
    sequenceParameterSetExt: Uint8Array[] | null;
};
export declare const concatAvcNalUnits: (nalUnits: Uint8Array[], decoderConfig: VideoDecoderConfig) => Uint8Array<ArrayBuffer>;
/** Builds an AvcDecoderConfigurationRecord from an AVC packet in Annex B format. */
export declare const extractAvcDecoderConfigurationRecord: (packetData: Uint8Array) => AvcDecoderConfigurationRecord | null;
/** Serializes an AvcDecoderConfigurationRecord into the format specified in Section 5.3.3.1 of ISO 14496-15. */
export declare const serializeAvcDecoderConfigurationRecord: (record: AvcDecoderConfigurationRecord) => Uint8Array<ArrayBuffer>;
/** Deserializes an AvcDecoderConfigurationRecord from the format specified in Section 5.3.3.1 of ISO 14496-15. */
export declare const deserializeAvcDecoderConfigurationRecord: (data: Uint8Array) => AvcDecoderConfigurationRecord | null;
export type AvcSpsInfo = {
    profileIdc: number;
    constraintFlags: number;
    levelIdc: number;
    frameMbsOnlyFlag: number;
    chromaFormatIdc: number;
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
    codedWidth: number;
    codedHeight: number;
    displayWidth: number;
    displayHeight: number;
    pixelAspectRatio: Rational;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
    fullRangeFlag: number;
    numReorderFrames: number;
    maxDecFrameBuffering: number;
};
/** Parses an AVC SPS (Sequence Parameter Set) to extract basic information. */
export declare const parseAvcSps: (sps: Uint8Array) => AvcSpsInfo | null;
export type HevcDecoderConfigurationRecord = {
    configurationVersion: number;
    generalProfileSpace: number;
    generalTierFlag: number;
    generalProfileIdc: number;
    generalProfileCompatibilityFlags: number;
    generalConstraintIndicatorFlags: Uint8Array;
    generalLevelIdc: number;
    minSpatialSegmentationIdc: number;
    parallelismType: number;
    chromaFormatIdc: number;
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
    avgFrameRate: number;
    constantFrameRate: number;
    numTemporalLayers: number;
    temporalIdNested: number;
    lengthSizeMinusOne: number;
    arrays: {
        arrayCompleteness: number;
        nalUnitType: number;
        nalUnits: Uint8Array[];
    }[];
};
export type HevcSpsInfo = {
    displayWidth: number;
    displayHeight: number;
    pixelAspectRatio: Rational;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
    fullRangeFlag: number;
    maxDecFrameBuffering: number;
    spsMaxSubLayersMinus1: number;
    spsTemporalIdNestingFlag: number;
    generalProfileSpace: number;
    generalTierFlag: number;
    generalProfileIdc: number;
    generalProfileCompatibilityFlags: number;
    generalConstraintIndicatorFlags: Uint8Array;
    generalLevelIdc: number;
    chromaFormatIdc: number;
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
    minSpatialSegmentationIdc: number;
};
export declare const iterateHevcNalUnits: (packetData: Uint8Array, decoderConfig: VideoDecoderConfig) => Generator<NalUnitLocation, any, any>;
export declare const extractNalUnitTypeForHevc: (byte: number) => number;
/** Parses an HEVC SPS (Sequence Parameter Set) to extract video information. */
export declare const parseHevcSps: (sps: Uint8Array) => HevcSpsInfo | null;
/** Builds a HevcDecoderConfigurationRecord from an HEVC packet in Annex B format. */
export declare const extractHevcDecoderConfigurationRecord: (packetData: Uint8Array) => HevcDecoderConfigurationRecord | null;
/** Serializes an HevcDecoderConfigurationRecord into the format specified in Section 8.3.3.1 of ISO 14496-15. */
export declare const serializeHevcDecoderConfigurationRecord: (record: HevcDecoderConfigurationRecord) => Uint8Array<ArrayBuffer>;
/** Deserializes an HevcDecoderConfigurationRecord from the format specified in Section 8.3.3.1 of ISO 14496-15. */
export declare const deserializeHevcDecoderConfigurationRecord: (data: Uint8Array) => HevcDecoderConfigurationRecord | null;
export type Vp9CodecInfo = {
    profile: number;
    level: number;
    bitDepth: number;
    chromaSubsampling: number;
    videoFullRangeFlag: number;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
};
export declare const extractVp9CodecInfoFromPacket: (packet: Uint8Array) => Vp9CodecInfo | null;
export type Av1CodecInfo = {
    profile: number;
    level: number;
    tier: number;
    bitDepth: number;
    monochrome: number;
    chromaSubsamplingX: number;
    chromaSubsamplingY: number;
    chromaSamplePosition: number;
};
/** Iterates over all OBUs in an AV1 packet bistream. */
export declare const iterateAv1PacketObus: (packet: Uint8Array) => Generator<{
    type: number;
    data: Uint8Array<ArrayBufferLike>;
}, void, unknown>;
/**
 * When AV1 codec information is not provided by the container, we can still try to extract the information by digging
 * into the AV1 bitstream.
 */
export declare const extractAv1CodecInfoFromPacket: (packet: Uint8Array) => Av1CodecInfo | null;
export declare const parseOpusIdentificationHeader: (bytes: Uint8Array) => {
    outputChannelCount: number;
    preSkip: number;
    inputSampleRate: number;
    outputGain: number;
    channelMappingFamily: number;
    channelMappingTable: Uint8Array<ArrayBufferLike> | null;
};
export declare const parseOpusTocByte: (packet: Uint8Array) => {
    durationInSamples: number;
};
export declare const parseModesFromVorbisSetupPacket: (setupHeader: Uint8Array) => {
    modeBlockflags: number[];
};
/** Determines a packet's type (key or delta) by digging into the packet bitstream. */
export declare const determineVideoPacketType: (codec: VideoCodec, decoderConfig: VideoDecoderConfig, packetData: Uint8Array) => PacketType | null;
export declare enum FlacBlockType {
    STREAMINFO = 0,
    VORBIS_COMMENT = 4,
    PICTURE = 6
}
export declare const readVorbisComments: (bytes: Uint8Array, metadataTags: MetadataTags) => void;
export declare const createVorbisComments: (headerBytes: Uint8Array, tags: MetadataTags, writeImages: boolean) => Uint8Array<ArrayBuffer>;
/**
 * Channel counts indexed by acmod (Table 4.3).
 * Does NOT include LFE - add lfeon to get total channel count.
 */
export declare const AC3_ACMOD_CHANNEL_COUNTS: number[];
export interface Ac3FrameInfo {
    /** Sample rate code */
    fscod: number;
    /** Bitstream ID */
    bsid: number;
    /** Bitstream mode */
    bsmod: number;
    /** Audio coding mode */
    acmod: number;
    /** LFE channel on */
    lfeon: number;
    /** Bit rate code (0-18, maps to bitrate via Table F.4.1) */
    bitRateCode: number;
}
/**
 * Parse an AC-3 syncframe to extract BSI (Bit Stream Information) fields.
 * Section 4.3
 */
export declare const parseAc3SyncFrame: (data: Uint8Array) => Ac3FrameInfo | null;
/**
 * AC-3 frame sizes in bytes, indexed by [3 * frmsizecod + fscod].
 * fscod: 0=48kHz, 1=44.1kHz, 2=32kHz
 * Values are 16-bit words * 2 (to convert to bytes).
 * Table 4.13
 */
export declare const AC3_FRAME_SIZES: number[];
/** Number of samples per AC-3 syncframe (always 1536) */
export declare const AC3_SAMPLES_PER_FRAME = 1536;
/**
 * AC-3 registration_descriptor for MPEG-TS.
 * Section A.2.3
 */
export declare const AC3_REGISTRATION_DESCRIPTOR: Uint8Array<ArrayBuffer>;
/** E-AC-3 registration_descriptor for MPEG-TS/ */
export declare const EAC3_REGISTRATION_DESCRIPTOR: Uint8Array<ArrayBuffer>;
/** Number of audio blocks per syncframe, indexed by numblkscod */
export declare const EAC3_NUMBLKS_TABLE: number[];
/**
 * E-AC-3 independent substream info.
 * Each independent substream represents a separate audio program.
 */
export interface Eac3SubstreamInfo {
    /** Sample rate code */
    fscod: number;
    /** Sample rate code 2 (ATSC A/52:2018) */
    fscod2: number | null;
    /** Bitstream ID */
    bsid: number;
    /** Bitstream mode */
    bsmod: number;
    /** Audio coding mode */
    acmod: number;
    /** LFE channel on */
    lfeon: number;
    /** Number of dependent substreams */
    numDepSub: number;
    /** Channel locations for dependent substreams */
    chanLoc: number;
}
/**
 * E-AC-3 decoder configuration (dec3 box contents).
 */
export interface Eac3FrameInfo {
    /** Data rate in kbps */
    dataRate: number;
    /** Independent substreams */
    substreams: Eac3SubstreamInfo[];
}
/**
 * Parse an E-AC-3 syncframe to extract BSI fields.
 * Section E.1.2
 */
export declare const parseEac3SyncFrame: (data: Uint8Array) => Eac3FrameInfo | null;
/**
 * Parse a dec3 box to extract E-AC-3 parameters.
 * Section F.6
 */
export declare const parseEac3Config: (data: Uint8Array) => Eac3FrameInfo | null;
/**
 * Get sample rate from E-AC-3 config.
 * See ATSC A/52:2018 for handling fscod2.
 */
export declare const getEac3SampleRate: (config: Eac3FrameInfo) => number | null;
/**
 * Get channel count from E-AC-3 config (first independent substream only).
 */
export declare const getEac3ChannelCount: (config: Eac3FrameInfo) => number;
//# sourceMappingURL=codec-data.d.ts.map