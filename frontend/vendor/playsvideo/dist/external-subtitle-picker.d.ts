import { PlaysVideoEngine } from './engine.js';
interface ExternalSubtitlePickerOptions {
    engine: PlaysVideoEngine;
    input: HTMLInputElement;
    openButton: HTMLButtonElement;
    clearButton?: HTMLButtonElement;
    status?: HTMLElement;
}
export declare function bindExternalSubtitlePicker({ engine, input, openButton, clearButton, status, }: ExternalSubtitlePickerOptions): {
    reset: () => void;
};
export {};
//# sourceMappingURL=external-subtitle-picker.d.ts.map