/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Input } from './input.js';
import { InputTrack } from './input-track.js';
import { MetadataTags } from './metadata.js';
export declare abstract class Demuxer {
    input: Input;
    constructor(input: Input);
    abstract computeDuration(): Promise<number>;
    abstract getTracks(): Promise<InputTrack[]>;
    abstract getMimeType(): Promise<string>;
    abstract getMetadataTags(): Promise<MetadataTags>;
}
//# sourceMappingURL=demuxer.d.ts.map