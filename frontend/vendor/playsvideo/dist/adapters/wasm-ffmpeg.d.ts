import type { FfmpegRunner } from '../pipeline/types.js';
export type FfmpegTier = 'audio' | 'full';
export declare function tierForCodec(codec: string): FfmpegTier;
export declare class WasmFfmpegRunner implements FfmpegRunner {
    private tier;
    /**
     * Pre-load the smallest sufficient bundle for the given audio codec.
     * Call before the first run() to avoid loading the full 32 MB bundle
     * when only audio transcode is needed.
     */
    loadForCodec(codec: string): Promise<void>;
    private getCore;
    writeInput(name: string, data: Uint8Array): Promise<void>;
    readOutput(name: string): Promise<Uint8Array>;
    deleteFile(name: string): Promise<void>;
    run(args: string[]): Promise<{
        exitCode: number;
        stderr: string;
    }>;
}
//# sourceMappingURL=wasm-ffmpeg.d.ts.map