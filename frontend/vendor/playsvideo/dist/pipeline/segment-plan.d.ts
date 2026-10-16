import type { PlannedSegment } from './types.js';
export declare function normalizeKeyframeTimestamps(timestampsSec: number[], durationSec: number): number[];
export interface BuildSegmentPlanOptions {
    keyframeTimestampsSec: number[];
    durationSec: number;
    targetSegmentDurationSec?: number;
    sequenceStart?: number;
}
export declare function buildSegmentPlan(options: BuildSegmentPlanOptions): PlannedSegment[];
//# sourceMappingURL=segment-plan.d.ts.map