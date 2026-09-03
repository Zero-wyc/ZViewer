/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AudioCodec, MediaCodec, SubtitleCodec, VideoCodec } from './codec.js';
import { Input } from './input.js';
import { PacketRetrievalOptions } from './media-sink.js';
import { Rational, Rotation } from './misc.js';
import { TrackType } from './output.js';
import { EncodedPacket, PacketType } from './packet.js';
import { TrackDisposition } from './metadata.js';
import { SubtitleCue } from './subtitles.js';
/**
 * Contains aggregate statistics about the encoded packets of a track.
 * @group Input files & tracks
 * @public
 */
export type PacketStats = {
    /** The total number of packets. */
    packetCount: number;
    /** The average number of packets per second. For video tracks, this will equal the average frame rate (FPS). */
    averagePacketRate: number;
    /** The average number of bits per second. */
    averageBitrate: number;
};
export interface InputTrackBacking {
    getId(): number;
    getNumber(): number;
    getCodec(): MediaCodec | null;
    getInternalCodecId(): string | number | Uint8Array | null;
    getName(): string | null;
    getLanguageCode(): string;
    getTimeResolution(): number;
    getDisposition(): TrackDisposition;
    getFirstTimestamp(): Promise<number>;
    computeDuration(): Promise<number>;
    getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
}
/**
 * Represents a media track in an input file.
 * @group Input files & tracks
 * @public
 */
export declare abstract class InputTrack {
    /** The input file this track belongs to. */
    readonly input: Input;
    /** The type of the track. */
    abstract get type(): TrackType;
    /** The codec of the track's packets. */
    abstract get codec(): MediaCodec | null;
    /** Returns the full codec parameter string for this track. */
    abstract getCodecParameterString(): Promise<string | null>;
    /** Checks if this track's packets can be decoded by the browser. */
    abstract canDecode(): Promise<boolean>;
    /**
     * For a given packet of this track, this method determines the actual type of this packet (key/delta) by looking
     * into its bitstream. Returns null if the type couldn't be determined.
     */
    abstract determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
    /** Returns true if and only if this track is a video track. */
    isVideoTrack(): this is InputVideoTrack;
    /** Returns true if and only if this track is an audio track. */
    isAudioTrack(): this is InputAudioTrack;
    /** Returns true if and only if this track is a subtitle track. */
    isSubtitleTrack(): this is InputSubtitleTrack;
    /** The unique ID of this track in the input file. */
    get id(): number;
    /**
     * The 1-based index of this track among all tracks of the same type in the input file. For example, the first
     * video track has number 1, the second video track has number 2, and so on. The index refers to the order in
     * which the tracks are returned by {@link Input.getTracks}.
     */
    get number(): number;
    /**
     * The identifier of the codec used internally by the container. It is not homogenized by Mediabunny
     * and depends entirely on the container format.
     *
     * This field can be used to determine the codec of a track in case Mediabunny doesn't know that codec.
     *
     * - For ISOBMFF files, this field returns the name of the Sample Description Box (e.g. `'avc1'`).
     * - For Matroska files, this field returns the value of the `CodecID` element.
     * - For WAVE files, this field returns the value of the format tag in the `'fmt '` chunk.
     * - For ADTS files, this field contains the `MPEG-4 Audio Object Type`.
     * - For MPEG-TS files, this field contains the `streamType` value from the Program Map Table.
     * - In all other cases, this field is `null`.
     */
    get internalCodecId(): string | number | Uint8Array<ArrayBufferLike> | null;
    /**
     * The ISO 639-2/T language code for this track. If the language is unknown, this field is `'und'` (undetermined).
     */
    get languageCode(): string;
    /** A user-defined name for this track. */
    get name(): string | null;
    /**
     * A positive number x such that all timestamps and durations of all packets of this track are
     * integer multiples of 1/x.
     */
    get timeResolution(): number;
    /** The track's disposition, i.e. information about its intended usage. */
    get disposition(): TrackDisposition;
    /**
     * Returns the start timestamp of the first packet of this track, in seconds. While often near zero, this value
     * may be positive or even negative. A negative starting timestamp means the track's timing has been offset. Samples
     * with a negative timestamp should not be presented.
     */
    getFirstTimestamp(): Promise<number>;
    /** Returns the end timestamp of the last packet of this track, in seconds. */
    computeDuration(): Promise<number>;
    /**
     * Computes aggregate packet statistics for this track, such as average packet rate or bitrate.
     *
     * @param targetPacketCount - This optional parameter sets a target for how many packets this method must have
     * looked at before it can return early; this means, you can use it to aggregate only a subset (prefix) of all
     * packets. This is very useful for getting a great estimate of video frame rate without having to scan through the
     * entire file.
     */
    computePacketStats(targetPacketCount?: number): Promise<PacketStats>;
}
export interface InputVideoTrackBacking extends InputTrackBacking {
    getCodec(): VideoCodec | null;
    getCodedWidth(): number;
    getCodedHeight(): number;
    getSquarePixelWidth(): number;
    getSquarePixelHeight(): number;
    getRotation(): Rotation;
    getColorSpace(): Promise<VideoColorSpaceInit>;
    canBeTransparent(): Promise<boolean>;
    getDecoderConfig(): Promise<VideoDecoderConfig | null>;
}
/**
 * Represents a video track in an input file.
 * @group Input files & tracks
 * @public
 */
