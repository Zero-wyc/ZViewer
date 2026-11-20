import { EncodedAudioPacketSource, EncodedVideoPacketSource, Mp4OutputFormat, NullTarget, Output, } from 'mediabunny';
function concatBuffers(arrays) {
    const totalLength = arrays.reduce((sum, a) => sum + a.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.byteLength;
    }
    return result;
}
export async function muxToFmp4(input) {
    const initParts = [];
    const moofMdatPairs = [];
    let currentPair = [];
    const output = new Output({
        format: new Mp4OutputFormat({
            fastStart: 'fragmented',
            minimumFragmentDuration: 0,
            onFtyp: (data) => {
                initParts.push(new Uint8Array(data));
            },
            onMoov: (data) => {
                initParts.push(new Uint8Array(data));
            },
            onMoof: (data) => {
                currentPair = [new Uint8Array(data)];
                moofMdatPairs.push(currentPair);
            },
            onMdat: (data) => {
                currentPair.push(new Uint8Array(data));
            },
        }),
        target: new NullTarget(),
    });
    // [本地补丁] 视频轨同样按「有包 + 有 codec + 有 decoderConfig」才建：
    // 纯音频容器（.m4a/.mp3/.flac）没有视频轨，input.videoCodec 为 null，
    // `new EncodedVideoPacketSource(null)` 会抛 TypeError。
    const hasVideo = input.videoPackets.length > 0 && !!input.videoCodec && !!input.videoDecoderConfig;
    const videoSource = hasVideo
        ? new EncodedVideoPacketSource(input.videoCodec)
        : null;
    if (videoSource) {
        output.addVideoTrack(videoSource);
    }
    // [本地补丁] 只有在「有音频包 且 有 decoderConfig」时才建音轨。
    // mediabunny 在建轨时用 decoderConfig 生成 mp4a/avcC 之类的 box，
    // 缺 metadata 会抛 `TypeError: Audio chunk metadata must be provided.`
    // 并让整个分段（进而整部影片）失败。宁可产出纯视频 fMP4：画面能播，
    // 上层据 demux 的 audioDropped 给出提示，远好过黑屏报错。
    const hasAudio = input.audioPackets.length > 0 && !!input.audioDecoderConfig;
    const audioSource = hasAudio
        ? new EncodedAudioPacketSource(input.audioCodec)
        : null;
    if (audioSource) {
        output.addAudioTrack(audioSource);
    }
    if (!videoSource && !audioSource) {
        // 空容器：不能让 muxer finalize 出没有任何轨的 fMP4（minf 缺 stbl
        // 会抛内部错误），在这里给可读原因。
        throw new Error('该分段没有可封装的音视频轨（编码不支持或无数据）');
    }
    await output.start();
    // Feed video packets — pass decoder config on first packet
    if (videoSource) {
        const videoMeta = {
            decoderConfig: input.videoDecoderConfig,
        };
        for (let i = 0; i < input.videoPackets.length; i++) {
            await videoSource.add(input.videoPackets[i], i === 0 ? videoMeta : undefined);
        }
    }
    // Feed audio packets — pass decoder config on first packet
    if (audioSource) {
        const audioMeta = { decoderConfig: input.audioDecoderConfig };
        for (let i = 0; i < input.audioPackets.length; i++) {
            await audioSource.add(input.audioPackets[i], i === 0 ? audioMeta : undefined);
        }
    }
    await output.finalize();
    const init = concatBuffers(initParts);
    const media = moofMdatPairs.map((pair) => concatBuffers(pair));
    return { init, media };
}
//# sourceMappingURL=mux.js.map