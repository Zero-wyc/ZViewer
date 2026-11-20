/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AUDIO_CODECS, inferCodecFromCodecString, VIDEO_CODECS } from '../codec.js';
import { Demuxer } from '../demuxer.js';
import { DEFAULT_TRACK_DISPOSITION } from '../metadata.js';
import { arrayArgmin, assert, joinPaths, UNDETERMINED_LANGUAGE } from '../misc.js';
import { readAllLines } from '../reader.js';
import { AttributeList, canIgnoreLine, HlsPlaylistVariables, HLS_MIME_TYPE, TAG_DEFINE, TAG_EXTINF, TAG_I_FRAME_STREAM_INF, TAG_MEDIA, TAG_STREAM_INF, } from './hls-misc.js';
import { HlsSegmentedInput } from './hls-segmented-input.js';
import { getReferenceFirstTimestamp } from '../segmented-input.js';
import { PathedSource } from '../source.js';
const MAX_VARIANT_STREAMS = 256;
const MAX_MEDIA_TAGS = 256;
export class HlsDemuxer extends Demuxer {
    constructor(input) {
        super(input);
        this.metadataPromise = null;
        this.trackBackings = null;
        this.internalTracks = null;
        this.segmentedInputs = [];
        this.hasMasterPlaylist = true;
        this.masterPlaylistVariables = null;
        this.mediaOffsets = new Map();
    }
    readMetadata() {
        return this.metadataPromise ??= (async () => {
            assert(this.input._rootSource instanceof PathedSource);
            const slice = await this.input._reader.requestEntireFile();
            assert(slice);
            const lines = readAllLines(slice, slice.length, { ignore: canIgnoreLine });
            // Important: get the root path AFTER reading data to get the final root path, possibly affected by
            // redirects. Any follow requests should be related to the redirected path, not the original one.
            const { rootPath } = this.input._rootSource;
            const variables = new HlsPlaylistVariables(rootPath, null);
            const variantStreams = [];
            const mediaTags = [];
            // Let's first iterate through the entire file, collecting all variant streams and media tags
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith(TAG_DEFINE)) {
                    variables.define(line.slice(TAG_DEFINE.length));
                }
                else if (line.startsWith(TAG_STREAM_INF)) {
                    const streamInfLineNumber = i;
                    let playlistPath = lines[++i];
                    if (playlistPath === undefined) {
                        throw new Error('Incorrect M3U8 file; a line must follow the #EXT-X-STREAM-INF tag.');
                    }
                    playlistPath = variables.substitute(playlistPath);
                    const fullPath = joinPaths(rootPath, playlistPath);
                    const attributes = new AttributeList(line.slice(TAG_STREAM_INF.length), variables);
                    const bandwidth = attributes.getAsNumber('bandwidth');
                    if (bandwidth === null) {
                        throw new Error('Invalid M3U8 file; #EXT-X-STREAM-INF tag requires a BANDWIDTH attribute with a valid'
                            + ' numerical value.');
                    }
                    variantStreams.push({
                        fullPath,
                        attributes,
                        lineNumber: streamInfLineNumber,
                        hasOnlyKeyPackets: false,
                    });
                }
                else if (line.startsWith(TAG_I_FRAME_STREAM_INF)) {
                    const attributes = new AttributeList(line.slice(TAG_I_FRAME_STREAM_INF.length), variables);
                    const playlistPath = attributes.get('uri');
                    if (playlistPath === null) {
                        throw new Error('Invalid M3U8 file; #EXT-X-I-FRAME-STREAM-INF tag requires a URI attribute.');
                    }
                    const bandwidth = attributes.getAsNumber('bandwidth');
                    if (bandwidth === null) {
                        throw new Error('Invalid M3U8 file; #EXT-X-I-FRAME-STREAM-INF tag requires a BANDWIDTH attribute with a'
                            + ' valid numerical value.');
                    }
                    const fullPath = joinPaths(rootPath, playlistPath);
                    variantStreams.push({
                        fullPath,
                        attributes,
                        lineNumber: i,
                        hasOnlyKeyPackets: true,
                    });
                }
                else if (line.startsWith(TAG_MEDIA)) {
                    const attributes = new AttributeList(line.slice(TAG_MEDIA.length), variables);
                    const type = attributes.get('type');
                    if (type === null) {
                        throw new Error('Invalid M3U8 file; #EXT-X-MEDIA tag requires a TYPE attribute.');
                    }
                    const groupId = attributes.get('group-id');
                    if (groupId === null) {
                        throw new Error('Invalid M3U8 file; #EXT-X-MEDIA tag requires a GROUP-ID attribute.');
                    }
                    let fullPath = null;
                    const uri = attributes.get('uri');
                    if (uri !== null) {
                        fullPath = joinPaths(rootPath, uri);
                    }
                    mediaTags.push({ fullPath, attributes, lineNumber: i });
                }
                else if (line.startsWith(TAG_EXTINF)) {
                    // This is a media playlist, not a master playlist
                    const segmentedInput = new HlsSegmentedInput(this, rootPath, null, lines);
                    this.segmentedInputs = [segmentedInput];
                    this.hasMasterPlaylist = false;
                    this.trackBackings = await segmentedInput.getTrackBackings();
                    return;
                }
            }
            if (variantStreams.length > MAX_VARIANT_STREAMS || mediaTags.length > MAX_MEDIA_TAGS) {
                throw new Error('Unsupported M3U8 file; too many variant streams or media tags.');
            }
            this.masterPlaylistVariables = variables;
            // Now, let's process & resolve all variant streams in parallel, mapping each of them to tracks.
            const internalTracksByVariant = await Promise.all(variantStreams.map(async (variantStream, i) => {
                const result = [];
                const codecsList = variantStream.attributes.get('codecs');
                let codecStrings;
                if (codecsList) {
                    codecStrings = codecsList.split(',').map(x => x.trim());
                }
                else {
                    // No codecs were specified, we need to read the underlying media data
                    const segmentedInput = this.getSegmentedInputForPath(variantStream.fullPath);
                    const trackBackings = await segmentedInput.getTrackBackings();
                    const tracksWithCodec = await Promise.all(trackBackings.map(async (t) => ({ track: t, codec: await t.getCodec() })));
                    codecStrings = await Promise.all(tracksWithCodec
                        .filter(x => x.codec !== null)
                        .map(x => x.track.getDecoderConfig().then(x => x.codec)));
                }
                const videoGroupId = variantStream.attributes.get('video');
                const audioGroupId = variantStream.attributes.get('audio');
                const containsVideoCodecs = codecStrings.some(x => VIDEO_CODECS.includes(inferCodecFromCodecString(x)));
                const containsAudioCodecs = codecStrings.some(x => AUDIO_CODECS.includes(inferCodecFromCodecString(x)));
                if (videoGroupId !== null && !containsVideoCodecs) {
                    // A video group is linked but no video codec is listed, sigh. Let's resolve the video codec.
                    // We only need to look at the first matching tag, since all tags are required to have the same
                    // codec anyway
                    const matchingVideoMediaTag = mediaTags.find((mediaTag) => {
                        const groupId = mediaTag.attributes.get('group-id');
                        const type = mediaTag.attributes.get('type');
                        return groupId === videoGroupId && type.toLowerCase() === 'video';
                    });
                    outer: if (matchingVideoMediaTag) {
                        const uri = matchingVideoMediaTag.attributes.get('uri');
                        if (uri === null) {
                            break outer;
                        }
                        const fullPath = joinPaths(rootPath, uri);
                        const segmentedInput = this.getSegmentedInputForPath(fullPath);
                        const trackBackings = await segmentedInput.getTrackBackings();
                        const videoTrack = trackBackings.find(x => x.getType() === 'video');
                        if (!videoTrack || (await videoTrack.getCodec()) === null) {
                            break outer;
                        }
                        const additionalCodecString = await videoTrack.getDecoderConfig().then(x => x?.codec ?? null);
                        assert(additionalCodecString !== null);
                        codecStrings.push(additionalCodecString);
                    }
                }
                if (audioGroupId !== null && !containsAudioCodecs) {
                    // An audio group is linked but no audio codec is listed, sigh. Let's resolve the audio codec.
                    // We only need to look at the first matching tag, since all tags are required to have the same
                    // codec anyway
                    const matchingAudioMediaTag = mediaTags.find((tag) => {
                        const groupId = tag.attributes.get('group-id');
                        const type = tag.attributes.get('type');
                        return groupId === audioGroupId && type.toLowerCase() === 'audio';
                    });
                    outer: if (matchingAudioMediaTag) {
                        const uri = matchingAudioMediaTag.attributes.get('uri');
                        if (uri === null) {
                            break outer;
                        }
                        const fullPath = joinPaths(rootPath, uri);
                        const segmentedInput = this.getSegmentedInputForPath(fullPath);
                        const trackBackings = await segmentedInput.getTrackBackings();
                        const audioTrack = trackBackings.find(x => x.getType() === 'audio');
                        if (!audioTrack || (await audioTrack.getCodec()) === null) {
                            break outer;
                        }
                        const additionalCodecString = await audioTrack.getDecoderConfig().then(x => x?.codec ?? null);
                        assert(additionalCodecString !== null);
                        codecStrings.push(additionalCodecString);
                    }
                }
                // Unique that shit
                codecStrings = [...new Set(codecStrings)];
                const bandwidth = variantStream.attributes.getAsNumber('bandwidth');
                assert(bandwidth !== null);
                const averageBandwidth = variantStream.attributes.getAsNumber('average-bandwidth');
                const name = variantStream.attributes.get('name');
                // CODECS lists every codec of any rendition in a group, so it says which codecs there are, but not
                // which rendition has which. As long as they're all the same codec, that's fine; otherwise, we need to
                // look at each rendition's media.
                const resolveCodec = async (typeCodecStrings, fullPath, type) => {
                    const codecs = new Set(typeCodecStrings.map(x => inferCodecFromCodecString(x)));
                    if (codecs.size === 1) {
                        const [codec] = codecs;
                        assert(codec);
                        return {
                            codec,
                            // With several strings for the same codec, we can't tell which one belongs to this track
                            fullCodecString: typeCodecStrings.length === 1 ? typeCodecStrings[0] : null,
                        };
                    }
                    const segmentedInput = this.getSegmentedInputForPath(fullPath);
                    const trackBackings = (await segmentedInput.getTrackBackings()).filter(x => x.getType() === type);
                    if (trackBackings.length !== 1) {
                        throw new Error(`Unsupported M3U8 file; a variant stream lists several ${type} codecs, but its media`
                            + ` doesn't contain exactly one ${type} track.`);
                    }
                    const codec = await trackBackings[0].getCodec();
                    if (codec === null) {
                        return null;
                    }
                    const decoderConfig = await trackBackings[0].getDecoderConfig();
                    assert(decoderConfig);
                    return {
                        codec,
                        fullCodecString: decoderConfig.codec,
                    };
                };
                const videoCodecStrings = codecStrings.filter(x => VIDEO_CODECS.includes(inferCodecFromCodecString(x)));
                const audioCodecStrings = codecStrings.filter(x => AUDIO_CODECS.includes(inferCodecFromCodecString(x)));
                // Each type's tracks get resolved at its first codec string, keeping the order of CODECS
                for (const codecString of codecStrings) {
                    if (codecString === videoCodecStrings[0]) {
                        const referencedVideoMediaTags = mediaTags.filter(mediaTag => (mediaTag.attributes.get('group-id') === videoGroupId
                            && mediaTag.attributes.get('type').toLowerCase() === 'video'));
                        if (referencedVideoMediaTags.length === 0) {
                            const resolution = variantStream.attributes.get('resolution');
                            let width = null;
                            let height = null;
                            if (resolution) {
                                const match = resolution.match(/^(\d+)x(\d+)$/);
                                if (match) {
                                    width = Number(match[1]);
                                    height = Number(match[2]);
                                }
                            }
                            const resolvedCodec = await resolveCodec(videoCodecStrings, variantStream.fullPath, 'video');
                            if (resolvedCodec) {
                                result.push({
                                    demuxer: this,
                                    backingTrack: null,
                                    default: true,
                                    autoselect: true,
                                    languageCode: UNDETERMINED_LANGUAGE,
                                    lineNumber: variantStream.lineNumber,
                                    fullPath: variantStream.fullPath,
                                    codec: resolvedCodec.codec,
                                    fullCodecString: resolvedCodec.fullCodecString,
                                    pairingMask: 1n << BigInt(i),
                                    peakBitrate: bandwidth,
                                    averageBitrate: averageBandwidth,
                                    name,
                                    hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
                                    info: {
                                        type: 'video',
                                        width,
                                        height,
                                    },
                                });
                            }
                        }
                        else {
                            const resolvedCodecs = await Promise.all(referencedVideoMediaTags.map(mediaTag => resolveCodec(videoCodecStrings, mediaTag.fullPath ?? variantStream.fullPath, 'video')));
                            for (let j = 0; j < referencedVideoMediaTags.length; j++) {
                                const mediaTag = referencedVideoMediaTags[j];
                                const resolvedCodec = resolvedCodecs[j];
                                if (!resolvedCodec) {
                                    continue;
                                }
                                const resolution = mediaTag.attributes.get('resolution')
                                    ?? variantStream.attributes.get('resolution');
                                let width = null;
                                let height = null;
                                if (resolution) {
                                    const match = resolution.match(/^(\d+)x(\d+)$/);
                                    if (match) {
                                        width = Number(match[1]);
                                        height = Number(match[2]);
                                    }
                                }
                                result.push({
                                    demuxer: this,
                                    backingTrack: null,
                                    default: getMediaTagDefault(mediaTag.attributes),
                                    // Autoselect is inferred to be true if the default is true
                                    autoselect: getMediaTagDefault(mediaTag.attributes)
                                        || getMediaTagAutoselect(mediaTag.attributes),
                                    languageCode: preprocessLanguageCode(mediaTag.attributes.get('language')),
                                    lineNumber: mediaTag.lineNumber,
                                    fullPath: mediaTag.fullPath ?? variantStream.fullPath,
                                    codec: resolvedCodec.codec,
                                    fullCodecString: resolvedCodec.fullCodecString,
                                    pairingMask: 1n << BigInt(i),
                                    peakBitrate: mediaTag.fullPath === null ? bandwidth : null,
                                    averageBitrate: mediaTag.fullPath === null ? averageBandwidth : null,
                                    name: mediaTag.attributes.get('name'),
                                    hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
                                    info: {
                                        type: 'video',
                                        width,
                                        height,
                                    },
                                });
                            }
                        }
                    }
                    else if (codecString === audioCodecStrings[0]) {
                        const referencedAudioMediaTags = mediaTags.filter(mediaTag => (mediaTag.attributes.get('group-id') === audioGroupId
                            && mediaTag.attributes.get('type').toLowerCase() === 'audio'));
                        if (referencedAudioMediaTags.length === 0) {
                            const resolvedCodec = await resolveCodec(audioCodecStrings, variantStream.fullPath, 'audio');
                            if (resolvedCodec) {
                                const channels = variantStream.attributes.get('channels');
                                result.push({
                                    demuxer: this,
                                    backingTrack: null,
                                    default: true,
                                    autoselect: true,
                                    languageCode: UNDETERMINED_LANGUAGE,
                                    lineNumber: variantStream.lineNumber,
                                    fullPath: variantStream.fullPath,
                                    codec: resolvedCodec.codec,
                                    fullCodecString: resolvedCodec.fullCodecString,
                                    pairingMask: 1n << BigInt(i),
                                    peakBitrate: bandwidth,
                                    averageBitrate: averageBandwidth,
                                    name,
                                    hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
                                    info: {
                                        type: 'audio',
                                        numberOfChannels: parseChannelCount(channels),
                                    },
                                });
                            }
                        }
                        else {
                            const resolvedCodecs = await Promise.all(referencedAudioMediaTags.map(mediaTag => resolveCodec(audioCodecStrings, mediaTag.fullPath ?? variantStream.fullPath, 'audio')));
                            for (let j = 0; j < referencedAudioMediaTags.length; j++) {
                                const mediaTag = referencedAudioMediaTags[j];
                                const resolvedCodec = resolvedCodecs[j];
                                if (!resolvedCodec) {
                                    continue;
                                }
                                const channels = mediaTag.attributes.get('channels')
                                    ?? variantStream.attributes.get('channels');
                                result.push({
                                    demuxer: this,
                                    backingTrack: null,
                                    default: getMediaTagDefault(mediaTag.attributes),
                                    // Autoselect is inferred to be true if the default is true
                                    autoselect: getMediaTagDefault(mediaTag.attributes)
                                        || getMediaTagAutoselect(mediaTag.attributes),
                                    languageCode: preprocessLanguageCode(mediaTag.attributes.get('language')),
                                    lineNumber: mediaTag.lineNumber,
                                    fullPath: mediaTag.fullPath ?? variantStream.fullPath,
                                    codec: resolvedCodec.codec,
                                    fullCodecString: resolvedCodec.fullCodecString,
                                    pairingMask: 1n << BigInt(i),
                                    peakBitrate: mediaTag.fullPath === null ? bandwidth : null,
                                    averageBitrate: mediaTag.fullPath === null ? averageBandwidth : null,
                                    name: mediaTag.attributes.get('name'),
                                    hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
                                    info: {
                                        type: 'audio',
                                        numberOfChannels: parseChannelCount(channels),
                                    },
                                });
                            }
                        }
                    }
                }
                return result;
            }));
            const internalTracks = [];
            const addInternalTrack = (track) => {
                const existingTrack = internalTracks.find(x => x.fullPath === track.fullPath && x.info.type === track.info.type);
                if (existingTrack) {
                    existingTrack.pairingMask |= track.pairingMask;
                    existingTrack.default ||= track.default;
                    existingTrack.autoselect ||= track.autoselect;
                    existingTrack.lineNumber = Math.min(existingTrack.lineNumber, track.lineNumber);
                    if (track.peakBitrate !== null) {
                        existingTrack.peakBitrate = Math.max(existingTrack.peakBitrate ?? -Infinity, track.peakBitrate);
                    }
                    if (track.averageBitrate !== null) {
                        existingTrack.averageBitrate = Math.max(existingTrack.averageBitrate ?? -Infinity, track.averageBitrate);
                    }
                    if (existingTrack.languageCode === UNDETERMINED_LANGUAGE) {
                        existingTrack.languageCode = track.languageCode;
                    }
                }
                else {
                    internalTracks.push(track);
                }
            };
            for (const variantInternalTracks of internalTracksByVariant) {
                for (const trackEntry of variantInternalTracks) {
                    addInternalTrack(trackEntry);
                }
            }
            // Order tracks by how they appear in the file
            internalTracks.sort((a, b) => a.lineNumber - b.lineNumber);
            this.trackBackings = [];
            for (const internalTrack of internalTracks) {
                if (internalTrack.info.type === 'video') {
                    this.trackBackings.push(new HlsInputVideoTrackBacking(internalTrack));
                }
                else {
                    this.trackBackings.push(new HlsInputAudioTrackBacking(internalTrack));
                }
            }
            this.internalTracks = internalTracks;
        })();
    }
    async getTrackBackings() {
        await this.readMetadata();
        assert(this.trackBackings);
        return this.trackBackings;
    }
    getMediaOffsetForDiscontinuity(discontinuityNumber) {
        let promise = this.mediaOffsets.get(discontinuityNumber);
        if (promise) {
            return promise;
        }
        promise = (async () => {
            // All playlists share their media's timestamps within a discontinuity, so the reference playlist alone
            // defines global timestamps. For the reference track, the first packet of any discontinuity lands exactly
            // on the timestamp of the discontinuity's first segment. This ensures that time starts at 0 (unless
            // PDT is used) and that discontinuities don't mess with overall timestamp continuity.
            const referenceSegmentedInput = this.getReferenceSegmentedInput();
            let segment = await referenceSegmentedInput.getFirstSegment();
            while (segment && segment.discontinuityNumber < discontinuityNumber) {
                segment = await referenceSegmentedInput.getNextSegment(segment, {});
            }
            if (!segment || segment.discontinuityNumber !== discontinuityNumber) {
                throw new Error(`The reference playlist contains no segment in discontinuity ${discontinuityNumber}, so the`
                    + ' discontinuity can\'t be synchronized across tracks. If you think this is a bug, please raise an'
                    + ' issue and include the playlist.');
            }
            const input = referenceSegmentedInput.getInputForSegment(segment);
            const rawTimestampOffset = await referenceSegmentedInput.getRawTimestampOffset(input) ?? 0;
            const firstTimestamp = await getReferenceFirstTimestamp(input);
            if (firstTimestamp === null) {
                throw new Error('The reference playlist\'s segment contains no media.');
            }
            return segment.timestamp - (rawTimestampOffset + firstTimestamp);
        })();
        this.mediaOffsets.set(discontinuityNumber, promise);
        return promise;
    }
    getReferenceSegmentedInput() {
        if (!this.hasMasterPlaylist) {
            return this.segmentedInputs[0];
        }
        assert(this.internalTracks);
        // Prefer the cheapest video track, since video timestamps are straightforward and its segments are
        // cheap to load. I-frame variants are a last resort.
        const regularTracks = this.internalTracks.filter(x => !x.hasOnlyKeyPackets);
        const candidates = regularTracks.length > 0 ? regularTracks : this.internalTracks;
        const videoCandidates = candidates.filter(x => x.info.type === 'video');
        const pool = videoCandidates.length > 0 ? videoCandidates : candidates;
        const index = arrayArgmin(pool, x => x.peakBitrate ?? Infinity);
        assert(index !== -1);
        return this.getSegmentedInputForPath(pool[index].fullPath);
    }
    getSegmentedInputForPath(path) {
        let segmentedInput = this.segmentedInputs.find(x => x.path === path);
        if (segmentedInput) {
            return segmentedInput;
        }
        let decls = null;
        if (this.internalTracks) {
            const tracks = this.internalTracks.filter(x => x.fullPath === path);
            decls = tracks.map(x => ({ type: x.info.type }));
        }
        segmentedInput = new HlsSegmentedInput(this, path, decls, null);
        this.segmentedInputs.push(segmentedInput);
        return segmentedInput;
    }
    async getMetadataTags() {
        return {};
    }
    async getMimeType() {
        return HLS_MIME_TYPE;
    }
    dispose() {
        if (this.segmentedInputs) {
            for (const segInput of this.segmentedInputs) {
                segInput.dispose();
            }
            this.segmentedInputs.length = 0;
        }
    }
}
class HlsInputTrackBacking {
    constructor(internalTrack) {
        this.internalTrack = internalTrack;
        this.hydrationPromise = null;
    }
    hydrate() {
        return this.hydrationPromise ??= (async () => {
            const segmentedInput = this.internalTrack.demuxer.getSegmentedInputForPath(this.internalTrack.fullPath);
            let trackBacking = null;
            const trackBackings = await segmentedInput.getTrackBackings();
            const matchingType = trackBackings.filter(x => x.getType() === this.getType());
            if (matchingType.length === 1) {
                // Avoids reading fields on the track
                trackBacking = matchingType[0];
            }
            else {
                if (this instanceof HlsInputVideoTrackBacking) {
                    for (const backing of matchingType) {
                        if ((await backing.getCodec()) === this.getCodec()) {
                            trackBacking = backing;
                            break;
                        }
                    }
                }
                else {
                    assert(this instanceof HlsInputAudioTrackBacking);
                    for (const backing of matchingType) {
                        if ((await backing.getCodec()) === this.getCodec()) {
                            trackBacking = backing;
                            break;
                        }
                    }
                }
            }
            if (!trackBacking) {
                throw new Error('Could not find matching track in underlying media data.');
            }
            this.internalTrack.backingTrack = trackBacking;
        })();
    }
    /** If the backing track is already present, delegate synchronously; otherwise, hydrate first. */
    delegate(fn) {
        if (this.internalTrack.backingTrack) {
            return fn();
        }
        return this.hydrate().then(fn);
    }
    getCodec() {
        throw new Error('Not implemented on base class.');
    }
    getDisposition() {
        return {
            ...DEFAULT_TRACK_DISPOSITION,
            // Meanings are swapped in HLS: "Default" means that a track is the primary track.
            default: this.internalTrack.autoselect,
            primary: this.internalTrack.default,
        };
    }
    getPairingMask() {
        return this.internalTrack.pairingMask;
    }
    getInternalCodecId() {
        return null;
    }
    getLanguageCode() {
        return this.internalTrack.languageCode;
    }
    getName() {
        return this.internalTrack.name;
    }
    getNumber() {
        assert(this.internalTrack.demuxer.internalTracks);
        const trackType = this.internalTrack.info.type;
        let number = 0;
        for (const track of this.internalTrack.demuxer.internalTracks) {
            if (track.info.type === trackType) {
                number++;
            }
            if (track === this.internalTrack) {
                break;
            }
        }
        return number;
    }
    getTimeResolution() {
        return this.delegate(() => this.internalTrack.backingTrack.getTimeResolution());
    }
    isRelativeToUnixEpoch() {
        return this.delegate(() => this.internalTrack.backingTrack.isRelativeToUnixEpoch());
    }
    getUnixTimeForTimestamp(timestamp) {
        return this.delegate(() => this.internalTrack.backingTrack.getUnixTimeForTimestamp(timestamp));
    }
    getBitrate() {
        return this.internalTrack.peakBitrate;
    }
    getAverageBitrate() {
        return this.internalTrack.averageBitrate;
    }
    async getDurationFromMetadata(options) {
        await this.hydrate();
        return this.internalTrack.backingTrack.getDurationFromMetadata(options);
    }
    async getLiveRefreshInterval() {
        await this.hydrate();
        return this.internalTrack.backingTrack.getLiveRefreshInterval();
    }
    getHasOnlyKeyPackets() {
        return this.internalTrack.hasOnlyKeyPackets || null;
    }
    async getFirstPacket(options) {
        await this.hydrate();
        return this.internalTrack.backingTrack.getFirstPacket(options);
    }
    async getPacket(timestamp, options) {
        await this.hydrate();
        return this.internalTrack.backingTrack.getPacket(timestamp, options);
    }
    async getKeyPacket(timestamp, options) {
        await this.hydrate();
        return this.internalTrack.backingTrack.getKeyPacket(timestamp, options);
    }
    async getNextPacket(packet, options) {
        await this.hydrate();
        return this.internalTrack.backingTrack.getNextPacket(packet, options);
    }
    async getNextKeyPacket(packet, options) {
        await this.hydrate();
        return this.internalTrack.backingTrack.getNextKeyPacket(packet, options);
    }
}
class HlsInputVideoTrackBacking extends HlsInputTrackBacking {
    constructor(internalTrack) {
        super(internalTrack);
    }
    get backingVideoTrack() {
        return this.internalTrack.backingTrack;
    }
    getType() {
        return 'video';
    }
    getCodec() {
        return this.internalTrack.codec;
    }
    getCodedWidth() {
        return this.delegate(() => this.backingVideoTrack.getCodedWidth());
    }
    getCodedHeight() {
        return this.delegate(() => this.backingVideoTrack.getCodedHeight());
    }
    getSquarePixelWidth() {
        return this.delegate(() => this.backingVideoTrack.getSquarePixelWidth());
    }
    getSquarePixelHeight() {
        return this.delegate(() => this.backingVideoTrack.getSquarePixelHeight());
    }
    getMetadataDisplayWidth() {
        if (this.backingVideoTrack) {
            return null;
        }
        return this.internalTrack.info.width;
    }
    getMetadataDisplayHeight() {
        if (this.backingVideoTrack) {
            return null;
        }
        return this.internalTrack.info.height;
    }
    getTransformationMatrix() {
        return this.delegate(() => this.backingVideoTrack.getTransformationMatrix());
    }
    async getColorSpace() {
        await this.hydrate();
        return this.backingVideoTrack.getColorSpace();
    }
    async canBeTransparent() {
        await this.hydrate();
        return this.backingVideoTrack.canBeTransparent();
    }
    getMetadataCodecParameterString() {
        if (this.backingVideoTrack) {
            return null;
        }
        return this.internalTrack.fullCodecString;
    }
    async getDecoderConfig() {
        await this.hydrate();
        if ((await this.backingVideoTrack.getCodec()) !== this.getCodec()) {
            // We check as late as possible, and we gotta check here
            throw new Error('The codec in the playlist doesn\'t match the codec of the media data.');
        }
        return this.backingVideoTrack.getDecoderConfig();
    }
}
class HlsInputAudioTrackBacking extends HlsInputTrackBacking {
    constructor(internalTrack) {
        super(internalTrack);
    }
    get backingAudioTrack() {
        return this.internalTrack.backingTrack;
    }
    getType() {
        return 'audio';
    }
    getCodec() {
        return this.internalTrack.codec;
    }
    getNumberOfChannels() {
        if (this.internalTrack.info.numberOfChannels !== null) {
            return this.internalTrack.info.numberOfChannels;
        }
        return this.delegate(() => this.backingAudioTrack.getNumberOfChannels());
    }
    getSampleRate() {
        return this.delegate(() => this.backingAudioTrack.getSampleRate());
    }
    getMetadataCodecParameterString() {
        if (this.backingAudioTrack) {
            return null;
        }
        return this.internalTrack.fullCodecString;
    }
    async getDecoderConfig() {
        await this.hydrate();
        if ((await this.backingAudioTrack.getCodec()) !== this.getCodec()) {
            // We check as late as possible, and we gotta check here
            throw new Error('The codec in the playlist doesn\'t match the codec of the media data.');
        }
        return this.backingAudioTrack.getDecoderConfig();
    }
}
const getMediaTagDefault = (attributes) => {
    const value = attributes.get('default');
    if (value === null) {
        return false;
    }
    const normalized = value.toUpperCase();
    if (normalized === 'YES') {
        return true;
    }
    if (normalized === 'NO') {
        return false;
    }
    throw new Error(`Invalid M3U8 file; #EXT-X-MEDIA DEFAULT attribute must be YES or NO, got "${value}".`);
};
const getMediaTagAutoselect = (attributes) => {
    const value = attributes.get('autoselect');
    if (value === null) {
        return false;
    }
    const normalized = value.toUpperCase();
    if (normalized === 'YES') {
        return true;
    }
    if (normalized === 'NO') {
        return false;
    }
    throw new Error(`Invalid M3U8 file; #EXT-X-MEDIA AUTOSELECT attribute must be YES or NO, got "${value}".`);
};
const preprocessLanguageCode = (code) => {
    if (code === null) {
        return UNDETERMINED_LANGUAGE;
    }
    const languageSubtag = code.split('-')[0];
    if (!languageSubtag) {
        return UNDETERMINED_LANGUAGE;
    }
    // Technically invalid, for now: The language subtag might be a language code from ISO 639-1,
    // ISO 639-2, ISO 639-3, ISO 639-5 or some other thing (source: Wikipedia). But, `languageCode` is
    // documented as ISO 639-2. Changing the definition would be a breaking change. This will get
    // cleaned up in the future by defining languageCode to be BCP 47 instead.
    return languageSubtag;
};
const parseChannelCount = (channels) => {
    if (channels === null) {
        return null;
    }
    const [count, objectCodingIdentifiers] = channels.split('/');
    if (objectCodingIdentifiers !== undefined && objectCodingIdentifiers !== '-') {
        // For object-based audio (like Dolby Atmos' "16/JOC"), the count isn't the output number of channels
        return null;
    }
    const number = Number(count);
    return Number.isInteger(number) && number > 0 ? number : null;
};
