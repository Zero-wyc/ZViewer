/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AUDIO_CODECS, buildAudioCodecString, buildVideoCodecString, getAudioEncoderConfigExtension, getVideoEncoderConfigExtension, inferCodecFromCodecString, PCM_AUDIO_CODECS, SUBTITLE_CODECS, VIDEO_CODECS, } from './codec.js';
import { customAudioEncoders, customVideoEncoders } from './custom-coder.js';
import { isFirefox } from './misc.js';
export const validateVideoEncodingConfig = (config) => {
    if (!config || typeof config !== 'object') {
        throw new TypeError('Encoding config must be an object.');
    }
    if (!VIDEO_CODECS.includes(config.codec)) {
        throw new TypeError(`Invalid video codec '${config.codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
    }
    if (!(config.bitrate instanceof Quality) && (!Number.isInteger(config.bitrate) || config.bitrate <= 0)) {
        throw new TypeError('config.bitrate must be a positive integer or a quality.');
    }
    if (config.keyFrameInterval !== undefined
        && (!Number.isFinite(config.keyFrameInterval) || config.keyFrameInterval < 0)) {
        throw new TypeError('config.keyFrameInterval, when provided, must be a non-negative number.');
    }
    if (config.sizeChangeBehavior !== undefined
        && !['deny', 'passThrough', 'fill', 'contain', 'cover'].includes(config.sizeChangeBehavior)) {
        throw new TypeError('config.sizeChangeBehavior, when provided, must be \'deny\', \'passThrough\', \'fill\', \'contain\''
            + ' or \'cover\'.');
    }
    if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
        throw new TypeError('config.onEncodedChunk, when provided, must be a function.');
    }
    if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
        throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
    }
    validateVideoEncodingAdditionalOptions(config.codec, config);
};
export const validateVideoEncodingAdditionalOptions = (codec, options) => {
    if (!options || typeof options !== 'object') {
        throw new TypeError('Encoding options must be an object.');
    }
    if (options.alpha !== undefined && !['discard', 'keep'].includes(options.alpha)) {
        throw new TypeError('options.alpha, when provided, must be \'discard\' or \'keep\'.');
    }
    if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
        throw new TypeError('bitrateMode, when provided, must be \'constant\' or \'variable\'.');
    }
    if (options.latencyMode !== undefined && !['quality', 'realtime'].includes(options.latencyMode)) {
        throw new TypeError('latencyMode, when provided, must be \'quality\' or \'realtime\'.');
    }
    if (options.fullCodecString !== undefined && typeof options.fullCodecString !== 'string') {
        throw new TypeError('fullCodecString, when provided, must be a string.');
    }
    if (options.fullCodecString !== undefined && inferCodecFromCodecString(options.fullCodecString) !== codec) {
        throw new TypeError(`fullCodecString, when provided, must be a string that matches the specified codec (${codec}).`);
    }
    if (options.hardwareAcceleration !== undefined
        && !['no-preference', 'prefer-hardware', 'prefer-software'].includes(options.hardwareAcceleration)) {
        throw new TypeError('hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
            + ' \'prefer-software\'.');
    }
    if (options.scalabilityMode !== undefined && typeof options.scalabilityMode !== 'string') {
        throw new TypeError('scalabilityMode, when provided, must be a string.');
    }
    if (options.contentHint !== undefined && typeof options.contentHint !== 'string') {
        throw new TypeError('contentHint, when provided, must be a string.');
    }
};
export const buildVideoEncoderConfig = (options) => {
    const resolvedBitrate = options.bitrate instanceof Quality
        ? options.bitrate._toVideoBitrate(options.codec, options.width, options.height)
        : options.bitrate;
    return {
        codec: options.fullCodecString ?? buildVideoCodecString(options.codec, options.width, options.height, resolvedBitrate),
        width: options.width,
        height: options.height,
        displayWidth: options.squarePixelWidth,
        displayHeight: options.squarePixelHeight,
        bitrate: resolvedBitrate,
        bitrateMode: options.bitrateMode,
        alpha: options.alpha ?? 'discard',
        framerate: options.framerate,
        latencyMode: options.latencyMode,
        hardwareAcceleration: options.hardwareAcceleration,
        scalabilityMode: options.scalabilityMode,
        contentHint: options.contentHint,
        ...getVideoEncoderConfigExtension(options.codec),
    };
};
export const validateAudioEncodingConfig = (config) => {
    if (!config || typeof config !== 'object') {
        throw new TypeError('Encoding config must be an object.');
    }
    if (!AUDIO_CODECS.includes(config.codec)) {
        throw new TypeError(`Invalid audio codec '${config.codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
    }
    if (config.bitrate === undefined
        && (!PCM_AUDIO_CODECS.includes(config.codec) || config.codec === 'flac')) {
        throw new TypeError('config.bitrate must be provided for compressed audio codecs.');
    }
    if (config.bitrate !== undefined
        && !(config.bitrate instanceof Quality)
        && (!Number.isInteger(config.bitrate) || config.bitrate <= 0)) {
        throw new TypeError('config.bitrate, when provided, must be a positive integer or a quality.');
    }
    if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
        throw new TypeError('config.onEncodedChunk, when provided, must be a function.');
    }
    if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
        throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
    }
    validateAudioEncodingAdditionalOptions(config.codec, config);
};
export const validateAudioEncodingAdditionalOptions = (codec, options) => {
    if (!options || typeof options !== 'object') {
        throw new TypeError('Encoding options must be an object.');
    }
    if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
        throw new TypeError('bitrateMode, when provided, must be \'constant\' or \'variable\'.');
    }
    if (options.fullCodecString !== undefined && typeof options.fullCodecString !== 'string') {
        throw new TypeError('fullCodecString, when provided, must be a string.');
    }
    if (options.fullCodecString !== undefined && inferCodecFromCodecString(options.fullCodecString) !== codec) {
        throw new TypeError(`fullCodecString, when provided, must be a string that matches the specified codec (${codec}).`);
    }
};
export const buildAudioEncoderConfig = (options) => {
    const resolvedBitrate = options.bitrate instanceof Quality
        ? options.bitrate._toAudioBitrate(options.codec)
        : options.bitrate;
    return {
        codec: options.fullCodecString ?? buildAudioCodecString(options.codec, options.numberOfChannels, options.sampleRate),
        numberOfChannels: options.numberOfChannels,
        sampleRate: options.sampleRate,
        bitrate: resolvedBitrate,
        bitrateMode: options.bitrateMode,
        ...getAudioEncoderConfigExtension(options.codec),
    };
};
/**
 * Represents a subjective media quality level.
 * @group Encoding
 * @public
 */
