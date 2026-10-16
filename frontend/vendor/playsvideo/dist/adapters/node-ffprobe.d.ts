import type { ProbeResult } from '../pipeline/types.js';
export declare class NodeFfprobeRunner {
    private ffprobePath;
    constructor(ffprobePath?: string);
    probe(inputPath: string): Promise<ProbeResult>;
    verifyDecodable(inputPath: string, ffmpegPath?: string): Promise<{
        ok: boolean;
        stderr: string;
    }>;
    private execJson;
}
//# sourceMappingURL=node-ffprobe.d.ts.map