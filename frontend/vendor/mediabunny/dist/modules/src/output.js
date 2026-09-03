/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AsyncMutex, isIso639Dash2LanguageCode } from './misc.js';
import { validateMetadataTags, validateTrackDisposition } from './metadata.js';
import { OutputFormat } from './output-format.js';
import { AudioSource, SubtitleSource, VideoSource } from './media-source.js';
import { Target } from './target.js';
/**
 * List of all track types.
 * @group Miscellaneous
 * @public
 */
export const ALL_TRACK_TYPES = ['video', 'audio', 'subtitle'];
const validateBaseTrackMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') {
        throw new TypeError('metadata must be an object.');
    }
    if (metadata.languageCode !== undefined && !isIso639Dash2LanguageCode(metadata.languageCode)) {
        throw new TypeError('metadata.languageCode, when provided, must be a three-letter, ISO 639-2/T language code.');
    }
    if (metadata.name !== undefined && typeof metadata.name !== 'string') {
        throw new TypeError('metadata.name, when provided, must be a string.');
    }
    if (metadata.disposition !== undefined) {
        validateTrackDisposition(metadata.disposition);
    }
    if (metadata.maximumPacketCount !== undefined
        && (!Number.isInteger(metadata.maximumPacketCount) || metadata.maximumPacketCount < 0)) {
        throw new TypeError('metadata.maximumPacketCount, when provided, must be a non-negative integer.');
    }
};
/**
 * Main class orchestrating the creation of a new media file.
 * @group Output files
 * @public
 */
