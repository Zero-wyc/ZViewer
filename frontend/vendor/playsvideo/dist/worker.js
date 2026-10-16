import { WasmFfmpegRunner } from './adapters/wasm-ffmpeg.js';
import { buildTranscodeResultFromAdts, concatEncodedPacketData, createEmptyTranscodeResult, createLocalAudioTranscoder, makeAacDecoderConfig, } from './pipeline/audio-transcode.js';
import { audioNeedsTranscode, createBrowserProber } from './pipeline/codec-probe.js';
import { demuxBlob, demuxUrl, getKeyframeIndex } from './pipeline/demux.js';
import { buildMkvKeyframeIndexFromBlob, buildMkvKeyframeIndexFromUrl, } from './pipeline/mkv-keyframe-index.js';
import { generateVodPlaylist } from './pipeline/playlist.js';
import { buildSegmentPlan } from './pipeline/segment-plan.js';
import { processSegmentWithAbort } from './pipeline/segment-processor.js';
import { extractSubtitleData, subtitleDataToWebVTT, } from './pipeline/subtitle.js';
function wlog(msg) {
    console.log(`[worker] ${msg}`);
}
function elapsed(start) {
    return `${(performance.now() - start).toFixed(1)}ms`;
}
function makeAbortError() {
    return new DOMException('Segment aborted', 'AbortError');
}
function emitSegmentState(index, phase, opts = {}) {
    const msg = {
        type: 'segment-state',
        index,
        phase,
        ...opts,
    };
    self.postMessage(msg);
}
class TranscodePortPool {
    workers = [];
    queue = [];
    nextJobId = 0;
    fallbackTranscode;
    constructor(fallbackTranscode) {
        this.fallbackTranscode = fallbackTranscode;
    }
    addPort(id, port) {
        const entry = { id, port, currentJob: null };
        port.onmessage = (event) => {
            this.handleWorkerMessage(entry, event.data);
        };
        port.start?.();
        this.workers.push(entry);
        this.dispatch();
    }
    hasWorkers() {
        return this.workers.length > 0;
    }
    workerCount() {
        return this.workers.length;
    }
    transcode = async (opts, signal) => {
        if (opts.packets.length === 0) {
            return createEmptyTranscodeResult(opts.sampleRate);
        }
        if (signal?.aborted) {
            throw makeAbortError();
        }
        if (this.workers.length === 0) {
            return this.fallbackTranscode(opts, signal);
        }
        const startedAt = performance.now();
        const tConcat = performance.now();
        const input = concatEncodedPacketData(opts.packets);
        const concatMs = performance.now() - tConcat;
        return await new Promise((resolve, reject) => {
            const job = {
                id: ++this.nextJobId,
                opts,
                startedAt,
                concatMs,
                inputBytes: input.inputBytes,
                audioDurationSec: input.audioDurationSec,
                inputData: input.data,
                signal,
                settled: false,
                resolve,
                reject,
            };
            const abort = () => {
                if (job.settled) {
                    return;
                }
                job.settled = true;
                this.queue = this.queue.filter((queued) => queued !== job);
                reject(makeAbortError());
                this.dispatch();
            };
            if (signal) {
                job.onAbort = abort;
                signal.addEventListener('abort', abort, { once: true });
            }
            this.queue.push(job);
            this.dispatch();
        });
    };
    dispatch() {
        for (const worker of this.workers) {
            if (worker.currentJob !== null) {
                continue;
            }
            const job = this.queue.shift();
            if (!job) {
                return;
            }
            worker.currentJob = job;
            const transferData = new Uint8Array(job.inputData);
            const buffer = transferData.buffer;
            const msg = {
                type: 'transcode-job',
                jobId: job.id,
                inputData: buffer,
                sourceCodec: job.opts.sourceCodec,
            };
            worker.port.postMessage(msg, [buffer]);
        }
    }
    handleWorkerFailure(id, reason) {
        const index = this.workers.findIndex((worker) => worker.id === id);
        if (index === -1) {
            return;
        }
        const [worker] = this.workers.splice(index, 1);
        const activeJob = worker.currentJob;
        worker.currentJob = null;
        if (activeJob) {
            void this.recoverJob(activeJob, `Transcode worker ${id} failed: ${reason}`);
        }
        if (this.workers.length === 0 && this.queue.length > 0) {
            const queuedJobs = this.queue.splice(0);
            for (const job of queuedJobs) {
                void this.recoverJob(job, `Transcode workers unavailable: ${reason}`);
            }
            return;
        }
        this.dispatch();
    }
    handleWorkerMessage(worker, msg) {
        const job = worker.currentJob;
        worker.currentJob = null;
        if (!job) {
            this.dispatch();
            return;
        }
        if (job.signal && job.onAbort) {
            job.signal.removeEventListener('abort', job.onAbort);
        }
        if (!job.settled) {
            if (msg.type !== 'transcode-result' || msg.jobId !== job.id) {
                job.settled = true;
                job.reject(new Error(`Transcode worker ${worker.id} returned an unexpected job result`));
            }
            else if (!msg.ok) {
                job.settled = true;
                job.reject(new Error(msg.error));
            }
            else {
                job.settled = true;
                const aacData = new Uint8Array(msg.outputData);
                const result = buildTranscodeResultFromAdts({
                    inputPackets: job.opts.packets.length,
                    inputBytes: job.inputBytes,
                    audioDurationSec: job.audioDurationSec,
                    concatMs: job.concatMs,
                    sampleRate: job.opts.sampleRate,
                    audioStartSec: job.opts.audioStartSec,
                    aacData,
                    ffmpegMetrics: msg.metrics,
                    totalMs: performance.now() - job.startedAt,
                });
                job.resolve(result);
            }
        }
        this.dispatch();
    }
    async recoverJob(job, reason) {
        if (job.settled) {
            this.dispatch();
            return;
        }
        if (job.signal?.aborted) {
            if (job.signal && job.onAbort) {
                job.signal.removeEventListener('abort', job.onAbort);
            }
            job.settled = true;
            job.reject(makeAbortError());
            this.dispatch();
            return;
        }
        if (this.workers.length > 0) {
            this.queue.unshift(job);
            this.dispatch();
            return;
        }
        try {
            if (job.signal && job.onAbort) {
                job.signal.removeEventListener('abort', job.onAbort);
            }
            const result = await this.fallbackTranscode(job.opts, job.signal);
            if (!job.settled) {
                job.settled = true;
                job.resolve(result);
            }
        }
        catch (err) {
            if (!job.settled) {
                job.settled = true;
                const fallbackMessage = err instanceof Error ? err.message : String(err);
                job.reject(new Error(`${reason}; fallback transcode failed: ${fallbackMessage}`));
            }
        }
        finally {
            this.dispatch();
        }
    }
}
const ffmpeg = new WasmFfmpegRunner();
const codecProber = createBrowserProber();
const localAudioTranscoder = createLocalAudioTranscoder(ffmpeg);
const transcodePool = new TranscodePortPool(localAudioTranscoder);
let demux = null;
let plan = [];
let doTranscode = false;
let audioDecoderConfig = null;
let initSegment = null;
let currentBlob = null;
let currentUrl = null;
const segmentCache = new Map();
const segmentTasks = new Map();
let targetSegDuration = 4;
// Keep pipeline setup ordered, but let individual segment work run independently.
let pipelineSetup = Promise.resolve();
// Per-segment abort controllers for cancellation
const segmentAbortControllers = new Map();
self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'open') {
        wlog('recv open');
        targetSegDuration = msg.targetSegmentDuration ?? 4;
        currentBlob = msg.file;
        currentUrl = null;
        queuePipelineSetup(() => handleProbe(() => demuxBlob(msg.file)));
    }
    else if (msg.type === 'open-url') {
        wlog('recv open-url');
        targetSegDuration = msg.targetSegmentDuration ?? 4;
        currentBlob = null;
        currentUrl = msg.url;
        queuePipelineSetup(() => handleProbe(() => demuxUrl(msg.url)));
    }
    else if (msg.type === 'remux-pipeline') {
        wlog('recv remux-pipeline');
        queuePipelineSetup(() => handleRemuxPipeline(msg.keyframeIndex));
    }
    else if (msg.type === 'passthrough-pipeline') {
        wlog('recv passthrough-pipeline — subtitle-only mode');
    }
    else if (msg.type === 'transcode-port') {
        const portMsg = msg;
        const port = event.ports[0];
        if (port) {
            wlog(`recv transcode-port id=${portMsg.id}`);
            transcodePool.addPort(portMsg.id, port);
        }
    }
    else if (msg.type === 'transcode-worker-failed') {
        const reason = msg.message || 'Transcode worker crashed';
        wlog(`recv transcode-worker-failed id=${msg.id} reason=${reason}`);
        transcodePool.handleWorkerFailure(msg.id, reason);
    }
    else if (msg.type === 'segment') {
        wlog(`recv segment idx=${msg.index}`);
        void handleSegmentRequest(msg.index);
    }
    else if (msg.type === 'cancel') {
        const controller = segmentAbortControllers.get(msg.index);
        if (controller) {
            wlog(`cancel segment idx=${msg.index}`);
            controller.abort();
            segmentAbortControllers.delete(msg.index);
        }
    }
    else if (msg.type === 'subtitle') {
        wlog(`recv subtitle trackIndex=${msg.trackIndex}`);
        const queueDelayMs = typeof msg.requestedAtMs === 'number' ? Date.now() - msg.requestedAtMs : 0;
        handleSubtitle(msg.trackIndex, Math.max(0, queueDelayMs)).catch((err) => self.postMessage({ type: 'error', message: String(err) }));
    }
};
function queuePipelineSetup(task) {
    pipelineSetup = pipelineSetup.then(task).catch((err) => {
        self.postMessage({ type: 'error', message: String(err) });
    });
}
/**
 * [本地补丁] 长耗时阶段心跳：主线程在 probe/index/ffmpeg/seg0 等阶段
 * 收不到任何事件，无法区分「慢源正常处理中」与「源站死亡/处理停滞」。
 * 此包装在 await 期间每 3s 向主线程发一条 progress 心跳，供引擎派发
 * progress 事件，驱动上层的活动超时（有进展就不超时）与加载进度展示。
 */
