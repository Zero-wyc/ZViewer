const ADTS_SYNCWORD = 0xfff;
const SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const CHANNEL_COUNTS = [0, 1, 2, 3, 4, 5, 6, 8];
export function parseAdtsFrames(data) {
    const frames = [];
    let offset = 0;
    while (offset + 7 <= data.length) {
        // Check syncword: 12 bits = 0xFFF
        const sync = (data[offset] << 4) | (data[offset + 1] >> 4);
        if (sync !== ADTS_SYNCWORD) {
            // Try to resync
            offset++;
            continue;
        }
        const protectionAbsent = data[offset + 1] & 0x01;
        const headerSize = protectionAbsent ? 7 : 9;
        // Frame length: 13 bits starting at byte 3 bit 5
        const frameSize = ((data[offset + 3] & 0x03) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
        if (frameSize < headerSize || offset + frameSize > data.length) {
            break;
        }
        const sampleRateIndex = (data[offset + 2] >> 2) & 0x0f;
        const channelConfig = ((data[offset + 2] & 0x01) << 2) | (data[offset + 3] >> 6);
        frames.push({
            data: data.subarray(offset, offset + frameSize),
            frameSize,
            sampleRate: SAMPLE_RATES[sampleRateIndex] ?? 48000,
            channels: CHANNEL_COUNTS[channelConfig] ?? 2,
        });
        offset += frameSize;
    }
    return frames;
}
//# sourceMappingURL=adts-parse.js.map