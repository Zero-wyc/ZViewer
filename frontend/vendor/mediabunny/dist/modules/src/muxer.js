/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AsyncMutex } from './misc.js';
export class Muxer {
    constructor(output) {
        this.mutex = new AsyncMutex();
        /**
         * This field is used to synchronize multiple MediaStreamTracks. They use the same time coordinate system across
         * tracks, and to ensure correct audio-video sync, we must use the same offset for all of them. The reason an offset
         * is needed at all is because the timestamps typically don't start at zero.
         */
        this.firstMediaStreamTimestamp = null;
        this.trackTimestampInfo = new WeakMap();
        this.output = output;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onTrackClose(track) { }
    validateAndNormalizeTimestamp(track, timestampInSeconds, isKeyPacket) {
        timestampInSeconds += track.source._timestampOffset;
        let timestampInfo = this.trackTimestampInfo.get(track);
        const isFirstPacket = !timestampInfo;
        if (!timestampInfo) {
            if (!isKeyPacket) {
                throw new Error('First packet must be a key packet.');
            }
            timestampInfo = {
                maxTimestamp: timestampInSeconds,
                // The first GOP in a new mux can legitimately contain packets whose
                // presentation timestamps are earlier than the opening key packet
                // (for example, HEVC/H.264 B-frames). There is no "previous GOP"
                // yet, so defer the monotonic GOP boundary check until we actually
                // see a subsequent key packet.
                maxTimestampBeforeLastKeyPacket: -Infinity,
            };
            this.trackTimestampInfo.set(track, timestampInfo);
        }
        if (timestampInSeconds < 0) {
            throw new Error(`Timestamps must be non-negative (got ${timestampInSeconds}s).`);
        }
        if (isKeyPacket && !isFirstPacket) {
            timestampInfo.maxTimestampBeforeLastKeyPacket = timestampInfo.maxTimestamp;
        }
        if (timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyPacket) {
            throw new Error(`Timestamps cannot be smaller than the largest timestamp of the previous GOP (a GOP begins with a key`
                + ` packet and ends right before the next key packet). Got ${timestampInSeconds}s, but largest`
                + ` timestamp is ${timestampInfo.maxTimestampBeforeLastKeyPacket}s.`);
        }
        timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);
        return timestampInSeconds;
    }
}
