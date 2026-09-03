/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AudioCodec, MediaCodec, SubtitleCodec, VideoCodec } from './codec.js';
import { EncodedPacket } from './packet.js';
/**
 * Configuration object that controls video encoding. Can be used to set codec, quality, and more.
 * @group Encoding
 * @public
 */
export type VideoEncodingConfig = {
    /** The video codec that should be used for encoding the video samples (frames). */
    codec: VideoCodec;
    /**
     * The target bitrate for the encoded video, in bits per second. Alternatively, a subjective {@link Quality} can
     * be provided.
     */
    bitrate: number | Quality;
    /**
     * The interval, in seconds, of how often frames are encoded as a key frame. The default is 5 seconds. Frequent key
     * frames improve seeking behavior but increase file size. When using multiple video tracks, you should give them
     * all the same key frame interval.
     */
    keyFrameInterval?: number;
    /**
     * Video frames may change size over time. This field controls the behavior in case this happens.
     *
     * - `'deny'` (default) will throw an error, requiring all frames to have the exact same dimensions.
     * - `'passThrough'` will allow the change and directly pass the frame to the encoder.
     * - `'fill'` will stretch the image to fill the entire original box, potentially altering aspect ratio.
     * - `'contain'` will contain the entire image within the original box while preserving aspect ratio. This may lead
     * to letterboxing.
     * - `'cover'` will scale the image until the entire original box is filled, while preserving aspect ratio.
     *
     * The "original box" refers to the dimensions of the first encoded frame.
     */
    sizeChangeBehavior?: 'deny' | 'passThrough' | 'fill' | 'contain' | 'cover';
    /** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
    onEncodedPacket?: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => unknown;
    /**
     * Called when the internal [encoder config](https://www.w3.org/TR/webcodecs/#video-encoder-config), as used by the
     * WebCodecs API, is created.
     */
    onEncoderConfig?: (config: VideoEncoderConfig) => unknown;
} & VideoEncodingAdditionalOptions;
export declare const validateVideoEncodingConfig: (config: VideoEncodingConfig) => void;
/**
 * Additional options that control audio encoding.
 * @group Encoding
 * @public
 */
export type VideoEncodingAdditionalOptions = {
    /**
     * What to do with alpha data contained in the video samples.
     *
     * - `'discard'` (default): Only the samples' color data is kept; the video is opaque.
     * - `'keep'`: The samples' alpha data is also encoded as side data. Make sure to pair this mode with a container
     * format that supports transparency (such as WebM or Matroska).
     */
    alpha?: 'discard' | 'keep';
    /** Configures the bitrate mode; defaults to `'variable'`. */
    bitrateMode?: 'constant' | 'variable';
    /**
     * The latency mode used by the encoder; controls the performance-quality tradeoff.
     *
     * - `'quality'` (default): The encoder prioritizes quality over latency, and no frames can be dropped.
     * - `'realtime'`: The encoder prioritizes low latency over quality, and may drop frames if the encoder becomes
     * overloaded to keep up with real-time requirements.
     */
    latencyMode?: 'quality' | 'realtime';
    /**
     * The full codec string as specified in the Mediabunny Codec Registry. This string must match the codec
     * specified in `codec`. When not set, a fitting codec string will be constructed automatically by the library.
     */
    fullCodecString?: string;
    /**
     * A hint that configures the hardware acceleration method of this codec. This is best left on `'no-preference'`,
     * the default.
     */
    hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    /**
     * An encoding scalability mode identifier as defined by
     * [WebRTC-SVC](https://w3c.github.io/webrtc-svc/#scalabilitymodes*).
     */
    scalabilityMode?: string;
    /**
     * An encoding video content hint as defined by
     * [mst-content-hint](https://w3c.github.io/mst-content-hint/#video-content-hints).
     */
    contentHint?: string;
};
export declare const validateVideoEncodingAdditionalOptions: (codec: VideoCodec, options: VideoEncodingAdditionalOptions) => void;
export declare const buildVideoEncoderConfig: (options: {
    codec: VideoCodec;
    width: number;
    height: number;
    bitrate: number | Quality;
    framerate: number | undefined;
    squarePixelWidth?: number;
    squarePixelHeight?: number;
} & VideoEncodingAdditionalOptions) => VideoEncoderConfig;
/**
 * Configuration object that controls audio encoding. Can be used to set codec, quality, and more.
 * @group Encoding
 * @public
 */
