import { execFile } from 'node:child_process';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export class NodeFfmpegRunner {
    ffmpegPath;
    dir;
    constructor(dir, ffmpegPath = 'ffmpeg') {
        this.dir = dir;
        this.ffmpegPath = ffmpegPath;
    }
    async writeInput(name, data) {
        await writeFile(join(this.dir, name), data);
    }
    async readOutput(name) {
        return new Uint8Array(await readFile(join(this.dir, name)));
    }
    async deleteFile(name) {
        await unlink(join(this.dir, name)).catch(() => { });
    }
    async run(args) {
        return new Promise((resolve) => {
            execFile(this.ffmpegPath, args, { maxBuffer: 100 * 1024 * 1024, cwd: this.dir }, (error, _stdout, stderr) => {
                resolve({
                    exitCode: error?.code !== undefined ? (typeof error.code === 'number' ? error.code : 1) : 0,
                    stderr: stderr || '',
                });
            });
        });
    }
}
export async function makeTempDir(prefix = 'playsvideo-') {
    return mkdtemp(join(tmpdir(), prefix));
}
//# sourceMappingURL=node-ffmpeg.js.map