/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AudioCodec, SubtitleCodec, VideoCodec } from './codec.js';
import { Quality } from './encode.js';
import { Input } from './input.js';
import { InputAudioTrack, InputSubtitleTrack, InputTrack, InputVideoTrack } from './input-track.js';
import { SubtitleSource } from './media-source.js';
import { MaybePromise, Rotation } from './misc.js';
import { Output, SubtitleTrackMetadata } from './output.js';
import { AudioSample, VideoSample } from './sample.js';
import { MetadataTags } from './metadata.js';
/**
 * The options for media file conversion.
 * @group Conversion
 * @public
 */
export type ConversionOptions = {
    /** The input file. */
    input: Input;
    /** The output file. */
    output: Output;
    /**
     * Video-specific options. When passing an object, the same options are applied to all video tracks. When passing a
     * function, it will be invoked for each video track and is expected to return or resolve to the options
     * for that specific track. The function is passed an instance of {@link InputVideoTrack} as well as a number `n`,
     * which is the 1-based index of the track in the list of all video tracks. Using `n` is deprecated, prefer the
     * identical `track.number` instead.
     */
    video?: ConversionVideoOptions | ((track: InputVideoTrack, n: number) => MaybePromise<ConversionVideoOptions | undefined>);
    /**
     * Audio-specific options. When passing an object, the same options are applied to all audio tracks. When passing a
     * function, it will be invoked for each audio track and is expected to return or resolve to the options
     * for that specific track. The function is passed an instance of {@link InputAudioTrack} as well as a number `n`,
     * which is the 1-based index of the track in the list of all audio tracks. Using `n` is deprecated, prefer the
     * identical `track.number` instead.
     */
    audio?: ConversionAudioOptions | ((track: InputAudioTrack, n: number) => MaybePromise<ConversionAudioOptions | undefined>);
    /**
     * Subtitle-specific options. When passing an object, the same options are applied to all subtitle tracks. When passing a
     * function, it will be invoked for each subtitle track and is expected to return or resolve to the options
     * for that specific track. The function is passed an instance of {@link InputSubtitleTrack} as well as a number `n`,
     * which is the 1-based index of the track in the list of all subtitle tracks.
     */
    subtitle?: ConversionSubtitleOptions | ((track: InputSubtitleTrack, n: number) => MaybePromise<ConversionSubtitleOptions | undefined>);
    /** Options to trim the input file. */
    trim?: {
        /**
         * The time in the input file in seconds at which the output file should start. Must be less than `end`.
         * When omitted, defaults to the start timestamp of the input or to 0, whichever is higher.
         */
        start?: number;
        /**
         * The time in the input file in seconds at which the output file should end. Must be greater than `start`.
         * Defaults to the duration of the input when omitted.
         */
        end?: number;
    };
    /**
     * An object or a callback that returns or resolves to an object containing the descriptive metadata tags that
     * should be written to the output file. If a function is passed, it will be passed the tags of the input file as
     * its first argument, allowing you to modify, augment or extend them.
     *
     * If no function is set, the input's metadata tags will be copied to the output.
     */
    tags?: MetadataTags | ((inputTags: MetadataTags) => MaybePromise<MetadataTags>);
    /**
     * Whether to show potential console warnings about discarded tracks after calling `Conversion.init()`, defaults to
     * `true`. Set this to `false` if you're properly handling the `discardedTracks` and `isValid` fields already and
     * want to keep the console output clean.
     */
    showWarnings?: boolean;
};
/**
 * Video-specific options.
 * @group Conversion
 * @public
 */