export type AudioEncodingConfig = {
    /** The audio codec that should be used for encoding the audio samples. */
    codec: AudioCodec;
    /**
     * The target bitrate for the encoded audio, in bits per second. Alternatively, a subjective {@link Quality} can
     * be provided. Required for compressed audio codecs, unused for PCM codecs.
     */
    bitrate?: number | Quality;
    /** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
    onEncodedPacket?: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => unknown;
    /**
     * Called when the internal [encoder config](https://www.w3.org/TR/webcodecs/#audio-encoder-config), as used by the
     * WebCodecs API, is created.
     */
    onEncoderConfig?: (config: AudioEncoderConfig) => unknown;
} & AudioEncodingAdditionalOptions;
export declare const validateAudioEncodingConfig: (config: AudioEncodingConfig) => void;
/**
 * Additional options that control audio encoding.
 * @group Encoding
 * @public
 */
export type AudioEncodingAdditionalOptions = {
    /** Configures the bitrate mode. */
    bitrateMode?: 'constant' | 'variable';
    /**
     * The full codec string as specified in the Mediabunny Codec Registry. This string must match the codec
     * specified in `codec`. When not set, a fitting codec string will be constructed automatically by the library.
     */
    fullCodecString?: string;
};
export declare const validateAudioEncodingAdditionalOptions: (codec: AudioCodec, options: AudioEncodingAdditionalOptions) => void;
export declare const buildAudioEncoderConfig: (options: {
    codec: AudioCodec;
    numberOfChannels: number;
    sampleRate: number;
    bitrate?: number | Quality;
} & AudioEncodingAdditionalOptions) => AudioEncoderConfig;
/**
 * Represents a subjective media quality level.
 * @group Encoding
 * @public
 */
export declare class Quality {
}
/**
 * Represents a very low media quality.
 * @group Encoding
 * @public
 */
export declare const QUALITY_VERY_LOW: Quality;
/**
 * Represents a low media quality.
 * @group Encoding
 * @public
 */
export declare const QUALITY_LOW: Quality;
/**
 * Represents a medium media quality.
 * @group Encoding
 * @public
 */
export declare const QUALITY_MEDIUM: Quality;
/**
 * Represents a high media quality.
 * @group Encoding
 * @public
 */
export declare const QUALITY_HIGH: Quality;
/**
 * Represents a very high media quality.
 * @group Encoding
 * @public
 */
export declare const QUALITY_VERY_HIGH: Quality;
/**
 * Checks if the browser is able to encode the given codec.
 * @group Encoding
 * @public
 */
export declare const canEncode: (codec: MediaCodec) => Promise<boolean>;
/**
 * Checks if the browser is able to encode the given video codec with the given parameters.
 * @group Encoding
 * @public
 */
export declare const canEncodeVideo: (codec: VideoCodec, options?: {
    width?: number;
    height?: number;
    bitrate?: number | Quality;
} & VideoEncodingAdditionalOptions) => Promise<boolean>;
/**
 * Checks if the browser is able to encode the given audio codec with the given parameters.
 * @group Encoding
 * @public
 */
export declare const canEncodeAudio: (codec: AudioCodec, options?: {
    numberOfChannels?: number;
    sampleRate?: number;
    bitrate?: number | Quality;
} & AudioEncodingAdditionalOptions) => Promise<boolean>;
/**
 * Checks if the browser is able to encode the given subtitle codec.
 * @group Encoding
 * @public
 */
export declare const canEncodeSubtitles: (codec: SubtitleCodec) => Promise<boolean>;
/**
 * Returns the list of all media codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getEncodableCodecs: () => Promise<MediaCodec[]>;
/**
 * Returns the list of all video codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getEncodableVideoCodecs: (checkedCodecs?: VideoCodec[], options?: {
    width?: number;
    height?: number;
    bitrate?: number | Quality;
}) => Promise<VideoCodec[]>;
/**
 * Returns the list of all audio codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getEncodableAudioCodecs: (checkedCodecs?: AudioCodec[], options?: {
    numberOfChannels?: number;
    sampleRate?: number;
    bitrate?: number | Quality;
}) => Promise<AudioCodec[]>;
/**
 * Returns the list of all subtitle codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getEncodableSubtitleCodecs: (checkedCodecs?: SubtitleCodec[]) => Promise<SubtitleCodec[]>;
/**
 * Returns the first video codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getFirstEncodableVideoCodec: (checkedCodecs: VideoCodec[], options?: {
    width?: number;
    height?: number;
    bitrate?: number | Quality;
}) => Promise<VideoCodec | null>;
/**
 * Returns the first audio codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getFirstEncodableAudioCodec: (checkedCodecs: AudioCodec[], options?: {
    numberOfChannels?: number;
    sampleRate?: number;
    bitrate?: number | Quality;
}) => Promise<AudioCodec | null>;
/**
 * Returns the first subtitle codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export declare const getFirstEncodableSubtitleCodec: (checkedCodecs: SubtitleCodec[]) => Promise<SubtitleCodec | null>;
//# sourceMappingURL=encode.d.ts.map