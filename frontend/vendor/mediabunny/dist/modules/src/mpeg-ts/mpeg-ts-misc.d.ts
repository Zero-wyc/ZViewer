/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
export declare const TIMESCALE = 90000;
export declare const TS_PACKET_SIZE = 188;
export declare const enum MpegTsStreamType {
    MP3_MPEG1 = 3,
    MP3_MPEG2 = 4,
    AAC = 15,
    AC3_SYSTEM_A = 129,
    EAC3_SYSTEM_A = 135,
    PRIVATE_DATA = 6,
    AVC = 27,
    HEVC = 36
}
export declare const buildMpegTsMimeType: (codecStrings: (string | null)[]) => string;
//# sourceMappingURL=mpeg-ts-misc.d.ts.map