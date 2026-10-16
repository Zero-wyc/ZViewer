export async function buildMkvKeyframeIndexFromSource(source, videoTrackId) {
    const size = await source.getSizeOrNull();
    if (size === null) {
        return null;
    }
    return buildMkvKeyframeIndex(async (start, end) => {
        const result = await source._read(start, end);
        if (!result) {
            throw new Error(`MKV cue read failed for source range ${start}-${end}`);
        }
        const sliceStart = start - result.offset;
        const sliceEnd = end - result.offset;
        if (sliceStart < 0 || sliceEnd > result.bytes.length || sliceStart > sliceEnd) {
            throw new Error(`MKV cue read returned mismatched range ${result.offset}-${result.offset + result.bytes.length}`);
        }
        return result.bytes.subarray(sliceStart, sliceEnd);
    }, size, videoTrackId);
}
export async function buildMkvKeyframeIndexFromBlob(blob, videoTrackId) {
    return buildMkvKeyframeIndex(async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()), blob.size, videoTrackId);
}
export async function buildMkvKeyframeIndexFromUrl(url, videoTrackId) {
    try {
        const size = await getUrlSize(url);
        return buildMkvKeyframeIndex(async (start, end) => {
            const response = await fetch(url, {
                headers: {
                    Range: `bytes=${start}-${end - 1}`,
                },
            });
            if (response.status !== 206) {
                throw new Error(`MKV cue range request failed: HTTP ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        }, size, videoTrackId);
    }
    catch {
        return null;
    }
}
async function getUrlSize(url) {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) {
        throw new Error(`MKV cue HEAD failed: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get('content-length');
    const size = contentLength ? Number(contentLength) : NaN;
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error('MKV cue HEAD missing content-length');
    }
    return size;
}
async function buildMkvKeyframeIndex(read, fileSize, videoTrackId) {
    try {
        // Cues may index audio and subtitle tracks as well. Only video cues
        // define video keyframes; otherwise video and audio start seconds apart.
        if (!Number.isInteger(videoTrackId)) return null;
        const parsed = await parseMkvCueIndex(read, fileSize, videoTrackId);
        if (!parsed.durationSec || !Number.isFinite(parsed.durationSec) || parsed.durationSec <= 0) {
            return null;
        }
        if (parsed.cuePoints.length === 0) {
            return null;
        }
        return {
            duration: parsed.durationSec,
            keyframes: parsed.cuePoints.map((cue, sequenceNumber) => ({
                timestamp: cue.timestampMs / 1000,
                sequenceNumber,
            })),
        };
    }
    catch {
        return null;
    }
}
export async function parseMkvCues(read, fileSize) {
    const parsed = await parseMkvCueIndex(read, fileSize);
    return parsed.cuePoints;
}
export async function parseMkvCueIndex(read, fileSize, videoTrackId) {
    let pos = 0;
    const headerData = await read(0, Math.min(64, fileSize));
    const headerEl = readElementHeader(headerData, 0);
    if (!headerEl || headerEl.id !== EBML_ID) {
        throw new Error('Not an EBML file');
    }
    pos = headerEl.dataStart + headerEl.dataSize;
    const segBuf = await read(pos, Math.min(pos + 16, fileSize));
    const segEl = readElementHeader(segBuf, 0);
    if (!segEl || segEl.id !== SEGMENT_ID) {
        throw new Error('Segment element not found');
    }
    const segmentDataStart = pos + segEl.dataStart;
    let cuesOffset;
    let infoOffset;
    let timestampScale = 1_000_000;
    const scanPos = segmentDataStart;
    const segmentEnd = segEl.dataSize === UNKNOWN_SIZE ? fileSize : segmentDataStart + segEl.dataSize;
    const scanLimit = Math.min(segmentEnd, scanPos + 4096);
    const scanBuf = await read(scanPos, Math.min(scanLimit, fileSize));
    let localPos = 0;
    while (localPos < scanBuf.length - 2) {
        const el = readElementHeader(scanBuf, localPos);
        if (!el)
            break;
        const absPos = scanPos + localPos;
        if (el.id === SEEKHEAD_ID) {
            const seekHeadEnd = localPos + el.dataStart + el.dataSize;
            let sp = localPos + el.dataStart;
            while (sp < seekHeadEnd && sp < scanBuf.length - 2) {
                const seekEl = readElementHeader(scanBuf, sp);
                if (!seekEl)
                    break;
                if (seekEl.id === SEEK_ID) {
                    const seekEnd = sp + seekEl.dataStart + seekEl.dataSize;
                    let seekInner = sp + seekEl.dataStart;
                    let seekId;
                    let seekPosition;
                    while (seekInner < seekEnd && seekInner < scanBuf.length - 2) {
                        const innerEl = readElementHeader(scanBuf, seekInner);
                        if (!innerEl)
                            break;
                        if (innerEl.id === SEEKID_ID) {
                            seekId = readUint(scanBuf, seekInner + innerEl.dataStart, innerEl.dataSize);
                        }
                        else if (innerEl.id === SEEKPOSITION_ID) {
                            seekPosition = readUint(scanBuf, seekInner + innerEl.dataStart, innerEl.dataSize);
                        }
                        seekInner += innerEl.dataStart + innerEl.dataSize;
                    }
                    if (seekId === CUES_ID && seekPosition !== undefined) {
                        cuesOffset = segmentDataStart + seekPosition;
                    }
                    if (seekId === INFO_ID && seekPosition !== undefined) {
                        infoOffset = segmentDataStart + seekPosition;
                    }
                }
                sp += seekEl.dataStart + seekEl.dataSize;
            }
        }
        else if (el.id === INFO_ID) {
            infoOffset = absPos;
        }
        else if (el.id === CLUSTER_ID) {
            break;
        }
        if (el.dataSize === UNKNOWN_SIZE)
            break;
        localPos += el.dataStart + el.dataSize;
    }
    let durationSec = null;
    if (infoOffset !== undefined) {
        const infoHdrBuf = await read(infoOffset, Math.min(infoOffset + 64, fileSize));
        const infoEl = readElementHeader(infoHdrBuf, 0);
        if (infoEl && infoEl.id === INFO_ID) {
            const infoEnd = infoEl.dataStart + infoEl.dataSize;
            const infoBuf = infoEnd <= infoHdrBuf.length
                ? infoHdrBuf
                : await read(infoOffset, Math.min(infoOffset + infoEnd, fileSize));
            let ip = infoEl.dataStart;
            while (ip < infoEnd && ip < infoBuf.length - 2) {
                const child = readElementHeader(infoBuf, ip);
                if (!child)
                    break;
                if (child.id === TIMESTAMP_SCALE_ID) {
                    timestampScale = readUint(infoBuf, ip + child.dataStart, child.dataSize);
                }
                else if (child.id === DURATION_ID) {
                    const durationTicks = readFloat(infoBuf, ip + child.dataStart, child.dataSize);
                    if (durationTicks !== null && Number.isFinite(durationTicks) && durationTicks > 0) {
                        durationSec = (durationTicks * timestampScale) / 1_000_000_000;
                    }
                }
                if (child.dataSize === UNKNOWN_SIZE)
                    break;
                ip += child.dataStart + child.dataSize;
            }
        }
    }
    if (cuesOffset === undefined) {
        return { cuePoints: [], durationSec };
    }
    const cuesHdrBuf = await read(cuesOffset, Math.min(cuesOffset + 16, fileSize));
    const cuesEl = readElementHeader(cuesHdrBuf, 0);
    if (!cuesEl || cuesEl.id !== CUES_ID) {
        return { cuePoints: [], durationSec };
    }
    const cuesDataStart = cuesOffset + cuesEl.dataStart;
    const cuesDataSize = cuesEl.dataSize === UNKNOWN_SIZE ? fileSize - cuesDataStart : cuesEl.dataSize;
    const cuesBuf = await read(cuesDataStart, Math.min(cuesDataStart + cuesDataSize, fileSize));
    const cuePoints = [];
    let cp = 0;
    while (cp < cuesBuf.length - 2) {
        const cpEl = readElementHeader(cuesBuf, cp);
        if (!cpEl)
            break;
        if (cpEl.id === CUEPOINT_ID) {
            let cueTime;
            let clusterPosition;
            let hasVideoPosition = false;
            const cpEnd = cp + cpEl.dataStart + cpEl.dataSize;
            let inner = cp + cpEl.dataStart;
            while (inner < cpEnd && inner < cuesBuf.length - 2) {
                const child = readElementHeader(cuesBuf, inner);
                if (!child)
                    break;
                if (child.id === CUETIME_ID) {
                    cueTime = readUint(cuesBuf, inner + child.dataStart, child.dataSize);
                }
                else if (child.id === CUETRACKPOSITIONS_ID) {
                    let cueTrack;
                    let position;
                    const ctpEnd = inner + child.dataStart + child.dataSize;
                    let ctpInner = inner + child.dataStart;
                    while (ctpInner < ctpEnd && ctpInner < cuesBuf.length - 2) {
                        const ctpChild = readElementHeader(cuesBuf, ctpInner);
                        if (!ctpChild)
                            break;
                        if (ctpChild.id === CUECLUSTERPOSITION_ID) {
                            position = readUint(cuesBuf, ctpInner + ctpChild.dataStart, ctpChild.dataSize);
                        }
                        else if (ctpChild.id === 0xf7) {
                            cueTrack = readUint(cuesBuf, ctpInner + ctpChild.dataStart, ctpChild.dataSize);
                        }
                        if (ctpChild.dataSize === UNKNOWN_SIZE)
                            break;
                        ctpInner += ctpChild.dataStart + ctpChild.dataSize;
                    }
                    if (position !== undefined && (videoTrackId === undefined || cueTrack === videoTrackId)) {
                        clusterPosition = position;
                        hasVideoPosition = true;
                    }
                }
                if (child.dataSize === UNKNOWN_SIZE)
                    break;
                inner += child.dataStart + child.dataSize;
            }
            if (cueTime !== undefined && clusterPosition !== undefined && hasVideoPosition) {
                cuePoints.push({
                    timestampMs: (cueTime * timestampScale) / 1_000_000,
                });
            }
        }
        if (cpEl.dataSize === UNKNOWN_SIZE)
            break;
        cp += cpEl.dataStart + cpEl.dataSize;
    }
    return { cuePoints, durationSec };
}
const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const SEEK_ID = 0x4dbb;
const SEEKID_ID = 0x53ab;
const SEEKPOSITION_ID = 0x53ac;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const CUES_ID = 0x1c53bb6b;
const CUEPOINT_ID = 0xbb;
const CUETIME_ID = 0xb3;
const CUETRACKPOSITIONS_ID = 0xb7;
const CUECLUSTERPOSITION_ID = 0xf1;
const CLUSTER_ID = 0x1f43b675;
const UNKNOWN_SIZE = -1;
function readElementHeader(buf, offset) {
    if (offset >= buf.length)
        return null;
    const idResult = readVarIntRaw(buf, offset);
    if (!idResult)
        return null;
    const sizeResult = readVarIntValue(buf, offset + idResult.length);
    if (!sizeResult)
        return null;
    return {
        id: idResult.value,
        dataStart: idResult.length + sizeResult.length,
        dataSize: sizeResult.unknown ? UNKNOWN_SIZE : sizeResult.value,
    };
}
function readVarIntRaw(buf, offset) {
    if (offset >= buf.length)
        return null;
    const first = buf[offset];
    let mask = 0x80;
    let length = 1;
    while (length <= 4 && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 4 || offset + length > buf.length)
        return null;
    let value = 0;
    for (let i = 0; i < length; i++) {
        value = (value << 8) | buf[offset + i];
    }
    return { value, length };
}
function readVarIntValue(buf, offset) {
    if (offset >= buf.length)
        return null;
    const first = buf[offset];
    let mask = 0x80;
    let length = 1;
    while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 8 || offset + length > buf.length)
        return null;
    let value = first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < length; i++) {
        value = value * 256 + buf[offset + i];
        if (buf[offset + i] !== 0xff) {
            allOnes = false;
        }
    }
    return { value, length, unknown: allOnes };
}
function readUint(buf, offset, length) {
    let value = 0;
    for (let i = 0; i < length; i++) {
        value = value * 256 + buf[offset + i];
    }
    return value;
}
function readFloat(buf, offset, length) {
    const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
    if (length === 4)
        return view.getFloat32(0, false);
    if (length === 8)
        return view.getFloat64(0, false);
    return null;
}
//# sourceMappingURL=mkv-keyframe-index.js.map