export class Output {
    /**
     * Creates a new instance of {@link Output} which can then be used to create a new media file according to the
     * specified {@link OutputOptions}.
     */
    constructor(options) {
        /** The current state of the output. */
        this.state = 'pending';
        /** @internal */
        this._tracks = [];
        /** @internal */
        this._startPromise = null;
        /** @internal */
        this._cancelPromise = null;
        /** @internal */
        this._finalizePromise = null;
        /** @internal */
        this._mutex = new AsyncMutex();
        /** @internal */
        this._metadataTags = {};
        if (!options || typeof options !== 'object') {
            throw new TypeError('options must be an object.');
        }
        if (!(options.format instanceof OutputFormat)) {
            throw new TypeError('options.format must be an OutputFormat.');
        }
        if (!(options.target instanceof Target)) {
            throw new TypeError('options.target must be a Target.');
        }
        if (options.target._output) {
            throw new Error('Target is already used for another output.');
        }
        options.target._output = this;
        this.format = options.format;
        this.target = options.target;
        this._writer = options.target._createWriter();
        this._muxer = options.format._createMuxer(this);
    }
    /** Adds a video track to the output with the given source. Can only be called before the output is started. */
    addVideoTrack(source, metadata = {}) {
        if (!(source instanceof VideoSource)) {
            throw new TypeError('source must be a VideoSource.');
        }
        validateBaseTrackMetadata(metadata);
        if (metadata.rotation !== undefined && ![0, 90, 180, 270].includes(metadata.rotation)) {
            throw new TypeError(`Invalid video rotation: ${metadata.rotation}. Has to be 0, 90, 180 or 270.`);
        }
        if (!this.format.supportsVideoRotationMetadata && metadata.rotation) {
            throw new Error(`${this.format._name} does not support video rotation metadata.`);
        }
        if (metadata.frameRate !== undefined
            && (!Number.isFinite(metadata.frameRate) || metadata.frameRate <= 0)) {
            throw new TypeError(`Invalid video frame rate: ${metadata.frameRate}. Must be a positive number.`);
        }
        this._addTrack('video', source, metadata);
    }
    /** Adds an audio track to the output with the given source. Can only be called before the output is started. */
    addAudioTrack(source, metadata = {}) {
        if (!(source instanceof AudioSource)) {
            throw new TypeError('source must be an AudioSource.');
        }
        validateBaseTrackMetadata(metadata);
        this._addTrack('audio', source, metadata);
    }
    /** Adds a subtitle track to the output with the given source. Can only be called before the output is started. */
    addSubtitleTrack(source, metadata = {}) {
        if (!(source instanceof SubtitleSource)) {
            throw new TypeError('source must be a SubtitleSource.');
        }
        validateBaseTrackMetadata(metadata);
        this._addTrack('subtitle', source, metadata);
    }
    /**
     * Sets descriptive metadata tags about the media file, such as title, author, date, or cover art. When called
     * multiple times, only the metadata from the last call will be used.
     *
     * Can only be called before the output is started.
     */
    setMetadataTags(tags) {
        validateMetadataTags(tags);
        if (this.state !== 'pending') {
            throw new Error('Cannot set metadata tags after output has been started or canceled.');
        }
        this._metadataTags = tags;
    }
    /** @internal */
    _addTrack(type, source, metadata) {
        if (this.state !== 'pending') {
            throw new Error('Cannot add track after output has been started or canceled.');
        }
        if (source._connectedTrack) {
            throw new Error('Source is already used for a track.');
        }
        // Verify maximum track count constraints
        const supportedTrackCounts = this.format.getSupportedTrackCounts();
        const presentTracksOfThisType = this._tracks.reduce((count, track) => count + (track.type === type ? 1 : 0), 0);
        const maxCount = supportedTrackCounts[type].max;
        if (presentTracksOfThisType === maxCount) {
            throw new Error(maxCount === 0
                ? `${this.format._name} does not support ${type} tracks.`
                : (`${this.format._name} does not support more than ${maxCount} ${type} track`
                    + `${maxCount === 1 ? '' : 's'}.`));
        }
        const maxTotalCount = supportedTrackCounts.total.max;
        if (this._tracks.length === maxTotalCount) {
            throw new Error(`${this.format._name} does not support more than ${maxTotalCount} tracks`
                + `${maxTotalCount === 1 ? '' : 's'} in total.`);
        }
        const track = {
            id: this._tracks.length + 1,
            output: this,
            type,
            source: source,
            metadata,
        };
        if (track.type === 'video') {
            const supportedVideoCodecs = this.format.getSupportedVideoCodecs();
            if (supportedVideoCodecs.length === 0) {
                throw new Error(`${this.format._name} does not support video tracks.`
                    + this.format._codecUnsupportedHint(track.source._codec));
            }
            else if (!supportedVideoCodecs.includes(track.source._codec)) {
                throw new Error(`Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported`
                    + ` video codecs are: ${supportedVideoCodecs.map(codec => `'${codec}'`).join(', ')}.`
                    + this.format._codecUnsupportedHint(track.source._codec));
            }
        }
        else if (track.type === 'audio') {
            const supportedAudioCodecs = this.format.getSupportedAudioCodecs();
            if (supportedAudioCodecs.length === 0) {
                throw new Error(`${this.format._name} does not support audio tracks.`
                    + this.format._codecUnsupportedHint(track.source._codec));
            }
            else if (!supportedAudioCodecs.includes(track.source._codec)) {
                throw new Error(`Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported`
                    + ` audio codecs are: ${supportedAudioCodecs.map(codec => `'${codec}'`).join(', ')}.`
                    + this.format._codecUnsupportedHint(track.source._codec));
            }
        }
        else if (track.type === 'subtitle') {
            const supportedSubtitleCodecs = this.format.getSupportedSubtitleCodecs();
            if (supportedSubtitleCodecs.length === 0) {
                throw new Error(`${this.format._name} does not support subtitle tracks.`
                    + this.format._codecUnsupportedHint(track.source._codec));
            }
            else if (!supportedSubtitleCodecs.includes(track.source._codec)) {
                throw new Error(`Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported`
                    + ` subtitle codecs are: ${supportedSubtitleCodecs.map(codec => `'${codec}'`).join(', ')}.`
                    + this.format._codecUnsupportedHint(track.source._codec));
            }
        }
        this._tracks.push(track);
        source._connectedTrack = track;
    }
    /**
     * Starts the creation of the output file. This method should be called after all tracks have been added. Only after
     * the output has started can media samples be added to the tracks.
     *
     * @returns A promise that resolves when the output has successfully started and is ready to receive media samples.
     */
    async start() {
        // Verify minimum track count constraints
        const supportedTrackCounts = this.format.getSupportedTrackCounts();
        for (const trackType of ALL_TRACK_TYPES) {
            const presentTracksOfThisType = this._tracks.reduce((count, track) => count + (track.type === trackType ? 1 : 0), 0);
            const minCount = supportedTrackCounts[trackType].min;
            if (presentTracksOfThisType < minCount) {
                throw new Error(minCount === supportedTrackCounts[trackType].max
                    ? (`${this.format._name} requires exactly ${minCount} ${trackType}`
                        + ` track${minCount === 1 ? '' : 's'}.`)
                    : (`${this.format._name} requires at least ${minCount} ${trackType}`
                        + ` track${minCount === 1 ? '' : 's'}.`));
            }
        }
        const totalMinCount = supportedTrackCounts.total.min;
        if (this._tracks.length < totalMinCount) {
            throw new Error(totalMinCount === supportedTrackCounts.total.max
                ? (`${this.format._name} requires exactly ${totalMinCount} track`
                    + `${totalMinCount === 1 ? '' : 's'}.`)
                : (`${this.format._name} requires at least ${totalMinCount} track`
                    + `${totalMinCount === 1 ? '' : 's'}.`));
        }
        if (this.state === 'canceled') {
            throw new Error('Output has been canceled.');
        }
        if (this._startPromise) {
            console.warn('Output has already been started.');
            return this._startPromise;
        }
        return this._startPromise = (async () => {
            this.state = 'started';
            this._writer.start();
            const release = await this._mutex.acquire();
            await this._muxer.start();
            const promises = this._tracks.map(track => track.source._start());
            await Promise.all(promises);
            release();
        })();
    }
    /**
     * Resolves with the full MIME type of the output file, including track codecs.
     *
     * The returned promise will resolve only once the precise codec strings of all tracks are known.
     */
    getMimeType() {
        return this._muxer.getMimeType();
    }
    /**
     * Cancels the creation of the output file, releasing internal resources like encoders and preventing further
     * samples from being added.
     *
     * @returns A promise that resolves once all internal resources have been released.
     */
    async cancel() {
        if (this._cancelPromise) {
            console.warn('Output has already been canceled.');
            return this._cancelPromise;
        }
        else if (this.state === 'finalizing' || this.state === 'finalized') {
            console.warn('Output has already been finalized.');
            return;
        }
        return this._cancelPromise = (async () => {
            this.state = 'canceled';
            const release = await this._mutex.acquire();
            const promises = this._tracks.map(x => x.source._flushOrWaitForOngoingClose(true)); // Force close
            await Promise.all(promises);
            await this._writer.close();
            release();
        })();
    }
    /**
     * Finalizes the output file. This method must be called after all media samples across all tracks have been added.
     * Once the Promise returned by this method completes, the output file is ready.
     */
    async finalize() {
        if (this.state === 'pending') {
            throw new Error('Cannot finalize before starting.');
        }
        if (this.state === 'canceled') {
            throw new Error('Cannot finalize after canceling.');
        }
        if (this._finalizePromise) {
            console.warn('Output has already been finalized.');
            return this._finalizePromise;
        }
        return this._finalizePromise = (async () => {
            this.state = 'finalizing';
            const release = await this._mutex.acquire();
            const promises = this._tracks.map(x => x.source._flushOrWaitForOngoingClose(false));
            await Promise.all(promises);
            await this._muxer.finalize();
            await this._writer.flush();
            await this._writer.finalize();
            this.state = 'finalized';
            release();
        })();
    }
}
