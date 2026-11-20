/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { modEuclid } from '../misc.js';
export const MPEG_TS_TIMESCALE = 90_000; // MPEG-TS timestamps run on a 90 kHz clock
export const TIMESTAMP_MODULUS = 2 ** 33;
export const TS_PACKET_SIZE = 188;
export const buildMpegTsMimeType = (codecStrings) => {
    let string = 'video/MP2T';
    const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
    if (uniqueCodecStrings.length > 0) {
        string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
    }
    return string;
};
export const secondsToMpegTsTimestamp = (seconds) => {
    // This supports writing negative timestamps by simply Euclid-modding them. It is then up to the demuxer to
    // interpret them as negative, if it wants to.
    return modEuclid(Math.round(MPEG_TS_TIMESCALE * seconds), TIMESTAMP_MODULUS);
};
export const createTimestampWrapInfo = (firstTimestamp) => {
    const tolerance = 60 * MPEG_TS_TIMESCALE;
    return {
        reference: firstTimestamp >= TIMESTAMP_MODULUS - tolerance
            ? firstTimestamp - tolerance - TIMESTAMP_MODULUS // Timestamps close to the modulus are treated as negative
            : firstTimestamp - tolerance,
    };
};
export const normalizeWrappedTimestamp = (timestamp, wrapInfo) => {
    // Every timestamp is mapped into the modulus-wide window starting a bit below the first timestamp
    return wrapInfo.reference + modEuclid(timestamp - wrapInfo.reference, TIMESTAMP_MODULUS);
};
