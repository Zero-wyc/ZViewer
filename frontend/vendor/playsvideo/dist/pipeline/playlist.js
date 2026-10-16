export function generateVodPlaylist(spec) {
    return generatePlaylist({ ...spec, endList: true });
}
export function generateEventPlaylist(spec) {
    return generatePlaylist({ ...spec, endList: false });
}
function generatePlaylist(spec) {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        `#EXT-X-TARGETDURATION:${spec.targetDuration}`,
        `#EXT-X-MEDIA-SEQUENCE:${spec.mediaSequence}`,
        `#EXT-X-PLAYLIST-TYPE:${spec.endList ? 'VOD' : 'EVENT'}`,
    ];
    if (spec.mapUri) {
        lines.push(`#EXT-X-MAP:URI="${spec.mapUri}"`);
    }
    for (const entry of spec.entries) {
        if (entry.discontinuity) {
            lines.push('#EXT-X-DISCONTINUITY');
        }
        lines.push(`#EXTINF:${entry.durationSec.toFixed(6)},`);
        lines.push(entry.uri);
    }
    if (spec.endList) {
        lines.push('#EXT-X-ENDLIST');
    }
    return `${lines.join('\n')}\n`;
}
export function parsePlaylist(m3u8) {
    const lines = m3u8.split('\n').map((l) => l.trim());
    let targetDuration = 0;
    let mediaSequence = 0;
    let endList = false;
    let mapUri;
    const entries = [];
    let nextDisc = false;
    let nextDuration = null;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = parseInt(line.split(':')[1], 10);
        }
        else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            mediaSequence = parseInt(line.split(':')[1], 10);
        }
        else if (line === '#EXT-X-ENDLIST') {
            endList = true;
        }
        else if (line.startsWith('#EXT-X-MAP:')) {
            const match = line.match(/URI="([^"]+)"/);
            if (match)
                mapUri = match[1];
        }
        else if (line === '#EXT-X-DISCONTINUITY') {
            nextDisc = true;
        }
        else if (line.startsWith('#EXTINF:')) {
            nextDuration = parseFloat(line.slice(8));
        }
        else if (line && !line.startsWith('#') && nextDuration !== null) {
            entries.push({
                uri: line,
                durationSec: nextDuration,
                ...(nextDisc ? { discontinuity: true } : {}),
            });
            nextDuration = null;
            nextDisc = false;
        }
    }
    return { targetDuration, mediaSequence, entries, endList, mapUri };
}
//# sourceMappingURL=playlist.js.map