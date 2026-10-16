import { EncodedPacket } from 'mediabunny';
import { parseAdtsFrames } from './adts-parse.js';
const SAMPLES_PER_AAC_FRAME = 1024;
const DEFAULT_OUTPUT_SAMPLE_RATE = 48000;
const DEFAULT_OUTPUT_CHANNELS = 2;
const runnerLocks = new WeakMap();
let transcodeJobCounter = 0;
/** Map short codec names to ffmpeg input format (-f) flags. */
const INPUT_FORMAT = {
    ac3: 'ac3',
    eac3: 'eac3',
    dts: 'dts',
    mp3: 'mp3',
    flac: 'flac',
    opus: 'ogg',
};
export function makeAacDecoderConfig(sourceConfig) {
    return {
        codec: 'mp4a.40.2',
        numberOfChannels: DEFAULT_OUTPUT_CHANNELS,
        sampleRate: sourceConfig?.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE,
    };
}
/** Parse ffmpeg's final stats line for speed and time values. */
function parseFfmpegStats(stderr) {
    const speedMatch = stderr.match(/speed=\s*([\d.]+)x/);
    const timeMatch = stderr.match(/time=(\d+):(\d+):([\d.]+)/);
    return {
        speed: speedMatch ? Number.parseFloat(speedMatch[1]) : null,
        timeMs: timeMatch
            ? (Number.parseInt(timeMatch[1], 10) * 3600 +
                Number.parseInt(timeMatch[2], 10) * 60 +
                Number.parseFloat(timeMatch[3])) *
                1000
            : null,
    };
}
function now() {
    return performance.now();
}
function nextTranscodeJobId() {
    transcodeJobCounter += 1;
    return transcodeJobCounter;
}
function getRunnerLockState(runner) {
    let state = runnerLocks.get(runner);
    if (!state) {
        state = { tail: Promise.resolve() };
        runnerLocks.set(runner, state);
    }
    return state;
}
async function withRunnerLock(runner, fn) {
    const state = getRunnerLockState(runner);
    const previous = state.tail;
    let release;
    state.tail = new Promise((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await fn();
    }
    finally {
        release();
    }
}
export function createLocalAudioTranscoder(ffmpeg) {
    return (opts) => transcodeAudioSegment({ ...opts, ffmpeg });
}
export function createEmptyTranscodeResult(sampleRate) {
    return {
        packets: [],
        decoderConfig: makeAacDecoderConfig({
            codec: 'mp4a.40.2',
            numberOfChannels: DEFAULT_OUTPUT_CHANNELS,
            sampleRate,
        }),
        metrics: {
            inputPackets: 0,
            inputBytes: 0,
            audioDurationSec: 0,
            concatMs: 0,
            writeMs: 0,
            ffmpegMs: 0,
            readMs: 0,
            cleanupMs: 0,
            parseMs: 0,
            totalMs: 0,
            outputPackets: 0,
            outputBytes: 0,
            outputDurationSec: 0,
            ffmpegSpeed: null,
            ffmpegTimeMs: null,
            realtimeRatio: 0,
        },
    };
}
export function concatEncodedPacketData(packets) {
    const inputBytes = packets.reduce((sum, p) => sum + p.data.byteLength, 0);
    const data = new Uint8Array(inputBytes);
    let offset = 0;
    for (const pkt of packets) {
        data.set(pkt.data, offset);
        offset += pkt.data.byteLength;
    }
    const firstPkt = packets[0];
    const lastPkt = packets[packets.length - 1];
    const audioDurationSec = lastPkt.timestamp + lastPkt.duration - firstPkt.timestamp;
    return { data, inputBytes, audioDurationSec };
}
export function packetsFromAdtsData(aacData, sampleRate, audioStartSec) {
    const tParse = now();
    const frames = parseAdtsFrames(aacData);
    // Native FFmpeg AAC adds 1024 priming samples for every independent job.
    // ADTS cannot carry skip_samples; discard that frame rather than placing
    // its silence at the original packet time (a fresh delay at every cut).
    const outputRate = frames[0]?.sampleRate ?? sampleRate;
    const frameDuration = SAMPLES_PER_AAC_FRAME / outputRate;
    const packets = frames.slice(1).map((frame, i) => {
        const pkt = new EncodedPacket(frame.data, 'key', // all AAC frames are keyframes
        audioStartSec + i * frameDuration, frameDuration, i);
        return pkt;
    });
    const parseMs = now() - tParse;
    return {
        packets,
        decoderConfig: {
            codec: 'mp4a.40.2', // AAC-LC
            numberOfChannels: frames[0]?.channels ?? DEFAULT_OUTPUT_CHANNELS,
            sampleRate: frames[0]?.sampleRate ?? sampleRate,
        },
        parseMs,
        outputBytes: aacData.byteLength,
        outputDurationSec: packets.length * frameDuration,
    };
}
export function buildTranscodeResultFromAdts(params) {
    const parsed = packetsFromAdtsData(params.aacData, params.sampleRate, params.audioStartSec);
    const metrics = {
        inputPackets: params.inputPackets,
        inputBytes: params.inputBytes,
        audioDurationSec: params.audioDurationSec,
        concatMs: params.concatMs,
        writeMs: params.ffmpegMetrics.writeMs,
        ffmpegMs: params.ffmpegMetrics.ffmpegMs,
        readMs: params.ffmpegMetrics.readMs,
        cleanupMs: params.ffmpegMetrics.cleanupMs,
        parseMs: parsed.parseMs,
        totalMs: params.totalMs,
        outputPackets: parsed.packets.length,
        outputBytes: parsed.outputBytes,
        outputDurationSec: parsed.outputDurationSec,
        ffmpegSpeed: params.ffmpegMetrics.ffmpegSpeed,
        ffmpegTimeMs: params.ffmpegMetrics.ffmpegTimeMs,
        realtimeRatio: params.audioDurationSec > 0 ? params.totalMs / (params.audioDurationSec * 1000) : 0,
    };
    return {
        packets: parsed.packets,
        decoderConfig: parsed.decoderConfig,
        metrics,
    };
}
export async function runFfmpegAudioTranscode(opts) {
    const codec = opts.sourceCodec ?? 'ac3';
    const inputFormat = INPUT_FORMAT[codec] ?? codec;
    const jobId = nextTranscodeJobId();
    const inputName = `transcode-input-${jobId}.${inputFormat}`;
    const outputName = `transcode-output-${jobId}.aac`;
    let writeMs = 0;
    let ffmpegMs = 0;
    let readMs = 0;
    let cleanupMs = 0;
    let ffmpegSpeed = null;
    let ffmpegTimeMs = null;
    let aacData = new Uint8Array(0);
    await withRunnerLock(opts.ffmpeg, async () => {
        try {
            const tWrite = now();
            await opts.ffmpeg.writeInput(inputName, opts.inputData);
            writeMs = now() - tWrite;
            const tFfmpeg = now();
            const result = await opts.ffmpeg.run([
                '-hide_banner',
                '-loglevel',
                'info',
                '-f',
                inputFormat,
                '-i',
                inputName,
                '-c:a',
                'aac',
                '-ac',
                String(DEFAULT_OUTPUT_CHANNELS),
                '-b:a',
                '160k',
                '-f',
                'adts',
                '-y',
                outputName,
            ]);
            ffmpegMs = now() - tFfmpeg;
            if (result.exitCode !== 0) {
                throw new Error(`Audio transcode failed: ${result.stderr}`);
            }
            ({ speed: ffmpegSpeed, timeMs: ffmpegTimeMs } = parseFfmpegStats(result.stderr));
            const tRead = now();
            aacData = await opts.ffmpeg.readOutput(outputName);
            readMs = now() - tRead;
        }
        finally {
            const tCleanup = now();
            await opts.ffmpeg.deleteFile?.(inputName);
            await opts.ffmpeg.deleteFile?.(outputName);
            cleanupMs = now() - tCleanup;
        }
    });
    return {
        aacData,
        metrics: {
            writeMs,
            ffmpegMs,
            readMs,
            cleanupMs,
            ffmpegSpeed,
            ffmpegTimeMs,
        },
    };
}
export async function transcodeAudioSegment(opts) {
    if (opts.packets.length === 0) {
        return createEmptyTranscodeResult(opts.sampleRate);
    }
    const tTotal = now();
    const tConcat = now();
    const input = concatEncodedPacketData(opts.packets);
    const concatMs = now() - tConcat;
    const raw = await runFfmpegAudioTranscode({
        ffmpeg: opts.ffmpeg,
        inputData: input.data,
        sourceCodec: opts.sourceCodec,
    });
    return buildTranscodeResultFromAdts({
        inputPackets: opts.packets.length,
        inputBytes: input.inputBytes,
        audioDurationSec: input.audioDurationSec,
        concatMs,
        sampleRate: opts.sampleRate,
        audioStartSec: opts.audioStartSec,
        aacData: raw.aacData,
        ffmpegMetrics: raw.metrics,
        totalMs: now() - tTotal,
    });
}
//# sourceMappingURL=audio-transcode.js.map