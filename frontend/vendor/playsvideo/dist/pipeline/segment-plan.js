const EPSILON_SEC = 1 / 1000;
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