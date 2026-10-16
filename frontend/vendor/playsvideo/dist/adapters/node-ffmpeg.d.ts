import type { FfmpegRunner } from '../pipeline/types.js';
export declare class NodeFfmpegRunner implements FfmpegRunner {
    private ffmpegPath;
    private dir;
    constructor(dir: string, ffmpegPath?: string);
    writeInput(name: string, data: Uint8Array): Promise<void>;
    readOutput(name: string): Promise<Uint8Array>;
    deleteFile(name: string): Promise<void>;
    run(args: string[]): Promise<{
        exitCode: number;
        stderr: string;
    }>;
}
export declare function makeTempDir(prefix?: string): Promise<string>;
//# sourceMappingURL=node-ffmpeg.d.ts.map