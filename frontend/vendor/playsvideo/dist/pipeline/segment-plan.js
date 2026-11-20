const EPSILON_SEC = 1 / 1000;
/** 合成分段边界时末尾保留的最小余量（秒），避免产出取不到包的极短尾段 */
const MIN_TAIL_SEC = 0.2;
/**
 * [本地补丁] 为「没有关键帧可依」的源合成分段边界（纯音频容器）。
 *
 * 视频必须切在关键帧上，否则解码器缺参考帧；音频每一帧都自带完整编码
 * 状态，可以在任意包边界切开。纯音频容器（.m4a / .mp3 / .flac）没有
 * 视频关键帧，若直接把空数组交给 buildSegmentPlan，它会退化成
 * `[0, duration]` 两边界 → 整首歌变成一个 segment，seek 时要从头取整段。
 *
 * 这里按目标时长等距切（末段不足一个间隔时保留原值，由 buildSegmentPlan
 * 的收尾逻辑并入）。返回的边界与关键帧时间戳同构，可直接喂给
 * buildSegmentPlan。
 */
export function synthesizeSegmentBoundaries(durationSec, targetSegmentDurationSec) {
    const duration = Number(durationSec);
    const step = Math.max(EPSILON_SEC, Number(targetSegmentDurationSec) || 4);
    if (!Number.isFinite(duration) || duration <= 0) {
        return [0];
    }
    // 末尾留够 MIN_TAIL_SEC：否则 duration=20.017s 时会生成 20.0 这个边界，
    // 归一化后再补上 20.017，得到一个 0.017s 的尾段——它取不到任何音频包，
    // 会让 mux 抛「没有可封装的轨道」而整片失败。
    const boundaries = [0];
    for (let t = step; t <= duration - MIN_TAIL_SEC; t += step) {
        boundaries.push(t);
    }
    return boundaries;
}
export function normalizeKeyframeTimestamps(timestampsSec, durationSec) {
    const duration = Number(durationSec);
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`durationSec must be > 0 (received ${String(durationSec)})`);
    }
    const normalized = [...timestampsSec]
        .map(Number)
        .filter((v) => Number.isFinite(v) && v >= 0 && v <= duration + EPSILON_SEC)
        .map((v) => Math.max(0, Math.min(duration, v)))
        .sort((a, b) => a - b);
    if (!normalized.length) {
        normalized.unshift(0);
    }
    const deduped = [];
    for (const value of normalized) {
        if (!deduped.length || Math.abs(value - deduped[deduped.length - 1]) > EPSILON_SEC) {
            deduped.push(value);
        }
    }
    if (duration - deduped[deduped.length - 1] > EPSILON_SEC) {
        deduped.push(duration);
    }
    else {
        deduped[deduped.length - 1] = duration;
    }
    if (deduped.length < 2) {
        throw new Error('Not enough boundaries for segmentation.');
    }
    return deduped;
}
export function buildSegmentPlan(options) {
    const durationSec = Number(options.durationSec);
    const sequenceStart = Math.max(0, Math.floor(Number(options.sequenceStart) || 0));
    const targetSegmentDurationSec = Math.max(EPSILON_SEC, Number(options.targetSegmentDurationSec) || 4);
    const boundaries = normalizeKeyframeTimestamps(options.keyframeTimestampsSec, durationSec);
    const plan = [];
    let sequence = sequenceStart;
    let segmentStartSec = 0;
    let nextTargetCutSec = targetSegmentDurationSec;
    // Match FFmpeg HLS behavior: cut on the first keyframe at or after each
    // global hls_time boundary (4s, 8s, 12s, ...), not after each segment's
    // local elapsed duration.
    for (const boundarySec of boundaries) {
        if (boundarySec < nextTargetCutSec - EPSILON_SEC)
            continue;
        if (boundarySec <= segmentStartSec + EPSILON_SEC)
            continue;
        plan.push({
            sequence,
            uri: `seg-${sequence}.m4s`,
            startSec: segmentStartSec,
            durationSec: Math.max(EPSILON_SEC, boundarySec - segmentStartSec),
        });
        sequence += 1;
        segmentStartSec = boundarySec;
        nextTargetCutSec =
            (Math.floor((boundarySec + EPSILON_SEC) / targetSegmentDurationSec) + 1) *
                targetSegmentDurationSec;
    }
    if (durationSec > segmentStartSec + EPSILON_SEC) {
        plan.push({
            sequence,
            uri: `seg-${sequence}.m4s`,
            startSec: segmentStartSec,
            durationSec: Math.max(EPSILON_SEC, durationSec - segmentStartSec),
        });
    }
    return plan;
}
//# sourceMappingURL=segment-plan.js.map