const HEARTBEAT_INTERVAL_MS = 3000;
async function withHeartbeat(stage, fn) {
    const timer = setInterval(() => {
        self.postMessage({ type: 'progress', stage });
    }, HEARTBEAT_INTERVAL_MS);
    try {
        return await fn();
    }
    finally {
        clearInterval(timer);
    }
}
function makeProcessorConfig() {
    if (!demux) {
        throw new Error('No demux — handleProbe must run first');
    }
    return {
        videoSink: demux.videoSink,
        audioSink: demux.audioSink,
        videoCodec: demux.videoCodec,
        audioCodec: demux.audioCodec,
        videoDecoderConfig: demux.videoDecoderConfig,
        audioDecoderConfig,
        plan,
        doTranscode,
        transcodeAudio: transcodePool.hasWorkers() ? transcodePool.transcode : localAudioTranscoder,
        sourceCodec: demux.audioCodec ?? undefined,
        log: wlog,
    };
}
function shouldPrefetchSegments() {
    return doTranscode && transcodePool.workerCount() > 0;
}
function schedulePrefetch(startIndex) {
    if (!shouldPrefetchSegments()) {
        return;
    }
    const maxInFlight = transcodePool.workerCount();
    let nextIndex = startIndex;
    while (segmentTasks.size < maxInFlight && nextIndex < plan.length) {
        if (!segmentCache.has(nextIndex) && !segmentTasks.has(nextIndex)) {
            emitSegmentState(nextIndex, 'prefetching');
            void ensureSegmentTask(nextIndex).catch((err) => {
                emitSegmentState(nextIndex, 'error', { message: String(err) });
                self.postMessage({ type: 'error', message: String(err) });
            });
        }
        nextIndex += 1;
    }
}
async function ensureSegmentTask(index) {
    const cached = segmentCache.get(index);
    if (cached) {
        return cached;
    }
    const existing = segmentTasks.get(index);
    if (existing) {
        return existing;
    }
    const task = (async () => {
        const t0 = performance.now();
        emitSegmentState(index, 'processing');
        const result = await processSegmentWithAbort(makeProcessorConfig(), index);
        if (!initSegment && result.initSegment) {
            initSegment = result.initSegment;
            wlog(`init-segment captured size=${initSegment.byteLength}`);
        }
        const mediaData = result.mediaData;
        segmentCache.set(index, mediaData);
        emitSegmentState(index, 'ready', { sizeBytes: mediaData.byteLength });
        wlog(`seg ${index} done ${elapsed(t0)} size=${mediaData.byteLength}`);
        return mediaData;
    })().finally(() => {
        segmentTasks.delete(index);
    });
    segmentTasks.set(index, task);
    return task;
}
async function waitForSegment(index, signal) {
    if (signal?.aborted) {
        throw makeAbortError();
    }
    const task = ensureSegmentTask(index);
    if (!signal) {
        return task;
    }
    return await new Promise((resolve, reject) => {
        const abort = () => reject(makeAbortError());
        signal.addEventListener('abort', abort, { once: true });
        task
            .then(resolve)
            .catch(reject)
            .finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}
/** Phase 1: demux and send codec info to engine for passthrough decision. */
async function handleProbe(demuxFn) {
    if (demux) {
        demux.dispose();
    }
    const tDemux = performance.now();
    demux = await withHeartbeat('probe', demuxFn);
    wlog(`demux done ${elapsed(tDemux)} codec=${demux.videoCodec}/${demux.audioCodec} dur=${demux.duration.toFixed(1)}s`);
    // Send codec info so engine can check canPlayType on the main thread
    self.postMessage({
        type: 'probed',
        sourceVideoCodec: demux.videoCodec,
        sourceAudioCodec: demux.audioCodec,
        videoCodec: demux.videoDecoderConfig.codec,
        audioCodec: demux.audioDecoderConfig?.codec ?? null,
        durationSec: demux.duration,
        subtitleTracks: demux.subtitleTracks,
    });
}
/** Phase 2: full pipeline — engine told us native playback isn't possible. */
async function handleRemuxPipeline(prebuiltKeyframeIndex) {
    if (!demux)
        throw new Error('No demux — handleProbe must run first');
    const t0 = performance.now();
    let index;
    // [本地补丁] 本地构建的索引随 ready 消息回传主线程，供上层做 URL 级
    // 复用缓存（重载/切回同一影片时经 loadUrl 的 keyframeIndex 传入，
    // 跳过 Range 探测）。prebuilt 场景主线程本就持有，不回传。
    let builtKeyframeIndex = null;
    if (prebuiltKeyframeIndex) {
        index = prebuiltKeyframeIndex;
        wlog(`keyframe-index pre-built keyframes=${index.keyframes.length}`);
    }
    else {
        const tIndex = performance.now();
        const mkvIndex = currentBlob
            ? await withHeartbeat('index', () => buildMkvKeyframeIndexFromBlob(currentBlob, demux.videoTrack.id))
            : currentUrl
                ? await withHeartbeat('index', () => buildMkvKeyframeIndexFromUrl(currentUrl, demux.videoTrack.id))
                : null;
        if (mkvIndex) {
            index = mkvIndex;
            wlog(`mkv-cues done ${elapsed(tIndex)} keyframes=${index.keyframes.length}`);
        }
        else {
            index = await withHeartbeat('index', () => getKeyframeIndex(demux.videoSink, demux.duration));
            wlog(`keyframe-index done ${elapsed(tIndex)} keyframes=${index.keyframes.length}`);
        }
        builtKeyframeIndex = index;
    }
    const tPlan = performance.now();
    plan = buildSegmentPlan({
        keyframeTimestampsSec: index.keyframes.map((k) => k.timestamp),
        durationSec: index.duration,
        targetSegmentDurationSec: targetSegDuration,
    });
    wlog(`segment-plan done ${elapsed(tPlan)} segments=${plan.length}`);
    doTranscode =
        demux.audioCodec !== null &&
            audioNeedsTranscode(codecProber, demux.audioCodec, demux.audioDecoderConfig?.codec);
    if (doTranscode && demux.audioCodec && !transcodePool.hasWorkers()) {
        await withHeartbeat('ffmpeg', () => ffmpeg.loadForCodec(demux.audioCodec));
    }
    audioDecoderConfig = doTranscode
        ? makeAacDecoderConfig(demux.audioDecoderConfig)
        : demux.audioDecoderConfig;
    initSegment = null;
    segmentCache.clear();
    segmentTasks.clear();
    const playlist = generateVodPlaylist({
        targetDuration: Math.ceil(Math.max(...plan.map((s) => s.durationSec))),
        mediaSequence: 0,
        mapUri: 'init.mp4',
        entries: plan.map((s) => ({ uri: `seg-${s.sequence}.m4s`, durationSec: s.durationSec })),
        endList: true,
    });
    const tSeg0 = performance.now();
    const seg0Result = await withHeartbeat('seg0', () => processSegmentWithAbort(makeProcessorConfig(), 0));
    segmentCache.set(0, seg0Result.mediaData);
    if (seg0Result.initSegment) {
        initSegment = seg0Result.initSegment;
        wlog(`init-segment captured size=${initSegment.byteLength}`);
    }
    wlog(`seg0 preprocess done ${elapsed(tSeg0)}`);
    wlog(`pipeline complete ${elapsed(t0)} total`);
    self.postMessage({
        type: 'ready',
        playlist,
        initData: initSegment.buffer,
        totalSegments: plan.length,
        durationSec: demux.duration,
        sourceVideoCodec: demux.videoCodec,
        sourceVideoCodecFull: demux.videoDecoderConfig.codec,
        sourceAudioCodec: demux.audioCodec,
        sourceAudioCodecFull: demux.audioDecoderConfig?.codec ?? null,
        outputVideoCodec: demux.videoCodec,
        outputVideoCodecFull: demux.videoDecoderConfig.codec,
        outputAudioCodec: doTranscode ? 'aac' : demux.audioCodec,
        outputAudioCodecFull: audioDecoderConfig?.codec ?? null,
        subtitleTracks: demux.subtitleTracks,
        keyframeIndex: builtKeyframeIndex,
    }, { transfer: [] }); // don't transfer initData — we need to keep it
    schedulePrefetch(1);
}
async function handleSegmentRequest(index) {
    const controller = new AbortController();
    segmentAbortControllers.set(index, controller);
    emitSegmentState(index, 'queued');
    try {
        await pipelineSetup;
        await handleSegment(index, controller.signal);
    }
    catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            emitSegmentState(index, 'aborted');
            wlog(`seg ${index} aborted`);
            return;
        }
        emitSegmentState(index, 'error', { message: String(err) });
        self.postMessage({ type: 'error', message: String(err) });
    }
    finally {
        segmentAbortControllers.delete(index);
    }
}
async function handleSegment(index, signal) {
    if (!demux || index >= plan.length) {
        self.postMessage({ type: 'error', message: `Invalid segment index: ${index}` });
        return;
    }
    // Return cached segment if available (segment 0 is pre-processed during open)
    const cached = segmentCache.get(index);
    if (cached) {
        segmentCache.delete(index);
        emitSegmentState(index, 'cache-hit', { sizeBytes: cached.byteLength });
        wlog(`seg ${index} cache-hit size=${cached.byteLength}`);
        const buffer = cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength);
        self.postMessage({ type: 'segment', index, data: buffer }, { transfer: [buffer] });
        return;
    }
    try {
        const mediaData = await waitForSegment(index, signal);
        const buffer = mediaData.buffer.slice(mediaData.byteOffset, mediaData.byteOffset + mediaData.byteLength);
        self.postMessage({ type: 'segment', index, data: buffer }, { transfer: [buffer] });
        segmentCache.delete(index);
        schedulePrefetch(index + 1);
    }
    catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            emitSegmentState(index, 'aborted');
            wlog(`seg ${index} aborted during processing`);
            return;
        }
        emitSegmentState(index, 'error', { message: String(err) });
        throw err;
    }
}
function emitSubtitleProgress(trackIndex, progress, queueDelayMs = 0) {
    if (progress.phase === 'done') {
        return;
    }
    const message = {
        type: 'subtitle-progress',
        trackIndex,
        phase: progress.phase,
        codec: progress.codec,
        cuesRead: progress.cuesRead,
        elapsedMs: progress.elapsedMs,
        queueDelayMs,
    };
    self.postMessage(message);
}
async function handleSubtitle(trackIndex, queueDelayMs = 0) {
    if (!demux) {
        self.postMessage({ type: 'error', message: 'No file open' });
        return;
    }
    const t0 = performance.now();
    let hasSentStart = false;
    const data = await extractSubtitleData(demux.input, trackIndex, {
        onProgress(progress) {
            emitSubtitleProgress(trackIndex, progress, hasSentStart ? 0 : queueDelayMs);
            hasSentStart = true;
        },
    });
    const webvtt = subtitleDataToWebVTT(data);
    wlog(`subtitle track=${trackIndex} cues=${data.cues.length} codec=${data.codec} ${elapsed(t0)}`);
    self.postMessage({ type: 'subtitle', trackIndex, webvtt, codec: data.codec });
}
//# sourceMappingURL=worker.js.map