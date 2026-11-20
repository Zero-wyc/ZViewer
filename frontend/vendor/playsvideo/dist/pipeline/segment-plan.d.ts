import type { PlannedSegment } from './types.js';
/**
 * [本地补丁] 为没有关键帧可依的源（纯音频容器）合成等距分段边界。
 */
export declare function synthesizeSegmentBoundaries(durationSec: number, targetSegmentDurationSec: number): number[];
export declare function normalizeKeyframeTimestamps(timestampsSec: number[], durationSec: number): number[];
export interface BuildSegmentPlanOptions {
    keyframeTimestampsSec: number[];
    durationSec: number;
    targetSegmentDurationSec?: number;
    sequenceStart?: number;
}
export declare function buildSegmentPlan(options: BuildSegmentPlanOptions): PlannedSegment[];
//# sourceMappingURL=segment-plan.d.ts.map