export class Quality {
    /** @internal */
    constructor(factor) {
        this._factor = factor;
    }
    /** @internal */
    _toVideoBitrate(codec, width, height) {
        const pixels = width * height;
        const codecEfficiencyFactors = {
            avc: 1.0, // H.264/AVC (baseline)
            hevc: 0.6, // H.265/HEVC (~40% more efficient than AVC)
            vp9: 0.6, // Similar to HEVC
            av1: 0.4, // ~60% more efficient than AVC
            vp8: 1.2, // Slightly less efficient than AVC
        };
        const referencePixels = 1920 * 1080;
        const referenceBitrate = 3000000;
        const scaleFactor = Math.pow(pixels / referencePixels, 0.95); // Slight non-linear scaling
        const baseBitrate = referenceBitrate * scaleFactor;
        const codecAdjustedBitrate = baseBitrate * codecEfficiencyFactors[codec];
        const finalBitrate = codecAdjustedBitrate * this._factor;
        return Math.ceil(finalBitrate / 1000) * 1000;
    }
    /** @internal */
    _toAudioBitrate(codec) {
        if (PCM_AUDIO_CODECS.includes(codec) || codec === 'flac') {
            return undefined;
        }
        const baseRates = {
            aac: 128000, // 128kbps base for AAC
            opus: 64000, // 64kbps base for Opus
            mp3: 160000, // 160kbps base for MP3
            vorbis: 64000, // 64kbps base for Vorbis
            ac3: 384000, // 384kbps base for AC-3
            eac3: 192000, // 192kbps base for E-AC-3
        };
        const baseBitrate = baseRates[codec];
        if (!baseBitrate) {
            throw new Error(`Unhandled codec: ${codec}`);
        }
        let finalBitrate = baseBitrate * this._factor;
        if (codec === 'aac') {
            // AAC only works with specific bitrates, let's find the closest
            const validRates = [96000, 128000, 160000, 192000];
            finalBitrate = validRates.reduce((prev, curr) => Math.abs(curr - finalBitrate) < Math.abs(prev - finalBitrate) ? curr : prev);
        }
        else if (codec === 'opus' || codec === 'vorbis') {
            finalBitrate = Math.max(6000, finalBitrate);
        }
        else if (codec === 'mp3') {
            const validRates = [
                8000, 16000, 24000, 32000, 40000, 48000, 64000, 80000,
                96000, 112000, 128000, 160000, 192000, 224000, 256000, 320000,
            ];
            finalBitrate = validRates.reduce((prev, curr) => Math.abs(curr - finalBitrate) < Math.abs(prev - finalBitrate) ? curr : prev);
        }
        return Math.round(finalBitrate / 1000) * 1000;
    }
}
/**
 * Represents a very low media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_VERY_LOW = /* #__PURE__ */ new Quality(0.3);
