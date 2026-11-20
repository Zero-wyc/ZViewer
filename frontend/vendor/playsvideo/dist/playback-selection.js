import Hls from 'hls.js/light';
import { createBrowserProber } from './pipeline/codec-probe.js';
const DEFAULT_PREFERENCE_ORDER = ['direct-url', 'direct-bytes', 'hls'];
/**
 * Convenience helper for browser integrations.
 *
 * The returned object is plain data/functions, so `evaluatePlaybackOptions()`
 * stays pure and testable. The heuristics mirror the current engine split:
 * direct/native uses `canPlayType()`, while remux/HLS uses the pipeline codec
 * probe built on `MediaSource.isTypeSupported()`.
 */
export function createBrowserPlaybackCapabilities(video, options = {}) {
    return {
        canPlayType: (mimeType) => normalizeCanPlayType(video.canPlayType(mimeType)),
        hlsSupported: options.hlsSupported ?? Hls.isSupported(),
        pipelineProbe: options.pipelineProbe ?? createBrowserProber(),
    };
}
export function evaluatePlaybackOptions(input) {
    const preferenceOrder = input.preferenceOrder ?? DEFAULT_PREFERENCE_ORDER;
    const evaluations = input.options.map((option) => evaluateOption(option, input.media, input.capabilities));
    const recommendedIndex = pickRecommendedIndex(evaluations, preferenceOrder);
    let recommended = null;
    if (recommendedIndex !== null) {
        const evaluation = evaluations[recommendedIndex];
        evaluation.selected = true;
        recommended = {
            option: evaluation.option,
            reason: evaluation.option.mode === 'hls'
                ? {
                    code: 'selected-hls',
                    message: 'Recommended HLS playback because no higher-preference direct option was supported.',
                }
                : {
                    code: 'selected-direct',
                    message: 'Recommended direct playback because the browser natively accepts the source container and codecs.',
                },
        };
        evaluation.diagnostics.push(recommended.reason);
    }
    return { recommended, evaluations };
}
export function recommendPlaybackOption(input) {
    return evaluatePlaybackOptions(input).recommended;
}
function evaluateOption(option, media, capabilities) {
    return option.mode === 'hls'
        ? evaluateHlsOption(option, media, capabilities)
        : evaluateDirectOption(option, media, capabilities);
}
function evaluateDirectOption(option, media, capabilities) {
    const diagnostics = [];
    if (!capabilities.canPlayType) {
        diagnostics.push({
            code: 'direct-missing-capability',
            message: 'Direct playback evaluation requires a `canPlayType()` capability.',
        });
        return makeEvaluation(option, 'unknown', diagnostics);
    }
    if (!option.mimeType) {
        diagnostics.push({
            code: 'direct-missing-mime-type',
            message: 'Direct playback evaluation requires the source MIME type.',
        });
        return makeEvaluation(option, 'unknown', diagnostics);
    }
    if (!media.videoCodec && !media.audioCodec) {
        diagnostics.push({
            code: 'direct-missing-video-codec',
            message: 'Direct playback evaluation requires the parsed video (or audio) codec string.',
        });
        return makeEvaluation(option, 'unknown', diagnostics);
    }
    // [本地补丁] 纯音频容器没有视频编码：只拼音频 codec，交给
    // canPlayType('audio/mp4; codecs="mp4a.40.2"') 判定。这样本地 .m4a
    // 能走直通（零重封装），而不是被这条前置检查逼到 HLS 管线。
    const codecList = media.videoCodec
        ? media.audioCodec
            ? `${media.videoCodec}, ${media.audioCodec}`
            : media.videoCodec
        : media.audioCodec;
    const fullMime = `${option.mimeType}; codecs="${codecList}"`;
    const result = normalizeCanPlayType(capabilities.canPlayType(fullMime));
    if (result === 'maybe' || result === 'probably') {
        diagnostics.push({
            code: 'direct-supported',
            message: `Direct playback is supported: canPlayType("${fullMime}") returned "${result}".`,
        });
        return makeEvaluation(option, 'supported', diagnostics, { directCanPlayType: result });
    }
    diagnostics.push({
        code: 'direct-unsupported',
        message: `Direct playback is unsupported: canPlayType("${fullMime}") returned "${result}".`,
    });
    return makeEvaluation(option, 'blocked', diagnostics, { directCanPlayType: result });
}
function evaluateHlsOption(option, media, capabilities) {
    const diagnostics = [];
    if (capabilities.hlsSupported === undefined || !capabilities.pipelineProbe) {
        diagnostics.push({
            code: 'hls-missing-capability',
            message: 'HLS evaluation requires both `hlsSupported` and a pipeline codec probe.',
        });
        return makeEvaluation(option, 'unknown', diagnostics);
    }
    if (!capabilities.hlsSupported) {
        diagnostics.push({
            code: 'hls-runtime-unsupported',
            message: 'HLS playback is unavailable in this browser/runtime.',
        });
        return makeEvaluation(option, 'blocked', diagnostics);
    }
    if (!media.sourceVideoCodec) {
        // [本地补丁] 纯音频容器（.m4a / .mp3 / .flac / 音频-only MKV）：
        // 「没有视频轨」不是能力缺失。原逻辑在这里直接返回 unknown
        // （`hls-missing-video-codec`）→ recommended 为 null → 引擎报
        // 「Playback selection failed」，纯音频源永远起不来。改为按
        // 音频-only 继续评估；真正完全没轨时才判不可播。
        if (!media.sourceAudioCodec) {
            diagnostics.push({
                code: 'hls-no-tracks',
                message: 'Source has neither a video nor a playable audio track.',
            });
            return makeEvaluation(option, 'blocked', diagnostics);
        }
        diagnostics.push({
            code: 'hls-audio-only',
            message: 'Source has no video track; evaluating as audio-only playback.',
        });
    }
    const hasVideo = !!media.sourceVideoCodec;
    const pipelineVideoSupported = hasVideo
        ? capabilities.pipelineProbe.canPlayVideo(media.sourceVideoCodec, media.videoCodec ?? undefined)
        : null;
    if (hasVideo && !pipelineVideoSupported) {
        diagnostics.push({
            code: 'hls-video-unsupported',
            message: 'The remux/HLS path cannot play the source video codec in this environment.',
        });
        return makeEvaluation(option, 'blocked', diagnostics, { pipelineVideoSupported });
    }
    if (hasVideo) {
        diagnostics.push({
            code: 'hls-video-supported',
            message: 'The remux/HLS path can play the source video codec.',
        });
    }
    if (!media.sourceAudioCodec) {
        diagnostics.push({
            code: 'hls-no-audio-track',
            message: 'No source audio track was provided; video-only HLS playback is viable.',
        });
        return makeEvaluation(option, 'supported', diagnostics, {
            pipelineVideoSupported,
            pipelineAudioSupported: null,
            pipelineAudioRequiresTranscode: false,
        });
    }
    const pipelineAudioSupported = capabilities.pipelineProbe.canPlayAudio(media.sourceAudioCodec, media.audioCodec ?? undefined);
    if (pipelineAudioSupported) {
        diagnostics.push({
            code: 'hls-audio-supported',
            message: 'The remux/HLS path can keep the source audio codec without transcoding.',
        });
        return makeEvaluation(option, 'supported', diagnostics, {
            pipelineVideoSupported,
            pipelineAudioSupported,
            pipelineAudioRequiresTranscode: false,
        });
    }
    diagnostics.push({
        code: 'hls-audio-transcode',
        message: 'The remux/HLS path remains viable, but audio will be transcoded to AAC.',
    });
    return makeEvaluation(option, 'supported', diagnostics, {
        pipelineVideoSupported,
        pipelineAudioSupported,
        pipelineAudioRequiresTranscode: true,
    });
}
function makeEvaluation(option, status, diagnostics, overrides = {}) {
    return {
        option,
        status,
        selected: false,
        diagnostics,
        directCanPlayType: null,
        pipelineVideoSupported: null,
        pipelineAudioSupported: null,
        pipelineAudioRequiresTranscode: null,
        ...overrides,
    };
}
function pickRecommendedIndex(evaluations, preferenceOrder) {
    const supportedIndexes = evaluations
        .map((evaluation, index) => ({ evaluation, index }))
        .filter(({ evaluation }) => evaluation.status === 'supported');
    if (supportedIndexes.length === 0) {
        return null;
    }
    const modeRank = new Map(preferenceOrder.map((mode, index) => [mode, index]));
    supportedIndexes.sort((a, b) => {
        const aRank = modeRank.get(a.evaluation.option.mode) ?? Number.MAX_SAFE_INTEGER;
        const bRank = modeRank.get(b.evaluation.option.mode) ?? Number.MAX_SAFE_INTEGER;
        return aRank - bRank || a.index - b.index;
    });
    return supportedIndexes[0].index;
}
function normalizeCanPlayType(value) {
    if (value === 'maybe' || value === 'probably') {
        return value;
    }
    return '';
}
//# sourceMappingURL=playback-selection.js.map