import { collectPacketsInRange } from './demux.js';
import { muxToFmp4 } from './mux.js';
import { checkAbort } from './source-signal.js';
function elapsed(start) {
    return `${(performance.now() - start).toFixed(1)}ms`;
}
/**
 * Processes a single segment through the pipeline: collect packets → transcode → mux.
 *
 * Accepts an AbortSignal and checks it between stages. If aborted, throws AbortError.
 * Does NOT modify any shared mutable state — returns all results.
 */
export async function processSegmentWithAbort(config, index, signal) {
    const log = config.log ?? (() => { });
    const seg = config.plan[index];
    if (!seg)
        throw new Error(`Invalid segment index: ${index}`);
    const endSec = seg.startSec + seg.durationSec;
    log(`seg ${index} start range=[${seg.startSec.toFixed(2)},${endSec.toFixed(2)})`);
    checkAbort(signal);
    // Stage 1: Collect video packets
    const tVid = performance.now();
    const videoPackets = await collectPacketsInRange(config.videoSink, seg.startSec, endSec, {
        startFromKeyframe: true,
    });
    log(`seg ${index} video-collect ${elapsed(tVid)} pkts=${videoPackets.length}`);
    checkAbort(signal);
    // Stage 2: Collect audio packets
    const tAud = performance.now();
    let audioPackets = config.audioSink
        ? await collectPacketsInRange(config.audioSink, seg.startSec, endSec)
        : [];
    log(`seg ${index} audio-collect ${elapsed(tAud)} pkts=${audioPackets.length}`);
    checkAbort(signal);
    // Stage 3: Transcode audio if needed (slow — ffmpeg.wasm)
    let audioDecoderConfig = config.audioDecoderConfig;
    if (config.doTranscode && audioPackets.length > 0) {
        const sampleRate = config.audioDecoderConfig?.sampleRate ?? 48000;
        const transcoded = await config.transcodeAudio({
            packets: audioPackets,
            sampleRate,
            audioStartSec: audioPackets[0].timestamp,
            sourceCodec: config.sourceCodec,
        }, signal);
        const m = transcoded.metrics;
        const speed = m.ffmpegSpeed !== null ? ` speed=${m.ffmpegSpeed}x` : '';
        log(`seg ${index} transcode ${m.totalMs.toFixed(1)}ms audio=${m.audioDurationSec.toFixed(2)}s ratio=${m.realtimeRatio.toFixed(4)}x ffmpeg=${m.ffmpegMs.toFixed(1)}ms${speed}`);
        audioPackets = transcoded.packets;
        // Encoder flush padding must not spill into the following segment.
        const audioEndSec = transcoded.metrics.audioDurationSec + audioPackets[0]?.timestamp;
        audioPackets = audioPackets.filter(p => p.timestamp < Math.min(endSec, audioEndSec) - 1e-7);
        if (!audioDecoderConfig || audioDecoderConfig.codec !== 'mp4a.40.2') {
            audioDecoderConfig = transcoded.decoderConfig;
        }
    }
    checkAbort(signal);
    // Stage 4: Mux to fMP4 (fast)
    const tMux = performance.now();
    const muxResult = await muxToFmp4({
        videoPackets,
        audioPackets,
        videoCodec: config.videoCodec,
        audioCodec: config.doTranscode ? 'aac' : (config.audioCodec ?? 'aac'),
        videoDecoderConfig: config.videoDecoderConfig,
        audioDecoderConfig,
    });
    log(`seg ${index} mux ${elapsed(tMux)}`);
    // Concatenate media fragments
    const totalLen = muxResult.media.reduce((s, c) => s + c.byteLength, 0);
    const mediaData = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of muxResult.media) {
        mediaData.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return {
        mediaData,
        initSegment: muxResult.init,
        audioDecoderConfig,
    };
}
//# sourceMappingURL=segment-processor.js.map