/**
 * Represents a low media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_LOW = /* #__PURE__ */ new Quality(0.6);
/**
 * Represents a medium media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_MEDIUM = /* #__PURE__ */ new Quality(1);
/**
 * Represents a high media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_HIGH = /* #__PURE__ */ new Quality(2);
/**
 * Represents a very high media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_VERY_HIGH = /* #__PURE__ */ new Quality(4);
/**
 * Checks if the browser is able to encode the given codec.
 * @group Encoding
 * @public
 */
export const canEncode = (codec) => {
    if (VIDEO_CODECS.includes(codec)) {
        return canEncodeVideo(codec);
    }
    else if (AUDIO_CODECS.includes(codec)) {
        return canEncodeAudio(codec);
    }
    else if (SUBTITLE_CODECS.includes(codec)) {
        return canEncodeSubtitles(codec);
    }
    throw new TypeError(`Unknown codec '${codec}'.`);
};
/**
 * Checks if the browser is able to encode the given video codec with the given parameters.
 * @group Encoding
 * @public
 */
export const canEncodeVideo = async (codec, options = {}) => {
    const { width = 1280, height = 720, bitrate = 1e6, ...restOptions } = options;
    if (!VIDEO_CODECS.includes(codec)) {
        return false;
    }
    if (!Number.isInteger(width) || width <= 0) {
        throw new TypeError('width must be a positive integer.');
    }
    if (!Number.isInteger(height) || height <= 0) {
        throw new TypeError('height must be a positive integer.');
    }
    if (!(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
        throw new TypeError('bitrate must be a positive integer or a quality.');
    }
    validateVideoEncodingAdditionalOptions(codec, restOptions);
    let encoderConfig = null;
    if (customVideoEncoders.length > 0) {
        encoderConfig ??= buildVideoEncoderConfig({
            codec,
            width,
            height,
            bitrate,
            framerate: undefined,
            ...restOptions,
        });
        if (customVideoEncoders.some(x => x.supports(codec, encoderConfig))) {
            // There's a custom encoder
            return true;
        }
    }
    if (typeof VideoEncoder === 'undefined') {
        return false;
    }
    const hasOddDimension = width % 2 === 1 || height % 2 === 1;
    if (hasOddDimension
        && (codec === 'avc' || codec === 'hevc')) {
        // Disallow odd dimensions for certain codecs
        return false;
    }
    encoderConfig ??= buildVideoEncoderConfig({
        codec,
        width,
        height,
        bitrate,
        framerate: undefined,
        ...restOptions,
        alpha: 'discard', // Since we handle alpha ourselves
    });
    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
        return false;
    }
    if (isFirefox()) {
        // isConfigSupported on Firefox appears to unreliably indicate if encoding will actually succeed. Therefore, we
        // just try encoding a frame to see if it actually works.
        // https://github.com/Vanilagy/mediabunny/issues/222
        // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
        return new Promise(async (resolve) => {
            try {
                const encoder = new VideoEncoder({
                    output: () => { },
                    error: () => resolve(false),
                });
                encoder.configure(encoderConfig);
                const frameData = new Uint8Array(width * height * 4);
                const frame = new VideoFrame(frameData, {
                    format: 'RGBA',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp: 0,
                });
                encoder.encode(frame);
                frame.close();
                await encoder.flush();
                resolve(true);
            }
            catch {
                resolve(false);
            }
        });
    }
    else {
        return true;
    }
};
/**
 * Checks if the browser is able to encode the given audio codec with the given parameters.
 * @group Encoding
 * @public
 */
