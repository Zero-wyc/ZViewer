import { type EncodedPacket } from 'mediabunny';
export interface MuxInput {
    videoPackets: EncodedPacket[];
    audioPackets: EncodedPacket[];
    videoCodec: string;
    audioCodec: string;
    videoDecoderConfig: VideoDecoderConfig;
    audioDecoderConfig: AudioDecoderConfig | null;
}
export interface MuxResult {
    init: Uint8Array;
    media: Uint8Array[];
}
export declare function muxToFmp4(input: MuxInput): Promise<MuxResult>;
//# sourceMappingURL=mux.d.ts.map