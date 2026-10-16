// Audio-only bundle (~1.5 MB) — AC3/EAC3/DTS/MP3/FLAC/Opus decode → AAC encode
// Uses new URL(..., import.meta.url) so any bundler (Vite, Webpack, Rollup, esbuild) can resolve it.
const audioJsUrl = new URL('../vendor/ffmpeg-core-audio/ffmpeg-core.js', import.meta.url).href;
const audioWasmUrl = new URL('../vendor/ffmpeg-core-audio/ffmpeg-core.wasm', import.meta.url).href;
/** Full tier is not currently used — reserved for future video transcode support. */
const FULL_TIER_ENABLED = false;
/** Codecs the minimal audio bundle can handle (all decoders built into ffmpeg-core-audio). */
const AUDIO_TIER_CODECS = new Set(['ac3', 'eac3', 'dts', 'mp3', 'flac', 'opus']);
const TIER_URLS = {
    audio: { coreURL: audioJsUrl, wasmURL: audioWasmUrl },
};
let coreModule = null;
let loadedTier = null;
let loadPromise = null;
let pendingTier = null;
/** Full is a superset of audio — never downgrade. */
const TIER_RANK = { audio: 0, full: 1 };
async function ensureTier(tier) {
    if (tier === 'full' && !FULL_TIER_ENABLED) {
        throw new Error('Full ffmpeg tier is not currently enabled — only audio transcode is supported');
    }
    // Already loaded a sufficient tier
    if (coreModule && loadedTier !== null && TIER_RANK[loadedTier] >= TIER_RANK[tier]) {
        return coreModule;
    }
    // Already loading a sufficient tier
    if (loadPromise && pendingTier !== null && TIER_RANK[pendingTier] >= TIER_RANK[tier]) {
        return loadPromise;
    }
    // Wait for any in-progress load before upgrading
    if (loadPromise) {
        await loadPromise;
    }
    // Discard existing module if upgrading
    if (coreModule) {
        console.log(`[ffmpeg] upgrading ${loadedTier} → ${tier}`);
        coreModule = null;
        loadedTier = null;
    }
    pendingTier = tier;
    loadPromise = (async () => {
        const { coreURL, wasmURL } = TIER_URLS[tier];
        console.log(`[ffmpeg] loading ${tier} bundle`);
        const { default: createFFmpegCore } = (await import(/* @vite-ignore */ coreURL));
        const core = await createFFmpegCore({
            mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL: '' }))}`,
        });
        console.log(`[ffmpeg] ${tier} bundle ready`);
        coreModule = core;
        loadedTier = tier;
        return core;
    })();
    return loadPromise;
}
export function tierForCodec(codec) {
    return AUDIO_TIER_CODECS.has(codec) ? 'audio' : 'full';
}
export class WasmFfmpegRunner {
    tier = 'audio';
    /**
     * Pre-load the smallest sufficient bundle for the given audio codec.
     * Call before the first run() to avoid loading the full 32 MB bundle
     * when only audio transcode is needed.
     */
    async loadForCodec(codec) {
        this.tier = tierForCodec(codec);
        await ensureTier(this.tier);
    }
    getCore() {
        return ensureTier(this.tier);
    }
    async writeInput(name, data) {
        const core = await this.getCore();
        core.FS.writeFile(name, data);
    }
    async readOutput(name) {
        const core = await this.getCore();
        return core.FS.readFile(name);
    }
    async deleteFile(name) {
        const core = await this.getCore();
        try {
            core.FS.unlink(name);
        }
        catch {
            // ignore — file may not exist
        }
    }
    async run(args) {
        const core = await this.getCore();
        const stderr = [];
        core.setLogger(({ message }) => stderr.push(message));
        try {
            const exitCode = core.exec(...args);
            core.reset();
            return { exitCode, stderr: stderr.join('\n') };
        }
        finally {
            core.setLogger(() => { });
        }
    }
}
//# sourceMappingURL=wasm-ffmpeg.js.map