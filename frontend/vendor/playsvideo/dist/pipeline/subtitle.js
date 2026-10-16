/**
 * 本地补丁：上游 mediabunny（>=1.40）移除了 fork 分支私有的
 * formatCuesToWebVTT，此处按 kzahel/mediabunny@integration 原实现内联，
 * 使 playsvideo 0.4.7 可直接搭配 registry 上游使用。逻辑照搬，勿改。
 */
const formatSubtitleTimestamp = (timestamp) => {
    const hours = Math.floor(timestamp / (60 * 60 * 1000));
    const minutes = Math.floor((timestamp % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((timestamp % (60 * 1000)) / 1000);
    const milliseconds = timestamp % 1000;
    return (
        hours.toString().padStart(2, '0') +
        ':' +
        minutes.toString().padStart(2, '0') +
        ':' +
        seconds.toString().padStart(2, '0') +
        '.' +
        milliseconds.toString().padStart(3, '0')
    );
};

const extractTextFromAssCue = (text) => {
    if (text.startsWith('Dialogue:') || text.startsWith('Comment:')) {
        const colonIndex = text.indexOf(':');
        if (colonIndex === -1) return text;
        const afterColon = text.substring(colonIndex + 1);
        const parts = afterColon.split(',');
        if (parts.length >= 10) {
            return parts.slice(9).join(',');
        }
    }
    const parts = text.split(',');
    if (parts.length >= 8) {
        const firstPart = parts[0] && parts[0].trim();
        const secondPart = parts[1] && parts[1].trim();
        if (firstPart && !isNaN(parseInt(firstPart))) {
            if (secondPart && !isNaN(parseInt(secondPart)) && parts.length >= 9) {
                return parts.slice(8).join(',');
            } else if (parts.length >= 8) {
                return parts.slice(7).join(',');
            }
        }
    }
    return text;
};

const formatCuesToWebVTT = (cues, preamble) => {
    let result = preamble || 'WEBVTT\n';
    if (!result.endsWith('\n\n')) {
        result += '\n';
    }
    const formattedCues = cues.map((cue) => {
        const startTime = formatSubtitleTimestamp(cue.timestamp * 1000);
        const endTime = formatSubtitleTimestamp(
            (cue.timestamp + cue.duration) * 1000
        );
        const text = extractTextFromAssCue(cue.text);
        return `${startTime} --> ${endTime}\n${text}`;
    });
    return result + formattedCues.join('\n\n');
};
/** Discover subtitle tracks from a demuxed input. Cheap — reads only metadata, no cue extraction. */
export async function getSubtitleTrackInfos(input) {
    const tracks = await input.getSubtitleTracks();
    return tracks.map((track, i) => {
        const d = track.disposition;
        return {
            index: i,
            codec: track.codec ?? 'unknown',
            language: track.languageCode,
            name: track.name,
            disposition: {
                default: d.default,
                forced: d.forced,
                hearingImpaired: d.hearingImpaired,
            },
        };
    });
}
/** Extract all cues from a subtitle track and return cleaned SubtitleData. */
export async function extractSubtitleData(input, trackIndex, options = {}) {
    const tracks = await input.getSubtitleTracks();
    const track = tracks[trackIndex];
    if (!track) {
        throw new Error(`Subtitle track index ${trackIndex} not found`);
    }
    const codec = track.codec ?? 'unknown';
    const rawCues = [];
    const startedAt = performance.now();
    let lastReportedAt = startedAt;
    let lastReportedCues = 0;
    const reportProgress = (phase, cuesRead = rawCues.length) => {
        options.onProgress?.({
            trackIndex,
            codec,
            phase,
            cuesRead,
            elapsedMs: performance.now() - startedAt,
        });
    };
    reportProgress('starting', 0);
    for await (const cue of track.getCues()) {
        rawCues.push(cue);
        const now = performance.now();
        if (rawCues.length === 1 ||
            rawCues.length - lastReportedCues >= 250 ||
            now - lastReportedAt >= 500) {
            reportProgress('reading-cues');
            lastReportedAt = now;
            lastReportedCues = rawCues.length;
        }
    }
    const cues = cleanCues(rawCues, codec);
    // For ASS/SSA, try to get the header from exportToText
    let header;
    if (codec === 'ass' || codec === 'ssa') {
        reportProgress('exporting-text');
        const exported = await track.exportToText();
        header = extractAssHeader(exported);
    }
    reportProgress('done', cues.length);
    return { cues, codec, header };
}
/**
 * Convert SubtitleData to a WebVTT string suitable for a Blob URL.
 * Works for any source codec — ASS override tags are stripped to plain text.
 */
export function subtitleDataToWebVTT(data) {
    // If we have clean cues, use mediabunny's formatter
    const mbCues = data.cues.map((c) => ({
        timestamp: c.startSec,
        duration: c.endSec - c.startSec,
        text: stripAssTags(c.text),
        settings: c.settings,
    }));
    return formatCuesToWebVTT(mbCues);
}
/**
 * Parse a user-imported subtitle file into SubtitleData.
 * Supports .srt, .vtt, .ass/.ssa files.
 */
export function parseSubtitleFile(text, filename) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'vtt') {
        return parseWebVTT(text);
    }
    if (ext === 'srt') {
        return parseSRT(text);
    }
    if (ext === 'ass' || ext === 'ssa') {
        return { cues: [], codec: ext, header: text };
        // For ASS, the full file IS the data — keep it opaque for JASSUB
        // Could also parse into cues for WebVTT fallback
    }
    throw new Error(`Unsupported subtitle format: .${ext}`);
}
// --- Internal helpers ---
/** Strip tx3g 2-byte length prefix, filter empty gap cues. */
function cleanCues(raw, codec) {
    const cleaned = [];
    for (const cue of raw) {
        let text = cue.text;
        // tx3g samples have a 2-byte big-endian length prefix
        if (codec === 'tx3g' && text.length >= 2) {
            text = text.slice(2);
        }
        text = text.trim();
        if (!text || cue.duration <= 0)
            continue;
        cleaned.push({
            startSec: cue.timestamp,
            endSec: cue.timestamp + cue.duration,
            text,
            settings: cue.settings,
        });
    }
    return cleaned;
}
/** Strip ASS/SSA override tags like {\b1}, {\pos(x,y)}, {\an8} → plain text. */
function stripAssTags(text) {
    return text
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/\\N/g, '\n')
        .replace(/\\n/g, '\n');
}
/** Extract the ASS header (everything before the first Dialogue: line). */
function extractAssHeader(fullText) {
    const idx = fullText.indexOf('Dialogue:');
    if (idx === -1)
        return fullText;
    return fullText.slice(0, idx).trimEnd();
}
function parseWebVTT(text) {
    const cues = [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const timeRegex = /([\d:.]+)\s+-->\s+([\d:.]+)(.*)/;
    for (let i = 0; i < lines.length; i++) {
        const match = timeRegex.exec(lines[i]);
        if (!match)
            continue;
        const startSec = parseVTTTimestamp(match[1]);
        const endSec = parseVTTTimestamp(match[2]);
        const settings = match[3]?.trim() || undefined;
        const textLines = [];
        for (let j = i + 1; j < lines.length && lines[j].trim(); j++) {
            textLines.push(lines[j]);
            i = j;
        }
        if (textLines.length > 0) {
            cues.push({ startSec, endSec, text: textLines.join('\n'), settings });
        }
    }
    // Extract preamble as header
    const firstArrow = text.indexOf('-->');
    let header;
    if (firstArrow !== -1) {
        const beforeFirstCue = text.slice(0, text.lastIndexOf('\n', text.lastIndexOf('\n', firstArrow) - 1));
        if (beforeFirstCue.includes('WEBVTT')) {
            header = beforeFirstCue.trim();
        }
    }
    return { cues, codec: 'webvtt', header };
}
function parseSRT(text) {
    const cues = [];
    const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
    const timeRegex = /([\d:,]+)\s+-->\s+([\d:,]+)/;
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2)
            continue;
        // Find the timing line (skip sequence number)
        let timingIdx = 0;
        for (let i = 0; i < lines.length; i++) {
            if (timeRegex.test(lines[i])) {
                timingIdx = i;
                break;
            }
        }
        const match = timeRegex.exec(lines[timingIdx]);
        if (!match)
            continue;
        const startSec = parseSRTTimestamp(match[1]);
        const endSec = parseSRTTimestamp(match[2]);
        const cueText = lines
            .slice(timingIdx + 1)
            .join('\n')
            .trim();
        if (cueText) {
            cues.push({ startSec, endSec, text: cueText });
        }
    }
    return { cues, codec: 'srt' };
}
function parseVTTTimestamp(ts) {
    const parts = ts.split(':');
    if (parts.length === 3) {
        return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    return Number(parts[0]) * 60 + Number(parts[1]);
}
function parseSRTTimestamp(ts) {
    const [time, ms] = ts.split(',');
    const parts = time.split(':');
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(ms) / 1000;
}
//# sourceMappingURL=subtitle.js.map