export const canEncodeAudio = async (codec, options = {}) => {
    const { numberOfChannels = 2, sampleRate = 48000, bitrate = 128e3, ...restOptions } = options;
    if (!AUDIO_CODECS.includes(codec)) {
        return false;
    }
    if (!Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
        throw new TypeError('numberOfChannels must be a positive integer.');
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
        throw new TypeError('sampleRate must be a positive integer.');
    }
    if (!(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
        throw new TypeError('bitrate must be a positive integer.');
    }
    validateAudioEncodingAdditionalOptions(codec, restOptions);
    let encoderConfig = null;
    if (customAudioEncoders.length > 0) {
        encoderConfig ??= buildAudioEncoderConfig({
            codec,
            numberOfChannels,
            sampleRate,
            bitrate,
            ...restOptions,
        });
        if (customAudioEncoders.some(x => x.supports(codec, encoderConfig))) {
            // There's a custom encoder
            return true;
        }
    }
    if (PCM_AUDIO_CODECS.includes(codec)) {
        return true; // Because we encode these ourselves
    }
    if (typeof AudioEncoder === 'undefined') {
        return false;
    }
    encoderConfig ??= buildAudioEncoderConfig({
        codec,
        numberOfChannels,
        sampleRate,
        bitrate,
        ...restOptions,
    });
    const support = await AudioEncoder.isConfigSupported(encoderConfig);
    return support.supported === true;
};
/**
 * Checks if the browser is able to encode the given subtitle codec.
 * @group Encoding
 * @public
 */
export const canEncodeSubtitles = async (codec) => {
    if (!SUBTITLE_CODECS.includes(codec)) {
        return false;
    }
    return true;
};
/**
 * Returns the list of all media codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableCodecs = async () => {
    const [videoCodecs, audioCodecs, subtitleCodecs] = await Promise.all([
        getEncodableVideoCodecs(),
        getEncodableAudioCodecs(),
        getEncodableSubtitleCodecs(),
    ]);
    return [...videoCodecs, ...audioCodecs, ...subtitleCodecs];
};
/**
 * Returns the list of all video codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableVideoCodecs = async (checkedCodecs = VIDEO_CODECS, options) => {
    const bools = await Promise.all(checkedCodecs.map(codec => canEncodeVideo(codec, options)));
    return checkedCodecs.filter((_, i) => bools[i]);
};
/**
 * Returns the list of all audio codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableAudioCodecs = async (checkedCodecs = AUDIO_CODECS, options) => {
    const bools = await Promise.all(checkedCodecs.map(codec => canEncodeAudio(codec, options)));
    return checkedCodecs.filter((_, i) => bools[i]);
};
/**
 * Returns the list of all subtitle codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableSubtitleCodecs = async (checkedCodecs = SUBTITLE_CODECS) => {
    const bools = await Promise.all(checkedCodecs.map(canEncodeSubtitles));
    return checkedCodecs.filter((_, i) => bools[i]);
};
/**
 * Returns the first video codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getFirstEncodableVideoCodec = async (checkedCodecs, options) => {
    for (const codec of checkedCodecs) {
        if (await canEncodeVideo(codec, options)) {
            return codec;
        }
    }
    return null;
};
/**
 * Returns the first audio codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getFirstEncodableAudioCodec = async (checkedCodecs, options) => {
    for (const codec of checkedCodecs) {
        if (await canEncodeAudio(codec, options)) {
            return codec;
        }
    }
    return null;
};
/**
 * Returns the first subtitle codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getFirstEncodableSubtitleCodec = async (checkedCodecs) => {
    for (const codec of checkedCodecs) {
        if (await canEncodeSubtitles(codec)) {
            return codec;
        }
    }
    return null;
};
