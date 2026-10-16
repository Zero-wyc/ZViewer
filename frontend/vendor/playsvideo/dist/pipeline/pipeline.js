import { transcodeAudioSegment } from './audio-transcode.js';
import { audioNeedsTranscode, createNodeProber } from './codec-probe.js';
import { collectPacketsInRange, demuxFile, getKeyframeIndex } from './demux.js';
import { muxToFmp4 } from './mux.js';
import { generateVodPlaylist } from './playlist.js';
import { buildSegmentPlan } from './segment-plan.js';
export async function runPipeline(opts) {
    const targetDuration = opts.targetSegmentDuration ?? 4;
    const prober = opts.codecProber ?? createNodeProber();
    // 1. Demux
    const demux = await demuxFile(opts.filePath);
    try {
        // 2. Keyframe index
        const index = await getKeyframeIndex(demux.videoSink, demux.duration);
        // 3. Segment plan
        const plan = buildSegmentPlan({
            keyframeTimestampsSec: index.keyframes.map((k) => k.timestamp),
            durationSec: index.duration,
            targetSegmentDurationSec: targetDuration,
        });
        const doTranscode = demux.audioCodec !== null &&
            audioNeedsTranscode(prober, demux.audioCodec, demux.audioDecoderConfig?.codec);
        const outputAudioCodec = doTranscode ? 'aac' : (demux.audioCodec ?? 'aac');
        // For transcoded audio, we'll build a new AudioDecoderConfig from the AAC output.
        // For passthrough, use the original config.
        let audioDecoderConfig = demux.audioDecoderConfig;
        let init = null;
        const segments = [];
        // 4. Process each segment
        for (const seg of plan) {
            const endSec = seg.startSec + seg.durationSec;
            // Extract packets for this segment
            const videoPackets = await collectPacketsInRange(demux.videoSink, seg.startSec, endSec, {
                startFromKeyframe: true,
            });
            let audioPackets = demux.audioSink
                ? await collectPacketsInRange(demux.audioSink, seg.startSec, endSec)
                : [];
            // Transcode audio if needed
            if (doTranscode && audioPackets.length > 0) {
                const sampleRate = demux.audioDecoderConfig?.sampleRate ?? 48000;
                const transcoded = await transcodeAudioSegment({
                    packets: audioPackets,
                    sampleRate,
                    audioStartSec: audioPackets[0].timestamp,
                    ffmpeg: opts.ffmpeg,
                    sourceCodec: demux.audioCodec ?? undefined,
                });
                audioPackets = transcoded.packets;
                if (!audioDecoderConfig || audioDecoderConfig.codec !== 'mp4a.40.2') {
                    audioDecoderConfig = transcoded.decoderConfig;
                }
            }
            // Mux to fMP4
            const muxResult = await muxToFmp4({
                videoPackets,
                audioPackets,
                videoCodec: demux.videoCodec,
                audioCodec: outputAudioCodec,
                videoDecoderConfig: demux.videoDecoderConfig,
                audioDecoderConfig,
            });
            // Keep the first init segment
            if (!init) {
                init = muxResult.init;
            }
            // Concatenate all media fragments for this segment
            const mediaData = concatBuffers(muxResult.media);
            segments.push({
                index: seg.sequence,
                data: mediaData,
                durationSec: seg.durationSec,
                startSec: seg.startSec,
            });
        }
        if (!init) {
            throw new Error('No segments produced');
        }
        // 5. Generate playlist
        const maxDuration = Math.ceil(Math.max(...plan.map((s) => s.durationSec)));
        const playlist = generateVodPlaylist({
            targetDuration: maxDuration,
            mediaSequence: 0,
            mapUri: 'init.mp4',
            entries: segments.map((s) => ({
                uri: `seg-${s.index}.m4s`,
                durationSec: s.durationSec,
            })),
            endList: true,
        });
        return {
            init,
            segments,
            playlist,
            totalDurationSec: demux.duration,
        };
    }
    finally {
        demux.dispose();
    }
}
function concatBuffers(arrays) {
    const totalLength = arrays.reduce((sum, a) => sum + a.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.byteLength;
    }
    return result;
}
//# sourceMappingURL=pipeline.js.map