export type ConversionVideoOptions = {
    /** If `true`, all video tracks will be discarded and will not be present in the output. */
    discard?: boolean;
    /**
     * The desired width of the output video in pixels, defaulting to the video's natural display width. If height
     * is not set, it will be deduced automatically based on aspect ratio.
     */
    width?: number;
    /**
     * The desired height of the output video in pixels, defaulting to the video's natural display height. If width
     * is not set, it will be deduced automatically based on aspect ratio.
     */
    height?: number;
    /**
     * The fitting algorithm in case both width and height are set, or if the input video changes its size over time.
     *
     * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
     * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
     * letterboxing.
     * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
     */
    fit?: 'fill' | 'contain' | 'cover';
    /**
     * The angle in degrees to rotate the input video by, clockwise. Rotation is applied before cropping and resizing.
     * This rotation is _in addition to_ the natural rotation of the input video as specified in input file's metadata.
     */
    rotate?: Rotation;
    /**
     * Defaults to `true`. When enabaled, Mediabunny will use the rotation metadata in the output file to perform video
     * rotation whenever possible. Set this field to `false` if you want to ensure the output file does not make use of
     * rotation metadata and that any rotation is baked into the video frames directly.
     */
    allowRotationMetadata?: boolean;
    /**
     * Specifies the rectangular region of the input video to crop to. The crop region will automatically be clamped to
     * the dimensions of the input video track. Cropping is performed after rotation but before resizing.
     */
    crop?: {
        /** The distance in pixels from the left edge of the source frame to the left edge of the crop rectangle. */
        left: number;
        /** The distance in pixels from the top edge of the source frame to the top edge of the crop rectangle. */
        top: number;
        /** The width in pixels of the crop rectangle. */
        width: number;
        /** The height in pixels of the crop rectangle. */
        height: number;
    };
    /**
     * The desired frame rate of the output video, in hertz. If not specified, the original input frame rate will
     * be used (which may be variable).
     */
    frameRate?: number;
    /** The desired output video codec. */
    codec?: VideoCodec;
    /** The desired bitrate of the output video. */
    bitrate?: number | Quality;
    /**
     * Whether to discard or keep the transparency information of the input video. The default is `'discard'`. Note that
     * for `'keep'` to produce a transparent video, you must use an output config that supports it, such as WebM with
     * VP9.
     */
    alpha?: 'discard' | 'keep';
    /**
     * The interval, in seconds, of how often frames are encoded as a key frame. The default is 5 seconds. Frequent key
     * frames improve seeking behavior but increase file size. When using multiple video tracks, you should give them
     * all the same key frame interval.
     *
     * Setting this fields forces a transcode.
     */
    keyFrameInterval?: number;
    /**
     * A hint that configures the hardware acceleration method used when transcoding. This is best left on
     * `'no-preference'`, the default.
     */
    hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    /** When `true`, video will always be re-encoded instead of directly copying over the encoded samples. */
    forceTranscode?: boolean;
    /**
     * Allows for custom user-defined processing of video frames, e.g. for applying overlays, color transformations, or
     * timestamp modifications. Will be called for each input video sample after transformations and frame rate
     * corrections.
     *
     * Must return a {@link VideoSample} or a `CanvasImageSource`, an array of them, or `null` for dropping the frame.
     * When non-timestamped data is returned, the timestamp and duration from the source sample will be used. Rotation
     * metadata of the returned sample will be ignored.
     *
     * This function can also be used to manually resize frames. When doing so, you should signal the post-process
     * dimensions using the `processedWidth` and `processedHeight` fields, which enables the encoder to better know what
     * to expect. If these fields aren't set, Mediabunny will assume you won't perform any resizing.
     */
    process?: (sample: VideoSample) => MaybePromise<CanvasImageSource | VideoSample | (CanvasImageSource | VideoSample)[] | null>;
    /**
     * An optional hint specifying the width of video samples returned by the `process` function, for better
     * encoder configuration.
     */
    processedWidth?: number;
    /**
     * An optional hint specifying the height of video samples returned by the `process` function, for better
     * encoder configuration.
     */
    processedHeight?: number;
};
/**
 * Audio-specific options.
 * @group Conversion
 * @public
 */
export type ConversionAudioOptions = {
    /** If `true`, all audio tracks will be discarded and will not be present in the output. */
    discard?: boolean;
    /** The desired channel count of the output audio. */
    numberOfChannels?: number;
    /** The desired sample rate of the output audio, in hertz. */
    sampleRate?: number;
    /** The desired output audio codec. */
    codec?: AudioCodec;
    /** The desired bitrate of the output audio. */
    bitrate?: number | Quality;
    /** When `true`, audio will always be re-encoded instead of directly copying over the encoded samples. */
    forceTranscode?: boolean;
    /**
     * Allows for custom user-defined processing of audio samples, e.g. for applying audio effects, transformations, or
     * timestamp modifications. Will be called for each input audio sample after remixing and resampling.
     *
     * Must return an {@link AudioSample}, an array of them, or `null` for dropping the sample.
     *
     * This function can also be used to manually perform remixing or resampling. When doing so, you should signal the
     * post-process parameters using the `processedNumberOfChannels` and `processedSampleRate` fields, which enables the
     * encoder to better know what to expect. If these fields aren't set, Mediabunny will assume you won't perform
     * remixing or resampling.
     */
    process?: (sample: AudioSample) => MaybePromise<AudioSample | AudioSample[] | null>;
    /**
     * An optional hint specifying the channel count of audio samples returned by the `process` function, for better
     * encoder configuration.
     */
    processedNumberOfChannels?: number;
    /**
     * An optional hint specifying the sample rate of audio samples returned by the `process` function, for better
     * encoder configuration.
     */
    processedSampleRate?: number;
};
/**
 * Subtitle-specific options.
 * @group Conversion
 * @public
 */
export type ConversionSubtitleOptions = {
    /** If `true`, all subtitle tracks will be discarded and will not be present in the output. */
    discard?: boolean;
    /** The desired output subtitle codec. */
    codec?: SubtitleCodec;
};
/**
 * An input track that was discarded (excluded) from a {@link Conversion} alongside the discard reason.
 * @group Conversion
 * @public
 */
