import Hls from 'hls.js/light';
import { WasmFfmpegRunner } from './adapters/wasm-ffmpeg.js';
import { createBrowserPlaybackCapabilities, evaluatePlaybackOptions, } from './playback-selection.js';
import { createLocalAudioTranscoder, makeAacDecoderConfig } from './pipeline/audio-transcode.js';
import { generateVodPlaylist } from './pipeline/playlist.js';
import { buildSegmentPlan } from './pipeline/segment-plan.js';
import { extractSubtitleData, parseSubtitleFile, subtitleDataToWebVTT, } from './pipeline/subtitle.js';
import { processSegmentWithAbort } from './pipeline/segment-processor.js';
import { isAbortableSource } from './pipeline/source-signal.js';
function normalizeErrorMessage(message) {
    return message.replace(/^Error:\s*/, '').trim();
}
function defaultTranscodeWorkerCount() {
    const concurrency = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
        ? navigator.hardwareConcurrency
        : 2;
    return Math.max(1, Math.min(2, concurrency - 1));
}
export class PlaysVideoEngine extends EventTarget {
    video;
    options;
    worker = null;
    transcodeWorkers = [];
    _transcodeWorkerStates = [];
    _segmentStates = new Map();
    hls = null;
    // Pending segment requests from hls.js custom loader
    pendingSegments = new Map();
    // Cached data from the worker
    playlist = null;
    initData = null;
    pendingInit = null;
    pendingPlaylist = null;
    segmentRequestTimes = new Map();
    subtitleRequestTimes = new Map();
    // Subtitle state
    attachedSubtitleTracks = [];
    _subtitleTracks = [];
    // Public read-only state
    _phase = 'idle';
    _totalSegments = 0;
    _durationSec = 0;
    // Passthrough state
    _passthrough = false;
    _blobUrl = null;
    _pendingFileType = null;
    _codecPath = {
        mode: 'pipeline',
        sourceVideo: { short: null, full: null },
        sourceAudio: { short: null, full: null },
        outputVideo: { short: null, full: null },
        outputAudio: { short: null, full: null },
    };
    // Pre-built keyframe index (e.g. from MKV cues) to skip mediabunny scan
    _keyframeIndex = null;
    // Main-thread pipeline state (used by loadSource)
    _source = null;
    _sourceDemux = null;
    _sourcePlan = [];
    _sourceDoTranscode = false;
    _sourceAudioDecoderConfig = null;
    _sourceInitSegment = null;
    _sourceFfmpeg = null;
    _sourceTargetSegDuration = 4;
    _sourceSegmentAbort = null;
    _sourcePlaybackOptions = null;
    _sourcePreferenceOrder = null;
    _sourcePlaybackPolicy = 'auto';
    _lastInternalErrorMessage = null;
    _lastInternalErrorAt = 0;
    get phase() {
        return this._phase;
    }
    get loading() {
        return this._phase === 'demuxing';
    }
    get totalSegments() {
        return this._totalSegments;
    }
    get durationSec() {
        return this._durationSec;
    }
    get subtitleTracks() {
        return this._subtitleTracks;
    }
    get passthrough() {
        return this._passthrough;
    }
    get codecPath() {
        return {
            mode: this._codecPath.mode,
            sourceVideo: { ...this._codecPath.sourceVideo },
            sourceAudio: { ...this._codecPath.sourceAudio },
            outputVideo: { ...this._codecPath.outputVideo },
            outputAudio: { ...this._codecPath.outputAudio },
        };
    }
    get transcodeWorkerStates() {
        return this._transcodeWorkerStates.map((worker) => ({ ...worker }));
    }
    // [本地补丁] 最近一次 pipeline 自己构建的关键帧索引（prebuilt 传入时为
    // null）。供上层在 attach 完成后读取并做 URL 级复用缓存（重载 / 切回
    // 同一影片时经 loadUrl 的 keyframeIndex 传入，跳过 Range 探测）。
    get builtKeyframeIndex() {
        return this._builtKeyframeIndex;
    }
    get segmentStates() {
        return Array.from(this._segmentStates.values())
            .sort((a, b) => a.index - b.index)
            .map((segment) => ({
            ...segment,
            events: segment.events.map((event) => ({ ...event })),
        }));
    }
    constructor(video, options = {}) {
        super();
        this.video = video;
        this.options = {
            transcodeWorkers: options.transcodeWorkers ?? defaultTranscodeWorkerCount(),
            embeddedSubtitlePolicy: options.embeddedSubtitlePolicy ?? 'auto',
        };
    }
    loadFile(file, opts) {
        this.reset({ file });
        this._pendingFileType = file.type || null;
        this._blobUrl = URL.createObjectURL(file);
        this._keyframeIndex = opts?.keyframeIndex ?? null;
        this.createWorker();
        this.worker.postMessage({ type: 'open', file });
        mlog(`open file=${file.name} size=${(file.size / 1024 / 1024).toFixed(1)}MB type=${file.type}`);
    }
    loadUrl(url, opts) {
        this.reset({ url });
        this._keyframeIndex = opts?.keyframeIndex ?? null;
        this._sourcePlaybackOptions = null;
        this._sourcePreferenceOrder = null;
        this._sourcePlaybackPolicy = 'auto';
        this.createWorker();
        this.worker.postMessage({ type: 'open-url', url });
        mlog(`open url=${url}`);
    }
    async loadExternalSubtitle(file, options = {}) {
        if (this._phase !== 'ready') {
            throw new Error('Load a video before adding an external subtitle file');
        }
        const text = await file.text();
        const data = parseSubtitleFile(text, file.name);
        if (data.codec === 'ass' || data.codec === 'ssa') {
            throw new Error('External .ass/.ssa subtitles are not supported yet');
        }
        const webvtt = subtitleDataToWebVTT(data);
        this.clearExternalSubtitles();
        this.addSubtitleTrack({
            webvtt,
            source: 'external',
            label: options.label ?? file.name.replace(/\.[^.]+$/, ''),
            language: options.language ?? 'und',
            kind: options.kind ?? 'subtitles',
            defaultTrack: true,
            selectTrack: true,
        });
    }
    clearExternalSubtitles() {
        this.removeSubtitleTracks('external');
        this.restoreDefaultTextTrack();
    }
    /**
     * Load from an external Source (e.g. TorrentSource).
     *
     * Runs the pipeline on the main thread (no worker) because external Sources
     * typically need access to objects on the main thread.
     *
     * If the Source implements AbortableSource, the pipeline will call
     * setCurrentSignal() before each segment so the Source can abort in-flight
     * reads on seek.
     */
    loadSource(source, opts) {
        this.reset({});
        this._keyframeIndex = opts?.keyframeIndex ?? null;
        this._sourcePlaybackOptions = null;
        this._sourcePreferenceOrder = null;
        this._sourcePlaybackPolicy = 'auto';
        this._source = source;
        this._sourcePlan = [];
        this._sourceDoTranscode = false;
        this._sourceAudioDecoderConfig = null;
        this._sourceInitSegment = null;
        this._sourceFfmpeg = opts?.ffmpeg ?? null;
        this._sourceTargetSegDuration = opts?.targetSegmentDuration ?? 4;
        this.startSourcePipeline(source);
    }
    loadWithOptions(input) {
        this.reset({});
        this._keyframeIndex = null;
        this._source = input.source;
        this._sourcePlan = [];
        this._sourceDoTranscode = false;
        this._sourceAudioDecoderConfig = null;
        this._sourceInitSegment = null;
        this._sourceFfmpeg = input.ffmpeg ?? null;
        this._sourceTargetSegDuration = input.targetSegmentDuration ?? 4;
        this._sourcePlaybackOptions = input.options.length > 0 ? [...input.options] : [{ mode: 'hls' }];
        this._sourcePreferenceOrder = input.preferenceOrder ? [...input.preferenceOrder] : null;
        this._sourcePlaybackPolicy = input.playbackPolicy ?? 'auto';
        this.startSourcePipeline(input.source);
    }
    reset(detail) {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.destroyTranscodeWorkers();
        if (this._blobUrl) {
            URL.revokeObjectURL(this._blobUrl);
            this._blobUrl = null;
        }
        if (this._passthrough) {
            this.video.removeAttribute('src');
            this.video.load();
        }
        this.playlist = null;
        this.initData = null;
        this.pendingSegments.clear();
        this.segmentRequestTimes.clear();
        this.subtitleRequestTimes.clear();
        this.removeSubtitleTracks();
        this._phase = 'demuxing';
        this._totalSegments = 0;
        this._durationSec = 0;
        this._subtitleTracks = [];
        this._passthrough = false;
        this._pendingFileType = null;
        this._keyframeIndex = null;
        // [本地补丁] 上一次 pipeline 自己构建的关键帧索引（builtKeyframeIndex
        // getter 供上层复用缓存）；reset 清空避免 passthrough 残留旧值
        this._builtKeyframeIndex = null;
        this._codecPath = {
            mode: 'pipeline',
            sourceVideo: { short: null, full: null },
            sourceAudio: { short: null, full: null },
            outputVideo: { short: null, full: null },
            outputAudio: { short: null, full: null },
        };
        // Source pipeline cleanup
        if (this._sourceSegmentAbort) {
            this._sourceSegmentAbort.abort();
            this._sourceSegmentAbort = null;
        }
        if (this._source && isAbortableSource(this._source)) {
            this._source.setCurrentSignal(null);
        }
        this._source?._dispose();
        this._source = null;
        this._sourceDemux?.dispose();
        this._sourceDemux = null;
        this._sourcePlan = [];
        this._sourceDoTranscode = false;
        this._sourceAudioDecoderConfig = null;
        this._sourceInitSegment = null;
        this._sourceFfmpeg = null;
        this._sourcePlaybackOptions = null;
        this._sourcePreferenceOrder = null;
        this._sourcePlaybackPolicy = 'auto';
        this._segmentStates.clear();
        this._lastInternalErrorMessage = null;
        this._lastInternalErrorAt = 0;
        this.dispatchEvent(new CustomEvent('loading', { detail }));
        this.dispatchSegmentStateChange();
    }
    createWorker() {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this.handleWorkerMessage(e);
        this.worker.onerror = (e) => {
            this.failPlayback(e.message || 'Playback worker crashed');
        };
    }
    ensureTranscodeWorkers() {
        if (!this.worker || this.transcodeWorkers.length > 0 || this.options.transcodeWorkers <= 0) {
            return;
        }
        for (let i = 0; i < this.options.transcodeWorkers; i++) {
            const worker = new Worker(new URL('./transcode-worker.js', import.meta.url), {
                type: 'module',
            });
            worker.onmessage = (event) => this.handleTranscodeWorkerMessage(i, event);
            worker.onerror = (event) => {
                const message = event.message || 'Transcode worker crashed';
                this.updateTranscodeWorkerState(i, {
                    phase: 'error',
                    jobId: null,
                    lastError: message,
                });
                this.worker?.postMessage({ type: 'transcode-worker-failed', id: i, message });
            };
            const channel = new MessageChannel();
            worker.postMessage({ type: 'connect' }, [channel.port2]);
            this.worker.postMessage({ type: 'transcode-port', id: i }, [channel.port1]);
            this.transcodeWorkers.push({ worker });
            this._transcodeWorkerStates.push({
                id: i,
                phase: 'starting',
                sourceCodec: null,
                jobId: null,
                inputBytes: null,
                outputBytes: null,
                totalMs: null,
                ffmpegMs: null,
                jobsCompleted: 0,
                lastError: null,
            });
        }
        this.dispatchWorkerStateChange();
    }
    destroyTranscodeWorkers() {
        for (const handle of this.transcodeWorkers) {
            handle.worker.terminate();
        }
        this.transcodeWorkers = [];
        this._transcodeWorkerStates = [];
        this.dispatchWorkerStateChange();
    }
    destroy() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.destroyTranscodeWorkers();
        if (this._blobUrl) {
            URL.revokeObjectURL(this._blobUrl);
            this._blobUrl = null;
        }
        if (this._passthrough) {
            this.video.removeAttribute('src');
            this.video.load();
        }
        this.removeSubtitleTracks();
        if (this._sourceSegmentAbort) {
            this._sourceSegmentAbort.abort();
            this._sourceSegmentAbort = null;
        }
        if (this._source && isAbortableSource(this._source)) {
            this._source.setCurrentSignal(null);
        }
        this._source?._dispose();
        this._source = null;
        this._sourceDemux?.dispose();
        this._sourceDemux = null;
        this.pendingSegments.clear();
        this.segmentRequestTimes.clear();
        this.subtitleRequestTimes.clear();
        this._phase = 'idle';
        this._passthrough = false;
        this._segmentStates.clear();
        this._lastInternalErrorMessage = null;
        this._lastInternalErrorAt = 0;
        this.dispatchSegmentStateChange();
    }
    addEventListener(type, listener, options) {
        super.addEventListener(type, listener, options);
    }
    dispatchWorkerStateChange() {
        this.dispatchEvent(new CustomEvent('workerstatechange', {
            detail: {
                workers: this.transcodeWorkerStates,
            },
        }));
    }
    dispatchSegmentStateChange() {
        this.dispatchEvent(new CustomEvent('segmentstatechange', {
            detail: {
                segments: this.segmentStates,
            },
        }));
    }
    handleTranscodeWorkerMessage(id, event) {
        const msg = event.data;
        if (!msg || msg.type !== 'worker-state') {
            return;
        }
        this.updateTranscodeWorkerState(id, msg.state);
    }
    updateTranscodeWorkerState(id, patch) {
        const index = this._transcodeWorkerStates.findIndex((worker) => worker.id === id);
        if (index === -1) {
            return;
        }
        this._transcodeWorkerStates[index] = {
            ...this._transcodeWorkerStates[index],
            ...patch,
            id,
        };
        if (patch.phase === 'error' && patch.lastError) {
            this.recordInternalError(patch.lastError);
        }
        this.dispatchWorkerStateChange();
    }
    noteSegmentState(index, phase, opts = {}) {
        const existing = this._segmentStates.get(index);
        const next = existing
            ? {
                ...existing,
                events: [...existing.events],
            }
            : {
                index,
                phase,
                requestCount: 0,
                sizeBytes: null,
                latencyMs: null,
                error: null,
                prefetched: false,
                events: [],
            };
        next.phase = phase;
        if (opts.incrementRequestCount) {
            next.requestCount += 1;
        }
        if (opts.prefetched !== undefined) {
            next.prefetched = opts.prefetched;
        }
        else if (phase === 'prefetching') {
            next.prefetched = true;
        }
        if (opts.sizeBytes !== undefined) {
            next.sizeBytes = opts.sizeBytes;
        }
        if (opts.latencyMs !== undefined) {
            next.latencyMs = opts.latencyMs;
        }
        next.error = phase === 'error' ? (opts.message ?? next.error) : null;
        next.events.push({
            phase,
            atMs: performance.now(),
            sizeBytes: opts.sizeBytes ?? null,
            message: opts.message ?? null,
        });
        this._segmentStates.set(index, next);
        this.dispatchSegmentStateChange();
    }
    handleWorkerSegmentState(msg) {
        if (msg.phase === 'error' && msg.message) {
            this.recordInternalError(msg.message);
        }
        this.noteSegmentState(msg.index, msg.phase, {
            sizeBytes: msg.sizeBytes,
            message: msg.message,
        });
    }
    recordInternalError(message) {
        const normalized = normalizeErrorMessage(message);
        this._lastInternalErrorMessage = normalized;
        this._lastInternalErrorAt = performance.now();
        return normalized;
    }
    getRecentInternalError(maxAgeMs = 5000) {
        if (!this._lastInternalErrorMessage) {
            return null;
        }
        if (performance.now() - this._lastInternalErrorAt > maxAgeMs) {
            return null;
        }
        return this._lastInternalErrorMessage;
    }
    failPlayback(message) {
        const normalized = this.recordInternalError(message);
        this._phase = 'error';
        this.dispatchEvent(new CustomEvent('error', { detail: { message: normalized } }));
    }
    createPlaybackCapabilities() {
        const capabilities = createBrowserPlaybackCapabilities(this.video);
        if (FORCE_REMUX) {
            return {
                ...capabilities,
                canPlayType: () => '',
            };
        }
        return capabilities;
    }
    evaluateInitialPlayback(media) {
        const options = this._blobUrl
            ? [
                { mode: 'direct-bytes', mimeType: this._pendingFileType, url: this._blobUrl },
                { mode: 'hls' },
            ]
            : [{ mode: 'hls' }];
        return evaluatePlaybackOptions({
            options: [...options],
            media,
            capabilities: this.createPlaybackCapabilities(),
        });
    }
    evaluateHlsPlayback(media) {
        return evaluatePlaybackOptions({
            options: [{ mode: 'hls' }],
            media,
            capabilities: this.createPlaybackCapabilities(),
        }).evaluations[0];
    }
    evaluateSourcePlayback(media) {
        return evaluatePlaybackOptions({
            options: this.getSourcePlaybackOptions(),
            media,
            capabilities: this.createPlaybackCapabilities(),
            preferenceOrder: this._sourcePreferenceOrder ?? undefined,
        });
    }
    getSourcePlaybackOptions() {
        const baseOptions = this._sourcePlaybackOptions
            ? [...this._sourcePlaybackOptions]
            : [{ mode: 'hls' }];
        if (this._sourcePlaybackPolicy !== 'force-hls') {
            return baseOptions;
        }
        const hlsOption = baseOptions.find((option) => option.mode === 'hls');
        return hlsOption ? [hlsOption] : [{ mode: 'hls' }];
    }
    logPlaybackDiagnostics(context, evaluation) {
        for (const entry of evaluation.evaluations) {
            for (const diagnostic of entry.diagnostics) {
                mlog(`${context}: mode=${entry.option.mode} ${diagnostic.code} ${diagnostic.message}`);
            }
        }
        if (!evaluation.recommended) {
            mlog(`${context}: no-supported-option`);
        }
    }
    dispatchPlaybackDecision(media, evaluation) {
        this.dispatchEvent(new CustomEvent('playbackdecision', {
            detail: {
                media,
                evaluation,
                playbackPolicy: this._sourcePlaybackPolicy,
            },
        }));
    }
    throwPlaybackSelectionError(context, diagnostics) {
        const detail = diagnostics.length > 0
            ? diagnostics.map((diagnostic) => diagnostic.message).join(' ')
            : 'No supported playback option.';
        throw new Error(`${context}: ${detail}`);
    }
    failPlaybackSelection(context, diagnostics) {
        const detail = diagnostics.length > 0
            ? diagnostics.map((diagnostic) => diagnostic.message).join(' ')
            : 'No supported playback option.';
        this.failPlayback(`${context}: ${detail}`);
    }
    makeCodecPathFromSource(media, mode, outputAudio = {
        short: media.sourceAudioCodec,
        full: media.audioCodec,
    }) {
        return {
            mode,
            sourceVideo: {
                short: media.sourceVideoCodec,
                full: media.videoCodec,
            },
            sourceAudio: {
                short: media.sourceAudioCodec,
                full: media.audioCodec,
            },
            outputVideo: {
                short: media.sourceVideoCodec,
                full: media.videoCodec,
            },
            outputAudio,
        };
    }
    startPassthrough(src) {
        this._passthrough = true;
        this._totalSegments = 0;
        if (src.startsWith('blob:')) {
            this._blobUrl = src;
        }
        this.video.src = src;
        const fireReady = () => {
            this._durationSec = this.video.duration;
            this._phase = 'ready';
            mlog(`passthrough ready dur=${this._durationSec.toFixed(1)}s`);
            this.dispatchEvent(new CustomEvent('ready', {
                detail: {
                    totalSegments: 0,
                    durationSec: this._durationSec,
                    subtitleTracks: this._subtitleTracks,
                    passthrough: true,
                    codecPath: this.codecPath,
                },
            }));
        };
        if (this.video.readyState >= 1) {
            fireReady();
        }
        else {
            this.video.addEventListener('loadedmetadata', fireReady, { once: true });
        }
    }
    handleWorkerMessage(event) {
        const msg = event.data;
        if (msg.type === 'progress') {
            // [本地补丁] worker 长耗时阶段（probe/index/ffmpeg/seg0）的心跳：
            // 派发 progress 事件供上层驱动活动超时与加载进度展示
            this.dispatchEvent(new CustomEvent('progress', { detail: { stage: msg.stage } }));
            return;
        }
        if (msg.type === 'probed') {
            // Worker finished demux — decide passthrough vs pipeline
            const media = {
                sourceVideoCodec: msg.sourceVideoCodec ?? null,
                sourceAudioCodec: msg.sourceAudioCodec ?? null,
                videoCodec: msg.videoCodec ?? null,
                audioCodec: msg.audioCodec ?? null,
            };
            const evaluation = this.evaluateInitialPlayback(media);
            this.logPlaybackDiagnostics('playback selection', evaluation);
            this.dispatchPlaybackDecision(media, evaluation);
            this._subtitleTracks = msg.subtitleTracks ?? [];
            const blobUrl = this._blobUrl;
            const usePassthrough = evaluation.recommended?.option.mode === 'direct-bytes' && blobUrl !== null;
            this._codecPath = this.makeCodecPathFromSource(media, usePassthrough ? 'passthrough' : 'pipeline');
            if (usePassthrough && blobUrl) {
                mlog(`passthrough: selected direct playback codecs=${msg.videoCodec}/${msg.audioCodec}`);
                this.startPassthrough(blobUrl);
                this.worker.postMessage({ type: 'passthrough-pipeline' });
                if (this._subtitleTracks.length > 0) {
                    this.dispatchSubtitleStatus(`Extracting ${this._subtitleTracks.length} subtitle track(s)...`);
                }
                else {
                    this.dispatchSubtitleStatus('No embedded subtitles');
                }
                for (const track of this._subtitleTracks) {
                    this.requestEmbeddedSubtitleTrack(track);
                }
            }
            else {
                const hlsEvaluation = evaluation.evaluations.find((entry) => entry.option.mode === 'hls');
                if (evaluation.recommended?.option.mode !== 'hls') {
                    this.failPlaybackSelection('Playback selection failed', hlsEvaluation?.diagnostics ?? []);
                    return;
                }
                if (this._blobUrl) {
                    URL.revokeObjectURL(this._blobUrl);
                    this._blobUrl = null;
                }
                mlog('pipeline: selected remux/HLS playback');
                this.ensureTranscodeWorkers();
                const remuxMsg = { type: 'remux-pipeline' };
                if (this._keyframeIndex)
                    remuxMsg.keyframeIndex = this._keyframeIndex;
                this.worker.postMessage(remuxMsg);
            }
        }
        else if (msg.type === 'ready') {
            this.playlist = msg.playlist;
            this.initData = msg.initData;
            this._totalSegments = msg.totalSegments;
            this._durationSec = msg.durationSec;
            this._subtitleTracks = msg.subtitleTracks ?? [];
            // [本地补丁] worker 本地构建的关键帧索引（prebuilt 时为 null），
            // 经 builtKeyframeIndex getter 供上层做 URL 级复用缓存
            this._builtKeyframeIndex = msg.keyframeIndex ?? null;
            this._phase = 'ready';
            this._codecPath = {
                mode: 'pipeline',
                sourceVideo: {
                    short: msg.sourceVideoCodec ?? this._codecPath.sourceVideo.short,
                    full: msg.sourceVideoCodecFull ?? this._codecPath.sourceVideo.full,
                },
                sourceAudio: {
                    short: msg.sourceAudioCodec ?? this._codecPath.sourceAudio.short,
                    full: msg.sourceAudioCodecFull ?? this._codecPath.sourceAudio.full,
                },
                outputVideo: {
                    short: msg.outputVideoCodec ?? this._codecPath.outputVideo.short,
                    full: msg.outputVideoCodecFull ?? this._codecPath.outputVideo.full,
                },
                outputAudio: {
                    short: msg.outputAudioCodec ?? this._codecPath.outputAudio.short,
                    full: msg.outputAudioCodecFull ?? this._codecPath.outputAudio.full,
                },
            };
            mlog(`ready segments=${msg.totalSegments} dur=${msg.durationSec.toFixed(1)}s`);
            // Resolve any pending requests
            if (this.pendingPlaylist) {
                this.pendingPlaylist.resolve(this.playlist);
                this.pendingPlaylist = null;
            }
            if (this.pendingInit && this.initData) {
                this.pendingInit.resolve(this.initData);
                this.pendingInit = null;
            }
            // Request subtitle extraction for all embedded tracks
            if (this._subtitleTracks.length > 0) {
                this.dispatchSubtitleStatus(`Extracting ${this._subtitleTracks.length} subtitle track(s)...`);
            }
            else {
                this.dispatchSubtitleStatus('No embedded subtitles');
            }
            for (const track of this._subtitleTracks) {
                this.requestEmbeddedSubtitleTrack(track);
            }
            this.dispatchEvent(new CustomEvent('ready', {
                detail: {
                    totalSegments: this._totalSegments,
                    durationSec: this._durationSec,
                    subtitleTracks: this._subtitleTracks,
                    codecPath: this.codecPath,
                },
            }));
            this.startHls();
        }
        else if (msg.type === 'subtitle') {
            mlog(`subtitle arrived track=${msg.trackIndex} codec=${msg.codec} len=${msg.webvtt?.length}`);
            this.subtitleRequestTimes.delete(msg.trackIndex);
            const info = this._subtitleTracks.find((t) => t.index === msg.trackIndex);
            const lang = info?.language ?? '?';
            const cueMatch = msg.webvtt?.match(/\d\d:\d\d/g);
            const cueCount = cueMatch ? Math.floor(cueMatch.length / 2) : 0;
            this.dispatchSubtitleStatus(`Subtitle track ${msg.trackIndex}: ${lang} ${msg.codec} ${cueCount} cues, ${msg.webvtt?.length ?? 0} bytes`);
            this.addSubtitleTrack({
                webvtt: msg.webvtt,
                source: 'embedded',
                trackIndex: msg.trackIndex,
                defaultTrack: this.shouldAutoSelectEmbeddedSubtitle(msg.trackIndex),
                selectTrack: this.shouldAutoSelectEmbeddedSubtitle(msg.trackIndex),
            });
        }
        else if (msg.type === 'subtitle-progress') {
            this.handleWorkerSubtitleProgress(msg);
        }
        else if (msg.type === 'segment-state') {
            this.handleWorkerSegmentState(msg);
        }
        else if (msg.type === 'segment') {
            const pending = this.pendingSegments.get(msg.index);
            const reqTime = this.segmentRequestTimes.get(msg.index);
            const latencyMs = reqTime ? performance.now() - reqTime : null;
            const latency = latencyMs !== null ? latencyMs.toFixed(1) : '?';
            const size = msg.data?.byteLength ?? 0;
            this.segmentRequestTimes.delete(msg.index);
            if (pending) {
                pending.resolve(msg.data);
                this.pendingSegments.delete(msg.index);
            }
            this.noteSegmentState(msg.index, 'delivered', {
                sizeBytes: size,
                latencyMs: latencyMs ?? undefined,
            });
            mlog(`seg ${msg.index} arrived latency=${latency}ms size=${size} pending=${this.pendingSegments.size}`);
        }
        else if (msg.type === 'error') {
            mlog(`error: ${msg.message} pending=${this.pendingSegments.size}`);
            this.failPlayback(msg.message);
            // Reject all pending requests
            for (const [index, p] of this.pendingSegments) {
                this.noteSegmentState(index, 'error', { message: msg.message });
                p.reject(new Error(msg.message));
            }
            this.pendingSegments.clear();
            this.subtitleRequestTimes.clear();
            if (this.pendingInit) {
                this.pendingInit.reject(new Error(msg.message));
                this.pendingInit = null;
            }
            if (this.pendingPlaylist) {
                this.pendingPlaylist.reject(new Error(msg.message));
                this.pendingPlaylist = null;
            }
        }
    }
    requestSegment(index) {
        // Race detection: duplicate request for same segment
        if (this.pendingSegments.has(index)) {
            mlog(`WARN duplicate request for seg ${index} (already pending)`);
        }
        const pendingCount = this.pendingSegments.size;
        if (pendingCount > 1) {
            mlog(`WARN ${pendingCount} segments already pending when requesting seg ${index}`);
        }
        mlog(`req seg ${index} pending=${pendingCount}`);
        this.segmentRequestTimes.set(index, performance.now());
        this.noteSegmentState(index, 'requested', { incrementRequestCount: true });
        return new Promise((resolve, reject) => {
            this.pendingSegments.set(index, { resolve, reject });
            this.worker.postMessage({ type: 'segment', index });
        });
    }
    cancelSegment(index) {
        const pending = this.pendingSegments.get(index);
        if (pending) {
            mlog(`cancel seg ${index}`);
            this.noteSegmentState(index, 'canceled');
            pending.reject(new DOMException('Segment aborted', 'AbortError'));
            this.pendingSegments.delete(index);
            this.segmentRequestTimes.delete(index);
            this.worker?.postMessage({ type: 'cancel', index });
        }
    }
    async startSourcePipeline(source) {
        try {
            const { demuxSource, getKeyframeIndex } = await import('./pipeline/demux.js');
            const { buildMkvKeyframeIndexFromSource } = await import('./pipeline/mkv-keyframe-index.js');
            mlog('source pipeline: demuxing');
            this._sourceDemux = await demuxSource(source);
            const demux = this._sourceDemux;
            // Build keyframe index
            let index;
            if (this._keyframeIndex) {
                index = this._keyframeIndex;
                mlog(`source pipeline: pre-built keyframes=${index.keyframes.length}`);
            }
            else {
                const mkvIndex = await buildMkvKeyframeIndexFromSource(source, demux.videoTrack.id);
                if (mkvIndex) {
                    index = mkvIndex;
                    mlog(`source pipeline: mkv-cues keyframes=${index.keyframes.length}`);
                }
                else {
                    index = await getKeyframeIndex(demux.videoSink, demux.duration);
                    mlog(`source pipeline: keyframe-index keyframes=${index.keyframes.length}`);
                }
            }
            // Build segment plan
            this._sourcePlan = buildSegmentPlan({
                keyframeTimestampsSec: index.keyframes.map((k) => k.timestamp),
                durationSec: index.duration,
                targetSegmentDurationSec: this._sourceTargetSegDuration,
            });
            const media = {
                sourceVideoCodec: demux.videoCodec,
                sourceAudioCodec: demux.audioCodec,
                videoCodec: demux.videoDecoderConfig.codec,
                audioCodec: demux.audioDecoderConfig?.codec ?? null,
            };
            const evaluation = this.evaluateSourcePlayback(media);
            this.logPlaybackDiagnostics('source playback selection', evaluation);
            this.dispatchPlaybackDecision(media, evaluation);
            const selectedOption = evaluation.recommended?.option ?? null;
            if (!selectedOption) {
                this.throwPlaybackSelectionError('Source playback selection failed', evaluation.evaluations.flatMap((entry) => entry.diagnostics));
            }
            if (selectedOption.mode !== 'hls') {
                if (!selectedOption.url) {
                    this.throwPlaybackSelectionError('Source playback selection failed', evaluation.evaluations.flatMap((entry) => entry.diagnostics));
                }
                this._subtitleTracks = demux.subtitleTracks;
                this._codecPath = this.makeCodecPathFromSource(media, 'passthrough');
                this._sourcePlan = [];
                this._sourceDoTranscode = false;
                this._sourceAudioDecoderConfig = null;
                this._sourceInitSegment = null;
                mlog(`source pipeline: selected ${selectedOption.mode}`);
                this.startPassthrough(selectedOption.url);
                void this.extractEmbeddedSubtitlesFromDemux(demux, { releaseAfterComplete: true });
                return;
            }
            const hlsEvaluation = evaluation.evaluations.find((entry) => entry.option.mode === 'hls') ?? null;
            if (!hlsEvaluation || hlsEvaluation.status !== 'supported') {
                this.throwPlaybackSelectionError('Source playback selection failed', evaluation.evaluations.flatMap((entry) => entry.diagnostics));
            }
            this._sourceDoTranscode = hlsEvaluation.pipelineAudioRequiresTranscode === true;
            this._sourceAudioDecoderConfig = this._sourceDoTranscode
                ? makeAacDecoderConfig(demux.audioDecoderConfig)
                : demux.audioDecoderConfig;
            this._codecPath = this.makeCodecPathFromSource(media, 'pipeline', {
                short: this._sourceDoTranscode ? 'aac' : demux.audioCodec,
                full: this._sourceAudioDecoderConfig?.codec ?? null,
            });
            // Pre-process segment 0
            const seg0Result = await processSegmentWithAbort(this.makeSourceProcessorConfig(), 0);
            if (seg0Result.initSegment) {
                this._sourceInitSegment = seg0Result.initSegment;
            }
            // Build playlist
            const playlist = generateVodPlaylist({
                targetDuration: Math.ceil(Math.max(...this._sourcePlan.map((s) => s.durationSec))),
                mediaSequence: 0,
                mapUri: 'init.mp4',
                entries: this._sourcePlan.map((s) => ({
                    uri: `seg-${s.sequence}.m4s`,
                    durationSec: s.durationSec,
                })),
                endList: true,
            });
            this.playlist = playlist;
            this.initData = this._sourceInitSegment.buffer.slice(this._sourceInitSegment.byteOffset, this._sourceInitSegment.byteOffset + this._sourceInitSegment.byteLength);
            this._totalSegments = this._sourcePlan.length;
            this._durationSec = demux.duration;
            this._subtitleTracks = demux.subtitleTracks;
            this._phase = 'ready';
            mlog(`source pipeline: ready segments=${this._totalSegments} dur=${this._durationSec.toFixed(1)}s`);
            this.dispatchEvent(new CustomEvent('ready', {
                detail: {
                    totalSegments: this._totalSegments,
                    durationSec: this._durationSec,
                    subtitleTracks: this._subtitleTracks,
                    codecPath: this.codecPath,
                },
            }));
            void this.extractEmbeddedSubtitlesFromDemux(demux);
            this.startHls();
        }
        catch (err) {
            this.failPlayback(String(err));
        }
    }
    makeSourceProcessorConfig() {
        if (!this._sourceFfmpeg) {
            this._sourceFfmpeg = new WasmFfmpegRunner();
        }
        const demux = this._sourceDemux;
        return {
            videoSink: demux.videoSink,
            audioSink: demux.audioSink,
            videoCodec: demux.videoCodec,
            audioCodec: demux.audioCodec,
            videoDecoderConfig: demux.videoDecoderConfig,
            audioDecoderConfig: this._sourceAudioDecoderConfig,
            plan: this._sourcePlan,
            doTranscode: this._sourceDoTranscode,
            transcodeAudio: createLocalAudioTranscoder(this._sourceFfmpeg),
            sourceCodec: demux.audioCodec ?? undefined,
            log: mlog,
        };
    }
    async requestSourceSegment(index) {
        // Cancel previous in-flight segment if any
        if (this._sourceSegmentAbort) {
            this._sourceSegmentAbort.abort();
        }
        const controller = new AbortController();
        this._sourceSegmentAbort = controller;
        // Set signal on source for abort-aware Sources (e.g. TorrentSource)
        if (this._source && isAbortableSource(this._source)) {
            this._source.setCurrentSignal(controller.signal);
        }
        const result = await processSegmentWithAbort(this.makeSourceProcessorConfig(), index, controller.signal);
        this._sourceSegmentAbort = null;
        // Update mutable state
        if (!this._sourceInitSegment && result.initSegment) {
            this._sourceInitSegment = result.initSegment;
        }
        return result.mediaData.buffer.slice(result.mediaData.byteOffset, result.mediaData.byteOffset + result.mediaData.byteLength);
    }
    startHls() {
        if (!Hls.isSupported()) {
            this.failPlayback('hls.js not supported in this browser');
            return;
        }
        // Need to capture `this` for the loader classes
        const engine = this;
        class PipelinePlaylistLoader {
            context = null;
            stats = makeStats();
            load(context, _config, callbacks) {
                this.context = context;
                if (engine.playlist) {
                    const data = engine.playlist;
                    queueMicrotask(() => {
                        this.stats.loaded = data.length;
                        this.stats.loading.end = performance.now();
                        callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
                    });
                }
                else {
                    engine.pendingPlaylist = {
                        resolve: (data) => {
                            this.stats.loaded = data.length;
                            this.stats.loading.end = performance.now();
                            callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
                        },
                        reject: (err) => {
                            callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
                        },
                    };
                }
            }
            abort() { }
            destroy() { }
        }
        class PipelineFragmentLoader {
            context = null;
            stats = makeStats();
            currentSegmentIndex = null;
            callbacks = null;
            aborted = false;
            load(context, _config, callbacks) {
                this.context = context;
                this.callbacks = callbacks;
                this.aborted = false;
                const url = context.url;
                if (url.includes('init.mp4')) {
                    this.loadInit(context, callbacks);
                }
                else {
                    const match = url.match(/seg-(\d+)\.m4s/);
                    if (match) {
                        this.loadSegment(parseInt(match[1], 10), context, callbacks);
                    }
                    else {
                        callbacks.onError({ code: 404, text: 'Unknown URL' }, context, null, this.stats);
                    }
                }
            }
            loadInit(context, callbacks) {
                if (engine.initData) {
                    const data = engine.initData;
                    queueMicrotask(() => {
                        this.stats.loaded = data.byteLength;
                        this.stats.loading.end = performance.now();
                        callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
                    });
                }
                else {
                    engine.pendingInit = {
                        resolve: (data) => {
                            this.stats.loaded = data.byteLength;
                            this.stats.loading.end = performance.now();
                            callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
                        },
                        reject: (err) => {
                            callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
                        },
                    };
                }
            }
            loadSegment(index, context, callbacks) {
                this.currentSegmentIndex = index;
                const segmentPromise = engine._source
                    ? engine.requestSourceSegment(index)
                    : engine.requestSegment(index);
                segmentPromise
                    .then((data) => {
                    if (this.aborted) {
                        return;
                    }
                    this.currentSegmentIndex = null;
                    this.stats.loaded = data.byteLength;
                    this.stats.loading.end = performance.now();
                    callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
                })
                    .catch((err) => {
                    if (this.aborted) {
                        return;
                    }
                    this.currentSegmentIndex = null;
                    if (err instanceof DOMException && err.name === 'AbortError') {
                        this.stats.aborted = true;
                        callbacks.onAbort?.(this.stats, context, null);
                        return;
                    }
                    callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
                });
            }
            abort() {
                if (this.aborted) {
                    return;
                }
                this.aborted = true;
                this.stats.aborted = true;
                let abortedActiveSegment = false;
                if (this.currentSegmentIndex !== null) {
                    abortedActiveSegment = true;
                    if (engine._source) {
                        // Source mode: abort the in-flight main-thread processing
                        engine._sourceSegmentAbort?.abort();
                    }
                    else {
                        // Worker mode: cancel via worker message
                        engine.cancelSegment(this.currentSegmentIndex);
                    }
                    this.currentSegmentIndex = null;
                }
                if (abortedActiveSegment && this.callbacks && this.context) {
                    this.callbacks.onAbort?.(this.stats, this.context, null);
                }
            }
            destroy() {
                this.abort();
                this.callbacks = null;
                this.context = null;
            }
        }
        this.hls = new Hls({
            pLoader: PipelinePlaylistLoader,
            fLoader: PipelineFragmentLoader,
            enableWorker: false,
        });
        this.hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
            mlog(`hls MANIFEST_PARSED levels=${data.levels.length}`);
            if (this.video.autoplay) {
                this.video.play().catch(() => { });
            }
        });
        this.hls.on(Hls.Events.FRAG_LOADING, (_evt, data) => {
            mlog(`hls FRAG_LOADING sn=${data.frag.sn} url=${data.frag.relurl}`);
        });
        this.hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
            mlog(`hls FRAG_LOADED sn=${data.frag.sn} size=${data.frag.stats.loaded}`);
        });
        this.hls.on(Hls.Events.FRAG_BUFFERED, (_evt, data) => {
            mlog(`hls FRAG_BUFFERED sn=${data.frag.sn}`);
        });
        this.hls.on(Hls.Events.BUFFER_APPENDING, (_evt, data) => {
            mlog(`hls BUFFER_APPENDING type=${data.type}`);
        });
        this.hls.on(Hls.Events.ERROR, (_evt, data) => {
            const underlyingMessage = data.error?.message ?? data.reason ?? data.response?.text ?? data.err?.message ?? null;
            mlog(`hls ERROR fatal=${data.fatal} type=${data.type} details=${data.details}${underlyingMessage ? ` message=${underlyingMessage}` : ''}`);
            if (data.fatal) {
                console.error('hls.js fatal error:', data);
                const internalMessage = this.getRecentInternalError();
                const message = internalMessage && data.details === 'fragLoadError'
                    ? internalMessage
                    : underlyingMessage
                        ? `${data.details} (${normalizeErrorMessage(underlyingMessage)})`
                        : data.details;
                this.failPlayback(message);
            }
        });
        this.hls.loadSource('/virtual/playlist.m3u8');
        this.hls.attachMedia(this.video);
    }
    addSubtitleTrack({ webvtt, source, trackIndex, label, language, kind, defaultTrack = false, selectTrack = false, }) {
        const blob = new Blob([webvtt], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);
        const info = trackIndex === undefined
            ? undefined
            : this._subtitleTracks.find((t) => t.index === trackIndex);
        const track = document.createElement('track');
        track.kind = kind ?? (info?.disposition.hearingImpaired ? 'captions' : 'subtitles');
        track.src = url;
        track.srclang = normalizeSubtitleLanguageCode(language ?? info?.language ?? 'und');
        track.label =
            label ??
                info?.name ??
                languageLabel(info?.language ?? 'und', trackIndex ?? this.video.querySelectorAll('track').length);
        track.default = defaultTrack;
        this.video.appendChild(track);
        this.attachedSubtitleTracks.push({ element: track, url, source });
        if (selectTrack) {
            track.addEventListener('load', () => this.showTextTrack(track), { once: true });
            queueMicrotask(() => this.showTextTrack(track));
        }
        mlog(`subtitle track ${trackIndex ?? 'external'} attached as <track kind=${track.kind} lang=${track.srclang}>`);
    }
    removeSubtitleTracks(source) {
        const keep = [];
        for (const attached of this.attachedSubtitleTracks) {
            if (source && attached.source !== source) {
                keep.push(attached);
                continue;
            }
            attached.element.remove();
            URL.revokeObjectURL(attached.url);
        }
        this.attachedSubtitleTracks = keep;
    }
    showTextTrack(track) {
        for (let i = 0; i < this.video.textTracks.length; i++) {
            this.video.textTracks[i].mode = 'disabled';
        }
        track.track.mode = 'showing';
    }
    dispatchSubtitleStatus(message) {
        mlog(`subtitle-status: ${message}`);
        this.dispatchEvent(new CustomEvent('subtitle-status', { detail: { message } }));
    }
    requestEmbeddedSubtitleTrack(track) {
        const requestedAtMs = Date.now();
        this.subtitleRequestTimes.set(track.index, requestedAtMs);
        mlog(`requesting subtitle track=${track.index} lang=${track.language} codec=${track.codec}`);
        this.dispatchSubtitleStatus(`Subtitle track ${track.index}: ${track.language ?? '?'} ${track.codec} queued`);
        this.worker.postMessage({ type: 'subtitle', trackIndex: track.index, requestedAtMs });
    }
    handleWorkerSubtitleProgress(msg) {
        const info = this._subtitleTracks.find((track) => track.index === msg.trackIndex);
        this.dispatchSubtitleStatus(this.formatSubtitleProgress(info, msg));
    }
    formatSubtitleProgress(info, progress) {
        const lang = info?.language ?? '?';
        const prefix = `Subtitle track ${progress.trackIndex}: ${lang} ${progress.codec}`;
        const queueDelay = typeof progress.queueDelayMs === 'number' && progress.queueDelayMs >= 50
            ? ` after waiting ${formatElapsed(progress.queueDelayMs)}`
            : '';
        if (progress.phase === 'starting') {
            return `${prefix} started${queueDelay}`;
        }
        if (progress.phase === 'reading-cues') {
            return `${prefix} reading cues (${progress.cuesRead} read, ${formatElapsed(progress.elapsedMs)})${queueDelay}`;
        }
        if (progress.phase === 'exporting-text') {
            return `${prefix} exporting text (${progress.cuesRead} cues, ${formatElapsed(progress.elapsedMs)})`;
        }
        return `${prefix} processing (${progress.cuesRead} cues, ${formatElapsed(progress.elapsedMs)})`;
    }
    async extractEmbeddedSubtitlesFromDemux(demux, options = {}) {
        const subtitleTracks = demux.subtitleTracks;
        if (subtitleTracks.length === 0) {
            this.dispatchSubtitleStatus('No embedded subtitles');
            if (options.releaseAfterComplete && this._sourceDemux === demux) {
                this._sourceDemux.dispose();
                this._sourceDemux = null;
                this._source = null;
            }
            return;
        }
        this.dispatchSubtitleStatus(`Extracting ${subtitleTracks.length} subtitle track(s)...`);
        try {
            for (const track of subtitleTracks) {
                mlog(`extracting subtitle track=${track.index} lang=${track.language} codec=${track.codec}`);
                this.dispatchSubtitleStatus(`Subtitle track ${track.index}: ${track.language ?? '?'} ${track.codec} queued`);
                const data = await extractSubtitleData(demux.input, track.index, {
                    onProgress: (progress) => {
                        if (progress.phase === 'done') {
                            return;
                        }
                        this.dispatchSubtitleStatus(this.formatSubtitleProgress(track, progress));
                    },
                });
                const webvtt = subtitleDataToWebVTT(data);
                const cueMatch = webvtt.match(/\d\d:\d\d/g);
                const cueCount = cueMatch ? Math.floor(cueMatch.length / 2) : 0;
                this.dispatchSubtitleStatus(`Subtitle track ${track.index}: ${track.language ?? '?'} ${data.codec} ${cueCount} cues, ${webvtt.length} bytes`);
                this.addSubtitleTrack({
                    webvtt,
                    source: 'embedded',
                    trackIndex: track.index,
                    defaultTrack: this.shouldAutoSelectEmbeddedSubtitle(track.index),
                    selectTrack: this.shouldAutoSelectEmbeddedSubtitle(track.index),
                });
            }
        }
        catch (error) {
            this.dispatchSubtitleStatus(`Subtitle extraction failed: ${String(error)}`);
        }
        finally {
            if (options.releaseAfterComplete && this._sourceDemux === demux) {
                this._sourceDemux.dispose();
                this._sourceDemux = null;
                this._source = null;
            }
        }
    }
    restoreDefaultTextTrack() {
        const preferred = this.attachedSubtitleTracks.find((attached) => attached.element.default) ??
            this.attachedSubtitleTracks[0];
        if (!preferred)
            return;
        queueMicrotask(() => this.showTextTrack(preferred.element));
    }
    shouldAutoSelectEmbeddedSubtitle(trackIndex) {
        return this.options.embeddedSubtitlePolicy === 'auto' && trackIndex === 0;
    }
}
/** Set to true to bypass native playback and force the remux pipeline (for testing). */
const FORCE_REMUX = false;
function mlog(msg) {
    console.log(`[engine] ${msg}`);
}
function formatElapsed(ms) {
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${Math.round(ms)}ms`;
}
function makeStats() {
    const now = performance.now();
    return {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: now, first: now, end: now },
        parsing: { start: now, end: now },
        buffering: { start: now, first: now, end: now },
    };
}
function iso639_2to1(code) {
    const map = {
        eng: 'en',
        spa: 'es',
        fra: 'fr',
        deu: 'de',
        ita: 'it',
        por: 'pt',
        rus: 'ru',
        jpn: 'ja',
        kor: 'ko',
        zho: 'zh',
        ara: 'ar',
        hin: 'hi',
        nld: 'nl',
        swe: 'sv',
        pol: 'pl',
        tur: 'tr',
        vie: 'vi',
        tha: 'th',
        und: '',
    };
    return map[code] ?? code;
}
function normalizeSubtitleLanguageCode(code) {
    if (code.length === 2)
        return code;
    return iso639_2to1(code);
}
function languageLabel(langCode, trackIndex) {
    const names = {
        eng: 'English',
        spa: 'Spanish',
        fra: 'French',
        deu: 'German',
        ita: 'Italian',
        por: 'Portuguese',
        rus: 'Russian',
        jpn: 'Japanese',
        kor: 'Korean',
        zho: 'Chinese',
        ara: 'Arabic',
        hin: 'Hindi',
        nld: 'Dutch',
        swe: 'Swedish',
        pol: 'Polish',
        tur: 'Turkish',
        vie: 'Vietnamese',
        tha: 'Thai',
    };
    return names[langCode] ?? `Track ${trackIndex + 1}`;
}
//# sourceMappingURL=engine.js.map