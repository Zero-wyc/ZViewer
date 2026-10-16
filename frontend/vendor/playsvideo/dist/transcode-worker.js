import { WasmFfmpegRunner } from './adapters/wasm-ffmpeg.js';
import { runFfmpegAudioTranscode } from './pipeline/audio-transcode.js';
const ffmpeg = new WasmFfmpegRunner();
let port = null;
const state = {
    phase: 'starting',
    sourceCodec: null,
    jobId: null,
    inputBytes: null,
    outputBytes: null,
    totalMs: null,
    ffmpegMs: null,
    jobsCompleted: 0,
    lastError: null,
};
function publishState() {
    const message = {
        type: 'worker-state',
        state: { ...state },
    };
    self.postMessage(message);
}
function updateState(patch) {
    Object.assign(state, patch);
    publishState();
}
self.onmessage = (event) => {
    if (event.data?.type !== 'connect' || event.ports.length === 0) {
        return;
    }
    port = event.ports[0];
    port.onmessage = (messageEvent) => {
        void handleJob(messageEvent.data);
    };
    port.start?.();
    updateState({ phase: 'idle', lastError: null });
};
async function handleJob(msg) {
    if (!port || msg.type !== 'transcode-job') {
        return;
    }
    const startedAt = performance.now();
    updateState({
        phase: msg.sourceCodec ? 'loading-codec' : 'transcoding',
        sourceCodec: msg.sourceCodec ?? state.sourceCodec,
        jobId: msg.jobId,
        inputBytes: msg.inputData.byteLength,
        outputBytes: null,
        totalMs: null,
        ffmpegMs: null,
        lastError: null,
    });
    try {
        if (msg.sourceCodec) {
            await ffmpeg.loadForCodec(msg.sourceCodec);
            updateState({ phase: 'transcoding' });
        }
        const result = await runFfmpegAudioTranscode({
            ffmpeg,
            inputData: new Uint8Array(msg.inputData),
            sourceCodec: msg.sourceCodec,
        });
        const outputData = new Uint8Array(result.aacData);
        const outputBuffer = outputData.buffer;
        const response = {
            type: 'transcode-result',
            jobId: msg.jobId,
            ok: true,
            outputData: outputBuffer,
            metrics: result.metrics,
        };
        port.postMessage(response, [outputBuffer]);
        updateState({
            phase: 'idle',
            sourceCodec: msg.sourceCodec ?? state.sourceCodec,
            jobId: null,
            outputBytes: result.aacData.byteLength,
            totalMs: performance.now() - startedAt,
            ffmpegMs: result.metrics.ffmpegMs,
            jobsCompleted: state.jobsCompleted + 1,
            lastError: null,
        });
    }
    catch (err) {
        const response = {
            type: 'transcode-result',
            jobId: msg.jobId,
            ok: false,
            error: String(err),
        };
        port.postMessage(response);
        updateState({
            phase: 'error',
            sourceCodec: msg.sourceCodec ?? state.sourceCodec,
            jobId: null,
            outputBytes: null,
            totalMs: performance.now() - startedAt,
            ffmpegMs: null,
            lastError: String(err),
        });
    }
}
//# sourceMappingURL=transcode-worker.js.map