/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/// <reference types="dom-mediacapture-transform" preserve="true" />
/// <reference types="dom-webcodecs" preserve="true" />
export { Output, OutputOptions, BaseTrackMetadata, VideoTrackMetadata, AudioTrackMetadata, SubtitleTrackMetadata, } from './output.js';
export { OutputFormat, AdtsOutputFormat, AdtsOutputFormatOptions, FlacOutputFormat, FlacOutputFormatOptions, IsobmffOutputFormat, IsobmffOutputFormatOptions, MkvOutputFormat, MkvOutputFormatOptions, MovOutputFormat, Mp3OutputFormat, Mp3OutputFormatOptions, Mp4OutputFormat, MpegTsOutputFormat, MpegTsOutputFormatOptions, OggOutputFormat, OggOutputFormatOptions, WavOutputFormat, WavOutputFormatOptions, WebMOutputFormat, WebMOutputFormatOptions, InclusiveIntegerRange, TrackCountLimits, } from './output-format.js';
export { MediaSource, VideoSource, AudioSource, SubtitleSource, AudioBufferSource, AudioSampleSource, CanvasSource, EncodedAudioPacketSource, EncodedVideoPacketSource, MediaStreamAudioTrackSource, MediaStreamVideoTrackSourceOptions, MediaStreamVideoTrackSource, TextSubtitleSource, VideoSampleSource, } from './media-source.js';
export { MediaCodec, VideoCodec, AudioCodec, SubtitleCodec, VIDEO_CODECS, AUDIO_CODECS, PCM_AUDIO_CODECS, NON_PCM_AUDIO_CODECS, SUBTITLE_CODECS, } from './codec.js';
export { VideoEncodingConfig, VideoEncodingAdditionalOptions, AudioEncodingConfig, AudioEncodingAdditionalOptions, canEncode, canEncodeVideo, canEncodeAudio, canEncodeSubtitles, getEncodableCodecs, getEncodableVideoCodecs, getEncodableAudioCodecs, getEncodableSubtitleCodecs, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, getFirstEncodableSubtitleCodec, Quality, QUALITY_VERY_LOW, QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH, } from './encode.js';
export { Target, BufferTarget, FilePathTarget, FilePathTargetOptions, NullTarget, StreamTarget, StreamTargetOptions, StreamTargetChunk, } from './target.js';
export { AnyIterable, MaybePromise, Rational, Rectangle, Rotation, SetRequired, } from './misc.js';
export { TrackType, ALL_TRACK_TYPES, } from './output.js';
export { Source, BlobSource, BlobSourceOptions, BufferSource, FilePathSource, FilePathSourceOptions, StreamSource, StreamSourceOptions, ReadableStreamSource, ReadableStreamSourceOptions, UrlSource, UrlSourceOptions, } from './source.js';
export { InputFormat, AdtsInputFormat, FlacInputFormat, IsobmffInputFormat, MatroskaInputFormat, Mp3InputFormat, Mp4InputFormat, MpegTsInputFormat, OggInputFormat, QuickTimeInputFormat, WaveInputFormat, WebMInputFormat, ALL_FORMATS, ADTS, FLAC, MATROSKA, MP3, MP4, MPEG_TS, OGG, QTFF, WAVE, WEBM, } from './input-format.js';
export { Input, InputOptions, InputDisposedError, } from './input.js';
export { InputTrack, InputVideoTrack, InputAudioTrack, InputSubtitleTrack, PacketStats, } from './input-track.js';
export { EncodedPacket, EncodedPacketSideData, PacketType, } from './packet.js';
export { AudioSample, AudioSampleInit, AudioSampleCopyToOptions, VideoSample, VideoSampleInit, VideoSamplePixelFormat, VideoSampleColorSpace, CropRectangle, VIDEO_SAMPLE_PIXEL_FORMATS, } from './sample.js';
export { AudioBufferSink, AudioSampleSink, BaseMediaSampleSink, CanvasSink, CanvasSinkOptions, EncodedPacketSink, PacketRetrievalOptions, VideoSampleSink, WrappedAudioBuffer, WrappedCanvas, } from './media-sink.js';
export { Conversion, ConversionOptions, ConversionVideoOptions, ConversionAudioOptions, ConversionCanceledError, ConversionSubtitleOptions, DiscardedTrack, } from './conversion.js';
export { CustomVideoDecoder, CustomVideoEncoder, CustomAudioDecoder, CustomAudioEncoder, registerDecoder, registerEncoder, } from './custom-coder.js';
export { MetadataTags, AttachedImage, RichImageData, AttachedFile, TrackDisposition, } from './metadata.js';
export type { SubtitleMetadata, SubtitleCue, SubtitleConfig } from './subtitles.js';
export { parseSrtTimestamp, formatSrtTimestamp, splitSrtIntoCues, formatCuesToSrt, formatCuesToWebVTT, parseAssTimestamp, formatAssTimestamp, splitAssIntoCues, formatCuesToAss, } from './subtitles.js';
//# sourceMappingURL=index.d.ts.map