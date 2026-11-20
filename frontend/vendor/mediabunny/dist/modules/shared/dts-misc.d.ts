/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/** Sample rates the core can be encoded at (Table 5-5) */
export declare const DTS_SAMPLE_RATES: number[];
/** Channel counts DTS has a speaker layout for; 3 and 7 have no mapping */
export declare const DTS_CHANNEL_COUNTS: number[];
/**
 * The DTS encoder rejects bitrates whose frames can't hold the per-channel side info, or that exceed its limits (see
 * FFmpeg's dcaenc.c), so this moves a bitrate into the range it accepts.
 */
export declare const clampDtsBitrate: (bitrate: number, sampleRate: number, numberOfChannels: number) => number;
//# sourceMappingURL=dts-misc.d.ts.map