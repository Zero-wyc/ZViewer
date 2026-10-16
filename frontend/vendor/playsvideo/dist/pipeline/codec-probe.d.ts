/**
 * Codec support detection for HLS/MSE playback.
 *
 * Determines whether audio/video codecs can be played natively via MSE
 * or need transcoding. The CodecProber interface is platform-swappable:
 * browser uses MediaSource.isTypeSupported(), Node/test uses a static whitelist.
 */
export interface CodecProber {
    /** Can MSE play this audio codec in an fMP4 container? */
    canPlayAudio(shortCodec: string, fullCodecString?: string): boolean;
    /** Can MSE play this video codec in an fMP4 container? */
    canPlayVideo(shortCodec: string, fullCodecString?: string): boolean;
}
/**
 * Browser prober — queries MediaSource.isTypeSupported() with result caching.
 * Create once at module level in the worker.
 */
export declare function createBrowserProber(): CodecProber;
export declare function createNodeProber(): CodecProber;
/** Does this audio codec need transcoding in the given environment? */
export declare function audioNeedsTranscode(prober: CodecProber, shortCodec: string, fullCodecString?: string): boolean;
//# sourceMappingURL=codec-probe.d.ts.map