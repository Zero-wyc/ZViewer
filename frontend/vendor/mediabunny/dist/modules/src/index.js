/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/// <reference types="dom-mediacapture-transform" preserve="true" />
/// <reference types="dom-webcodecs" preserve="true" />
const MEDIABUNNY_LOADED_SYMBOL = Symbol.for('mediabunny loaded');
if (globalThis[MEDIABUNNY_LOADED_SYMBOL]) {
    console.error('[WARNING]\nMediabunny was loaded twice.'
        + ' This will likely cause Mediabunny not to work correctly.'
        + ' Check if multiple dependencies are importing different versions of Mediabunny,'
        + ' or if something is being bundled incorrectly.');
}
globalThis[MEDIABUNNY_LOADED_SYMBOL] = true;
export { Output, } from './output.js';
export { OutputFormat, AdtsOutputFormat, FlacOutputFormat, IsobmffOutputFormat, MkvOutputFormat, MovOutputFormat, Mp3OutputFormat, Mp4OutputFormat, MpegTsOutputFormat, OggOutputFormat, WavOutputFormat, WebMOutputFormat, } from './output-format.js';
export { MediaSource, VideoSource, AudioSource, SubtitleSource, AudioBufferSource, AudioSampleSource, CanvasSource, EncodedAudioPacketSource, EncodedVideoPacketSource, MediaStreamAudioTrackSource, MediaStreamVideoTrackSource, TextSubtitleSource, VideoSampleSource, } from './media-source.js';
export { VIDEO_CODECS, AUDIO_CODECS, PCM_AUDIO_CODECS, NON_PCM_AUDIO_CODECS, SUBTITLE_CODECS, } from './codec.js';
export { canEncode, canEncodeVideo, canEncodeAudio, canEncodeSubtitles, getEncodableCodecs, getEncodableVideoCodecs, getEncodableAudioCodecs, getEncodableSubtitleCodecs, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, getFirstEncodableSubtitleCodec, Quality, QUALITY_VERY_LOW, QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH, } from './encode.js';
export { Target, BufferTarget, FilePathTarget, NullTarget, StreamTarget, } from './target.js';
export { ALL_TRACK_TYPES, } from './output.js';
export { Source, BlobSource, BufferSource, FilePathSource, StreamSource, ReadableStreamSource, UrlSource, } from './source.js';
export { InputFormat, AdtsInputFormat, FlacInputFormat, IsobmffInputFormat, MatroskaInputFormat, Mp3InputFormat, Mp4InputFormat, MpegTsInputFormat, OggInputFormat, QuickTimeInputFormat, WaveInputFormat, WebMInputFormat, ALL_FORMATS, ADTS, FLAC, MATROSKA, MP3, MP4, MPEG_TS, OGG, QTFF, WAVE, WEBM, } from './input-format.js';
export { Input, InputDisposedError, } from './input.js';
export { InputTrack, InputVideoTrack, InputAudioTrack, InputSubtitleTrack, } from './input-track.js';
export { EncodedPacket, } from './packet.js';
export { AudioSample, VideoSample, VideoSampleColorSpace, VIDEO_SAMPLE_PIXEL_FORMATS, } from './sample.js';
export { AudioBufferSink, AudioSampleSink, BaseMediaSampleSink, CanvasSink, EncodedPacketSink, VideoSampleSink, } from './media-sink.js';
export { Conversion, ConversionCanceledError, } from './conversion.js';
export { CustomVideoDecoder, CustomVideoEncoder, CustomAudioDecoder, CustomAudioEncoder, registerDecoder, registerEncoder, } from './custom-coder.js';
export { RichImageData, AttachedFile, } from './metadata.js';
export { parseSrtTimestamp, formatSrtTimestamp, splitSrtIntoCues, formatCuesToSrt, formatCuesToWebVTT, parseAssTimestamp, formatAssTimestamp, splitAssIntoCues, formatCuesToAss, } from './subtitles.js';
// 🐡🦔
