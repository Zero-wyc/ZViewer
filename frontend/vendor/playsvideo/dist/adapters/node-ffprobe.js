import { execFile } from 'node:child_process';
export class NodeFfprobeRunner {
    ffprobePath;
    constructor(ffprobePath = 'ffprobe') {
        this.ffprobePath = ffprobePath;
    }
    async probe(inputPath) {
        const stdout = await this.execJson([
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_streams',
            '-show_format',
            inputPath,
        ]);
        const data = JSON.parse(stdout);
        const streams = (data.streams || []).map((s) => ({
            index: s.index,
            codecType: s.codec_type,
            codecName: s.codec_name,
            width: s.width,
            height: s.height,
            sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : undefined,
            channels: s.channels,
            duration: s.duration ? parseFloat(s.duration) : undefined,
        }));
        return {
            format: data.format?.format_name ?? 'unknown',
            duration: parseFloat(data.format?.duration ?? '0'),
            bitRate: data.format?.bit_rate ? parseFloat(data.format.bit_rate) : undefined,
            streams,
        };
    }
    async verifyDecodable(inputPath, ffmpegPath = 'ffmpeg') {
        return new Promise((resolve) => {
            execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'null', '-'], { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
                resolve({ ok: !error, stderr: stderr || '' });
            });
        });
    }
    execJson(args) {
        return new Promise((resolve, reject) => {
            execFile(this.ffprobePath, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`ffprobe failed: ${stderr || error.message}`));
                }
                else {
                    resolve(stdout);
                }
            });
        });
    }
}
//# sourceMappingURL=node-ffprobe.js.map