export type DiscardedTrack = {
    /** The track that was discarded. */
    track: InputTrack;
    /**
     * The reason for discarding the track.
     *
     * - `'discarded_by_user'`: You discarded this track by setting `discard: true`.
     * - `'max_track_count_reached'`: The output had no more room for another track.
     * - `'max_track_count_of_type_reached'`: The output had no more room for another track of this type, or the output
     * doesn't support this track type at all.
     * - `'unknown_source_codec'`: We don't know the codec of the input track and therefore don't know what to do
     * with it.
     * - `'undecodable_source_codec'`: The input track's codec is known, but we are unable to decode it.
     * - `'no_encodable_target_codec'`: We can't find a codec that we are able to encode and that can be contained
     * within the output format. This reason can be hit if the environment doesn't support the necessary encoders, or if
     * you requested a codec that cannot be contained within the output format.
     */
    reason: 'discarded_by_user' | 'max_track_count_reached' | 'max_track_count_of_type_reached' | 'unknown_source_codec' | 'undecodable_source_codec' | 'no_encodable_target_codec';
};
/**
 * Represents a media file conversion process, used to convert one media file into another. In addition to conversion,
 * this class can be used to resize and rotate video, resample audio, drop tracks, or trim to a specific time range.
 * @group Conversion
 * @public
 */
export declare class Conversion {
    /** The input file. */
    readonly input: Input;
    /** The output file. */
    readonly output: Output;
    /**
     * A callback that is fired whenever the conversion progresses. Returns a number between 0 and 1, indicating the
     * completion of the conversion. Note that a progress of 1 doesn't necessarily mean the conversion is complete;
     * the conversion is complete once `execute()` resolves.
     *
     * In order for progress to be computed, this property must be set before `execute` is called.
     */
    onProgress?: (progress: number) => unknown;
    /**
     * Whether this conversion, as it has been configured, is valid and can be executed. If this field is `false`, check
     * the `discardedTracks` field for reasons.
     */
    isValid: boolean;
    /** The list of tracks that are included in the output file. */
    readonly utilizedTracks: InputTrack[];
    /** The list of tracks from the input file that have been discarded, alongside the discard reason. */
    readonly discardedTracks: DiscardedTrack[];
    /** Initializes a new conversion process without starting the conversion. */
    static init(options: ConversionOptions): Promise<Conversion>;
    /** Creates a new Conversion instance (duh). */
    private constructor();
    /**
     * Adds an external subtitle track to the output. This can be called after `init()` but before `execute()`.
     * This is useful for adding subtitle tracks from separate files that are not part of the input video.
     *
     * @param source - The subtitle source to add
     * @param metadata - Optional metadata for the subtitle track
     * @param contentProvider - Optional async function that will be called after the output starts to add content to the subtitle source
     */
    addExternalSubtitleTrack(source: SubtitleSource, metadata?: SubtitleTrackMetadata, contentProvider?: () => Promise<void>): void;
    /**
     * Executes the conversion process. Resolves once conversion is complete.
     *
     * Will throw if `isValid` is `false`.
     */
    execute(): Promise<void>;
    /**
     * Cancels the conversion process, causing any ongoing `execute` call to throw a `ConversionCanceledError`.
     * Does nothing if the conversion is already complete.
     */
    cancel(): Promise<void>;
    /** Converts or passes through a subtitle track into the output format. */
    _processSubtitleTrack(track: InputSubtitleTrack, trackOptions: ConversionSubtitleOptions): Promise<void>;
}
/**
 * Thrown when a conversion couldn't complete due to being canceled.
 * @group Conversion
 * @public
 */
export declare class ConversionCanceledError extends Error {
    /** Creates a new {@link ConversionCanceledError}. */
    constructor(message?: string);
}
/**
 * Utility class to handle audio resampling, handling both sample rate resampling as well as channel up/downmixing.
 * The advantage over doing this manually rather than using OfflineAudioContext to do it for us is the artifact-free
 * handling of putting multiple resampled audio samples back to back, which produces flaky results using
 * OfflineAudioContext.
 */
export declare class AudioResampler {
    sourceSampleRate: number | null;
    targetSampleRate: number;
    sourceNumberOfChannels: number | null;
    targetNumberOfChannels: number;
    startTime: number;
    endTime: number;
    onSample: (sample: AudioSample) => Promise<void>;
    bufferSizeInFrames: number;
    bufferSizeInSamples: number;
    outputBuffer: Float32Array;
    /** Start frame of current buffer */
    bufferStartFrame: number;
    /** The highest index written to in the current buffer */
    maxWrittenFrame: number;
    channelMixer: (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => number;
    tempSourceBuffer: Float32Array;
    constructor(options: {
        targetSampleRate: number;
        targetNumberOfChannels: number;
        startTime: number;
        endTime: number;
        onSample: (sample: AudioSample) => Promise<void>;
    });
    /**
     * Sets up the channel mixer to handle up/downmixing in the case where input and output channel counts don't match.
     */
    doChannelMixerSetup(): void;
    ensureTempBufferSize(requiredSamples: number): void;
    add(audioSample: AudioSample): Promise<void>;
    finalizeCurrentBuffer(): Promise<void>;
    finalize(): Promise<void>;
}
//# sourceMappingURL=conversion.d.ts.map