export declare class InputVideoTrack extends InputTrack {
    /**
     * The pixel aspect ratio of the track's frames, as a rational number in its reduced form. Most videos use
     * square pixels (1:1).
     */
    readonly pixelAspectRatio: Rational;
    get type(): TrackType;
    get codec(): VideoCodec | null;
    /** The width in pixels of the track's coded samples, before any transformations or rotations. */
    get codedWidth(): number;
    /** The height in pixels of the track's coded samples, before any transformations or rotations. */
    get codedHeight(): number;
    /** The angle in degrees by which the track's frames should be rotated (clockwise). */
    get rotation(): Rotation;
    /** The width of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation. */
    get squarePixelWidth(): number;
    /** The height of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation. */
    get squarePixelHeight(): number;
    /** The display width of the track's frames in pixels, after aspect ratio adjustment and rotation. */
    get displayWidth(): number;
    /** The display height of the track's frames in pixels, after aspect ratio adjustment and rotation. */
    get displayHeight(): number;
    /** Returns the color space of the track's samples. */
    getColorSpace(): Promise<VideoColorSpaceInit>;
    /** If this method returns true, the track's samples use a high dynamic range (HDR). */
    hasHighDynamicRange(): Promise<boolean>;
    /** Checks if this track may contain transparent samples with alpha data. */
    canBeTransparent(): Promise<boolean>;
    /**
     * Returns the [decoder configuration](https://www.w3.org/TR/webcodecs/#video-decoder-config) for decoding the
     * track's packets using a [`VideoDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder). Returns
     * null if the track's codec is unknown.
     */
    getDecoderConfig(): Promise<VideoDecoderConfig | null>;
    getCodecParameterString(): Promise<string | null>;
    canDecode(): Promise<boolean>;
    determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
}
export interface InputAudioTrackBacking extends InputTrackBacking {
    getCodec(): AudioCodec | null;
    getNumberOfChannels(): number;
    getSampleRate(): number;
    getDecoderConfig(): Promise<AudioDecoderConfig | null>;
}
/**
 * Represents an audio track in an input file.
 * @group Input files & tracks
 * @public
 */
export declare class InputAudioTrack extends InputTrack {
    get type(): TrackType;
    get codec(): AudioCodec | null;
    /** The number of audio channels in the track. */
    get numberOfChannels(): number;
    /** The track's audio sample rate in hertz. */
    get sampleRate(): number;
    /**
     * Returns the [decoder configuration](https://www.w3.org/TR/webcodecs/#audio-decoder-config) for decoding the
     * track's packets using an [`AudioDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder). Returns
     * null if the track's codec is unknown.
     */
    getDecoderConfig(): Promise<AudioDecoderConfig | null>;
    getCodecParameterString(): Promise<string | null>;
    canDecode(): Promise<boolean>;
    determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
}
export interface InputSubtitleTrackBacking extends InputTrackBacking {
    getCodec(): SubtitleCodec | null;
    getCodecPrivate(): string | null;
    getCues(): AsyncGenerator<SubtitleCue>;
}
/**
 * Represents a subtitle track in an input file.
 * @group Input files & tracks
 * @public
 */
export declare class InputSubtitleTrack extends InputTrack {
    get type(): TrackType;
    get codec(): SubtitleCodec | null;
    /**
     * Returns an async iterator that yields all subtitle cues in this track.
     */
    getCues(): AsyncGenerator<SubtitleCue>;
    /**
     * Exports all subtitle cues to text format. If targetFormat is specified,
     * attempts to convert to that format (limited conversion support).
     */
    exportToText(targetFormat?: SubtitleCodec): Promise<string>;
    getCodecParameterString(): Promise<string | null>;
    canDecode(): Promise<boolean>;
    determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
}
//# sourceMappingURL=input-track.d.ts.map